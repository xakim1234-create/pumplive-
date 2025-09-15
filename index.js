// index.js — v8.1.0 (robust indicator + frames/shadow + smart fallback + staged polling + rich diagnostics)
import os from "os";
import process from "process";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ================== CONFIG (ENV) ================== */
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data";
const API = process.env.PUMP_API || "https://frontend-api-v3.pump.fun";

const TG_TOKEN = process.env.TG_TOKEN || "";   // <-- заполни в ENV
const TG_CHAT_ID = process.env.TG_CHAT_ID || ""; // <-- заполни в ENV

// REST троттлинг
const MIN_GAP_MS = numEnv("MIN_GAP_MS", 1500);
const MAX_LIFETIME_MS = numEnv("MAX_LIFETIME_MS", 120_000);
const MAX_QUEUE = numEnv("MAX_QUEUE", 1000);
const MAX_RETRIES = numEnv("MAX_RETRIES", 2);

// Порог и тайминги
const VIEWERS_THRESHOLD = numEnv("VIEWERS_THRESHOLD", 30);
const INDICATOR_WAIT_TOTAL_MS = numEnv("INDICATOR_WAIT_TOTAL_MS", 25_000);
const SAMPLE_COUNT = numEnv("SAMPLE_COUNT", 3);
const SAMPLE_STEP_MS = numEnv("SAMPLE_STEP_MS", 3000);
const VIEWERS_TASK_TIMEOUT = numEnv("VIEWERS_TASK_TIMEOUT", 60_000);

// Пулинг фазами (ускорение раннего детекта)
const POLL_PHASES = [
  { untilMs: 3000, everyMs: 250 },
  { untilMs: 10_000, everyMs: 600 },
  { untilMs: 20_000, everyMs: 1000 },
  { untilMs: 25_000, everyMs: 1500 },
];

// Браузер
const VIEWERS_CONCURRENCY = numEnv("VIEWERS_CONCURRENCY", 1);
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// Диагностика
const RES_LOG_EVERY_MS = numEnv("RES_LOG_EVERY_MS", 15_000);

// Дедуп
const DEDUP_TTL_MS = numEnv("DEDUP_TTL_MS", 10 * 60_000);

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

function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function log(...a) {
  // Один безопасный вызов, без вложенных бэктиков внутри строк
  const ts = new Date().toISOString();
  console.log(ts, ...a);
}

/* ================== REST-троттлер ================== */
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await sleep(nextAvailableAt - now);
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
          "user-agent": "pumplive-watcher/8.1.0",
        },
      });

      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        await sleep(waitMs);
        continue;
      }

      if (!r.ok) {
        metrics.httpOther++;
        throw new Error("HTTP " + r.status);
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

/* ================== HELPERS ================== */
function formatNumber(n) {
  try {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return String(n);
  }
}

function extractOfficialSocials(coin) {
  const socials = [];
  if (coin?.website) socials.push("🌐 <b>Website:</b> " + coin.website);
  if (coin?.twitter) socials.push("🐦 <b>Twitter:</b> " + coin.twitter);
  if (coin?.telegram) socials.push("💬 <b>Telegram:</b> " + coin.telegram);
  if (coin?.discord) socials.push("🎮 <b>Discord:</b> " + coin.discord);
  return socials;
}

async function sendTG({ text, photo }) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = photo
      ? "https://api.telegram.org/bot" + TG_TOKEN + "/sendPhoto"
      : "https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage";
    const payload = photo
      ? { chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: "HTML" }
      : { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" };

    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log("telegram send error:", e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

const recentlyHandled = new Map(); // mint -> ts
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
    protocolTimeout: 20_000,
  });
  log("Chromium ready:", execPath);
  return browser;
}

async function createPage() {
  const br = await getBrowser();
  let page;
  try {
    page = await br.newPage();
    activePages++;
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });

    // лёгкий антидетект
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        const _plugins = [{ name: "Chrome PDF Viewer" }];
        Object.defineProperty(navigator, "plugins", { get: () => _plugins });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
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
    log("page open error:", e.message);
    try { await page?.close({ runBeforeUnload: false }); } catch {}
    activePages = Math.max(0, activePages - 1);
    throw e;
  }
}

async function safeClosePage(page, afterError = false) {
  try { await page?.close({ runBeforeUnload: false }); } catch {}
  activePages = Math.max(0, activePages - 1);
  log(afterError ? "page:closed after error | active_pages=" + activePages : "page:closed | active_pages=" + activePages);
}

