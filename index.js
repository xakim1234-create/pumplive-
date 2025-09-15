// index.js — v10.4.1
// Основа 10.1 + ступени 5s/10s/15s, RPS-троттлинг, дедуп.
// Live решается ТОЛЬКО по coin.is_currently_live == true.
// Анти-флап: быстрый мини-повтор на 5s и 15s (по умолчанию включено), 10s — опционально.
// В окне 30s: при внезапном not_live одна короткая перепроверка.

import process from "process";
import WebSocket from "ws";
import fetch from "node-fetch";

// ===== Config (ENV + дефолты) =====
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data";
const API    = process.env.PUMP_API    || "https://frontend-api-v3.pump.fun";

// Порог и окно
const VIEWERS_THRESHOLD   = int("VIEWERS_THRESHOLD", 30);
const MEASURE_WINDOW_MS   = int("MEASURE_WINDOW_MS", 30_000);
const RECHECKS            = int("RECHECKS", 6);
const RECHECK_STEP_MS     = int("RECHECK_STEP_MS", 5_000);

// One-shot расписание
const FIRST_CHECK_DELAY_MS  = int("FIRST_CHECK_DELAY_MS", 5_000);
const SECOND_CHECK_DELAY_MS = int("SECOND_CHECK_DELAY_MS", 10_000);
const THIRD_CHECK_DELAY_MS  = int("THIRD_CHECK_DELAY_MS", 15_000);

// Параллельность и троттлинг
const MAX_CONCURRENCY     = int("MAX_CONCURRENCY", 12);
const GLOBAL_RPS          = num("GLOBAL_RPS", 3);
const JITTER_MS           = int("JITTER_MS", 150);

// Дедуп WS
const DEDUP_TTL_MS        = int("DEDUP_TTL_MS", 10 * 60_000);

// Rescue api_null
const API_NULL_RETRIES    = int("API_NULL_RETRIES", 4);
const API_NULL_STEP_MS    = int("API_NULL_STEP_MS", 1_000);

// Быстрые переповторы на one-shot’ах
const FAST_RECHECK_FIRST  = bool("FAST_RECHECK_FIRST", true);
const FAST_RECHECK_SECOND = bool("FAST_RECHECK_SECOND", false); // по умолчанию выкл (можно включить)
const FAST_RECHECK_THIRD  = bool("FAST_RECHECK_THIRD", true);
const FAST_RECHECK_DELAY_MS = int("FAST_RECHECK_DELAY_MS", 450); // 300–600мс ок

// В окне: подтверждение «снялся лайв»
const WINDOW_CONFIRM_LEFT_LIVE = bool("WINDOW_CONFIRM_LEFT_LIVE", true);
const WINDOW_CONFIRM_DELAY_MS  = int("WINDOW_CONFIRM_DELAY_MS", 300);

// Heartbeat
const HEARTBEAT_MS        = int("HEARTBEAT_MS", 60_000);

// Telegram (фоллбек)
const TG_TOKEN_HARDCODED   = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID_HARDCODED = "-4857972467";
const TG_TOKEN             = (process.env.TG_TOKEN || TG_TOKEN_HARDCODED || "").trim();
const TG_CHAT_ID           = (process.env.TG_CHAT_ID || TG_CHAT_ID_HARDCODED || "").trim();

// ===== Helpers =====
function int(name, def){ const v=parseInt(process.env[name]||"",10); return Number.isFinite(v)?v:def; }
function num(name, def){ const v=Number(process.env[name]); return Number.isFinite(v)?v:def; }
function bool(name, def){ const v=(process.env[name]||"").trim().toLowerCase(); if(v==="true")return true; if(v==="false")return false; return def; }
function log(...a){ console.log(new Date().toISOString(), ...a); }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ===== State / Metrics =====
let ws;
let lastWsMsgAt = 0;

const metrics = {
  api_req:0, api_ok:0, api_retry:0, api_429:0, api_other:0,
  queued:0, started:0, done:0, alerted:0,
  dedup_skip:0, api_null_skip:0, api_null_recovered:0,
  threshold_miss:0, not_live_skip:0,

  scheduled_first:0, scheduled_second:0, scheduled_third:0,
  performed_first:0, performed_second:0, performed_third:0,
  first_live:0, second_live:0, third_live:0,
  second_skip:0, third_skip:0,

  avgReadyDelayFirst_sum:0, avgReadyDelayFirst_cnt:0,
  avgReadyDelaySecond_sum:0, avgReadyDelaySecond_cnt:0,
  avgReadyDelayThird_sum:0, avgReadyDelayThird_cnt:0,

  windows_started:0, windows_hit:0, windows_miss:0
};

// дедуп по mint
const recently = new Map();
function seenRecently(mint){ const t = recently.get(mint); if(!t) return false; if(Date.now()-t>DEDUP_TTL_MS){ recently.delete(mint); return false;} return true; }
function markSeen(mint){ recently.set(mint, Date.now()); }

