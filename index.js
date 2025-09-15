// index.js — v7.7.0 (25s indicator wait, 3x3s samples, before-browser recheck, dedup 10m, rich diagnostics)
import os from "os";
import process from "process";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import WebSocket from "ws";
import fetch from "node-fetch";

// === Конфиг прямо тут ===
const TELEGRAM_BOT_TOKEN = "7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc";
const TELEGRAM_CHAT_ID = "-4857972467";

/* ================== CONFIG ================== */
const WS_URL = 'wss://pumpportal.fun/api/data';
const API    = 'https://frontend-api-v3.pump.fun';

// ——— Telegram
const TG_TOKEN   = process.env.TG_TOKEN   || '7598357622:AAHeGIaZJYzkfw58gpR1aHC4r4q315WoNKc';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '-4857972467';

// ——— REST троттлинг
const MIN_GAP_MS       = 1500;           // ~0.66 rps
const MAX_LIFETIME_MS  = 120_000;        // ждать LIVE до 2 минут
const MAX_QUEUE        = 1000;
const MAX_RETRIES      = 2;

// ——— “Зрители”
const VIEWERS_THRESHOLD = 30;
const INDICATOR_WAIT_MS = 25_000;        // ждём индикатор максимум 25с
const SAMPLE_COUNT      = 3;              // 3 замера
const SAMPLE_STEP_MS    = 3000;           // каждые ~3с
const VIEWERS_TASK_TIMEOUT = 60_000;      // общий таймаут одной задачи в браузере

// ——— Браузер
const VIEWERS_CONCURRENCY = 1;            // держим 1 вкладку одновременно
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ——— Диагностика ресурсов
const RES_LOG_EVERY_MS = 15_000;

// ——— Дедуп (не брать тот же mint 10 минут)
const DEDUP_TTL_MS = 10 * 60_000;

/* ================== STATE & METRICS ================== */
let ws;
let lastWsMsgAt = 0;
let lastLiveAt  = 0;

const metrics = {
  requests: 0, ok: 0, retries: 0,
  http429: 0, httpOther: 0,
  emptyBody: 0, skippedNull: 0,
  reconnects: 0,
  viewerTasksStarted: 0, viewerTasksDone: 0, viewerTasksDropped: 0,
  viewerOpenErrors: 0, viewerSelectorMiss: 0,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

// REST троттлер
let nextAvailableAt = 0;
async function throttle() {
  const now = Date.now();
  if (now < nextAvailableAt) await new Promise(r => setTimeout(r, nextAvailableAt - now));
  nextAvailableAt = Date.now() + MIN_GAP_MS;
}

// безопасный GET JSON
async function safeGetJson(url) {
  metrics.requests++;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttle();
      const r = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'cache-control': 'no-cache',
          'user-agent': 'pumplive-watcher/7.7.0'
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

/* ================== FORMATTERS ================== */
function formatNumber(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function extractOfficialSocials(coin) {
  const socials = [];
  if (coin?.website)  socials.push(`🌐 <b>Website:</b> ${coin.website}`);
  if (coin?.twitter)  socials.push(`🐦 <b>Twitter:</b> ${coin.twitter}`);
  if (coin?.telegram) socials.push(`💬 <b>Telegram:</b> ${coin.telegram}`);
  if (coin?.discord)  socials.push(`🎮 <b>Discord:</b> ${coin.discord}`);
  return socials;
}

/* ================== TELEGRAM ================== */
async function sendTG({ text, photo }) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    if (photo) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, photo, caption: text, parse_mode: 'HTML' })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
      });
    }
  } catch (e) {
    log('⚠️  telegram send error:', e.message);
  }
}

/* ================== API QUEUE ================== */
const inQueue = new Set();
const queue   = []; // [{ mint, name, symbol, enqueuedAt, expiresAt, nextTryAt }]

function enqueue(mint, name = '', symbol = '') {
  if (inQueue.has(mint)) return;
  if (inQueue.size >= MAX_QUEUE) return;
  const now = Date.now();
  queue.push({ mint, name, symbol, enqueuedAt: now, expiresAt: now + MAX_LIFETIME_MS, nextTryAt: now });
  inQueue.add(mint);
}
function requeue(item) { item.nextTryAt = Date.now() + 4000; queue.push(item); }
function queueSize()   { return inQueue.size; }

