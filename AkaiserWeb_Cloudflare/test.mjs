// Runs the whole API against an in-memory fake of Netlify Blobs. No network needed:  node test.mjs
import { createHandler } from './src/core.mjs';

const mem = new Map();
const fake = {
  async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
  async setJSON(k, v, o) { if (o && o.onlyIfNew && mem.has(k)) return { modified: false }; mem.set(k, JSON.stringify(v)); return { modified: true }; },
  async delete(k) { mem.delete(k); },
};
const handle = createHandler(() => fake, { maxDevices: 2 });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
async function call(method, path, { body, cookie, device, ip = '1.1.1.1', ct = true } = {}) {
  const h = {};
  if (body !== undefined && ct) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (device) h.authorization = 'Device ' + device;
  const res = await handle(new Request('https://site.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), { ip });
  const sc = res.headers.get('set-cookie');
  return { status: res.status, json: await res.json(), cookie: sc ? sc.split(';')[0] : null };
}
const DEV1 = 'a'.repeat(64), DEV2 = 'b'.repeat(64), DEV3 = 'c'.repeat(64);

// --- the app asks for a code (the thing that failed before)
let r = await call('GET', '/api/ping');
ok(r.status === 200 && r.json.ok === true, 'ping answers');
r = await call('POST', '/api/device/status', { body: { name: 'Pixel 7' }, device: DEV1 });
ok(r.status === 200 && r.json.linked === false && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.json.code), 'app gets a code');
const code1 = r.json.code;
r = await call('POST', '/api/device/status', { body: { name: 'Pixel 7' }, device: DEV1 });
ok(r.json.code === code1, 'same code on next poll');
r = await call('POST', '/api/device/status', { body: {} });
ok(r.status === 401, 'no device header -> 401');
r = await call('POST', '/api/device/status', { body: {}, device: 'short' });
ok(r.status === 401, 'short secret -> 401');
r = await call('POST', '/api/device/status', { body: {}, device: DEV1, ct: false });
ok(r.status === 415, 'non-JSON rejected');

// --- sign up / login
r = await call('POST', '/api/signup', { body: { username: 'ab', password: 'password1' } });
ok(r.status === 400, 'short username');
r = await call('POST', '/api/signup', { body: { username: 'Alice', password: 'short' } });
ok(r.status === 400, 'short password');
r = await call('POST', '/api/signup', { body: { username: 'Alice', password: 'password1' } });
ok(r.status === 201 && r.cookie, 'sign up');
const alice = r.cookie;
r = await call('POST', '/api/signup', { body: { username: 'alice', password: 'password1' } });
ok(r.status === 409, 'duplicate name (case-insensitive)');
r = await call('GET', '/api/me', { cookie: alice });
ok(r.json.loggedIn && r.json.username === 'Alice' && r.json.devices.length === 0, '/api/me logged in');
r = await call('GET', '/api/me');
ok(r.json.loggedIn === false, '/api/me logged out');
r = await call('POST', '/api/login', { body: { username: 'ALICE', password: 'wrongpass' } });
ok(r.status === 401, 'wrong password');
r = await call('POST', '/api/login', { body: { username: 'alice', password: 'password1' } });
ok(r.status === 200 && r.cookie, 'login');

// --- link
r = await call('POST', '/api/link', { body: { code: code1 } });
ok(r.status === 401, 'link needs login');
r = await call('POST', '/api/link', { body: { code: 'ZZZZ-ZZZZ' }, cookie: alice });
ok(r.status === 404, 'unknown code');
r = await call('POST', '/api/link', { body: { code: 'abc' }, cookie: alice });
ok(r.status === 400, 'malformed code');
r = await call('POST', '/api/link', { body: { code: code1.toLowerCase().replace('-', ' ') }, cookie: alice });
ok(r.status === 200, 'link with lowercase/space code');
r = await call('POST', '/api/link', { body: { code: code1 }, cookie: alice });
ok(r.status === 404, 'code cannot be reused');
r = await call('POST', '/api/device/status', { body: { name: 'Pixel 7' }, device: DEV1 });
ok(r.json.linked === true && r.json.username === 'Alice', 'app sees linked');
r = await call('GET', '/api/me', { cookie: alice });
ok(r.json.devices.length === 1 && r.json.devices[0].name === 'Pixel 7', 'device listed');

// --- max devices (2 in this test)
r = await call('POST', '/api/device/status', { body: { name: 'Tab' }, device: DEV2 });
r = await call('POST', '/api/link', { body: { code: r.json.code }, cookie: alice });
ok(r.status === 200, 'second device links');
r = await call('POST', '/api/device/status', { body: { name: 'Third' }, device: DEV3 });
const code3 = r.json.code;
r = await call('POST', '/api/link', { body: { code: code3 }, cookie: alice });
ok(r.status === 409, 'device limit');

// --- backup
r = await call('GET', '/api/device/data', { device: DEV3 });
ok(r.status === 403, 'unlinked device has no backup access');
r = await call('GET', '/api/device/data', { device: DEV1 });
ok(r.status === 200 && r.json.data === null, 'no backup yet');
r = await call('PUT', '/api/device/data', { body: { data: { vol: 7, layout: 'x' } }, device: DEV1 });
ok(r.status === 200, 'save backup');
r = await call('GET', '/api/device/data', { device: DEV2 });
ok(r.json.data && r.json.data.vol === 7, 'other device of same account restores it');
r = await call('PUT', '/api/device/data', { body: { data: { big: 'x'.repeat(70000) } }, device: DEV1 });
ok(r.status === 413, 'backup too large');
r = await call('GET', '/api/me', { cookie: alice });
ok(r.json.backup && r.json.backup.bytes > 0, 'backup shown on site');

// --- unlink from both sides
const id1 = r.json.devices.find((d) => d.name === 'Pixel 7').id;
r = await call('POST', '/api/devices/unlink', { body: { id: id1 }, cookie: alice });
ok(r.status === 200, 'unlink from website');
r = await call('POST', '/api/device/status', { body: { name: 'Pixel 7' }, device: DEV1 });
ok(r.json.linked === false && r.json.code, 'app is unlocked-out and gets a new code');
r = await call('POST', '/api/device/unlink', { body: {}, device: DEV2 });
ok(r.status === 200, 'unlink from app');
r = await call('GET', '/api/me', { cookie: alice });
ok(r.json.devices.length === 0, 'both gone from website');
r = await call('POST', '/api/devices/unlink', { body: { id: 'nope' }, cookie: alice });
ok(r.status === 404, 'unknown device id');

// --- code expiry
r = await call('POST', '/api/device/status', { body: {}, device: DEV1 });
const stale = r.json.code.replace('-', '');
const ref = JSON.parse(mem.get('c:' + stale)); ref.exp = Date.now() - 1000; mem.set('c:' + stale, JSON.stringify(ref));
r = await call('POST', '/api/link', { body: { code: stale }, cookie: alice });
ok(r.status === 404, 'expired code refused');
const dk = [...mem.keys()].find((k) => k.startsWith('d:') && JSON.parse(mem.get(k)).code === stale);
const dd = JSON.parse(mem.get(dk)); dd.code_exp = Date.now() - 1000; mem.set(dk, JSON.stringify(dd));
r = await call('POST', '/api/device/status', { body: {}, device: DEV1 });
ok(r.json.code && r.json.code.replace('-', '') !== stale, 'expired code is replaced by a fresh one');

// --- A.19: the app makes its own code
r = await call('POST', '/api/device/status', { body: { name: 'New', code: 'ABCD-2345' }, device: 'd'.repeat(64) });
ok(r.json.code === 'ABCD-2345' && r.json.linked === false, 'site accepts the code made by the app');
r = await call('POST', '/api/device/status', { body: { name: 'New', code: 'ABCD2345' }, device: 'd'.repeat(64) });
ok(r.json.code === 'ABCD-2345', 'same app code on next poll');
r = await call('POST', '/api/device/status', { body: { name: 'Other', code: 'ABCD-2345' }, device: 'e'.repeat(64) });
ok(r.json.code && r.json.code !== 'ABCD-2345', 'clash with another phone: site answers with its own code');
r = await call('POST', '/api/device/status', { body: { name: 'Bad', code: 'oops!' }, device: 'f'.repeat(64) });
ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.json.code), 'invalid app code ignored, site makes one');
r = await call('POST', '/api/link', { body: { code: 'abcd 2345' }, cookie: alice });
ok(r.status === 200, 'link with the code made by the app');
r = await call('POST', '/api/device/status', { body: { name: 'New', code: 'ABCD2345' }, device: 'd'.repeat(64) });
ok(r.json.linked === true, 'app linked via its own code');
r = await call('POST', '/api/device/unlink', { body: {}, device: 'd'.repeat(64) });
r = await call('POST', '/api/device/status', { body: { name: 'New', code: 'WXYZ6789' }, device: 'd'.repeat(64) });
ok(r.json.code === 'WXYZ-6789', 'after unlink the app can bring a new code');
{ const ref = JSON.parse(mem.get('c:WXYZ6789')); ref.exp = Date.now() - 1000; mem.set('c:WXYZ6789', JSON.stringify(ref));
  const dk2 = [...mem.keys()].find((k) => k.startsWith('d:') && JSON.parse(mem.get(k)).code === 'WXYZ6789');
  const d2 = JSON.parse(mem.get(dk2)); d2.code_exp = Date.now() - 1000; mem.set(dk2, JSON.stringify(d2)); }
