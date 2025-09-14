// index.js — v3: только LIVE, без "NEW TOKEN", с устойчивым fetch и ретраями
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";
const LIVE_INTERVAL = 12000;        // опрос лайва каждые 12 сек
const LIVE_TIMEOUT_MIN = 30;        // ждать лайв не дольше 30 минут
const MAX_FETCH_RETRIES = 2;        // повторы при сетевых глюках

const tracking = new Map();         // mint -> timer
const seen = new Set();             // чтобы не запускать два watcher на один mint

function log(...a){ console.log(new Date().toISOString(), ...a); }

// надёжный fetch + json со страховкой и ретраями
async function safeGetJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "pumplive-watcher/3.0"
        },
        timeout: 10000
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!text) throw new Error("Empty body");
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("Bad JSON: " + e.message);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_FETCH_RETRIES) {
        await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
}

async function getCoin(mint){
  return safeGetJson(`${API}/coins/${mint}`);
}

function startLiveWatch(mint, name="", symbol=""){
  if (tracking.has(mint)) return;

  const startedAt = Date.now();
  const timer = setInterval(async () => {
    try {
      // стоп, если слишком долго ждём
      if ((Date.now() - startedAt)/60000 > LIVE_TIMEOUT_MIN) {
        clearInterval(timer); tracking.delete(mint);
        return;
      }

      const data = await getCoin(mint);
      if (data?.is_currently_live) {
        clearInterval(timer); tracking.delete(mint);

        const title = data.name || name || "";
        const sym = data.symbol || symbol || "";
        log(`🎥 LIVE START | ${title} (${sym})`);
        log(`   mint: ${mint}`);
        if (typeof data.usd_market_cap === "number")
          log(`   mcap_usd: ${data.usd_market_cap.toFixed(2)}`);
        if (data.thumbnail) log(`   thumbnail: ${data.thumbnail}`);
      }
    } catch (e) {
      log("⚠️  live-check error:", e.message);
    }
  }, LIVE_INTERVAL);

  tracking.set(mint, timer);
}

function connect(){
  const ws = new WebSocket(WS_URL);

  ws.on("open", ()=>{
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw)=>{
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;

    // только запускаем watcher; никаких "NEW TOKEN" логов
    if (!seen.has(mint)) {
      seen.add(mint);
      startLiveWatch(mint, msg?.name || msg?.tokenName, msg?.symbol || msg?.ticker);
    }
  });

  ws.on("close", (c, r)=>{
    log(`🔌 WS closed ${c} ${(r||"").toString()}. Reconnecting in 3s…`);
    setTimeout(connect, 3000);
  });

  ws.on("error", (e)=> log("❌ WS error:", e.message));
}

log("Worker starting…");
connect();