/* ================== VIEWERS QUEUE ================== */
const viewersQueue   = [];
const viewersInQueue = new Set();
let browser = null;
let viewersActive = 0;

// дедуп по mint на 10 минут
const recentlyHandled = new Map(); // mint -> timestamp

function markHandled(mint) {
  recentlyHandled.set(mint, Date.now());
}
function isRecentlyHandled(mint) {
  const ts = recentlyHandled.get(mint);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { recentlyHandled.delete(mint); return false; }
  return true;
}

function enqueueViewers({ mint, coin, fallbackName = '', fallbackSymbol = '' }) {
  if (viewersInQueue.has(mint)) return;
  if (isRecentlyHandled(mint)) return; // дедуп 10м
  viewersQueue.push({ mint, coin, fallbackName, fallbackSymbol, enqueuedAt: Date.now() });
  viewersInQueue.add(mint);
}

async function getBrowser() {
  if (browser) return browser;
  const execPath = await chromium.executablePath();
  browser = await puppeteer.launch({
    executablePath: execPath,
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: chromium.headless,
    protocolTimeout: 20_000, // fail-fast, чтобы не висеть надолго
  });
  log('✅ Chromium ready:', execPath);
  return browser;
}

// ——— полезные утилиты для логов ресурсов
let activePages = 0;
let lastChromeRssMB = 0;
async function logResources() {
  try {
    const mem = process.memoryUsage();
    const rssMB  = (mem.rss / (1024*1024)).toFixed(1);
    const heapMB = (mem.heapUsed / (1024*1024)).toFixed(1);
    const load1  = (osLoadAvg1() || 0).toFixed(2);
    const extra  = browser ? ` rss_chrome=${lastChromeRssMB ? lastChromeRssMB.toFixed(1)+'MB' : 'n/a'}` : '';
    console.log(`[res] cpu_node=${(process.cpuUsage().user/1e6).toFixed(1)}% rss_node=${rssMB}MB heap_node=${heapMB}MB load1=${load1} active_pages=${activePages}${extra}`);
  } catch {}
}
function osLoadAvg1() {
  try { return require('os').loadavg?.()[0]; } catch { return 0; }
}

// ——— подсчёт Chrome RSS (best effort)
async function updateChromeRSS() {
  try {
    if (!browser) { lastChromeRssMB = 0; return; }
    const proc = browser.process?.();
    if (!proc) return;
    // На Render `process.memoryUsage` для дочернего может быть недоступен.
    // Поэтому делаем best-effort: ничего не делаем. Оставляем предыдущий lastChromeRssMB.
  } catch {}
}

async function createPage() {
  const br = await getBrowser();
  let page;
  try {
    page = await br.newPage();
    activePages++;
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });

    // блокируем тяжёлое, НО НЕ блокируем stylesheet (вдруг он нужен для появления бейджа)
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return req.abort();
      req.continue();
    });

    // небольшие таймауты по умолчанию
    page.setDefaultTimeout(15_000);

    return page;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log('⚠️ page open error:', e.message);
    try { await page?.close({ runBeforeUnload: false }); } catch {}
    activePages = Math.max(0, activePages - 1);
    throw e;
  }
}

async function safeClosePage(page, afterError = false) {
  try { await page?.close({ runBeforeUnload: false }); } catch {}
  activePages = Math.max(0, activePages - 1);
  if (afterError) log('🗑 page:closed after error active_pages=' + activePages);
  else            log('🗑 page:closed active_pages=' + activePages);
}

/* ================== VIEWERS TASK ================== */

const INDICATOR_SELECTORS = ['#live-indicator', '.live-indicator', '[data-testid="live-indicator"]'];

