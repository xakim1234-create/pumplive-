// index.js — v7.6.0
// - Indicator wait: 25s
// - Samples: every 1s up to 10s (early exit on first >= threshold)
// - Pre-API check before browser, mid-API check after navigation
// - Timeline logs (detect→checked etc.)
// - Resource monitor (CPU/RAM/Chrome pages)
// - Chromium optimized flags + no cache + bypass SW

import WebSocket from "ws";
import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import os from "os";
import fs from "fs/promises";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram (используй переменные окружения на Render)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

// === API очередь ===
const MIN_GAP_MS = 1500;
const MAX_LIFETIME_MS = 120_000;
const MAX_QUEUE = 1000;
const MAX_RETRIES = 2;

// === Viewers ===
const VIEWERS_THRESHOLD = 30;
const INDICATOR_WAIT_MS = 25_000;
const SAMPLE_STEP_MS = 1_000; // 1s
const SAMPLE_MAX = 10;        // максимум 10 выборок (до ~10s)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
  viewerTasksStarted: 0, viewerTasksDone: 0,
  viewerTasksDropped: 0, viewerOpenErrors: 0,
  viewerSelectorMiss: 0,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }
const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dt = (ms) => `${ms}ms`;

// ——— throttle
let nextAvailableAt = 0;
async function throttle() {
  const t = now();
  if (t < nextAvailableAt) await sleep(nextAvailableAt - t);
  nextAvailableAt = now() + MIN_GAP_MS;
}

// ——— safeGetJson
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/7.6.0"
        }
      });
      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = now() + waitMs;
        await sleep(waitMs);
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
        await sleep(400 * (attempt + 1));
        continue;
      }
      metrics.skippedNull++;
      return null;
    }
  }
}

// ——— socials
function extractOfficialSocials(coin) {
  const s = [];
  if (coin?.website) s.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter) s.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) s.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord) s.push(`🎮 <b>Discord:</b> ${coin.discord}`);
  return s;
}

// ——— Telegram
async function sendTG({ text, photo }) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    if (photo) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: "HTML" })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
      });
    }
  } catch (e) {
    log("⚠️ telegram send error:", e.message);
  }
}

// ===================== API очередь =====================
const inQueue = new Set();
const queue = []; // items: { mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }

function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const t = now();
  queue.push({ mint, name, symbol, enqueuedAt: t, expiresAt: t + MAX_LIFETIME_MS, nextTryAt: t });
  inQueue.add(mint);
}
function requeue(item) { item.nextTryAt = now() + 4000; queue.push(item); }
function queueSize() { return inQueue.size; }

async function apiWorkerLoop() {
  while (true) {
    let idx = -1; const t = now();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= t) { idx = i; break; }
    if (idx === -1) { await sleep(250); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt, enqueuedAt } = item;
    if (now() > expiresAt) { inQueue.delete(mint); continue; }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) { requeue(item); continue; }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { inQueue.delete(mint); continue; } // оставляем твой базовый фильтр

      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol, detectedAt: now(), enqueuedAt });
      lastLiveAt = now();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);
      continue;
    }

    requeue(item);
  }
}

// ===================== Viewers =====================
const viewersQueue = [];
let browser = null;
let viewersActive = 0; // оставляем 1 из-за 512MB RAM

function enqueueViewers({ mint, coin, fallbackName = "", fallbackSymbol = "", detectedAt, enqueuedAt }) {
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, detectedAt, enqueuedAt });
}

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
      "--single-process",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--disable-features=Translate,BackForwardCache,InterestCohort,PaintHolding",
      "--blink-settings=imagesEnabled=false"
    ],
    headless: chromium.headless,
    protocolTimeout: 180_000
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

// ——— единичная выборка зрителей (через fallback селекторы)
async function checkViewersOnce(pg) {
  return await pg.evaluate(() => {
    const pick = (txt) => {
      const m = (txt || "").match(/\d{1,6}/);
      return m ? Number(m[0]) : null;
    };
    const roots = [
      document.querySelector('#live-indicator'),
      document.querySelector('[data-testid*="live" i]'),
      document.querySelector('[class*="live"][class*="indicator"]'),
      Array.from(document.querySelectorAll('span,div,b,strong')).find(n => /live/i.test(n.textContent || '')) || null,
    ].filter(Boolean);

    for (const root of roots) {
      let span = root.querySelector(':scope > span') ||
                 root.parentElement?.querySelector('span') ||
                 root.closest('div')?.querySelector('span');
      const n = span ? pick(span.textContent) : null;
      if (Number.isFinite(n)) return { ok: true, viewers: n };
    }
    return { ok: false, reason: 'no_live_indicator' };
  });
}

