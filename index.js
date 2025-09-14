// index.js — v3.4: LIVE-only + health/metrics в логах
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

const LIVE_INTERVAL = 25000;       // базовый интервал проверки
const LIVE_TIMEOUT_MIN = 30;       // сколько ждём лайв
const MIN_GAP_MS = 1000;           // глобальный лимит: ~1 rps
const MAX_RETRIES = 4;
const MAX_WATCHERS = 200;

const tracking = new Map();        // mint -> timer
const seen = new Set();            // уже видели токен
let ws;                            // текущее ws
let lastWsMsgAt = 0;               // когда в последний раз приходило WS-сообщение
let lastLiveAt = 0;                // когда в последний раз поймали LIVE
let lastConnectAt = 0;

const metrics = {
  requests: 0,
  ok: 0,
  retries: 0,
  skippedNull: 0,         // пропущенные тики из-за null/ошибок после ретраев
  http429: 0,
  httpOther: 0,
  jsonErrors: 0,
  emptyBody: 0,
  reconnects: 0,
};

function log(...a){ console.log(new Date().toISOString(), ...a); }

// ——— глобальный лимитер
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise(r => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// ——— безопасный fetch JSON с ретраями и учётом 429
async function safeGetJson(url) {
  metrics.requests++;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const cacheBust = url.includes("?") ? `&t=${Date.now()}` : `?t=${Date.now()}`;
      const r = await fetch(url + cacheBust, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/3.4"
        }
      });

      if (r.status === 429) {
        metrics.http429++;
        const ra = r.headers.get("retry-after");
        const waitMs = ra ? Number(ra) * 1000 : 4000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;        // раздвигаем очередь
        if (attempt < MAX_RETRIES) {
          metrics.retries++;
          await new Promise(res => setTimeout(res, waitMs));
          continue;
        }
        throw new Error("HTTP 429");
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

      const data = JSON.parse(text);
      metrics.ok++;
      return data;

    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        metrics.retries++;
        const base = 800 * (attempt + 1);
        const jitter = Math.floor(Math.random() * 400);
        await new Promise(res => setTimeout(res, base + jitter));
        continue;
      }
      metrics.skippedNull++;
      return null;  // сдаёмся — попробуем на следующем тике
    }
  }
}

// ——— запрос монеты
async function getCoin(mint) {
  return safeGetJson(`${API}/coins/${mint}`);
}

// ——— запуск вотчера лайва для токена
function startLiveWatch(mint, name = "", symbol = "") {
  if (tracking.has(mint)) return;
  if (tracking.size >= MAX_WATCHERS) return;

  const startedAt = Date.now();
  const jitter = Math.floor(Math.random() * 5000);

  const timer = setInterval(async () => {
    try {
      if ((Date.now() - startedAt) / 60000 > LIVE_TIMEOUT_MIN) {
        clearInterval(timer);
        tracking.delete(mint);
        return;
      }

      const data = await getCoin(mint);
      if (!data) return; // тихо пропускаем тик

      if (data.is_currently_live) {
        clearInterval(timer);
        tracking.delete(mint);

        const title = data.name || name || "";
        const sym = data.symbol || symbol || "";
        lastLiveAt = Date.now();

        log(`🎥 LIVE START | ${title} (${sym})`);
        log(`   mint: ${mint}`);
        if (typeof data.usd_market_cap === "number")
          log(`   mcap_usd: ${data.usd_market_cap.toFixed(2)}`);
        if (data.thumbnail) log(`   thumbnail: ${data.thumbnail}`);
      }
    } catch (e) {
      // редкие непредвиденные ошибки
      metrics.httpOther++;
      log("⚠️  live-check error:", e.message);
    }
  }, LIVE_INTERVAL + jitter);

  tracking.set(mint, timer);
}

// ——— WS подключение с авто-reconnect и «сторожем тишины»
function connect() {
  ws = new WebSocket(WS_URL);
  lastConnectAt = Date.now();

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
    if (!seen.has(mint)) {
      seen.add(mint);
      startLiveWatch(mint, msg?.name || msg?.tokenName, msg?.symbol || msg?.ticker);
    }
  });

  ws.on("close", (c, r) => {
    metrics.reconnects++;
    log(`🔌 WS closed ${c} ${(r || "").toString()}. Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    // просто отметим, подробности будут в close
    log("❌ WS error:", e.message);
  });
}

// ——— минутный heartbeat + guard
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;

  console.log(
    `[stats] watchers=${tracking.size}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}`
  );

  // Если 5 минут не было WS-сообщений — переподключимся
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// ——— старт
log("Worker starting…");
connect();
