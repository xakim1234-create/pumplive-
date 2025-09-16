// zero-miss live catcher — v10.4.1 (unconditional final)
// Ступени: T0+5s → T0+10s → T0+15s → ВСЕГДА финал T0+45s
// Цель: не пропускать поздние старты / флапы API.

import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ================== CONFIG ================== */

const WS_URL = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API    = envS("API",          "https://frontend-api-v3.pump.fun");

const VIEWERS_THRESHOLD      = envI("VIEWERS_THRESHOLD", 1);

const FIRST_CHECK_DELAY_MS   = envI("FIRST_CHECK_DELAY_MS",  5000);
const SECOND_CHECK_DELAY_MS  = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS   = envI("THIRD_CHECK_DELAY_MS",  15000);
const FINAL_CHECK_DELAY_MS   = envI("FINAL_CHECK_DELAY_MS",  45000); // безусловный финал

const QUICK_ATTEMPTS         = envI("QUICK_ATTEMPTS", 3);     // попыток в каждом слоте
const QUICK_STEP_MS          = envI("QUICK_STEP_MS", 700);    // пауза между попытками

const GLOBAL_RPS             = envN("GLOBAL_RPS", 3);         // общий рейт-лимит
const JITTER_MS              = envI("JITTER_MS", 200);        // рандомный джиттер
const PENALTY_429_MS         = envI("PENALTY_429_MS", 45000); // пауза после 429

const DEDUP_TTL_MS           = envI("DEDUP_TTL_MS", 600000);  // 10 мин: грубая дедупликация
const WS_BUMP_WINDOW_MS      = envI("WS_BUMP_WINDOW_MS", 60000);

const HEARTBEAT_MS           = envI("HEARTBEAT_MS", 30000);

/* ================== HELPERS ================== */

function envI(name, def){ const v = parseInt(process.env[name]||"", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def){ const v = Number(process.env[name]);          return Number.isFinite(v) ? v : def; }
function envS(name, def){ const v = (process.env[name]||"").trim();     return v || def; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(...a){ console.log(new Date().toISOString(), ...a); }
function now(){ return Date.now(); }

/* ================== METRICS ================== */

const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_429:0, api_http:0, api_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_new:0, jobs_done:0, finals:0
};

/* ================== RATE LIMITER ================== */

let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntilTs = 0;

async function throttle(){
  const t = now();
  if (t < nextAllowedAt) await sleep(nextAllowedAt - t);
  const baseGap = Math.max(minGapMs, (t < penaltyUntilTs ? 1000 : minGapMs));
  const jitter  = Math.round((Math.random()*2 - 1) * JITTER_MS);
  nextAllowedAt = now() + baseGap + jitter;
}

/* ================== FETCH COIN (ROBUST) ================== */

async function fetchCoin(mint){
  // cache-busters, чтобы ловить свежак и не упираться в “пустые/html”
  const url = `${API}/coins/${encodeURIComponent(mint)}?_=${Date.now()}&n=${Math.random().toString(36).slice(2,8)}`;
  try{
    await throttle();
    metrics.api_req++;

    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
        "user-agent": "pumplive/10.4.1-zero-miss"
      }
    });

    if (r.status === 429){
      metrics.api_429++;
      penaltyUntilTs = now() + PENALTY_429_MS;
      return { ok:false, kind:"429", status:429 };
    }
    if (!r.ok){
      metrics.api_http++;
      // типичные CF: 530/522/523/525/526/502/503
      return { ok:false, kind:"http", status:r.status };
    }

    const text = await r.text();
    if (!text || !text.trim()){
      metrics.api_empty++;
      return { ok:false, kind:"empty" };
    }
    if (text.trim().startsWith("<")){
      metrics.api_html++;
      return { ok:false, kind:"html" };
    }
    try{
      const json = JSON.parse(text);
      metrics.api_ok++;
      return { ok:true, data:json };
    }catch(e){
      metrics.api_parse++;
      return { ok:false, kind:"parse", msg:e.message };
    }
  }catch(e){
    metrics.api_throw++;
    return { ok:false, kind:"throw", msg:e.message };
  }
}

