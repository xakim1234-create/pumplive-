// index.js
import WebSocket from "ws";
import fetch from "node-fetch";

// ============================
// Конфиг
// ============================
const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api.pump.fun";

const DEBOUNCE_MS_MIN = 900;   // первая задержка
const DEBOUNCE_MS_MAX = 1200;
const QUICK_RECHECKS = 6;      // сколько быстрых проверок
const QUICK_STEP_MS   = 500;   // интервал между ними

// ============================
// Вспомогательные
// ============================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pending = new Set();

// аккуратный fetch с no-cache и ретраями
async function fetchCoinSafe(mint, retries = 2) {
  const url = `${API}/coins/${mint}?_=${Date.now()}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "cache-control": "no-cache, no-store",
          "pragma": "no-cache",
          "user-agent": "live-sniffer/mini"
        }
      });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error("empty-body");
      return JSON.parse(text);
    } catch (e) {
      if (i < retries) {
        await sleep(350 + i * 200);
        continue;
      }
      throw e;
    }
  }
}

// проверка лайва (дебаунс + быстрые ре-чеки)
async function confirmLive(mint) {
  if (pending.has(mint)) return;
  pending.add(mint);

  const debounce = Math.floor(
    DEBOUNCE_MS_MIN + Math.random() * (DEBOUNCE_MS_MAX - DEBOUNCE_MS_MIN)
  );
  await sleep(debounce);

  let lastErr = null;
  for (let i = 0; i <= QUICK_RECHECKS; i++) {
    try {
      const c = await fetchCoinSafe(mint, 2);
      const live = c?.is_currently_live === true;
      const viewers = (typeof c?.num_participants === "number")
        ? c.num_participants
        : "n/a";

      if (live) {
        console.log(new Date().toISOString(),
          `🔥 LIVE | ${mint} | ${(c?.symbol || "").toString()} (${(c?.name || "").toString()}) | viewers=${viewers} | is_currently_live=true`
        );
        pending.delete(mint);
        return;
      }

      // если не лайв — повторим через QUICK_STEP_MS
      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }

      // последняя попытка и всё ещё false
      console.log(new Date().toISOString(),
        `… not live | ${mint} | viewers=${viewers} | is_currently_live=false`
      );
      pending.delete(mint);
      return;

    } catch (e) {
      lastErr = e;
      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }
      console.log(`❌ fetch error: ${e.message} | mint: ${mint}`);
      pending.delete(mint);
      return;
    }
  }

  if (pending.has(mint)) pending.delete(mint);
}

// ============================
// WebSocket подключение
// ============================
const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log(`✅ WS connected: ${WS_URL}`);
  ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  console.log("📡 Subscribed: subscribeNewToken");
});

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    confirmLive(mint);
  } catch (e) {
    console.error("parse error:", e);
  }
});

ws.on("error", (err) => {
  console.error("WS error:", err);
});

ws.on("close", () => {
  console.error("WS closed, reconnecting in 3s...");
  setTimeout(() => {
    process.exit(1); // Render сам перезапустит
  }, 3000);
});
