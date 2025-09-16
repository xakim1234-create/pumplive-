// zero-miss live catcher — v11.2 (no-miss + eligible>=30 + Telegram)
// Ступени LIVE-чека: T0+5s → +10s → +15s → (всегда) финал T0+45s
// Доп. фильтр: после первого LIVE — 30s окно по 5s; если viewers >= ELIG_VIEWERS — шлём в Telegram.

import process from "node:process";
import WebSocket from "ws";

/* ================== CONFIG ================== */

// WS / API
const WS_URL = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
// Поддержим и API, и PUMP_API (что бы ты ни задал в env – подхватим)
const API    = envS("API", envS("PUMP_API", "https://frontend-api-v3.pump.fun"));

// Дешёвый триггер LIVE (чтобы не пропускать)
const VIEWERS_THRESHOLD      = envI("VIEWERS_THRESHOLD", 1);
const FIRST_CHECK_DELAY_MS   = envI("FIRST_CHECK_DELAY_MS", 5000);
const SECOND_CHECK_DELAY_MS  = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS   = envI("THIRD_CHECK_DELAY_MS", 15000);
const FINAL_CHECK_DELAY_MS   = envI("FINAL_CHECK_DELAY_MS", 45000); // безусловный финал

// Внутрислотные быстрые попытки (пробиваем кеши/пустые ответы)
const QUICK_ATTEMPTS         = envI("QUICK_ATTEMPTS", 3);
const QUICK_STEP_MS          = envI("QUICK_STEP_MS", 700);

// Rate-limit и антибан
const GLOBAL_RPS             = envN("GLOBAL_RPS", 3);
const JITTER_MS              = envI("JITTER_MS", 120);
const PENALTY_AFTER_429_MS   = envI("PENALTY_AFTER_429_MS", 30000);

// Дедуп/повторы
const DEDUP_TTL_MS           = envI("DEDUP_TTL_MS", 20000);
const WS_BUMP_WINDOW_MS      = envI("WS_BUMP_WINDOW_MS", 60000);

// Статистика-лог раз в HEARTBEAT_MS
const HEARTBEAT_MS           = envI("HEARTBEAT_MS", 30000);

// Окно «нужных» лайвов (≥N зрителей за 30s)
const ELIG_VIEWERS           = envI("ELIG_VIEWERS", 30);
const ELIG_WINDOW_MS         = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS           = envI("ELIG_STEP_MS", 5000);

// Telegram (дефолты — твои; env-переменные TG_BOT_TOKEN / TG_CHAT_ID их перекроют)
const TG_BOT_TOKEN           = envS("TG_BOT_TOKEN", "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc");
const TG_CHAT_ID             = envS("TG_CHAT_ID", "-4857972467");
const TIMEZONE               = envS("TIMEZONE", "Europe/Moscow"); // локальное время в уведомлении
const TG_PARSE_MODE          = "HTML";

/* ================== HELPERS ================== */

function envI(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now   = () => Date.now();
function log(...a){ console.log(new Date().toISOString(), ...a); }

function asNum(v){ return (typeof v === "number" && Number.isFinite(v)) ? v : null; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

function escapeHtml(s=""){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll("\"","&quot;");
}
function fmtSec(ms){
  return (ms/1000).toFixed(2).replace(/\.00$/,"");
}
function localTimestamp(ts=Date.now()){
  try{
    const d  = new Date(ts);
    const t  = new Intl.DateTimeFormat("ru-RU", { timeZone: TIMEZONE, hour12:false, hour:"2-digit", minute:"2-digit", second:"2-digit"}).format(d);
    const dd = new Intl.DateTimeFormat("ru-RU", { timeZone: TIMEZONE, day:"2-digit", month:"2-digit", year:"numeric"}).format(d);
    return `${t} · ${dd} (${TIMEZONE})`;
  }catch{
    const d = new Date(ts);
    return d.toISOString();
  }
}

/* ================== METRICS ================== */

const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_429:0, api_http:0, api_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_created:0, jobs_finished:0, final_checks:0,
  elig_started:0, elig_ok:0, elig_fail:0
};

/* ================== RATE LIMITER ================== */

let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttle(){
  const t = now();
  const underPenalty = t < penaltyUntil;
  const gap = underPenalty ? Math.max(1000, minGapMs) : minGapMs;
  if (t < nextAllowedAt) await sleep(nextAllowedAt - t);
  const jitter = clamp((Math.random()*2 - 1) * JITTER_MS, -JITTER_MS, JITTER_MS);
  nextAllowedAt = now() + gap + jitter;
}

/* ================== FETCH COIN (ROBUST) ================== */

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
        "user-agent": "pumplive/11.2-zero-miss"
      }
    });

    if (r.status === 429){
      metrics.api_429++;
      penaltyUntil = now() + PENALTY_AFTER_429_MS;
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

/* ================== JOBS / SCHEDULER ================== */

const jobs = new Map();     // mint -> Job
const recently = new Map(); // mint -> ts

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
    t0: now(),            // когда пришёл WS
    wsTs: now(),
    stageTimers: new Set(),
    eligTimers: new Set(),
    liveHit: false,
    stageClosed: false,
    seenUnknown: 0,
    goodFalse: 0,
    closed: false,

    // тайминги
    liveAt: null,        // первый уверенный LIVE
    eligibleAt: null,    // первый проход ≥ELIG_VIEWERS

    // данные для алерта
    lastCoin: null,

    // окно «≥30 за 30s»
    elig: null           // { startedAt, step, samples, maxViewers, ok }
  };
  jobs.set(mint, j);
  metrics.jobs_created++;
  return j;
}