// ===== Global API throttle =====
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttleApi(){
  const now = Date.now();
  const gap = (now < penaltyUntil) ? Math.max(minGapMs, 1000) : minGapMs;
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  const jitter = (Math.random()*2 - 1) * JITTER_MS;
  nextAllowedAt = Date.now() + gap + Math.max(-JITTER_MS, Math.min(JITTER_MS, jitter));
}

// ===== API =====
function coinUrl(mint){ return `${API}/coins/${mint}?_=${Date.now()}`; }

function viewersOf(json){
  if (typeof json?.num_participants === "number") return json.num_participants|0;
  if (typeof json?.viewer_count === "number")     return json.viewer_count|0;
  if (typeof json?.stream?.viewer_count === "number") return json.stream.viewer_count|0;
  return 0;
}

function isLive(json){ return json?.is_currently_live == true; }

async function fetchCoin(mint, maxRetries=2){
  const url = coinUrl(mint);
  for (let attempt=0; attempt<=maxRetries; attempt++){
    try{
      await throttleApi();
      metrics.api_req++;
      const r = await fetch(url, {
        headers:{
          "accept":"application/json, text/plain, */*",
          "cache-control":"no-cache, no-store",
          "pragma":"no-cache",
          "user-agent":"pump-watcher/10.4.1"
        }
      });
      if (r.status === 429){
        metrics.api_429++; penaltyUntil = Date.now()+30_000;
        await sleep(1500+Math.random()*1000); continue;
      }
      if (!r.ok){ metrics.api_other++; throw new Error("HTTP "+r.status); }
      const text = await r.text(); if (!text || text.trim()==="") throw new Error("Empty body");
      const json = JSON.parse(text); metrics.api_ok++; return json;
    }catch(e){
      if (attempt < maxRetries){ metrics.api_retry++; await sleep(400*(attempt+1)); continue; }
      return null;
    }
  }
}

// ===== Telegram =====
async function sendTG(text, photo=null){
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try{
    const url = photo
      ? `https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`
      : `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = photo
      ? { chat_id: TG_CHAT_ID, photo, caption: text, parse_mode:"HTML" }
      : { chat_id: TG_CHAT_ID, text, parse_mode:"HTML" };
    await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    log("tg:sent");
  }catch(e){ log("telegram error:", e.message); }
}

function fmt(n){ try{ return Number(n).toLocaleString("en-US"); }catch{ return String(n); } }

async function alertLive(mint, coin, viewers, source="api"){
  const title = `${coin?.name || ""} (${coin?.symbol || ""})`.trim();
  const socials = [];
  if (coin?.website)  socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter)  socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord)  socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);
  const NL = "\n";
  const parts = [
    `🎥 <b>LIVE START</b> | ${title || "(no title)"}`,
    `Mint: <code>${mint}</code>`,
    `👁 Viewers: ${fmt(viewers)} (source: ${source})`,
    `💰 Market Cap (USD): ${typeof coin?.usd_market_cap==="number" ? "$"+fmt(coin.usd_market_cap) : "n/a"}`,
    `🔗 Axiom: https://axiom.trade/t/${mint}`
  ];
  if (socials.length) parts.push(socials.join(NL));
  const msg = parts.join(NL);

  log("tg:send start");
  await sendTG(msg, coin?.image_uri || null);
  metrics.alerted++;
  log("ALERT sent |", title, "| viewers:", viewers);
}

