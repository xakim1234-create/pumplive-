import process from "node:process";
import WebSocket from "ws";
import fetch from "node-fetch";
import FormData from "form-data";

/* ================== CONFIG (ENV) ================== */
const envI = (k, d) => { const v = parseInt(process.env[k] || "", 10); return Number.isFinite(v) ? v : d; };
const envN = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const envS = (k, d) => { const v = (process.env[k] || "").trim(); return v || d; };

// Endpoints
const WS_URL   = envS("PUMP_WS_URL", "wss://pumpportal.fun/api/data");
const API_COIN = envS("PUMP_API",    "https://frontend-api-v3.pump.fun");
const API_LS   = envS("PUMP_LS_API", "https://livestream-api.pump.fun");

// WS → multi-stage (first/second/third → final)
const FIRST_CHECK_DELAY_MS  = envI("FIRST_CHECK_DELAY_MS", 6000);
const SECOND_CHECK_DELAY_MS = envI("SECOND_CHECK_DELAY_MS", 12000);
const THIRD_CHECK_DELAY_MS  = envI("THIRD_CHECK_DELAY_MS", 18000);
const FINAL_CHECK_DELAY_MS  = envI("FINAL_CHECK_DELAY_MS", 48000);

// Quick probe per slot
const QUICK_ATTEMPTS        = envI("QUICK_ATTEMPTS", 1);
const QUICK_STEP_MS         = envI("QUICK_STEP_MS", 1200);

// Eligibility window (≥N viewers)
const ELIG_THRESHOLD        = envI("ELIG_THRESHOLD", 10);
const ELIG_WINDOW_MS        = envI("ELIG_WINDOW_MS", 30000);
const ELIG_STEP_MS          = envI("ELIG_STEP_MS", 3000);

// Instant send mode
const ELIG_INSTANT          = envI("ELIG_INSTANT", 1);  // 1 = on
const MIN_CONSEC_SAMPLES    = envI("MIN_CONSEC_SAMPLES", 2);

// Anti-spike
const SPIKE_RATIO           = envN("SPIKE_RATIO", 2.0);
const SPIKE_MIN_ABS         = envI("SPIKE_MIN_ABS", 6);

// Rate limit
const GLOBAL_RPS            = envN("GLOBAL_RPS", 3);
const JITTER_MS             = envI("JITTER_MS", 120);
const PENALTY_AFTER_429_MS  = envI("PENALTY_AFTER_429_MS", 90000);

// WS dedup / bumps
const DEDUP_TTL_MS          = envI("DEDUP_TTL_MS", 600000);
const WS_BUMP_WINDOW_MS     = envI("WS_BUMP_WINDOW_MS", 15000);

// Heartbeat
const HEARTBEAT_MS          = envI("HEARTBEAT_MS", 30000);

// Telegram
const TG_BOT_TOKEN          = envS("TG_BOT_TOKEN", "");
const TG_CHAT_ID            = envS("TG_CHAT_ID",   "");
const TG_SEND_PHOTO         = envI("TG_SEND_PHOTO", 1);
const TG_PLACEHOLDER_IMG    = envS("TG_PLACEHOLDER_IMG", "");
const TZ_LABEL              = envS("TIMEZONE", "Europe/Moscow");

