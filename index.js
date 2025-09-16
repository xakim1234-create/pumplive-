// zero-miss live catcher + eligibility to TG — v11.2.0
// by chatgpt — paste & run

import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";

/* ================== CONFIG (ENV) ================== */

function envI(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }

const WS_URL = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API    = envS("PUMP_API",    "https://frontend-api-v3.pump.fun");

// первичное решение LIVE
const VIEWERS_THRESHOLD      = envI("VIEWERS_THRESHOLD", 1);
const FIRST_CHECK_DELAY_MS   = envI("FIRST_CHECK_DELAY_MS", 5000);
const SECOND_CHECK_DELAY_MS  = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS   = envI("THIRD_CHECK_DELAY_MS", 15000);
const FINAL_CHECK_DELAY_MS   = envI("FINAL_CHECK_DELAY_MS", 45000); // безусловный финал

const QUICK_ATTEMPTS         = envI("QUICK_ATTEMPTS", 3);
const QUICK_STEP_MS          = envI("QUICK_STEP_MS", 700);

const GLOBAL_RPS             = envN("GLOBAL_RPS", 2);
const JITTER_MS              = envI("JITTER_MS", 120);
const PENALTY_AFTER_429_MS   = envI("PENALTY_AFTER_429_MS", 30000);

const DEDUP_TTL_MS           = envI("DEDUP_TTL_MS", 20000);
const WS_BUMP_WINDOW_MS      = envI("WS_BUMP_WINDOW_MS", 60000);
const HEARTBEAT_MS           = envI("HEARTBEAT_MS", 30000);

// eligibility окно: «в течение ELIG_WINDOW_MS хотя бы раз достигли ELIG_THRESHOLD»
const ELIG_THRESHOLD         = envI("ELIG_THRESHOLD", 30);
const ELIG_WINDOW_MS         = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS           = envI("ELIG_STEP_MS", 5000);

// логирование тиков eligibility
const LOG_ELIG_TICKS         = (process.env.LOG_ELIG_TICKS ?? "true") === "true";
const LOG_ELIG_ONLY_PASSED   = (process.env.LOG_ELIG_ONLY_PASSED ?? "false") === "true";

// телега
const TG_BOT_TOKEN           = envS("TG_BOT_TOKEN", "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc");
const TG_CHAT_ID             = envS("TG_CHAT_ID", "-4857972467");
const TG_SEND_PHOTO          = (process.env.TG_SEND_PHOTO ?? "true") === "true";

// отображение времени в хедерах
const TIMEZONE               = envS("TIMEZONE", "Europe/Moscow");

/* ================== HELPERS ================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
function log(...a){ console.log(new Date().toISOString(), ...a); }
function fmtS(ms){ return `+${(ms/1000).toFixed(2)}s`; }
function shortMint(m){ return m?.length>12 ? `${m.slice(0,4)}…${m.slice(-4)}` : (m||""); }

function formatZoned(ts){
  try{
    const fmt = new Intl.DateTimeFormat("ru-RU", {
      timeZone: TIMEZONE,
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    return fmt.format(ts) + ` (${TIMEZONE})`;
  }catch{
    return new Date(ts).toISOString();
  }
}

function buildAxiomUrl(mint){
  // используешь такой формат в телеге
  return `https://axiom.trade/t/${mint}`;
}

function ipfsToHttp(url){
  if (!url) return null;
  if (url.startsWith("ipfs://")){
    const cid = url.replace("ipfs://", "");
    return [
      `https://ipfs.io/ipfs/${cid}`,
      `https://cloudflare-ipfs.com/ipfs/${cid}`,
      `https://gateway.pinata.cloud/ipfs/${cid}`
    ];
  }
  return [url];
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
  const jitter = Math.max(-JITTER_MS, Math.min(JITTER_MS, (Math.random()*2 - 1) * JITTER_MS));
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
        "user-agent": "pumplive/11.2"
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

/* ================== LIVE DECISION ================== */