async function logResources() {
  try {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);
    const load1 = (os.loadavg?.()[0] || 0).toFixed(2);
    const extra = browser ? " rss_chrome=" + (lastChromeRssMB ? lastChromeRssMB.toFixed(1) + "MB" : "n/a") : "";
    console.log("[res] cpu_node=" + (process.cpuUsage().user / 1e6).toFixed(1) + "% rss_node=" + rssMB + "MB heap_node=" + heapMB + "MB load1=" + load1 + " active_pages=" + activePages + extra);
  } catch {}
}
async function updateChromeRSS() {
  // best-effort (нет простого способа считать RSS дочерних процессов без прав)
}

/* ================== INDICATOR FINDING ================== */
const INDICATOR_SELECTORS = ["#live-indicator", ".live-indicator", '[data-testid="live-indicator"]'];
const OVERLAY_HINTS = ["#nprogress", ".nprogress-busy"];

function parseViewersFromText(s) {
  const lower = String(s || "").toLowerCase();

  // 1. 1.2k / 1,2k
  let m = lower.match(/(\d+(?:[.,]\d+)?)\s*k\b/);
  if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 1000);

  // 2. 3.4m
  m = lower.match(/(\d+(?:[.,]\d+)?)\s*m\b/);
  if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 1_000_000);

  // 3. 1,234 viewers / 987 viewer
  m = lower.match(/(\d{1,3}(?:[.,]\d{3})+|\d{1,4})\s*(viewer|viewers)\b/);
  if (m) {
    const raw = m[1].replace(/\./g, "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // 4. просто число 1–4 знака (как fallback)
  m = lower.match(/\b\d{1,4}\b/);
  if (m) return Number(m[0]);

  return null;
}

function rectVisible(rect) {
  if (!rect) return false;
  return rect.width > 0 && rect.height > 0;
}

async function waitHydrationGate(page, deadlineMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const gate = await page.evaluate((OVERLAY_HINTS) => {
      const body = document.body;
      const pointerNone = !!body && body.style && body.style.pointerEvents === "none";
      const nprogress = OVERLAY_HINTS.some((sel) => !!document.querySelector(sel));
      const ready = document.readyState;
      const next = !!document.querySelector("#__next");
      const root = !!document.querySelector("#root");
      return { pointerNone, nprogress, ready, next, root };
    }, OVERLAY_HINTS);

    if (!gate.pointerNone && !gate.nprogress && (gate.ready === "complete" || gate.ready === "interactive")) {
      return { ok: true, gate };
    }
    await sleep(150);
  }
  return { ok: false, gate: null };
}

async function evaluateInAllFrames(page, fn, ...args) {
  const frames = page.frames();
  const results = [];
  for (const fr of frames) {
    try {
      const value = await fr.evaluate(fn, ...args);
      results.push({ ok: true, frameUrl: fr.url(), value });
    } catch (e) {
      results.push({ ok: false, frameUrl: fr.url(), error: String(e) });
    }
  }
  return results;
}

async function findIndicatorOnce(page) {
  // В каждом фрейме: сначала селекторы (+поиск в shadow), иначе — текстовый fallback
  return await evaluateInAllFrames(
    page,
    (INDICATOR_SELECTORS) => {
      function deepQuery(root, selectors) {
        const stack = [root];
        while (stack.length) {
          const el = stack.pop();
          if (!el) continue;
          for (let i = 0; i < selectors.length; i++) {
            const sel = selectors[i];
            if (!el.querySelector) continue;
            const found = el.querySelector(sel);
            if (found) {
              const rect = found.getBoundingClientRect ? found.getBoundingClientRect() : null;
              const text = (found.parentElement && found.parentElement.innerText) || (found.textContent || "");
              return { found: true, via: "selector", text, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
            }
          }
          if (el.shadowRoot) stack.push(el.shadowRoot);
          if (el.children && el.children.length) {
            for (let j = 0; j < el.children.length; j++) stack.push(el.children[j]);
          }
        }
        return { found: false, via: "selector" };
      }

      const doc = document;
      const bySel = deepQuery(doc, INDICATOR_SELECTORS);
      if (bySel && bySel.found) return bySel;

      const bodyTxt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 20000) : "";
      return { found: bodyTxt.length > 0, via: "text", text: bodyTxt, rect: null };
    },
    INDICATOR_SELECTORS
  );
}

