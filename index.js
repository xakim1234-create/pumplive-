Перейти к содержимому
Журнал чата

Вы сказали:
// zero-miss live catcher — v12.0 (WS → multi-stage → final@45s) + TG + eligible≥N/window
// features: instant-send+stop, X/N stabilize logs, configurable window/step
import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";
import FormData from "form-data";

/* ================== CONFIG ================== */

function envI(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }

const WS_URL = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API    = envS("PUMP_API",    "https://frontend-api-v3.pump.fun");

const VIEWERS_THRESHOLD      = envI("VIEWERS_THRESHOLD", 1);     // для первичного LIVE-решения
const FIRST_CHECK_DELAY_MS   = envI("FIRST_CHECK_DELAY_MS", 5000);
const SECOND_CHECK_DELAY_MS  = envI("SECOND_CHECK_DELAY_MS", 10000);
const THIRD_CHECK_DELAY_MS   = envI("THIRD_CHECK_DELAY_MS", 15000);
const FINAL_CHECK_DELAY_MS   = envI("FINAL_CHECK_DELAY_MS", 45000);

const QUICK_ATTEMPTS         = envI("QUICK_ATTEMPTS", 3);
const QUICK_STEP_MS          = envI("QUICK_STEP_MS", 700);

const GLOBAL_RPS             = envN("GLOBAL_RPS", 3);
const JITTER_MS              = envI("JITTER_MS", 120);
const PENALTY_AFTER_429_MS   = envI("PENALTY_AFTER_429_MS", 30000);

const DEDUP_TTL_MS           = envI("DEDUP_TTL_MS", 600000);
const WS_BUMP_WINDOW_MS      = envI("WS_BUMP_WINDOW_MS", 60000);

const HEARTBEAT_MS           = envI("HEARTBEAT_MS", 30000);

// Eligibility (лайвы ≥N в течение окна)
const ELIG_THRESHOLD         = envI("ELIG_THRESHOLD", 30);
const ELIG_WINDOW_MS         = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS           = envI("ELIG_STEP_MS", 5000);

// Instant режим (то, о чём договорились)
const ELIG_INSTANT           = envI("ELIG_INSTANT", 1);        // 1 — сразу отправлять при первом ≥N
const MIN_CONSEC_SAMPLES     = envI("MIN_CONSEC_SAMPLES", 1);  // подряд тиков ≥N для триггера (оставь 1)
const INSTANT_MODE           = "stop";                          // фиксируем «stop» по твоему запросу

// Telegram (дефолты — можно переопределить ENV-ами)
const TG_BOT_TOKEN           = envS("TG_BOT_TOKEN", "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc");
const TG_CHAT_ID             = envS("TG_CHAT_ID",   "-4857972467");
const TG_SEND_PHOTO          = envI("TG_SEND_PHOTO", 1);
const TG_PLACEHOLDER_IMG     = envS("TG_PLACEHOLDER_IMG", "");


// TZ для меток времени в телеге
const TZ_LABEL               = envS("TIMEZONE", "Europe/Moscow");

/* ================== HELPERS ================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now   = () => Date.now();
function log(...a){ console.log(new Date().toISOString(), ...a); }

function fmtNum(n){
  if (n == null || !Number.isFinite(Number(n))) return "n/a";
  return Number(n).toLocaleString("en-US");
}
function fmtUsd(n){
  if (n == null || !Number.isFinite(Number(n))) return "n/a";
  return $${Number(n).toLocaleString("en-US", {maximumFractionDigits: 2})};
}
function fmtDur(ms){ return (ms/1000).toFixed(2) + "s"; }
function fmtDateTime(ts){
  const d = new Date(ts);
  const dt = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ_LABEL, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  }).format(d);
  return ${dt} (${TZ_LABEL});
}

/* ================== METRICS ================== */

const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_429:0, api_http:0, api_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_created:0, jobs_finished:0,
  final_checks:0,
  elig_started:0, elig_ok:0, elig_fail:0,
  lat_live: [],   // ms: WS → LIVE
  lat_elig: []    // ms: LIVE → ≥N (первый тик)
};

