// tg-digest — дайджест Telegram-каналов и RSS: каждые 15 минут сбор в пул, по расписанию выпуск → Gemini → группа.
// 2026-10-07 18:52 · v1.11 · Nick Churkin
//
// R2 `DIGEST` (бакет tg-digest; ключ = объект с JSON): источники — `channels` (свои, [мой]), `background` (мир, [мир]), `tech` (технологии, [тех]):
//              юзернеймы каналов с открытой лентой t.me/s или URL RSS-лент;
//              `last` — {источник: id последнего поста (Telegram) или время последнего материала, мс (RSS)};
//              `pool` — собранное за сутки: [{src, tier, url, date, views, text, pub}], pub — уже в выпуске;
//              `settings` — {hours: [часы MSK], paused, focus, alerts}, `status` — итог прошлого выпуска,
//              `alerts` — объявленные тревоги за двое суток [{at, title, urls}].
// Где крутится (с 04.10): бесплатный Workers режет вызов на 10 мс CPU, а сбор тратит ~90 мс — поэтому `scheduled`
// и команды бота исполняет local.mjs на GCP tgproxy (Node, R2 через REST, long polling Telegram).
// На Cloudflare остался только fetch: POST /notify?key=<ADMIN_KEY>, тело — текст (HTML можно) — сообщение владельцу.
// Каждые 15 минут: сбор всех источников в пул и проверка на экстренное (🚨 сразу в группу);
// в первую четверть часа из settings.hours, не на паузе — выпуск из неопубликованного (тогда без проверки:
// её сделает следующий сбор — окно тревог ALERT_HOURS). Команды — только от OWNER_ID, долгие (SLOW) — с «⏳» вперёд.
// Семейные MTProto-прокси: каждый cron — TCP до каждого из PROXIES; PROXY_FAILS неудач подряд — ⚠️ владельцу, ожил — ✅.
// Туннель за прокси проверяет сам стенд (mtg-check) и шлёт через /notify.

// Лимит бесплатного Workers — 50 подзапросов за вызов. Сбор тратит не больше BUDGET: страница на источник,
// своим — вторая, если первая вся новая; не хватило — источник ждёт следующего часа. Остаток — Gemini и отправка.
const BUDGET = 40;
const MAX_PAGES = 2;          // страниц ленты своего канала за сбор (по 20 постов)
const FIRST_RUN_HOURS = 12;   // источника нет в `last` — берём вышедшее за столько часов
const POOL_HOURS = 24;        // столько держим опубликованное в пуле (для /ask)
const CAP = { mine: 1000, world: 300, tech: 400 };  // символов текста в пул и промпт
const MIN_TEXT = 15;          // короче — пропуск (стикеры, «👍»)
const TG_LIMIT = 4000;        // длина одного сообщения (у Telegram 4096)
const TIERS = { channels: 'mine', background: 'world', tech: 'tech' };
const LABEL = { mine: 'мой', world: 'мир', tech: 'тех' };
const ALERT_MODELS = 'gemini-flash-lite-latest,gemini-flash-latest';  // проверка дешёвая и частая — лёгкая модель
const ALERT_HOURS = 2;        // тревогу ищем в материалах за столько часов (второй источник мог прийти раньше)
const ALERT_KEEP_HOURS = 48;
// PROXIES — env, «host:port,host:port»; пусто — проверка выключена
const proxies = (env) => (env.PROXIES ?? '').split(',').filter(Boolean)
  .map((p) => { const [hostname, port = 443] = p.trim().split(':'); return { hostname, port: +port }; });
const PROXY_FAILS = 2;        // подряд неудач до тревоги (30 мин): перезагрузка стенда — не повод  // столько помним объявленное, чтобы не повторять

