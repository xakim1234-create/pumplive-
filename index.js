// zero-miss live catcher — v11.0 (eligibility 30+ viewers window)
// Слоты: T0+5s → T0+10s → T0+15s → всегда финал @+45s (не пропускаем вообще)
// Новое: после ПЕРВОГО LIVE запускаем окно «годности» 30s c тиками каждые 5s:
// если хотя бы раз viewers >= ELIG_VIEWERS_MIN (по умолчанию 30) → токен годный.

// ---------- Imports ----------
import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";

// ---------- ENV helpers ----------
function envI(name, def) { const v = parseInt((process.env[name] || "").trim(), 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number((process.env[name] || "").trim()); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }
function now() { return Date.now(); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- Config ----------
const WS_URL = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API = envS("PUMP_API", envS("API", "https://frontend-api-v3.pump.fun"));

const VIEWERS_THRESHOLD       = envI("VIEWERS_THRESHOLD", 1);

const FIRST_CHECK_DELAY_MS    = envI("FIRST_CHECK_DELAY_MS", 5000);
const SECOND_CHECK_DELAY_MS   = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS    = envI("THIRD_CHECK_DELAY_MS", 15000);
const FINAL_CHECK_DELAY_MS    = envI("FINAL_CHECK_DELAY_MS", 45000); // всегда финальный контроль

const QUICK_ATTEMPTS          = envI("QUICK_ATTEMPTS", 3);
const QUICK_STEP_MS           = envI("QUICK_STEP_MS", 700);

const GLOBAL_RPS              = envN("GLOBAL_RPS", 3);
const JITTER_MS               = envI("JITTER_MS", 120);
const PENALTY_429_MS          = envI("PENALTY_429_MS", 45000);

const DEDUP_TTL_MS            = envI("DEDUP_TTL_MS", 600000);
const WS_BUMP_WINDOW_MS       = envI("WS_BUMP_WINDOW_MS", 60000);

const HEARTBEAT_MS            = envI("HEARTBEAT_MS", 30000);

// Новое — окно «годности» (eligibility) после первого LIVE
const ELIG_ENABLED            = envS("ELIG_ENABLED", "true") === "true";
const ELIG_VIEWERS_MIN        = envI("ELIG_VIEWERS_MIN", 30);
const ELIG_WINDOW_MS          = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS            = envI("ELIG_STEP_MS", 5000);
// 0 = достаточно одного попадания ≥ порога, >0 = нужно подряд N тиков ≥ порога
const ELIG_REQUIRE_CONSECUTIVE = envI("ELIG_REQUIRE_CONSECUTIVE", 0);

// Старая 30-с стабилизация — по умолчанию выключена
const STABILIZE_ENABLED       = envS("STABILIZE_ENABLED", "false") === "true";

// ---------- Metrics ----------
const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_http:0, api_429:0, api_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_created:0, jobs_finished:0, final_checks:0,
  elig_started:0, elig_ok:0, elig_fail:0,
  lat_live_ms: [],       // от WS-ивента до первого LIVE
  lat_elig_ms: []        // от первого LIVE до первого попадания ≥ ELIG_VIEWERS_MIN
};

function addLatency(arr, ms, cap=200000) { // мягкий кап, чтобы не раздувать память
  arr.push(ms);
  if (arr.length > 1000) arr.shift();
}
function pct(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const i = Math.max(0, Math.min(a.length-1, Math.floor((p/100)* (a.length-1))));
  return a[i];
}

// ---------- Rate limiter ----------
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttle(){
  const ts = now();
  const underPenalty = ts < penaltyUntil;
  const gap = underPenalty ? Math.max(1000, minGapMs) : minGapMs;
  if (ts < nextAllowedAt) await sleep(nextAllowedAt - ts);
  const jitter = Math.max(-JITTER_MS, Math.min(JITTER_MS, (Math.random()*2 - 1) * JITTER_MS));
  nextAllowedAt = now() + gap + jitter;
}

// ---------- Fetch coin (robust) ----------
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
        "user-agent": "pumplive/11.0-zero-miss"
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
    if (text.trim()[0] === "<"){
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

// ---------- Decide live/not-live ----------
function asNum(v){ return (typeof v === "number" && Number.isFinite(v)) ? v : null; }
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
  const negativeFlags = (c?.is_currently_live === false) && (c?.inferred_live === false || typeof c?.inferred_live === "undefined");
  if (negativeFlags && (viewers === 0 || viewers === null)){
    metrics.decide_not_live++;
    return { state:"not_live", viewers, liveFlag:false, reason:"clean-false" };
  }
  metrics.decide_unknown++;
  return { state:"unknown", viewers, liveFlag: !!liveFlag, reason:"ambiguous" };
}

// ---------- Jobs (slots + final) ----------
const jobs = new Map();       // mint -> Job
const recently = new Map();   // mint -> ts (грубая дедупликация)

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
    t0: now(),          // время первого WS-ивента
    timeouts: new Set(),
    liveHit: false,
    firstLiveAt: null,  // когда впервые увидели LIVE
    seenUnknown: 0,
    goodFalse: 0,
    closed: false
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
function schedule(j, label, atMs, fn){
  const delay = Math.max(0, atMs - now());
  const id = setTimeout(async () => {
    j.timeouts.delete(id);
    if (j.closed) return;
    await fn(j, label);
  }, delay);
  j.timeouts.add(id);
}

// ---------- Eligibility (30+ viewers window) ----------
const elig = new Map(); // mint -> EligJob

function startEligibility(j, firstViewers, reason){
  if (!ELIG_ENABLED) return;
  if (elig.has(j.mint)) return;

  metrics.elig_started++;
  const ej = {
    mint: j.mint,
    wsAt: j.t0,
    liveAt: j.firstLiveAt || now(),
    startedAt: now(),
    windowMs: ELIG_WINDOW_MS,
    stepMs: ELIG_STEP_MS,
    minViewers: ELIG_VIEWERS_MIN,
    requireConsec: Math.max(0, ELIG_REQUIRE_CONSECUTIVE),
    total: 0,
    valid: 0,
    err: 0,
    consec: 0,
    maxViewers: asNum(firstViewers) ?? 0,
    timer: null,
    closed: false
  };
  elig.set(j.mint, ej);

  log(`🎯 ELIG start 30s | ${j.mint} | thr=${ej.minViewers} | step=${Math.round(ej.stepMs/1000)}s`);

  const tick = async () => {
    if (ej.closed) return;
    const elapsed = now() - ej.startedAt;
    if (elapsed >= ej.windowMs){
      // завершение окна без успеха
      ej.closed = true;
      elig.delete(ej.mint);
      metrics.elig_fail++;
      const latLive = j.firstLiveAt ? (j.firstLiveAt - j.t0) : null;
      log(`🚫 NOT ELIGIBLE (<${ej.minViewers} за ${Math.round(ej.windowMs/1000)}s) | ${ej.mint} | max=${ej.maxViewers} | valid=${ej.valid}/${ej.total}${ej.err?` err=${ej.err}`:""}${latLive!==null?` | firstLIVE@+${(latLive/1000).toFixed(2)}s`: ""}`);
      return;
    }

    const r = await fetchCoin(ej.mint);
    if (!r.ok){
      ej.total++;
      ej.err++;
      // ошибки не ломают окно: пробуем дальше
      ej.timer = setTimeout(tick, ej.stepMs);
      return;
    }

    const coin = r.data || {};
    const v = extractViewers(coin);
    if (asNum(v) !== null) ej.maxViewers = Math.max(ej.maxViewers, v);
    const okNow = (asNum(v) !== null) && (v >= ej.minViewers);

    ej.total++;
    if (okNow){
      ej.valid++;
      ej.consec++;
      if (ej.requireConsec === 0 || ej.consec >= ej.requireConsec){
        // Успех
        ej.closed = true;
        elig.delete(ej.mint);
        metrics.elig_ok++;
        const hitAt = now();
        const latLive = j.firstLiveAt ? (j.firstLiveAt - j.t0) : null;            // WS → first LIVE
        const lat30  = j.firstLiveAt ? (hitAt - j.firstLiveAt) : (hitAt - ej.wsAt); // first LIVE → hit (или WS→hit fallback)
        if (latLive !== null) addLatency(metrics.lat_live_ms, latLive);
        addLatency(metrics.lat_elig_ms, lat30);

        const latStrLive = (latLive !== null) ? `+${(latLive/1000).toFixed(2)}s от WS` : "n/a";
        const latStrHit  = `+${(lat30/1000).toFixed(2)}s от LIVE`;
        log(`✅ ELIGIBLE (≥${ej.minViewers}) | ${ej.mint} | hit@${latStrHit} (${latStrLive}) | max=${ej.maxViewers} | samples=${ej.valid}/${ej.total}${ej.err?` err=${ej.err}`:""}`);
        return;
      }
    }else{
      ej.consec = 0;
    }
    ej.timer = setTimeout(tick, ej.stepMs);
  };

  // первый тик сразу (не ждём step)
  tick();
}

// (Опциональная) старая стабилизация "6/6 live 30s"
function stabilizeLive(j){
  if (!STABILIZE_ENABLED) return;
  const totalTicks = Math.ceil(30000 / 5000); // 6 тиков по 5с
  let ok=0, unk=0, fail=0, tick=0;
  const t = async () => {
    tick++;
    const r = await fetchCoin(j.mint);
    if (!r.ok){ unk++; }
    else {
      const coin = r.data || {};
      const d = decideFromCoin(coin);
      if (d.state === "live") ok++; else if (d.state === "unknown") unk++; else fail++;
    }
    log(`⏱️ stabilize ${tick}/${totalTicks} | state=${ok? "live":"?"} | viewers=${"n/a"} | reason=flag`);
    if (tick >= totalTicks){
      if (ok === totalTicks){
        log(`✅ STABLE LIVE (30s) | mint=${j.mint} | ok=${ok} unknown=${unk} false=${fail}`);
      }
      return;
    }
    setTimeout(t, 5000);
  };
  t();
}

// ---------- Slot probes ----------
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
      }else if (r.kind === "html" || r.kind === "empty" || r.kind === "http" || r.kind === "parse"){
        log(`❌ fetch error: ${r.kind}${r.status ? " "+r.status:""} | mint: ${j.mint}`);
      }else{
        log(`❌ fetch error: ${r.kind}${r.msg? " "+r.msg:""} | mint: ${j.mint}`);
      }
    }else{
      const coin = r.data || {};
      const { state, viewers, liveFlag, reason } = decideFromCoin(coin);
      if (state === "live"){
        const name = coin?.name || "no-name";
        const symbol = coin?.symbol || "";
        if (!j.firstLiveAt){
          j.firstLiveAt = now();
          const latLive = j.firstLiveAt - j.t0; // WS → first LIVE
          addLatency(metrics.lat_live_ms, latLive);
        }
        log(`🔥 LIVE | ${j.mint} | ${symbol ? symbol+" " : ""}(${name}) | v=${viewers ?? "n/a"} | reason=${reason}${liveFlag?"/flag":""} | +${((j.firstLiveAt - j.t0)/1000).toFixed(2)}s от WS → candidate`);
        j.liveHit = true;
        localLive = true;

        // Сразу запускаем Eligibility окно (ищем ≥ ELIG_VIEWERS_MIN в ближайшие 30s)
        startEligibility(j, viewers, reason);

        // Опциональная старая стабилизация
        stabilizeLive(j);
        break;
      }else if (state === "unknown"){
        localUnknown++;
      }else{
        localFalse++;
        log(`… not live | ${j.mint} | slot=${label} | viewers=${viewers ?? "n/a"} | is_currently_live=false`);
      }
    }
    if (i < QUICK_ATTEMPTS-1) await sleep(QUICK_STEP_MS);
  }

  j.seenUnknown += localUnknown;
  j.goodFalse   += localFalse;
  return { localLive, localUnknown, localFalse };
}

