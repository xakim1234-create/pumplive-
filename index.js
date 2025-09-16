// index.js (ESM)
// Zero-miss live catcher — v13.0 (livestream-aware)

import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";
import FormData from "form-data";

/* ================== CONFIG ================== */

function envI(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function envN(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envS(name, def) { const v = (process.env[name] || "").trim(); return v || def; }

const WS_URL        = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API_COINS     = envS("PUMP_API",    "https://frontend-api-v3.pump.fun");
const API_LS        = envS("LIVESTREAM_API", "https://livestream-api.pump.fun");

// Первичное подтверждение LIVE по coin-флагам/счётчикам
const VIEWERS_THRESHOLD      = envI("VIEWERS_THRESHOLD", 2);

// Этапы проб после WS
const FIRST_CHECK_DELAY_MS   = envI("FIRST_CHECK_DELAY_MS", 6000);
const SECOND_CHECK_DELAY_MS  = envI("SECOND_CHECK_DELAY_MS", 12000);
const THIRD_CHECK_DELAY_MS   = envI("THIRD_CHECK_DELAY_MS", 18000);
const FINAL_CHECK_DELAY_MS   = envI("FINAL_CHECK_DELAY_MS", 48000);

// Быстрые пробы на этапе (минимальные безопасные дефолты)
const QUICK_ATTEMPTS         = envI("QUICK_ATTEMPTS", 1);
const QUICK_STEP_MS          = envI("QUICK_STEP_MS", 1200);

// Глобальный троттлинг
const GLOBAL_RPS             = envN("GLOBAL_RPS", 2);
const JITTER_MS              = envI("JITTER_MS", 400);
const PENALTY_AFTER_429_MS   = envI("PENALTY_AFTER_429_MS", 120000);

// Дедуп WS и бамп
const DEDUP_TTL_MS           = envI("DEDUP_TTL_MS", 600000);
const WS_BUMP_WINDOW_MS      = envI("WS_BUMP_WINDOW_MS", 15000);

const HEARTBEAT_MS           = envI("HEARTBEAT_MS", 30000);

// Eligibility (≥N в окне)
const ELIG_THRESHOLD         = envI("ELIG_THRESHOLD", 10);
const ELIG_WINDOW_MS         = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS           = envI("ELIG_STEP_MS", 4000);

// Анти-спайк и подтверждение
const MIN_CONSEC_SAMPLES     = envI("MIN_CONSEC_SAMPLES", 2);
const SPIKE_RATIO            = envN("SPIKE_RATIO", 5);

// Instant режим: мгновенная отправка при достижении порога
const ELIG_INSTANT           = envI("ELIG_INSTANT", 1);
const INSTANT_MODE           = "stop";

// Telegram
const TG_BOT_TOKEN           = envS("TG_BOT_TOKEN", "");
const TG_CHAT_ID             = envS("TG_CHAT_ID", "");
const TG_SEND_PHOTO          = envI("TG_SEND_PHOTO", 1);
const TG_PLACEHOLDER_IMG     = envS("TG_PLACEHOLDER_IMG", "");
const TZ_LABEL               = envS("TIMEZONE", "Europe/Moscow");

/* ================== HELPERS ================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now   = () => Date.now();
function log(...a){ console.log(new Date().toISOString(), ...a); }

function fmtNum(n){ if (n == null || !Number.isFinite(Number(n))) return "n/a"; return Number(n).toLocaleString("en-US"); }
function fmtDur(ms){ return (ms/1000).toFixed(2) + "s"; }
function fmtDateTime(ts){
  const d = new Date(ts);
  const dt = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ_LABEL, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  }).format(d);
  return `${dt} (${TZ_LABEL})`;
}
const caShort = (mint) => !mint || mint.length < 8 ? (mint || "n/a") : `${mint.slice(0,4)}...${mint.slice(-4)}`;
function escapeHtml(s){ return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

/* ================== METRICS ================== */

const metrics = {
  api_req:0, api_ok:0, api_html:0, api_empty:0, api_parse:0, api_429:0, api_http:0, api_throw:0,
  ls_req:0, ls_ok:0, ls_304:0, ls_http:0, ls_429:0, ls_throw:0,
  decide_live:0, decide_not_live:0, decide_unknown:0,
  ws_events:0, ws_dups:0, ws_bumps:0,
  jobs_created:0, jobs_finished:0,
  final_checks:0,
  elig_started:0, elig_ok:0, elig_fail:0,
  lat_live: [],   // ms: WS → LIVE
  lat_elig: []    // ms: LIVE → ≥N
};
function pushLat(arr, v, cap=5000){ arr.push(v); if (arr.length > cap) arr.shift(); }
function percentile(sorted, p){ if (!sorted.length) return null; const idx = Math.floor((p/100)*(sorted.length-1)); return sorted[idx]; }

/* ================== RATE LIMITER ================== */

let minGapMs = Math.max(60, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttle(){
  const t = now();
  if (t < penaltyUntil) {
    const wait = Math.max(1000, penaltyUntil - t);
    await sleep(wait);
  }
  if (t < nextAllowedAt) await sleep(nextAllowedAt - t);
  const jitter = Math.max(-JITTER_MS, Math.min(JITTER_MS, (Math.random()*2 - 1) * JITTER_MS));
  nextAllowedAt = now() + minGapMs + jitter;
}

/* ================== FETCHERS ================== */

// coins — метаданные, редкий источник «онлайн» (use only if no better)
async function fetchCoin(mint){
  const url = `${API_COINS}/coins/${encodeURIComponent(mint)}`;
  try{
    await throttle();
    metrics.api_req++;
    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "user-agent": "pumplive/v13.0-zero-miss"
      }
    });

    if (r.status === 429){ metrics.api_429++; penaltyUntil = now() + PENALTY_AFTER_429_MS; return { ok:false, kind:"429", status:r.status }; }
    if (!r.ok){ metrics.api_http++; return { ok:false, kind:"http", status:r.status }; }

    const text = await r.text();
    if (!text || !text.trim()){ metrics.api_empty++; return { ok:false, kind:"empty" }; }
    if (text.trim()[0] === "<"){ metrics.api_html++; return { ok:false, kind:"html" }; }

    try{ const json = JSON.parse(text); metrics.api_ok++; return { ok:true, data:json }; }
    catch(e){ metrics.api_parse++; return { ok:false, kind:"parse", msg:e.message }; }

  }catch(e){ metrics.api_throw++; return { ok:false, kind:"throw", msg:e.message }; }
}