function pushLat(arr, v, cap=5000){ arr.push(v); if (arr.length > cap) arr.shift(); }
function percentile(sorted, p){ if (!sorted.length) return null; const idx = Math.floor((p/100)*(sorted.length-1)); return sorted[idx]; }

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
  const url = ${API}/coins/${encodeURIComponent(mint)}?_=${Date.now()}&n=${Math.random().toString(36).slice(2,8)};
  try{
    await throttle();
    metrics.api_req++;
    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
        "user-agent": "pumplive/v12.0-zero-miss"
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
      metrics.api_empty++; return { ok:false, kind:"empty" };
    }
    if (text.trim()[0] === "<"){
      metrics.api_html++; return { ok:false, kind:"html" };
    }
    try{
      const json = JSON.parse(text);
      metrics.api_ok++;
      return { ok:true, data:json };
    }catch(e){
      metrics.api_parse++; return { ok:false, kind:"parse", msg:e.message };
    }
  }catch(e){
    metrics.api_throw++; return { ok:false, kind:"throw", msg:e.message };
  }
}

/* ================== DECISION ================== */

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

/* ================== DEDUP ================== */

const jobs = new Map();     // mint -> Job
const recently = new Map(); // грубая дедупликация WS событий

function markRecent(mint){ recently.set(mint, now()); }
function seenRecently(mint){
  const t = recently.get(mint);
  if (!t) return false;
  if (now() - t > DEDUP_TTL_MS){ recently.delete(mint); return false; }
  return true;
}

/* ================== TELEGRAM ================== */

async function tgApi(method, payload){
  const url = https://api.telegram.org/bot${TG_BOT_TOKEN}/${method};
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if (!j?.ok){
    log(⚠️ TG ${method} fail: ${r.status} ${j?.description || ""});
  }
  return j;
}
async function sendTGMessage(textHtml){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID){
    log("⚠️ TG creds missing: message not sent");
    return { ok:false };
  }
  return tgApi("sendMessage", { chat_id: TG_CHAT_ID, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true });
}
function normalizeIpfs(u){
  if (!u) return null;
  if (typeof u !== "string") return null;
  u = u.trim();
  if (!u) return null;
  if (u.startsWith("ipfs://")){
    const cid = u.replace(/^ipfs:\/\//, "");
    return https://cloudflare-ipfs.com/ipfs/${cid};
  }
  return u;
}
function pickImageCandidates(coin){
  const fields = [
    coin?.image_url, coin?.imageUrl, coin?.image, coin?.imageURI, coin?.image_uri,
    coin?.metadata?.image, coin?.twitter_pfp, coin?.twitter_profile_image_url,
    coin?.icon, coin?.logo
  ];
  const out = [];
  for (const f of fields){
    const u = normalizeIpfs(f);
    if (u && /^https?:\/\//i.test(u)) out.push(u);
  }
  if (TG_PLACEHOLDER_IMG) out.push(TG_PLACEHOLDER_IMG);
  return [...new Set(out)];
}
async function downloadImage(url){
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 pumplive" } });
  if (!r.ok) { log(🖼️ img http ${r.status} | ${url}); return null; }
  const ct = r.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) { log(🖼️ img bad type ${ct} | ${url}); return null; }
  const ab = await r.arrayBuffer();
  const max = 9.5 * 1024 * 1024; // лимит TG ~10MB
  if (ab.byteLength > max) { log(🖼️ img too big ${ab.byteLength} | ${url}); return null; }
  const ext = (ct.split("/")[1] || "jpg").split(";")[0];
  return { buffer: Buffer.from(ab), contentType: ct, filename: cover.${ext} };
}
async function sendPhotoWithFallback(captionHtml, urls){
  if (!TG_SEND_PHOTO || !TG_BOT_TOKEN || !TG_CHAT_ID){
    await sendTGMessage(captionHtml);
    return;
  }
  for (const url of urls){
    // 1) прямой URL
    const direct = await tgApi("sendPhoto", {
      chat_id: TG_CHAT_ID, photo: url, caption: captionHtml, parse_mode: "HTML"
    });
    if (direct?.ok){ log(🖼️ TG photo: direct OK | ${url}); return; }

    // 2) fallback: скачать и загрузить
    try{
      const img = await downloadImage(url);
      if (!img) continue;
      const form = new FormData();
      form.append("chat_id", TG_CHAT_ID);
      form.append("caption", captionHtml);
      form.append("parse_mode", "HTML");
      form.append("photo", img.buffer, { filename: img.filename, contentType: img.contentType });

      const r = await fetch(https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto, { method: "POST", body: form });
      const j = await r.json().catch(()=> ({}));
      if (j?.ok){ log(🖼️ TG photo: upload OK | ${url}); return; }
      log(⚠️ TG upload fail ${r.status} ${j?.description || ""});
    }catch(e){
      log(⚠️ TG upload error: ${e.message});
    }
  }
  log("ℹ️ TG photo fallback → text only");
  await sendTGMessage(captionHtml);
}

/* ================== MESSAGE BUILDER ================== */

function pickWebsite(coin){
  const cand = [
    coin?.website_url, coin?.website, coin?.links?.website, coin?.metadata?.website,
    coin?.socials?.website, coin?.site
  ].filter(Boolean);
  return cand.find(u => /^https?:\/\//i.test(u)) || null;
}
function pickTwitter(coin){
  const cand = [
    coin?.twitter_url, coin?.twitter_profile, coin?.twitter, coin?.twitter_handle,
    coin?.socials?.twitter
  ].filter(Boolean);
  for (let u of cand){
    if (!u) continue;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("@")) u = u.slice(1);
    return https://twitter.com/${u};
  }
  return null;
}
function pickInstagram(coin){
  const cand = [
    coin?.instagram_url, coin?.instagram, coin?.socials?.instagram
  ].filter(Boolean);
  for (let u of cand){
    if (!u) continue;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("@")) u = u.slice(1);
    return https://instagram.com/${u};
  }
  return null;
}

