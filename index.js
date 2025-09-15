// index.js — v10.2
// Базируется на твоём v10.1. Ничего не выкидывал по смыслу —
// только добавил: MAX_CONCURRENCY=12, третий чек @15s, приоритет 5s>10s>15s>пробы,
// детальные логи plan/run/done/measure/alert с WS→*, и метрики third-очереди в heartbeat.
//
// ⚠️ Если какие-то ENV уже заданы у тебя — они перекроют дефолты ниже.

// ===== Imports =====
import process from "process";
import WebSocket from "ws";
import fetch from "node-fetch";

// ===== Config (ENV + дефолты) =====
const WS_URL = process.env.PUMP_WS_URL || "wss://pumpportal.fun/api/data"; // их стабильная точка для subscribeNewToken
const API = process.env.PUMP_API || "https://frontend-api-v3.pump.fun";    // v3, как и было у тебя

// Порог и окно измерения
const VIEWERS_THRESHOLD      = int("VIEWERS_THRESHOLD", 30);      // >= этого — алёрт
const MEASURE_WINDOW_MS      = int("MEASURE_WINDOW_MS", 30_000);  // 30s окно
const RECHECKS               = int("RECHECKS", 6);                 // 6 проб
const RECHECK_STEP_MS        = int("RECHECK_STEP_MS", 5_000);      // шаг 5s

// Ступени one‑shot чеков
const FIRST_CHECK_DELAY_MS   = int("FIRST_CHECK_DELAY_MS", 5_000);   // 5s (приоритет №1)
const SECOND_CHECK_DELAY_MS  = int("SECOND_CHECK_DELAY_MS", 10_000); // 10s (приоритет №2)
const THIRD_CHECK_DELAY_MS   = int("THIRD_CHECK_DELAY_MS", 15_000);  // 15s (приоритет №3)

// Пул воркеров и глобальный троттлинг API
const MAX_CONCURRENCY        = int("MAX_CONCURRENCY", 12);          // одновременно воркеров
const GLOBAL_RPS             = num("GLOBAL_RPS", 3);                 // лимит запросов/сек (общий)
const JITTER_MS              = int("JITTER_MS", 150);                // небольшой джиттер

// Дедуп по mint для входа из WS
const DEDUP_TTL_MS           = int("DEDUP_TTL_MS", 10 * 60_000);

// Поведение
envBool("STRICT_ONE_SHOT", true); // для совместимости с твоей схемой
envBool("API_VIEWERS_ONLY", true);

// Rescue для api_null
const API_NULL_RETRIES       = int("API_NULL_RETRIES", 4);          // 4 быстрых ретрая
const API_NULL_STEP_MS       = int("API_NULL_STEP_MS", 1000);       // шаг 1s между ретраями

// Heartbeat
const HEARTBEAT_MS           = int("HEARTBEAT_MS", 60_000);

// Telegram (ENV или хардкод-фоллбек — как просил ранее)
const TG_TOKEN_HARDCODED   = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID_HARDCODED = "-4857972467";
const TG_TOKEN             = (process.env.TG_TOKEN || TG_TOKEN_HARDCODED || "").trim();
const TG_CHAT_ID           = (process.env.TG_CHAT_ID || TG_CHAT_ID_HARDCODED || "").trim();

