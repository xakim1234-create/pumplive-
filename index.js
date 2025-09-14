// index.js — v3.5: LIVE-only + socials filter
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

const LIVE_INTERVAL = 25000;
const LIVE_TIMEOUT_MIN = 30;
const MIN_GAP_MS = 1000;
const MAX_RETRIES = 4;
const MAX_WATCHERS = 200;

const tracking = new Map();
const seen = new Set();
let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
};

// ——— helpers
function log(...a) { console.log(new Date().toISOString(), ...a); }
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise(r => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// ——— fetch with retries
async function safeGetJson(url) {
  metrics.requests++;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const cacheBust = url.includes("?") ? `&t=${Date.now()}` : `?t=${Date.now()}`;
      const r = await fetch(url + cacheBust, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/3.5"
        }
      });
      if (r.status === 429) {
        metrics.http429++;
        const ra = r.headers.get("retry-after");
        const waitMs = ra ? Number(ra) * 1000 : 4000 + Math.random() * 2000;
        nextAvailableAt = Date.now() + waitMs;
        if (attempt < MAX_RETRIES) {
          metrics.retries++;
          await new Promise(res => setTimeout(res, waitMs));
          continue;
        }
        throw new Error("HTTP 429");
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
      const data = JSON.parse(text);
      metrics.ok++;
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        metrics.retries++;
        const base = 800 * (attempt + 1);
        const jitter = Math.floor(Math.random() * 400);
        await new Promise(res => setTimeout(res, base + jitter));
        continue;
      }
      metrics.skippedNull++;
      return null;
    }
  }
  return null;
}

// ——— social detection
function extractSocials(obj) {
  const socials = [];

  const directFields = ["twitter", "telegram", "website", "discord"];
  for (const f of directFields) {
    if (obj?.[f]) socials.push(`${f}=${obj[f]}`);
  }

  const desc = obj?.description || "";
  const regexes = [
    /(https?:\/\/t\.me\/[^\s]+)/gi,
    /(https?:\/\/(x|twitter)\.com\/[^\s]+)/gi,
    /(https?:\/\/discord\.(gg|com)\/[^\s]+)/gi,
    /(https?:\/\/(www\.)?instagram\.com\/[^\s]+)/gi,
    /(https?:\/\/(www\.)?youtube\.com\/[^\s]+)/gi,
    /(https?:\/\/youtu\.be\/[^\s]+)/gi,
    /(https?:\/\/(www\.)?tiktok\.com\/[^\s]+)/gi,
    /(https?:\/\/[^\s]+)/gi,
  ];
  for (const re of regexes) {
    let m;
    while ((m = re.exec(desc)) !== null) {
      socials.push(`link=${m[1]}`);
    }
  }

  return socials;
}

async function extractSocialsDeep(coin) {
  let socials = extractSocials(coin);

  if ((!socials || socials.length === 0) && coin?.metadata_uri) {
    try {
      const meta = await safeGetJson(coin.metadata_uri);
      socials = extractSocials(meta || {});
    } catch { /* ignore */ }
  }
  return socials;
}

// ——— watcher
function startLiveWatch(mint, name = "", symbol = "") {
  if (tracking.has(mint)) return;
  if (tracking.size >= MAX_WATCHERS) return;

  const startedAt = Date.now();
  const jitter = Math.floor(Math.random() * 5000);

  const timer = setInterval(async () => {
    try {
      if ((Date.now() - startedAt) / 60000 > LIVE_TIMEOUT_MIN) {
        clearInterval(timer);
        tracking.delete(mint);
        return;
      }

      const coin = await safeGetJson(`${API}/coins/${mint}`);
      if (!coin) return;

      if (coin.is_currently_live) {
        clearInterval(timer);
        tracking.delete(mint);

        const socials = await extractSocialsDeep(coin);
        if (socials.length === 0) return; // no socials → skip

        lastLiveAt = Date.now();
        log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
        log(`   mint: ${mint}`);
        if (typeof coin.usd_market_cap === "number") {
          log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
        }
        log(`   socials: ${socials.join("  ")}`);
      }
    } catch (e) {
      metrics.httpOther++;
      log("⚠️  live-check error:", e.message);
    }
  }, LIVE_INTERVAL + jitter);

  tracking.set(mint, timer);
}

// ——— websocket
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected, subscribing to new tokens…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (raw) => {
    lastWsMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    if (!seen.has(mint)) {
      seen.add(mint);
      startLiveWatch(mint, msg?.name || msg?.tokenName, msg?.symbol || msg?.ticker);
    }
  });

  ws.on("close", (c, r) => {
    metrics.reconnects++;
    log(`🔌 WS closed ${c} ${(r || "").toString()}. Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    log("❌ WS error:", e.message);
  });
}

// ——— heartbeat
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;

  console.log(
    `[stats] watchers=${tracking.size}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} 429=${metrics.http429} ` +
    `other=${metrics.httpOther} empty=${metrics.emptyBody} null=${metrics.skippedNull} ` +
    `reconnects=${metrics.reconnects}`
  );

  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// ——— start
log("Worker starting…");
connect();