function escapeHtml(s){
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function buildCaption(coin, j, elig){
  const name   = coin?.name || "";
  const symbol = coin?.symbol || "";
  const title  = ${name}${symbol ?  (${symbol}) : ""} || "Live on pump.fun";

  const line1  = 🟢 <b>LIVE ≥${ELIG_THRESHOLD}</b> | ${escapeHtml(title)};
  const lineTs = 🕒 <b>${fmtDateTime(now())}</b>;

  const viewersLine = 👁️ Viewers: <b>${fmtNum(elig.peak)}</b> (peak in ${Math.floor(ELIG_WINDOW_MS/1000)}s);
  const latLine     = ⏱️ <b>+${fmtDur(j.liveAt - j.t0)}</b> от WS → LIVE, <b>+${fmtDur(elig.hitAt - j.liveAt)}</b> от LIVE → ≥${ELIG_THRESHOLD};

  const axiom = 🔗 Axiom:\nhttps://axiom.trade/t/${j.mint};
  const mint  = 🧬 Mint (CA):\n<code>${j.mint}</code>;

  const lines = [line1, lineTs, mint, viewersLine, latLine, axiom];

  const www = pickWebsite(coin);
  if (www) lines.push(🌐 Website: ${www});
  const ig = pickInstagram(coin);
  if (ig) lines.push(📸 Instagram: ${ig});
  const tw = pickTwitter(coin);
  if (tw) lines.push(🐦 Twitter: ${tw});

  return lines.join("\n");
}

/* ================== JOBS / SCHEDULER ================== */

function newJob(mint){
  const j = {
    mint,
    t0: now(),
    timeouts: new Set(),
    liveHit: false,
    liveAt: null,
    seenUnknown: 0,
    goodFalse: 0,
    closed: false,

    // eligibility
    eligStarted: false,
    eligDone: false,
    eligHitAt: null,
    eligPeak: 0,
    eligOkSamples: 0,     // сколько тиков ≥ порога (необязательно подряд)
    eligConsecOk: 0,      // подряд тиков ≥ порога
    eligTotalSamples: 0,
    eligTickIndex: 0,     // 1..N
    eligTotalTicks: Math.max(1, Math.ceil(ELIG_WINDOW_MS / Math.max(1, ELIG_STEP_MS)))
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
    try{
      await fn(j, label);
    }catch(e){
      log(⚠️ job error [${label}] ${e.message});
    }
  }, delay);
  j.timeouts.add(id);
}

