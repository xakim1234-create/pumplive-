// zero-miss live catcher — v10.5.0
// Ступени: T0+5s → T0+10s → T0+15s → ВСЕГДА финал T0+45s
// + Стабилизация: после первого LIVE проверяем ещё 30s по 5s-таку (по умолчанию)

// ================== DEPS ==================
import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";

// ================== ENV ===================
function envI(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }

const WS_URL                  = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API                     = envS("PUMP_API", "https://frontend-api-v3.pump.fun");

const VIEWERS_THRESHOLD       = envI("VIEWERS_THRESHOLD", 1);

const FIRST_CHECK_DELAY_MS    = envI("FIRST_CHECK_DELAY_MS", 5000);
const SECOND_CHECK_DELAY_MS   = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS    = envI("THIRD_CHECK_DELAY_MS", 15000);
const FINAL_CHECK_DELAY_MS    = envI("FINAL_CHECK_DELAY_MS", 45000);

const ALWAYS_FINAL            = envI("ALWAYS_FINAL", 1); // 1 = всегда ставим финал

const QUICK_ATTEMPTS          = envI("QUICK_ATTEMPTS", 3);
const QUICK_STEP_MS           = envI("QUICK_STEP_MS", 700);

const GLOBAL_RPS              = envN("GLOBAL_RPS", 3);
const JITTER_MS               = envI("JITTER_MS", 120);
const PENALTY_429_MS          = envI("PENALTY_429_MS", 30000);

const DEDUP_TTL_MS            = envI("DEDUP_TTL_MS", 600000);  // 10 минут
const WS_BUMP_WINDOW_MS       = envI("WS_BUMP_WINDOW_MS", 60000);
const HEARTBEAT_MS            = envI("HEARTBEAT_MS", 30000);

// Параметры стабилизации
const STABLE_WINDOW_MS        = envI("STABLE_WINDOW_MS", 30000); // окно 30s
const STABLE_TICK_MS          = envI("STABLE_TICK_MS", 5000);    // шаг 5s
const STABLE_MIN_OK           = envI("STABLE_MIN_OK", 4);        // минимум live-тиков из окна
const STABLE_ABORT_CONSEC_FALSE = envI("STABLE_ABORT_CONSEC_FALSE", 2); // 2 подряд «чистых not_live» = фейл

// ================== HELPERS ==================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ================== METRICS ==================
const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_429:0, api_http:0, api_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_created:0, jobs_finished:0, finals:0,
  stabilize_started:0, stabilize_passed:0, stabilize_failed:0
};

// ================== RATE LIMITER ==================
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttle(){
  const t = now();
  const underPenalty = t < penaltyUntil;
  const gap = underPenalty ? Math.max(1000, minGapMs) : minGapMs;
  if (t < nextAllowedAt) await sleep(nextAllowedAt - t);
  const jitter = Math.max(-JITTER_MS, Math.min(JITTER_MS, (Math.random()*2 - 1) * JITTER_MS));
  nextAllowedAt = now() + gap + jitter;
}