r = await call('POST', '/api/device/status', { body: { name: 'Other', code: 'WXYZ6789' }, device: 'e'.repeat(64) });
ok(r.json.code === 'WXYZ-6789', 'an expired code can be taken over');

// --- change password logs out other sessions
const alice2 = (await call('POST', '/api/login', { body: { username: 'alice', password: 'password1' } })).cookie;
r = await call('POST', '/api/change-password', { body: { oldPassword: 'bad', newPassword: 'newpassword1' }, cookie: alice });
ok(r.status === 401, 'wrong current password');
r = await call('POST', '/api/change-password', { body: { oldPassword: 'password1', newPassword: 'newpassword1' }, cookie: alice });
ok(r.status === 200 && r.cookie, 'password changed');
const aliceNew = r.cookie;
ok((await call('GET', '/api/me', { cookie: alice2 })).json.loggedIn === false, 'other session logged out');
ok((await call('GET', '/api/me', { cookie: aliceNew })).json.loggedIn === true, 'current session kept');
ok((await call('POST', '/api/login', { body: { username: 'alice', password: 'newpassword1' } })).status === 200, 'login with new password');

// --- A.20: play time reported by the app
const DEVP = 'p'.repeat(64);
r = await call('POST', '/api/device/playtime', { body: { sessions: [] }, device: DEVP });
ok(r.status === 403, 'playtime refused for a device that is not linked');
r = await call('POST', '/api/device/status', { body: { name: 'Pixel P' }, device: DEVP });
const codeP = r.json.code;
for (const dk2 of (await call('GET', '/api/me', { cookie: aliceNew })).json.devices) await call('POST', '/api/devices/unlink', { body: { id: dk2.id }, cookie: aliceNew });   // free the slots
r = await call('POST', '/api/link', { body: { code: codeP }, cookie: aliceNew });
ok(r.status === 200, 'playtime test device linked');
const t0 = Date.now() - 3600_000;
r = await call('POST', '/api/device/playtime', { body: { sessions: [
  { id: 'aaaaaaaa11111111', game: 'akaievo8', startedAt: t0, seconds: 600 },
  { id: 'bbbbbbbb22222222', game: 'akaievo8', startedAt: t0 - 7200_000, seconds: 1800 },
  { id: 'bad id!', game: 'x', startedAt: t0, seconds: 50 },
  { id: 'cccccccc33333333', game: 'x', startedAt: t0, seconds: 0 },
  { id: 'dddddddd44444444', game: 'x', startedAt: 5, seconds: 50 },
  { id: 'eeeeeeee55555555', game: 'x', startedAt: Date.now() + 10 * 86400_000, seconds: 50 },
] }, device: DEVP });
ok(r.status === 200 && r.json.accepted === 2 && r.json.rejected === 4 && r.json.totalSeconds === 2400, 'playtime: 2 accepted, 4 bad ones rejected');
r = await call('POST', '/api/device/playtime', { body: { sessions: [{ id: 'aaaaaaaa11111111', game: 'akaievo8', startedAt: t0, seconds: 600 }] }, device: DEVP });
ok(r.json.accepted === 0 && r.json.duplicate === 1 && r.json.totalSeconds === 2400, 'playtime: a resend is not counted twice');
r = await call('POST', '/api/device/playtime', { body: { sessions: [{ id: 'ffffffff66666666', game: 'akaievo8', startedAt: t0, seconds: 999999 }] }, device: DEVP });
ok(r.json.accepted === 1 && r.json.totalSeconds === 2400 + 86400, 'playtime: one session counts at most 24 h');
r = await call('POST', '/api/device/playtime', { body: { sessions: 'nope' }, device: DEVP });
ok(r.status === 200 && r.json.accepted === 0, 'playtime: junk list is ignored');
r = await call('GET', '/api/me', { cookie: aliceNew });
ok(r.json.playtime.totalSeconds === 2400 + 86400 && r.json.playtime.sessionCount === 3 && r.json.playtime.recent[0].device === 'Pixel P', 'website shows the play time');
ok(r.json.playtime.daily.length === 14 && r.json.playtime.daily.reduce((a, d) => a + d.seconds, 0) > 0, 'website gets a 14-day chart');
for (let i = 0; i < 4; i++) await call('POST', '/api/device/playtime', { body: { sessions: Array.from({ length: 50 }, (_, k) => ({ id: 'bulk' + String(i * 50 + k).padStart(6, '0'), game: 'g', startedAt: t0 - (i * 50 + k) * 60_000, seconds: 10 })) }, device: DEVP });
r = await call('GET', '/api/me', { cookie: aliceNew });
ok(r.json.playtime.sessionCount === 203 && r.json.playtime.totalSeconds === 2400 + 86400 + 2000, 'playtime: total and count keep growing past the detail limit');
r = await call('POST', '/api/device/unlink', { body: {}, device: DEVP });
r = await call('POST', '/api/device/playtime', { body: { sessions: [] }, device: DEVP });
ok(r.status === 403, 'playtime refused after unlinking');
await call('POST', '/api/device/status', { body: { name: 'Pixel P' }, device: DEVP });
const codeP2 = (await call('POST', '/api/device/status', { body: {}, device: DEVP })).json.code;
await call('POST', '/api/link', { body: { code: codeP2 }, cookie: aliceNew });
ok((await call('GET', '/api/me', { cookie: aliceNew })).json.playtime.totalSeconds === 2400 + 86400 + 2000, 'play time stays with the account after relinking');

