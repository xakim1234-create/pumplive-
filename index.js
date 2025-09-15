// index.js — v6.1.1 (API queue + Viewers queue ≥30 in 30s) + Telegram + Chromium serverless
import WebSocket from "ws";
import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram (замени позже на свои)
const TG_TOKEN = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID = "-4857972467";

// === API очередь ===
const MIN_GAP_MS = 1500;          // глобальный RPS ~0.66
const MAX_LIFETIME_MS = 120_000;  // ждём LIVE до 2 минут
const MAX_QUEUE = 1000;
const MAX_RETRIES = 2;

// === Очередь зрителей ===
const VIEWERS_THRESHOLD = 30;
const VIEWERS_WINDOW_MS = 30_000;           // 30 секунд
const VIEWERS_STEP_MS = 5_000;              // шаг 5 сек
const VIEWERS_ITER = Math.floor(VIEWERS_WINDOW_MS / VIEWERS_STEP_MS); // 6 замеров
const VIEWERS_QUEUE_MAX = 200;
const VIEWERS_CONCURRENCY = 1;              // можно 2, если захочешь
const VIEWERS_DELAY_BETWEEN_TASKS = 3000;
const VIEWERS_PAGE_TIMEOUT = 20_000;        // ↑ против таймаутов
const VIEWERS_TASK_TIMEOUT = 45_000;        // ↑ общий лимит задачи
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

// ——— метрики
const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
  viewerTasksStarted: 0, viewerTasksDone: 0, viewerTasksDropped: 0,
  viewerOpenErrors: 0, viewerSelectorMiss: 0,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ——— глобальный троттлер REST
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise(r => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// ——— безопасный GET JSON
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/6.1.1"
        }
      });

      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        await new Promise(res => setTimeout(res, waitMs));
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
        await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
        continue;
      }
      metrics.skippedNull++;
      return null;
    }
  }
}

// ——— форматтеры
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
    log("⚠️  telegram send error:", e.message);
  }
}

// ===================== API ОЧЕРЕДЬ =====================
const inQueue = new Set();
const queue = []; // [{ mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }]

function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({ mint, name, symbol, enqueuedAt: now, expiresAt: now + MAX_LIFETIME_MS, nextTryAt: now });
  inQueue.add(mint);
}
function requeue(item) { item.nextTryAt = Date.now() + 4000; queue.push(item); }
function queueSize() { return inQueue.size; }

async function apiWorkerLoop() {
  while (true) {
    let idx = -1; const now = Date.now();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= now) { idx = i; break; }
    if (idx === -1) { await new Promise(r => setTimeout(r, 250)); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;
    if (Date.now() > expiresAt) { inQueue.delete(mint); continue; }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) { requeue(item); continue; }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { inQueue.delete(mint); continue; } // твой фильтр

      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);
      continue;
    }

    requeue(item);
  }
}

// ===================== ОЧЕРЕДЬ ЗРИТЕЛЕЙ =====================
const viewersQueue = [];
const viewersInQueue = new Set();
let browser = null;
let viewersActive = 0;

function enqueueViewers({ mint, coin, fallbackName = "", fallbackSymbol = "" }) {
  if (viewersInQueue.has(mint)) return;
  if (viewersQueue.length >= VIEWERS_QUEUE_MAX) { metrics.viewerTasksDropped++; return; }
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: Date.now() });
  viewersInQueue.add(mint);
}

