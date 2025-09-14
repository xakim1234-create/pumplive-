// index.js — v4.2: (основано на v4.1) LIVE-only + офиц. соцсети + токеновые метрики + Telegram notify
import WebSocket from 'ws';
import fetch from 'node-fetch';

const WS_URL = 'wss://pumpportal.fun/api/data';
const API    = 'https://frontend-api-v3.pump.fun';

const CHECK_INTERVAL   = 5000;      // каждые 5с проверка
const MAX_LIFETIME_MS  = 30000;     // живём максимум 30с
const MIN_GAP_MS       = 800;       // глобальный лимит запросов ~1.2 rps
const MAX_RETRIES      = 2;
const MAX_WATCHERS     = 500;

// ====== Telegram ======
function mdEscape(s = '') {
  // экранируем markdown-символы, чтобы Телега не ругалась
  return String(s).replace(/([_*[\]()~`>#+=|{}.!\\-])/g, '\\$1');
}

async function notifyLive({ name, symbol, mint, mcap_usd, coin }) {
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT_ID) return;

  const lines = [
    '🎥 LIVE START',
    `Name: ${mdEscape(name || coin?.name || '-')}`,
    `Ticker: ${mdEscape(symbol || coin?.symbol || '-')}`,
    `Mint: ${mint}`,
    (typeof coin?.usd_market_cap === 'number' || typeof mcap_usd === 'number')
      ? `MarketCap: $${(coin?.usd_market_cap ?? mcap_usd).toFixed(2)}`
      : null,
    '',
    'Socials:',
    coin?.telegram ? `- Telegram: ${mdEscape(coin.telegram)}` : null,
    coin?.twitter  ? `- Twitter: ${mdEscape(coin.twitter)}`   : null,
    coin?.discord  ? `- Discord: ${mdEscape(coin.discord)}`   : null,
    coin?.website  ? `- Website: ${mdEscape(coin.website)}`   : null,
    '',
    `Axiom: https://axiom.trade/meme/${mint}`,
  ].filter(Boolean).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TG_CHAT_ID,
        text: lines,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    console.log(`[tg] sent LIVE for ${mint}`);
  } catch (e) {
    console.log('tg send error:', e.message);
  }
}

// ====== состояние и метрики ======
const tracking = new Map(); // mint -> interval timer
const seen     = new Set();
let ws;
let lastWsMsgAt = 0;
let lastLiveAt  = 0;

const metrics = {
  // тиковые (HTTP)
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,

  // токеновые
  tokens_tracked: 0,
  tokens_completed: 0,
  tokens_live: 0,
  tokens_dropped: 0,
  tokens_missed: 0, // дропнули, а через минуту оказался live
};

// глобальный лимитер HTTP
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) {
    await new Promise(r => setTimeout(r, nextAvailableAt - now));
  }
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// безопасный fetch JSON с ретраями
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'cache-control': 'no-cache',
          'user-agent': 'pumplive-watcher/4.2',
        },
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
      if (!text || text.trim() === '') {
        metrics.emptyBody++;
        throw new Error('Empty body');
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

// только официальные поля соцсетей
function collectOfficialSocials(coin) {
  const socials = [];
  if (coin?.telegram) socials.push(`telegram=${coin.telegram}`);
  if (coin?.twitter)  socials.push(`twitter=${coin.twitter}`);
  if (coin?.discord)  socials.push(`discord=${coin.discord}`);
  if (coin?.website)  socials.push(`website=${coin.website}`);
  return socials;
}

// watcher: 30с окно, чек каждые 5с
function startLiveWatch(mint, name = '', symbol = '') {
  if (tracking.has(mint)) return;
  if (tracking.size >= MAX_WATCHERS) return;

  metrics.tokens_tracked++;
  const startedAt = Date.now();

  const timer = setInterval(async () => {
    try {
      if (Date.now() - startedAt > MAX_LIFETIME_MS) {
        clearInterval(timer);
        tracking.delete(mint);
        metrics.tokens_dropped++;
        metrics.tokens_completed++;

        // бэкап-проверка через 1 минуту: считаем реальный «miss»
        setTimeout(async () => {
          try {
            const coin = await safeGetJson(`${API}/coins/${mint}`);
            if (coin && coin.is_currently_live) {
              metrics.tokens_missed++;
            }
          } catch {}
        }, 60_000);

        return;
      }

      const coin = await safeGetJson(`${API}/coins/${mint}`);
      if (!coin) return;

      if (coin.is_currently_live) {
        clearInterval(timer);
        tracking.delete(mint);
        metrics.tokens_live++;
        metrics.tokens_completed++;

        const socialsList = collectOfficialSocials(coin);
        if (socialsList.length === 0) return; // все 4 null → пропускаем

        lastLiveAt = Date.now();

        console.log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
        console.log(`   mint: ${mint}`);
        if (typeof coin.usd_market_cap === 'number') {
          console.log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
        }
        console.log(`   socials: ${socialsList.join('  ')}`);
        console.log(`   axiom: https://axiom.trade/meme/${mint}`);

        // отправка в Telegram
        await notifyLive({
          name: coin.name || name,
          symbol: coin.symbol || symbol,
          mint,
          mcap_usd: coin.usd_market_cap,
          coin,
        });
      }
    } catch (e) {
      metrics.httpOther++;
      console.log('⚠️  live-check error:', e.message);
    }
  }, CHECK_INTERVAL);

  tracking.set(mint, timer);
}

// WebSocket: только новые токены (как и раньше)
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ WS connected, subscribing to new tokens…');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', (raw) => {
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

  ws.on('close', () => {
    metrics.reconnects++;
    console.log('🔌 WS closed → Reconnecting in 5s…');
    setTimeout(connect, 5000);
  });

  ws.on('error', (e) => {
    console.log('❌ WS error:', e.message);
  });
}

// минутный heartbeat + guard
setInterval(() => {
  const now = Date.now();
  const secSinceWs   = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt  ? Math.round((now - lastLiveAt) / 60000) : -1;

  console.log(
    `[stats] watchers=${tracking.size}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}`
  );
  console.log(
    `        tokens_tracked=${metrics.tokens_tracked} completed=${metrics.tokens_completed} ` +
    `live=${metrics.tokens_live} dropped=${metrics.tokens_dropped} missed=${metrics.tokens_missed}`
  );

  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// старт
console.log('Worker starting…');
connect();
