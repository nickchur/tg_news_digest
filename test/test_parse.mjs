// node test/test_parse.mjs — разбор страницы t.me/s, листание до last, разбивка на сообщения.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePage, parseRss, collect, collectAll, publish, checkAlerts, sourceKey, split, channelName, command } from '../worker.js';

const html = readFileSync(new URL('./durov.html', import.meta.url), 'utf8');
const posts = parsePage(html);
assert.ok(posts.length >= 15, `постов ${posts.length}`);
assert.ok(posts.every((p) => p.channel === 'durov' && p.id > 0 && !Number.isNaN(Date.parse(p.date))));
assert.ok(posts.every((p, i) => !i || posts[i - 1].id < p.id), 'по возрастанию id');
assert.ok(posts.some((p) => p.text.length > 100), 'тексты есть');
assert.ok(posts.every((p) => !/<[a-z]|&amp;|&quot;/i.test(p.text)), 'без тегов и сущностей');

// last в середине страницы: берём только новее, вторую страницу не просим
const ids = posts.map((p) => p.id);
const mid = ids[Math.floor(ids.length / 2)];
let calls = 0;
const page = async () => { calls++; return html; };
const fresh = await collect('durov', mid, page);
assert.deepEqual(fresh.map((p) => p.id), ids.filter((id) => id > mid));
assert.equal(calls, 1);

// last новее всех — пусто
assert.equal((await collect('durov', ids.at(-1), page)).length, 0);

// первый запуск: окно по времени от даты последнего поста
const now = Date.parse(posts.at(-1).date) + 1000;
const first = await collect('durov', 0, page, now);
assert.ok(first.length >= 1 && first.every((p) => now - Date.parse(p.date) <= 12 * 3600e3));

// разбивка: куски в лимите, текст не теряется
const long = Array.from({ length: 200 }, (_, i) => `• пункт ${i} ` + 'x'.repeat(60)).join('\n');
const chunks = split(long, 4000);
assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 4000));
assert.equal(chunks.join('\n'), long);

// имя канала из ссылок и @
for (const s of ['@kod_ru', 'kod_ru', 't.me/kod_ru', 'https://t.me/kod_ru', 'https://t.me/s/kod_ru/123', 'https://telegram.me/kod_ru?x=1'])
  assert.equal(channelName(s), 'kod_ru', s);

// команды без сети: настройки и список
const kv = new Map([['channels', '["kod_ru","rbc_news"]'], ['last', '{"kod_ru":5}']]);
const env = { DIGEST: { get: async (k) => (kv.has(k) ? { text: async () => kv.get(k) } : null), put: async (k, v) => kv.set(k, v) } };
assert.match(await command(env, '/schedule@Nick_ai_bot 20 9 14 99 9'), /9, 14, 20/);
assert.deepEqual(JSON.parse(kv.get('settings')).hours, [9, 14, 20]);
assert.match(await command(env, '/schedule'), /Сейчас: 9, 14, 20/);
await command(env, '/focus меньше политики');
await command(env, '/pause');
const st = JSON.parse(kv.get('settings'));
assert.equal(st.focus, 'меньше политики'); assert.equal(st.paused, true); assert.deepEqual(st.hours, [9, 14, 20]);
assert.match(await command(env, '/status'), /на паузе[\s\S]*Фокус: меньше политики/);
await command(env, '/focus -');
assert.equal(JSON.parse(kv.get('settings')).focus, '');
assert.match(await command(env, '/list'), /@kod_ru<\/a> — прочитано до[\s\S]*@rbc_news<\/a> — ещё не читался/);
assert.match(await command(env, '/del https://t.me/RBC_news'), /Убраны: @rbc_news/);
assert.deepEqual(JSON.parse(kv.get('channels')), ['kod_ru']);
assert.match(await command(env, '/нет'), /help/);