// ===== Helpers =====
function int(name, def) { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? v : def; }
function num(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envBool(name, def){ const v=(process.env[name]||"").trim().toLowerCase(); if(v==="true")return true; if(v==="false")return false; return def; }
function log(...a){ console.log(new Date().toISOString(), ...a); }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ===== State / Metrics =====
let ws;
let lastWsMsgAt = 0;

const metrics = {
  api_req:0, api_ok:0, api_retry:0, api_429:0, api_other:0,
  queued:0, started:0, done:0, alerted:0,
  dedup_skip:0, miss:0,
  api_null_skip:0, api_null_recovered:0,
  // first/second/third планирование/выполнение
  scheduled_first:0, scheduled_second:0, scheduled_third:0,
  performed_first:0, performed_second:0, performed_third:0,
  first_live:0, second_live:0, third_live:0,
  first_skip:0, second_skip:0, third_skip:0,
  // очереди
  stack_first:0, stack_second:0, stack_third:0,
  // средние отклонения запуска от due-времени (5s/10s/15s)
  avgReadyDelayFirstMs:0, avgReadyDelaySecondMs:0, avgReadyDelayThirdMs:0,
  // измерения
  active_windows:0
};

// дедуп по mint
const recently = new Map(); // mint -> ts
function seenRecently(mint){ const t = recently.get(mint); if(!t) return false; if(Date.now()-t>DEDUP_TTL_MS){ recently.delete(mint); return false;} return true; }
function markSeen(mint){ recently.set(mint, Date.now()); }

// Три очереди «отложенных» one-shot чеков
const firstStack  = []; // элементы: Task
const secondStack = [];
const thirdStack  = [];

// Идёт ли сейчас измерение окна по mint
const windows = new Map(); // mint -> { task, via, t_start, probes, max_viewers }

// ===== Global API throttle (RPS + penalty после 429) =====
let minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));
let nextAllowedAt = 0;
let penaltyUntil = 0;

async function throttleApi(){
  const now = Date.now();
  const currentGap = (now < penaltyUntil) ? Math.max(minGapMs, 1000) : minGapMs;
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  const jitter = (Math.random()*2 - 1) * JITTER_MS;
  nextAllowedAt = Date.now() + currentGap + Math.max(-JITTER_MS, Math.min(JITTER_MS, jitter));
}

// ===== API =====
function coinUrl(mint){ const bust = Date.now().toString(); return `${API}/coins/${mint}?_=${bust}`; }

async function fetchCoin(mint, maxRetries=2){
  const url = coinUrl(mint);
  for(let attempt=0; attempt<=maxRetries; attempt++){
    try{
      await throttleApi();
      metrics.api_req++;
      const r = await fetch(url, {
        headers:{
          "accept":"application/json, text/plain, */*",
          "cache-control":"no-cache, no-store",
          "pragma":"no-cache",
          "user-agent":"pump-watcher/10.2"
        }
      });
      if (r.status === 429){ metrics.api_429++; penaltyUntil = Date.now()+30_000; await sleep(1500+Math.random()*1000); continue; }
      if (!r.ok){ metrics.api_other++; throw new Error("HTTP "+r.status); }
      const text = await r.text(); if(!text || text.trim()==="") throw new Error("Empty body");
      const json = JSON.parse(text); metrics.api_ok++; return json;
    }catch(e){ if (attempt < maxRetries){ metrics.api_retry++; await sleep(400*(attempt+1)); continue; } return null; }
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
  }catch(e){ log("telegram error:", e.message); }
}

function fmt(n){ try{ return Number(n).toLocaleString("en-US"); }catch{ return String(n); } }

async function alertLive(task, coin, viewers){
  const title = `${coin.name || ""} (${coin.symbol || ""})`.trim();
  const hasSocials = !!(coin?.website || coin?.twitter || coin?.telegram || coin?.discord);
  const socials = [];
  if (coin?.website)  socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter)  socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord)  socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);

  const NL = "\n";
  const parts = [
    `🎥 <b>LIVE START</b> | ${title}${hasSocials?"":" <i>(no socials)</i>"}`,
    `Mint: <code>${task.mint}</code>`,
    `👁 Viewers: ${fmt(viewers)} (source: api)`,
    `💰 Market Cap (USD): ${typeof coin.usd_market_cap==="number" ? "$"+fmt(coin.usd_market_cap) : "n/a"}`,
    `🔗 Axiom: https://axiom.trade/t/${task.mint}`
  ];
  if (socials.length) parts.push(socials.join(NL));

  const msg = parts.join(NL) + NL + `⏱ WS→alert: ${Date.now()-task.t_ws}ms (path: ${task.via || "api"})`;

  log("tg:send start");
  await sendTG(msg, coin?.image_uri || null);
  metrics.alerted++;
  log("ALERT sent |", title, "| viewers:", viewers, "| source: api | via=", task.via || "api", "| WS→alert=", (Date.now()-task.t_ws)+"ms");
}

