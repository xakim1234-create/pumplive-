// index.js — v8.0.0
import os from "os";
import process from "process";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ================== CONFIG (всё из ENV) ================== */
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data";
const API = process.env.PUMP_API || "https://frontend-api-v3.pump.fun";

// Telegram (не хардкодим!)
// Пример запуска: TG_TOKEN=xxx TG_CHAT_ID=yyy node index.js
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

// REST троттлинг
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 1500); // ~0.66 rps
const MAX_LIFETIME_MS = Number(process.env.MAX_LIFETIME_MS || 120_000); // ждать LIVE до 2 минут
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 1000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 2);

// “Зрители”
const VIEWERS_THRESHOLD = Number(process.env.VIEWERS_THRESHOLD || 30);

// Индикатор/пулинг
const INDICATOR_WAIT_TOTAL_MS = Number(process.env.INDICATOR_WAIT_TOTAL_MS || 25_000);
const POLL_PHASES = [
  { untilMs: 3000, everyMs: 250 },   // быстрый старт: 0–3 c → каждые 250 мс
  { untilMs: 10_000, everyMs: 600 }, // 3–10 c
  { untilMs: 20_000, everyMs: 1000 },// 10–20 c
  { untilMs: 25_000, everyMs: 1500 } // 20–25 c
];

const SAMPLE_COUNT = Number(process.env.SAMPLE_COUNT || 3);
const SAMPLE_STEP_MS = Number(process.env.SAMPLE_STEP_MS || 3000);
const VIEWERS_TASK_TIMEOUT = Number(process.env.VIEWERS_TASK_TIMEOUT || 60_000);

// Браузер
const VIEWERS_CONCURRENCY = Number(process.env.VIEWERS_CONCURRENCY || 1);
const UA =
  process.env.UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// Диагностика ресурсов
const RES_LOG_EVERY_MS = Number(process.env.RES_LOG_EVERY_MS || 15_000);

// Дедуп (не брать тот же mint 10 минут)
const DEDUP_TTL_MS = Number(process.env.DEDUP_TTL_MS || 10 * 60_000);

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
};
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/* ================== REST-троттлер и безопасный fetch ================== */
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await new Promise((r) => setTimeout(r, nextAvailableAt - now));
  }
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/8.0.0",
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
    log("⚠️ telegram send error:", e.message);
  }
}

/* ================== API QUEUE ================== */
const inQueue = new Set();
const queue = []; // [{ mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }]
function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({
    mint,
    name,
    symbol,
    enqueuedAt: now,
    expiresAt: now + MAX_LIFETIME_MS,
    nextTryAt: now,
  });
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
  if (isRecentlyHandled(mint)) return;
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: Date.now() });
  viewersInQueue.add(mint);
}

/* ================== BROWSER ================== */
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
    protocolTimeout: 20_000,
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

let activePages = 0;
let lastChromeRssMB = 0;

async function logResources() {
  try {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);
    const load1 = (osLoadAvg1() || 0).toFixed(2);
    const extra = browser ? ` rss_chrome=${lastChromeRssMB ? lastChromeRssMB.toFixed(1) + "MB" : "n/a"}` : "";
    console.log(
      `[res] cpu_node=${(process.cpuUsage().user / 1e6).toFixed(1)}% rss_node=${rssMB}MB heap_node=${heapMB}MB load1=${load1} active_pages=${activePages}${extra}`
    );
  } catch {}
}

function osLoadAvg1() {
  try {
    return os.loadavg?.()[0];
  } catch {
    return 0;
  }
}