const PROMPT = `Ты — шеф-редактор новостного Telegram-канала. Составь дайджест главного по публикациям
из разных каналов ниже: что интересного происходит в мире.

Требования:
1. Язык — русский.
2. Заголовок с датой и временем выпуска, затем рубрики с эмодзи (🌐 Мир, 💼 Экономика, 🚀 Технологии и ИИ и т.п.),
   только те, по которым есть новости.
3. По каждой новости 1–3 предложения сути, без воды; в конце ссылка на пост: <a href="URL">Канал</a>.
4. Одна новость из нескольких каналов — один пункт с несколькими ссылками.
5. Рекламу, розыгрыши, призывы подписаться и мелочь без новостной ценности выкидывай.
6. Формат — Telegram HTML: только <b>, <i>, <a href="…">; никаких Markdown, <br>, <p>, списков-тегов.
   Пункты начинай с «• ». Никаких вступлений и пояснений — сразу готовый текст.
7. Публикации помечены: [мой] — каналы читателя, главное содержание дайджеста; [мир] — ленты агентств и
   мировых СМИ; [тех] — технологические издания. Из [мир] сделай первую рубрику «🌍 Главное в мире»: 5–7 самых
   важных событий. Из [тех] и технологических [мой] — рубрику «🚀 Технологии и ИИ»: 5–7 самых заметных новостей
   (релизы, запуски, сделки, исследования, уязвимости), без мелочи и рекламы курсов. Английское пересказывай
   по-русски. Событие из нескольких источников — один пункт со всеми ссылками, в разных рубриках не повторяй.`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENTITIES[e] ?? m;
});

// Страница t.me/s/<канал> → посты по возрастанию id.
export function parsePage(html) {
  const posts = [];
  for (const block of html.split('class="tgme_widget_message_wrap').slice(1)) {
    const post = block.match(/data-post="([^"/]+)\/(\d+)"/);
    if (!post) continue;
    const body = block.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/);
    const text = body ? decode(body[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim() : '';
    posts.push({
      channel: post[1],
      id: +post[2],
      date: block.match(/<time datetime="([^"]+)"/)?.[1] ?? '',
      views: block.match(/tgme_widget_message_views">([^<]+)</)?.[1] ?? '',
      text,
    });
  }
  return posts.sort((a, b) => a.id - b.id);
}

// Новые посты канала: листаем назад, пока не дошли до last или до границы по времени.
export async function collect(channel, last, fetchPage, now = Date.now(), hours = FIRST_RUN_HOURS, pages = MAX_PAGES) {
  const since = last ? 0 : now - hours * 3600e3;
  const fresh = [];
  let before = '';
  for (let page = 0; page < pages; page++) {
    const posts = parsePage(await fetchPage(channel, before));
    if (!posts.length) break;
    const keep = posts.filter((p) => (last ? p.id > last : Date.parse(p.date) >= since));
    fresh.unshift(...keep);
    if (keep.length < posts.length || posts[0].id <= 1) break;  // дошли до старого
    before = posts[0].id;
  }
  return fresh;
}