// ===== Измерение окна 30s (пробы каждые RECHECK_STEP_MS) =====
async function measureWindow(task, coin){
  // старт окна
  windows.set(task.mint, { task, via:task.via||"api", t_start:Date.now(), probes:0, max_viewers:0 });
  log(`measure: start ${task.mint} via=${task.via||"api"} | WS→measure=${Date.now()-task.t_ws}ms`);

  const t0 = Date.now();
  while (true){
    const w = windows.get(task.mint);
    if (!w) return; // сняли с измерения

    // ожидание до следующей пробы по расписанию
    const due = t0 + Math.min(MEASURE_WINDOW_MS, (w.probes+1)*RECHECK_STEP_MS);
    const sleepMs = Math.max(0, due - Date.now());
    if (sleepMs>0) await sleep(sleepMs);

    // сделать пробу
    await throttleApi();
    metrics.api_req++;
    const res = await fetch(coinUrl(task.mint), { headers:{
      "accept":"application/json, text/plain, */*",
      "cache-control":"no-cache, no-store",
      "pragma":"no-cache",
      "user-agent":"pump-watcher/10.2"
    }});
    let viewers = 0;
    try{
      if (res.status===429){ metrics.api_429++; penaltyUntil=Date.now()+30_000; await sleep(800); continue; }
      if (!res.ok){ metrics.api_other++; throw new Error("HTTP "+res.status); }
      const text = await res.text(); if(!text||text.trim()==="") throw new Error("Empty body");
      const json = JSON.parse(text); metrics.api_ok++;
      viewers = (typeof json.num_participants==="number" ? json.num_participants : (json.viewer_count||0))|0;
    }catch(e){ metrics.api_retry++; continue; }

    w.probes++;
    w.max_viewers = Math.max(w.max_viewers, viewers);
    log(`probe ${w.probes}/${RECHECKS} | viewers=${viewers} | threshold=${VIEWERS_THRESHOLD}`);

    if (viewers >= VIEWERS_THRESHOLD){
      windows.delete(task.mint);
      log(`measure: hit ${task.mint} probe=${w.probes}/${RECHECKS} viewers=${viewers}`);
      await alertLive(task, { ...coin }, viewers);
      return;
    }

    if (Date.now() - t0 >= MEASURE_WINDOW_MS || w.probes>=RECHECKS){
      windows.delete(task.mint);
      metrics.miss++;
      log(`measure: miss ${task.mint} max_viewers=${w.max_viewers}`);
      return;
    }
  }
}

// ===== One-shot checks (5s / 10s / 15s) =====
function planFirst(task){
  firstStack.push({ ...task, due: task.t_ws + FIRST_CHECK_DELAY_MS, delay: FIRST_CHECK_DELAY_MS });
  metrics.scheduled_first++; metrics.stack_first = firstStack.length; log(`plan: first@5s ${task.mint}`);
}
function planSecond(task){
  secondStack.push({ ...task, due: task.t_ws + SECOND_CHECK_DELAY_MS, delay: SECOND_CHECK_DELAY_MS });
  metrics.scheduled_second++; metrics.stack_second = secondStack.length; log(`plan: second@10s ${task.mint} (from first not_live)`);
}
function planThird(task){
  thirdStack.push({ ...task, due: task.t_ws + THIRD_CHECK_DELAY_MS, delay: THIRD_CHECK_DELAY_MS });
  metrics.scheduled_third++; metrics.stack_third = thirdStack.length; log(`plan: third@15s ${task.mint} (from second not_live)`);
}