// RSS: BBC World
const rss = parseRss(readFileSync(new URL('./bbc_world.xml', import.meta.url), 'utf8'));
assert.ok(rss.length >= 20, `rss ${rss.length}`);
assert.ok(rss.every((p) => p.url.startsWith('https://') && p.channel === 'bbc.co.uk' && !Number.isNaN(Date.parse(p.date))));
assert.ok(rss.every((p) => p.text.length > 20 && !/<!\[CDATA|<\/?\w/.test(p.text)), 'текст без CDATA и тегов');
assert.equal(parseRss('<rss><item><title>x</title><pubDate>не дата</pubDate><link>https://a.b/c</link></item></rss>').length, 0);

// Atom: The Verge
const atom = parseRss(readFileSync(new URL('./verge_atom.xml', import.meta.url), 'utf8'));
assert.equal(atom.length, 10);
assert.ok(atom.every((p) => p.url.startsWith('https://www.theverge.com/') && p.channel === 'theverge.com' && !Number.isNaN(Date.parse(p.date))));
assert.ok(atom.every((p) => p.text.length > 30 && !/<!\[CDATA|<\/?\w/.test(p.text)), 'текст без CDATA и тегов');
assert.equal(atom[0].text.split('. ')[0], '3D movies are finally worth watching');
assert.equal(atom[0].date, '2026-10-03T12:00:00.000Z', 'published, а не updated');
assert.equal(parseRss('<feed><entry><title>t</title><link href="https://x.y/1"/><updated>2026-10-01T00:00:00Z</updated><content type="html">&lt;p&gt;тело&lt;/p&gt;</content></entry></feed>')[0].date,
  '2026-10-01T00:00:00.000Z', 'без published — updated');
assert.equal(parseRss('<feed><entry><title>t</title><link href="https://x.y/1"/><updated>2026-10-01T00:00:00Z</updated><content type="html">&lt;p&gt;тело&lt;/p&gt;</content></entry></feed>')[0].text,
  't. тело', 'экранированный HTML вычищен');

// фон в /list и /del по URL
kv.set('background', JSON.stringify(['tass_agency', 'https://feeds.bbci.co.uk/news/world/rss.xml']));
kv.set('tech', JSON.stringify(['habr_com']));
assert.match(await command(env, '/list'), /Мир: 2[\s\S]*@tass_agency[\s\S]*feeds\.bbci[\s\S]*Тех: 1/);
assert.match(await command(env, '/del https://feeds.bbci.co.uk/news/world/rss.xml @TASS_agency'), /Убраны: @tass_agency, https/);
assert.deepEqual(JSON.parse(kv.get('background')), []);

// сбор в пул и выпуск: fetch подменён — t.me отдаёт страницу durov, RSS — BBC, Gemini и Telegram — заглушки
const xml = readFileSync(new URL('./bbc_world.xml', import.meta.url), 'utf8');
const sent = [];
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  if (u.startsWith('https://t.me/s/')) return new Response(u.includes('before=') ? '' : html);
  if (u.includes('bbci')) return new Response(xml);
  if (u.includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text: '<b>Дайджест</b>' }] } }] });
  if (u.includes('api.telegram.org')) { sent.push(JSON.parse(opt.body)); return Response.json({ ok: true }); }
  throw new Error(`неожиданный fetch ${u}`);
};
const rssNewest = Math.max(...rss.map((p) => Date.parse(p.date)));
const kv2 = new Map([['channels', '["durov"]'], ['background', '["https://feeds.bbci.co.uk/news/world/rss.xml"]'],
  ['last', JSON.stringify({ durov: mid })]]);
const env2 = { DIGEST: { get: async (k) => (kv2.has(k) ? { text: async () => kv2.get(k) } : null), put: async (k, v) => kv2.set(k, v) },
  GEMINI_MODEL: 'm', GEMINI_API_KEY: 'k', BOT_TOKEN: 't', TARGET_CHAT: '-1' };
// «сейчас» — сразу после последнего поста durov: его посты в окне пула, свежий RSS — тем более
const now0 = Date.parse(posts.at(-1).date) + 1000;
const c1 = await collectAll(env2, 40, now0);
const mineN = c1.pool.filter((p) => p.tier === 'mine').length;
assert.ok(mineN >= 1 && mineN <= ids.filter((id) => id > mid).length, `своих ${mineN}`);
assert.ok(c1.pool.some((p) => p.tier === 'world' && p.url.includes('bbc')), 'RSS в пуле');
assert.ok(JSON.parse(kv2.get('last')).durov === ids.at(-1) && JSON.parse(kv2.get('last'))['https://feeds.bbci.co.uk/news/world/rss.xml'] === rssNewest);
const c2 = await collectAll(env2, 40, now0 + 1000);  // повторный сбор — ничего нового
assert.equal(c2.added, 0); assert.equal(c2.pool.length, c1.pool.length);
const c3 = await collectAll(env2, 1, now0 + 2000);   // бюджет 1 — второй источник ждёт
assert.ok(c3.errors.some((e) => e.includes('ждёт следующего часа')));