// Текст длиннее лимита — режем по абзацам (пустая строка), абзац длиннее лимита — по строкам.
export function split(text, limit = TG_LIMIT) {
  const chunks = [];
  let cur = '';
  for (const part of text.split(/(?<=\n)/)) {
    if (cur && cur.length + part.length > limit) { chunks.push(cur.trim()); cur = ''; }
    cur += part;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

const fetchTme = async (channel, before) => {
  const r = await fetch(`https://t.me/s/${channel}${before ? `?before=${before}` : ''}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (tg-digest)' } });
  if (!r.ok) throw new Error(`t.me/s/${channel}: HTTP ${r.status}`);
  return r.text();
};

const sourceName = (p) => (isUrl(p.src) ? new URL(p.url).hostname.replace(/^(www|feeds|rss)\./, '') : p.src);
const postList = (posts) => posts.map((p, i) => `[${i + 1}] [${LABEL[p.tier]}] ${sourceName(p)} · ${p.date}` +
  (p.views ? ` · ${p.views} просм.` : '') + `\n${p.url}\n${p.text}`).join('\n\n');

// RSS 2.0 или Atom → посты: заголовок + описание, ссылка, дата.
// теги чистим и до, и после decode: в Atom HTML бывает экранирован (&lt;p&gt;)
const cdata = (s) => decode((s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').replace(/<[^>]+>/g, ''))
  .replace(/<[^>]+>/g, '').trim();
export function parseRss(xml) {
  const atom = !/<item[\s>]/.test(xml) && /<entry[\s>]/.test(xml);
  return xml.split(atom ? /<entry[\s>]/ : /<item[\s>]/).slice(1).map((item) => {
    const tag = (t) => item.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`))?.[1];
    // Atom: ссылка — атрибут href у <link rel="alternate"> (или у первого <link>), дата — published/updated
    const url = atom
      ? decode(item.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] ?? item.match(/<link\b[^>]*href="([^"]+)"/)?.[1] ?? '')
      : cdata(tag('link'));
    const d = new Date(cdata(atom ? tag('published') ?? tag('updated') : tag('pubDate')));
    const date = Number.isNaN(+d) ? '' : d.toISOString();
    const about = atom ? tag('summary') ?? tag('content') : tag('description');
    return { channel: url ? new URL(url).hostname.replace(/^(www|feeds|rss)\./, '') : '', id: url, url, date, views: '',
      text: [cdata(tag('title')), cdata(about)].filter(Boolean).join('. ') };
  }).filter((p) => p.url && !Number.isNaN(Date.parse(p.date)));
}

const isUrl = (s) => /^https?:\/\//.test(s);
const fetchRss = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (tg-digest)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseRss(await r.text());
};
// Проверка источника перед /add: лента открывается и в ней есть посты.
const sourceAlive = async (src) => (isUrl(src) ? fetchRss(src) : fetchTme(src, '').then(parsePage)).then((x) => x.length > 0);

const nowMsk = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'long', timeStyle: 'short' });

async function llm(env, system, user, { models = env.GEMINI_MODEL, json = false } = {}) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: json ? 0 : 0.4, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  let err = '';
  // GEMINI_MODEL — список через запятую: перегружена или снята первая — идём ко второй
  for (const model of models.split(',').map((m) => m.trim())) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 5000));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body,
      });
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
      if (text) return { text, model };
      err = `${model}: ${r.status} ${JSON.stringify(d.error?.message ?? d.promptFeedback ?? d).slice(0, 200)}`;
      if (![429, 500, 503].includes(r.status)) break;
    }
  }
  throw new Error(`Gemini: ${err}`);
}

async function send(env, chat, text) {
  const call = (body) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true }, ...body }),
  }).then((r) => r.json());
  let d = await call({ parse_mode: 'HTML' });
  if (!d.ok && /parse entities/i.test(d.description ?? '')) d = await call({});  // сломанная разметка — без неё
  if (!d.ok) throw new Error(`sendMessage: ${d.description}`);
}

const sendLong = async (env, chat, text) => { for (const chunk of split(text)) await send(env, chat, chunk); };


const ASK_PROMPT = `Ты отвечаешь на вопрос по свежим публикациям Telegram-каналов ниже. Отвечай по-русски, коротко и по делу,
только по этим публикациям; чего в них нет — так и скажи. После каждого факта — ссылка на пост:
<a href="URL">Канал</a>. Формат — Telegram HTML: только <b>, <i>, <a href="…">, без Markdown.`;

const DEFAULTS = { hours: [9, 14, 20], paused: false, focus: '', alerts: true };
const getJson = async (env, key, dflt) => JSON.parse((await (await env.DIGEST.get(key))?.text()) ?? 'null') ?? dflt;
const settingsOf = async (env) => ({ ...DEFAULTS, ...(await getJson(env, 'settings', {})) });

