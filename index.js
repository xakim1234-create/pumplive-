// index.js — v6.0.1 (API queue + Viewers queue) + Telegram photo + Axiom /t/{mint}
import WebSocket from "ws";
import fetch from "node-fetch";
import puppeteer from "puppeteer";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram (замени при необходимости)
const TG_TOKEN = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID = "-4857972467";

// === Тюнинг API-очереди ===
const MIN_GAP_MS = 1500;            // глобальный лимитер RPS для REST
const MAX_LIFETIME_MS = 120_000;    // ждём LIVE до 2 минут
const MAX_QUEUE = 1000;             // максимум mint в API-очереди
const MAX_RETRIES = 2;

// === Тюнинг очереди зрителей ===
const VIEWERS_THRESHOLD = 30;       // порог зрителей
const VIEWERS_WINDOW_MS = 30_000;   // окно наблюдения 30с
const VIEWERS_STEP_MS = 5_000;      // шаг 5с
const VIEWERS_ITER = Math.floor(VIEWERS_WINDOW_MS / VIEWERS_STEP_MS); // 6 замеров
const VIEWERS_QUEUE_MAX = 200;      // максимум задач в очереди зрителей
const VIEWERS_CONCURRENCY = 1;      // 1 поток (начни с 1, потом можно 2)
const VIEWERS_DELAY_BETWEEN_TASKS = 3000; // пауза между задачами
const VIEWERS_PAGE_TIMEOUT = 10_000; // таймаут загрузки страницы
const VIEWERS_TASK_TIMEOUT = 35_000; // общий таймаут задачи

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

// ——— лог и глобальный троттлер
function log(...a) { console.log(new Date().toISOString(), ...a); }
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await new Promise(r => setTimeout(r, nextAvailableAt - now));
  }
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
          "user-agent": "pumplive-watcher/6.0.1"
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
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          photo,
          caption: text,
          parse_mode: "HTML"
        })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text,
          parse_mode: "HTML"
        })
      });
    }
  } catch (e) {
    log("⚠️  telegram send error:", e.message);
  }
}

// =====================
//       API ОЧЕРЕДЬ
// =====================
const inQueue = new Set(); // дедупликация по mint
const queue = [];          // [{ mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }]

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
    nextTryAt: now
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

async function apiWorkerLoop() {
  while (true) {
    let idx = -1;
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].nextTryAt <= now) { idx = i; break; }
    }

    if (idx === -1) {
      await new Promise(r => setTimeout(r, 250));
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
      requeue(item);
      continue;
    }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { // твоя логика: без оф. соцсетей — пропуск
        inQueue.delete(mint);
        continue;
      }

      // готово к viewers-проверке
      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();

      // лог как раньше
      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number")
        log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);

      continue;
    }

    // ещё не LIVE — вернём в очередь до истечения времени
    requeue(item);
  }
}

// =====================
//   ОЧЕРЕДЬ ЗРИТЕЛЕЙ
// =====================
const viewersQueue = [];
const viewersInQueue = new Set();
let browser = null;
let viewersActive = 0;

function enqueueViewers({ mint, coin, fallbackName = "", fallbackSymbol = "" }) {
  if (viewersInQueue.has(mint)) return;
  if (viewersQueue.length >= VIEWERS_QUEUE_MAX) {
    metrics.viewerTasksDropped++;
    return;
  }
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: Date.now() });
  viewersInQueue.add(mint);
}

async function getBrowser() {
  if (browser) return browser;

  // ЯВНО берём путь к Chrome, установленному postinstall’ом
  const execPath = await puppeteer.executablePath();

  browser = await puppeteer.launch({
    executablePath: execPath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  });

  log("✅ Puppeteer ready:", execPath);
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
    await page.goto(`https://pump.fun/coin/${mint}`, {
      waitUntil: "domcontentloaded",
      timeout: VIEWERS_PAGE_TIMEOUT
    });

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
      if (i < VIEWERS_ITER - 1) {
        await new Promise(r => setTimeout(r, VIEWERS_STEP_MS));
      }
    }

    if (!sent && maxV >= VIEWERS_THRESHOLD) {
      await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, maxV);
      sent = true;
    }

    // если не отправили — просто дропаем
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
  const mcapStr = typeof coin.usd_market_cap === "number"
    ? `$${formatNumber(coin.usd_market_cap)}`
    : "n/a";
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

    // Ограничиваем общее время задачи (safety)
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("viewer task timeout")), VIEWERS_TASK_TIMEOUT));
    try {
      await Promise.race([task, timeout]);
    } catch (e) {
      metrics.viewerTasksDropped++;
      log("⚠️ viewers task dropped:", e.message);
    } finally {
      viewersActive--;
      await new Promise(r => setTimeout(r, VIEWERS_DELAY_BETWEEN_TASKS));
    }
  }
}

// =====================
//      WebSocket
// =====================
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
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

// =====================
//      Heartbeat
// =====================
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

// =====================
//       Start!
// =====================
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

// ——— аккуратное завершение
process.on("SIGTERM", async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
process.on("SIGINT", async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
