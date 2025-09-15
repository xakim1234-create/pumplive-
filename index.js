// index.js — v7.8.1 (fixed)
// Robust LIVE-indicator capture: all frames, late render, reload-if-live, richer diagnostics
// - Indicator wait 40s, Task timeout 90s, protocolTimeout 60s
// - Interception enabled AFTER indicator found

import os from "os";
import process from "process";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ================== CONFIG ================== */
const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// ——— Telegram
const TG_TOKEN = process.env.TG_TOKEN || "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "-4857972467";

// ——— REST троттлинг
const MIN_GAP_MS = 1500; // ~0.66 rps
const MAX_LIFETIME_MS = 120_000; // ждать LIVE до 2 минут
const MAX_QUEUE = 1000;
const MAX_RETRIES = 2;

// ——— “Зрители”
const VIEWERS_THRESHOLD = 30;
const INDICATOR_WAIT_MS = 40_000; // ждём индикатор до 40с (было 25)
const SAMPLE_COUNT = 3; // 3 замера
const SAMPLE_STEP_MS = 3000; // каждые ~3с
const VIEWERS_TASK_TIMEOUT = 90_000; // общий таймаут одной задачи в браузере (было 60)

// ——— Браузер
const VIEWERS_CONCURRENCY = 1; // держим 1 вкладку одновременно
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ——— Диагностика ресурсов
const RES_LOG_EVERY_MS = 15_000;

// ——— Дедуп (не брать тот же mint 10 минут)
const DEDUP_TTL_MS = 10 * 60_000;

/* ================== STATE & METRICS ================== */
let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

const metrics = {
  requests: 0,
  ok: 0,
  retries: 0,
  http429: 0,
  httpOther: 0,
  emptyBody: 0,
  skippedNull: 0,
  reconnects: 0,
  viewerTasksStarted: 0,
  viewerTasksDone: 0,
  viewerTasksDropped: 0,
  viewerOpenErrors: 0,
  viewerSelectorMiss: 0,
  // indicator-specific
  ind_found_selector: 0,
  ind_found_text: 0,
  ind_found_after_reload: 0,
  ind_timeout: 0,
  ind_iframe_hits: 0,
  ind_wait_samples_ms: [],
};

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * a.length) - 1));
  return a[i];
}
let TASK_SEQ = 0;
function nextTaskId() {
  TASK_SEQ = (TASK_SEQ + 1) % 1e9;
  return TASK_SEQ;
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// REST троттлер
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise((r) => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// безопасный GET JSON
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/7.8.1",
        },
      });

      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }

      if (!r.ok) {
        metrics.httpOther++;
        throw new Error(`HTTP ${r.status}`);
      }

      const text = await r.text();
      if (!text || text.trim() === "") {
        metrics.emptyBody++;
        throw new Error("Empty body");
      }

      metrics.ok++;
      return JSON.parse(text);
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        metrics.retries++;
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        continue;
      }
      metrics.skippedNull++;
      return null;
    }
  }
}

/* ================== FORMATTERS ================== */
function formatNumber(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function extractOfficialSocials(coin) {
  const socials = [];
  if (coin?.website) socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter) socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord) socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);
  return socials;
}

/* ================== TELEGRAM ================== */
async function sendTG({ text, photo }) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    if (photo) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: "HTML" }),
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
      });
    }
  } catch (e) {
    log("⚠️  telegram send error:", e.message);
  }
}

/* ================== API QUEUE ================== */
const inQueue = new Set();
const queue = []; // [{ mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }]

function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({ mint, name, symbol, enqueuedAt: now, expiresAt: now + MAX_LIFETIME_MS, nextTryAt: now });
  inQueue.add(mint);
}
function requeue(item) {
  item.nextTryAt = Date.now() + 4000;
  queue.push(item);
}
function queueSize() {
  return inQueue.size;
}

/* ================== VIEWERS QUEUE ================== */
const viewersQueue = [];
const viewersInQueue = new Set();
let browser = null;
let viewersActive = 0;

// дедуп по mint на 10 минут
const recentlyHandled = new Map(); // mint -> timestamp
function markHandled(mint) {
  recentlyHandled.set(mint, Date.now());
}
function isRecentlyHandled(mint) {
  const ts = recentlyHandled.get(mint);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentlyHandled.delete(mint);
    return false;
  }
  return true;
}

function enqueueViewers({ mint, coin, fallbackName = "", fallbackSymbol = "" }) {
  if (viewersInQueue.has(mint)) return;
  if (isRecentlyHandled(mint)) return; // дедуп 10м
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: Date.now() });
  viewersInQueue.add(mint);
}

/* ================== BROWSER ================== */
let activePages = 0;
let lastChromeRssMB = 0;

