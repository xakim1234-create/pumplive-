// ==== настройки быстрой верификации ====
const DEBOUNCE_MS_MIN = 900;     // первое ожидание после WS
const DEBOUNCE_MS_MAX = 1200;
const QUICK_RECHECKS = 6;        // сколько быстрых повторов
const QUICK_STEP_MS   = 500;     // шаг между повторами

// кэш, чтобы одну монету не проверять параллельно
const pending = new Set();

// аккуратный фетч с no-cache и ретраями на пустой ответ
async function fetchCoinSafe(mint, retries = 2) {
  const url = `${API}/coins/${mint}?_=${Date.now()}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "cache-control": "no-cache, no-store",
          "pragma": "no-cache",
          "user-agent": "live-sniffer/mini"
        }
      });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error("empty-body");
      return JSON.parse(text);
    } catch (e) {
      if (i < retries) {
        await new Promise(res => setTimeout(res, 350 + i * 200));
        continue;
      }
      throw e;
    }
  }
}

// быстрая проверка лайва (дебаунс + несколько проб)
async function confirmLive(mint, tokenFrom = "ws") {
  if (pending.has(mint)) return;
  pending.add(mint);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const debounce = Math.floor(DEBOUNCE_MS_MIN + Math.random() * (DEBOUNCE_MS_MAX - DEBOUNCE_MS_MIN));
  await sleep(debounce);

  let lastErr = null;
  for (let i = 0; i <= QUICK_RECHECKS; i++) {
    try {
      const c = await fetchCoinSafe(mint, 2);
      const live = c?.is_currently_live === true;
      const viewers = (typeof c?.num_participants === "number") ? c.num_participants : "n/a";

      if (live) {
        console.log(new Date().toISOString(),
          `🔥 LIVE | ${mint} | ${(c?.symbol || "").toString()} (${(c?.name || "").toString()}) | viewers=${viewers} | is_currently_live=true`
        );
        pending.delete(mint);
        return;
      }

      // не лайв — если это не последняя попытка, ждём и повторяем
      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }

      // последняя попытка и всё ещё false — логируем not live
      console.log(new Date().toISOString(),
        `… not live | ${mint} | viewers=${viewers} | is_currently_live=false`
      );
      pending.delete(mint);
      return;

    } catch (e) {
      lastErr = e;
      // сеть/пустое тело — ещё попытка, если есть
      if (i < QUICK_RECHECKS) {
        await sleep(QUICK_STEP_MS);
        continue;
      }
      console.log(`❌ fetch error: ${e.message} | mint: ${mint}`);
      pending.delete(mint);
      return;
    }
  }

  // на всякий случай
  if (pending.has(mint)) pending.delete(mint);
}

// === в твоём ws.on("message") просто вызывай confirmLive ===
// ...
ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    const mint = msg?.mint || msg?.tokenMint || msg?.ca || null;
    if (!mint) return;
    confirmLive(mint, "ws");
  } catch {}
});