async function viewersTask(job) {
  const { mint, coin, fallbackName, fallbackSymbol, detectedAt } = job;
  metrics.viewerTasksStarted++;
  const taskStartAt = now();

  // ——— Пред-проверка API до браузера
  const preApi = await safeGetJson(`${API}/coins/${mint}`);
  if (!preApi?.is_currently_live) {
    const tDetectToNow = taskStartAt - detectedAt;
    log(`⏭️ skip before_browser mint=${mint} reason=already_not_live t_detect→taskStart=${dt(tDetectToNow)}`);
    metrics.viewerTasksDone++;
    return;
  }

  let br, pg;
  try {
    br = await getBrowser();
    pg = await br.newPage();

    // базовые настройки вкладки
    await pg.setUserAgent(UA);
    await pg.setViewport({ width: 1280, height: 800 });

    // выключаем кеш/ServiceWorker/CSP для предсказуемости
    try { await pg.setCacheEnabled(false); } catch {}
    try { await pg.setBypassCSP(true); } catch {}
    try { await pg._client().send('Network.setBypassServiceWorker', { bypass: true }); } catch {}

    // блокируем тяжелые ресурсы
    await pg.setRequestInterception(true);
    pg.on("request", req => {
      const t = req.resourceType();
      if (t === "image" || t === "font" || t === "media" || t === "stylesheet") return req.abort();
      req.continue();
    });

    pg.setDefaultTimeout(60_000);
    pg.setDefaultNavigationTimeout(60_000);

    log(`▶️ viewers:start mint=${mint} name="${coin?.name || fallbackName}" symbol="${coin?.symbol || fallbackSymbol}"`);

    // ——— Навигация
    const navStartAt = now();
    const url = `https://pump.fun/coin/${mint}`;
    log(`🌐 goto:start url=${url}`);
    await pg.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1500); // стабилизация
    const navDoneAt = now();
    log(`🌐 goto:done dt_nav=${dt(navDoneAt - navStartAt)} wait_dom_extra=1500ms`);

    // ——— Mid-API check (мог умереть во время навигации)
    const midApi = await safeGetJson(`${API}/coins/${mint}`);
    if (!midApi?.is_currently_live) {
      const tDetectToNow2 = now() - detectedAt;
      log(`⏭️ skip mid_check reason=not_live_anymore t_detect→now=${dt(tDetectToNow2)}`);
      metrics.viewerTasksDone++;
      await pg.close();
      log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
      return;
    }

    // ——— Ожидание индикатора (25s)
    const selStartAt = now();
    let indicatorFound = true;
    try {
      await pg.waitForSelector("#live-indicator", { timeout: INDICATOR_WAIT_MS });
      log(`🔎 live-indicator:found=true dt=${dt(now() - selStartAt)}`);
    } catch {
      indicatorFound = false;
      metrics.viewerSelectorMiss++;
      log(`🔎 live-indicator:found=false dt=${dt(now() - selStartAt)} reason=timeout_or_missing`);

      // Финальная перепроверка API
      const finalApi = await safeGetJson(`${API}/coins/${mint}`);
      const apiLive = !!finalApi?.is_currently_live;
      log(`🔁 api:recheck_live=${apiLive}`);
      metrics.viewerTasksDone++;
      await pg.close();
      log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
      log(`⏭️ skip reason=${apiLive ? 'no_indicator_but_still_live' : 'no_indicator_and_not_live'} ` +
          `timeline detect→taskStart=${dt(taskStartAt - detectedAt)} ` +
          `taskStart→navDone=${dt(navDoneAt - taskStartAt)} ` +
          `navDone→indicatorWait=${dt(now() - navDoneAt)} ` +
          `detect→skip=${dt(now() - detectedAt)}`);
      return;
    }

    // ——— Замеры: каждую 1s до 10s (ранний выход при первом >= threshold)
    let maxV = -1;
    const measStartAt = now();
    let hitEarly = false;
    for (let i = 1; i <= SAMPLE_MAX; i++) {
      const res = await checkViewersOnce(pg);
      if (res.ok) {
        maxV = Math.max(maxV, res.viewers);
        log(`📊 sample i=${i}/${SAMPLE_MAX} ok=true viewers=${res.viewers}`);
        if (res.viewers >= VIEWERS_THRESHOLD) {
          hitEarly = true;
          break; // ранний выход
        }
      } else {
        log(`📊 sample i=${i}/${SAMPLE_MAX} ok=false reason=${res.reason}`);
      }
      if (i < SAMPLE_MAX) await sleep(SAMPLE_STEP_MS);
    }
    const measDoneAt = now();

    // ——— Таймлайны
    const tDetectToTaskStart = taskStartAt - detectedAt;
    const tTaskStartToNavDone = navDoneAt - taskStartAt;
    const tNavDoneToIndicator = selStartAt - navDoneAt;
    const tIndicatorToSamples = measDoneAt - selStartAt;
    const tDetectToChecked = measDoneAt - detectedAt;

    if (maxV >= VIEWERS_THRESHOLD) {
      const socials = extractOfficialSocials(coin);
      const title = `${coin?.name || fallbackName} (${coin?.symbol || fallbackSymbol})`;
      const mcapStr = typeof coin.usd_market_cap === "number" ? `$${coin?.usd_market_cap.toFixed(2)}` : "n/a";
      const msg = [
        `🎥 <b>LIVE START</b> | ${title}`,
        ``,
        `Mint: <code>${mint}</code>`,
        `💰 Market Cap: ${mcapStr}`,
        `👁 Viewers: ${maxV}`,
        ``,
        socials.join("\n")
      ].join("\n");

      log(`✅ threshold:hit viewers=${maxV} early=${hitEarly} ` +
          `timeline detect→taskStart=${dt(tDetectToTaskStart)} ` +
          `taskStart→navDone=${dt(tTaskStartToNavDone)} ` +
          `navDone→indicator=${dt(tNavDoneToIndicator)} ` +
          `indicator→samples=${dt(tIndicatorToSamples)} ` +
          `detect→checked=${dt(tDetectToChecked)}`);

      log("📤 tg:send start");
      await sendTG({ text: msg, photo: coin?.image_uri || null });
      log("✅ tg:sent");
    } else {
      log(`⏭️ threshold:miss max=${maxV} ` +
          `timeline detect→taskStart=${dt(tDetectToTaskStart)} ` +
          `taskStart→navDone=${dt(tTaskStartToNavDone)} ` +
          `navDone→indicator=${dt(tNavDoneToIndicator)} ` +
          `indicator→samples=${dt(tIndicatorToSamples)} ` +
          `detect→checked=${dt(tDetectToChecked)}`);
    }

    metrics.viewerTasksDone++;
    await pg.close();
    log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
  } catch (e) {
    metrics.viewerOpenErrors++;
    log(`⚠️ viewers task error: ${e.message}`);
    try { await pg?.close(); log(`🗑 page:closed after error active_pages=${(await browser?.pages())?.length ?? 0}`); } catch {}
  }
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= 1 || viewersQueue.length === 0) {
      await sleep(100);
      continue;
    }
    const job = viewersQueue.shift();
    viewersActive++;
    try { await viewersTask(job); }
    catch (e) { metrics.viewerTasksDropped++; log("⚠️ viewers task dropped:", e.message); }
    finally { viewersActive--; await sleep(200); }
  }
}