// Сбор: новое из всех источников в пул (без повторов по url), чистка пула от старого.
export async function collectAll(env, budget = BUDGET, now = Date.now()) {
  const last = await getJson(env, 'last', {});
  const pool = await getJson(env, 'pool', []);
  const seen = new Set(pool.map((p) => p.url));
  const left = { n: budget };
  const errors = [];
  let added = 0;
  for (const [key, tier] of Object.entries(TIERS)) {
    for (const src of await getJson(env, key, [])) {
      if (left.n <= 0) { errors.push(`${src}: ждёт следующего часа (лимит запросов)`); continue; }
      try {
        let posts;
        if (isUrl(src)) {
          left.n--;
          const since = last[src] || now - FIRST_RUN_HOURS * 3600e3;
          posts = (await fetchRss(src)).filter((p) => Date.parse(p.date) > since);
          if (posts.length) last[src] = Math.max(last[src] ?? 0, ...posts.map((p) => Date.parse(p.date)));
        } else {
          const counted = (c, b) => { left.n--; return fetchTme(c, b); };
          const pages = Math.min(tier === 'mine' ? MAX_PAGES : 1, left.n);
          posts = (await collect(src, last[src] ?? 0, counted, now, FIRST_RUN_HOURS, pages))
            .map((p) => ({ ...p, url: `https://t.me/${src}/${p.id}` }));
          if (posts.length) last[src] = Math.max(last[src] ?? 0, ...posts.map((p) => p.id));
        }
        for (const p of posts) {
          if (p.text.length < MIN_TEXT || seen.has(p.url)) continue;
          seen.add(p.url);
          added++;
          pool.push({ src, tier, url: p.url, date: p.date, views: p.views, text: p.text.slice(0, CAP[tier]), pub: false });
        }
      } catch (e) {
        errors.push(`${src}: ${e.message}`);
      }
    }
  }
  // опубликованное держим сутки (для /ask), неопубликованное — двое (ждёт выпуска, но не вечно)
  const age = (p) => now - Date.parse(p.date);
  const kept = pool.filter((p) => age(p) < (p.pub ? 1 : 2) * POOL_HOURS * 3600e3);
  await env.DIGEST.put('pool', JSON.stringify(kept));
  await env.DIGEST.put('last', JSON.stringify(last));
  return { pool: kept, added, errors };
}

// Выпуск из неопубликованного в пуле. Без новых постов своих каналов не выходит — один фон не публикуем.
export async function publish(env, { pool, errors = [], dry = false, to = env.TARGET_CHAT } = {}) {
  pool ??= await getJson(env, 'pool', []);
  const { focus } = await settingsOf(env);
  const fresh = pool.filter((p) => !p.pub);
  const n = (tier) => fresh.filter((p) => p.tier === tier).length;
  const res = { at: new Date().toISOString(), dry, mine: n('mine'), world: n('world'), tech: n('tech'), pool: pool.length,
    errors, model: '', digest: '' };
  try {
    if (res.mine) {
      const system = focus ? `${PROMPT}\n\nПожелания читателя к отбору: ${focus}` : PROMPT;
      ({ text: res.digest, model: res.model } = await llm(env, system, `Выпуск: ${nowMsk()} MSK. Публикаций: ` +
        `${res.mine} [мой], ${res.world} [мир], ${res.tech} [тех].\n\n${postList(fresh)}`));
      if (!dry) {
        await sendLong(env, to, res.digest);
        for (const p of fresh) p.pub = true;
        await env.DIGEST.put('pool', JSON.stringify(pool));
      }
    }
  } catch (e) {
    res.error = e.message;
  }
  if (!dry) await env.DIGEST.put('status', JSON.stringify({ ...res, digest: res.digest.length }));
  return res;
}

export async function run(env, opts = {}) {
  const { pool, errors } = await collectAll(env);
  return publish(env, { ...opts, pool, errors });
}

// ── Экстренное ──────────────────────────────────────────────────────────────

