// index.js — v10.0.0 ("single 5s check" design)
// Логика: WS даёт mint → ЖДЁМ РОВНО 5s → один API-чек.
//  - Если live → запускаем измерение окна до 30s (до 6 проб каждые ~5s) и, если порог взят, шлём TG-алёрт.
//  - Если not_live → мгновенный skip. НИКАКИХ повторных recheck и очередей recheck.
//  - Весь трафик API идёт через ОДИН глобальный лимитер RPS, чтобы не ловить 429. Воркеров может быть много.
// Браузер НЕ используется.

// ===== Imports =====
import process from "process";
import WebSocket from "ws";
import fetch from "node-fetch";

// ===== Config (ENV + хардкод-фоллбек для TG) =====
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data";
const API = process.env.PUMP_API || "https://frontend-api-v3.pump.fun";

// Порог и окно измерения
const VIEWERS_THRESHOLD   = int("VIEWERS_THRESHOLD", 30);        // >= этого — алёрт
const MEASURE_WINDOW_MS   = int("MEASURE_WINDOW_MS", 30_000);    // 30s окно
const RECHECKS            = int("RECHECKS", 6);                   // 6 проб
const RECHECK_STEP_MS     = int("RECHECK_STEP_MS", 5_000);        // шаг 5s

// Единственный 5-секундный задержанный первичный чек
const FIRST_CHECK_DELAY_MS = int("FIRST_CHECK_DELAY_MS", 5_000);  // Ждём 5s после WS

// Параллельность и глобальный троттлинг API
const MAX_CONCURRENCY     = int("MAX_CONCURRENCY", 8);            // воркеры на выполнение готовых задач
const GLOBAL_RPS          = num("GLOBAL_RPS", 3);                  // лимит запросов/сек (можно 2–4)
const JITTER_MS           = int("JITTER_MS", 150);                 // небольшой джиттер

// Дедупликация: одно и то же mint не тревожим N минут (для входа из WS)
const DEDUP_TTL_MS        = int("DEDUP_TTL_MS", 10 * 60_000);

// Поведение (для логов)
const STRICT_ONE_SHOT     = bool("STRICT_ONE_SHOT", true);         // теперь реально one-shot на T0+5s
const API_VIEWERS_ONLY    = bool("API_VIEWERS_ONLY", true);

// Rescue для api_null
const API_NULL_RETRIES    = int("API_NULL_RETRIES", 4);           // 4 быстрых ретрая
const API_NULL_STEP_MS    = int("API_NULL_STEP_MS", 1_000);       // шаг 1s между ретраями

// Heartbeat
const HEARTBEAT_MS        = int("HEARTBEAT_MS", 60_000);

// Telegram — либо ENV, либо хардкод ниже (замени на свои при деплое)
const TG_TOKEN_HARDCODED   = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID_HARDCODED = "-4857972467";
const TG_TOKEN             = (process.env.TG_TOKEN || TG_TOKEN_HARDCODED || "").trim();
const TG_CHAT_ID           = (process.env.TG_CHAT_ID || TG_CHAT_ID_HARDCODED || "").trim();

// ===== Helpers =====
function int(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function num(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function bool(name, def) { const v = (process.env[name] || "").trim().toLowerCase(); if (v === "true") return true; if (v === "false") return false; return def; }
function log(...a){ console.log(new Date().toISOString(), ...a); }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ===== State / Metrics =====
let ws;
let lastWsMsgAt = 0;

const metrics = {
  api_req: 0, api_ok: 0, api_retry: 0, api_429: 0, api_other: 0,
  queued: 0, scheduled: 0, started: 0, done: 0, alerted: 0,
  dedup_skip: 0, api_null_skip: 0, threshold_miss: 0, not_live_skip: 0,
  api_null_recovered: 0,
  schedule_ready_delay_ms_sum: 0, schedule_ready_count: 0,
};

// дедуп по mint (для входа из WS)
const recently = new Map(); // mint -> ts
function seenRecently(mint){
  const t = recently.get(mint);
  if (!t) return false;
  if (Date.now() - t > DEDUP_TTL_MS) { recently.delete(mint); return false; }
  return true;
}
function markSeen(mint){ recently.set(mint, Date.now()); }

// ===== Global API throttle (RPS + penalty после 429) =====
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS))); // напр. 3 rps => ~333ms
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttleApi(){
  const now = Date.now();
  const currentGap = (now < penaltyUntil) ? Math.max(minGapMs, 1000) : minGapMs; // осторожнее после 429
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  const jitter = (Math.random()*2 - 1) * JITTER_MS;
  nextAllowedAt = Date.now() + currentGap + Math.max(-JITTER_MS, Math.min(JITTER_MS, jitter));
}