// ===== Окно 30s =====
async function measureWindow(mint){
  metrics.windows_started++;
  const attempts = Math.max(1, RECHECKS);
  const step = Math.max(200, RECHECK_STEP_MS);
  const t0 = Date.now();
  let maxViewers = 0;

  for (let i=0; i<attempts; i++){
    if (Date.now() - t0 > MEASURE_WINDOW_MS) break;

    let c = await fetchCoin(mint, 1);
    if (!c){
      for (let k=1;k<=API_NULL_RETRIES;k++){
        await sleep(API_NULL_STEP_MS);
        c = await fetchCoin(mint, 1);
        if (c){ metrics.api_null_recovered++; break; }
      }
      if (!c) { metrics.windows_miss++; return { ok:false, reason:"api_null", maxViewers }; }
    }

    if (!isLive(c) && WINDOW_CONFIRM_LEFT_LIVE){
      await sleep(WINDOW_CONFIRM_DELAY_MS);
      const c2 = await fetchCoin(mint, 0);
      if (c2) c = c2;
    }
    if (!isLive(c)){ metrics.windows_miss++; return { ok:false, reason:"left_live", maxViewers }; }

    const v = viewersOf(c);
    if (typeof v === "number") maxViewers = Math.max(maxViewers, v);
    log(`probe ${i+1}/${attempts} | viewers=${v} | threshold=${VIEWERS_THRESHOLD}`);

    if (v >= VIEWERS_THRESHOLD){
      metrics.windows_hit++;
      return { ok:true, viewers:v, source:"api", maxViewers };
    }

    const nextPlanned = t0 + Math.min(MEASURE_WINDOW_MS, (i+1)*step);
    const sleepMs = Math.max(0, nextPlanned - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
  metrics.windows_miss++;
  return { ok:false, reason:"threshold_not_reached", maxViewers };
}

// ===== Планировщик 5s→10s→15s =====
const delayedFirst  = []; // { mint, at, t0 }
const delayedSecond = [];
const delayedThird  = [];

const scheduledFirstSet  = new Set();
const scheduledSecondSet = new Set();
const scheduledThirdSet  = new Set();

let activeWorkers = 0;

function scheduleFirst(mint){
  if (scheduledFirstSet.has(mint)) return;
  const t0 = Date.now();
  scheduledFirstSet.add(mint);
  delayedFirst.push({ mint, at: t0 + FIRST_CHECK_DELAY_MS, t0 });
  metrics.scheduled_first++;
}
function scheduleSecond(mint, t0){
  if (scheduledSecondSet.has(mint)) return;
  scheduledSecondSet.add(mint);
  delayedSecond.push({ mint, at: Math.max(Date.now(), t0 + SECOND_CHECK_DELAY_MS), t0 });
  metrics.scheduled_second++;
}
function scheduleThird(mint, t0){
  if (scheduledThirdSet.has(mint)) return;
  scheduledThirdSet.add(mint);
  delayedThird.push({ mint, at: Math.max(Date.now(), t0 + THIRD_CHECK_DELAY_MS), t0 });
  metrics.scheduled_third++;
}

function takeReadyJob(){
  const now = Date.now();
  for (let i=0;i<delayedThird.length;i++)  if ((delayedThird[i].at||0)  <= now) return { ...delayedThird.splice(i,1)[0],  kind:'third'  };
  for (let i=0;i<delayedSecond.length;i++) if ((delayedSecond[i].at||0) <= now) return { ...delayedSecond.splice(i,1)[0], kind:'second' };
  for (let i=0;i<delayedFirst.length;i++)  if ((delayedFirst[i].at||0)  <= now) return { ...delayedFirst.splice(i,1)[0],  kind:'first'  };
  return null;
}

// ===== Worker =====
async function workerLoop(){
  while(true){
    if (activeWorkers >= MAX_CONCURRENCY){ await sleep(50); continue; }
    const job = takeReadyJob();
    if (!job){ await sleep(20); continue; }

    activeWorkers++;
    (async () => {
      try{
        metrics.started++;
        const startAt = Date.now();
        const { mint, at, t0, kind } = job;
        if (kind==='first') scheduledFirstSet.delete(mint);
        else if (kind==='second') scheduledSecondSet.delete(mint);
        else scheduledThirdSet.delete(mint);

        // задержка запуска
        if (kind==='first'){  metrics.performed_first++;  metrics.avgReadyDelayFirst_sum  += Math.max(0, startAt - at); metrics.avgReadyDelayFirst_cnt++; }
        else if (kind==='second'){ metrics.performed_second++; metrics.avgReadyDelaySecond_sum += Math.max(0, startAt - at); metrics.avgReadyDelaySecond_cnt++; }
        else { metrics.performed_third++; metrics.avgReadyDelayThird_sum += Math.max(0, startAt - at); metrics.avgReadyDelayThird_cnt++; }

        // === Чек ===
        let coin = await fetchCoin(mint, 2);
        if (!coin){
          for (let i=1;i<=API_NULL_RETRIES;i++){
            log(`api_null → retry ${i}/${API_NULL_RETRIES} | ${mint}`);
            await sleep(API_NULL_STEP_MS);
            coin = await fetchCoin(mint, 1);
            if (coin){ metrics.api_null_recovered++; break; }
          }
          if (!coin){ metrics.api_null_skip++; log("skip: api_null", mint); return; }
        }

        const fastRecheckNeeded = (kind==='first' && FAST_RECHECK_FIRST)
                               || (kind==='second' && FAST_RECHECK_SECOND)
                               || (kind==='third' && FAST_RECHECK_THIRD);

        let live = isLive(coin);

        // анти-флап: быстрый короткий переповтор на нужных ступенях
        if (!live && fastRecheckNeeded){
          await sleep(FAST_RECHECK_DELAY_MS);
          const c2 = await fetchCoin(mint, 0);
          if (c2){ coin = c2; live = isLive(coin); }
        }

        if (!live){
          log(`decide not_live | stage=${kind} | mint=${mint} | is_currently_live=`, coin?.is_currently_live, typeof coin?.is_currently_live);
          if (kind==='first'){
            scheduleSecond(mint, t0);
          } else if (kind==='second'){
            log("not_live (second) → scheduled third", mint);
            scheduleThird(mint, t0);
            metrics.second_skip++; metrics.not_live_skip++;
          } else {
            log("skip: not_live (third one-shot)", mint);
            metrics.third_skip++; metrics.not_live_skip++;
          }
          return;
        }

        if (kind==='first')  metrics.first_live++;
        if (kind==='second') metrics.second_live++;
        if (kind==='third')  metrics.third_live++;

        // === Live → окно 30s
        const res = await measureWindow(mint);
        if (res.ok){
          await alertLive(mint, coin, res.viewers, res.source);
        } else {
          metrics.threshold_miss++;
          log("miss threshold:", mint, "| reason:", res.reason, "| max_viewers=", res.maxViewers);
        }

      }catch(e){
        log("task error:", e.message);
      }finally{
        metrics.done++;
        activeWorkers--;
      }
    })();
  }
}

// ===== WebSocket intake =====
function connectWS(){
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log("WS connected, subscribing new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });
  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg=null; try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    if (seenRecently(mint)){ metrics.dedup_skip++; return; }
    markSeen(mint);
    metrics.queued++;
    scheduleFirst(mint);
  });
  ws.on("close", () => { log("WS closed → reconnect in 5s"); setTimeout(connectWS, 5000); });
  ws.on("error", (e) => { log("WS error:", e.message); });
}

// ===== Heartbeat =====
setInterval(() => {
  const secSinceWs = lastWsMsgAt ? Math.round((Date.now()-lastWsMsgAt)/1000) : -1;
  const avg = (s,c)=> c?Math.round(s/c):0;
  log(
    "[stats]",
    "queued="+metrics.queued,
    "active="+activeWorkers,
    "stack_first="+delayedFirst.length,
    "stack_second="+delayedSecond.length,
    "stack_third="+delayedThird.length,
    "ws_last="+secSinceWs+"s",
    "| api:req="+metrics.api_req,
    "ok="+metrics.api_ok,
    "retry="+metrics.api_retry,
    "429="+metrics.api_429,
    "other="+metrics.api_other,
    "| started="+metrics.started,
    "done="+metrics.done,
    "alerted="+metrics.alerted,
    "| skip:dedup="+metrics.dedup_skip,
    "api_null="+metrics.api_null_skip,
    "not_live="+metrics.not_live_skip,
    "miss="+metrics.threshold_miss,
    "| scheduled:first="+metrics.scheduled_first,
    "second="+metrics.scheduled_second,
    "third="+metrics.scheduled_third,
    "| performed:first="+metrics.performed_first,
    "second="+metrics.performed_second,
    "third="+metrics.performed_third,
    "| first_live="+metrics.first_live,
    "second_live="+metrics.second_live,
    "third_live="+metrics.third_live,
    "| windows: started="+metrics.windows_started,
    "hit="+metrics.windows_hit,
    "miss="+metrics.windows_miss,
    "| avgReadyDelayFirstMs="+avg(metrics.avgReadyDelayFirst_sum,metrics.avgReadyDelayFirst_cnt),
    "avgReadyDelaySecondMs="+avg(metrics.avgReadyDelaySecond_sum,metrics.avgReadyDelaySecond_cnt),
    "avgReadyDelayThirdMs="+avg(metrics.avgReadyDelayThird_sum,metrics.avgReadyDelayThird_cnt)
  );
}, HEARTBEAT_MS);

// ===== Start =====
log("Worker starting…",
  "| THR="+VIEWERS_THRESHOLD,
  "| WINDOW="+MEASURE_WINDOW_MS+"ms",
  "| RECHECKS="+RECHECKS+"@"+RECHECK_STEP_MS+"ms",
  "| FIRST="+FIRST_CHECK_DELAY_MS+"ms",
  "| SECOND="+SECOND_CHECK_DELAY_MS+"ms",
  "| THIRD="+THIRD_CHECK_DELAY_MS+"ms",
  "| CONC="+MAX_CONCURRENCY,
  "| RPS="+GLOBAL_RPS,
  "| apiNullRescue="+API_NULL_RETRIES+"@"+API_NULL_STEP_MS+"ms",
  "| fast: 5s="+FAST_RECHECK_FIRST+", 10s="+FAST_RECHECK_SECOND+", 15s="+FAST_RECHECK_THIRD+" @"+FAST_RECHECK_DELAY_MS+"ms",
  "| windowConfirm="+WINDOW_CONFIRM_LEFT_LIVE+"@"+WINDOW_CONFIRM_DELAY_MS+"ms"
);
connectWS();
workerLoop();

// ===== Graceful =====
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT",  ()=>process.exit(0));
