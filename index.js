// index.js — minimal live-catcher with safe fetch + retries
import WebSocket from "ws";
import { setTimeout as sleep } from "timers/promises";
import fetch from "undici";

// ---------- Config ----------
const WS_URL = "wss://pumpportal.fun/api/data";
const API    = "https://frontend-api-v3.pump.fun";
const GLOBAL_RPS = 3;                 // ~3 запроса/сек — достаточно
const MAX_RETRIES = 4;                // ретраи при пустом/битом JSON
const RETRY_STEP_MS = 800;            // пауза между ретраями
const JITTER_MS = 150;                // небольшой джиттер к RPS
const VIEWERS_THRESHOLD = 1;          // просто увидеть лайв (можешь поднять позже)

// ---------- Throttle ----------
let nextAllowedAt = 0;
let penaltyUntil = 0; // после 429 замедляемся
const minGapMs = Math.max(50, Math.floor(1000 / Math.max(0.1, GLOBAL_RPS)));

async function throttle() {
  const now = Date.now();
  const gap = now < penaltyUntil ? Math.max(minGapMs, 1000) : minGapMs;
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  const jitter = Math.max(-JITTER_MS, Math.min(JITTER_MS, (Math.random() * 2 - 1) * JITTER_MS));
  nextAllowedAt = Date.now() + gap + jitter;
}

// ---------- Safe fetch ----------
function coinUrl(mint) {
  // кэш-бастер снижает шанс пустого тела
  return `${API}/coins/${mint}?_=${Date.now()}`;
}

async function fetchCoin(mint) {
  const url = coinUrl(mint);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch.fetch(url, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "cache-control": "no-cache, no-store",
          "pragma": "no-cache",
          "user-agent": "pumplive/mini-1.0"
        }
      });

      if (r.status === 429) {
        // замедляемся на 30с
        penaltyUntil = Date.now() + 30_000;
        console.warn("⚠️ 429 from API → slow mode 30s");
        await sleep(1500 + Math.random() * 1000);
        continue;
      }
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }

      const text = await r.text();
      if (!text || !text.trim()) {
        throw new Error("empty-body");
      }

      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error("bad-json"); }

      return json;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_STEP_MS * (attempt + 1));
        continue;
      }
      console.error(`❌ fetch error: ${e.message} | mint: ${mint}`);
      return null;
    }
  }
}

// ---------- Helpers ----------
function now() { return new Date().toISOString(); }
function fmt(n) { try { return Number(n).toLocaleString("en-US"); } catch { return String(n); } }
function inferLive(c) {
  const isLive = c?.is_currently_live === true;
  const viewers = typeof c?.num_participants === "number" ? c.num_participants : null;
  const inferred = isLive || (typeof viewers === "number" && viewers >= VIEWERS_THRESHOLD);
  return { inferred, isLive, viewers };
}

// ---------- WS ----------
const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ WS connected:", WS_URL);
  ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  console.log("📡 Subscribed: subscribeNewToken");
});

ws.on("message", async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const mint =
    msg?.mint || msg?.tokenMint || msg?.ca || msg?.address || msg?.mintAddress || null;

  if (!mint) return;

  // тянем coin
  const c = await fetchCoin(mint);
  if (!c) return;

  const { inferred, isLive, viewers } = inferLive(c);

  if (inferred) {
    console.log(
      `${now()} 🔥 LIVE | ${mint} | ${c?.symbol || ""} ${c?.name ? `(${c.name})` : ""}`.trim(),
      `| viewers=${viewers ?? "n/a"} | is_currently_live=${isLive}`
    );
  } else {
    console.log(
      `${now()} … not live | ${mint} | viewers=${viewers ?? "n/a"} | is_currently_live=${isLive}`
    );
  }
});

ws.on("close", () => console.log("❌ WS closed"));
ws.on("error", (e) => console.error("WS error:", e?.message ?? e));