/* ================== ELIGIBILITY (≥N/window) ================== */

function startEligibility(j, coin){
  if (j.eligStarted) return;
  j.eligStarted = true;
  metrics.elig_started++;

  const windowEnd = now() + ELIG_WINDOW_MS;
  log(🎯 ELIG start ${Math.floor(ELIG_WINDOW_MS/1000)}s | ${j.mint} | thr=${ELIG_THRESHOLD} | step=${Math.floor(ELIG_STEP_MS/1000)}s | ticks=${j.eligTotalTicks});

  const instantSendAndStop = async () => {
    // успех: отправим в TG (мгновенно) и закроем джобу
    const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
    const latLiveMs = j.liveAt - j.t0;
    const latEligMs = j.eligHitAt - j.liveAt;
    pushLat(metrics.lat_live, latLiveMs);
    pushLat(metrics.lat_elig, latEligMs);
    metrics.elig_ok++;

    log(⚡ INSTANT ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | hit@+${fmtDur(latEligMs)} от LIVE (+${fmtDur(latLiveMs)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${j.eligTickIndex});

    const caption = buildCaption(coin, j, res);
    const imgs = pickImageCandidates(coin);
    await sendPhotoWithFallback(caption, imgs);

    log(🛑 INSTANT-STOP | <mint=${j.mint}> | уведомлено, окно закрыто на ${j.eligTickIndex}/${j.eligTotalTicks});
    clearJob(j);
  };

  const tick = async () => {
    if (j.closed || j.eligDone) return;

    // защита от бесконечного цикла при нулевом шаге
    const step = Math.max(1, ELIG_STEP_MS);

    const r = await fetchCoin(j.mint);
    if (r.ok){
      const c = r.data || {};
      const v = extractViewers(c);
      const state = decideFromCoin(c).state;

      j.eligTotalSamples++;
      j.eligTickIndex = Math.min(j.eligTickIndex + 1, j.eligTotalTicks);
      if (v !== null) j.eligPeak = Math.max(j.eligPeak, v);

      const idx = j.eligTickIndex;
      const tot = j.eligTotalTicks;

      if (v !== null && v >= ELIG_THRESHOLD){
        j.eligOkSamples++;
        j.eligConsecOk++;
        if (!j.eligHitAt) j.eligHitAt = now();
      }else{
        j.eligConsecOk = 0;
      }

      log(⏱️ stabilize ${idx}/${tot} | state=${state} | viewers=${v ?? "n/a"} | ok=${j.eligOkSamples} | consec=${j.eligConsecOk});

      // === INSTANT SEND + STOP ===
      if (ELIG_INSTANT && j.eligConsecOk >= MIN_CONSEC_SAMPLES){
        j.eligDone = true;           // блокируем последующие тики
        await instantSendAndStop();  // отправляем и очищаем job
        return;
      }

    }else{
      j.eligTotalSamples++;
      j.eligTickIndex = Math.min(j.eligTickIndex + 1, j.eligTotalTicks);
      log(⏱️ stabilize err: ${r.kind}${r.status? " "+r.status:""});
      // при ошибке не трогаем consecOk
    }

    if (now() < windowEnd && j.eligTickIndex < j.eligTotalTicks){
      schedule(j, "elig-tick", now() + step, () => tick());
    }else{
      j.eligDone = true;
      if (j.eligHitAt){
        // это случай, когда ELIG_INSTANT=0 (теоретически) — тогда отправка в конце окна
        const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
        const latLiveMs = j.liveAt - j.t0;
        const latEligMs = j.eligHitAt - j.liveAt;
        pushLat(metrics.lat_live, latLiveMs);
        pushLat(metrics.lat_elig, latEligMs);
        metrics.elig_ok++;

        log(✅ ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | hit@+${fmtDur(latEligMs)} от LIVE (+${fmtDur(latLiveMs)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${j.eligTotalSamples});

        const caption = buildCaption(c, j, res);
        const imgs = pickImageCandidates(c);
        await sendPhotoWithFallback(caption, imgs);
      }else{
        metrics.elig_fail++;
        log(🚫 NOT ELIGIBLE (<${ELIG_THRESHOLD} за ${Math.floor(ELIG_WINDOW_MS/1000)}s) | ${j.mint} | max=${j.eligPeak} | valid=${j.eligOkSamples}/${j.eligTotalSamples} | firstLIVE@+${fmtDur(j.liveAt - j.t0)});
      }
      clearJob(j);
    }
  };

  // первый тик — сразу
  schedule(j, "elig-tick", now() + 1, () => tick());
}

/* ================== PROBE SLOTS ================== */

async function slotProbe(j, label){
  let localLive = false;
  let localUnknown = 0;
  let localFalse = 0;
  let lastCoin = null;
  let lastDecision = null;

  for (let i=0; i<QUICK_ATTEMPTS; i++){
    const r = await fetchCoin(j.mint);
    if (!r.ok){
      localUnknown++;
      if (r.kind === "html" || r.kind === "empty" || r.kind === "http" || r.kind === "parse"){
        log(❌ fetch error: ${r.kind}${r.status ? " "+r.status:""} | mint: ${j.mint});
      }else if (r.kind === "429"){
        log(❌ fetch error: HTTP 429 | mint: ${j.mint} (penalty ${PENALTY_AFTER_429_MS}ms));
      }else{
        log(❌ fetch error: ${r.kind}${r.msg? " "+r.msg:""} | mint: ${j.mint});
      }
    }else{
      const coin = r.data || {};
      lastCoin = coin;
      const dec = decideFromCoin(coin);
      lastDecision = dec;
      const v = dec.viewers ?? "n/a";

      if (dec.state === "live"){
        if (!j.liveAt) {
          j.liveAt = now();
          log(🔥 LIVE | ${j.mint} | ${coin?.symbol ? coin.symbol+" " : ""}(${coin?.name || "no-name"}) | v=${v} | reason=${dec.reason}${dec.liveFlag?"/flag":""} | +${fmtDur(j.liveAt - j.t0)} от WS → candidate);
          // старт eligibility
          startEligibility(j, coin);
        }
        j.liveHit = true;
        localLive = true;
        break;
      }else if (dec.state === "unknown"){
        localUnknown++;
      }else{
        localFalse++;
        log(… not live | ${j.mint} | slot=${label} | viewers=${v} | is_currently_live=false);
      }
    }
    if (i < QUICK_ATTEMPTS-1) await sleep(QUICK_STEP_MS);
  }

  j.seenUnknown += localUnknown;
  j.goodFalse   += localFalse;
  return { localLive, localUnknown, localFalse, lastCoin, lastDecision };
}

async function runStage(j, stage){
  if (j.closed) return;

  const { localLive } = await slotProbe(j, stage);
  if (j.closed) return;

  if (j.liveHit){
    // Eligibility сама завершит job
    return;
  }

  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  }else if (stage === "second"){
    schedule(j, "third", j.t0 + THIRD_CHECK_DELAY_MS, runStage);
  }else if (stage === "third"){
    metrics.final_checks++;
    log(↪️  schedule FINAL | ${j.mint} | reason=always goodFalse=${j.goodFalse} unknown=${j.seenUnknown});
    schedule(j, "final", j.t0 + FINAL_CHECK_DELAY_MS, runFinal);
  }
}

async function runFinal(j){
  if (j.closed) return;
  const { localLive } = await slotProbe(j, "final");
  if (j.closed) return;

  if (j.liveHit || localLive){
    return; // eligibility возьмёт дальше
  }
  log(🧹 final skip not_live | ${j.mint} | goodFalse=${j.goodFalse} unknown=${j.seenUnknown});
  clearJob(j);
}

/* ================== WS ================== */

let ws;
function connectWS(){
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log(✅ WS connected: ${WS_URL});
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    log("📡 Subscribed: subscribeNewToken");
  });
  ws.on("message", (raw) => {
    let msg = null;
    try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;

    metrics.ws_events++;
    const existing = jobs.get(mint);
    const ts = now();

    if (!existing){
      if (!seenRecently(mint)) markRecent(mint);
      const j = newJob(mint);
      schedule(j, "first", j.t0 + FIRST_CHECK_DELAY_MS, runStage);
      return;
    }
    if (!existing.liveHit && !existing.closed && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
      metrics.ws_bumps++;
      schedule(existing, "bump", ts + 1, runStage);
    }else{
      metrics.ws_dups++;
    }
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
  const l1 = metrics.lat_live.slice().sort((a,b)=>a-b);
  const l2 = metrics.lat_elig.slice().sort((a,b)=>a-b);
  const p50L = percentile(l1,50), p95L = percentile(l1,95);
  const p50E = percentile(l2,50), p95E = percentile(l2,95);

  log(
    [stats] active=${active},
    api:req=${metrics.api_req} ok=${metrics.api_ok} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} http=${metrics.api_http} 429=${metrics.api_429} throw=${metrics.api_throw},
    decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown},
    ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps},
    jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} final=${metrics.final_checks},
    elig: started=${metrics.elig_started} ok=${metrics.elig_ok} fail=${metrics.elig_fail},
    | lat(LIVE) p50=${p50L?fmtDur(p50L):"n/a"} p95=${p95L?fmtDur(p95L):"n/a"},
    | lat(≥${ELIG_THRESHOLD}) p50=${p50E?fmtDur(p50E):"n/a"} p95=${p95E?fmtDur(p95E):"n/a"}
  );
}, HEARTBEAT_MS);

