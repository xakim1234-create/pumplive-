// index.js — v5.0 (queue-based) + Telegram photo + Axiom /t/{mint}
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://pumpportal.fun/api/data";
const API = "https://frontend-api-v3.pump.fun";

// === Telegram (замени при необходимости)
const TG_TOKEN = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TG_CHAT_ID = "-4857972467";

// === Тюнинг под стабильность ===
const MIN_GAP_MS = 1500;           // глобальный лимитер RPS (~0.66 rps)
const MAX_LIFETIME_MS = 120_000;   // ждём LIVE до 2 минут
const RECHECK_DELAY_MS = 4000;     // если ещё не LIVE — вернём в очередь через 4с
const MAX_QUEUE = 1000;            // максимум одновременно отслеживаемых mint
const MAX_RETRIES = 2;

let ws;
let lastWsMsgAt = 0;
let lastLiveAt = 0;

// ——— метрики
const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
};

// ——— лог и глобальный троттлер
function log(...a) { console.log(new Date().toISOString(), ...a); }
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await new Promise(r => setTimeout(r, nextAvailableAt - now));
  }
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// ——— безопасный GET JSON
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          "user-agent": "pumplive-watcher/5.0"
        }
      });

      if (r.status === 429) {
        metrics.http429++;
        // Мягкий backoff при 429
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
    } catch (e) {
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

// ——— форматтеры
function formatNumber(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
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
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          photo,
          caption: text,
          parse_mode: "HTML"
        })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text,
          parse_mode: "HTML"
        })
      });
    }
  } catch (e) {
    log("⚠️  telegram send error:", e.message);
  }
}

// =====================
//       ОЧЕРЕДЬ
// =====================
const inQueue = new Set(); // дедупликация по mint
const queue = [];          // [{ mint, name, symbol, enqueuedAt, expiresAt }]
function enqueue(mint, name = "", symbol = "") {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({
    mint,
    name,
    symbol,
    enqueuedAt: now,
    expiresAt: now + MAX_LIFETIME_MS,
    nextTryAt: now
  });
  inQueue.add(mint);
}

function requeue(item) {
  // Обновим nextTryAt для повторной проверки
  item.nextTryAt = Date.now() + RECHECK_DELAY_MS;
  queue.push(item);
}

function queueSize() {
  return inQueue.size;
}

// Один воркер, который берёт задания по одному и уважает MIN_GAP_MS
async function workerLoop() {
  while (true) {
    // Возьмём следующую готовую задачу
    let idx = -1;
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].nextTryAt <= now) { idx = i; break; }
    }

    if (idx === -1) {
      // Нечего делать прямо сейчас — немного подождём
      await new Promise(r => setTimeout(r, 250));
      continue;
    }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;

    if (Date.now() > expiresAt) {
      // истёк срок ожидания — снимаем с учёта
      inQueue.delete(mint);
      continue;
    }

    // Дёргаем API
    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) {
      // Ошибка/пусто — дадим второй шанс позже
      requeue(item);
      continue;
    }

    // LIVE?
    if (coin.is_currently_live) {
      // Соцсети — прежнее поведение: если все null, не шлём
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) {
        // не отправляем, но считаем, что задача завершена
        inQueue.delete(mint);
        continue;
      }

      // Готовим и шлём
      lastLiveAt = Date.now();

      // Логи в консоль (как раньше)
      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === "number")
        log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join("  ")}`);

      // Красивое сообщение в ТГ
      const title = `${coin.name || name} (${coin.symbol || symbol})`;
      const mcapStr = typeof coin.usd_market_cap === "number"
        ? `$${formatNumber(coin.usd_market_cap)}`
        : "n/a";

      const msg = [
        `🎥 <b>LIVE START</b> | ${title}`,
        ``,
        `Mint: <code>${mint}</code>`,
        `🔗 <b>Axiom:</b> https://axiom.trade/t/${mint}`,
        `💰 Market Cap: ${mcapStr}`,
        ``,
        socials.join("\n")
      ].join("\n");

      const photoUrl = coin?.image_uri || null;

      log("📤 sending to Telegram…");
      sendTG({ text: msg, photo: photoUrl })
        .then(() => log("✅ sent to Telegram"))
        .catch(e => log("⚠️ TG error:", e.message));

      // Снимаем задачу с очереди
      inQueue.delete(mint);
      continue;
    }

    // Ещё не LIVE — вернём в очередь до истечения времени
    requeue(item);
  }
}

// =====================
//      WebSocket
// =====================
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

    // Имя/тикер из WS если есть
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

// =====================
//      Heartbeat
// =====================
setInterval(() => {
  const now = Date.now();
  const secSinceWs = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}`
  );

  // Страховка: если WS молчит > 300с — перезапускаем
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// =====================
//       Start!
 // =====================
log("Worker starting…");
connect();
workerLoop(); // запускаем воркер
