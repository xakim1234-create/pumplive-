// index.js — v7.4.0
import WebSocket from "ws";
import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import os from "os";
import fs from "fs/promises";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram
const TG_TOKEN = "XXX";
const TG_CHAT_ID = "YYY";

// === API очередь ===
const MIN_GAP_MS = 1500;
const MAX_LIFETIME_MS = 120_000;
const MAX_QUEUE = 1000;
const MAX_RETRIES = 2;

// === Viewers ===
const VIEWERS_THRESHOLD = 30;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
  viewerTasksStarted: 0, viewerTasksDone: 0,
  viewerTasksDropped: 0, viewerOpenErrors: 0,
  viewerSelectorMiss: 0,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ——— throttle
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise(r => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// ——— safeGetJson
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/7.4.0"
        }
      });
      if (r.status === 429) {
        metrics.http429++;
        const waitMs = 2000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        await new Promise(res => setTimeout(res, waitMs));
        continue;
      }
      if (!r.ok) {
        metrics.httpOther++;
        throw new Error(`HTTP ${r.status}`);
      }
      const text = await r.text();
      if (!text || text.trim() === "") {
        metrics.emptyBody++;
        throw new Error("Empty body");
      }
      metrics.ok++;
      return JSON.parse(text);
    } catch {
      if (attempt < MAX_RETRIES) {
        metrics.retries++;
        await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
        continue;
      }
      metrics.skippedNull++;
      return null;
    }
  }
}

// ——— socials
function extractOfficialSocials(coin) {
  const socials = [];
  if (coin?.website) socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter) socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord) socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);
  return socials;
}

// ——— Telegram
async function sendTG({ text, photo }) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    if (photo) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: "HTML" })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
      });
    }
  } catch (e) {
    log("⚠️ telegram send error:", e.message);
  }
}

// ===================== API очередь =====================
const inQueue = new Set();
const queue = [];

function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({ mint, name, symbol, enqueuedAt: now, expiresAt: now + MAX_LIFETIME_MS, nextTryAt: now });
  inQueue.add(mint);
}
function requeue(item) { item.nextTryAt = Date.now() + 4000; queue.push(item); }
function queueSize() { return inQueue.size; }

async function apiWorkerLoop() {
  while (true) {
    let idx = -1; const now = Date.now();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= now) { idx = i; break; }
    if (idx === -1) { await new Promise(r => setTimeout(r, 250)); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;
    if (Date.now() > expiresAt) { inQueue.delete(mint); continue; }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) { requeue(item); continue; }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { inQueue.delete(mint); continue; }

      inQueue.delete(mint);
      viewersQueue.push({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number") log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);
      continue;
    }

    requeue(item);
  }
}

// ===================== Viewers =====================
const viewersQueue = [];
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  const execPath = await chromium.executablePath();
  browser = await puppeteer.launch({
    executablePath: execPath,
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: chromium.headless
  });
  log("✅ Chromium ready:", execPath);
  return browser;
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol }) {
  metrics.viewerTasksStarted++;
  const br = await getBrowser();
  const pg = await br.newPage();
  await pg.setUserAgent(UA);
  await pg.setViewport({ width: 1280, height: 800 });
  await pg.setRequestInterception(true);
  pg.on("request", req => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media" || t === "stylesheet") return req.abort();
    req.continue();
  });

  log(`▶️ viewers:start mint=${mint} name="${coin.name || fallbackName}" symbol="${coin.symbol || fallbackSymbol}"`);

  await pg.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await new Promise(r => setTimeout(r, 1500));

  const tSel = Date.now();
  let indicatorFound = true;
  try {
    await pg.waitForSelector("#live-indicator", { timeout: 60_000 });
    log(`🔎 live-indicator:found=true dt=${Date.now() - tSel}ms`);
  } catch {
    indicatorFound = false;
    metrics.viewerSelectorMiss++;
    log(`🔎 live-indicator:found=false dt=${Date.now() - tSel}ms reason=timeout_or_missing`);

    // перепроверяем API
    let apiLive = null;
    try {
      const fresh = await safeGetJson(`${API}/coins/${mint}`);
      apiLive = !!fresh?.is_currently_live;
    } catch {}
    log(`🔁 api:recheck_live=${apiLive}`);
    if (!apiLive) {
      metrics.viewerTasksDone++;
      await pg.close();
      log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
      log(`⏭️ skip reason=no_indicator_and_not_live`);
      return;
    } else {
      metrics.viewerTasksDone++;
      await pg.close();
      log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
      log(`⏭️ skip reason=no_indicator_but_still_live`);
      return;
    }
  }

  // если индикатор найден → 2 замера
  let maxV = -1;
  for (let i = 1; i <= 2; i++) {
    await new Promise(r => setTimeout(r, 5000));
    let viewers = null;
    try {
      const handle = await pg.$("#live-indicator");
      const span = await pg.evaluateHandle(el => el && el.parentElement && el.parentElement.querySelector("span"), handle);
      const txt = await span.evaluate(el => (el.textContent || "").trim());
      const num = Number((txt.match(/\d+/) || [null])[0]);
      if (Number.isFinite(num)) viewers = num;
    } catch {}
    if (viewers != null) {
      if (viewers > maxV) maxV = viewers;
      log(`📊 sample i=${i}/2 ok=true viewers=${viewers}`);
    } else {
      log(`📊 sample i=${i}/2 ok=false`);
    }
  }

  if (maxV >= VIEWERS_THRESHOLD) {
    const socials = extractOfficialSocials(coin);
    const title = `${coin.name || fallbackName} (${coin.symbol || fallbackSymbol})`;
    const mcapStr = typeof coin.usd_market_cap === "number" ? `$${coin.usd_market_cap.toFixed(2)}` : "n/a";
    const msg = [
      `🎥 <b>LIVE START</b> | ${title}`,
      ``,
      `Mint: <code>${mint}</code>`,
      `💰 Market Cap: ${mcapStr}`,
      `👁 Viewers: ${maxV}`,
      ``,
      socials.join("\n")
    ].join("\n");
    log("📤 tg:send start");
    await sendTG({ text: msg, photo: coin?.image_uri || null });
    log("✅ tg:sent");
  } else {
    log(`⏭️ threshold:miss max=${maxV}`);
  }

  metrics.viewerTasksDone++;
  await pg.close();
  log(`🗑 page:closed active_pages=${(await br.pages()).length}`);
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersQueue.length === 0) { await new Promise(r => setTimeout(r, 200)); continue; }
    const job = viewersQueue.shift();
    try { await viewersTask(job); }
    catch (e) { metrics.viewerOpenErrors++; log("⚠️ viewers task error:", e.message); }
  }
}