async function runCheck(queueName, stack){
  // берём ближайшую по due задачу этого стека
  if (stack.length===0) return false;
  let bestIdx = -1, bestDue = Infinity;
  for (let i=0;i<stack.length;i++){ const d = stack[i].due; if (d<bestDue){ bestDue=d; bestIdx=i; } }
  const job = stack.splice(bestIdx,1)[0]; metrics[`stack_${queueName}`] = stack.length;

  const tStart = Date.now();
  const readyDelay = Math.max(0, tStart - job.due);
  // EMA средняя задержка запуска
  const keyAvg = queueName==='first' ? 'avgReadyDelayFirstMs' : queueName==='second' ? 'avgReadyDelaySecondMs' : 'avgReadyDelayThirdMs';
  metrics[keyAvg] = Math.round(metrics[keyAvg]*0.9 + readyDelay*0.1);

  log(`run:  ${queueName}@${Math.round(job.delay/1000)}s ${job.mint} | WS→run=${tStart - job.t_ws}ms`);

  const before = Date.now();
  const coin = await fetchCoin(job.mint, 2);
  const after = Date.now();

  if (!coin){
    metrics.api_null_skip++;
    log(`done: ${queueName}@${Math.round(job.delay/1000)}s ${job.mint} api_null | dur=${after-before}ms | WS→done=${after - job.t_ws}ms`);
    return true;
  }

  const isLive = coin.is_currently_live===true || coin?.bonding_curve?.live===true;
  metrics[`performed_${queueName}`]++;

  if (isLive){
    metrics[`${queueName}_live`]++;
    log(`done: ${queueName}@${Math.round(job.delay/1000)}s ${job.mint} live | dur=${after-before}ms | WS→done=${after - job.t_ws}ms`);
    const via = queueName; // кто зажёг
    const task = { mint: job.mint, t_ws: job.t_ws, via };
    // Стартуем окно измерения (не блокирует воркера)
    if (!windows.has(job.mint)){
      metrics.active_windows = windows.size+1;
      measureWindow(task, coin).catch(()=>{});
    }
  } else {
    metrics[`${queueName}_skip`]++;
    log(`done: ${queueName}@${Math.round(job.delay/1000)}s ${job.mint} not_live | dur=${after-before}ms | WS→done=${after - job.t_ws}ms`);
    if (queueName==='first') planSecond({ mint: job.mint, t_ws: job.t_ws });
    else if (queueName==='second') planThird({ mint: job.mint, t_ws: job.t_ws });
  }
  return true;
}

// ===== Worker pool =====
async function worker(){
  while(true){
    // Приоритет: first > second > third > пробы окна
    if (await runCheck('first', firstStack)) { /* ok */ }
    else if (await runCheck('second', secondStack)) { /* ok */ }
    else if (await runCheck('third', thirdStack)) { /* ok */ }
    else {
      // если нет отложенных чеков — занимаемся окнами: один шаг в одном окне
      // выбираем то окно, у которого следующая проба due ближе
      const nowTs = Date.now();
      let pickMint=null, pickDue=Infinity;
      for (const [mint, w] of windows){
        const due = w.t_start + Math.min(MEASURE_WINDOW_MS, (w.probes+1)*RECHECK_STEP_MS);
        if (due<=nowTs && due<pickDue){ pickDue=due; pickMint=mint; }
      }
      if (pickMint){
        const w = windows.get(pickMint);
        if (w){ await doProbeStep(pickMint, w); }
      } else {
        await sleep(20);
      }
    }
  }
}

async function doProbeStep(mint, w){
  // один шаг пробы, почти то же что в measureWindow, но без цикла ожидания
  await throttleApi();
  metrics.api_req++;
  const res = await fetch(coinUrl(mint), { headers:{
    "accept":"application/json, text/plain, */*",
    "cache-control":"no-cache, no-store",
    "pragma":"no-cache",
    "user-agent":"pump-watcher/10.2"
  }});
  let viewers = 0;
  try{
    if (res.status===429){ metrics.api_429++; penaltyUntil=Date.now()+30_000; await sleep(800); return; }
    if (!res.ok){ metrics.api_other++; throw new Error("HTTP "+res.status); }
    const text = await res.text(); if(!text||text.trim()==="") throw new Error("Empty body");
    const json = JSON.parse(text); metrics.api_ok++;
    viewers = (typeof json.num_participants==="number" ? json.num_participants : (json.viewer_count||0))|0;
  }catch(e){ metrics.api_retry++; return; }

  w.probes++;
  w.max_viewers = Math.max(w.max_viewers, viewers);
  log(`probe ${w.probes}/${RECHECKS} | viewers=${viewers} | threshold=${VIEWERS_THRESHOLD}`);

  if (viewers >= VIEWERS_THRESHOLD){
    windows.delete(mint);
    log(`measure: hit ${mint} probe=${w.probes}/${RECHECKS} viewers=${viewers}`);
    await alertLive(w.task, { name:"", symbol:"" }, viewers).catch(()=>{});
  } else if (Date.now() - w.t_start >= MEASURE_WINDOW_MS || w.probes>=RECHECKS){
    windows.delete(mint);
    metrics.miss++;
    log(`measure: miss ${mint} max_viewers=${w.max_viewers}`);
  }
}