async function waitIndicatorOrExplain(page, totalWaitMs) {
  const t0 = Date.now();
  const gate = await waitHydrationGate(page, Math.min(3000, totalWaitMs));
  if (!gate.ok) {
    log("[gate] hydration timeout or overlay");
  } else {
    log("[gate] hydration ready:", "ready=" + gate.gate.ready, "next=" + gate.gate.next, "root=" + gate.gate.root);
  }

  let elapsed = 0;
  let lastDiag = null;

  for (let p = 0; p < POLL_PHASES.length; p++) {
    const phase = POLL_PHASES[p];
    const phaseEnd = Math.min(phase.untilMs, totalWaitMs);

    while (elapsed < phaseEnd) {
      const start = Date.now();
      const results = await findIndicatorOnce(page);

      // 1) сначала ищем селекторный хит
      let picked = null;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.ok || !r.value) continue;
        const v = r.value;
        if (v.found && v.via === "selector") {
          picked = { via: "selector", text: v.text || "", rect: v.rect, frameUrl: r.frameUrl };
          break;
        }
      }

      // 2) если нет — текстовый
      if (!picked) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r.ok || !r.value) continue;
          const v = r.value;
          if (v.via === "text" && v.text) {
            const hasLive = /\bLIVE\b/i.test(v.text);
            const parsed = parseViewersFromText(v.text);
            if (hasLive && parsed !== null) {
              picked = { via: "text", text: v.text.slice(0, 2000), rect: null, frameUrl: r.frameUrl, viewers: parsed };
              break;
            }
          }
        }
      }

      // валидация видимости для селектора
      if (picked) {
        if (picked.via === "selector" && picked.rect && !rectVisible(picked.rect)) {
          lastDiag = { reason: "found_but_invisible", rect: picked.rect, frameUrl: picked.frameUrl };
        } else {
          return { ok: true, via: picked.via, elapsedMs: Date.now() - t0 };
        }
      } else {
        // лёгкая диагностика итерации
        const diag = await page.evaluate((INDICATOR_SELECTORS) => {
          function q(sel) {
            try { return document.querySelectorAll(sel).length; } catch { return 0; }
          }
          const counts = INDICATOR_SELECTORS.map((s) => ({ sel: s, n: q(s) }));
          const iframes = (document.querySelectorAll && document.querySelectorAll("iframe").length) || 0;
          const ready = document.readyState;
          const txt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 2000) : "";
          const bodyPreview = (document.body && document.body.outerHTML) ? document.body.outerHTML.slice(0, 1000) : "";
          const liveTxt = /\bLIVE\b/i.test(txt);
          return { counts, iframes, ready, bodyPreview, liveTxt };
        }, INDICATOR_SELECTORS);
        lastDiag = { reason: "polling", diag };
      }

      const dt = Date.now() - start;
      const sleepMs = Math.max(phase.everyMs - dt, 50);
      await sleep(sleepMs);
      elapsed = Date.now() - t0;
      if (elapsed >= totalWaitMs) break;
    }
    if (elapsed >= totalWaitMs) break;
  }

  // финальная диагностика
  const d = await page.evaluate((INDICATOR_SELECTORS) => {
    function q(sel) {
      try { return document.querySelectorAll(sel).length; } catch { return 0; }
    }
    const counts = INDICATOR_SELECTORS.map((s) => ({ sel: s, n: q(s) }));
    const ready = document.readyState;
    const hasNext = !!document.querySelector("#__next");
    const hasRoot = !!document.querySelector("#root");
    const iframes = (document.querySelectorAll && document.querySelectorAll("iframe").length) || 0;
    const txt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 5000) : "";
    const liveTxt = /\bLIVE\b/i.test(txt);
    const digits = /\b\d{1,4}\b/.test(txt);
    let perf = null;
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        perf = {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          responseEnd: Math.round(nav.responseEnd - nav.startTime),
        };
      }
    } catch {}
    const bodyPreview = (document.body && document.body.outerHTML) ? document.body.outerHTML.slice(0, 1200) : "";
    return { ready, counts, hasNext, hasRoot, iframes, liveTxt, digits, perf, bodyPreview };
  }, INDICATOR_SELECTORS);

  const ua = await page.browser().userAgent();
  const vp = page.viewport();
  log("[diag] indicator:miss",
      "ready=" + d.ready,
      "next=" + d.hasNext,
      "root=" + d.hasRoot,
      "iframes=" + d.iframes,
      "counts=" + d.counts.map(c => c.sel + ":" + c.n).join("|"),
      "liveTxt=" + d.liveTxt,
      "digits=" + d.digits,
      "perf=" + (d.perf ? JSON.stringify(d.perf) : "n/a"),
      "ua=" + ua,
      "viewport=" + (vp ? (vp.width + "x" + vp.height) : "n/a")
  );
  const preview = (d.bodyPreview || "").replace(/\s+/g, " ").slice(0, 1000);
  log("[diag] bodyPreview:", preview);
  if (lastDiag) {
    let ld = "";
    try { ld = JSON.stringify(lastDiag).slice(0, 1000); } catch { ld = String(lastDiag); }
    log("[diag] last:", ld);
  }
  return { ok: false, reason: "timeout_or_missing", details: d };
}