// --- A.22 card collection + daily gacha
import { CARDS } from './src/cards.mjs';
const DEVC = 'd'.repeat(64);
r = await call('GET', '/api/cards');
ok(r.status === 200 && r.json.cards.length === CARDS.length && CARDS.length === 160, 'card list is public and has 160 cards');
ok(new Set(CARDS.map((c) => c.id)).size === CARDS.length, 'card ids are unique');
ok((await call('GET', '/api/collection')).status === 401, 'collection needs login');
ok((await call('POST', '/api/gacha', { body: {} })).status === 401, 'gacha needs login');
ok((await call('POST', '/api/device/collection', { body: { cards: {} }, device: DEVC })).status === 403, 'unlinked device cannot sync cards');
r = await call('POST', '/api/signup', { body: { username: 'Carol', password: 'password1' }, ip: '5.5.5.5' });
const carol = r.cookie;
await call('POST', '/api/device/status', { body: { name: 'Pixel C' }, device: DEVC });
const codeC = (await call('POST', '/api/device/status', { body: {}, device: DEVC })).json.code;
ok((await call('POST', '/api/link', { body: { code: codeC }, cookie: carol })).status === 200, 'carol links her phone');
r = await call('GET', '/api/collection', { cookie: carol });
ok(r.status === 200 && Object.keys(r.json.owned).length === 0 && r.json.gacha.canDraw === true, 'new account: empty collection, gacha ready');