async function getBrowser() {
  if (browser) return browser;
  const execPath = await chromium.executablePath();
  browser = await puppeteer.launch({
    executablePath: execPath,
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    headless: chromium.headless,
    protocolTimeout: 60_000, // было 20_000 — мало
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

async function logResources() {
  try {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);
    const load1 = (os.loadavg()?.[0] || 0).toFixed(2);
    const extra = browser ? ` rss_chrome=${lastChromeRssMB ? lastChromeRssMB.toFixed(1) + "MB" : "n/a"}` : "";
    console.log(
      `[res] cpu_node=${(process.cpuUsage().user / 1e6).toFixed(1)}% rss_node=${rssMB}MB heap_node=${heapMB}MB load1=${load1} active_pages=${activePages}${extra}`
    );
  } catch {}
}
async function updateChromeRSS() {
  try {
    if (!browser) {
      lastChromeRssMB = 0;
      return;
    }
    const proc = browser.process?.();
    if (!proc) return;
    // Best-effort: на некоторых платформах не достать RSS дочернего процесса
  } catch {}
}

async function createPage() {
  const br = await getBrowser();
  let page;
  try {
    page = await br.newPage();
    activePages++;
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });

    // БОльшие таймауты на операции со страницей
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);

    return page;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log("⚠️ page open error:", e.message);
    try {
      await page?.close({ runBeforeUnload: false });
    } catch {}
    activePages = Math.max(0, activePages - 1);
    throw e;
  }
}

async function safeClosePage(page, afterError = false) {
  try {
    await page?.close({ runBeforeUnload: false });
  } catch {}
  activePages = Math.max(0, activePages - 1);
  if (afterError) log("🗑 page:closed after error active_pages=" + activePages);
  else log("🗑 page:closed active_pages=" + activePages);
}

/* ================== INDICATOR HUNTER ================== */
const INDICATOR_SELECTORS = ["#live-indicator", ".live-indicator", "[data-testid=\"live-indicator\"]"];

function framePath(f) {
  const names = [];
  let cur = f;
  while (cur) {
    names.unshift(cur.name() || "(anon)");
    cur = cur.parentFrame();
  }
  return names.join(" > ");
}
function logFrameTree(page) {
  try {
    const frs = page.frames();
    const info = frs
      .map((f) => {
        const u = f.url();
        const trimmed = u.length > 120 ? u.slice(0, 120) + "…" : u;
        return `{name:${f.name() || "-"}, url:${trimmed}}`;
      })
      .join(", ");
    log(`[frames] count=${frs.length} tree=[${info}]`);
  } catch {}
}