const ALERT_PROMPT = `Ты — дежурный редактор. Ниже свежие публикации новостных источников. Реши, есть ли среди них
ЧРЕЗВЫЧАЙНОЕ событие, о котором читателя надо известить немедленно, не дожидаясь дайджеста. Порог очень высокий —
такое случается раз в несколько недель:
- начало войны, вторжение, удар по территории новой страны, объявление военного положения;
- теракт или катастрофа с массовыми жертвами (десятки погибших и больше), крупное стихийное бедствие;
- ядерный, радиационный, химический инцидент;
- гибель, отставка или свержение главы крупного государства, военный переворот;
- обвал рынков или курса рубля на десятки процентов, остановка крупнейших банков или платёжных систем.
НЕ тревога: продолжение уже идущих конфликтов (обычные удары, обстрелы, сводки), заявления и угрозы политиков,
прогнозы, слухи, анонсы, локальные происшествия, всё уже объявленное ранее (и его развитие).
Тревога только если событие подтверждают минимум два РАЗНЫХ источника из списка.
Ответ — строго JSON: {"alert": false} или {"alert": true, "title": "заголовок по-русски до 80 символов",
"text": "2–3 предложения по-русски: что, где, когда, масштаб", "urls": ["ссылки на публикации из списка"]}.`;

export const sourceKey = (url) => (url.startsWith('https://t.me/') ? url.split('/')[3].toLowerCase() : new URL(url).hostname.replace(/^www\./, ''));

// Проверка свежих материалов на экстренное; объявленное — сразу в группу и в `alerts`.
export async function checkAlerts(env, pool, now = Date.now()) {
  const recent = pool.filter((p) => now - Date.parse(p.date) < ALERT_HOURS * 3600e3);
  if (!recent.length) return null;
  const known = (await getJson(env, 'alerts', [])).filter((a) => now - Date.parse(a.at) < ALERT_KEEP_HOURS * 3600e3);
  const told = new Set(known.flatMap((a) => a.urls));
  const fresh = recent.filter((p) => !told.has(p.url));
  if (!fresh.length) return null;
  const { text } = await llm(env, ALERT_PROMPT, (known.length ? `Уже объявлено, не повторяй:\n${known.map((a) => `- ${a.title}`).join('\n')}\n\n` : '') +
    `Публикации (${fresh.length}):\n\n${postList(fresh)}`, { models: ALERT_MODELS, json: true });
  const verdict = JSON.parse(text);
  if (!verdict.alert) return null;
  // модели не верим на слово: ссылки — только из списка, источники — разные
  const given = new Set(fresh.map((p) => p.url));
  const urls = [...new Set(verdict.urls ?? [])].filter((u) => given.has(u));
  if (new Set(urls.map(sourceKey)).size < 2 || !verdict.title) return null;
  const alert = { at: new Date(now).toISOString(), title: String(verdict.title).slice(0, 120), urls };
  const links = urls.map((u) => `<a href="${u}">${esc(sourceName(fresh.find((p) => p.url === u)))}</a>`).join(', ');
  await sendLong(env, env.TARGET_CHAT, `🚨 <b>${esc(alert.title)}</b>\n\n${esc(verdict.text ?? '')}\n\n${links}`);
  await env.DIGEST.put('alerts', JSON.stringify([...known, alert]));
  return alert;
}

// ── Команды ─────────────────────────────────────────────────────────────────

const HELP = `<b>tg-digest</b> — дайджест каналов
/list — каналы в дайджесте
/add @канал … — добавить свой (или перешлите мне пост из канала в личку)
/add мир @канал|URL-RSS … — в «🌍 Главное в мире»
/add тех @канал|URL-RSS … — в «🚀 Технологии и ИИ»
/del @канал|URL … — убрать отовсюду
/now — выпуск сейчас
/preview — каким был бы выпуск, ничего не публикуя
/status — прошлый выпуск и пул
/pause, /resume — плановые выпуски
/alerts on|off — экстренные сообщения 🚨
/schedule 9 14 20 — часы выпусков (MSK)
/focus текст — пожелания к отбору; /focus - — сбросить
/ask вопрос — ответ по всему собранному за сутки`;