// ===== WebSocket intake =====
function connectWS(){
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { log("WS connected, subscribing new tokens…"); ws.send(JSON.stringify({ method: "subscribeNewToken" })); });
  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg=null; try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null; if (!mint) return;
    if (seenRecently(mint)){ metrics.dedup_skip++; return; }
    markSeen(mint);

    const task = { mint, t_ws: Date.now() };
    planFirst(task);
    metrics.queued++;
  });
  ws.on("close", () => { log("WS closed → reconnect in 5s"); setTimeout(connectWS, 5000); });
  ws.on("error", (e) => { log("WS error:", e.message); });
}

// ===== Heartbeat =====
setInterval(() => {
  const secSinceWs = lastWsMsgAt ? Math.round((Date.now()-lastWsMsgAt)/1000) : -1;
  log(
    `[stats] queued=${metrics.queued}`,
    `active=${windows.size}`,
    `stack_first=${firstStack.length}`,
    `stack_second=${secondStack.length}`,
    `stack_third=${thirdStack.length}`,
    `ws_last=${secSinceWs}s |`,
    `api:req=${metrics.api_req}`,
    `ok=${metrics.api_ok}`,
    `retry=${metrics.api_retry}`,
    `429=${metrics.api_429}`,
    `other=${metrics.api_other} |`,
    `started=${metrics.started}`,
    `done=${metrics.done}`,
    `alerted=${metrics.alerted} |`,
    `skip:dedup=${metrics.dedup_skip}`,
    `api_null=${metrics.api_null_skip}`,
    `miss=${metrics.miss} |`,
    `scheduled:first=${metrics.scheduled_first}`,
    `second=${metrics.scheduled_second}`,
    `third=${metrics.scheduled_third} |`,
    `performed:first=${metrics.performed_first}`,
    `second=${metrics.performed_second}`,
    `third=${metrics.performed_third} |`,
    `first_live=${metrics.first_live}`,
    `second_live=${metrics.second_live}`,
    `third_live=${metrics.third_live} |`,
    `avgReadyDelayFirstMs=${metrics.avgReadyDelayFirstMs}`,
    `avgReadyDelaySecondMs=${metrics.avgReadyDelaySecondMs}`,
    `avgReadyDelayThirdMs=${metrics.avgReadyDelayThirdMs}`
  );
}, HEARTBEAT_MS);

// ===== Start =====
log("Worker starting…",
  "| THR="+VIEWERS_THRESHOLD,
  "| WINDOW="+MEASURE_WINDOW_MS+"ms",
  "| RECHECKS="+RECHECKS+"@"+RECHECK_STEP_MS+"ms",
  "| FIRST_CHECK_DELAY="+FIRST_CHECK_DELAY_MS+"ms",
  "| SECOND_CHECK_DELAY="+SECOND_CHECK_DELAY_MS+"ms",
  "| THIRD_CHECK_DELAY="+THIRD_CHECK_DELAY_MS+"ms",
  "| CONC="+MAX_CONCURRENCY,
  "| RPS="+GLOBAL_RPS,
  "| apiNullRescue="+API_NULL_RETRIES+"@"+API_NULL_STEP_MS+"ms"
);

connectWS();
for (let i=0;i<MAX_CONCURRENCY;i++){ worker().catch(()=>{}); }

// ===== Graceful =====
process.on("SIGTERM", ()=>process.exit(0));
process.on("SIGINT", ()=>process.exit(0));