// ===================== WS =====================
function connect() {
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });
  ws.on("message", raw => {
    lastWsMsgAt = Date.now();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    const nm = msg?.name || msg?.tokenName || "";
    const sm = msg?.symbol || msg?.ticker || "";
    enqueue(mint, nm, sm);
  });
  ws.on("close", () => {
    metrics.reconnects++;
    log(`🔌 WS closed → Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });
  ws.on("error", (e) => log("❌ WS error:", e.message));
}

// ===================== Heartbeat + Resources =====================
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
    `vQ=${viewersQueue.length} vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} ` +
    `vDrop=${metrics.viewerTasksDropped} vOpenErr=${metrics.viewerOpenErrors} vSelMiss=${metrics.viewerSelectorMiss}`
  );
}, 60_000);

// ==== RESOURCE MONITOR ======================
function fmtMB(bytes){ return (bytes/1024/1024).toFixed(1); }
async function readProcStatm(pid) {
  try {
    const txt = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const parts = txt.trim().split(/\s+/).map(Number);
    const pageSize = 4096;
    const residentBytes = (parts[1] || 0) * pageSize;
    return residentBytes;
  } catch { return null; }
}
function startResourceLogger(intervalMs = 15000) {
  let lastCpu = process.cpuUsage();
  let lastTime = Date.now();
  setInterval(async () => {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsedMs = now - lastTime || 1;
    lastCpu = process.cpuUsage();
    lastTime = now;
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cores = os.cpus().length || 1;
    const nodeCpuPct = (cpuMs / elapsedMs) * 100 / cores;
    const mem = process.memoryUsage();
    const nodeRssMB = fmtMB(mem.rss);
    const nodeHeapMB = fmtMB(mem.heapUsed);
    const [load1] = os.loadavg();
    let activePages = 0;
    try { activePages = browser ? (await browser.pages()).length : 0; } catch {}
    let chromeRssMB = null;
    try {
      const bproc = browser?.process?.();
      if (bproc?.pid) {
        const rss = await readProcStatm(bproc.pid);
        if (rss != null) chromeRssMB = fmtMB(rss);
      }
    } catch {}
    console.log(
      new Date().toISOString(),
      `[res] cpu_node=${nodeCpuPct.toFixed(1)}% rss_node=${nodeRssMB}MB heap_node=${nodeHeapMB}MB ` +
      `load1=${load1.toFixed(2)} active_pages=${activePages}` +
      (chromeRssMB ? ` rss_chrome=${chromeRssMB}MB` : "")
    );
  }, intervalMs).unref();
}
startResourceLogger(15000);

// ===================== Start =====================
log("Worker starting…");
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(0); });
process.on("SIGINT",  async () => { try { await browser?.close(); } catch {} process.exit(0); });
