// index.js — v9.0.0 (API-first, one-shot, 15s window, parallel, global throttle)
// Без браузера. Берём viewers из API: coins/{mint}.num_participants.
// Параметры — через ENV (см. ниже).

import process from "process";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ========= ENV / CONFIG ========= */
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data";
const API = process.env.PUMP_API || "https://frontend-api-v3.pump.fun";

// Telegram (можно пустыми — тогда просто не шлём)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

// Порог и окно измерения
const VIEWERS_THRESHOLD = int("VIEWERS_THRESHOLD", 30);       // минимум зрителей
const MEASURE_WINDOW_MS = int("MEASURE_WINDOW_MS", 15_000);   // окно 15 сек
const RECHECKS = int("RECHECKS", 3);                          // попыток в окне
const RECHECK_STEP_MS = int("RECHECK_STEP_MS", 5_000);        // шаг между попытками

// Параллельность и троттлинг API
const MAX_CONCURRENCY = int("MAX_CONCURRENCY", 8);            // параллельных задач
const GLOBAL_RPS = num("GLOBAL_RPS", 2);                       // общий лимит rps
const JITTER_MS = int("JITTER_MS", 150);                      // случайный +/- к задержкам

// Дедупликация: не тревожим один и тот же mint
const DEDUP_TTL_MS = int("DEDUP_TTL_MS", 10 * 60_000);        // 10 минут

// Флаги поведения
const STRICT_ONE_SHOT = bool("STRICT_ONE_SHOT", true);        // не хранить не-live
const API_VIEWERS_ONLY = bool("API_VIEWERS_ONLY", true);      // только API (без браузера)

// Логи/метрики
const HEARTBEAT_MS = int("HEARTBEAT_MS", 60_000);

// ---- helpers env
function int(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function num(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function bool(name, def) { const v = (process.env[name] || "").trim().toLowerCase(); if (v === "true") return true; if (v === "false") return false; return def; }
function log(...a){ console.log(new Date().toISOString(), ...a); }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

/* ========= STATE ========= */
let ws;
let lastWsMsgAt = 0;
const metrics = {
  api_req: 0, api_ok: 0, api_retry: 0, api_429: 0, api_other: 0,
  queued: 0, started: 0, done: 0, skipped: 0, alerted: 0,
  dedup_skip: 0, not_live_skip: 0, socials_skip: 0, threshold_miss: 0
};

// дедуп по mint
const recently = new Map(); // mint -> timestamp
function seenRecently(mint){
  const t = recently.get(mint);
  if (!t) return false;
  if (Date.now() - t > DEDUP_TTL_MS) { recently.delete(mint); return false; }
  return true;
}
function markSeen(mint){ recently.set(mint, Date.now()); }

// входная очередь live-кандидатов (после первичной проверки API)
const stack = []; // LIFO
let activeTasks = 0;

/* ========= Глобальный троттлер (RPS) ========= */
// простой "следующее доступное время"
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS))); // напр., 2 rps => 500ms
let nextAllowedAt = 0;
// временное понижение rps после 429
let penaltyUntil = 0;

async function throttleApi(){
  const now = Date.now();
  // если в пенальти — удлиним паузу
  const currentGap = (now < penaltyUntil) ? Math.max(minGapMs, 1000) : minGapMs;
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  const jitter = (Math.random()*2 - 1) * JITTER_MS;
  nextAllowedAt = Date.now() + currentGap + Math.max(-JITTER_MS, Math.min(JITTER_MS, jitter));
}

/* ========= API ========= */
async function fetchCoin(mint, maxRetries=2){
  const url = `${API}/coins/${mint}`;
  for (let attempt=0; attempt<=maxRetries; attempt++){
    try{
      await throttleApi();
      metrics.api_req++;
      const r = await fetch(url, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pump-watcher/9.0.0"
        }
      });
      if (r.status === 429){
        metrics.api_429++;
        // пенальти: 30с осторожности
        penaltyUntil = Date.now() + 30_000;
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
    } catch(e){
      if (attempt < maxRetries){
        metrics.api_retry++;
        await sleep(400 * (attempt+1));
        continue;
      }
      return null;
    }
  }
}

/* ========= Соцсети есть? ========= */
function hasAnySocial(coin){
  return !!(coin?.website || coin?.twitter || coin?.telegram || coin?.discord);
}

/* ========= Telegram ========= */
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
  }catch(e){ log("telegram error:", e.message); }
}

/* ========= Форматирование ========= */
function fmt(n){
  try{ return Number(n).toLocaleString("en-US"); }catch{ return String(n); }
}