/* ================== UTILS ================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now   = () => Date.now();
const log   = (...a) => console.log(new Date().toISOString(), ...a);

const fmtNum = (n) => (n == null || !Number.isFinite(Number(n))) ? "n/a" : Number(n).toLocaleString("en-US");
const fmtDur = (ms) => (ms/1000).toFixed(2) + "s";
function fmtDateTime(ts){
  const d = new Date(ts);
  const dt = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ_LABEL, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  }).format(d);
  return `${dt} (${TZ_LABEL})`;
}
const caShort = (mint) => (!mint || mint.length < 8) ? (mint || "n/a") : `${mint.slice(0,4)}...${mint.slice(-4)}`;
const escapeHtml = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

/* ================== METRICS ================== */
const metrics = {
  http_coin: { req:0, ok:0, html:0, empty:0, parse:0, http:0, _429:0, throw:0 },
  http_ls:   { req:0, ok:0, http:0, _429:0, throw:0 },
  decide: { live:0, not_live:0, unknown:0 },
  ws: { events:0, dups:0, bumps:0 },
  jobs: { new:0, done:0, final:0 },
  elig: { started:0, ok:0, fail:0 },
  lat_live: [],
  lat_elig: []
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

/* ================== HTTP: COIN & LIVESTREAM ================== */
async function fetchCoin(mint){
  const url = `${API_COIN}/coins/${encodeURIComponent(mint)}?_=${Date.now()}&n=${Math.random().toString(36).slice(2,8)}`;
  try{
    await throttle();
    metrics.http_coin.req++;
    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
        "user-agent": "pumplive/no304"
      }
    });
    if (r.status === 429){ metrics.http_coin._429++; penaltyUntil = now() + PENALTY_AFTER_429_MS; return { ok:false, kind:"429", status:r.status }; }
    if (!r.ok){ metrics.http_coin.http++; return { ok:false, kind:"http", status:r.status }; }
    const text = await r.text();
    if (!text || !text.trim()){ metrics.http_coin.empty++; return { ok:false, kind:"empty" }; }
    if (text.trim()[0] === "<"){ metrics.http_coin.html++; return { ok:false, kind:"html" }; }
    try{ const json = JSON.parse(text); metrics.http_coin.ok++; return { ok:true, data:json, status:r.status }; }
    catch(e){ metrics.http_coin.parse++; return { ok:false, kind:"parse", msg:e.message }; }
  }catch(e){ metrics.http_coin.throw++; return { ok:false, kind:"throw", msg:e.message }; }
}

async function fetchLs(mint){
  const url = `${API_LS}/livestream?mintId=${encodeURIComponent(mint)}&_=${Date.now()}&n=${Math.random().toString(36).slice(2,8)}`;
  try{
    await throttle();
    metrics.http_ls.req++;
    const r = await fetch(url, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
        "user-agent": "pumplive/no304"
      }
    });
    if (r.status === 429){ metrics.http_ls._429++; penaltyUntil = now() + PENALTY_AFTER_429_MS; return { ok:false, status:429, kind:"429" }; }
    if (!r.ok){ metrics.http_ls.http++; return { ok:false, status:r.status, kind:"http" }; }
    const j = await r.json().catch(()=> null);
    if (!j || typeof j !== "object"){ metrics.http_ls.http++; return { ok:false, status:r.status, kind:"badjson" }; }
    metrics.http_ls.ok++;
    return { ok:true, data:j, status:r.status };
  }catch(e){ metrics.http_ls.throw++; return { ok:false, kind:"throw", msg:e.message }; }
}

/* ================== VIEWERS / DECISION ================== */
const asNum = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;
function extractViewersCoin(c){
  const candidates = [ c?.num_participants, c?.viewers, c?.num_viewers, c?.live_viewers, c?.participants, c?.unique_viewers, c?.room?.viewers ];
  for (const x of candidates){ const n = asNum(x); if (n !== null) return n; }
  return null;
}
function decideFromCoin(c){
  const viewers = extractViewersCoin(c);
  const liveFlag = (c?.is_currently_live === true) || (c?.inferred_live === true);
  if (liveFlag || (viewers !== null && viewers >= 1)) { metrics.decide.live++; return { state:"live", viewers, src: liveFlag?"coin.flag":"coin.viewers" }; }
  const negative = (c?.is_currently_live === false) && (c?.inferred_live !== true);
  if (negative && (viewers === 0 || viewers === null)) { metrics.decide.not_live++; return { state:"not_live", viewers:null, src:"coin.clean-false" }; }
  metrics.decide.unknown++; return { state:"unknown", viewers, src:"coin.ambiguous" };
}
function decideFromLs(ls){
  const live = !!ls?.isLive;
  const viewers = asNum(ls?.numParticipants);
  if (live){ metrics.decide.live++; return { state:"live", viewers: viewers ?? 0, src:"ls.numParticipants" }; }
  metrics.decide.not_live++; return { state:"not_live", viewers:null, src:"ls.notlive" };
}

/* ================== DEDUP ================== */
const recently = new Map(); // mint -> ts
function markRecent(mint){ recently.set(mint, now()); }
function seenRecently(mint){ const t = recently.get(mint); if (!t) return false; if (now() - t > DEDUP_TTL_MS){ recently.delete(mint); return false; } return true; }