/* ================== START ================== */

log("Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", ${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS},
  "| SLOT=", ${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms,
  "| RPS=", GLOBAL_RPS,
  "| ELIG=", ≥${ELIG_THRESHOLD} for ${Math.floor(ELIG_WINDOW_MS/1000)}s step ${Math.floor(ELIG_STEP_MS/1000)}s,
  "| INSTANT=", ELIG_INSTANT ? on (minConsec=${MIN_CONSEC_SAMPLES}, mode=${INSTANT_MODE}) : "off",
  "| TZ=", TZ_LABEL
);

connectWS();

/* ================== Graceful ================== */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));   


привет что может мой код ? коротко
ChatGPT сказал:

Думал на протяжении 28s
Коротко: это ловец лайв-появлений новых токенов на pump.fun с мгновенными алертами в Telegram.

Подключается к WS pumpportal.fun, ловит новые mint’ы.

По каждому mint делает многостадийные проверки через REST frontend-api-v3.pump.fun с троттлингом/джиттером и штрафом после 429.

Определяет “live” по флагам/числу зрителей; затем запускает окно eligibility (≥N зрителей за заданный интервал, дискретный шаг).

В instant-режиме при первом выполнении условия сразу шлёт и останавливает джобу (mode=“stop”).

Отправляет в Telegram карточку (фото/фолбэк на текст): имя/тикер, CA, пик зрителей, задержки WS→LIVE и LIVE→≥N, ссылки (Axiom/сайт/Twitter/IG), таймстемп в заданном TZ.