function asNum(v){ return (typeof v === "number" && Number.isFinite(v)) ? v : null; }
function extractViewers(c){
  const arr = [
    c?.num_participants, c?.viewers, c?.num_viewers, c?.live_viewers,
    c?.participants, c?.unique_viewers, c?.room?.viewers
  ];
  for (const x of arr){
    const n = asNum(x);
    if (n !== null) return n;
  }
  return null;
}

function decideFromCoin(c){
  const v = extractViewers(c);
  const liveFlag = (c?.is_currently_live === true) || (c?.inferred_live === true);
  if (liveFlag || (v !== null && v >= VIEWERS_THRESHOLD)){
    metrics.decide_live++;
    return { state:"live", viewers:v, liveFlag:true, reason: liveFlag ? "flag" : "viewers" };
  }
  const negative = (c?.is_currently_live === false) && (c?.inferred_live === false || typeof c?.inferred_live === "undefined");
  if (negative && (v === 0 || v === null)){
    metrics.decide_not_live++;
    return { state:"not_live", viewers:v, liveFlag:false, reason:"clean-false" };
  }
  metrics.decide_unknown++;
  return { state:"unknown", viewers:v, liveFlag: !!liveFlag, reason:"ambiguous" };
}

/* ================== TELEGRAM ================== */

async function tg(method, payload){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return { ok:false, err:"no_token_or_chat" };
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j.ok){
    const msg = j?.description || `${r.status}`;
    return { ok:false, err:msg };
  }
  return { ok:true, data:j };
}

function buildCaption(c, j){
  const n = c?.name || "no-name";
  const s = c?.symbol || "";
  const title = `🟢 LIVE ≥${ELIG_THRESHOLD} | ${s ? `${s} `:""}(${n})`;
  const when = formatZoned(Date.now());
  const viewers = j.eligPeak ?? (extractViewers(c) ?? "n/a");
  const delta1 = j.firstLiveAt ? fmtS(j.firstLiveAt - j.t0) : "n/a";
  const delta2 = j.eligHitAt  ? fmtS(j.eligHitAt  - (j.firstLiveAt || j.t0)) : "n/a";
  const lines = [
    `${title}`,
    `🕒 ${when}`,
    `🧬 Mint (CA):\n${c?.mint || j.mint}`,
    `👁️ Viewers: ${viewers} (peak in ${Math.floor(ELIG_WINDOW_MS/1000)}s)`,
    `⏱️ ${delta1} от WS → LIVE, ${delta2} от LIVE → ≥${ELIG_THRESHOLD}`,
    `🔗 Axiom:\n${buildAxiomUrl(c?.mint || j.mint)}`
  ];

  // socials, если есть
  const site = c?.website || c?.metadata?.website || c?.links?.website;
  const tw   = c?.twitter || c?.metadata?.twitter || c?.links?.twitter;
  if (site) lines.push(`🌐 Website: ${site}`);
  if (tw)   lines.push(`🐦 Twitter: ${tw}`);

  return lines.join("\n");
}

async function sendToTGWithPhoto(c, j){
  const caption = buildCaption(c, j).slice(0, 1020); // запас под телеграмные лимиты на подпись фото
  const rawImg = c?.image_uri || c?.image || c?.img || c?.metadata?.image || null;
  const candidates = TG_SEND_PHOTO ? ipfsToHttp(rawImg) : [];

  for (const url of candidates){
    const res = await tg("sendPhoto", {
      chat_id: TG_CHAT_ID,
      photo: url,
      caption,
      parse_mode: "HTML" // на случай ссылок, но мы даём обычный текст
    });
    if (res.ok){
      log(`🖼️ TG photo: direct OK | ${url}`);
      return true;
    }else{
      log(`⚠️ TG sendPhoto fail: ${res.err}`);
      // пробуем следующий шлюз/фоллбек
    }
  }

  // текстом
  const res = await tg("sendMessage", {
    chat_id: TG_CHAT_ID,
    text: buildCaption(c, j),
    disable_web_page_preview: false
  });
  if (!res.ok){
    log(`❌ TG sendMessage fail: ${res.err}`);
    return false;
  }
  log("✉️  TG text sent");
  return true;
}

