// AkaiserEvodroid account API (same behaviour as the original server.js) for Netlify Functions + Netlify Blobs.
// `getStore()` must return an object with: get(key,{type:'json'}), setJSON(key,value,opts), delete(key).
import crypto from 'node:crypto';
import { CARDS } from './cards.mjs';

const SESSION_DAYS = 30;
const CODE_TTL_MS = 15 * 60 * 1000;
const DATA_LIMIT = 64 * 1024;
const PLAY_KEEP = 200;              // newest play sessions kept in detail (the total keeps counting forever)
const PLAY_MAX_SESSION_S = 24 * 3600;
const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));
const MIN_TIME = 1577836800000;      // 2020-01-01: any card date older than this is not real
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const rid = () => crypto.randomBytes(8).toString('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
let dummyHash = null;
function verifyPassword(pw, stored) {
  try {
    const [v, saltHex, keyHex] = stored.split('$');
    if (v !== 's1') return false;
    const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch { return false; }
}
function cleanCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(c) ? c : null;
}
const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function createHandler(getStore, opts = {}) {
  const MAX_DEVICES = opts.maxDevices || 5;
  // The daily gacha resets at midnight in this UTC offset (minutes). Default 0 = UTC. Example: 420 for Jakarta (UTC+7).
  const GACHA_OFFSET_MIN = Number.isFinite(opts.gachaOffsetMin) ? opts.gachaOffsetMin : 0;
  const gachaDay = (t) => Math.floor((t + GACHA_OFFSET_MIN * 60_000) / 86400_000);
  const gachaNextAt = (t) => (gachaDay(t) + 1) * 86400_000 - GACHA_OFFSET_MIN * 60_000;
  let _store = null;
  const S = () => (_store ||= getStore());
  const get = (k) => S().get(k, { type: 'json' });
  const put = (k, v, o) => S().setJSON(k, v, o);
  const del = (k) => S().delete(k);
  // true when the write really happened (old library versions return nothing: treat as written)
  const created = (r) => !(r && r.modified === false);

  // ---- rate limiter (counters live in Blobs, so they work across function instances)
  async function allow(key, max, windowMs) {
    const k = 'r:' + sha256(key).slice(0, 32);
    const t = now();
    let b = await get(k);
    if (!b || b.reset < t) b = { n: 0, reset: t + windowMs };
    b.n++;
    await put(k, b);
    return b.n <= max;
  }

  const clientIp = (req, ctx) => (ctx && ctx.ip) || req.headers.get('cf-connecting-ip') || req.headers.get('x-nf-client-connection-ip') || String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

  function json(status, obj, extra) {
    const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const [k, v] of Object.entries(extra || {})) h.append(k, v);
    return new Response(JSON.stringify(obj), { status, headers: h });
  }

  async function readJson(req, limit = 100 * 1024) {
    const ct = String(req.headers.get('content-type') || '');
    if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
    const text = await req.text();
    if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Request too large.');
    if (!text) return {};
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; }
    catch { throw new HttpError(400, 'Bad JSON.'); }
  }

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
    }
    return out;
  }

  // ---- sessions
  async function sessionUser(req) {
    const tok = parseCookies(req).ak_session;
    if (!tok || tok.length < 20) return null;
    const s = await get('s:' + sha256(tok));
    if (!s) return null;
    if (s.expires < now()) { await del('s:' + sha256(tok)); return null; }
    const u = await get('u:' + s.lc);
    if (!u || (u.pwv || 0) !== (s.pwv || 0)) return null;
    return { lc: s.lc, user: u };
  }
  async function requireUser(req) {
    const u = await sessionUser(req);
    if (!u) throw new HttpError(401, 'Please log in.');
    return u;
  }
  async function startSession(req, u) {
    const tok = crypto.randomBytes(32).toString('base64url');
    await put('s:' + sha256(tok), { lc: u.username.toLowerCase(), pwv: u.pwv || 0, expires: now() + SESSION_DAYS * 86400_000 });
    const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    return `ak_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` + (secure ? '; Secure' : '');
  }
  const clearCookie = 'ak_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

  // ---- devices
  function deviceFromAuth(req) {
    const h = String(req.headers.get('authorization') || '');
    if (!h.startsWith('Device ')) throw new HttpError(401, 'Missing device credentials.');
    const secret = h.slice(7).trim();
    if (secret.length < 32 || secret.length > 200) throw new HttpError(401, 'Bad device credentials.');
    return secret;
  }
  // devices of a user, as the device records say (the list in the user record is only a hint)
  async function devicesOf(lc, u) {
    const out = [];
    for (const h of u.devs || []) {
      const d = await get('d:' + h);
      if (d && d.user === lc) out.push({ h, d });
    }
    return out;
  }
  async function newCode(secretHash) {
    for (let i = 0; i < 20; i++) {
      let c = '';
      const b = crypto.randomBytes(8);
      for (let k = 0; k < 8; k++) c += CODE_ALPHABET[b[k] % CODE_ALPHABET.length];
      const r = await put('c:' + c, { h: secretHash, exp: now() + CODE_TTL_MS }, { onlyIfNew: true });
      if (created(r)) return c;
    }
    throw new Error('could not make a code');
  }

  // The app may choose its own link code. Returns the expiry time when the code is now ours, 0 when another phone holds it.
  async function claimCode(secretHash, want) {
    const ref = await get('c:' + want);
    const exp = now() + CODE_TTL_MS;
    if (!ref) return created(await put('c:' + want, { h: secretHash, exp }, { onlyIfNew: true })) ? exp : 0;
    if (ref.h === secretHash || ref.exp < now()) { await put('c:' + want, { h: secretHash, exp }); return exp; }
    return 0;
  }

  // seconds played per UTC day for the last 14 days (from the kept sessions), oldest first
  function playDaily(p) {
    const days = [];
    for (let i = 13; i >= 0; i--) days.push({ day: new Date(now() - i * 86400_000).toISOString().slice(0, 10), seconds: 0 });
    for (const x of (p && p.sessions) || []) {
      const d = days.find((q) => q.day === new Date(x.at).toISOString().slice(0, 10));
      if (d) d.seconds += x.sec;
    }
    return days;
  }

  // ---- card collection (A.22). One record per account: { cards: { <barcode>: firstOwnedMillis }, gacha: { day, id } | null }.
  // A card is owned once; there is no counter. Fed by the app (sync) and by the daily gacha.
  async function readColl(lc) {
    const k = await get('k:' + lc);
    return { cards: (k && k.cards) || {}, gacha: (k && k.gacha) || null };
  }
  const saveColl = (lc, k) => put('k:' + lc, k);
  function gachaState(k, t) {
    const day = gachaDay(t);
    const done = !!(k.gacha && k.gacha.day === day);
    const left = Object.keys(k.cards).length >= CARDS.length;
    return { canDraw: !done && !left, drawnToday: done, todayCard: done ? k.gacha.id : null, complete: left, nextAt: done ? gachaNextAt(t) : null };
  }

  const routes = {};
  const route = (method, p, fn) => { routes[`${method} ${p}`] = fn; };

  // connection test used by the app's "Test connection" button
  route('GET', '/api/ping', async () => json(200, { ok: true, service: 'akaiser-account' }));

  // ------------------------------------------------------------ website API
  route('POST', '/api/signup', async (req, ctx) => {
    if (!(await allow('signup:' + clientIp(req, ctx), 10, 3600_000))) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const { username, password } = await readJson(req);
    if (!validUsername(username)) throw new HttpError(400, 'Username: 3-20 letters, numbers or underscore.');
    if (!validPassword(password)) throw new HttpError(400, 'Password must be at least 8 characters.');
    const lc = username.toLowerCase();
    const u = { id: rid(), username, pass_hash: hashPassword(password), created_at: now(), pwv: 0, devs: [] };
    if (await get('u:' + lc)) throw new HttpError(409, 'That username is taken.');
    if (!created(await put('u:' + lc, u, { onlyIfNew: true }))) throw new HttpError(409, 'That username is taken.');
    return json(201, { ok: true, username }, { 'Set-Cookie': await startSession(req, u) });
  });

  route('POST', '/api/login', async (req, ctx) => {
    const { username, password } = await readJson(req);
    const lc = String(username || '').toLowerCase().slice(0, 40);
    if (!(await allow('login-ip:' + clientIp(req, ctx), 20, 10 * 60_000)) || !(await allow('login-user:' + lc, 8, 10 * 60_000)))
      throw new HttpError(429, 'Too many attempts. Wait 10 minutes and try again.');
    const u = validUsername(lc) ? await get('u:' + lc) : null;
    if (!dummyHash) dummyHash = hashPassword('dummy-password-for-timing');
    const ok = verifyPassword(String(password || ''), u ? u.pass_hash : dummyHash);
    if (!u || !ok) throw new HttpError(401, 'Wrong username or password.');
    return json(200, { ok: true, username: u.username }, { 'Set-Cookie': await startSession(req, u) });
  });

  route('POST', '/api/logout', async (req) => {
    const tok = parseCookies(req).ak_session;
    if (tok) await del('s:' + sha256(tok));
    return json(200, { ok: true }, { 'Set-Cookie': clearCookie });
  });

  route('GET', '/api/me', async (req) => {
    const s = await sessionUser(req);
    if (!s) return json(200, { loggedIn: false });
    const devices = (await devicesOf(s.lc, s.user)).map(({ d }) => ({ id: d.id, name: d.name || 'Android device', linkedAt: d.linked_at, lastSeen: d.last_seen }))
      .sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0));
    const b = await get('b:' + s.lc);
    const p = await get('p:' + s.lc);
    const playtime = { totalSeconds: p ? p.total : 0, sessionCount: p ? p.count : 0, lastPlayed: p ? p.last : null,
      recent: p ? p.sessions.slice(0, 30).map((x) => ({ at: x.at, seconds: x.sec, game: x.game, device: x.dev })) : [],
      daily: playDaily(p) };
    return json(200, { loggedIn: true, username: s.user.username, devices, maxDevices: MAX_DEVICES,
      backup: b && b.text ? { bytes: Buffer.byteLength(b.text), updatedAt: b.t } : null, playtime });
  });

  // ---- A.22 card collection + daily gacha (website)
  // The card list (no login needed; it is the same list that is built into the app).
  route('GET', '/api/cards', async () => json(200, { cards: CARDS }));

  route('GET', '/api/collection', async (req) => {
    const s = await requireUser(req);
    const k = await readColl(s.lc);
    return json(200, { owned: k.cards, total: CARDS.length, gacha: gachaState(k, now()) });
  });

  // One random card per day, picked on the server from the cards the player does not have yet.
  route('POST', '/api/gacha', async (req) => {
    const s = await requireUser(req);
    const t = now(), day = gachaDay(t);
    const k = await readColl(s.lc);
    if (k.gacha && k.gacha.day === day) throw new HttpError(409, 'You already opened today\'s card. Come back tomorrow!');
    if (CARDS.every((c) => k.cards[c.id])) throw new HttpError(409, 'You have every card. Nothing left to draw!');
    // the claim key makes "once per day" hold even when two requests arrive at the same moment
    if (!created(await put(`g:${s.lc}:${day}`, { t }, { onlyIfNew: true }))) throw new HttpError(409, 'You already opened today\'s card. Come back tomorrow!');
    const fresh = await readColl(s.lc);                       // re-read: the app may have synced while we were claiming
    const pool = CARDS.filter((c) => !fresh.cards[c.id]);
    if (!pool.length) throw new HttpError(409, 'You have every card. Nothing left to draw!');
    const got = pool[crypto.randomInt(pool.length)];
    fresh.cards[got.id] = t;
    fresh.gacha = { day, id: got.id };
    await saveColl(s.lc, fresh);
    await del(`g:${s.lc}:${day - 1}`);
    return json(200, { ok: true, card: got, owned: fresh.cards, total: CARDS.length, gacha: gachaState(fresh, t) });
  });

  route('POST', '/api/change-password', async (req) => {
    const s = await requireUser(req);
    const { oldPassword, newPassword } = await readJson(req);
    if (!(await allow('pw:' + s.lc, 8, 10 * 60_000))) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (!verifyPassword(String(oldPassword || ''), s.user.pass_hash)) throw new HttpError(401, 'Current password is wrong.');
    if (!validPassword(newPassword)) throw new HttpError(400, 'New password must be at least 8 characters.');
    const u = { ...s.user, pass_hash: hashPassword(newPassword), pwv: (s.user.pwv || 0) + 1 };   // new pwv logs out every other session
    await put('u:' + s.lc, u);
    await del('s:' + sha256(parseCookies(req).ak_session));
    return json(200, { ok: true }, { 'Set-Cookie': await startSession(req, u) });
  });

  // The player types the code the app shows. This is the step that connects the web account to the app.
  route('POST', '/api/link', async (req, ctx) => {
    const s = await requireUser(req);
    if (!(await allow('link:' + s.lc, 10, 10 * 60_000)) || !(await allow('link-ip:' + clientIp(req, ctx), 30, 10 * 60_000)))
      throw new HttpError(429, 'Too many wrong codes. Wait 10 minutes and try again.');
    const { code } = await readJson(req);
    const c = cleanCode(code);
    if (!c) throw new HttpError(400, 'The code has 8 letters/numbers, like K7M2-9QXA.');
    const ref = await get('c:' + c);
    const d = ref && ref.exp >= now() ? await get('d:' + ref.h) : null;
    if (!d || d.user || d.code !== c) throw new HttpError(404, 'Code not found or expired. Open the app to get a new code.');
    const mine = await devicesOf(s.lc, s.user);
    if (mine.length >= MAX_DEVICES) throw new HttpError(409, `This account already has ${MAX_DEVICES} linked devices. Unlink one first.`);
    await put('d:' + ref.h, { ...d, user: s.lc, linked_at: now(), code: null, code_exp: null });
    await del('c:' + c);
    await put('u:' + s.lc, { ...s.user, devs: [...new Set([...mine.map((m) => m.h), ref.h])] });
    return json(200, { ok: true });
  });

  route('POST', '/api/devices/unlink', async (req) => {
    const s = await requireUser(req);
    const { id } = await readJson(req);
    const hit = (await devicesOf(s.lc, s.user)).find((m) => m.d.id === String(id));
    if (!hit) throw new HttpError(404, 'Device not found.');
    await put('d:' + hit.h, { ...hit.d, user: null, linked_at: null });
    await put('u:' + s.lc, { ...s.user, devs: (s.user.devs || []).filter((h) => h !== hit.h) });
    return json(200, { ok: true });
  });

  route('POST', '/api/delete-account', async (req) => {
    const s = await requireUser(req);
    const { password } = await readJson(req);
    if (!(await allow('del:' + s.lc, 5, 10 * 60_000)) || !verifyPassword(String(password || ''), s.user.pass_hash)) throw new HttpError(401, 'Password is wrong.');
    for (const { h, d } of await devicesOf(s.lc, s.user)) await put('d:' + h, { ...d, user: null, linked_at: null });
    await del('b:' + s.lc);
    await del('p:' + s.lc);
    await del('k:' + s.lc);
    await del(`g:${s.lc}:${gachaDay(now())}`);
    await del('u:' + s.lc);          // sessions die with the user record (sessionUser checks it)
    return json(200, { ok: true }, { 'Set-Cookie': clearCookie });
  });

  // ------------------------------------------------------------ app API
  async function linkedDevice(req) {
    const h = sha256(deviceFromAuth(req));
    const d = await get('d:' + h);
    if (!d || !d.user) throw new HttpError(403, 'This device is not linked to an account.');
    return d;
  }
  route('GET', '/api/device/data', async (req) => {
    const d = await linkedDevice(req);
    const b = await get('b:' + d.user);
    return json(200, { data: b && b.text ? JSON.parse(b.text) : null, updatedAt: b ? b.t : null });
  });
  route('PUT', '/api/device/data', async (req) => {
    const d = await linkedDevice(req);
    const body = await readJson(req, DATA_LIMIT + 1024);
    const text = JSON.stringify(body.data === undefined ? null : body.data);
    if (Buffer.byteLength(text) > DATA_LIMIT) throw new HttpError(413, 'Backup is too large (max 64 KB).');
    await put('b:' + d.user, { text, t: now() });
    return json(200, { ok: true });
  });

  // A.20: the app reports finished play sessions (launch of the game -> close). Each session has an id, so a resend is never counted twice.
  route('POST', '/api/device/playtime', async (req) => {
    const d = await linkedDevice(req);
    const body = await readJson(req);
    const list = Array.isArray(body.sessions) ? body.sessions.slice(0, 50) : [];
    const t = now();
    const p = (await get('p:' + d.user)) || { total: 0, count: 0, last: null, sessions: [] };
    const have = new Set(p.sessions.map((x) => x.id));
    let accepted = 0, duplicate = 0, rejected = 0;
    for (const x of list) {
      const id = String((x && x.id) || '');
      const sec = Math.floor(Number(x && x.seconds));
      const at = Number(x && x.startedAt);
      if (!/^[A-Za-z0-9-]{8,40}$/.test(id) || !(sec >= 1) || !(at > 1577836800000) || at > t + 86400_000) { rejected++; continue; }
      if (have.has(id)) { duplicate++; continue; }
      const game = String((x && x.game) || '').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 24);
      const clamped = Math.min(sec, PLAY_MAX_SESSION_S);
      p.sessions.push({ id, at, sec: clamped, game, dev: d.name || 'Android device' });
      have.add(id); p.total += clamped; p.count++; accepted++;
      if (!p.last || at > p.last) p.last = at;
    }
    if (accepted) {
      p.sessions.sort((a, b) => b.at - a.at);
      p.sessions = p.sessions.slice(0, PLAY_KEEP);
      await put('p:' + d.user, p);
    }
    return json(200, { ok: true, accepted, duplicate, rejected, totalSeconds: p.total });
  });

  // A.22: the app sends the cards it has; the site adds them to the account's collection and answers with the whole collection
  // (so cards from the daily gacha reach the phone too). Only cards from the built-in list count; there is no counter.
  route('POST', '/api/device/collection', async (req) => {
    const d = await linkedDevice(req);
    const body = await readJson(req);
    const t = now();
    const k = await readColl(d.user);
    const inc = body && body.cards && typeof body.cards === 'object' && !Array.isArray(body.cards) ? body.cards : {};
    let added = 0, ignored = 0;
    for (const [id, v] of Object.entries(inc)) {
      if (!CARD_BY_ID.has(id)) { ignored++; continue; }
      let first = Number(Array.isArray(v) ? v[0] : v);
      if (!(first > MIN_TIME) || first > t + 86400_000) first = t;
      if (!k.cards[id]) { k.cards[id] = first; added++; }
      else if (first < k.cards[id]) { k.cards[id] = first; added++; }     // keep the earliest date
    }
    if (added) await saveColl(d.user, k);
    return json(200, { ok: true, added, ignored, total: CARDS.length, cards: k.cards });
  });

  // One call does it all: registers the device on first use, hands out / renews the link code while it is
  // not linked, and reports "linked" once the player has typed the code on the website.
  route('POST', '/api/device/status', async (req, ctx) => {
    const secret = deviceFromAuth(req);
    const body = await readJson(req);
    const name = String(body.name || '').replace(/[^\x20-\x7E]/g, '').slice(0, 40);
    const sh = sha256(secret);
    let d = await get('d:' + sh);
    if (!d) {
      if (!(await allow('dev-new:' + clientIp(req, ctx), 10, 3600_000))) throw new HttpError(429, 'Too many new devices from this network.');
      d = { id: rid(), name, user: null, code: null, code_exp: null, created_at: now(), linked_at: null, last_seen: now() };
      await put('d:' + sh, d);
    } else if ((name && name !== d.name) || now() - (d.last_seen || 0) > 60_000) {
      d = { ...d, last_seen: now(), name: name || d.name };
      await put('d:' + sh, d);
    }

    if (d.user) {
      const u = await get('u:' + d.user);
      if (u) return json(200, { linked: true, username: u.username });
      d = { ...d, user: null, linked_at: null };            // account was deleted
      await put('d:' + sh, d);
    }
    let code = d.code, exp = d.code_exp;
    let fresh = !!(code && exp && exp >= now() + 30_000);
    const want = cleanCode(body.code);                       // A.19: the app makes its own code and tells us which one
    if (want && !(fresh && want === code)) {
      const e = await claimCode(sh, want);
      if (e) {
        if (code && code !== want) await del('c:' + code);
        code = want; exp = e; fresh = true;
        d = { ...d, code, code_exp: exp };
        await put('d:' + sh, d);
      }                                                      // else: another phone holds that code -> make our own below
    }
    if (!fresh) {                                            // missing, expired or about to expire: give a fresh one
      if (code) await del('c:' + code);
      code = await newCode(sh); exp = now() + CODE_TTL_MS;
      d = { ...d, code, code_exp: exp };
      await put('d:' + sh, d);
    }
    return json(200, { linked: false, code: code.slice(0, 4) + '-' + code.slice(4), expiresIn: Math.max(0, Math.floor((exp - now()) / 1000)) });
  });

  route('POST', '/api/device/unlink', async (req) => {
    const sh = sha256(deviceFromAuth(req));
    const d = await get('d:' + sh);
    if (d && d.user) {
      const u = await get('u:' + d.user);
      if (u) await put('u:' + d.user, { ...u, devs: (u.devs || []).filter((h) => h !== sh) });
      await put('d:' + sh, { ...d, user: null, linked_at: null });
    }
    return json(200, { ok: true });
  });

  // ------------------------------------------------------------ entry point
  return async function handle(req, ctx) {
    const url = new URL(req.url);
    try {
      const fn = routes[`${req.method} ${url.pathname}`];
      if (fn) return await fn(req, ctx);
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API.');
      throw new HttpError(405, 'Method not allowed.');
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'Server error.' });
    }
  };
}