const [k0, k1, k2] = CARDS;
const T0 = Date.now() - 5 * 86400_000;
r = await call('POST', '/api/device/collection', { body: { cards: { [k0.id]: [T0, 7], [k1.id]: [T0, 1], 'not-a-card': [T0, 1], [k2.id]: [12, 3] } }, device: DEVC });
ok(r.status === 200 && r.json.added === 3 && r.json.ignored === 1, 'app sync: 3 cards added, unknown barcode ignored');
ok(Object.keys(r.json.cards).length === 3 && !('not-a-card' in r.json.cards), 'sync answer holds the collection');
ok(r.json.cards[k0.id] === T0 && r.json.cards[k2.id] > 1577836800000, 'bad date replaced by now, good date kept');
r = await call('POST', '/api/device/collection', { body: { cards: { [k0.id]: [T0, 99] } }, device: DEVC });
ok(r.json.added === 0 && Object.keys(r.json.cards).length === 3, 'resend does not add anything (no counters)');
r = await call('POST', '/api/device/collection', { body: { cards: { [k0.id]: [T0 - 1000, 1] } }, device: DEVC });
ok(r.json.cards[k0.id] === T0 - 1000, 'earliest date is kept');
r = await call('POST', '/api/device/collection', { body: { cards: [1, 2] }, device: DEVC });
ok(r.status === 200 && r.json.added === 0, 'garbage body is harmless');
r = await call('GET', '/api/collection', { cookie: carol });
ok(Object.keys(r.json.owned).length === 3 && Object.values(r.json.owned).every((v) => typeof v === 'number'), 'website sees the cards the app synced (dates only, no counts)');