/* ========= Алёрт ========= */
async function alertLive(mint, coin, viewers, source="api"){
  const title = `${coin.name || ""} (${coin.symbol || ""})`.trim();
  const socials = [];
  if (coin?.website) socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter) socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord) socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);

  const msg = [
    `🎥 <b>LIVE START</b> | ${title}`,
    `Mint: <code>${mint}</code>`,
    `👁 Viewers: ${fmt(viewers)} (source: ${source})`,
    `💰 Market Cap (USD): ${typeof coin.usd_market_cap==="number" ? "$"+fmt(coin.usd_market_cap) : "n/a"}`,
    `🔗 Axiom: https://axiom.trade/t/${mint}`,
    socials.length ? socials.join("\n") : null
  ].filter(Boolean).join("\n");

  await sendTG(msg, coin?.image_uri || null);
  metrics.alerted++;
  log("ALERT sent |", title, "| viewers:", viewers, "| source:", source);
}

/* ========= Измерение 15с (API-first) ========= */
async function measureWindow(mint, coin){
  const attempts = Math.max(1, RECHECKS);
  const step = Math.max(200, RECHECK_STEP_MS);
  const t0 = Date.now();

  for (let i=0; i<attempts; i++){
    if (Date.now() - t0 > MEASURE_WINDOW_MS) break;
    const c = await fetchCoin(mint, 1);
    if (!c || c.is_currently_live !== true){
      // если ушёл из live во время окна — сразу скип
      return { ok:false, reason:"left_live" };
    }
    const v = (typeof c.num_participants === "number") ? c.num_participants : null;
    log(`probe ${i+1}/${attempts} | viewers=${v} | threshold=${VIEWERS_THRESHOLD}`);
    if (v !== null && v >= VIEWERS_THRESHOLD){
      return { ok:true, viewers:v, source:"api" };
    }
    // ждём следующий тик, но не выходя за окно
    const nextPlanned = t0 + Math.min(MEASURE_WINDOW_MS, (i+1)*step);
    const sleepMs = Math.max(0, nextPlanned - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return { ok:false, reason:"threshold_not_reached" };
}

/* ========= Подача задач и пул воркеров ========= */
function pushTask(task){ stack.push(task); metrics.queued++; }
function popTask(){ return stack.pop(); }

async function workerLoop(){
  while (true){
    if (activeTasks >= MAX_CONCURRENCY || stack.length === 0){ await sleep(80); continue; }
    const job = popTask();
    if (!job) { await sleep(20); continue; }

    activeTasks++;
    (async () => {
      try{
        metrics.started++;
        const { mint, name, symbol } = job;

        // первичная проверка (на входе), one-shot
        const coin = await fetchCoin(mint, 2);
        if (!coin){
          metrics.skipped++; log("skip: api_null", mint); return;
        }
        if (coin.is_currently_live !== true){
          metrics.not_live_skip++; log("skip: not_live", mint); return;
        }
        if (!hasAnySocial(coin)){
          metrics.socials_skip++; log("skip: no_socials", mint); return;
        }

        // 15с окно
        const res = await measureWindow(mint, coin);
        if (res.ok){
          await alertLive(mint, coin, res.viewers, res.source);
        } else {
          metrics.threshold_miss++;
          log("miss threshold:", mint, "| reason:", res.reason);
        }
      } catch(e){
        log("task error:", e.message);
      } finally {
        metrics.done++;
        activeTasks--;
      }
    })();
  }
}

/* ========= WebSocket intake ========= */
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

    const name = msg?.name || msg?.tokenName || "";
    const symbol = msg?.symbol || msg?.ticker || "";
    // В нашем режиме one-shot мы не «ждём потом». Сразу кидаем в пул проверку.
    pushTask({ mint, name, symbol });
  });
  ws.on("close", () => { log("WS closed → reconnect in 5s"); setTimeout(connectWS, 5000); });
  ws.on("error", (e) => { log("WS error:", e.message); });
}

/* ========= Heartbeat ========= */
setInterval(() => {
  const secSinceWs = lastWsMsgAt ? Math.round((Date.now()-lastWsMsgAt)/1000) : -1;
  log(
    "[stats]",
    "queued="+metrics.queued,
    "active="+activeTasks,
    "stack="+stack.length,
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
    "not_live="+metrics.not_live_skip,
    "no_socials="+metrics.socials_skip,
    "miss="+metrics.threshold_miss
  );
}, HEARTBEAT_MS);

/* ========= Start ========= */
log("Worker starting…",
  "| THR="+VIEWERS_THRESHOLD,
  "| WINDOW="+MEASURE_WINDOW_MS+"ms",
  "| RECHECKS="+RECHECKS+"@"+RECHECK_STEP_MS+"ms",
  "| CONC="+MAX_CONCURRENCY,
  "| RPS="+GLOBAL_RPS,
  "| oneShot="+STRICT_ONE_SHOT,
  "| apiOnly="+API_VIEWERS_ONLY
);
connectWS();
workerLoop();

/* ========= graceful ========= */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
