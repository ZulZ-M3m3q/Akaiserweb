'use strict';
const view = document.getElementById('view');

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.error || 'Something went wrong (' + r.status + ').');
  return data;
}

function say(box, text, ok) { box.className = 'msg ' + (ok ? 'ok' : 'err'); box.textContent = text; }
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' h ' + m + ' min';
  if (m > 0) return m + ' min';
  return sec + ' s';
}
function fmtDate(t) { return t ? new Date(t).toLocaleString() : 'never'; }

// ------------------------------------------------------------ Android app download (shown on the main page and the dashboard)
const APP_DOWNLOAD_URL = 'https://drive.google.com/drive/folders/1jenwXJA2W1cx9iau4SRJ2xLehovPYgrR';
function downloadCard() {
  return el('div', { class: 'card dl' },
    el('h2', {}, 'Download the Android app'),
    el('p', { class: 'mute' }, 'Get AkaiserEvodroid for Android from Google Drive, install it, then log in here and link it with the code shown in the app.'),
    el('a', { class: 'btn', href: APP_DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer' }, '⬇ Download Android app'));
}

// ------------------------------------------------------------ logged-out screen
function showAuth(mode) {
  const signup = mode === 'signup';
  const msg = el('div');
  const user = el('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', maxlength: '20', placeholder: 'letters, numbers, _' });
  const pass = el('input', { id: 'p', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', placeholder: 'at least 8 characters' });
  const pass2 = signup ? el('input', { id: 'p2', type: 'password', autocomplete: 'new-password' }) : null;
  const go = el('button', { type: 'button' }, signup ? 'Create account' : 'Log in');

  async function submit() {
    if (signup && pass.value !== pass2.value) return say(msg, 'The two passwords do not match.');
    go.disabled = true;
    try {
      await api(signup ? '/api/signup' : '/api/login', { username: user.value.trim(), password: pass.value });
      await render();
    } catch (e) { say(msg, e.message); go.disabled = false; }
  }
  go.addEventListener('click', submit);
  for (const i of [user, pass, pass2]) if (i) i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  view.replaceChildren(
    el('p', { class: 'tagline' }, 'Animal Kaiser Evolution on your Android phone'),
    downloadCard(),
    el('div', { class: 'tabs' },
      el('button', { class: signup ? 'on' : '', onclick: () => showAuth('signup') }, 'Sign up'),
      el('button', { class: signup ? '' : 'on', onclick: () => showAuth('login') }, 'Log in')),
    el('div', { class: 'card' },
      el('h2', {}, signup ? 'Create your account' : 'Welcome back'),
      el('label', { for: 'u' }, 'Username'), user,
      el('label', { for: 'p' }, 'Password'), pass,
      signup ? [el('label', { for: 'p2' }, 'Repeat password'), pass2] : null,
      go, msg),
    el('p', { class: 'mute' }, 'After you sign in you will enter the code shown in the app to connect it to your account.'));
}

// ------------------------------------------------------------ logged-in screen
function formatCodeInput(input) {
  let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
  input.value = v;
}

let page = 'account';      // 'account' | 'cards'
function nav() {
  const t = (id, label) => el('button', { class: page === id ? 'on' : '', onclick: () => { page = id; render(); } }, label);
  return el('div', { class: 'tabs' }, t('account', 'Account'), t('cards', 'Cards'));
}

function showDashboard(me) {
  const linkMsg = el('div');
  const code = el('input', { class: 'codebox', placeholder: 'XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', maxlength: '9' });
  code.addEventListener('input', () => formatCodeInput(code));
  const linkBtn = el('button', { type: 'button' }, 'Link my app');
  async function link() {
    linkBtn.disabled = true;
    try {
      await api('/api/link', { code: code.value });
      code.value = '';
      await render('Linked! Your app will unlock in a few seconds.');
    } catch (e) { say(linkMsg, e.message); linkBtn.disabled = false; }
  }
  linkBtn.addEventListener('click', link);
  code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') link(); });

  const devs = me.devices.length
    ? me.devices.map((d) => el('div', { class: 'row' },
        el('div', {}, el('div', {}, d.name), el('div', { class: 'mute' }, 'Linked ' + fmtDate(d.linkedAt) + ' · last seen ' + fmtDate(d.lastSeen))),
        el('button', { class: 'ghost small', onclick: async () => {
          if (!confirm('Unlink "' + d.name + '"? The game will ask for a new code on that device.')) return;
          try { await api('/api/devices/unlink', { id: d.id }); await render(); } catch (e) { alert(e.message); }
        } }, 'Unlink')))
    : [el('p', { class: 'mute' }, 'No app linked yet.')];

  // change password
  const pwMsg = el('div');
  const oldPw = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = el('input', { type: 'password', autocomplete: 'new-password' });
  const pwBtn = el('button', { type: 'button', class: 'ghost' }, 'Change password');
  pwBtn.addEventListener('click', async () => {
    pwBtn.disabled = true;
    try { await api('/api/change-password', { oldPassword: oldPw.value, newPassword: newPw.value }); oldPw.value = newPw.value = ''; say(pwMsg, 'Password changed.', true); }
    catch (e) { say(pwMsg, e.message); }
    pwBtn.disabled = false;
  });

  // delete account
  const delMsg = el('div');
  const delPw = el('input', { type: 'password', autocomplete: 'current-password' });
  const delBtn = el('button', { type: 'button', class: 'danger' }, 'Delete my account');
  delBtn.addEventListener('click', async () => {
    if (!confirm('Delete your account and cloud backup for good?')) return;
    try { await api('/api/delete-account', { password: delPw.value }); await render(); } catch (e) { say(delMsg, e.message); }
  });

  view.replaceChildren(
    whoBar(me), nav(),
    downloadCard(),
    el('div', { class: 'card' },
      el('h2', {}, 'Link your app'),
      el('p', { class: 'mute' }, 'Open AkaiserEvodroid and tap PLAY. The app shows a code. Type it here.'),
      code, linkBtn, linkMsg),
    el('div', { class: 'card' },
      el('h2', {}, 'Your devices (' + me.devices.length + '/' + me.maxDevices + ')'), devs,
      me.backup ? el('p', { class: 'mute' }, 'Cloud backup of app settings: ' + me.backup.bytes + ' bytes, saved ' + fmtDate(me.backup.updatedAt)) : null),
    playCard(me.playtime),
    el('div', { class: 'card' },
      el('details', {}, el('summary', {}, 'Change password'),
        el('label', {}, 'Current password'), oldPw, el('label', {}, 'New password'), newPw, pwBtn, pwMsg)),
    el('div', { class: 'card' },
      el('details', {}, el('summary', {}, 'Delete account'),
        el('label', {}, 'Type your password to confirm'), delPw, delBtn, delMsg)));
}

function whoBar(me) {
  return el('div', { class: 'who' },
    el('div', {}, 'Signed in as ', el('b', {}, me.username)),
    el('button', { class: 'ghost small', onclick: async () => { await api('/api/logout', {}); page = 'account'; await render(); } }, 'Log out'));
}

function playCard(pt) {
  pt = pt || { totalSeconds: 0, sessionCount: 0, recent: [], daily: [] };
  const week = (pt.daily || []).slice(-7).reduce((a, d) => a + d.seconds, 0);
  const max = Math.max(1, ...(pt.daily || []).map((d) => d.seconds));
  const bars = (pt.daily || []).map((d) => {
    const fill = el('div', { class: 'fill' });
    fill.style.height = Math.round((d.seconds / max) * 100) + '%';   // set through the DOM: the page's CSP forbids inline style attributes
    return el('div', { class: 'bar', title: d.day + ': ' + fmtDur(d.seconds) }, fill);
  });
  const rows = (pt.recent || []).map((x) => el('div', { class: 'row' },
    el('div', {}, el('div', {}, fmtDur(x.seconds)), el('div', { class: 'mute' }, fmtDate(x.at) + (x.device ? ' · ' + x.device : ''))),
    el('div', { class: 'mute' }, x.game || '')));
  return el('div', { class: 'card' },
    el('h2', {}, 'Play time'),
    el('div', { class: 'stats' },
      el('div', {}, el('b', {}, fmtDur(pt.totalSeconds)), el('div', { class: 'mute' }, 'total')),
      el('div', {}, el('b', {}, fmtDur(week)), el('div', { class: 'mute' }, 'last 7 days')),
      el('div', {}, el('b', {}, String(pt.sessionCount || 0)), el('div', { class: 'mute' }, 'sessions'))),
    pt.sessionCount ? [el('div', { class: 'bars' }, bars), el('p', { class: 'mute' }, 'Last 14 days (UTC days)'),
      el('details', {}, el('summary', {}, 'Recent sessions'), rows)]
      : el('p', { class: 'mute' }, 'Nothing yet. Time is counted from when the game starts until you close it, and is sent when the phone is online.'));
}

// ------------------------------------------------------------ cards: daily gacha + collection (A.22)
const KINDS = [['animal', 'Animal'], ['strong', 'Strong'], ['miracle', 'Miracle']];
let catalog = null;                                   // the full card list, loaded once
const cardView = { kind: 'animal', query: '', showAll: false };

function rarityClass(r) {
  if (/Kaiser|Gold/.test(r)) return 'r-gold';
  if (/Ultra/.test(r)) return 'r-ultra';
  if (/Silver/.test(r)) return 'r-silver';
  if (/Bronze/.test(r)) return 'r-bronze';
  return 'r-normal';
}
function fmtLeft(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
  return h > 0 ? h + ' h ' + (m % 60) + ' min' : m + ' min';
}

function cardTile(c, firstAt, extra) {
  const has = firstAt != null;
  const tile = el('div', { class: 'ccard ' + rarityClass(c.rarity) + (has ? '' : ' locked') },
    el('div', { class: 'cname' }, c.name),
    el('div', { class: 'cstats' }, c.stats),
    el('div', { class: 'cmeta' }, c.rarity + ' · ' + c.game + (has ? '' : ' · not collected yet')));
  if (has) {
    const more = el('div', { class: 'cmore', hidden: true }, 'Barcode: ' + c.id + ' · collected ' + fmtDate(firstAt));
    tile.append(more);
    tile.classList.add('tap');
    tile.addEventListener('click', () => { more.hidden = !more.hidden; });
  }
  if (extra) tile.prepend(extra);
  return tile;
}

function gachaCard(coll, onDrawn) {
  const g = coll.gacha, msg = el('div'), result = el('div');
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const btn = el('button', { type: 'button' }, 'Open today’s card');
  if (g.complete) { btn.disabled = true; btn.textContent = 'You have every card!'; }
  else if (!g.canDraw) { btn.disabled = true; btn.textContent = 'Come back in ' + fmtLeft(g.nextAt - Date.now()); }
  if (g.drawnToday && g.todayCard && byId.get(g.todayCard)) {
    result.append(el('p', { class: 'mute' }, 'Today’s card:'), cardTile(byId.get(g.todayCard), coll.owned[g.todayCard]));
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api('/api/gacha', {});
      onDrawn(r);
    } catch (e) { say(msg, e.message); btn.disabled = false; }
  });
  return el('div', { class: 'card' },
    el('h2', {}, 'Daily card'),
    el('p', { class: 'mute' }, 'Open one random card every day. You can only get a card you do not have yet, and cards you get here also appear in the app.'),
    btn, msg, result);
}

function collectionCard(coll) {
  const owned = coll.owned;
  const counts = {};
  for (const [k] of KINDS) counts[k] = { have: 0, all: 0 };
  for (const c of catalog) { counts[c.kind].all++; if (owned[c.id]) counts[c.kind].have++; }
  const haveAll = Object.keys(owned).length;

  const bar = el('div', { class: 'progress' }, el('div', { class: 'pfill' }));
  bar.firstChild.style.width = Math.round((haveAll / catalog.length) * 100) + '%';
  const list = el('div', { class: 'clist' });
  const tabs = el('div', { class: 'ktabs' });
  const search = el('input', { type: 'search', placeholder: 'Search name', autocomplete: 'off' });
  search.value = cardView.query;
  const showAll = el('input', { type: 'checkbox' });
  showAll.checked = cardView.showAll;

  function draw() {
    tabs.replaceChildren(...KINDS.map(([k, label]) => el('button', { class: 'ghost' + (cardView.kind === k ? ' on' : ''), onclick: () => { cardView.kind = k; draw(); } },
      label, el('br'), counts[k].have + '/' + counts[k].all)));
    const q = cardView.query.toLowerCase();
    const rows = catalog.filter((c) => c.kind === cardView.kind && (cardView.showAll || owned[c.id]) && (!q || c.name.toLowerCase().includes(q)));
    list.replaceChildren(...(rows.length ? rows.map((c) => cardTile(c, owned[c.id] || null))
      : [el('p', { class: 'mute' }, counts[cardView.kind].have === 0 && !cardView.showAll
        ? 'No cards here yet. Scan cards in the app or open your daily card.' : 'No card matches.')]));
  }
  search.addEventListener('input', () => { cardView.query = search.value.trim(); draw(); });
  showAll.addEventListener('change', () => { cardView.showAll = showAll.checked; draw(); });
  draw();
  return el('div', { class: 'card' },
    el('h2', {}, 'Card collection'),
    el('p', { class: 'mute' }, haveAll + ' of ' + catalog.length + ' cards collected. Cards you scan in the app are added here automatically.'),
    bar, tabs, search,
    el('label', { class: 'check' }, showAll, ' Show cards I don’t have'),
    list);
}

async function showCards(me) {
  if (!catalog) catalog = (await api('/api/cards')).cards;
  const coll = await api('/api/collection');
  const draw = () => {
    const box = el('div');
    const gacha = gachaCard(coll, (r) => {
      coll.owned = r.owned; coll.gacha = r.gacha;
      reveal(r.card);
    });
    box.append(gacha, collectionCard(coll));
    view.replaceChildren(whoBar(me), nav(), box);
  };
  function reveal(card) {
    const tile = cardTile(card, coll.owned[card.id], el('div', { class: 'newtag' }, 'NEW!'));
    tile.classList.add('reveal');
    view.replaceChildren(whoBar(me), nav(),
      el('div', { class: 'card' }, el('h2', {}, 'You got a card!'), tile,
        el('button', { type: 'button', onclick: draw }, 'Back to my cards')));
  }
  draw();
}

async function render(flash) {
  let me;
  try { me = await api('/api/me'); } catch (e) { view.replaceChildren(el('div', { class: 'msg err' }, e.message)); return; }
  if (!me.loggedIn) return showAuth('signup');
  if (page === 'cards') { try { await showCards(me); } catch (e) { view.replaceChildren(whoBar(me), nav(), el('div', { class: 'msg err' }, e.message)); } }
  else showDashboard(me);
  if (flash) { const b = el('div', { class: 'msg ok' }, flash); view.prepend(b); }
}
render();