// daily gacha
r = await call('POST', '/api/gacha', { body: {}, cookie: carol });
ok(r.status === 200 && r.json.card && !([k0.id, k1.id, k2.id].includes(r.json.card.id)), 'gacha gives a card that is not owned yet');
const g1 = r.json.card;
ok(Object.keys(r.json.owned).length === 4 && r.json.gacha.drawnToday && !r.json.gacha.canDraw && r.json.gacha.nextAt > Date.now(), 'gacha: collection +1, locked until tomorrow');
r = await call('POST', '/api/gacha', { body: {}, cookie: carol });
ok(r.status === 409, 'second draw on the same day refused');
r = await call('GET', '/api/collection', { cookie: carol });
ok(r.json.gacha.todayCard === g1.id && r.json.gacha.drawnToday, 'today\'s card is remembered');
r = await call('POST', '/api/device/collection', { body: { cards: {} }, device: DEVC });
ok(r.json.cards[g1.id] > 0, 'gacha card reaches the app on its next sync');

// next day (move the stored day back) -> one more card, never a duplicate, until the collection is complete
const kRaw = () => JSON.parse(mem.get('k:carol'));
async function nextDay() { const k = kRaw(); const day = k.gacha.day; k.gacha.day = day - 1; mem.set('k:carol', JSON.stringify(k)); mem.delete('g:carol:' + day); }
await nextDay();
r = await call('POST', '/api/gacha', { body: {}, cookie: carol });
ok(r.status === 200 && r.json.card.id !== g1.id && Object.keys(r.json.owned).length === 5, 'next day: another new card');
let drawn = 5, dup = false, lastRes = r;
while (drawn < CARDS.length) {
  await nextDay();
  lastRes = await call('POST', '/api/gacha', { body: {}, cookie: carol });
  if (lastRes.status !== 200) break;
  const n = Object.keys(lastRes.json.owned).length;
  if (n !== drawn + 1) dup = true;
  drawn = n;
}
ok(!dup && drawn === CARDS.length, 'drawing every day fills the collection with no duplicate (160/160)');
await nextDay();
r = await call('POST', '/api/gacha', { body: {}, cookie: carol });
ok(r.status === 409 && /every card/.test(r.json.error), 'complete collection: nothing left to draw');
r = await call('GET', '/api/collection', { cookie: carol });
ok(r.json.gacha.complete === true && r.json.gacha.canDraw === false, 'status says complete');