/* ================== JOBS / SCHEDULER ================== */

const jobs = new Map();   // mint -> Job
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
    t0: now(),
    timeouts: new Set(),
    liveHit: false,
    seenUnknown: 0,
    goodFalse: 0,
    closed: false,

    // eligibility
    eligActive:false,
    eligTotalSamples:0,
    eligOkSamples:0,
    eligPeak:0,
    eligStartAt:0,
    eligHitAt:0,

    // times
    firstLiveAt:0
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

/* ================== ELIGIBILITY WINDOW ================== */

function logEligTick(j, tickIdx, total, viewers, errKind){
  if (!LOG_ELIG_TICKS) return;
  if (LOG_ELIG_ONLY_PASSED && !j.eligHitAt) return;

  const tLive = j.firstLiveAt ? now() - j.firstLiveAt : 0;
  const tWs   = now() - j.t0;
  const ok    = j.eligOkSamples || 0;
  const max   = j.eligPeak || 0;
  const base  = `mint=${shortMint(j.mint)} | tick ${tickIdx}/${total} | tLIVE=${fmtS(tLive)} | tWS=${fmtS(tWs)}`;

  if (errKind){
    log(`[ELIG] ${base} | err=${errKind} | ok=${ok}/${total} | max=${max}`);
  } else {
    const thr = ELIG_THRESHOLD;
    const flag = (viewers!=null && viewers>=thr) ? `(≥${thr})` : `(<${thr})`;
    log(`[ELIG] ${base} | v=${viewers ?? "n/a"} ${flag} | ok=${ok}/${total} | max=${max}`);
  }
}

async function startEligibility(j){
  if (j.eligActive) return;
  j.eligActive = true;
  j.eligStartAt = now();
  j.eligTotalSamples = 0;
  j.eligOkSamples = 0;
  j.eligPeak = 0;
  j.eligHitAt = 0;
  metrics.elig_started++;

  const totalTicks = Math.ceil(ELIG_WINDOW_MS / ELIG_STEP_MS);
  log(`🎯 ELIG start ${Math.floor(ELIG_WINDOW_MS/1000)}s | ${j.mint} | thr=${ELIG_THRESHOLD} | step=${Math.floor(ELIG_STEP_MS/1000)}s`);

  const windowEnd = now() + ELIG_WINDOW_MS;

  const tick = async () => {
    if (j.closed || !j.eligActive) return;

    const r = await fetchCoin(j.mint);
    if (!r.ok){
      const idx = j.eligTotalSamples + 1;
      logEligTick(j, idx, totalTicks, null, r.kind || "error");
    } else {
      const c = r.data || {};
      const v = extractViewers(c);
      const state = decideFromCoin(c).state; // фиксируем опять же

      const idx = j.eligTotalSamples + 1;
      logEligTick(j, idx, totalTicks, v, null);

      j.eligTotalSamples++;
      if (v !== null) j.eligPeak = Math.max(j.eligPeak, v);
      if (v !== null && v >= ELIG_THRESHOLD){
        if (!j.eligHitAt) j.eligHitAt = now();
        j.eligOkSamples++;
        // пушнем сразу, не ждём конца окна:
        if (j.eligOkSamples === 1){
          log(`✅ ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | hit@${fmtS(j.eligHitAt - (j.firstLiveAt || j.t0))} от LIVE (${fmtS((j.firstLiveAt||j.t0)-j.t0)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${totalTicks}`);
          metrics.elig_ok++;
          // телега
          await sendToTGWithPhoto({ ...(c||{}), mint: j.mint }, j).catch(()=>{});
        }
      }
    }

    if (now() < windowEnd && j.eligTotalSamples < totalTicks){
      schedule(j, "elig-tick", now() + ELIG_STEP_MS, async () => { await tick(); });
    } else {
      // окно закрыто
      if (!j.eligHitAt){
        metrics.elig_fail++;
        log(`🚫 NOT ELIGIBLE (<${ELIG_THRESHOLD} за ${Math.floor(ELIG_WINDOW_MS/1000)}s) | ${j.mint} | max=${j.eligPeak} | valid=${j.eligOkSamples}/${totalTicks} | firstLIVE@${j.firstLiveAt ? fmtS(j.firstLiveAt - j.t0) : "n/a"}`);
      }
      j.eligActive = false;
    }
  };

  // первый тик сразу
  await tick();
}

