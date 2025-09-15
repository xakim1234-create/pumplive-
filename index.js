// index.js
// Ловим новые токены через WebSocket + проверяем через API, live они или нет

import WebSocket from "ws";
import { fetch as undiciFetch } from "undici";

const fetch = globalThis.fetch || undiciFetch;

// --- настройки ---
const WS_URL = "wss://pumpportal.fun/api/data";
const API    = "https://frontend-api-v3.pump.fun";
const VIEWERS_MIN = 1; // сколько зрителей считать «лайвом»

const HEADERS = {
  "accept": "application/json, text/plain, */*",
  "user-agent": "pumplive/1.0",
};

const fmt = (n) => (Number.isFinite(+n) ? Number(n).toLocaleString("en-US") : String(n).trim());

// --- подключение к WS ---
const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ WS connected:", WS_URL);
  ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  console.log("📡 Subscribed: subscribeNewToken");
});

ws.on("message", async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const mint = msg?.mint || msg?.tokenMint || msg?.ca;
  if (!mint) return;

  try {
    const r = await fetch(`${API}/coins/${mint}?_=${Date.now()}`, { headers: HEADERS });
    if (!r.ok) {
      console.log("⚠️ API non-OK", r.status, "| mint:", mint);
      return;
    }
    const c = await r.json();

    const flagLive = c?.is_currently_live === true || c?.is_live === true;
    const viewers  = (typeof c?.num_participants === "number") ? c.num_participants : null;
    const inferred = flagLive || (typeof viewers === "number" && viewers >= VIEWERS_MIN);

    if (inferred) {
      console.log(
        "🔥 LIVE",
        "| mint:", mint,
        "| name:", c?.name,
        "| symbol:", c?.symbol,
        "| viewers:", viewers ?? "n/a",
        "| mc_usd:", typeof c?.usd_market_cap === "number" ? "$"+fmt(c.usd_market_cap) : "n/a"
      );
    } else {
      console.log("… not live", "| mint:", mint, "| viewers:", viewers ?? "n/a");
    }
  } catch (e) {
    console.log("❌ fetch error:", e.message, "| mint:", mint);
  }
});

ws.on("close", () => console.log("❌ WS closed"));
ws.on("error", (err) => console.log("⚠️ WS error:", err?.message || err));