async function runStage(j, stage){
  if (j.closed) return;

  await slotProbe(j, stage);
  if (j.closed) return;

  if (j.liveHit){
    clearJob(j);
    return;
  }

  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  }else if (stage === "second"){
    schedule(j, "third",  j.t0 + THIRD_CHECK_DELAY_MS,  runStage);
  }else if (stage === "third"){
    // всегда ставим финал, чтобы «не пропускать вообще»
    metrics.final_checks++;
    log(`↪️  schedule FINAL | ${j.mint} | reason=always goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
    schedule(j, "final",  j.t0 + FINAL_CHECK_DELAY_MS,  runFinal);
  }
}

async function runFinal(j){
  if (j.closed) return;
  const { localLive } = await slotProbe(j, "final");
  if (j.closed) return;
  if (localLive || j.liveHit){
    clearJob(j);
    return;
  }
  log(`🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
  clearJob(j);
}

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

  // Bump внутри окна 60s — внеплановый быстрый проверочный слот (параллельно основным)
  if (!existing.liveHit && !existing.closed && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
    metrics.ws_bumps++;
    schedule(existing, "bump", ts + 1, runStage);
  } else {
    metrics.ws_dups++;
  }
}

// ---------- WebSocket ----------
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

// ---------- Heartbeat ----------
setInterval(() => {
  const p50_live = pct(metrics.lat_live_ms, 50);
  const p95_live = pct(metrics.lat_live_ms, 95);
  const p50_elig = pct(metrics.lat_elig_ms, 50);
  const p95_elig = pct(metrics.lat_elig_ms, 95);
  log(
    `[stats] active=${jobs.size} api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw}` +
    ` decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}` +
    ` ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}` +
    ` jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} finals=${metrics.final_checks}` +
    ` elig: started=${metrics.elig_started} ok=${metrics.elig_ok} fail=${metrics.elig_fail}` +
    ` | lat(LIVE) p50=${p50_live!==null?(p50_live/1000).toFixed(2)+"s":"n/a"} p95=${p95_live!==null?(p95_live/1000).toFixed(2)+"s":"n/a"}` +
    ` | lat(≥${ELIG_VIEWERS_MIN}) p50=${p50_elig!==null?(p50_elig/1000).toFixed(2)+"s":"n/a"} p95=${p95_elig!==null?(p95_elig/1000).toFixed(2)+"s":"n/a"}`
  );
}, HEARTBEAT_MS);

// ---------- Start ----------
log(
  "Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS
);
if (ELIG_ENABLED){
  log(`Eligibility window: ${Math.round(ELIG_WINDOW_MS/1000)}s | step=${Math.round(ELIG_STEP_MS/1000)}s | minViewers=${ELIG_VIEWERS_MIN} | consecutive=${ELIG_REQUIRE_CONSECUTIVE}`);
}
if (STABILIZE_ENABLED){
  log("Stabilize 30s: ENABLED (6 тиков по 5s)");
}

connectWS();

process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