// livestream — источник правды для онлайна
const etags = new Map();         // mint -> ETag
const lastModified = new Map();  // mint -> Last-Modified
async function fetchLivestream(mintId){
  const url = `${API_LS}/livestream?mintId=${encodeURIComponent(mintId)}`;
  try{
    await throttle();
    metrics.ls_req++;
    const headers = { "accept":"application/json, text/plain, */*" };
    const et = etags.get(mintId); const lm = lastModified.get(mintId);
    if (et) headers["If-None-Match"] = et;
    if (lm) headers["If-Modified-Since"] = lm;

    const r = await fetch(url, { headers });
    if (r.status === 429){ metrics.ls_429++; penaltyUntil = now() + PENALTY_AFTER_429_MS; return { ok:false, kind:"429", status:r.status }; }
    if (r.status === 304){ metrics.ls_304++; return { ok:true, notModified:true, data:null, status:304 }; }
    if (!r.ok){ metrics.ls_http++; return { ok:false, kind:"http", status:r.status }; }

    const etNew = r.headers.get("etag"); const lmNew = r.headers.get("last-modified");
    if (etNew) etags.set(mintId, etNew);
    if (lmNew) lastModified.set(mintId, lmNew);

    const text = await r.text();
    if (!text || text.trim()[0] !== "{"){ metrics.ls_http++; return { ok:false, kind:"nonjson", status:r.status }; }
    const json = JSON.parse(text);
    metrics.ls_ok++;
    return { ok:true, data:json, status:r.status };

  }catch(e){ metrics.ls_throw++; return { ok:false, kind:"throw", msg:e.message }; }
}

