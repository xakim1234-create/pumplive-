// index.js — v7.0.0 (single page reuse, no global task timeout, 30s sampling window)
import WebSocket from "ws";
import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram (замени позже на свои либо вынеси в ENV)
const TG_TOKEN = process.env.TG_TOKEN || "REPLACE_ME";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "REPLACE_ME";

// === API очередь ===
const MIN_GAP_MS = 1500;         // глобальный RPS ~0.66
const MAX_LIFETIME_MS = 120_000; // ждём LIVE до 2 минут
const MAX_QUEUE = 2000;          // просто страховочный, но фактически лимит снят
const MAX_RETRIES = 2;

// === Логика зрителей (упрощённая) ===
const VIEWERS_THRESHOLD = 30;
const SAMPLE_STEP_MS = 5_000;         // каждые 5 сек
const SAMPLE_ITER = 6;                 // 30 сек окно
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ——— состояние
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
const nowMs = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// === мини-таймер для этапов
function makeTimer() {
  const t0 = nowMs();
  return () => nowMs() - t0;
}

// ——— глобальный троттлер REST
let nextAvailableAt = 0;
async function throttle() {
  const now = nowMs();
  if (now < nextAvailableAt) await sleep(nextAvailableAt - now);
  nextAvailableAt = nowMs() + MIN_GAP_MS;
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
          "user-agent": "pumplive-watcher/7.0.0"
        }
      });

      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = nowMs() + waitMs;
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
  if (!TG_TOKEN || !TG_CHAT_ID || TG_TOKEN === "REPLACE_ME") return;
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
  const now = nowMs();
  queue.push({ mint, name, symbol, enqueuedAt: now, expiresAt: now + MAX_LIFETIME_MS, nextTryAt: now });
  inQueue.add(mint);
}
function requeue(item) { item.nextTryAt = nowMs() + 4000; queue.push(item); }
function queueSize() { return inQueue.size; }

async function apiWorkerLoop() {
  while (true) {
    let idx = -1; const now = nowMs();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= now) { idx = i; break; }
    if (idx === -1) { await sleep(250); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;
    if (nowMs() > expiresAt) { inQueue.delete(mint); continue; }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) { requeue(item); continue; }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { inQueue.delete(mint); continue; } // фильтр: минимум 1 соцсеть

      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = nowMs();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);
      continue;
    }

    requeue(item);
  }
}

// ===================== ОЧЕРЕДЬ ЗРИТЕЛЕЙ (упростили) =====================
const viewersQueue = [];
const viewersInQueue = new Set();
let browser = null;
let page = null;
let viewersActive = 0;

function enqueueViewers({ mint, coin, fallbackName = "", fallbackSymbol = "" }) {
  if (viewersInQueue.has(mint)) return;
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: nowMs() });
  viewersInQueue.add(mint);
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
      "--single-process",            // помогает на ограниченных окружениях
      "--disable-gpu"
    ],
    headless: chromium.headless,
    protocolTimeout: 180_000 // ← увеличили CDP таймаут для операций типа Target.createTarget/Network.enable
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

async function getPage() {
  const t = makeTimer();
  const br = await getBrowser();
  let reused = false;
  try {
    if (page && !page.isClosed()) {
      // быстрая проверка, что CDP жив (можем дернуть title)
      try { await page.title(); reused = true; }
      catch { page = null; reused = false; }
    }
    if (!page || page.isClosed()) {
      page = await br.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 800 });
      page.setDefaultTimeout(60_000);              // таймауты Puppeteer (не общий, а для операций)
      page.setDefaultNavigationTimeout(60_000);
    }
    log(`🧊 chrome:warmup ok=true reused=${reused} dt=${t()}ms`);
    return page;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log(`❌ page:new error=${e.message} dt=${t()}ms`);
    // пробуем полный рестарт браузера
    try { await browser?.close(); } catch {}
    browser = null; page = null;
    throw e;
  }
}

