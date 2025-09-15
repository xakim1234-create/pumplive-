// index.js
import WebSocket from "ws";

// ============================
// Конфиг
// ============================
const WS_URL = "wss://pumpportal.fun/api/data";
const API_BASES = [
  "https://frontend-api-v3.pump.fun",
  "https://frontend-api.pump.fun"
];

const DEBOUNCE_MS_MIN = 900;   // первая задержка
const DEBOUNCE_MS_MAX = 1200;
const QUICK_RECHECKS  = 6;     // сколько быстрых проверок
const QUICK_STEP_MS   = 500;   // интервал между ними
const RPS_DELAY_MS    = 120;   // лёгкий глобальный троттлинг

// ============================
// Вспомогательные
// ============================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pending = new Set();
let nextAllowedAt = 0;

async function throttle() {
  const now = Date.now();
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  nextAllowedAt = Date.now() + RPS_DELAY_MS;
}

function isProbablyHtml(text) {
  if (!text) return false;
  const s = text.trim().slice(0, 64).toLowerCase();
  return s.startsWith("<!doctype") || s.startsWith("<html");
}

// аккуратный fetch с проверкой контента + фолбэки по доменам
async function fetchCoinSafe(mint, totalRetries = 3) {
  const qs = `?_=${Date.now()}`;
  const headers = {
    "accept": "application/json, text/plain, */*",
    "cache-control": "no-cache, no-store",
    "pragma": "no-cache",
    "user-agent": "live-sniffer/mini"
  };

  let lastErr = null;

  for (let attempt = 0; attempt <= totalRetries; attempt++) {
    for (const base of API_BASES) {
      const url = `${base}/coins/${mint}${qs}`;
      try {
        await throttle();
        const r = await fetch(url, { headers, redirect: "follow" });
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const text = await r.text();

        if (!r.ok) {
          // 403/404/5xx — пробуем другой base или ретрай
          lastErr = new Error(`HTTP ${r.status}`);
          continue;
        }
        if (!text || !text.trim()) {
          lastErr = new Error("empty-body");
          continue;
        }
        if (!ct.includes("application/json") || isProbablyHtml(text)) {
          // отдали HTML (CF/редирект-страница) — пробуем другой base/ретрай
          lastErr = new Error("html-response");
          continue;
        }

        // Парсим JSON
        try {
          return JSON.parse(text);
        } catch (e) {
          lastErr = new Error("bad-json");
          continue;
        }
      } catch (e) {
        lastErr = e;
        // пробуем следующий base или ещё один круг
        continue;
      }
    }

    // короткий бэкофф перед следующим кругом
    if (attempt < totalRetries) {
      await sleep(300 + attempt * 200);
    }
  }

  throw lastErr || new Error("unknown-fetch-failure");
}

async function confirmLive(mint) {
  if (pending.has(mint)) return;
  pending.add(mint);

  const debounce = Math.floor(
    DEBOUNCE_MS_MIN + Math.random() * (DEBOUNCE_MS_MAX - DEBOUNCE_MS_MIN)
  );
  await sleep(debounce);

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

      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }

      console.log(new Date().toISOString(),
        `… not live | ${mint} | viewers=${viewers} | is_currently_live=false`
      );
      pending.delete(mint);
      return;

    } catch (e) {
      // если контент HTML/пустой — просто повторяем быстрый чек
      const msg = (e && e.message) ? e.message : String(e);
      if (["html-response","empty-body","bad-json"].includes(msg) && i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }
      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }
      console.log(`❌ fetch error: ${msg} | mint: ${mint}`);
      pending.delete(mint);
      return;
    }
  }

  pending.delete(mint);
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
  setTimeout(() => process.exit(1), 3000); // Render перезапустит
});