Есть дедуп событий, метрики и heartbeat-логи, авто-реконнект WS.

Всё поведение настраивается через ENV (пороги, окна, шаги, RPS и т.д.).

P.S. У тебя в коде прописан TG bot token и chat_id — лучше вынести в ENV и не публиковать.

Вы сказали:
как выглядят мои логи ? 
ChatGPT сказал:

Думал на протяжении 23s
Примерно так — каждая строка начинается с ISO-временем, дальше иконка/тег и сообщение.

2025-09-16T12:00:00.123Z Zero-miss watcher starting… | THR= 1 | DELAYS= 5000/10000/15000/final@45000 | SLOT= 3x700ms | RPS= 3 | ELIG= ≥30 for 30s step 5s | INSTANT= on (minConsec=1, mode=stop) | TZ= Europe/Moscow
2025-09-16T12:00:00.456Z ✅ WS connected: wss://pumpportal.fun/api/data
2025-09-16T12:00:00.457Z 📡 Subscribed: subscribeNewToken

2025-09-16T12:00:05.512Z … not live | 9Fh1...Mint | slot=first | viewers=n/a | is_currently_live=false
2025-09-16T12:00:06.230Z ❌ fetch error: HTTP 429 | mint: 9Fh1...Mint (penalty 30000ms)
2025-09-16T12:00:10.015Z ↪️  schedule FINAL | 9Fh1...Mint | reason=always goodFalse=1 unknown=1