export const COMMANDS = [
  ['list', 'источники'], ['add', 'добавить: свой | мир | тех'], ['del', 'убрать источник'],
  ['now', 'выпуск сейчас'], ['preview', 'выпуск без публикации'], ['status', 'прошлый выпуск'],
  ['pause', 'остановить плановые'], ['resume', 'возобновить плановые'], ['schedule', 'часы выпусков MSK'],
  ['focus', 'пожелания к отбору'], ['alerts', 'экстренные on|off'], ['ask', 'вопрос по ленте'], ['help', 'справка'],
];

// '@kod_ru', 't.me/kod_ru', 'https://t.me/s/kod_ru/123' → 'kod_ru'
export const channelName = (s) => s.replace(/^https?:\/\//, '').replace(/^(t\.me|telegram\.me)\/(s\/)?/, '')
  .replace(/^@/, '').split(/[/?#]/)[0].trim();

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function addChannels(env, names, key = 'channels') {
  const list = await getJson(env, key, []);
  const lower = new Set(list.map((c) => c.toLowerCase()));
  const out = [];
  for (const name of names.map((n) => (isUrl(n) && key !== 'channels' ? n.trim() : channelName(n))).filter(Boolean)) {
    const label = isUrl(name) ? name : `@${name}`;
    if (lower.has(name.toLowerCase())) { out.push(`= ${label} уже есть`); continue; }
    let ok = false;
    try { ok = await sourceAlive(name); } catch { /* ниже — «не открывается» */ }
    if (!ok) { out.push(`✗ ${label}: ${isUrl(name) ? 'не RSS или пустая лента' : 'лента t.me/s не открывается (закрытый канал или группа?)'}`); continue; }
    list.push(name);
    lower.add(name.toLowerCase());
    out.push(`+ ${label}${key === 'channels' ? '' : ` (${LABEL[TIERS[key]]})`}`);
  }
  await env.DIGEST.put(key, JSON.stringify(list));
  return out.join('\n') || 'Кого добавить? /add @канал, /add мир @канал, /add тех URL';
}

export async function command(env, text) {
  const [, cmd = '', rest = ''] = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/) ?? [];
  const args = rest.split(/[\s,]+/).filter(Boolean);
  const settings = await settingsOf(env);
  const saveSettings = (patch) => env.DIGEST.put('settings', JSON.stringify({ ...settings, ...patch }));

  switch (cmd.toLowerCase()) {
    case 'start': case 'help': return HELP;
    case 'list': {
      const channels = await getJson(env, 'channels', []);
      const last = await getJson(env, 'last', {});
      const mine = channels.length
        ? `<b>Свои: ${channels.length}</b>\n` + channels.map((c) => `• <a href="https://t.me/${c}">@${c}</a>` +
          (last[c] ? ` — прочитано до <a href="https://t.me/${c}/${last[c]}">#${last[c]}</a>` : ' — ещё не читался')).join('\n')
        : 'Своих каналов нет. /add @канал';
      let out = mine;
      for (const [key, title] of [['background', 'Мир'], ['tech', 'Тех']]) {
        const list = await getJson(env, key, []);
        if (list.length) out += `\n\n<b>${title}: ${list.length}</b>\n` +
          list.map((c) => (isUrl(c) ? `• ${esc(c)}` : `• <a href="https://t.me/${c}">@${c}</a>`)).join('\n');
      }
      return out;
    }
    case 'add': {
      const key = { мир: 'background', фон: 'background', тех: 'tech' }[args[0]?.toLowerCase()];
      return key ? addChannels(env, args.slice(1), key) : addChannels(env, args);
    }
    case 'del': {
      const drop = new Set(args.flatMap((a) => [a.trim(), channelName(a)]).map((c) => c.toLowerCase()));
      const gone = [];
      for (const key of Object.keys(TIERS)) {
        const list = await getJson(env, key, []);
        const keep = list.filter((c) => !drop.has(c.toLowerCase()));
        if (keep.length === list.length) continue;
        await env.DIGEST.put(key, JSON.stringify(keep));
        gone.push(...list.filter((c) => drop.has(c.toLowerCase())).map((c) => (isUrl(c) ? esc(c) : '@' + c)));
      }
      return gone.length ? `Убраны: ${gone.join(', ')}` : 'Таких в списке нет. /list';
    }
    case 'now': {
      const r = await run(env);
      return r.error ? `Выпуск не вышел: ${esc(r.error)}` : r.mine ? `Выпуск: ${r.mine} своих, ${r.world} мир, ${r.tech} тех, ${r.model}` : 'Новых постов в своих каналах нет.';
    }
    case 'preview': {
      const r = await run(env, { dry: true });
      return r.error ? `Не вышло: ${esc(r.error)}` : r.digest || 'Новых постов в своих каналах нет.';
    }
    case 'status': {
      const st = await getJson(env, 'status', null);
      const sched = `Расписание: ${settings.hours.join(', ')} MSK${settings.paused ? ' — ⏸ на паузе' : ''}` +
        `\nЭкстренные: ${settings.alerts ? 'вкл' : 'выкл'}` +
        (settings.focus ? `\nФокус: ${esc(settings.focus)}` : '');
      const pool = await getJson(env, 'pool', []);
      const wait = pool.filter((p) => !p.pub);
      const n = (t) => wait.filter((p) => p.tier === t).length;
      const queue = `\nВ пуле ${pool.length}, ждут выпуска: свои ${n('mine')}, мир ${n('world')}, тех ${n('tech')}`;
      if (!st) return `${sched}${queue}\nВыпусков ещё не было.`;
      const when = new Date(st.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
      return `${sched}${queue}\nПрошлый выпуск: ${when}: свои ${st.mine ?? st.posts}, мир ${st.world ?? 0}, тех ${st.tech ?? 0}` +
        (st.model ? `, ${st.model}` : '') + (st.error ? `\n✗ ${esc(st.error)}` : '') +
        (st.errors?.length ? `\nИсточники с ошибкой:\n${st.errors.map(esc).join('\n')}` : '');
    }
    case 'alerts': {
      const arg = args[0]?.toLowerCase();
      if (arg === 'on' || arg === 'off') await saveSettings({ alerts: arg === 'on' });
      const on = arg ? arg === 'on' : settings.alerts;
      const known = await getJson(env, 'alerts', []);
      return `Экстренные: ${on ? 'включены' : 'выключены'} (проверка каждые 15 минут)` + (known.length
        ? `\nПоследние:\n${known.slice(-5).map((a) => `• ${new Date(a.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })} ${esc(a.title)}`).join('\n')}`
        : '\nТревог ещё не было.');
    }
    case 'pause': await saveSettings({ paused: true }); return '⏸ Плановые выпуски остановлены. /resume — вернуть';
    case 'resume': await saveSettings({ paused: false }); return `▶️ Выпуски в ${settings.hours.join(', ')} MSK`;
    case 'schedule': {
      const hours = [...new Set(args.map(Number))].filter((h) => Number.isInteger(h) && h >= 0 && h <= 23).sort((a, b) => a - b);
      if (!hours.length) return `Сейчас: ${settings.hours.join(', ')} MSK. Пример: /schedule 9 14 20`;
      await saveSettings({ hours });
      return `Выпуски в ${hours.join(', ')} MSK`;
    }
    case 'focus': {
      if (!rest.trim()) return settings.focus ? `Фокус: ${esc(settings.focus)}\n/focus - — сбросить` : 'Фокус не задан. Пример: /focus меньше политики, больше технологий';
      const focus = rest.trim() === '-' ? '' : rest.trim().slice(0, 500);
      await saveSettings({ focus });
      return focus ? `Фокус: ${esc(focus)}` : 'Фокус сброшен';
    }
    case 'ask': {
      if (!rest.trim()) return 'Пример: /ask что пишут про ключевую ставку?';
      const pool = await getJson(env, 'pool', []);  // собранное за сутки — без запросов к источникам
      if (!pool.length) return 'Пул пуст: сбор идёт раз в час.';
      return (await llm(env, ASK_PROMPT, `Вопрос: ${rest.trim()}\n\nПубликации за сутки (${pool.length}):\n\n${postList(pool)}`)).text;
    }
    default: return 'Не знаю такой команды. /help';
  }
}

// Долгие команды: сразу «⏳», потом ответ.
const SLOW = { now: '⏳ Собираю выпуск, до пары минут…', preview: '⏳ Готовлю черновик, до пары минут…', ask: '⏳ Ищу ответ…' };

export async function onUpdate(env, update) {
  const msg = update.message;
  if (!msg || String(msg.from?.id) !== String(env.OWNER_ID)) return;  // чужим — молча
  const done = +((await (await env.DIGEST.get('update_id'))?.text()) ?? 0);
  if (update.update_id <= done) return;  // Telegram повторил доставку — уже обработано
  await env.DIGEST.put('update_id', String(update.update_id));

  let reply;
  const origin = msg.forward_origin;
  const name = msg.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
  if (origin?.type === 'channel') {
    reply = origin.chat.username ? await addChannels(env, [origin.chat.username]) : '✗ У этого канала нет публичной ленты';
  } else if (msg.text?.startsWith('/')) {
    if (SLOW[name]) await send(env, msg.chat.id, SLOW[name]);
    try { reply = await command(env, msg.text); } catch (e) { reply = `Ошибка: ${esc(e.message)}`; }
  } else return;
  await sendLong(env, msg.chat.id, reply);
}

// Порт прокси открывается за 10 с? Состояние в R2 `proxy:<host>` — {fails, down}; пишем только при изменении.
async function checkProxy(env, proxy) {
  let ok = false;
  try {
    // в node (local.mjs) — env.SOCKETS на net; динамически, потому что тесты и deploy.sh грузят модуль в node
    const { connect } = env.SOCKETS ?? await import('cloudflare:sockets');
    const sock = connect(proxy);
    ok = await Promise.race([sock.opened.then(() => true), new Promise((r) => setTimeout(r, 10000, false))]);
    sock.close().catch(() => {});
  } catch { /* ok = false */ }
  const key = `proxy:${proxy.hostname}`;
  const was = await getJson(env, key, { fails: 0, down: false });
  const now = ok ? { fails: 0, down: false } : { fails: was.fails + 1, down: was.down || was.fails + 1 >= PROXY_FAILS };
  if (now.fails === was.fails && now.down === was.down) return;
  await env.DIGEST.put(key, JSON.stringify(now));
  const where = `${proxy.hostname}:${proxy.port}`;
  if (now.down && !was.down) await send(env, env.OWNER_ID, `⚠️ Прокси ${where} не отвечает ${now.fails * 15} мин`);
  if (!now.down && was.down) await send(env, env.OWNER_ID, `✅ Прокси ${where} снова отвечает`);
}

export default {
  async scheduled(event, env) {
    await Promise.all(proxies(env).map((p) => checkProxy(env, p).catch((e) => console.log(`прокси ${p.hostname}: ${e.message}`))));
    const { hours, paused, alerts } = await settingsOf(env);
    const t = new Date(event.scheduledTime);
    const hour = +t.toLocaleString('en-US', { timeZone: 'Europe/Moscow', hour: 'numeric', hourCycle: 'h23' });
    if (paused || !hours.includes(hour) || t.getUTCMinutes() >= 15) {
      const { pool, added, errors } = await collectAll(env);
      let alert = null;
      if (alerts && added) {
        try { alert = await checkAlerts(env, pool); } catch (e) { errors.push(`тревоги: ${e.message}`); }
      }
      console.log(JSON.stringify({ collect: added, pool: pool.length, alert: alert?.title, errors }));
      return;
    }
    const res = await run(env);
    console.log(JSON.stringify({ ...res, digest: res.digest.length }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/notify') return new Response('tg-digest', { status: 404 });
    if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
    const text = (await request.text()).trim();
    if (!text) return new Response('empty', { status: 400 });
    await sendLong(env, env.OWNER_ID, text);
    return new Response('ok');
  },
};