function clearTimers(set){
  for (const id of set) clearTimeout(id);
  set.clear();
}
function finalizeJob(j){
  if (j.closed) return;
  j.closed = true;
  clearTimers(j.stageTimers);
  clearTimers(j.eligTimers);
  jobs.delete(j.mint);
  metrics.jobs_finished++;
}

function scheduleTimer(set, atMs, fn){
  const delay = Math.max(0, atMs - now());
  const id = setTimeout(async () => {
    set.delete(id);
    await fn();
  }, delay);
  set.add(id);
  return id;
}

/* ================== SLOTS ================== */

async function slotProbe(j, label){
  let localLive = false;
  let localUnknown = 0;
  let localFalse = 0;

  for (let i=0; i<QUICK_ATTEMPTS; i++){
    const r = await fetchCoin(j.mint);
    if (!r.ok){
      localUnknown++;
      if (r.kind === "429"){
        log(`❌ fetch error: HTTP 429 | mint: ${j.mint} (penalty ${PENALTY_AFTER_429_MS}ms)`);
      }else{
        const suffix = r.status ? ` ${r.status}` : (r.msg ? ` ${r.msg}` : "");
        log(`❌ fetch error: ${r.kind}${suffix} | mint: ${j.mint}`);
      }
    }else{
      const coin = r.data || {};
      j.lastCoin = coin;
      const { state, viewers, liveFlag, reason } = decideFromCoin(coin);

      if (state === "live"){
        const name = coin?.name || "";
        const symbol = coin?.symbol || "";
        const vTag = liveFlag ? "flag" : reason;
        const vs = viewers ?? "n/a";
        const fromWsMs = now() - j.wsTs;
        if (!j.liveHit){
          j.liveHit = true;
          j.liveAt = now();
          // как только первый LIVE — закрываем слоты и запускаем критерий ≥30
          clearTimers(j.stageTimers);
          j.stageClosed = true;

          log(`🔥 LIVE | ${j.mint} | ${symbol ? symbol+" " : ""}(${name || "no-name"}) | v=${asNum(viewers) ?? 0} | reason=${reason}${liveFlag?"/flag":""} | +${fmtSec(fromWsMs)}s от WS → candidate`);
          startEligibility(j, asNum(viewers));
        }else{
          log(`🔥 LIVE | ${j.mint} | ${symbol ? symbol+" " : ""}(${name || "no-name"}) | v=${vs} | reason=${vTag}`);
        }
        localLive = true;
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

async function runStage(j, label){
  if (j.closed || j.stageClosed) return;

  await slotProbe(j, label);
  if (j.closed || j.stageClosed) return;

  if (label === "first"){
    scheduleTimer(j.stageTimers, j.t0 + SECOND_CHECK_DELAY_MS, () => runStage(j, "second"));
  }else if (label === "second"){
    scheduleTimer(j.stageTimers, j.t0 + THIRD_CHECK_DELAY_MS,  () => runStage(j, "third"));
  }else if (label === "third"){
    // всегда ставим финал (безусловный)
    metrics.final_checks++;
    log(`↪️  schedule FINAL | ${j.mint} | reason=always goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
    scheduleTimer(j.stageTimers, j.t0 + FINAL_CHECK_DELAY_MS, () => runFinal(j));
  }
}

async function runFinal(j){
  if (j.closed || j.stageClosed) return; // если уже live → финал не нужен
  await slotProbe(j, "final");
  if (j.closed || j.stageClosed) return;
  log(`🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
  finalizeJob(j);
}

/* ================== ELIGIBILITY: ≥N viewers за 30s ================== */

function startEligibility(j, firstViewers){
  if (j.elig) return; // уже идёт
  metrics.elig_started++;

  j.elig = {
    startedAt: now(),
    step: ELIG_STEP_MS,
    samples: 0,
    maxViewers: asNum(firstViewers) ?? 0,
    ok: false
  };

  log(`🎯 ELIG start 30s | ${j.mint} | thr=${ELIG_VIEWERS} | step=${Math.round(ELIG_STEP_MS/1000)}s`);
  const tick = async () => {
    if (j.closed || !j.elig) return;

    const r = await fetchCoin(j.mint);
    let viewers = null;
    if (r.ok){
      const coin = r.data || {};
      j.lastCoin = coin;
      viewers = extractViewers(coin);
      if (asNum(viewers) !== null) j.elig.maxViewers = Math.max(j.elig.maxViewers, viewers);
    }

    j.elig.samples++;

    if (asNum(viewers) !== null && viewers >= ELIG_VIEWERS){
      j.elig.ok = true;
      j.eligibleAt = now();
      const fromLive = j.eligibleAt - j.liveAt;
      const fromWs   = j.liveAt - j.wsTs;
      log(`✅ ELIGIBLE (≥${ELIG_VIEWERS}) | ${j.mint} | hit@+${fmtSec(fromLive)}s от LIVE (+${fmtSec(fromWs)}s от WS) | max=${j.elig.maxViewers} | samples=${j.elig.samples}/${Math.ceil(ELIG_WINDOW_MS/ELIG_STEP_MS)}`);
      metrics.elig_ok++;
      // шлём телегу
      await notifyTelegramEligible(j);
      // заканчиваем eligibility
      clearTimers(j.eligTimers);
      j.elig = null;
      finalizeJob(j);
      return;
    }

    // ещё есть время?
    const elapsed = now() - j.elig.startedAt;
    if (elapsed + j.elig.step <= ELIG_WINDOW_MS){
      scheduleTimer(j.eligTimers, now() + j.elig.step, tick);
    }else{
      // окно закончено — не прошёл
      const fromLive = now() - j.liveAt;
      log(`🚫 NOT ELIGIBLE (<${ELIG_VIEWERS} за 30s) | ${j.mint} | max=${j.elig.maxViewers} | valid=${j.elig.samples}/${Math.ceil(ELIG_WINDOW_MS/ELIG_STEP_MS)} | firstLIVE@+${fmtSec(fromLive)}s`);
      metrics.elig_fail++;
      clearTimers(j.eligTimers);
      j.elig = null;
      finalizeJob(j);
    }
  };

  // первый тик — через шаг
  scheduleTimer(j.eligTimers, now() + ELIG_STEP_MS, tick);
}

/* ================== TELEGRAM ================== */

async function notifyTelegramEligible(j){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return; // молча, если не настроено

  const coin = j.lastCoin || {};
  const name = coin?.name || "";
  const symbol = coin?.symbol || "";
  const website = coin?.website || coin?.site || "";
  const twitter = coin?.twitter || coin?.x || "";
  const coinId = coin?.id || coin?.coin_id || null;

  const tSend = localTimestamp();
  const ws2live = fmtSec(j.liveAt - j.wsTs);
  const live2elig = fmtSec(j.eligibleAt - j.liveAt);

  const peak = (j.elig && j.elig.maxViewers) ? j.elig.maxViewers : (extractViewers(coin) ?? "");
  const title = `🟢 <b>LIVE ≥${ELIG_VIEWERS}</b> | ${escapeHtml(name)}${symbol ? " ("+escapeHtml(symbol)+")" : ""}`;

  let text = `${title}\n` +
             `🕒 ${tSend}\n` +
             `<b>Mint (CA):</b> <code>${j.mint}</code>\n`;
  if (coinId) {
    text += `<b>ID:</b> <code>${escapeHtml(String(coinId))}</code>\n`;
  }
  if (peak !== "") {
    text += `👁 <b>Viewers:</b> ${peak} (peak in 30s)\n`;
  }
  text += `⏱ +${ws2live}s от WS → LIVE, +${live2elig}s от LIVE → ≥${ELIG_VIEWERS}\n`;
  text += `🔗 Axiom: https://axiom.trade/t/${j.mint}\n`;
  if (website) text += `🌐 Website: ${website}\n`;
  if (twitter) text += `🐦 Twitter: ${twitter}\n`;

  try{
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: TG_PARSE_MODE,
      disable_web_page_preview: true
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok){
      const t = await r.text().catch(()=> "");
      log(`⚠️  telegram sendMessage failed: ${r.status} ${t || ""}`);
    }
  }catch(e){
    log(`⚠️  telegram error: ${e?.message || e}`);
  }
}

/* ================== WS INTAKE ================== */

let ws;

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
    scheduleTimer(j.stageTimers, j.t0 + FIRST_CHECK_DELAY_MS, () => runStage(j, "first"));
    return;
  }

  // bump в первые 60s
  if (!existing.stageClosed && !existing.closed && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
    metrics.ws_bumps++;
    scheduleTimer(existing.stageTimers, ts + 1, () => runStage(existing, "bump"));
  } else {
    metrics.ws_dups++;
  }
}

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
  const active = jobs.size;
  log(
    `[stats] active=${active}`,
    `api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw}`,
    `decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}`,
    `ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}`,
    `jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} finals=${metrics.final_checks}`,
    `elig: started=${metrics.elig_started} ok=${metrics.elig_ok} fail=${metrics.elig_fail}`,
    `| lat(LIVE) p50=— p95=— | lat(≥${ELIG_VIEWERS}) p50=— p95=—`
  );
}, HEARTBEAT_MS);

/* ================== START ================== */

log(
  "Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS,
  "| ELIG=", `≥${ELIG_VIEWERS} in ${Math.round(ELIG_WINDOW_MS/1000)}s step ${Math.round(ELIG_STEP_MS/1000)}s`,
  "| TZ=", TIMEZONE
);

connectWS();

/* ================== Graceful ================== */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT",  ()=>process.exit(0));