async function getViewersOnce(page) {
  const results = await evaluateInAllFrames(
    page,
    (INDICATOR_SELECTORS) => {
      function nearText(el) {
        if (!el) return "";
        const p = el.parentElement;
        if (p && p.innerText) return p.innerText;
        return el.textContent || "";
      }
      for (let i = 0; i < INDICATOR_SELECTORS.length; i++) {
        const sel = INDICATOR_SELECTORS[i];
        let node = null;
        try { node = document.querySelector(sel); } catch { node = null; }
        if (node) {
          return { via: "selector", text: nearText(node) };
        }
      }
      const bodyTxt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 20000) : "";
      return { via: "text", text: bodyTxt };
    },
    INDICATOR_SELECTORS
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok || !r.value) continue;
    const txt = r.value.text || "";
    const parsed = parseViewersFromText(txt);
    if (parsed !== null) return { ok: true, viewers: parsed, via: r.value.via };
  }
  return { ok: false, viewers: null, reason: "not_a_number" };
}

/* ================== VIEWERS TASK ================== */
async function notifyTelegram(mint, coin, fallbackName, fallbackSymbol, viewers) {
  const socials = extractOfficialSocials(coin);
  const title = (coin.name || fallbackName) + " (" + (coin.symbol || fallbackSymbol) + ")";
  const mcapStr = typeof coin.usd_market_cap === "number" ? "$" + formatNumber(coin.usd_market_cap) : "n/a";

  const lines = [
    "🎥 <b>LIVE START</b> | " + title,
    "Mint: <code>" + mint + "</code>",
    "🔗 <b>Axiom:</b> https://axiom.trade/t/" + mint,
    "💰 Market Cap: " + mcapStr,
    "👁 Viewers: " + viewers
  ];
  if (socials.length > 0) lines.push(socials.join("\n"));

  const msg = lines.join("\n");
  const photoUrl = coin && coin.image_uri ? coin.image_uri : null;

  log("tg:send start");
  await sendTG({ text: msg, photo: photoUrl });
  log("tg:sent");
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol, detectAt }) {
  metrics.viewerTasksStarted++;
  markHandled(mint);
  const t0 = detectAt || Date.now();

  // быстрый recheck перед браузером
  const pre = await safeGetJson(API + "/coins/" + mint);
  if (!pre || pre.is_currently_live === false) {
    log("skip before_browser mint=" + mint + " reason=already_not_live dt=" + (Date.now() - t0) + "ms");
    return;
  }

  const diag = { consoleErrors: [], pageErrors: [], reqFailed: [] };
  let page;

  try {
    page = await createPage();
    page.on("console", (msg) => { if (msg.type() === "error") diag.consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => diag.pageErrors.push(String(err)));
    page.on("requestfailed", (req) => {
      diag.reqFailed.push({
        url: req.url(),
        failure: (req.failure() && req.failure().errorText) || "",
        method: req.method(),
        type: req.resourceType(),
      });
    });

    const navStart = Date.now();
    log("goto:start url=https://pump.fun/coin/" + mint);
    await page.goto("https://pump.fun/coin/" + mint, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const dtNav = Date.now() - navStart;
    await sleep(800);
    log("goto:done dt_nav=" + dtNav + "ms wait_dom_extra=800ms");

    const indStart = Date.now();
    const ind = await waitIndicatorOrExplain(page, INDICATOR_WAIT_TOTAL_MS);
    const dtInd = Date.now() - indStart;

    if (!ind.ok) {
      log("live-indicator:found=false dt=" + dtInd + "ms reason=timeout_or_missing");
      const again = await safeGetJson(API + "/coins/" + mint);
      if (!again || again.is_currently_live === false) {
        await safeClosePage(page);
        log("skip no_indicator_but_now_not_live timeline t_detect_to_navStart=" + (navStart - t0) + "ms nav_to_done=" + dtNav + "ms wait_indicator=" + dtInd + "ms total=" + (Date.now() - t0) + "ms");
        return;
      }

      // быстрый reload один раз
      log("reload:quick_try");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(600);
      const ind2 = await waitIndicatorOrExplain(page, Math.max(6000, Math.floor(INDICATOR_WAIT_TOTAL_MS / 3)));
      if (!ind2.ok) {
        metrics.viewerSelectorMiss++;
        await safeClosePage(page);
        log("skip no_indicator_after_reload total=" + (Date.now() - t0) + "ms");
        return;
      } else {
        log("live-indicator:found=true after_reload dt_total=" + (Date.now() - indStart) + "ms");
      }
    } else {
      log("live-indicator:found=true dt=" + dtInd + "ms");
    }

    // Сэмплы
    let maxV = -1;
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const s = await getViewersOnce(page);
      if (!s.ok) {
        log("sample " + i + "/" + SAMPLE_COUNT + " ok=false reason=" + s.reason);
      } else {
        maxV = Math.max(maxV, s.viewers);
        log("sample " + i + "/" + SAMPLE_COUNT + " ok=true via=" + s.via + " viewers=" + s.viewers);
        if (s.viewers >= VIEWERS_THRESHOLD) {
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, s.viewers);
          await safeClosePage(page);
          log("threshold:hit viewers=" + s.viewers + " total=" + (Date.now() - t0) + "ms");
          metrics.viewerTasksDone++;
          return;
        }
      }
      if (i < SAMPLE_COUNT) await sleep(SAMPLE_STEP_MS);
    }

    await safeClosePage(page);
    log("threshold:miss max=" + (maxV < 0 ? "n/a" : maxV) + " total=" + (Date.now() - t0) + "ms");
    metrics.viewerTasksDone++;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log("viewers task error:", e.message);
    await safeClosePage(page, true);
  }
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= VIEWERS_CONCURRENCY || viewersQueue.length === 0) {
      await sleep(150);
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
      log("viewers task dropped:", e.message);
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
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].nextTryAt <= now) { idx = i; break; }
    }
    if (idx === -1) { await sleep(200); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;

    if (Date.now() > expiresAt) {
      inQueue.delete(mint);
      continue;
    }

    const coin = await safeGetJson(API + "/coins/" + mint);
    if (!coin) {
      requeue(item);
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
      log("LIVE START | " + (coin.name || name) + " (" + (coin.symbol || symbol) + ")");
      log("mint:", mint);
      if (typeof coin.usd_market_cap === "number") log("mcap_usd:", coin.usd_market_cap.toFixed(2));
      log("socials:", socials.join(" "));
    } else {
      item.nextTryAt = Date.now() + 4000;
      queue.push(item);
    }
  }
}