// ===== API =====
function coinUrl(mint){
  // кэш-бастер — снижает шанс получить старый/пустой ответ
  const bust = Date.now().toString();
  return `${API}/coins/${mint}?_=${bust}`;
}

async function fetchCoin(mint, maxRetries=2){
  const url = coinUrl(mint);
  for (let attempt=0; attempt<=maxRetries; attempt++){
    try{
      await throttleApi();
      metrics.api_req++;
      const r = await fetch(url, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "cache-control": "no-cache, no-store",
          "pragma": "no-cache",
          "user-agent": "pump-watcher/10.0.0"
        }
      });
      if (r.status === 429){
        metrics.api_429++;
        penaltyUntil = Date.now() + 30_000; // 30s осторожный режим
        await sleep(1500 + Math.random()*1000);
        continue;
      }
      if (!r.ok){
        metrics.api_other++;
        throw new Error("HTTP "+r.status);
      }
      const text = await r.text();
      if (!text || text.trim()==="") throw new Error("Empty body");
      const json = JSON.parse(text);
      metrics.api_ok++;
      return json;
    }catch(e){
      if (attempt < maxRetries){
        metrics.api_retry++;
        await sleep(400 * (attempt+1));
        continue;
      }
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
      ? { chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: "HTML" }
      : { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" };
    await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    log("tg:sent");
  }catch(e){
    log("telegram error:", e.message);
  }
}

function fmt(n){ try{ return Number(n).toLocaleString("en-US"); }catch{ return String(n); } }

async function alertLive(mint, coin, viewers, source="api"){
  const title = `${coin.name || ""} (${coin.symbol || ""})`.trim();
  const hasSocials = !!(coin?.website || coin?.twitter || coin?.telegram || coin?.discord);
  const socials = [];
  if (coin?.website)  socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter)  socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord)  socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);

  const msg = [
    `🎥 <b>LIVE START</b> | ${title}${hasSocials ? "" : " <i>(no socials)</i>"}`,
    `Mint: <code>${mint}</code>`,
    `👁 Viewers: ${fmt(viewers)} (source: ${source})`,
    `💰 Market Cap (USD): ${typeof coin.usd_market_cap==="number" ? "$"+fmt(coin.usd_market_cap) : "n/a"}`,
    `🔗 Axiom: https://axiom.trade/t/${mint}`,
    socials.length ? socials.join("\n") : null
  ].filter(Boolean).join("\n");

  log("tg:send start");
  await sendTG(msg, coin?.image_uri || null);
  metrics.alerted++;
  log("ALERT sent |", title, "| viewers:", viewers, "| source:", source, "| socials:", hasSocials ? "yes" : "no");
}