async function waitIndicatorOrExplain(page, timeoutMs, taskId) {
  const start = Date.now();
  const deadline = start + timeoutMs;

  // дождаться, пока уйдут блокировки UI
  await page
    .waitForFunction(() => getComputedStyle(document.body).pointerEvents !== "none", { timeout: 15_000 })
    .catch(() => {});
  log(`[ind] t#${taskId} pre-wait: pointerEvents unlocked`);
  logFrameTree(page);

  const selUnion = INDICATOR_SELECTORS.join(",");
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        const h = await f.$(selUnion);
        if (h) {
          const dt = Date.now() - start;
          const url = f.url();
          const inIframe = !!f.parentFrame();
          if (inIframe) metrics.ind_iframe_hits++;
          metrics.ind_found_selector++;
          metrics.ind_wait_samples_ms.push(dt);
          log(
            `[ind] t#${taskId} found via=selector_any_frame dt=${dt}ms iframe=${inIframe} framePath="${framePath(
              f
            )}" frameUrl="${url}"`
          );
          return { ok: true, reason: "selector_any_frame", frame: f, dt };
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // фолбэк по тексту во всех фреймах
  for (const f of page.frames()) {
    try {
      const ok = await f.evaluate(() => {
        const txt = (document.body?.innerText || "").trim();
        return /\bLIVE\b/i.test(txt) && /\b\d{1,4}\b/.test(txt);
      });
      if (ok) {
        const dt = Date.now() - start;
        metrics.ind_found_text++;
        metrics.ind_wait_samples_ms.push(dt);
        log(
          `[ind] t#${taskId} found via=text_fallback dt=${dt}ms framePath="${framePath(f)}" url="${f.url()}"`
        );
        return { ok: true, reason: "text_fallback_frames", frame: f, dt };
      }
    } catch {}
  }

  // диагностика
  const counts = [];
  for (const sel of INDICATOR_SELECTORS) {
    let sum = 0;
    for (const f of page.frames()) {
      try {
        sum += (await f.$$(sel)).length;
      } catch {}
    }
    counts.push({ sel, n: sum });
  }
  const ready = await page.evaluate(() => document.readyState).catch(() => "unknown");
  const dt = Date.now() - start;
  metrics.ind_timeout++;
  metrics.ind_wait_samples_ms.push(dt);
  log(`[ind] t#${taskId} MISS dt=${dt}ms ready=${ready} counts=${counts.map((c) => `${c.sel}:${c.n}`).join("|")}`);
  return { ok: false, reason: "timeout_or_missing", frame: null, dt };
}

async function getViewersOnce(page, preferFrame = null) {
  const tryRead = async (f) => {
    return await f.evaluate((selectors) => {
      const root = document.querySelector(selectors.join(","));
      let num = null;
      if (root) {
        const span = root.parentElement?.querySelector("span") || root.querySelector("span");
        const txt = (span?.textContent || root.textContent || "").trim();
        const m = txt.match(/\d{1,4}/);
        if (m) num = Number(m[0]);
      }
      if (num === null) {
        const txt = (document.body?.innerText || "").trim();
        const m2 = txt.match(/\b\d{1,4}\b/);
        if (m2) num = Number(m2[0]);
      }
      return Number.isFinite(num) ? num : null;
    }, INDICATOR_SELECTORS);
  };

  if (preferFrame) {
    try {
      const v = await tryRead(preferFrame);
      if (Number.isFinite(v)) return { ok: true, viewers: v };
    } catch {}
  }
  for (const f of page.frames()) {
    try {
      const v = await tryRead(f);
      if (Number.isFinite(v)) return { ok: true, viewers: v };
    } catch {}
  }
  return { ok: false, viewers: null, reason: "not_a_number" };
}

/* ================== VIEWERS TASK ================== */
async function notifyTelegram(mint, coin, fallbackName, fallbackSymbol, viewers) {
  const socials = extractOfficialSocials(coin);
  const title = `${coin.name || fallbackName} (${coin.symbol || fallbackSymbol})`;
  const mcapStr = typeof coin.usd_market_cap === "number" ? `$${formatNumber(coin.usd_market_cap)}` : "n/a";
  const msg = [
    `🎥 <b>LIVE START</b> | ${title}`,
    "",
    `Mint: <code>${mint}</code>`,
    `🔗 <b>Axiom:</b> https://axiom.trade/t/${mint}`,
    `💰 Market Cap: ${mcapStr}`,
    `👁 Viewers: ${viewers}`,
    "",
    socials.join("\n"),
  ].join("\n");

  const photoUrl = coin?.image_uri || null;
  log("📤 tg:send start");
  await sendTG({ text: msg, photo: photoUrl });
  log("✅ tg:sent");
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol, detectAt }) {
  const taskId = nextTaskId();
  metrics.viewerTasksStarted++;
  markHandled(mint);
  const t0 = detectAt || Date.now();
  log(`[task] t#${taskId} start mint=${mint} symbol=${coin?.symbol || fallbackSymbol}`);

  // быстрый recheck перед браузером — вдруг уже не live
  const pre = await safeGetJson(`${API}/coins/${mint}`);
  if (!pre || pre?.is_currently_live === false) {
    log(`⏭️ t#${taskId} skip: already_not_live dt=${Date.now() - t0}ms`);
    return;
  }

  let page;
  let reloads = 0;

  try {
    page = await createPage();

    const navStart = Date.now();
    log(`🌐 t#${taskId} goto:start url=https://pump.fun/coin/${mint}`);
    await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await new Promise((r) => setTimeout(r, 1200)); // догидратация
    const dtNav = Date.now() - navStart;
    log(`🌐 t#${taskId} goto:done dt_nav=${dtNav}ms`);

    let ind = await waitIndicatorOrExplain(page, INDICATOR_WAIT_MS, taskId);

    if (!ind.ok) {
      const again = await safeGetJson(`${API}/coins/${mint}`);
      if (again?.is_currently_live) {
        reloads++;
        log(`🔄 t#${taskId} reload#${reloads} API still live; short wait 12s`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page
          .waitForFunction(() => getComputedStyle(document.body).pointerEvents !== "none", { timeout: 10_000 })
          .catch(() => {});
        ind = await waitIndicatorOrExplain(page, 12_000, taskId);
        if (ind.ok) metrics.ind_found_after_reload++;
      }
    }

    if (!ind.ok) {
      metrics.viewerSelectorMiss++;
      await safeClosePage(page);
      log(`⏭️ t#${taskId} no-indicator; nav=${dtNav}ms reloads=${reloads} detect→end=${Date.now() - t0}ms`);
      return;
    }

    log(
      `🔎 t#${taskId} indicator ok via=${ind.reason} dt=${ind.dt}ms reloads=${reloads} iframe=${!!ind.frame?.parentFrame()}`
    );

    // Теперь включаем interception (ПОСЛЕ того, как нашли индикатор)
    await page.setRequestInterception(true).catch(() => {});
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media") return req.abort();
      // шрифты не режем — иногда от них зависит индикатор
      req.continue();
    });

    // 3 сэмпла
    let maxV = -1;
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const s = await getViewersOnce(page, ind.frame || null);
      if (!s.ok) {
        log(`📊 t#${taskId} sample ${i}/${SAMPLE_COUNT} miss reason=${s.reason}`);
      } else {
        maxV = Math.max(maxV, s.viewers);
        log(`📊 t#${taskId} sample ${i}/${SAMPLE_COUNT} viewers=${s.viewers}`);
        if (s.viewers >= VIEWERS_THRESHOLD) {
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, s.viewers);
          await safeClosePage(page);
          log(`✅ t#${taskId} threshold hit v=${s.viewers} total=${Date.now() - t0}ms`);
          metrics.viewerTasksDone++;
          return;
        }
      }
      if (i < SAMPLE_COUNT) await new Promise((r) => setTimeout(r, SAMPLE_STEP_MS));
    }

    await safeClosePage(page);
    log(`⏭️ t#${taskId} threshold miss max=${maxV < 0 ? "n/a" : maxV} total=${Date.now() - t0}ms`);
    metrics.viewerTasksDone++;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log("⚠️ viewers task error:", e.message);
    await safeClosePage(page, true);
  }
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= VIEWERS_CONCURRENCY || viewersQueue.length === 0) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const job = viewersQueue.shift();
    viewersInQueue.delete(job.mint);

    viewersActive++;
    const detectAt = job.enqueuedAt;
    const task = viewersTask({ ...job, detectAt });

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("viewer task timeout")), VIEWERS_TASK_TIMEOUT));
    try {
      await Promise.race([task, timeout]);
    } catch (e) {
      metrics.viewerTasksDropped++;
      log("⚠️ viewers task dropped:", e.message);
    } finally {
      viewersActive--;
    }
  }
}