/* ================== TELEGRAM ================== */
async function tgApi(method, payload){
  if (!TG_BOT_TOKEN) { log("⚠️ TG token missing"); return { ok:false }; }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!j?.ok){ log(`⚠️ TG ${method} fail: ${r.status} ${j?.description || ""}`); }
  return j;
}
async function sendTGMessage(textHtml){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID){ log("⚠️ TG creds missing: message not sent"); return { ok:false }; }
  return tgApi("sendMessage", { chat_id: TG_CHAT_ID, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true });
}
function normalizeIpfs(u){ if (!u || typeof u !== "string") return null; u = u.trim(); if (!u) return null; if (u.startsWith("ipfs://")){ const cid = u.replace(/^ipfs:\/\//, ""); return `https://cloudflare-ipfs.com/ipfs/${cid}`; } return u; }
function pickImageCandidates(coin){
  const fields = [ coin?.image_url, coin?.imageUrl, coin?.image, coin?.imageURI, coin?.image_uri, coin?.metadata?.image, coin?.twitter_pfp, coin?.twitter_profile_image_url, coin?.icon, coin?.logo, coin?.image_uri ];
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
  if (!TG_SEND_PHOTO || !TG_BOT_TOKEN || !TG_CHAT_ID || !urls?.length){ await sendTGMessage(captionHtml); return; }
  for (const url of urls){
    const direct = await tgApi("sendPhoto", { chat_id: TG_CHAT_ID, photo: url, caption: captionHtml, parse_mode: "HTML" });
    if (direct?.ok){ log(`🖼️ TG photo: direct OK | ${url}`); return; }
    try{
      const img = await downloadImage(url); if (!img) continue;
      const form = new FormData();
      form.append("chat_id", TG_CHAT_ID);
      form.append("caption", captionHtml);
      form.append("parse_mode", "HTML");
      form.append("photo", img.buffer, { filename: img.filename, contentType: img.contentType });
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
      const j = await r.json().catch(()=> ({}));
      if (j?.ok){ log(`🖼️ TG photo: upload OK | ${url}`); return; }
      log(`⚠️ TG upload fail ${r.status} ${j?.description || ""}`);
    }catch(e){ log(`⚠️ TG upload error: ${e.message}`); }
  }
  log("ℹ️ TG photo fallback → text only");
  await sendTGMessage(captionHtml);
}
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
  const name = coin?.name || ""; const symbol = coin?.symbol || "";
  const title = `${name}${symbol ? ` (${symbol})` : ""}` || "Live on pump.fun";
  const line1 = `🟢 <b>LIVE ≥${ELIG_THRESHOLD}</b> | ${escapeHtml(title)}`;
  const lineTs = `🕒 <b>${fmtDateTime(now())}</b>`;
  const tickLine = `🧭 Tick: <b>${j.eligTickIndex}/${j.eligTotalTicks}</b>`;
  const viewersLine = `👁️ Viewers: <b>${fmtNum(elig.peak)}</b> (peak in ${Math.floor(ELIG_WINDOW_MS/1000)}s)`;
  const latLine = `⏱️ <b>+${fmtDur(j.liveAt - j.t0)}</b> от WS → LIVE, <b>+${fmtDur(elig.hitAt - j.liveAt)}</b> от LIVE → ≥${ELIG_THRESHOLD}`;
  const axiom = `🔗 Axiom:\nhttps://axiom.trade/t/${j.mint}`;
  const mint = `🧬 Mint (CA):\n<code>${j.mint}</code>`;
  const lines = [line1, lineTs, mint, tickLine, viewersLine, latLine, axiom];
  const www = pickWebsite(coin); if (www) lines.push(`🌐 Website: ${www}`);
  const ig = pickInstagram(coin); if (ig) lines.push(`📸 Instagram: ${ig}`);
  const tw = pickTwitter(coin); if (tw) lines.push(`🐦 Twitter: ${tw}`);
  return lines.join("\n");
}

/* ================== JOB MODEL ================== */
const jobs = new Map();
function newJob(mint){
  const j = {
    mint,
    t0: now(),
    timeouts: new Set(),
    closed: false,
    liveHit: false,
    liveAt: null,
    viewerSrc: null,
    eligStarted: false,
    eligDone: false,
    eligHitAt: null,
    eligPeak: 0,
    eligOkSamples: 0,
    eligConsecOk: 0,
    eligTotalSamples: 0,
    eligTickIndex: 0,
    eligTotalTicks: Math.max(1, Math.ceil(ELIG_WINDOW_MS / Math.max(1, ELIG_STEP_MS))),
    lastViewers: null,
    coinSnap: null
  };
  jobs.set(mint, j); metrics.jobs.new++;
  return j;
}
function clearJob(j){ j.closed = true; for (const id of j.timeouts) clearTimeout(id); j.timeouts.clear(); jobs.delete(j.mint); metrics.jobs.done++; }
function schedule(j, label, atMs, fn){
  const delay = Math.max(0, atMs - now());
  const id = setTimeout(async () => {
    j.timeouts.delete(id);
    if (j.closed) return;
    try{ await fn(j, label); }catch(e){ log(`⚠️ job error [${label}] ${e.message}`); }
  }, delay);
  j.timeouts.add(id);
}

/* ================== ELIGIBILITY ================== */
function startEligibility(j, coin){
  if (j.eligStarted) return;
  j.eligStarted = true; metrics.elig.started++;
  if (coin && !j.coinSnap) j.coinSnap = coin;
  const windowEnd = now() + ELIG_WINDOW_MS;
  log(`🎯 ELIG start ${Math.floor(ELIG_WINDOW_MS/1000)}s | ca=${caShort(j.mint)} | thr=${ELIG_THRESHOLD} | step=${Math.floor(ELIG_STEP_MS/1000)}s | ticks=${j.eligTotalTicks}`);

  const instantSendAndStop = async () => {
    const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
    pushLat(metrics.lat_live, j.liveAt - j.t0);
    pushLat(metrics.lat_elig, j.eligHitAt - j.liveAt);
    metrics.elig.ok++;
    if (!j.coinSnap){ const rc = await fetchCoin(j.mint); if (rc.ok) j.coinSnap = rc.data; }
    const caption = buildCaption(j.coinSnap || {}, j, res);
    const imgs = pickImageCandidates(j.coinSnap || {});
    if (!imgs.length && TG_PLACEHOLDER_IMG) imgs.push(TG_PLACEHOLDER_IMG);
    await sendPhotoWithFallback(caption, imgs);
    log(`🛑 INSTANT-STOP | <mint=${j.mint}> | уведомлено, окно закрыто на ${j.eligTickIndex}/${j.eligTotalTicks}`);
    clearJob(j);
  };

  const tick = async () => {
    if (j.closed || j.eligDone) return;
    const step = Math.max(1, ELIG_STEP_MS);
    let viewers = null, src = "n/a", httpCode = 0, spike = false;

    // Prefer livestream-api always
    const rls = await fetchLs(j.mint);
    if (rls.ok){
      const dec = decideFromLs(rls.data);
      src = dec.src; httpCode = rls.status || 200;
      if (dec.state === "live"){ viewers = asNum(dec.viewers); if (!j.liveAt){ j.liveAt = now(); j.viewerSrc = dec.src; j.liveHit = true; } }
    } else {
      const rc = await fetchCoin(j.mint);
      if (rc.ok){
        const dc = decideFromCoin(rc.data);
        src = dc.src; httpCode = rc.status || 200;
        if (dc.state === "live"){ viewers = asNum(dc.viewers) ?? 0; if (!j.liveAt){ j.liveAt = now(); j.viewerSrc = dc.src; j.liveHit = true; } if (!j.coinSnap) j.coinSnap = rc.data; }
      } else {
        src = `${rls.kind || rc.kind || 'err'}`; httpCode = rls.status || rc.status || 0;
      }
    }

    j.eligTotalSamples++;
    j.eligTickIndex = Math.min(j.eligTickIndex + 1, j.eligTotalTicks);

    if (viewers !== null){
      j.eligPeak = Math.max(j.eligPeak, viewers);
      const prev = j.lastViewers;
      if (prev != null && prev < ELIG_THRESHOLD && viewers >= ELIG_THRESHOLD){
        const bigJump = (viewers >= prev * SPIKE_RATIO) && ((viewers - prev) >= SPIKE_MIN_ABS);
        if (bigJump) spike = true;
      }
      if (!spike && viewers >= ELIG_THRESHOLD){
        j.eligOkSamples++; j.eligConsecOk++; if (!j.eligHitAt) j.eligHitAt = now();
      } else if (!spike) {
        j.eligConsecOk = 0;
      }
    }

    const sp = spike ? " SP!KE" : "";
    log(`⏱️ stabilize ${j.eligTickIndex}/${j.eligTotalTicks} | ca=${caShort(j.mint)} | viewers=${viewers ?? 'n/a'} | src=${src} (${httpCode||'?'}) | ok=${j.eligOkSamples} | consec=${j.eligConsecOk}${sp}`);
    j.lastViewers = (viewers !== null) ? viewers : j.lastViewers;

    // INSTANT
    if (ELIG_INSTANT && j.eligConsecOk >= MIN_CONSEC_SAMPLES){ j.eligDone = true; await instantSendAndStop(); return; }

    // Continue or finalize
    if (now() < windowEnd && j.eligTickIndex < j.eligTotalTicks){
      schedule(j, "elig-tick", now() + step, () => tick());
    } else {
      j.eligDone = true;
      if (j.eligHitAt){
        const res = { peak: j.eligPeak, hitAt: j.eligHitAt };
        pushLat(metrics.lat_live, j.liveAt - j.t0);
        pushLat(metrics.lat_elig, j.eligHitAt - j.liveAt);
        metrics.elig.ok++;
        if (!j.coinSnap){ const rc = await fetchCoin(j.mint); if (rc.ok) j.coinSnap = rc.data; }
        const caption = buildCaption(j.coinSnap || {}, j, res);
        const imgs = pickImageCandidates(j.coinSnap || {});
        if (!imgs.length && TG_PLACEHOLDER_IMG) imgs.push(TG_PLACEHOLDER_IMG);
        await sendPhotoWithFallback(caption, imgs);
        log(`✅ ELIGIBLE (≥${ELIG_THRESHOLD}) | ${j.mint} | hit@+${fmtDur(j.eligHitAt - j.liveAt)} от LIVE (+${fmtDur(j.liveAt - j.t0)} от WS) | max=${j.eligPeak} | samples=${j.eligOkSamples}/${j.eligTickIndex}`);
      } else {
        metrics.elig.fail++;
        log(`🚫 NOT ELIGIBLE (<${ELIG_THRESHOLD} за ${Math.floor(ELIG_WINDOW_MS/1000)}s) | ${j.mint} | max=${j.eligPeak} | valid=${j.eligOkSamples}/${j.eligTickIndex} | firstLIVE@+${fmtDur(j.liveAt - j.t0)}`);
      }
      clearJob(j);
    }
  };

  // first tick immediately
  schedule(j, "elig-tick", now() + 1, () => tick());
}

/* ================== STAGES / PROBES ================== */
async function slotProbe(j, label){
  for (let i=0; i<QUICK_ATTEMPTS; i++){
    const rls = await fetchLs(j.mint);
    if (rls.ok){
      const dec = decideFromLs(rls.data);
      if (dec.state === "live"){
        if (!j.liveAt){ j.liveAt = now(); j.viewerSrc = dec.src; log(`🔥 LIVE | ${j.mint} | src=${dec.src} | v=${dec.viewers ?? 'n/a'} | +${fmtDur(j.liveAt - j.t0)} от WS → candidate`); }
        j.liveHit = true; startEligibility(j, null); return;
      }
    }
    const rc = await fetchCoin(j.mint);
    if (rc.ok){
      const dec = decideFromCoin(rc.data);
      if (dec.state === "live"){
        if (!j.liveAt){ j.liveAt = now(); j.viewerSrc = dec.src; j.coinSnap = rc.data; log(`🔥 LIVE | ${j.mint} | src=${dec.src} | v=${dec.viewers ?? 'n/a'} | +${fmtDur(j.liveAt - j.t0)} от WS → candidate`); }
        j.liveHit = true; startEligibility(j, rc.data); return;
      }
    }
    if (i < QUICK_ATTEMPTS-1) await sleep(QUICK_STEP_MS);
  }
  log(`… not live | ${j.mint} | slot=${label} | reason=clean-false | viewers=n/a`);
}
async function runStage(j, stage){
  if (j.closed) return;
  await slotProbe(j, stage);
  if (j.closed || j.liveHit) return;
  if (stage === "first"){
    schedule(j, "second", j.t0 + SECOND_CHECK_DELAY_MS, runStage);
  } else if (stage === "second"){
    schedule(j, "third",  j.t0 + THIRD_CHECK_DELAY_MS,  runStage);
  } else if (stage === "third"){
    metrics.jobs.final++; log(`↪️  schedule FINAL | ${j.mint}`);
    schedule(j, "final",  j.t0 + FINAL_CHECK_DELAY_MS,  runFinal);
  }
}
async function runFinal(j){
  if (j.closed) return;
  await slotProbe(j, "final");
  if (j.closed || j.liveHit) return;
  log(`🧹 final skip not_live | ${j.mint}`);
  clearJob(j);
}

/* ================== WS CONNECTION ================== */
let ws;
function connectWS(){
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log(`✅ WS connected: ${WS_URL}`);
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    log("📡 Subscribed: subscribeNewToken");
  });
  ws.on("message", (raw) => {
    let msg = null; try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null; if (!mint) return;
    metrics.ws.events++;
    const existing = jobs.get(mint); const ts = now();
    if (!existing){
      if (!seenRecently(mint)) markRecent(mint);
      const j = newJob(mint);
      schedule(j, "first", j.t0 + FIRST_CHECK_DELAY_MS, runStage);
      return;
    }
    if (!existing.liveHit && !existing.closed && (ts - existing.t0 <= WS_BUMP_WINDOW_MS)){
      metrics.ws.bumps++; schedule(existing, "bump", ts + 1, runStage);
    } else {
      metrics.ws.dups++;
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
    `http(coins): req=${metrics.http_coin.req} ok=${metrics.http_coin.ok} 429=${metrics.http_coin._429} http=${metrics.http_coin.http} html=${metrics.http_coin.html} empty=${metrics.http_coin.empty} parse=${metrics.http_coin.parse} throw=${metrics.http_coin.throw}`,
    `http(ls): req=${metrics.http_ls.req} ok=${metrics.http_ls.ok} 429=${metrics.http_ls._429} http=${metrics.http_ls.http} throw=${metrics.http_ls.throw}`,
    `decide: live=${metrics.decide.live} not_live=${metrics.decide.not_live} unknown=${metrics.decide.unknown}`,
    `ws: events=${metrics.ws.events} dups=${metrics.ws.dups} bumps=${metrics.ws.bumps}`,
    `jobs: new=${metrics.jobs.new} done=${metrics.jobs.done} final=${metrics.jobs.final}`,
    `elig: started=${metrics.elig.started} ok=${metrics.elig.ok} fail=${metrics.elig.fail}`,
    `| lat(LIVE) p50=${p50L?fmtDur(p50L):"n/a"} p95=${p95L?fmtDur(p95L):"n/a"}`,
    `| lat(≥${ELIG_THRESHOLD}) p50=${p50E?fmtDur(p50E):"n/a"} p95=${p95E?fmtDur(p95E):"n/a"}`
  );
}, HEARTBEAT_MS);

/* ================== START ================== */
log("Zero-miss watcher starting…",
  "| DELAYS=", `${FIRST_CHECK_DELAY_MS}/${SECOND_CHECK_DELAY_MS}/${THIRD_CHECK_DELAY_MS}/final@${FINAL_CHECK_DELAY_MS}`,
  "| SLOT=", `${QUICK_ATTEMPTS}x${QUICK_STEP_MS}ms`,
  "| RPS=", GLOBAL_RPS,
  "| ELIG=", `≥${ELIG_THRESHOLD} for ${Math.floor(ELIG_WINDOW_MS/1000)}s step ${Math.floor(ELIG_STEP_MS/1000)}s`,
  "| INSTANT=", ELIG_INSTANT ? `on (minConsec=${MIN_CONSEC_SAMPLES})` : "off",
  "| TZ=", TZ_LABEL,
  "| no-304 on livestream"
);

connectWS();

process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