// ===== Измерение окна 30s =====
async function measureWindow(mint){
  const attempts = Math.max(1, RECHECKS);
  const step = Math.max(200, RECHECK_STEP_MS);
  const t0 = Date.now();
  let maxViewers = 0;

  for (let i=0; i<attempts; i++){
    if (Date.now() - t0 > MEASURE_WINDOW_MS) break;
    const c = await fetchCoin(mint, 1);
    if (!c || c.is_currently_live !== true){
      return { ok:false, reason:"left_live", maxViewers };
    }
    const v = (typeof c.num_participants === "number") ? c.num_participants : null;
    if (typeof v === "number") maxViewers = Math.max(maxViewers, v);
    log(`probe ${i+1}/${attempts} | viewers=${v} | threshold=${VIEWERS_THRESHOLD}`);
    if (v !== null && v >= VIEWERS_THRESHOLD){
      return { ok:true, viewers:v, source:"api", maxViewers };
    }
    const nextPlanned = t0 + Math.min(MEASURE_WINDOW_MS, (i+1)*step);
    const sleepMs = Math.max(0, nextPlanned - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return { ok:false, reason:"threshold_not_reached", maxViewers };
}

// ===== Планировщик «одного чека через 5s» + воркеры =====
const delayedChecks = [];          // элементы: { mint, at }
const scheduledSet = new Set();    // чтобы не планировать дубли в окно 5s
let activeWorkers = 0;

function scheduleSingleCheck(mint){
  if (scheduledSet.has(mint)) return; // уже запланирован
  scheduledSet.add(mint);
  delayedChecks.push({ mint, at: Date.now() + FIRST_CHECK_DELAY_MS });
  metrics.scheduled++;
}

function takeReadyJob(){
  const now = Date.now();
  for (let i=0; i<delayedChecks.length; i++){
    if ((delayedChecks[i].at || 0) <= now){
      return delayedChecks.splice(i,1)[0];
    }
  }
  return null;
}

async function workerLoop(){
  while (true){
    if (activeWorkers >= MAX_CONCURRENCY){ await sleep(50); continue; }
    const job = takeReadyJob();
    if (!job){ await sleep(20); continue; }

    activeWorkers++;
    (async () => {
      const startedAt = Date.now();
      try{
        metrics.started++;
        const { mint, at } = job;
        scheduledSet.delete(mint);
        const readyDelay = Math.max(0, startedAt - at);
        metrics.schedule_ready_delay_ms_sum += readyDelay;
        metrics.schedule_ready_count++;

        // === Единственный первичный чек: ===
        let coin = await fetchCoin(mint, 2);
        if (!coin){
          for (let i=1; i<=API_NULL_RETRIES; i++){
            log(`api_null → retry ${i}/${API_NULL_RETRIES} | ${mint}`);
            await sleep(API_NULL_STEP_MS);
            coin = await fetchCoin(mint, 1);
            if (coin) { metrics.api_null_recovered++; break; }
          }
          if (!coin){
            metrics.api_null_skip++;
            log("skip: api_null", mint);
            return;
          }
        }

        if (coin.is_currently_live !== true){
          metrics.not_live_skip++;
          log("skip: not_live (one-shot)", mint);
          return;
        }

        // === Live → измеряем окно ===
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

    // Запланировать единственный чек через 5s
    metrics.queued++;
    scheduleSingleCheck(mint);
  });
  ws.on("close", () => { log("WS closed → reconnect in 5s"); setTimeout(connectWS, 5000); });
  ws.on("error", (e) => { log("WS error:", e.message); });
}

// ===== Heartbeat =====
setInterval(() => {
  const secSinceWs = lastWsMsgAt ? Math.round((Date.now()-lastWsMsgAt)/1000) : -1;
  const apiNullPct = metrics.api_req ? ((metrics.api_null_skip / Math.max(1, metrics.api_req)) * 100).toFixed(1) : "0.0";
  const avgReadyDelay = metrics.schedule_ready_count ? Math.round(metrics.schedule_ready_delay_ms_sum / metrics.schedule_ready_count) : 0;
  log(
    "[stats]",
    "queued="+metrics.queued,
    "active="+activeWorkers,
    "stack_delayed="+delayedChecks.length,
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
    "api_null="+metrics.api_null_skip+`(${apiNullPct}%)`,
    "not_live="+metrics.not_live_skip,
    "miss="+metrics.threshold_miss,
    "| avgReadyDelayMs="+avgReadyDelay
  );
}, HEARTBEAT_MS);

// ===== Start =====
log("Worker starting…",
  "| THR="+VIEWERS_THRESHOLD,
  "| WINDOW="+MEASURE_WINDOW_MS+"ms",
  "| RECHECKS="+RECHECKS+"@"+RECHECK_STEP_MS+"ms",
  "| FIRST_CHECK_DELAY="+FIRST_CHECK_DELAY_MS+"ms",
  "| CONC="+MAX_CONCURRENCY,
  "| RPS="+GLOBAL_RPS,
  "| oneShot="+STRICT_ONE_SHOT,
  "| apiOnly="+API_VIEWERS_ONLY,
  "| apiNullRescue="+API_NULL_RETRIES+"@"+API_NULL_STEP_MS+"ms"
);
connectWS();
workerLoop();

// ===== Graceful =====
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