async function getBrowser() {
  if (browser) return browser;
  const execPath = await chromium.executablePath();
  browser = await puppeteer.launch({
    executablePath: execPath,
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: chromium.headless
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

async function checkViewersOnce(page) {
  const liveHandle = await page.$("#live-indicator");
  if (!liveHandle) return { ok: false, viewers: null, reason: "no_live_indicator" };
  const viewersHandle = await page.evaluateHandle(
    el => el && el.parentElement && el.parentElement.querySelector("span"),
    liveHandle
  );
  if (!viewersHandle) return { ok: false, viewers: null, reason: "no_viewers_span" };
  const txt = await viewersHandle.evaluate(el => (el.textContent || "").trim());
  const num = Number((txt.match(/\d+/) || [null])[0]);
  if (!Number.isFinite(num)) return { ok: false, viewers: null, reason: "not_a_number" };
  return { ok: true, viewers: num };
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol }) {
  metrics.viewerTasksStarted++;
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();

    // Ускоряем/стабилизируем загрузку страницы
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on("request", req => {
      const t = req.resourceType();
      if (t === "image" || t === "font" || t === "media" || t === "stylesheet") return req.abort();
      req.continue();
    });

    // Навигация с одним авторетрайем
    let navigated = false;
    try {
      await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: VIEWERS_PAGE_TIMEOUT });
      navigated = true;
    } catch (_) {
      // одна повторная попытка
      await new Promise(r => setTimeout(r, 1000));
      await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: VIEWERS_PAGE_TIMEOUT });
      navigated = true;
    }

    // Ждём целевой селектор (если он вообще есть)
    try {
      await page.waitForSelector("#live-indicator", { timeout: 15000 });
    } catch { /* ок, будем пробовать читать напрямую */ }

    let maxV = -1;
    let sent = false;

    for (let i = 0; i < VIEWERS_ITER; i++) {
      const res = await checkViewersOnce(page);
      if (!res.ok) {
        if (res.reason === "no_live_indicator" || res.reason === "no_viewers_span") {
          metrics.viewerSelectorMiss++;
        }
      } else {
        if (res.viewers > maxV) maxV = res.viewers;
        if (res.viewers >= VIEWERS_THRESHOLD) {
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, res.viewers);
          sent = true;
          break;
        }
      }
      if (i < VIEWERS_ITER - 1) await new Promise(r => setTimeout(r, VIEWERS_STEP_MS));
    }

    if (!sent && maxV >= VIEWERS_THRESHOLD) {
      await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, maxV);
      sent = true;
    }

    if (!sent) {
      log(`ℹ️ Skipped Telegram (viewers < ${VIEWERS_THRESHOLD}) | mint=${mint} max=${maxV < 0 ? "n/a" : maxV}`);
    }

    metrics.viewerTasksDone++;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log("⚠️ viewers task error:", e.message);
  } finally {
    try { await page?.close({ runBeforeUnload: false }); } catch {}
  }
}

async function notifyTelegram(mint, coin, fallbackName, fallbackSymbol, viewers) {
  const socials = extractOfficialSocials(coin);
  const title = `${coin.name || fallbackName} (${coin.symbol || fallbackSymbol})`;
  const mcapStr = typeof coin.usd_market_cap === "number" ? `$${formatNumber(coin.usd_market_cap)}` : "n/a";
  const msg = [
    `🎥 <b>LIVE START</b> | ${title}`,
    ``,
    `Mint: <code>${mint}</code>`,
    `🔗 <b>Axiom:</b> https://axiom.trade/t/${mint}`,
    `💰 Market Cap: ${mcapStr}`,
    `👁 Viewers: ${viewers}`,
    ``,
    socials.join("\n")
  ].join("\n");

  const photoUrl = coin?.image_uri || null;
  log("📤 sending to Telegram…");
  sendTG({ text: msg, photo: photoUrl })
    .then(() => log("✅ sent to Telegram"))
    .catch(e => log("⚠️ TG error:", e.message));
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= VIEWERS_CONCURRENCY || viewersQueue.length === 0) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    const job = viewersQueue.shift();
    viewersInQueue.delete(job.mint);

    viewersActive++;
    const task = viewersTask(job);

    // общий лимит на задачу
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("viewer task timeout")), VIEWERS_TASK_TIMEOUT));
    try { await Promise.race([task, timeout]); }
    catch (e) { metrics.viewerTasksDropped++; log("⚠️ viewers task dropped:", e.message); }
    finally { viewersActive--; await new Promise(r => setTimeout(r, VIEWERS_DELAY_BETWEEN_TASKS)); }
  }
}

// ===================== WebSocket =====================
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
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
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
    `vQ=${viewersQueue.length}/${VIEWERS_QUEUE_MAX} vRun=${viewersActive} ` +
    `vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} vDrop=${metrics.viewerTasksDropped}`
  );
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// ===================== Start =====================
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(0); });
process.on("SIGINT",  async () => { try { await browser?.close(); } catch {} process.exit(0); });