/* ================== WEBSOCKET ================== */
function connect() {
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log("WS connected, subscribing...");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });
  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const mint = msg && (msg.mint || msg.tokenMint || msg.ca);
    if (!mint) return;
    const nm = msg.name || msg.tokenName || "";
    const sm = msg.symbol || msg.ticker || "";
    enqueue(mint, nm, sm);
  });
  ws.on("close", () => {
    metrics.reconnects++;
    log("WS closed → reconnecting in 5s…");
    setTimeout(connect, 5000);
  });
  ws.on("error", (e) => log("WS error:", e.message));
}

/* ================== HEARTBEAT & RES ================== */
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;

  console.log(
    "[stats]" +
    " watchers=" + queueSize() +
    " ws_last=" + secSinceWs + "s" +
    " live_last=" + minSinceLive + "m" +
    " req=" + metrics.requests +
    " ok=" + metrics.ok +
    " retries=" + metrics.retries +
    " 429=" + metrics.http429 +
    " other=" + metrics.httpOther +
    " empty=" + metrics.emptyBody +
    " null=" + metrics.skippedNull +
    " reconnects=" + metrics.reconnects +
    " vQ=" + viewersQueue.length +
    " vRun=" + viewersActive +
    " vStart=" + metrics.viewerTasksStarted +
    " vDone=" + metrics.viewerTasksDone +
    " vDrop=" + metrics.viewerTasksDropped +
    " vOpenErr=" + metrics.viewerOpenErrors +
    " vSelMiss=" + metrics.viewerSelectorMiss +
    " active_pages=" + activePages
  );

  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log("[guard] no WS messages for " + secSinceWs + "s → force reconnect");
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

setInterval(async () => {
  await updateChromeRSS();
  await logResources();
}, RES_LOG_EVERY_MS);

/* ================== STARTUP ================== */
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on("SIGTERM", async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
process.on("SIGINT", async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