async function waitIndicatorOrExplain(page, timeoutMs) {
  // сначала пробуем селекторы
  const selectorUnion = INDICATOR_SELECTORS.join(',');
  const found = await page.waitForSelector(selectorUnion, { timeout: timeoutMs }).catch(() => null);
  if (found) return { ok: true, reason: 'selector', details: null };

  // fallback: текст “LIVE” + цифры
  const tf = await page.waitForFunction(() => {
    const txt = document.body?.innerText || '';
    return /\bLIVE\b/i.test(txt) && /\b\d{1,4}\b/.test(txt);
  }, { timeout: timeoutMs }).catch(() => null);
  if (tf) return { ok: true, reason: 'text_fallback', details: null };

  // объясняем, почему не нашли
  const d = await page.evaluate((selectors) => {
    const count = (sel) => document.querySelectorAll(sel).length;
    const ready = document.readyState;
    const hasNext = !!document.querySelector('#__next');
    const hasRoot = !!document.querySelector('#root');
    const iframes = document.querySelectorAll('iframe').length;
    const txt = (document.body?.innerText || '').slice(0, 5000);
    const liveTxt = /\bLIVE\b/i.test(txt);
    const digits = /\b\d{1,4}\b/.test(txt);
    const counts = selectors.map(s => ({ sel: s, n: count(s) }));
    const nav = performance.getEntriesByType('navigation')[0];
    const perf = nav ? {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      load: Math.round(nav.loadEventEnd - nav.startTime),
      responseEnd: Math.round(nav.responseEnd - nav.startTime),
    } : null;
    return {
      ready, counts, hasNext, hasRoot, iframes,
      liveTxt, digits,
      perf,
      bodyPreview: (document.body?.outerHTML || '').slice(0, 1200)
    };
  }, INDICATOR_SELECTORS);

  const ua = await page.browser().userAgent();
  const vp = page.viewport();

  log(
    `[diag] indicator:miss ready=${d.ready} next=${d.hasNext} root=${d.hasRoot} iframes=${d.iframes} ` +
    `counts=${d.counts.map(c => `${c.sel}:${c.n}`).join('|')} liveTxt=${d.liveTxt} digits=${d.digits} ` +
    `perf=${d.perf ? JSON.stringify(d.perf) : 'n/a'} ua=${ua} viewport=${vp?.width}x${vp?.height}`
  );
  log('[diag] bodyPreview:', d.bodyPreview.replace(/\s+/g, ' ').slice(0, 1000));

  return { ok: false, reason: 'timeout_or_missing', details: d };
}

async function getViewersOnce(page) {
  // пробуем сначала через live-indicator родителя: span с цифрой
  const res = await page.evaluate((selectors) => {
    const root = document.querySelector(selectors.join(',')); // первый попавшийся
    let num = null;
    if (root) {
      const span = root.parentElement?.querySelector('span');
      if (span) {
        const txt = (span.textContent || '').trim();
        const m = txt.match(/\d+/);
        if (m) num = Number(m[0]);
      }
    }
    // fallback: поиск во всём теле
    if (num === null) {
      const txt = document.body?.innerText || '';
      const m2 = txt.match(/\b\d{1,4}\b/);
      if (m2) num = Number(m2[0]);
    }
    return Number.isFinite(num) ? num : null;
  }, INDICATOR_SELECTORS);

  if (!Number.isFinite(res)) return { ok: false, viewers: null, reason: 'not_a_number' };
  return { ok: true, viewers: res };
}

async function notifyTelegram(mint, coin, fallbackName, fallbackSymbol, viewers) {
  const socials = extractOfficialSocials(coin);
  const title = `${coin.name || fallbackName} (${coin.symbol || fallbackSymbol})`;
  const mcapStr = typeof coin.usd_market_cap === 'number' ? `$${formatNumber(coin.usd_market_cap)}` : 'n/a';
  const msg = [
    `🎥 <b>LIVE START</b> | ${title}`,
    ``,
    `Mint: <code>${mint}</code>`,
    `🔗 <b>Axiom:</b> https://axiom.trade/t/${mint}`,
    `💰 Market Cap: ${mcapStr}`,
    `👁 Viewers: ${viewers}`,
    ``,
    socials.join('\n')
  ].join('\n');

  const photoUrl = coin?.image_uri || null;
  log('📤 tg:send start');
  await sendTG({ text: msg, photo: photoUrl });
  log('✅ tg:sent');
}

