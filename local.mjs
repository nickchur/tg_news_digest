// Исполнитель tg-digest вне Cloudflare: бесплатный Workers режет вызов на 10 мс CPU, а сбор тратит ~90 мс.
// 2026-10-08 08:53 · v1.13 · Nick Churkin
//
// Крутится на GCP tgproxy (systemd tg-digest): long polling Telegram → onUpdate, на каждой границе четверти часа —
// тот же `scheduled`, что был у Worker'а. R2 — через REST Cloudflare (токен R2 из tg-digest).
// Окружение — как у Worker'а: BOT_TOKEN, GEMINI_API_KEY, GEMINI_MODEL, TARGET_CHAT, OWNER_ID,
// CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.
// `node local.mjs run` — разовый выпуск (сбор + публикация) и выход.
import worker, { onUpdate, run } from './worker.js';

const env = { ...process.env };
const R2 = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/tg-digest/objects/`;
const auth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

env.DIGEST = {
  async get(key) {
    const r = await fetch(R2 + encodeURIComponent(key), { headers: auth });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 get ${key}: ${r.status}`);
    const text = await r.text();
    return { text: async () => text };
  },
  async put(key, body) {
    const r = await fetch(R2 + encodeURIComponent(key), { method: 'PUT', headers: auth, body });
    if (!r.ok) throw new Error(`R2 put ${key}: ${r.status} ${await r.text()}`);
  },
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tg = async (method, params) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`${method}: ${d.description}`);
  return d.result;
};

if (process.argv[2] === 'run') {
  const res = await run(env);
  log(JSON.stringify({ ...res, digest: res.digest.length }));
  process.exit(0);
}

await tg('deleteWebhook', {});  // long polling несовместим с webhook
const QUARTER = 15 * 60e3;
let quarter = Math.floor(Date.now() / QUARTER);  // первый сбор — на ближайшей границе: рестарт не дублирует выпуск
let offset = +((await (await env.DIGEST.get('update_id'))?.text()) ?? 0) + 1;
log('старт, offset', offset);

for (;;) {
  const q = Math.floor(Date.now() / QUARTER);
  if (q !== quarter) {
    quarter = q;
    try { await worker.scheduled({ scheduledTime: q * QUARTER }, env); } catch (e) { log('scheduled:', e.message); }
  }
  const wait = Math.max(1, Math.min(50, Math.floor(((q + 1) * QUARTER - Date.now()) / 1000)));
  try {
    for (const u of await tg('getUpdates', { offset, timeout: wait, allowed_updates: ['message'] })) {
      offset = u.update_id + 1;
      try { await onUpdate(env, u); } catch (e) { log('update:', e.message); }
    }
  } catch (e) {
    log('getUpdates:', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