/* ================== VIEWERS ================== */

function asNum(v){ return (typeof v === "number" && Number.isFinite(v)) ? v : null; }

// «онлайн» поля в coins (fallback)
function extractInstantFromCoin(c){
  const fields = [
    ["live_viewers", c?.live_viewers],
    ["viewers", c?.viewers],
    ["num_viewers", c?.num_viewers],
    ["room.viewers", c?.room?.viewers]
  ];
  for (const [src,val] of fields){
    const n = asNum(val); if (n !== null) return { v:n, src:`coins.${src}` };
  }
  return { v:null, src:null };
}

function decideFromCoin(c){
  const vObj = extractInstantFromCoin(c);
  const v = vObj.v;
  const liveFlag = (c?.is_currently_live === true) || (c?.inferred_live === true);
  if (liveFlag || (v !== null && v >= VIEWERS_THRESHOLD)){
    metrics.decide_live++;
    return { state:"live", viewers:v, liveFlag, reason: liveFlag ? "flag" : `viewers(${vObj.src})` };
  }
  const negativeFlags = (c?.is_currently_live === false) && (c?.inferred_live === false || typeof c?.inferred_live === "undefined");
  if (negativeFlags && (v === 0 || v === null)){
    metrics.decide_not_live++;
    return { state:"not_live", viewers:v, liveFlag:false, reason:"clean-false" };
  }
  metrics.decide_unknown++;
  return { state:"unknown", viewers:v, liveFlag: !!liveFlag, reason:"ambiguous" };
}

/* ================== DEDUP ================== */

const jobs = new Map();     // mint -> Job
const recently = new Map(); // дедуп WS

function markRecent(mint){ recently.set(mint, now()); }
function seenRecently(mint){
  const t = recently.get(mint);
  if (!t) return false;
  if (now() - t > DEDUP_TTL_MS){ recently.delete(mint); return false; }
  return true;
}

/* ================== TELEGRAM ================== */

async function tgApi(method, payload){
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
  const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!j?.ok){ log(`⚠️ TG ${method} fail: ${r.status} ${j?.description || ""}`); }
  return j;
}
async function sendTGMessage(textHtml){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID){ log("⚠️ TG creds missing: message not sent"); return { ok:false }; }
  return tgApi("sendMessage", { chat_id: TG_CHAT_ID, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true });
}
function normalizeIpfs(u){
  if (!u || typeof u !== "string") return null;
  u = u.trim(); if (!u) return null;
  if (u.startsWith("ipfs://")) return `https://cloudflare-ipfs.com/ipfs/${u.replace(/^ipfs:\/\//, "")}`;
  return u;
}
function pickImageCandidates(coin){
  const fields = [ coin?.image_url, coin?.imageUrl, coin?.image, coin?.imageURI, coin?.image_uri,
    coin?.metadata?.image, coin?.twitter_pfp, coin?.twitter_profile_image_url, coin?.icon, coin?.logo ];
  const out = [];
  for (const f of fields){ const u = normalizeIpfs(f); if (u && /^https?:\/\//i.test(u)) out.push(u); }
  if (TG_PLACEHOLDER_IMG) out.push(TG_PLACEHOLDER_IMG);
  return [...new Set(out)];
}
async function downloadImage(url){
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 pumplive" } });
  if (!r.ok) { log(`🖼️ img http ${r.status} | ${url}`); return null; }
  const ct = r.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) { log(`🖼️ img bad type ${ct} | ${url}`); return null; }
  const ab = await r.arrayBuffer();
  const max = 9.5 * 1024 * 1024;
  if (ab.byteLength > max) { log(`🖼️ img too big ${ab.byteLength} | ${url}`); return null; }
  const ext = (ct.split("/")[1] || "jpg").split(";")[0];
  return { buffer: Buffer.from(ab), contentType: ct, filename: `cover.${ext}` };
}
async function sendPhotoWithFallback(captionHtml, urls){
  if (!TG_SEND_PHOTO || !TG_BOT_TOKEN || !TG_CHAT_ID){
    await sendTGMessage(captionHtml);
    return;
  }
  for (const url of urls){
    const direct = await tgApi("sendPhoto", {
      chat_id: TG_CHAT_ID, photo: url, caption: captionHtml, parse_mode: "HTML"
    });
    if (direct?.ok){ log(`🖼️ TG photo: direct OK | ${url}`); return; }

    try{
      const img = await downloadImage(url);
      if (!img) continue;
      const form = new FormData();
      form.append("chat_id", TG_CHAT_ID);
      form.append("caption", captionHtml);
      form.append("parse_mode", "HTML");
      form.append("photo", img.buffer, { filename: img.filename, contentType: img.contentType });

      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, headers: form.getHeaders() });
      const j = await r.json().catch(()=> ({}));
      if (j?.ok){ log(`🖼️ TG photo: upload OK | ${url}`); return; }
      log(`⚠️ TG upload fail ${r.status} ${j?.description || ""}`);
    }catch(e){
      log(`⚠️ TG upload error: ${e.message}`);
    }
  }
  log("ℹ️ TG photo fallback → text only");
  await sendTGMessage(captionHtml);
}