/* ================== PROBE SLOTS ================== */

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
        log(`❌ fetch error: ${r.kind}${r.status ? " "+r.status : ""} | mint: ${j.mint}`);
      }
    }else{
      const coin = r.data || {};
      const { state, viewers, reason } = decideFromCoin(coin);
      if (state === "live"){
        const name = coin?.name || "";
        const symbol = coin?.symbol || "";
        const ver = asNum(coin?.version) ?? 0;
        const dtLive = now() - j.t0;
        log(`🔥 LIVE | ${j.mint} | ${symbol || name ? `${symbol ? symbol+" " : ""}(${name || "no-name"})` : ""} | v=${viewers ?? "n/a"} | reason=${reason}/flag | ${fmtS(dtLive)} от WS → candidate`);
        j.liveHit = true;
        if (!j.firstLiveAt) j.firstLiveAt = now();
        // запускаем eligibility окно
        startEligibility(j).catch(()=>{});
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

async function runStage(j, stage){
  if (j.closed) return;

  await slotProbe(j, stage);
  if (j.closed) return;

  if (j.liveHit){
    // job не закрываем — eligibility допашется параллельно,
    // но слоты дальнейшие нам не нужны
    if (stage !== "final"){ /* no-op */ }
    return;
  }

  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  }else if (stage === "second"){
    schedule(j, "third", j.t0 + THIRD_CHECK_DELAY_MS, runStage);
  }else if (stage === "third"){
    // всегда ставим финал, чтобы «не пропустить вообще»
    metrics.final_checks++;
    log(`↪️  schedule FINAL | ${j.mint} | reason=always goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
    schedule(j, "final", j.t0 + FINAL_CHECK_DELAY_MS, runFinal);
  }
}

async function runFinal(j){
  if (j.closed) return;
  await slotProbe(j, "final");
  if (j.closed) return;

  // если так и не стало live — закрываем
  if (!j.liveHit){
    log(`🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown}`);
    clearJob(j);
  } else {
    // liveHit есть, eligibility может ещё крутиться — подождём чуть и уберём job
    // (чтобы не висеть бесконечно)
    setTimeout(() => { if (!j.closed) clearJob(j); }, 60000);
  }
}

/* ================== WS FEED ================== */

let ws;

function ensureJobFromWS(mint){
  metrics.ws_events++;
  if (!mint) return;
  const ts = now();
  let j = jobs.get(mint);
  if (!j){
    if (!seenRecently(mint)) markRecent(mint);
    j = newJob(mint);
    // план первого слота
    schedule(j, "first", j.t0 + FIRST_CHECK_DELAY_MS, runStage);
    return;
  }
  // bump в первые 60с
  if (!j.liveHit && !j.closed && (ts - j.t0 <= WS_BUMP_WINDOW_MS)){
    metrics.ws_bumps++;
    schedule(j, "bump", ts + 1, runStage);
  }else{
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

/* ================== HEARTBEAT ================== */

setInterval(() => {
  const active = jobs.size;
  log(
    `[stats] active=${active}`,
    `api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw}`,
    `decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}`,
    `ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}`,
    `jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} final=${metrics.final_checks}`,
    `elig: started=${metrics.elig_started} ok=${metrics.elig_ok} fail=${metrics.elig_fail}`
  );
}, HEARTBEAT_MS);

/* ================== START ================== */

log(
  "Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS,
  `| ELIG= ≥${ELIG_THRESHOLD} for ${Math.floor(ELIG_WINDOW_MS/1000)}s step ${Math.floor(ELIG_STEP_MS/1000)}s`,
  `| TZ=`, TIMEZONE
);

connectWS();

/* ================== Graceful ================== */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT",  ()=>process.exit(0));