// ================== FETCH COIN (ROBUST) ==================
async function fetchCoin(mint){
  const url = `${API}/coins/${encodeURIComponent(mint)}?_=${Date.now()}&n=${Math.random().toString(36).slice(2,8)}`;
  try{
    await throttle();
    metrics.api_req++;
    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
        "user-agent": "pumplive/10.5.0"
      }
    });

    if (r.status === 429){
      metrics.api_429++;
      penaltyUntil = now() + PENALTY_429_MS;
      return { ok:false, kind:"429", status:r.status };
    }
    if (!r.ok){
      metrics.api_http++;
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

// ================== DECISION ==================
const asNum = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;

function extractViewers(c){
  const candidates = [
    c?.num_participants, c?.viewers, c?.num_viewers, c?.live_viewers,
    c?.participants, c?.unique_viewers, c?.room?.viewers
  ];
  for (const x of candidates){
    const n = asNum(x);
    if (n !== null) return n;
  }
  return null;
}

function decideFromCoin(c){
  const viewers = extractViewers(c);
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

// ================== JOBS / SCHEDULER ==================
const jobs = new Map();      // mint -> Job
const recently = new Map();  // mint -> ts (грубая дедупликация)

function markRecent(mint){ recently.set(mint, now()); }
function seenRecently(mint){
  const t = recently.get(mint);
  if (!t) return false;
  if (now() - t > DEDUP_TTL_MS){ recently.delete(mint); return false; }
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
    closed: false,
    stabilize: null // появится объект при входе в фазу стабилизации
  };
  jobs.set(mint, j);
  metrics.jobs_created++;
  return j;
}

function clearJob(j){
  j.closed = true;
  for (const id of j.timeouts) clearTimeout(id);
  j.timeouts.clear();
  jobs.delete(j.mint);
  metrics.jobs_finished++;
}

function cancelAllTimeouts(j){
  for (const id of j.timeouts) clearTimeout(id);
  j.timeouts.clear();
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

// ======= Слот: несколько быстрых попыток =======
async function slotProbe(j, label){
  let localLive = false;
  let localUnknown = 0;
  let localFalse = 0;

  for (let i=0; i<QUICK_ATTEMPTS; i++){
    const r = await fetchCoin(j.mint);
    if (!r.ok){
      localUnknown++;
      if (r.kind === "429"){
        log(`❌ fetch error: HTTP 429 | mint: ${j.mint} (penalty ${PENALTY_429_MS}ms)`);
      } else if (r.kind === "html" || r.kind === "empty" || r.kind === "http" || r.kind === "parse") {
        log(`❌ fetch error: ${r.kind}${r.status ? " "+r.status:""} | mint: ${j.mint}`);
      } else {
        log(`❌ fetch error: ${r.kind}${r.msg? " "+r.msg:""} | mint: ${j.mint}`);
      }
    } else {
      const coin = r.data || {};
      const { state, viewers, liveFlag, reason } = decideFromCoin(coin);
      if (state === "live"){
        const name = coin?.name || "no-name";
        const symbol = coin?.symbol ? `${coin.symbol} ` : "";
        log(`🔥 LIVE | ${j.mint} | ${symbol}(${name}) | viewers=${viewers ?? "n/a"} | reason=${reason}${liveFlag?"/flag":""}`);
        j.liveHit = true;
        localLive = true;

        // стартуем стабилизацию, если еще не в ней
        if (!j.stabilize){
          startStabilize(j);
        }
        break;
      } else if (state === "unknown"){
        localUnknown++;
      } else {
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

// ======= Основные стадии =======
async function runStage(j, stage){
  if (j.closed) return;

  // если уже идёт стабилизация — слоты игнорим
  if (j.stabilize) return;

  const { localLive } = await slotProbe(j, stage);
  if (j.closed) return;

  // если стартовала стабилизация — дальше слоты не планируем
  if (j.stabilize) return;

  if (localLive || j.liveHit){
    // live поймали, но стабилизацию уже стартанули в slotProbe
    return;
  }

  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  } else if (stage === "second"){
    schedule(j, "third", j.t0 + THIRD_CHECK_DELAY_MS, runStage);
  } else if (stage === "third"){
    // ВСЕГДА ставим финал (zero-miss)
    metrics.finals++;
    log(`↪️  schedule FINAL | ${j.mint} | reason=always goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
    schedule(j, "final", j.t0 + FINAL_CHECK_DELAY_MS, runFinal);
  }
}

async function runFinal(j){
  if (j.closed) return;
  if (j.stabilize) return; // если уже стабилизация — финал не нужен

  const { localLive } = await slotProbe(j, "final");
  if (j.closed) return;

  if (j.stabilize) return; // стабилизация могла стартануть внутри slotProbe

  if (localLive || j.liveHit){
    // стабилизацию уже запустили в slotProbe
    return;
  }
  log(`🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
  clearJob(j);
}

// ================== СТАБИЛИЗАЦИЯ 30s ==================
function startStabilize(j){
  cancelAllTimeouts(j); // отрубим все слоты/финалы — управляем дальше сами
  const ticksTotal = Math.max(1, Math.ceil(STABLE_WINDOW_MS / STABLE_TICK_MS));

  j.stabilize = {
    startedAt: now(),
    ticksDone: 0,
    ticksTotal,
    okLive: 0,
    unknown: 0,
    cleanFalse: 0,
    consecFalse: 0,
    lastState: "live"
  };
  metrics.stabilize_started++;
  log(`🎯 LIVE detected — start ${Math.round(STABLE_WINDOW_MS/1000)}s stabilization | mint=${j.mint}`);

  scheduleStabilizeTick(j, now() + 1); // первый тик почти сразу
}

function scheduleStabilizeTick(j, atMs){
  const id = setTimeout(async () => {
    j.timeouts.delete(id);
    if (j.closed || !j.stabilize) return;
    await doStabilizeTick(j);
  }, Math.max(0, atMs - now()));
  j.timeouts.add(id);
}

async function doStabilizeTick(j){
  if (j.closed || !j.stabilize) return;
  const s = j.stabilize;

  // одна попытка на тик (внутри fetchCoin уже троттлинг/пенальти)
  const r = await fetchCoin(j.mint);
  let state = "unknown";
  let viewers = "n/a";
  let reason = "ambiguous";

  if (!r.ok){
    s.unknown++;
    if (r.kind === "429"){
      log(`⏱️ stabilize ${s.ticksDone+1}/${s.ticksTotal} | state=unknown(429) | mint=${j.mint}`);
    } else {
      log(`⏱️ stabilize ${s.ticksDone+1}/${s.ticksTotal} | state=unknown(${r.kind}) | mint=${j.mint}`);
    }
  } else {
    const coin = r.data || {};
    const d = decideFromCoin(coin);
    state = d.state;
    viewers = d.viewers ?? "n/a";
    reason = d.reason;

    if (state === "live"){
      s.okLive++;
      s.consecFalse = 0;
    } else if (state === "not_live"){
      s.cleanFalse++;
      s.consecFalse++;
    } else {
      s.unknown++;
      s.consecFalse = 0;
    }
    log(`⏱️ stabilize ${s.ticksDone+1}/${s.ticksTotal} | state=${state} | viewers=${viewers} | reason=${reason}`);
  }

  s.lastState = state;
  s.ticksDone++;

  // ранний фейл: подряд чистых not_live
  if (STABLE_ABORT_CONSEC_FALSE > 0 && s.consecFalse >= STABLE_ABORT_CONSEC_FALSE){
    metrics.stabilize_failed++;
    log(`⛔ unstable — ${s.consecFalse} clean not_live in a row | mint=${j.mint} | ok=${s.okLive} unknown=${s.unknown} false=${s.cleanFalse}`);
    clearJob(j);
    return;
  }

  // окончили окно
  if (s.ticksDone >= s.ticksTotal){
    const pass = (s.lastState === "live") || (s.okLive >= STABLE_MIN_OK);
    if (pass){
      metrics.stabilize_passed++;
      log(`✅ STABLE LIVE (${Math.round(STABLE_WINDOW_MS/1000)}s) | mint=${j.mint} | ok=${s.okLive} unknown=${s.unknown} false=${s.cleanFalse}`);
    } else {
      metrics.stabilize_failed++;
      log(`⛔ unstable — dropped before ${Math.round(STABLE_WINDOW_MS/1000)}s | mint=${j.mint} | ok=${s.okLive} unknown=${s.unknown} false=${s.cleanFalse}`);
    }
    clearJob(j);
    return;
  }

  // следующий тик
  scheduleStabilizeTick(j, now() + STABLE_TICK_MS);
}

// ================== WS ==================
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
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    ensureJobFromWS(mint);
  });
  ws.on("close", () => {
    log("WS closed → reconnect in 3s");
    setTimeout(connectWS, 3000);
  });
  ws.on("error", (e) => {
    log("WS error:", e?.message || e);
  });
}

function ensureJobFromWS(mint){
  metrics.ws_events++;
  if (!mint) return;

  const existing = jobs.get(mint);
  const ts = now();

  if (!existing){
    if (!seenRecently(mint)){
      markRecent(mint);
    }
    const j = newJob(mint);
    // первая ступень
    schedule(j, "first", j.t0 + FIRST_CHECK_DELAY_MS, runStage);
    return;
  }

  // Повтор WS-триггера: если рано и не стабилизация — быстрый bump
  if (!existing.closed && !existing.stabilize && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
    metrics.ws_bumps++;
    schedule(existing, "bump", ts + 1, runStage);
  } else {
    metrics.ws_dups++;
  }
}

// ================== HEARTBEAT ==================
setInterval(() => {
  const active = jobs.size;
  log(
    `[stats] active=${active}`,
    `api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw}`,
    `decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}`,
    `ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}`,
    `jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} finals=${metrics.finals}`,
    `stabilize: started=${metrics.stabilize_started} ok=${metrics.stabilize_passed} fail=${metrics.stabilize_failed}`
  );
}, HEARTBEAT_MS);

// ================== START ==================
log(
  "Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS,
  "| STABILIZE=", `${Math.round(STABLE_WINDOW_MS/1000)}s @ ${Math.round(STABLE_TICK_MS/1000)}s (minOK=${STABLE_MIN_OK}, abortConsecFalse=${STABLE_ABORT_CONSEC_FALSE})`
);

connectWS();

// ================== graceful ==================
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