// two draws at the very same moment -> only one counts
await call('POST', '/api/signup', { body: { username: 'Dave', password: 'password1' }, ip: '5.5.5.6' });
const dave = (await call('POST', '/api/login', { body: { username: 'Dave', password: 'password1' }, ip: '5.5.5.6' })).cookie;
const both = await Promise.all([call('POST', '/api/gacha', { body: {}, cookie: dave }), call('POST', '/api/gacha', { body: {}, cookie: dave })]);
ok(both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 409).length === 1, 'simultaneous draws: exactly one succeeds');
ok(Object.keys((await call('GET', '/api/collection', { cookie: dave })).json.owned).length === 1, 'and only one card was added');

// reset time zone
const handleJkt = createHandler(() => fake, { maxDevices: 2, gachaOffsetMin: 420 });
const resJkt = await handleJkt(new Request('https://site.test/api/gacha', { method: 'POST', headers: { 'content-type': 'application/json', cookie: (await call('POST', '/api/signup', { body: { username: 'Erin', password: 'password1' }, ip: '5.5.5.7' })).cookie }, body: '{}' }), { ip: '5.5.5.7' });
const jkt = await resJkt.json(), nowT = Date.now();
ok(resJkt.status === 200 && jkt.gacha.nextAt > nowT && jkt.gacha.nextAt <= nowT + 86400_000 && (jkt.gacha.nextAt + 420 * 60_000) % 86400_000 === 0, 'gacha reset follows the configured UTC offset (midnight at +7:00)');

// deleting an account removes its cards
r = await call('POST', '/api/delete-account', { body: { password: 'password1' }, cookie: carol });
ok(r.status === 200 && ![...mem.keys()].some((k) => k.startsWith('k:carol') || k.startsWith('g:carol')), 'cards deleted with the account');

// --- rate limits
let last;
for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { body: { username: 'bob', password: 'x' }, ip: '9.9.9.' + i });
ok(last.status === 429, 'login per-user rate limit');
for (let i = 0; i < 11; i++) last = await call('POST', '/api/device/status', { body: {}, device: String(i).repeat(40), ip: '7.7.7.7' });
ok(last.status === 429, 'too many new devices per IP');

// --- delete account
r = await call('POST', '/api/delete-account', { body: { password: 'wrong' }, cookie: aliceNew });
ok(r.status === 401, 'delete needs password');
await call('POST', '/api/device/status', { body: {}, device: DEV2 });
const c2 = (await call('POST', '/api/device/status', { body: {}, device: DEV2 })).json.code;
await call('POST', '/api/link', { body: { code: c2 }, cookie: aliceNew });
r = await call('POST', '/api/delete-account', { body: { password: 'newpassword1' }, cookie: aliceNew });
ok(r.status === 200, 'account deleted');
ok(![...mem.keys()].some((k) => k.startsWith('p:alice')), 'play time deleted with the account');
ok((await call('GET', '/api/me', { cookie: aliceNew })).json.loggedIn === false, 'session dead after delete');
r = await call('POST', '/api/device/status', { body: {}, device: DEV2 });
ok(r.json.linked === false && r.json.code, 'device of deleted account is unlinked');
ok((await call('GET', '/api/nothing')).status === 404, 'unknown API route');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