const dry = await publish(env2, { dry: true });
assert.equal(dry.digest, '<b>Дайджест</b>'); assert.equal(sent.length, 0);
assert.ok(JSON.parse(kv2.get('pool')).every((p) => !p.pub), 'dry ничего не помечает');
const pub = await publish(env2);
assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, '-1');
assert.ok(JSON.parse(kv2.get('pool')).every((p) => p.pub), 'после выпуска всё помечено');
assert.equal((await publish(env2, { dry: true })).digest, '', 'второй выпуск пуст');
assert.match(await command(env2, '/status'), /ждут выпуска: свои 0, мир 0, тех 0/);

// тревоги: модель отвечает по очереди заготовленными вердиктами
assert.equal(sourceKey('https://t.me/TASS_agency/5'), 'tass_agency');
assert.equal(sourceKey('https://www.bbc.co.uk/news/x'), 'bbc.co.uk');
const t0 = Date.parse('2026-10-03T12:00:00Z');
const item = (src, url, min) => ({ src, tier: 'world', url, date: new Date(t0 - min * 60e3).toISOString(), views: '', text: 'Срочно: событие', pub: false });
const apool = [item('tass_agency', 'https://t.me/tass_agency/1', 10), item('https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.bbc.co.uk/news/a', 20),
  item('kommersant', 'https://t.me/kommersant/7', 300)];  // 5 ч назад — вне окна
const verdicts = [];
let llmCalls = 0;
const sent2 = [];
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    llmCalls++;
    assert.ok(!opt.body.includes('kommersant/7'), 'старое вне окна не отправляется');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts.shift()) }] } }] });
  }
  if (u.includes('api.telegram.org')) { sent2.push(JSON.parse(opt.body)); return Response.json({ ok: true }); }
  throw new Error(`неожиданный fetch ${u}`);
};
const kv3 = new Map();
const env3 = { DIGEST: { get: async (k) => (kv3.has(k) ? { text: async () => kv3.get(k) } : null), put: async (k, v) => kv3.set(k, v) }, GEMINI_API_KEY: 'k', BOT_TOKEN: 't', TARGET_CHAT: '-1' };
verdicts.push({ alert: true, title: 'Т', text: 'x', urls: ['https://t.me/tass_agency/1', 'https://t.me/tass_agency/1'] });  // один источник
assert.equal(await checkAlerts(env3, apool, t0), null);
verdicts.push({ alert: true, title: 'Т', text: 'x', urls: ['https://t.me/tass_agency/1', 'https://evil.example/x'] });  // чужая ссылка
assert.equal(await checkAlerts(env3, apool, t0), null);
verdicts.push({ alert: false });
assert.equal(await checkAlerts(env3, apool, t0), null);
assert.equal(sent2.length, 0);
verdicts.push({ alert: true, title: 'Война', text: 'Началось <x>', urls: ['https://t.me/tass_agency/1', 'https://www.bbc.co.uk/news/a'] });
const al = await checkAlerts(env3, apool, t0);
assert.equal(al.title, 'Война'); assert.equal(sent2.length, 1);
assert.match(sent2[0].text, /^🚨 <b>Война<\/b>[\s\S]*Началось &lt;x&gt;[\s\S]*tass_agency[\s\S]*bbc\.co\.uk/);
const callsBefore = llmCalls;
assert.equal(await checkAlerts(env3, apool, t0 + 60e3), null, 'те же материалы — без повторной проверки');
assert.equal(llmCalls, callsBefore);
assert.equal(JSON.parse(kv3.get('alerts')).length, 1);
assert.match(await command(env3, '/alerts off'), /выключены[\s\S]*Война/);
assert.equal(JSON.parse(kv3.get('settings')).alerts, false);

console.log(`ok: ${posts.length} постов, last=${mid} → ${fresh.length} новых, ${chunks.length} кусков`);