/* ================== DECISION ================== */

function asNum(v){ return (typeof v === "number" && Number.isFinite(v)) ? v : null; }

function extractViewers(c){
  const cand = [
    c?.num_participants, c?.viewers, c?.num_viewers, c?.live_viewers,
    c?.participants, c?.unique_viewers, c?.room?.viewers
  ];
  for (const x of cand){
    const n = asNum(x);
    if (n !== null) return n;
  }
  return null;
}

function decideFromCoin(c){
  const viewers  = extractViewers(c);
  const liveFlag = (c?.is_currently_live === true) || (c?.inferred_live === true);

  if (liveFlag || (viewers !== null && viewers >= VIEWERS_THRESHOLD)){
    metrics.decide_live++;
    return { state:"live", viewers, liveFlag, reason: liveFlag ? "flag" : "viewers" };
  }

  const negativeFlags = (c?.is_currently_live === false) &&
                        (c?.inferred_live === false || typeof c?.inferred_live === "undefined");

  if (negativeFlags && (viewers === 0 || viewers === null)){
    metrics.decide_not_live++;
    return { state:"not_live", viewers, liveFlag:false, reason:"clean-false" };
  }

  metrics.decide_unknown++;
  return { state:"unknown", viewers, liveFlag: !!liveFlag, reason:"ambiguous" };
}

/* ================== JOBS / SCHEDULER ================== */

const jobs = new Map();     // mint -> Job
const recent = new Map();   // mint -> ts (грубая дедупликация)

function markRecent(m){ recent.set(m, now()); }
function seenRecently(m){
  const t = recent.get(m);
  if (!t) return false;
  if (now() - t > DEDUP_TTL_MS){ recent.delete(m); return false; }
  return true;
}

function newJob(mint){
  const j = {
    mint,
    t0: now(),
    timeouts: new Set(),
    liveHit: false,
    seenUnknown: 0,
    goodFalse: 0,
    finalScheduled: false,
    closed: false
  };
  jobs.set(mint, j);
  metrics.jobs_new++;
  return j;
}

function clearJob(j){
  j.closed = true;
  for (const id of j.timeouts) clearTimeout(id);
  j.timeouts.clear();
  jobs.delete(j.mint);
  metrics.jobs_done++;
}

function schedule(j, label, atMs, fn){
  const delay = Math.max(0, atMs - now());
  const id = setTimeout(async () => {
    j.timeouts.delete(id);
    if (j.closed) return;
    await fn(j, label);
  }, delay);
  j.timeouts.add(id);
}