async function viewersTask({ mint, coin, fallbackName, fallbackSymbol, detectAt }) {
  metrics.viewerTasksStarted++;
  markHandled(mint);
  const t0 = detectAt || Date.now();
  let page;

  // быстрый recheck перед браузером — вдруг уже не live
  const pre = await safeGetJson(`${API}/coins/${mint}`);
  if (!pre || pre?.is_currently_live === false) {
    log(`⏭️ skip before_browser mint=${mint} reason=already_not_live t_detect→taskStart=${Date.now()-t0}ms`);
    return;
  }

  const diag = { consoleErrors: [], pageErrors: [], reqFailed: [] };

  try {
    page = await createPage();

    page.on('console', msg => {
      if (msg.type() === 'error') diag.consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => diag.pageErrors.push(String(err)));
    page.on('requestfailed', req => {
      diag.reqFailed.push({
        url: req.url(),
        failure: req.failure()?.errorText,
        method: req.method(),
        type: req.resourceType()
      });
    });

    const navStart = Date.now();
    log(`🌐 goto:start url=https://pump.fun/coin/${mint}`);
    await page.goto(`https://pump.fun/coin/${mint}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000
    });
    const dtNav = Date.now() - navStart;
    // небольшая пауза для “догидратации”
    await new Promise(r => setTimeout(r, 1500));
    log(`🌐 goto:done dt_nav=${dtNav}ms wait_dom_extra=1500ms`);

    // ждём индикатор (расширенные селекторы, потом текстовый fallback)
    const indStart = Date.now();
    const ind = await waitIndicatorOrExplain(page, INDICATOR_WAIT_MS);
    const dtInd = Date.now() - indStart;
    if (!ind.ok) {
      log(`🔎 live-indicator:found=false dt=${dtInd}ms reason=${ind.reason}`);
      // ещё раз проверим API — возможно, уже не live, тогда скип сразу
      const again = await safeGetJson(`${API}/coins/${mint}`);
      if (!again || again?.is_currently_live === false) {
        await safeClosePage(page);
        log(`⏭️ skip reason=no_indicator_but_still_live timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicatorWait=${dtInd}ms detect→skip=${Date.now()-t0}ms`);
        return;
      }
      // считаем как miss (селектор не нашли, но API говорит live) — скип
      metrics.viewerSelectorMiss++;
      await safeClosePage(page);
      log(`⏭️ skip reason=no_indicator_and_still_live timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicatorWait=${dtInd}ms detect→skip=${Date.now()-t0}ms`);
      return;
    } else {
      log(`🔎 live-indicator:found=true dt=${dtInd}ms via=${ind.reason}`);
    }

    // 3 сэмпла по ~3 секунды
    let maxV = -1;
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const s = await getViewersOnce(page);
      if (!s.ok) {
        log(`📊 sample i=${i}/${SAMPLE_COUNT} ok=false reason=${s.reason}`);
      } else {
        maxV = Math.max(maxV, s.viewers);
        log(`📊 sample i=${i}/${SAMPLE_COUNT} ok=true viewers=${s.viewers}`);
        if (s.viewers >= VIEWERS_THRESHOLD) {
          // ранний выход: отправляем TG и закрываем
          await notifyTelegram(mint, coin, fallbackName, fallbackSymbol, s.viewers);
          await safeClosePage(page);
          log(`✅ threshold:hit viewers=${s.viewers} early=true timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicator=${dtInd}ms indicator→samples=${Date.now()-indStart}ms detect→checked=${Date.now()-t0}ms`);
          metrics.viewerTasksDone++;
          return;
        }
      }
      if (i < SAMPLE_COUNT) await new Promise(r => setTimeout(r, SAMPLE_STEP_MS));
    }

    // не достигли порога
    await safeClosePage(page);
    log(`⏭️ threshold:miss max=${maxV<0?'n/a':maxV} timeline detect→taskStart=${navStart - t0}ms taskStart→navDone=${dtNav}ms navDone→indicator=${dtInd}ms indicator→samples=${Date.now()-indStart}ms detect→checked=${Date.now()-t0}ms`);
    metrics.viewerTasksDone++;
  } catch (e) {
    metrics.viewerOpenErrors++;
    log('⚠️ viewers task error:', e.message);
    await safeClosePage(page, true);
  }
}

async function viewersWorkerLoop() {
  while (true) {
    if (viewersActive >= VIEWERS_CONCURRENCY || viewersQueue.length === 0) {
      await new Promise(r => setTimeout(r, 150));
      continue;
    }
    const job = viewersQueue.shift();
    viewersInQueue.delete(job.mint);

    viewersActive++;
    const detectAt = job.enqueuedAt;
    const task = viewersTask({ ...job, detectAt });

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('viewer task timeout')), VIEWERS_TASK_TIMEOUT));
    try { await Promise.race([task, timeout]); }
    catch (e) { metrics.viewerTasksDropped++; log('⚠️ viewers task dropped:', e.message); }
    finally { viewersActive--; }
  }
}

/* ================== API WORKER ================== */
async function apiWorkerLoop() {
  while (true) {
    let idx = -1; const now = Date.now();
    for (let i = 0; i < queue.length; i++) if (queue[i].nextTryAt <= now) { idx = i; break; }
    if (idx === -1) { await new Promise(r => setTimeout(r, 200)); continue; }

    const item = queue.splice(idx, 1)[0];
    const { mint, name, symbol, expiresAt } = item;
    if (Date.now() > expiresAt) { inQueue.delete(mint); continue; }

    const coin = await safeGetJson(`${API}/coins/${mint}`);
    if (!coin) { item.nextTryAt = Date.now() + 4000; queue.push(item); continue; }

    if (coin.is_currently_live) {
      const socials = extractOfficialSocials(coin);
      if (socials.length === 0) { inQueue.delete(mint); continue; } // твой фильтр

      inQueue.delete(mint);
      enqueueViewers({ mint, coin, fallbackName: name, fallbackSymbol: symbol });
      lastLiveAt = Date.now();

      log(`🎥 LIVE START | ${coin.name || name} (${coin.symbol || symbol})`);
      log(`   mint: ${mint}`);
      if (typeof coin.usd_market_cap === 'number') log(`   mcap_usd: ${coin.usd_market_cap.toFixed(2)}`);
      log(`   socials: ${socials.join('  ')}`);
      continue;
    }

    // пока не live — ещё попробуем позже
    item.nextTryAt = Date.now() + 4000;
    queue.push(item);
  }
}

/* ================== WEBSOCKET ================== */
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    log('✅ WS connected, subscribing to new tokens…');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', (raw) => {
    lastWsMsgAt = Date.now();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    const nm = msg?.name || msg?.tokenName || '';
    const sm = msg?.symbol || msg?.ticker || '';
    enqueue(mint, nm, sm);
  });

  ws.on('close', () => {
    metrics.reconnects++;
    log(`🔌 WS closed → Reconnecting in 5s…`);
    setTimeout(connect, 5000);
  });

  ws.on('error', (e) => log('❌ WS error:', e.message));
}

/* ================== HEARTBEAT & RES ================== */
setInterval(() => {
  const now = Date.now();
  const secSinceWs   = lastWsMsgAt ? Math.round((now - lastWsMsgAt) / 1000) : -1;
  const minSinceLive = lastLiveAt ? Math.round((now - lastLiveAt) / 60000) : -1;
  console.log(
    `[stats] watchers=${queueSize()}  ws_last=${secSinceWs}s  live_last=${minSinceLive}m  ` +
    `req=${metrics.requests} ok=${metrics.ok} retries=${metrics.retries} ` +
    `429=${metrics.http429} other=${metrics.httpOther} empty=${metrics.emptyBody} ` +
    `null=${metrics.skippedNull} reconnects=${metrics.reconnects}  ` +
    `vQ=${viewersQueue.length} vRun=${viewersActive} vStart=${metrics.viewerTasksStarted} vDone=${metrics.viewerTasksDone} ` +
    `vDrop=${metrics.viewerTasksDropped} vOpenErr=${metrics.viewerOpenErrors} vSelMiss=${metrics.viewerSelectorMiss} active_pages=${activePages}`
  );
  if (secSinceWs >= 0 && secSinceWs > 300) {
    console.log(`[guard] no WS messages for ${secSinceWs}s → force reconnect`);
    try { ws?.terminate(); } catch {}
  }
}, 60_000);

// ресурсы раз в 15с
setInterval(async () => {
  await updateChromeRSS();
  await logResources();
}, RES_LOG_EVERY_MS);

/* ================== STARTUP/SHUTDOWN ================== */
log('Worker starting…');
connect();
apiWorkerLoop();
viewersWorkerLoop();

process.on('SIGTERM', async () => { try { await browser?.close(); } catch {} process.exit(0); });
process.on('SIGINT',  async () => { try { await browser?.close(); } catch {} process.exit(0); });