2025-09-16T12:00:05.789Z 🔥 LIVE | 4b2C...Mint | (no-name) | v=57 | reason=viewers/flag | +5.31s от WS → candidate
2025-09-16T12:00:05.790Z 🎯 ELIG start 30s | 4b2C...Mint | thr=30 | step=5s | ticks=6
2025-09-16T12:00:05.791Z ⏱️ stabilize 1/6 | state=live | viewers=57 | ok=1 | consec=1
2025-09-16T12:00:05.792Z ⚡ INSTANT ELIGIBLE (≥30) | 4b2C...Mint | hit@+0.00s от LIVE (+5.31s от WS) | max=57 | samples=1/1
2025-09-16T12:00:05.950Z 🖼️ TG photo: direct OK | https://cloudflare-ipfs.com/ipfs/...
2025-09-16T12:00:05.951Z 🛑 INSTANT-STOP | <mint=4b2C...Mint> | уведомлено, окно закрыто на 1/6

2025-09-16T12:00:30.000Z 🧹 final skip not_live | 9Fh1...Mint | goodFalse=1 unknown=1
2025-09-16T12:00:30.123Z [stats] active=0 api:req=18 ok=16 html=0 empty=0 parse=0 http=1 429=1 throw=0 decide: live=1 not_live=3 unknown=2 ws: events=5 dups=1 bumps=1 jobs: new=2 done=2 final=1 elig: started=1 ok=1 fail=0 | lat(LIVE) p50=5.31s p95=5.31s | lat(≥30) p50=0.00s p95=0.00s

2025-09-16T12:02:10.777Z 🖼️ img too big 14652349 | https://example.com/cover.png
2025-09-16T12:02:10.980Z ⚠️ TG upload fail 400 Bad Request: IMAGE_PROCESS_FAILED
2025-09-16T12:02:10.981Z ℹ️ TG photo fallback → text only

2025-09-16T12:05:00.000Z WS closed → reconnect in 3s
2025-09-16T12:05:03.005Z ✅ WS connected: wss://pumpportal.fun/api/data
Что где:

старты/реконнекты: “Zero-miss watcher starting…”, “WS connected/closed”.

проверки монеты: “… not live”, “❌ fetch error”, “↪️ schedule FINAL”.

лайв и окно ≥N: “🔥 LIVE…”, “🎯 ELIG start…”, “⏱️ stabilize i/N…”.

успех/фейл окна: “⚡ INSTANT ELIGIBLE… / ✅ ELIGIBLE… / 🚫 NOT ELIGIBLE…”.

Telegram: “🖼️ TG photo: direct OK / upload OK / fallback → text only”, плюс предупреждения “⚠️ TG … fail”.

heartbeat каждые HEARTBEAT_MS: строка [stats] … с метриками и p50/p95 задержек.

Если хочешь, сгенерирую маленький фейковый лог под твои текущие ENV (порог/окна/RPS), чтобы проверить формат.




Файл не выбранФайл не выбран
ChatGPT может допускать ошибки. Проверьте важную информацию. См. настройки cookie-файлов.