function scheduleFinal(j, reason="always"){
  if (j.finalScheduled) return;
  j.finalScheduled = true;
  metrics.finals++;

  // финал через FINAL_CHECK_DELAY_MS (+джиттер) и с учётом активного 429-пенальти
  const base   = FINAL_CHECK_DELAY_MS;
  const jitter = Math.round(Math.random() * JITTER_MS);
  let delay    = base + jitter;
  const nowTs  = now();
  if (nowTs < penaltyUntilTs) delay += (penaltyUntilTs - nowTs);

  log(`↪️  schedule FINAL | ${j.mint} | reason=${reason} goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
  schedule(j, "final", j.t0 + delay, runFinal);
}

/* ================== SLOT PROBE ================== */

async function slotProbe(j, label){
  // Внутри слота несколько коротких попыток — пробиваем HTML/empty/CF
  let localLive = false;
  let localUnknown = 0;
  let localFalse = 0;

  for (let i=0; i<QUICK_ATTEMPTS; i++){
    const r = await fetchCoin(j.mint);

    if (!r.ok){
      localUnknown++;
      if (r.kind === "429"){
        log(`❌ fetch error: HTTP 429 | mint: ${j.mint} (penalty ${PENALTY_429_MS}ms)`);
      }else if (r.kind === "http"){
        log(`❌ fetch error: HTTP ${r.status} | mint: ${j.mint}`);
      }else{
        log(`❌ fetch error: ${r.kind}${r.msg ? " "+r.msg : ""} | mint: ${j.mint}`);
      }
    }else{
      const coin = r.data || {};
      const { state, viewers, liveFlag, reason } = decideFromCoin(coin);

      if (state === "live"){
        const name = coin?.name || "";
        const symbol = coin?.symbol || "";
        log(`🔥 LIVE | ${j.mint} | ${symbol ? symbol+" " : ""}(${name || "no-name"}) | viewers=${viewers ?? "n/a"} | reason=${reason}${liveFlag?"/flag":""}`);
        j.liveHit = true;
        localLive = true;
        break;
      }else if (state === "unknown"){
        localUnknown++;
      }else{
        localFalse++;
        log(`… not live | ${j.mint} | slot=${label} | viewers=${viewers ?? "n/a"} | is_currently_live=false`);
      }
    }

    if (localLive) break;
    if (i < QUICK_ATTEMPTS-1) await sleep(QUICK_STEP_MS);
  }

  j.seenUnknown += localUnknown;
  j.goodFalse   += localFalse;
  return { localLive, localUnknown, localFalse };
}

/* ================== STAGES ================== */

async function runStage(j, stage){
  if (j.closed) return;

  const { localLive } = await slotProbe(j, stage);
  if (j.closed) return;
  if (j.liveHit || localLive){ clearJob(j); return; }

  // Планирование ступеней
  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
    return;
  }
  if (stage === "second"){
    schedule(j, "third", j.t0 + THIRD_CHECK_DELAY_MS, runStage);
    return;
  }
  if (stage === "third"){
    // БЕЗУСЛОВНЫЙ ФИНАЛ — всегда ставим финальный контроль
    scheduleFinal(j, "always");
    return;
  }
  if (stage === "bump"){
    // Быстрый добой по сигналу из WS. Основные таймеры уже стоят — ничего не меняем.
    return;
  }
}

async function runFinal(j){
  if (j.closed) return;

  const { localLive } = await slotProbe(j, "final");
  if (j.closed) return;

  if (j.liveHit || localLive){
    clearJob(j);
    return;
  }

  // Если и в финале не зажглось — вычищаем.
  log(`🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
  clearJob(j);
}

/* ================== WS INGEST ================== */

function ensureJobFromWS(mint){
  metrics.ws_events++;
  if (!mint) return;

  const existing = jobs.get(mint);
  const ts = now();

  if (!existing){
    if (!seenRecently(mint)) markRecent(mint);
    const j = newJob(mint);
    schedule(j, "first", j.t0 + FIRST_CHECK_DELAY_MS, runStage);
    return;
  }

  // дубликат из WS в первые 60с → быстрый bump
  if (!existing.closed && !existing.liveHit && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
    metrics.ws_bumps++;
    schedule(existing, "bump", ts + 1, runStage);
  }else{
    metrics.ws_dups++;
  }
}

/* ================== WEBSOCKET ================== */

let ws;
function connectWS(){
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log(`✅ WS connected: ${WS_URL}`);
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    log("📡 Subscribed: subscribeNewToken");
  });

  ws.on("message", (raw) => {
    let msg = null;
    try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (mint) ensureJobFromWS(mint);
  });

  ws.on("close", () => {
    log("WS closed → reconnect in 3s");
    setTimeout(connectWS, 3000);
  });

  ws.on("error", (e) => {
    log("WS error:", e?.message || e);
  });
}

/* ================== HEARTBEAT ================== */

setInterval(() => {
  log(
    `[stats] active=${jobs.size}`,
    `api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw}`,
    `decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}`,
    `ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}`,
    `jobs: new=${metrics.jobs_new} done=${metrics.jobs_done} finals=${metrics.finals}`
  );
}, HEARTBEAT_MS);

/* ================== START ================== */

log(
  "Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS
);

connectWS();

/* ================== Graceful ================== */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT",  ()=>process.exit(0));
