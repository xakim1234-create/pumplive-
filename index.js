import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";
const LIVE_INTERVAL = 10000;       // опрос лайва каждые 10 сек
const LIVE_TIMEOUT_MIN = 30;       // ждать лайв не дольше 30 минут

const tracking = new Map();        // mint -> timer
const seen = new Set();            // чтобы не дублировать "NEW TOKEN" в логах

function log(...a){ console.log(new Date().toISOString(), ...a); }

async function getCoin(mint){
  const r = await fetch(`${API}/coins/${mint}`, { headers: { accept: "application/json" }});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function startLiveWatch(mint, name="", symbol=""){
  if(tracking.has(mint)) return;
  const start = Date.now();
  const t = setInterval(async ()=>{
    try{
      if((Date.now()-start)/60000 > LIVE_TIMEOUT_MIN){
        clearInterval(t); tracking.delete(mint);
        log(`⏱️  LIVE не начался за ${LIVE_TIMEOUT_MIN} мин — ${name} (${symbol}) ${mint}`);
        return;
      }
      const data = await getCoin(mint);
      if(data?.is_currently_live){
        clearInterval(t); tracking.delete(mint);
        log(`🎥 LIVE START | ${data.name||name} (${data.symbol||symbol})`);
        log(`   mint: ${mint}`);
        if(typeof data.usd_market_cap === "number")
          log(`   mcap_usd: ${data.usd_market_cap.toFixed(2)}`);
      }
    }catch(e){ log("⚠️  live-check error:", e.message); }
  }, LIVE_INTERVAL);
  tracking.set(mint, t);
}

function connect(){
  const ws = new WebSocket(WS_URL);

  ws.on("open", ()=>{
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw)=>{
    let msg;
    try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if(!mint) return;

    if(!seen.has(mint)){
      seen.add(mint);
      log(`🆕 NEW TOKEN | ${msg?.name || msg?.tokenName || ""} (${msg?.symbol || msg?.ticker || ""}) — ${mint}`);
      startLiveWatch(mint, msg?.name||msg?.tokenName, msg?.symbol||msg?.ticker);
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