async function checkViewersOnce(page) {
  // Не включаем request interception — избегаем лишнего Network.enable
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
  const jobTimer = makeTimer();
  log(`▶️ viewers:start mint=${mint} name="${coin?.name || fallbackName}" symbol="${coin?.symbol || fallbackSymbol}"`);

  let pg;
  try {
    // 1) Получаем/создаём вкладку (реюз)
    pg = await getPage();

    // 2) Навигация
    const tNav = makeTimer();
    const url = `https://pump.fun/coin/${mint}`;
    log(`🌐 goto:start url=${url}`);
    try {
      await pg.goto(url, { waitUntil: "domcontentloaded" }); // без request interception
      const extraWait = 1500;
      await sleep(extraWait);
      log(`🌐 goto:done dt_nav=${tNav()}ms wait_dom_extra=${extraWait}ms`);
    } catch (e) {
      log(`🌐 goto:error kind=${/timeout/i.test(e.message) ? "timeout" : "other"} dt=${tNav()}ms msg="${e.message}"`);
      // пробуем мягкий рефреш один раз
      await sleep(1000);
      const tNav2 = makeTimer();
      try {
        await pg.goto(url, { waitUntil: "domcontentloaded" });
        const extraWait = 1500;
        await sleep(extraWait);
        log(`🌐 goto:retry_success dt_nav=${tNav2()}ms wait_dom_extra=${extraWait}ms`);
      } catch (e2) {
        // если страница не открылась — считаем задачу неисполненной
        metrics.viewerTasksDropped++;
        log(`❌ goto:failed_twice dt1=${tNav()}ms dt2=${tNav2()}ms msg2="${e2.message}"`);
        return;
      }
    }

    // 3) Пробуем быстро дождаться индикатор (но это не обязаловка)
    const tSel = makeTimer();
    let selectorFound = true;
    try {
      await pg.waitForSelector("#live-indicator", { timeout: 10_000 });
      log(`🔎 live-indicator:found=true dt=${tSel()}ms`);
    } catch {
      selectorFound = false;
      metrics.viewerSelectorMiss++;
      log(`🔎 live-indicator:found=false dt=${tSel()}ms reason=timeout_or_missing`);
    }

    // 4) 30 секунд измерений (6×)
    let maxV = -1;
    for (let i = 0; i < SAMPLE_ITER; i++) {
      const tSample = makeTimer();
      let res;
      try { res = await checkViewersOnce(pg); }
      catch (e) {
        log(`📊 sample i=${i + 1}/${SAMPLE_ITER} error="${e.message}" dt=${tSample()}ms`);
        if (i < SAMPLE_ITER - 1) await sleep(SAMPLE_STEP_MS);
        continue;
      }

      if (!res.ok) {
        log(`📊 sample i=${i + 1}/${SAMPLE_ITER} ok=false reason=${res.reason} dt=${tSample()}ms`);
      } else {
        maxV = Math.max(maxV, res.viewers);
        log(`📊 sample i=${i + 1}/${SAMPLE_ITER} ok=true viewers=${res.viewers} dt=${tSample()}ms`);
        if (res.viewers >= VIEWERS_THRESHOLD) {
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, res.viewers, jobTimer());
          metrics.viewerTasksDone++;
          return;
        }
      }

      if (i < SAMPLE_ITER - 1) await sleep(SAMPLE_STEP_MS);
    }

    // 5) Порог не достигнут — логируем и выходим
    log(`⏭️ threshold:miss max=${maxV < 0 ? "n/a" : maxV} t_window=30s t_total=${jobTimer()}ms`);
    metrics.viewerTasksDone++;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log(`⚠️ viewers task error: ${e.message}`);
  }
}

async function notifyTelegram(mint, coin, fallbackName, fallbackSymbol, viewers, tTotalMs) {
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
  log(`✅ threshold:hit viewers=${viewers} t_total=${tTotalMs}ms`);
  log("📤 tg:send start");
  try {
    await sendTG({ text: msg, photo: photoUrl });
    log("✅ tg:sent");
  } catch (e) {
    log("⚠️ tg:error:", e.message);
  }
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= 1 || viewersQueue.length === 0) {
      await sleep(100);
      continue;
    }
    const job = viewersQueue.shift();
    viewersInQueue.delete(job.mint);

    viewersActive++;
    try { await viewersTask(job); }
    catch (e) {
      metrics.viewerTasksDropped++;
      log("⚠️ viewers task dropped:", e.message);
    } finally {
      viewersActive--;
      // короткая пауза между задачами, чтобы страница успела "отпустить" CPU
      await sleep(500);
    }
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
    lastWsMsgAt = nowMs();
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
  const now = nowMs();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
    `vQ=${viewersQueue.length} vRun=${viewersActive} ` +
    `vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} vDrop=${metrics.viewerTasksDropped} ` +
    `vOpenErr=${metrics.viewerOpenErrors} vSelMiss=${metrics.viewerSelectorMiss}`
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