/* ================== MESSAGE BUILDER ================== */

function pickWebsite(coin){
  const cand = [ coin?.website_url, coin?.website, coin?.links?.website, coin?.metadata?.website, coin?.socials?.website, coin?.site ].filter(Boolean);
  return cand.find(u => /^https?:\/\//i.test(u)) || null;
}
function pickTwitter(coin){
  const cand = [ coin?.twitter_url, coin?.twitter_profile, coin?.twitter, coin?.twitter_handle, coin?.socials?.twitter ].filter(Boolean);
  for (let u of cand){ if (!u) continue; if (/^https?:\/\//i.test(u)) return u; if (u.startsWith("@")) u = u.slice(1); return `https://twitter.com/${u}`; }
  return null;
}
function pickInstagram(coin){
  const cand = [ coin?.instagram_url, coin?.instagram, coin?.socials?.instagram ].filter(Boolean);
  for (let u of cand){ if (!u) continue; if (/^https?:\/\//i.test(u)) return u; if (u.startsWith("@")) u = u.slice(1); return `https://instagram.com/${u}`; }
  return null;
}

function buildCaption(coin, j, elig){
  const name   = coin?.name || "";
  const symbol = coin?.symbol || "";
  const title  = `${name}${symbol ? ` (${symbol})` : ""}` || "Live on pump.fun";

  const line1  = `🟢 <b>LIVE ≥${ELIG_THRESHOLD}</b> | ${escapeHtml(title)}`;
  const lineTs = `🕒 <b>${fmtDateTime(now())}</b>`;

  const viewersLine = `👁️ Viewers: <b>${fmtNum(elig.peak)}</b> (peak in ${Math.floor(ELIG_WINDOW_MS/1000)}s, src=${j.viewerSrc || "n/a"})`;
  const latLine     = `⏱️ <b>+${fmtDur(j.liveAt - j.t0)}</b> от WS → LIVE, <b>+${fmtDur(elig.hitAt - j.liveAt)}</b> от LIVE → ≥${ELIG_THRESHOLD}`;

  const axiom = `🔗 Axiom:\nhttps://axiom.trade/t/${j.mint}`;
  const mint  = `🧬 Mint (CA):\n<code>${j.mint}</code>`;

  const lines = [line1, lineTs, mint, viewersLine, latLine, axiom];

  const www = pickWebsite(coin); if (www) lines.push(`🌐 Website: ${www}`);
  const ig  = pickInstagram(coin); if (ig)  lines.push(`📸 Instagram: ${ig}`);
  const tw  = pickTwitter(coin);   if (tw)  lines.push(`🐦 Twitter: ${tw}`);

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
    closed: false,

    // eligibility state
    eligStarted: false,
    eligDone: false,
    eligHitAt: null,
    eligPeak: 0,
    eligOkSamples: 0,
    eligConsecOk: 0,
    eligTotalSamples: 0,
    eligTickIndex: 0,
    eligTotalTicks: Math.max(1, Math.ceil(ELIG_WINDOW_MS / Math.max(1, ELIG_STEP_MS))),
    coinSnap: null,

    // viewers source lock
    viewerSrc: null,      // "ls.numParticipants" / "coins.viewers" / ...
    lastViewer: null
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
    try{ await fn(j, label); }catch(e){ log(`⚠️ job error [${label}] ${e.message}`); }
  }, delay);
  j.timeouts.add(id);
}

/* ================== ELIGIBILITY (≥N/window) ================== */

function lockViewerSrc(j, src){ if (!j.viewerSrc && src) j.viewerSrc = src; }

async function readViewers(j){
  // 1) Пытаемся livestream
  const r1 = await fetchLivestream(j.mint);
  if (r1.ok){
    if (r1.notModified){
      return { v: j.lastViewer, src: "ls.numParticipants (304)" };
    }
    const v = asNum(r1.data?.numParticipants);
    if (v !== null){
      lockViewerSrc(j, "ls.numParticipants");
      return { v, src: "ls.numParticipants" };
    }
  }
  // 2) Fallback: coins «онлайн» поля (не participants/unique)
  const r2 = await fetchCoin(j.mint);
  if (r2.ok){
    j.coinSnap = j.coinSnap || r2.data;
    const { v, src } = extractInstantFromCoin(r2.data || {});
    if (v !== null){
      lockViewerSrc(j, src);
      return { v, src };
    }
  }
  // 3) Ничего не вышло
  return { v:null, src:null };
}

function startEligibility(j, coin){
  if (j.eligStarted) return;
  j.eligStarted = true;
  j.coinSnap = coin || j.coinSnap;
  metrics.elig_started++;

  const windowEnd = now() + ELIG_WINDOW_MS;
  log(`🎯 ELIG start ${Math.floor(ELIG_WINDOW_MS/1000)}s | ca=${caShort(j.mint)} | thr=${ELIG_THRESHOLD} | step=${Math.floor(ELIG_STEP_MS/1000)}s | ticks=${j.eligTotalTicks}`);

  const instantSendAndStop = async () => {
    const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
    const latLiveMs = j.liveAt - j.t0;
    const latEligMs = j.eligHitAt - j.liveAt;
    pushLat(metrics.lat_live, latLiveMs);
    pushLat(metrics.lat_elig, latEligMs);
    metrics.elig_ok++;

    log(`⚡ INSTANT ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | src=${j.viewerSrc} | hit@+${fmtDur(latEligMs)} от LIVE (+${fmtDur(latLiveMs)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${j.eligTickIndex}`);

    const caption = buildCaption(j.coinSnap || {}, j, res);
    const imgs = pickImageCandidates(j.coinSnap || {});
    await sendPhotoWithFallback(caption, imgs);

    log(`🛑 INSTANT-STOP | <mint=${j.mint}> | уведомлено, окно закрыто на ${j.eligTickIndex}/${j.eligTotalTicks}`);
    clearJob(j);
  };

  const tick = async () => {
    if (j.closed || j.eligDone) return;

    const step = Math.max(1, ELIG_STEP_MS);

    const { v, src } = await readViewers(j);
    let viewers = v; let source = src;

    j.eligTotalSamples++;
    j.eligTickIndex = Math.min(j.eligTickIndex + 1, j.eligTotalTicks);

    // анти-спайк: одиночные огромные скачки при prev<N не засчитываем
    let spike = false;
    if (j.lastViewer != null && viewers != null && j.lastViewer < ELIG_THRESHOLD){
      const ratio = (viewers+1e-9)/(j.lastViewer+1e-9);
      if (ratio >= SPIKE_RATIO){ spike = true; }
    }

    if (viewers != null){
      j.eligPeak = Math.max(j.eligPeak, viewers);
      if (!spike && viewers >= ELIG_THRESHOLD){
        j.eligOkSamples++;
        j.eligConsecOk++;
        if (!j.eligHitAt) j.eligHitAt = now();
      }else if (!spike){
        j.eligConsecOk = 0;
      }
    }else{
      // неизвестно — не сбрасываем consec, но и не увеличиваем
    }

    const spTxt = spike ? " SP!KE" : "";
    log(`⏱️ stabilize ${j.eligTickIndex}/${j.eligTotalTicks} | ca=${caShort(j.mint)} | viewers=${viewers ?? "n/a"} | src=${source || "n/a"} | ok=${j.eligOkSamples} | consec=${j.eligConsecOk}${spTxt}`);

    j.lastViewer = viewers;

    // INSTANT SEND + STOP
    if (ELIG_INSTANT && j.eligConsecOk >= MIN_CONSEC_SAMPLES){
      j.eligDone = true;
      await instantSendAndStop();
      return;
    }

    if (now() < windowEnd && j.eligTickIndex < j.eligTotalTicks){
      schedule(j, "elig-tick", now() + step, () => tick());
    }else{
      j.eligDone = true;
      if (j.eligHitAt){
        const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
        const latLiveMs = j.liveAt - j.t0;
        const latEligMs = j.eligHitAt - j.liveAt;
        pushLat(metrics.lat_live, latLiveMs);
        pushLat(metrics.lat_elig, latEligMs);
        metrics.elig_ok++;

        log(`✅ ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | src=${j.viewerSrc} | hit@+${fmtDur(latEligMs)} от LIVE (+${fmtDur(latLiveMs)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${j.eligTotalSamples}`);

        const caption = buildCaption(j.coinSnap || {}, j, res);
        const imgs = pickImageCandidates(j.coinSnap || {});
        await sendPhotoWithFallback(caption, imgs);
      }else{
        metrics.elig_fail++;
        log(`🚫 NOT ELIGIBLE (<${ELIG_THRESHOLD} за ${Math.floor(ELIG_WINDOW_MS/1000)}s) | ${j.mint} | src=${j.viewerSrc || "n/a"} | max=${j.eligPeak} | valid=${j.eligOkSamples}/${j.eligTotalSamples} | firstLIVE@+${fmtDur(j.liveAt - j.t0)}`);
      }
      clearJob(j);
    }
  };

  // первый тик — сразу
  schedule(j, "elig-tick", now() + 1, () => tick());
}

/* ================== PROBE SLOTS (используем livestream в приоритете) ================== */

async function slotProbe(j, label){
  let localLive = false;
  let lastCoin = null;

  for (let i=0; i<QUICK_ATTEMPTS; i++){
    // 1) livestream: если isLive=true — считаем live сразу
    const rls = await fetchLivestream(j.mint);
    if (rls.ok && !rls.notModified){
      const live = rls.data?.isLive === true;
      const v = asNum(rls.data?.numParticipants);
      if (live){
        if (!j.liveAt){
          j.liveAt = now();
          lockViewerSrc(j, "ls.numParticipants");
          j.lastViewer = v;
          log(`🔥 LIVE | ${j.mint} | src=ls.numParticipants | v=${v ?? "n/a"} | +${fmtDur(j.liveAt - j.t0)} от WS → candidate`);
          startEligibility(j, j.coinSnap); // coinSnap может подтянуться позже
        }
        j.liveHit = true;
        localLive = true;
        break;
      }
    }

    // 2) fallback coin-флаги
    const rc = await fetchCoin(j.mint);
    if (rc.ok){
      const coin = rc.data || {};
      lastCoin = coin;
      const dec = decideFromCoin(coin);
      if (dec.state === "live"){
        if (!j.liveAt){
          j.liveAt = now();
          j.lastViewer = dec.viewers;
          lockViewerSrc(j, dec.reason.includes("viewers(") ? dec.reason.split("(")[1]?.replace(")","") : "coins.flag");
          log(`🔥 LIVE | ${j.mint} | ${coin?.symbol ? coin.symbol+" " : ""}(${coin?.name || "no-name"}) | v=${dec.viewers ?? "n/a"} | reason=${dec.reason} | +${fmtDur(j.liveAt - j.t0)} от WS → candidate`);
          startEligibility(j, coin);
        }
        j.liveHit = true;
        localLive = true;
        break;
      }else{
        log(`… not live | ${j.mint} | slot=${label} | reason=${dec.reason} | viewers=${dec.viewers ?? "n/a"}`);
      }
    }else{
      log(`❌ fetch error: ${rc.kind}${rc.status ? " "+rc.status:""} | mint: ${j.mint}`);
    }

    if (i < QUICK_ATTEMPTS-1) await sleep(QUICK_STEP_MS);
  }

  return { localLive, lastCoin };
}

async function runStage(j, stage){
  if (j.closed) return;

  await slotProbe(j, stage);
  if (j.closed) return;

  if (j.liveHit) return;

  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  }else if (stage === "second"){
    schedule(j, "third",  j.t0 + THIRD_CHECK_DELAY_MS,  runStage);
  }else if (stage === "third"){
    metrics.final_checks++;
    log(`↪️  schedule FINAL | ${j.mint}`);
    schedule(j, "final",  j.t0 + FINAL_CHECK_DELAY_MS,  runFinal);
  }
}

async function runFinal(j){
  if (j.closed) return;
  await slotProbe(j, "final");
  if (j.closed) return;

  if (j.liveHit) return;
  log(`🧹 final skip not_live | ${j.mint}`);
  clearJob(j);
}

/* ================== WS ================== */

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
  ws.on("close", () => { log("WS closed → reconnect in 3s"); setTimeout(connectWS, 3000); });
  ws.on("error", (e) => { log("WS error:", e?.message || e); });
}

/* ================== HEARTBEAT ================== */

setInterval(() => {
  const active = jobs.size;
  const l1 = metrics.lat_live.slice().sort((a,b)=>a-b);
  const l2 = metrics.lat_elig.slice().sort((a,b)=>a-b);
  const p50L = percentile(l1,50), p95L = percentile(l1,95);
  const p50E = percentile(l2,50), p95E = percentile(l2,95);

  log(
    `[stats] active=${active}`,
    `http(coins): req=${metrics.api_req} ok=${metrics.api_ok} 429=${metrics.api_429} http=${metrics.api_http} html=${metrics.api_html} empty=${metrics.api_empty} parse=${metrics.api_parse} throw=${metrics.api_throw}`,
    `http(ls): req=${metrics.ls_req} ok=${metrics.ls_ok} 304=${metrics.ls_304} 429=${metrics.ls_429} http=${metrics.ls_http} throw=${metrics.ls_throw}`,
    `decide: live=${metrics.decide_live} not_live=${metrics.decide_not_live} unknown=${metrics.decide_unknown}`,
    `ws: events=${metrics.ws_events} dups=${metrics.ws_dups} bumps=${metrics.ws_bumps}`,
    `jobs: new=${metrics.jobs_created} done=${metrics.jobs_finished} final=${metrics.final_checks}`,
    `elig: started=${metrics.elig_started} ok=${metrics.elig_ok} fail=${metrics.elig_fail}`,
    `| lat(LIVE) p50=${p50L?fmtDur(p50L):"n/a"} p95=${p95L?fmtDur(p95L):"n/a"}`,
    `| lat(≥${ELIG_THRESHOLD}) p50=${p50E?fmtDur(p50E):"n/a"} p95=${p95E?fmtDur(p95E):"n/a"}`
  );
}, HEARTBEAT_MS);

/* ================== START ================== */

log("Zero-miss watcher starting…",
  "| THR=", VIEWERS_THRESHOLD,
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS,
  "| ELIG=", `≥${ELIG_THRESHOLD} for ${Math.floor(ELIG_WINDOW_MS/1000)}s step ${Math.floor(ELIG_STEP_MS/1000)}s (minConsec=${MIN_CONSEC_SAMPLES}, spike>${SPIKE_RATIO}x filtered)`,
  "| INSTANT=", ELIG_INSTANT ? `on (mode=${INSTANT_MODE})` : "off",
  "| TZ=", TZ_LABEL
);

connectWS();

/* ================== Graceful ================== */
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