async function updateChromeRSS() {
  try {
    if (!browser) {
      lastChromeRssMB = 0;
      return;
    }
    // best-effort: недоступно кросс-процессно — оставляем предыдущий замер
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

    // Лёгкий антидетект
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        const _plugins = [{ name: "Chrome PDF Viewer" }];
        Object.defineProperty(navigator, "plugins", { get: () => _plugins });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        // Заглушка для chrome.runtime
        // @ts-ignore
        window.chrome = window.chrome || {};
        // @ts-ignore
        window.chrome.runtime = window.chrome.runtime || {};
      } catch {}
    });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media") return req.abort(); // не режем fonts/XHR/WS
      req.continue();
    });

    page.setDefaultTimeout(15_000);
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

/* ================== INDICATOR FINDING (frames + shadow + text fallback) ================== */

const INDICATOR_SELECTORS = ["#live-indicator", ".live-indicator", '[data-testid="live-indicator"]'];
const OVERLAY_HINTS = ["#nprogress", ".nprogress-busy"];

function parseViewersFromText(s) {
  // Поддержка: "1,234", "1.2k", "987 viewers", "Live • 234"
  const lower = s.toLowerCase();
  const kMatch = lower.match(/(\d+(?:[.,]\d+)?)\s*k\b/);
  if (kMatch) return Math.round(parseFloat(kMatch[1].replace(",", ".")) * 1000);

  const mMatch = lower.match(/(\d+(?:[.,]\d+)?)\s*m\b/);
  if (mMatch) return Math.round(parseFloat(mMatch[1].replace(",", ".")) * 1_000_000);

  const viewersMatch = lower.match(/(\d{1,3}(?:[.,]\d{3})+|\d{1,4})\s*(?:viewer|viewers)?\b/);
  if (viewersMatch) {
    const raw = viewersMatch[1].replace(/\./g, "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // просто первая цифра 1–4 знака
  const plain = lower.match(/\b\d{1,4}\b/);
  if (plain) return Number(plain[0]);

  return null;
}

function isVisibleRect(rect) {
  if (!rect) return false;
  const { width, height } = rect;
  return width > 0 && height > 0;
}

async function waitHydrationGate(page, deadlineMs) {
  const t0 = Date.now();
  // ждём исчезновения оверлея/pointer-events:none/nprogress
  while (Date.now() - t0 < deadlineMs) {
    const gate = await page.evaluate((OVERLAY_HINTS) => {
      const body = document.body;
      const pointerNone = body?.style?.pointerEvents === "none";
      const nprogress = OVERLAY_HINTS.some((sel) => !!document.querySelector(sel));
      const ready = document.readyState;
      return {
        pointerNone,
        nprogress,
        ready,
        next: !!document.querySelector("#__next"),
        root: !!document.querySelector("#root"),
      };
    }, OVERLAY_HINTS);

    if (!gate.pointerNone && !gate.nprogress && (gate.ready === "complete" || gate.ready === "interactive"))
      return { ok: true, gate };

    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, gate: null };
}

async function evaluateInAllFrames(page, fn, ...args) {
  const frames = page.frames();
  const results = [];
  for (const fr of frames) {
    try {
      const r = await fr.evaluate(fn, ...args);
      results.push({ ok: true, frameUrl: fr.url(), value: r });
    } catch (e) {
      results.push({ ok: false, frameUrl: fr.url(), error: String(e) });
    }
  }
  return results;
}

// Поиск индикатора: сначала селекторы (с shadow), затем текстовый фоллбек в каждом фрейме
async function findIndicatorOnce(page) {
  const res = await evaluateInAllFrames(
    page,
    (INDICATOR_SELECTORS) => {
      function deepQuery(root, selectors) {
        // обходим обычные узлы и shadowRoot
        const stack = [root];
        while (stack.length) {
          const el = stack.pop();
          if (!el) continue;
          for (const sel of selectors) {
            const found = el.querySelector?.(sel);
            if (found) {
              const rect = found.getBoundingClientRect?.();
              const txt = found.textContent || "";
              let num = null;
              // попытаемся взять цифру у соседей/родителя
              const near = found.parentElement?.innerText || txt || "";
              num = near;
              return { found: true, via: "selector", text: near, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
            }
          }
          // Shadow DOM
          if (el.shadowRoot) {
            stack.push(el.shadowRoot);
          }
          // Дочерние
          if (el.children?.length) {
            for (const ch of el.children) stack.push(ch);
          }
        }
        return { found: false, via: "selector" };
      }

      const doc = document;
      const result = deepQuery(doc, INDICATOR_SELECTORS);
      if (result.found) return result;

      // Текстовый фоллбек (весь фрейм)
      const bodyTxt = (document.body?.innerText || "").slice(0, 20_000);
      return { found: !!bodyTxt, via: "text", text: bodyTxt, rect: null };
    },
    INDICATOR_SELECTORS
  );

  // Постобработка: если via=selector — проверим видимость; если via=text — попытаемся распарсить число позже
  return res;
}

async function waitIndicatorOrExplain(page, totalWaitMs) {
  const t0 = Date.now();
  const gate = await waitHydrationGate(page, Math.min(3000, totalWaitMs));
  if (!gate.ok) {
    log("[gate] hydration:timeout_or_overlay");
  } else {
    log(`[gate] hydration:ready ready=${gate.gate.ready} next=${gate.gate.next} root=${gate.gate.root}`);
  }

  let lastDiag = null;
  let elapsed = 0;
  for (const phase of POLL_PHASES) {
    while (elapsed < Math.min(phase.untilMs, totalWaitMs)) {
      const t = Date.now();
      const results = await findIndicatorOnce(page);
      // Сведём по фреймам: ищем лучший кандидат
      let best = null;
      for (const r of results) {
        if (!r.ok) continue;
        const v = r.value;
        if (v?.found && v?.via === "selector") {
          // селектор — супер
          best = { type: "selector", text: v.text || "", rect: v.rect, frameUrl: r.frameUrl };
          break;
        }
      }
      if (!best) {
        // нет селектора — попробуем текст
        for (const r of results) {
          if (!r.ok) continue;
          const v = r.value;
          if (v?.via === "text" && v?.text) {
            // попытаемся найти «LIVE» + число
            const hasLive = /\bLIVE\b/i.test(v.text);
            const parsed = parseViewersFromText(v.text);
            if (hasLive && parsed !== null) {
              best = { type: "text", text: v.text.slice(0, 2000), rect: null, frameUrl: r.frameUrl, viewers: parsed };
              break;
            }
          }
        }
      }

      if (best) {
        // дополнительная проверка видимости для селектора
        if (best.type === "selector" && best.rect && !isVisibleRect(best.rect)) {
          lastDiag = { reason: "found_but_invisible", rect: best.rect, frameUrl: best.frameUrl };
        } else {
          // успех
          return { ok: true, best, elapsedMs: Date.now() - t0, via: best.type };
        }
      } else {
        // соберем лёгкую диагностику
        const diag = await page.evaluate((INDICATOR_SELECTORS) => {
          const count = (sel) => document.querySelectorAll(sel).length;
          const counts = INDICATOR_SELECTORS.map((s) => ({ sel: s, n: count(s) }));
          const iframes = document.querySelectorAll("iframe").length;
          const ready = document.readyState;
          const bodyPreview = (document.body?.outerHTML || "").slice(0, 1000);
          const txt = (document.body?.innerText || "").slice(0, 2000);
          return { counts, iframes, ready, bodyPreview, liveTxt: /\bLIVE\b/i.test(txt) };
        }, INDICATOR_SELECTORS);
        lastDiag = { reason: "polling", diag };
      }

      const dt = Date.now() - t;
      const sleep = Math.max(phase.everyMs - dt, 50);
      await new Promise((r) => setTimeout(r, sleep));
      elapsed = Date.now() - t0;
      if (elapsed >= totalWaitMs) break;
    }
    if (elapsed >= totalWaitMs) break;
  }

  // Расширенная диагностика
  const d = await page.evaluate((INDICATOR_SELECTORS) => {
    const counts = INDICATOR_SELECTORS.map((s) => ({ sel: s, n: document.querySelectorAll(s).length }));
    const ready = document.readyState;
    const hasNext = !!document.querySelector("#__next");
    const hasRoot = !!document.querySelector("#root");
    const iframes = document.querySelectorAll("iframe").length;
    const txt = (document.body?.innerText || "").slice(0, 5000);
    const liveTxt = /\bLIVE\b/i.test(txt);
    const digits = /\b\d{1,4}\b/.test(txt);
    const nav = performance.getEntriesByType("navigation")[0];
    const perf = nav
      ? {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          responseEnd: Math.round(nav.responseEnd - nav.startTime),
        }
      : null;
    return {
      ready,
      counts,
      hasNext,
      hasRoot,
      iframes,
      liveTxt,
      digits,
      perf,
      bodyPreview: (document.body?.outerHTML || "").slice(0, 1200),
    };
  }, INDICATOR_SELECTORS);

  const ua = await page.browser().userAgent();
  const vp = page.viewport();
  log(
    `[diag] indicator:miss ready=${d.ready} next=${d.hasNext} root=${d.hasRoot} iframes=${d.iframes} + counts=${d.counts
      .map((c) => `${c.sel}:${c.n}`)
      .join("|")} liveTxt=${d.liveTxt} digits=${d.digits} + perf=${d.perf ? JSON.stringify(d.perf) : "n/a"} ua=${ua} viewport=${vp?.width}x${vp?.height}`
  );
  log("[diag] bodyPreview:", d.bodyPreview.replace(/\s+/g, " ").slice(0, 1000));
  if (lastDiag) log("[diag] last:", JSON.stringify(lastDiag).slice(0, 1000));
  return { ok: false, reason: "timeout_or_missing", details: d };
}

async function getViewersOnce(page) {
  // Оценка во всех фреймах: сначала селектор-контекст, затем текст
  const results = await evaluateInAllFrames(
    page,
    (INDICATOR_SELECTORS) => {
      function getNearNumber(el) {
        const near = el?.parentElement?.innerText || el?.textContent || "";
        return near;
      }
      for (const sel of INDICATOR_SELECTORS) {
        const node = document.querySelector(sel);
        if (node) {
          const near = getNearNumber(node);
          return { via: "selector", text: near };
        }
      }
      const bodyTxt = (document.body?.innerText || "").slice(0, 20_000);
      return { via: "text", text: bodyTxt };
    },
    INDICATOR_SELECTORS
  );

  for (const r of results) {
    if (!r.ok) continue;
    const v = r.value;
    if (!v?.text) continue;
    const parsed = parseViewersFromText(v.text);
    if (parsed !== null) return { ok: true, viewers: parsed, via: v.via };
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
    `Mint: <code>${mint}</code>`,
    `🔗 <b>Axiom:</b> https://axiom.trade/t/${mint}`,
    `💰 Market Cap: ${mcapStr}`,
    `👁 Viewers: ${viewers}`,
    socials.join("\n"),
  ].join("\n");

  const photoUrl = coin?.image_uri || null;
  log("📤 tg:send start");
  await sendTG({ text: msg, photo: photoUrl });
  log("✅ tg:sent");
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol, detectAt }) {
  metrics.viewerTasksStarted++;
  markHandled(mint);
  const t0 = detectAt || Date.now();

  // быстрый recheck перед браузером
  const pre = await safeGetJson(`${API}/coins/${mint}`);
  if (!pre || pre?.is_currently_live === false) {
    log(`⏭️ skip before_browser mint=${mint} reason=already_not_live t_detect→taskStart=${Date.now() - t0}ms`);
    return;
  }

  const diag = { consoleErrors: [], pageErrors: [], reqFailed: [] };
  let page;

  try {
    page = await createPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") diag.consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => diag.pageErrors.push(String(err)));
    page.on("requestfailed", (req) => {
      diag.reqFailed.push({
        url: req.url(),
        failure: req.failure()?.errorText,
        method: req.method(),
        type: req.resourceType(),
      });
    });

    const navStart = Date.now();
    log(`🌐 goto:start url=https://pump.fun/coin/${mint}`);
    await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const dtNav = Date.now() - navStart;
    await new Promise((r) => setTimeout(r, 800)); // короткая пауза вместо 1500
    log(`🌐 goto:done dt_nav=${dtNav}ms wait_dom_extra=800ms`);

    // умное ожидание индикатора (фазы)
    const indStart = Date.now();
    const ind = await waitIndicatorOrExplain(page, INDICATOR_WAIT_TOTAL_MS);
    const dtInd = Date.now() - indStart;

    if (!ind.ok) {
      log(`🔎 live-indicator:found=false dt=${dtInd}ms reason=${ind.reason}`);
      // ещё раз API — возможно, уже не live
      const again = await safeGetJson(`${API}/coins/${mint}`);
      if (!again || again?.is_currently_live === false) {
        await safeClosePage(page);
        log(
          `⏭️ skip reason=no_indicator_but_now_not_live timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicatorWait=${dtInd}ms detect→skip=${Date.now() - t0}ms`
        );
        return;
      }

      // Попытка «быстрого» перезахода один раз (SPA иногда чинится)
      log("🔁 reload:quick_try");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      await new Promise((r) => setTimeout(r, 600));
      const ind2 = await waitIndicatorOrExplain(page, Math.max(6000, INDICATOR_WAIT_TOTAL_MS / 3));
      if (!ind2.ok) {
        metrics.viewerSelectorMiss++;
        await safeClosePage(page);
        log(
          `⏭️ skip reason=no_indicator_after_reload timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicatorWait=${dtInd}ms detect→skip=${Date.now() - t0}ms`
        );
        return;
      } else {
        log(`🔎 live-indicator:found=true (after reload) dt=${Date.now() - indStart}ms via=${ind2.via}`);
      }
    } else {
      log(`🔎 live-indicator:found=true dt=${dtInd}ms via=${ind.via}`);
    }

    // 3 сэмпла по ~3 секунды (или что задано)
    let maxV = -1;
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const s = await getViewersOnce(page);
      if (!s.ok) {
        log(`📊 sample i=${i}/${SAMPLE_COUNT} ok=false reason=${s.reason}`);
      } else {
        maxV = Math.max(maxV, s.viewers);
        log(`📊 sample i=${i}/${SAMPLE_COUNT} ok=true via=${s.via} viewers=${s.viewers}`);
        if (s.viewers >= VIEWERS_THRESHOLD) {
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, s.viewers);
          await safeClosePage(page);
          log(
            `✅ threshold:hit viewers=${s.viewers} early=true timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicator=${dtInd}ms indicator→samples=${Date.now() - indStart}ms detect→checked=${Date.now() - t0}ms`
          );
          metrics.viewerTasksDone++;
          return;
        }
      }
      if (i < SAMPLE_COUNT) await new Promise((r) => setTimeout(r, SAMPLE_STEP_MS));
    }

    await safeClosePage(page);
    log(
      `⏭️ threshold:miss max=${maxV < 0 ? "n/a" : maxV} timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicator=${dtInd}ms indicator→samples=${Date.now() - indStart}ms detect→checked=${Date.now() - t0}ms`
    );
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
        continue;
      }
      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();
      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`socials: ${socials.join(" ")}`);
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
    log("🔌 WS closed → Reconnecting in 5s…");
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
    `[stats] watchers=${queueSize()} ws_last=${secSinceWs}s live_last=${minSinceLive}m ` +
      `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
      `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
      `null=${metrics.skippedNull} reconnects=${metrics.reconnects} ` +
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
