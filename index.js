// index.js — v3.2: только LIVE START, с анти-429 защитой
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// --- настройки ---
const LIVE_INTERVAL = 25000;       // базовый интервал проверки 25с
const LIVE_TIMEOUT_MIN = 30;       // ждать лайв не дольше 30 мин
const MIN_GAP_MS = 1000;           // глобально ~1 rps (можно 1200–1500 если всё ещё 429)
const MAX_RETRIES = 4;             // сколько раз пробовать при сетевых сбоях
const MAX_WATCHERS = 200;          // максимум одновременно отслеживаемых токенов

// --- глобальный лимитер ---
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await new Promise(r => setTimeout(r, nextAvailableAt - now));
  }
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// --- обёртка fetch ---
async function safeGetJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();

      const cacheBust = url.includes("?") ? `&t=${Date.now()}` : `?t=${Date.now()}`;
      const r = await fetch(url + cacheBust, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/3.2"
        }
      });

      if (r.status === 429) {
        const ra = r.headers.get("retry-after");
        const waitMs = ra ? Number(ra) * 1000 : 4000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        if (attempt < MAX_RETRIES) {
          await new Promise(res => setTimeout(res, waitMs));
          continue;
        }
        throw new Error("HTTP 429");
      }

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const text = await r.text();
      if (!text || text.trim() === "") throw new Error("Empty body");

      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        const base = 800 * (attempt + 1);
        const jitter = Math.floor(Math.random() * 400);
        await new Promise(res => setTimeout(res, base + jitter));
        continue;
      }
      return null; // сдаёмся, попробуем на следующем тике
    }
  }
  return null;
}

// --- проверка токена ---
async function getCoin(mint) {
  return safeGetJson(`${API}/coins/${mint}`);
}

// --- трекинг ---
const tracking = new Map(); // mint -> timer
const seen = new Set();     // уже видели токен

function log(...a) { console.log(new Date().toISOString(), ...a); }

// запуск вотчера для конкретного токена
function startLiveWatch(mint, name = "", symbol = "") {
  if (tracking.has(mint)) return;
  if (tracking.size >= MAX_WATCHERS) return;

  const startedAt = Date.now();
  const jitter = Math.floor(Math.random() * 5000); // до +5с к интервалу

  const timer = setInterval(async () => {
    try {
      if ((Date.now() - startedAt) / 60000 > LIVE_TIMEOUT_MIN) {
        clearInterval(timer);
        tracking.delete(mint);
        return;
      }

      const data = await getCoin(mint);
      if (!data) return;

      if (data.is_currently_live) {
        clearInterval(timer);
        tracking.delete(mint);

        const title = data.name || name || "";
        const sym = data.symbol || symbol || "";
        log(`🎥 LIVE START | ${title} (${sym})`);
        log(`   mint: ${mint}`);
        if (typeof data.usd_market_cap === "number") {
          log(`   mcap_usd: ${data.usd_market_cap.toFixed(2)}`);
        }
        if (data.thumbnail) log(`   thumbnail: ${data.thumbnail}`);
      }
    } catch (e) {
      log("⚠️  live-check error:", e.message);
    }
  }, LIVE_INTERVAL + jitter);

  tracking.set(mint, timer);
}

// --- WS подключение ---
function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;

    if (!seen.has(mint)) {
      seen.add(mint);
      startLiveWatch(mint, msg?.name || msg?.tokenName, msg?.symbol || msg?.ticker);
    }
  });

  ws.on("close", (c, r) => {
    log(`🔌 WS closed ${c} ${(r || "").toString()}. Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => log("❌ WS error:", e.message));
}

log("Worker starting…");
connect();