// ===================== WS =====================
function connect() {
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });
  ws.on("message", raw => {
    lastWsMsgAt = now();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
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

// ===================== Heartbeat =====================
setInterval(async () => {
  const t = now();
  const secSinceWs = lastWsMsgAt ? Math.round((t - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((t - lastLiveAt) / 60000) : -1;
  const pages = browser ? await browser.pages() : [];
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
    `vQ=${viewersQueue.length} vRun=${viewersActive} ` +
    `vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} vDrop=${metrics.viewerTasksDropped} ` +
    `vOpenErr=${metrics.viewerOpenErrors} vSelMiss=${metrics.viewerSelectorMiss} active_pages=${pages.length}`
  );
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// ==== RESOURCE MONITOR ======================
function fmtMB(bytes){ return (bytes/1024/1024).toFixed(1); }
async function readProcStatm(pid) {
  try {
    const txt = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const parts = txt.trim().split(/\s+/).map(Number);
    const pageSize = 4096;
    const residentBytes = (parts[1] || 0) * pageSize;
    return residentBytes;
  } catch { return null; }
}
function startResourceLogger(intervalMs = 15000) {
  let lastCpu = process.cpuUsage();
  let lastTime = now();
  setInterval(async () => {
    const nowT = now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsedMs = nowT - lastTime || 1;
    lastCpu = process.cpuUsage();
    lastTime = nowT;
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cores = os.cpus().length || 1;
    const nodeCpuPct = (cpuMs / elapsedMs) * 100 / cores;

    const mem = process.memoryUsage();
    const nodeRssMB = fmtMB(mem.rss);
    const nodeHeapMB = fmtMB(mem.heapUsed);
    const [load1] = os.loadavg();

    let activePages = 0;
    try { activePages = browser ? (await browser.pages()).length : 0; } catch {}

    let chromeRssMB = null;
    try {
      const bproc = browser?.process?.();
      if (bproc?.pid) {
        const rss = await readProcStatm(bproc.pid);
        if (rss != null) chromeRssMB = fmtMB(rss);
      }
    } catch {}

    console.log(
      new Date().toISOString(),
      `[res] cpu_node=${nodeCpuPct.toFixed(1)}% rss_node=${nodeRssMB}MB heap_node=${nodeHeapMB}MB ` +
      `load1=${load1.toFixed(2)} active_pages=${activePages}` +
      (chromeRssMB ? ` rss_chrome=${chromeRssMB}MB` : "")
    );
  }, intervalMs).unref();
}
startResourceLogger(15000);

// ===================== Start =====================
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(0); });
process.on("SIGINT",  async () => { try { await browser?.close(); } catch {} process.exit(0); });