/* ================== API WORKER ================== */
async function apiWorkerLoop() {
  while (true) {
    let idx = -1;
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= now) {
        idx = i;
        break;
      }
    if (idx === -1) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;
    if (Date.now() > expiresAt) {
      inQueue.delete(mint);
      continue;
    }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) {
      item.nextTryAt = Date.now() + 4000;
      queue.push(item);
      continue;
    }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) {
        inQueue.delete(mint);
        continue; // фильтр: без соцсетей не тратим браузер
      }

      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);
      continue;
    }

    // пока не live — ещё попробуем позже
    item.nextTryAt = Date.now() + 4000;
    queue.push(item);
  }
}

/* ================== WEBSOCKET ================== */
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    const nm = msg?.name || msg?.tokenName || "";
    const sm = msg?.symbol || msg?.ticker || "";
    enqueue(mint, nm, sm);
  });

  ws.on("close", () => {
    metrics.reconnects++;
    log(`🔌 WS closed → Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => log("❌ WS error:", e.message));
}

/* ================== HEARTBEAT & RES ================== */
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
      `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
      `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
      `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
      `vQ=${viewersQueue.length} vRun=${viewersActive} vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} ` +
      `vDrop=${metrics.viewerTasksDropped} vOpenErr=${metrics.viewerOpenErrors} vSelMiss=${metrics.viewerSelectorMiss} active_pages=${activePages}`
  );
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try {
      ws?.terminate();
    } catch {}
  }
}, 60_000);

// ресурсы раз в 15с
setInterval(async () => {
  await updateChromeRSS();
  await logResources();
}, RES_LOG_EVERY_MS);

// индикаторная сводка каждые 5 минут
setInterval(() => {
  const a = metrics.ind_wait_samples_ms;
  const p50 = pct(a, 50),
    p90 = pct(a, 90),
    p99 = pct(a, 99);
  console.log(
    `[ind-sum] samples=${a.length} p50=${p50}ms p90=${p90}ms p99=${p99}ms ` +
      `found_sel=${metrics.ind_found_selector} found_text=${metrics.ind_found_text} ` +
      `found_after_reload=${metrics.ind_found_after_reload} timeouts=${metrics.ind_timeout} iframe_hits=${metrics.ind_iframe_hits}`
  );
}, 300_000);

/* ================== STARTUP/SHUTDOWN ================== */
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on("SIGTERM", async () => {
  try {
    await browser?.close();
  } catch {}
  process.exit(0);
});
process.on("SIGINT", async () => {
  try {
    await browser?.close();
  } catch {}
  process.exit(0);
});
