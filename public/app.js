import { md, esc } from './md.js';

const $app = document.getElementById('app');
const STATUSES = ['draft', 'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];
const REVIEW_LABEL = { fix: 'Fixed CV', cover_letter: 'Cover letter', pre_submit: 'Pre-submit review', rejection: 'Rejection analysis', tailor: 'Tailored version', interview_prep: 'Interview prep', patterns: 'Pattern analysis', answer: 'Answer review' };
const KIND_LABEL = { cv: 'CV', cover_letter: 'Cover letter', other: 'Other' };
const isMobile = () => matchMedia('(max-width: 820px)').matches;

// ---------- helpers ----------
// ---------- offline support ----------
// When the laptop is unreachable, reads come from the copy saved on this device (see sw.js) and
// simple changes are queued here, then replayed in order once the laptop is back.
const OUTBOX_KEY = 'jt_outbox';
const QUEUEABLE = [/^POST \/api\/applications$/, /^PATCH \/api\/applications\/\d+$/, /^POST \/api\/answers$/, /^PATCH \/api\/answers\/\d+$/,
  /^PATCH \/api\/emails\/\d+$/, /^POST \/api\/emails\/seen$/, /^PUT \/api\/profile$/];
const outbox = { get: () => { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; } }, set: (q) => { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch {} } };
let offlineSince = null;
class QueuedOffline extends Error { constructor() { super('Saved on this phone. It\'ll sync when your laptop is back online.'); this.queued = true; } }
function setOffline(flag, when) {
  const was = !!offlineSince;
  offlineSince = flag ? (offlineSince || when || new Date().toISOString()) : null;
  if (was !== !!offlineSince) renderOfflineBar();
  if (was && !flag) flushOutbox();
}
function renderOfflineBar() {
  document.getElementById('offlineBar')?.remove();
  const n = outbox.get().length;
  if (!offlineSince && !n) return;
  const bar = h(`<div id="offlineBar" class="offline-bar">${offlineSince ? `<b>Offline</b> · your laptop isn't reachable, so you're seeing data saved on this phone.` : '<b>Syncing…</b>'}${n ? ` ${n} change${n > 1 ? 's' : ''} waiting to sync.` : ''}</div>`);
  (document.querySelector('.shell') || document.body).prepend(bar);
}
let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  const q = outbox.get(); if (!q.length) return;
  flushing = true;
  try {
    while (outbox.get().length) {
      const [item, ...rest] = outbox.get();
      let r;
      try { r = await fetch(item.path, { method: item.method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: item.body }); }
      catch { setOffline(true); return; }                         // still offline: try again later
      if (r.status === 503 && r.headers.get('X-JobTrack-Offline')) { setOffline(true); return; }
      outbox.set(rest);                                           // sent (or rejected with 4xx): move on
    }
    toast('Offline changes synced ✓'); renderOfflineBar(); route();
  } finally { flushing = false; }
}
window.addEventListener('online', () => flushOutbox());
setInterval(() => { if (outbox.get().length) flushOutbox(); }, 30000);

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && !(o.body instanceof FormData) && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const method = (o.method || 'GET').toUpperCase();
  if (method !== 'GET') api.lastWrite = Date.now();
  else if (Date.now() - (api.lastWrite || 0) < 10000) o.headers['X-JobTrack-Fresh'] = '1';
  let r;
  try { r = await fetch(path, o); }
  catch (e) {                                                     // network error = laptop unreachable
    if (method === 'GET') { setOffline(true); throw new Error('Your laptop is unreachable.'); }
    if (QUEUEABLE.some((re) => re.test(`${method} ${path.split('?')[0]}`)) && typeof o.body === 'string') {
      outbox.set([...outbox.get(), { method, path, body: o.body, at: Date.now() }]); setOffline(true); renderOfflineBar(); throw new QueuedOffline();
    }
    setOffline(true); throw new Error('This needs your laptop to be online.');
  }
  const fromCache = method === 'GET' && !!r.headers.get('X-JobTrack-Offline');
  if (method === 'GET') setOffline(fromCache, r.headers.get('X-JobTrack-Offline'));
  if (r.status === 401 && !path.startsWith('/api/auth')) { renderAuth(); throw new Error('Not signed in'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const err = new Error(data?.error || `Request failed (${r.status})`); err.offline = !!data?.offline; throw err; }
  return fromCache || outbox.get().length ? withPending(path, data) : data;
}

// Show changes that are still waiting to sync on top of the saved copy
function withPending(path, data) {
  const edits = {};
  for (const it of outbox.get()) {
    const m = it.method === 'PATCH' && it.path.match(/^\/api\/applications\/(\d+)$/);
    if (m) { try { Object.assign((edits[m[1]] ||= {}), JSON.parse(it.body)); } catch {} }
  }
  if (!Object.keys(edits).length) return data;
  const p = path.split('?')[0];
  if (p === '/api/applications' && Array.isArray(data)) return data.map((a) => (edits[a.id] ? { ...a, ...edits[a.id] } : a));
  const m = p.match(/^\/api\/applications\/(\d+)$/);
  if (m && edits[m[1]]) return { ...data, ...edits[m[1]] };
  return data;
}

// Save everything to this device while online, so it's all there when the laptop isn't
async function warmCache() {
  if (offlineSince || !('caches' in window)) return;
  try {
    const base = ['/api/applications', '/api/documents', '/api/answers', '/api/stats', '/api/profile', '/api/reminders', '/api/mail/status',
      '/api/duplicates/groups', '/api/emails/updates', '/api/emails?filter=all', '/api/reviews'];
    await Promise.all(base.map((u) => fetch(u, { credentials: 'same-origin' }).catch(() => {})));
    const apps = await (await fetch('/api/applications', { credentials: 'same-origin' })).json();
    const docs = await (await fetch('/api/documents', { credentials: 'same-origin' })).json();
    const urls = [...apps.slice(0, 150).map((a) => `/api/applications/${a.id}`), ...latestVersions(docs).slice(0, 60).map((d) => `/api/documents/${d.id}`)];
    for (let i = 0; i < urls.length; i += 3) { await Promise.all(urls.slice(i, i + 3).map((u) => fetch(u, { credentials: 'same-origin' }).catch(() => {}))); await new Promise((r) => setTimeout(r, 150)); }
  } catch {}
}
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function toast(msg, ms = 2600) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length <= 19 ? 'Z' : '')).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const daysAgo = (s) => (s ? Math.floor((Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 864e5) : null);
const pill = (s) => `<span class="pill" style="color:var(--s-${s})"><span class="dot"></span>${s}</span>`;
const statusOptions = (cur) => STATUSES.map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('');
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { const ta = h('<textarea></textarea>'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); } }
function guard(fn) { return async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Not signed in') toast(e.message, e.queued ? 3500 : 4000); if (!e.queued) console.error(e); } }; }

const I = {
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v6a6 6 0 0 0 6 6h6M18 15l-3-3M18 15l-3 3M6 21V9"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
  logo: '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" style="fill:var(--primary)"/><path d="M9 11h14v13a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z" fill="#fff"/><path d="M13 11V9a3 3 0 0 1 6 0v2" stroke="#fff" stroke-width="2.2" fill="none"/><path d="M12.5 18.5l2.5 2.5 4.5-5" style="stroke:var(--primary)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------- layout & routing ----------
function layout(active, inner) {
  const link = (href, key, icon, label) => `<a href="${href}" class="${active === key ? 'active' : ''}"><span class="nav-ic">${icon}</span><span>${label}</span></a>`;
  $app.innerHTML = `<div class="shell">
    <nav class="nav">
      <a class="brand" href="#/">${I.logo} JobTrack</a>
      ${link('#/', 'board', I.board, 'Applications')}
      ${link('#/new', 'new', I.plus, 'New')}
      ${link('#/docs', 'docs', I.doc, 'Documents')}
      ${link('#/inbox', 'inbox', I.mail, 'Inbox')}
      ${link('#/answers', 'answers', I.chat, 'Answers')}
      ${link('#/insights', 'insights', I.chart, 'Insights')}
      ${link('#/profile', 'profile', (() => { try { const v = localStorage.getItem('jt_avatar_v'); return v ? `<img class="nav-avatar" src="/api/profile/avatar?v=${v}" alt="">` : I.user; } catch { return I.user; } })(), 'Profile')}
    </nav>
    <main id="main"></main></div>`;
  const main = document.getElementById('main');
  renderOfflineBar();
  // Unread employer replies badge on the Inbox link
  api('/api/mail/status').then((st) => {
    const n = st.counts?.unseen || 0, el = document.querySelector('.nav a[href="#/inbox"]');
    if (el && n) el.querySelector('.nav-ic').insertAdjacentHTML('beforeend', `<span class="badge">${n > 9 ? '9+' : n}</span>`);
  }).catch(() => {});
  if (typeof inner === 'string') main.innerHTML = inner; else if (inner) main.append(inner);
  return main;
}

const routes = [
  [/^#\/?$/, () => viewBoard()],
  [/^#\/new/, () => viewNew()],
  [/^#\/app\/(\d+)\/insight/, (m) => viewInsight(+m[1])],
  [/^#\/app\/(\d+)/, (m) => viewApp(+m[1])],
  [/^#\/inbox/, () => viewInbox()],
  [/^#\/docs$/, () => viewDocs()],
  [/^#\/doc\/(\d+)/, (m) => viewEditor(+m[1])],
  [/^#\/answers/, () => viewAnswers()],
  [/^#\/insights/, () => viewInsights()],
  [/^#\/(profile|settings)/, () => viewProfile()],
];
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
async function route() {
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  const hash = location.hash.split('?')[0] || '#/';
  for (const [re, fn] of routes) { const m = hash.match(re); if (m) { try { await fn(m); } catch (e) { if (e.message !== 'Not signed in') { layout('', `<div class="banner warn">${esc(e.message)}</div>`); } } window.scrollTo(0, 0); document.getElementById('main')?.scrollTo(0, 0); return; } }
  location.hash = '#/';
}

// ---------- auth ----------
async function renderAuth() {
  const st = await (await fetch('/api/auth/status')).json();
  const creating = !st.setup;
  $app.innerHTML = `<div class="auth"><div class="auth-art"><div><span class="auth-logo">${I.logo}</span><h1>JobTrack</h1>
      <p>Every application, CV and answer in one place, with Claude reviewing them before you hit submit.</p></div></div>
    <form class="card stack auth-card" id="authForm">
    <h2 style="margin:0">${creating ? 'Create your account' : 'Welcome back'}</h2>
    <p class="muted small" style="margin:0">${creating ? 'Your account stays on your own laptop. You\'ll sign in with it on your laptop and phone.' : 'Sign in to continue.'}</p>
    ${creating ? '<div><label>Full name</label><input name="name" autocomplete="name" required></div>' : ''}
    ${creating || st.hasEmail ? `<div><label>Email</label><input type="email" name="email" autocomplete="email" required ${creating ? '' : 'autofocus'}></div>` : ''}
    <div><label>Password</label><input type="password" name="pin" autocomplete="${creating ? 'new-password' : 'current-password'}" minlength="${creating ? 8 : 6}" required ${!creating && !st.hasEmail ? 'autofocus' : ''}></div>
    ${creating ? '<div><label>Confirm password</label><input type="password" name="pin2" autocomplete="new-password" minlength="8" required></div>' : ''}
    <button class="btn primary" style="width:100%">${creating ? 'Create account' : 'Sign in'}</button>
    <p class="small" id="authErr" style="color:var(--danger);margin:0"></p></form></div>`;
  document.getElementById('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const err = document.getElementById('authErr');
    if (creating && f.pin !== f.pin2) { err.textContent = 'Passwords don\'t match'; return; }
    const r = await fetch(creating ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; return; }
    if (!creating && !st.hasEmail) { location.hash = '#/profile'; toast('Add an email to your account to finish setting it up', 5000); }
    route();
  };
}

// Company logo, or coloured initials when there isn't one
const AV_COLORS = ['#4f46e5', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#059669', '#2563eb', '#9333ea', '#c2410c', '#0d9488'];
function avatar(a, size = 48) {
  const name = (a.company || a.role || '?').trim();
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const color = AV_COLORS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AV_COLORS.length];
  const fallback = `<span class="avatar" style="width:${size}px;height:${size}px;background:${color}">${esc(initials)}</span>`;
  if (!a.logo_url) return fallback;
  return `<span class="avatar img" style="width:${size}px;height:${size}px"><img src="${esc(a.logo_url)}" alt="" referrerpolicy="no-referrer" loading="lazy" data-fallback="${esc(initials)}" data-color="${color}"></span>`;
}
// Swap broken logos for initials (CSP blocks inline onerror handlers)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.fallback) { const s = img.parentElement; s.classList.remove('img'); s.style.background = img.dataset.color; s.textContent = img.dataset.fallback; }
}, true);

const STATUS_LABEL = { all: 'All', draft: 'Drafts', applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offers', rejected: 'Rejected', ghosted: 'Ghosted', withdrawn: 'Withdrawn' };

// ---------- applications ----------
async function viewBoard() {
  const [apps, rem, dupes, updates] = await Promise.all([api('/api/applications'), api('/api/reminders'), api('/api/duplicates/groups'), api('/api/emails/updates').catch(() => [])]);
  const main = layout('board');
  let filter = query().get('s') || localStorage.getItem('jt_filter') || 'all';
  let q = '';
  const banners = [];
  if (updates.length) banners.push(`<div class="card updates"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">${I.mail} New from your email</h2><span class="spacer"></span><button class="btn sm ghost" id="seenAll">Mark all as seen</button></div>
    ${updates.slice(0, isMobile() ? 3 : 5).map((u) => `<div class="mail-row unseen" data-email="${u.id}">${avatar(u, 34)}<div class="mail-main"><div class="row" style="gap:8px;flex-wrap:nowrap"><b class="ellipsis">${esc(u.company)}</b>${catChip(u.category)}${u.applied_status ? `<span class="small muted nowrap">→ ${u.applied_status}</span>` : ''}<span class="spacer"></span><span class="small muted nowrap">${timeAgo(u.date)}</span></div>
      <div class="small muted ellipsis">${esc(u.role)} · ${esc(u.subject)}</div></div></div>`).join('')}
    ${updates.length > (isMobile() ? 3 : 5) ? `<a class="small" href="#/inbox?f=new">See all ${updates.length} updates →</a>` : ''}</div>`);
  if (rem.stale.length) banners.push(`<div class="banner warn"><strong>${rem.stale.length} application${rem.stale.length > 1 ? 's' : ''} with no reply for 14+ days.</strong> Follow up, or mark as ghosted: ${rem.stale.slice(0, 4).map((a) => `<a href="#/app/${a.id}">${esc(a.company)}</a>`).join(', ')}${rem.stale.length > 4 ? '…' : ''}</div>`);
  if (rem.followUps.length) banners.push(`<div class="banner"><strong>Follow-ups due:</strong> ${rem.followUps.map((a) => `<a href="#/app/${a.id}">${esc(a.role)} @ ${esc(a.company)}</a>`).join(', ')}</div>`);
  if (dupes.length) banners.push(`<div class="banner dupe row"><span style="flex:1"><strong>${dupes.length} possible duplicate${dupes.length > 1 ? 's' : ''}</strong> (${dupes.map((g) => esc(g[0].company)).join(', ')}). Merge them to keep one record per job.</span><button class="btn sm primary" id="mergeBtn">${I.merge} Review &amp; merge</button></div>`);
  if (rem.drafts.length) banners.push(`<div class="banner">You have ${rem.drafts.length} unfinished draft${rem.drafts.length > 1 ? 's' : ''}. Did you submit ${rem.drafts.length > 1 ? 'them' : 'it'}?</div>`);

  const iosHint = document.documentElement.classList.contains('ios-browser') && !localStorage.getItem('jt_hide_a2hs')
    ? `<div class="banner small row" id="a2hs"><span style="flex:1">Tip: tap <b>Share → Add to Home Screen</b> for the full-screen app, with notifications and no Safari bar.</span><button class="btn sm ghost" id="a2hsX">✕</button></div>` : '';
  main.innerHTML = `${iosHint}<div class="hero"><div><h1>Applications</h1><p>${apps.filter((a) => a.status !== 'draft').length} sent · ${apps.filter((a) => a.status === 'interview').length} interviewing · ${apps.filter((a) => a.status === 'offer').length} offers</p></div>
    <a class="btn primary" href="#/new">${I.plus} New application</a></div>
    ${banners.join('')}
    <div class="status-tabs" id="tabs"></div>
    <div class="row" style="margin-bottom:14px"><input id="search" placeholder="Search company or role" style="max-width:340px"></div>
    <div id="content"></div>`;

  const counts = (s) => (s === 'all' ? apps.length : apps.filter((a) => a.status === s).length);
  function drawTabs() {
    main.querySelector('#tabs').innerHTML = ['all', ...STATUSES].filter((s) => s === 'all' || s === filter || counts(s) || ['applied', 'interview', 'offer', 'rejected', 'ghosted'].includes(s))
      .map((s) => `<button class="stab ${s === filter ? 'active' : ''}" data-s="${s}" style="--c:var(--s-${s === 'all' ? 'all' : s})"><span class="dot"></span>${STATUS_LABEL[s]}<span class="n">${counts(s)}</span></button>`).join('');
    main.querySelectorAll('.stab').forEach((b) => (b.onclick = () => { filter = b.dataset.s; localStorage.setItem('jt_filter', filter); drawTabs(); draw(); }));
  }

  const card = (a) => `<div class="job" style="--c:var(--s-${a.status})">
    <a href="#/app/${a.id}" class="job-main">
      ${avatar(a)}
      <div class="job-info">
        <div class="job-role">${esc(a.role || 'Untitled role')}</div>
        <div class="job-co">${esc(a.company || '—')}${a.location ? ` <span class="muted">· ${esc(a.location)}</span>` : ''}</div>
        <div class="job-meta">
          <span>${a.applied_at ? `Applied ${fmtDate(a.applied_at)} · ${daysAgo(a.applied_at) === 0 ? 'today' : daysAgo(a.applied_at) + 'd ago'}` : `Added ${fmtDate(a.created_at)}`}</span>
          ${a.latest_email ? `<span class="cat ${a.latest_email.seen ? '' : 'pulse'}" style="--c:${(CAT[a.latest_email.category] || CAT.other).color}" title="${esc(a.latest_email.subject)}">${I.mail} ${(CAT[a.latest_email.category] || CAT.other).label} · ${fmtDate(a.latest_email.date)}</span>` : ''}
          ${a.source ? `<span class="tag">${esc(a.source)}</span>` : ''}
          ${a.docs.length ? a.docs.map((d) => `<span class="tag doc">${d.kind === 'cover_letter' ? '✉️' : '📄'} ${esc(d.title)} v${d.version}</span>`).join('') : '<span class="tag warn">No CV attached</span>'}
        </div>
        ${a.key_answers.length ? `<div class="qa">${a.key_answers.map((x) => `<div><span class="qa-l">${esc(x.label)}</span><span class="qa-a">${esc(x.answer.length > 110 ? x.answer.slice(0, 110) + '…' : x.answer)}</span></div>`).join('')}</div>` : ''}
      </div>
    </a>
    <select class="status-select" data-id="${a.id}" style="color:var(--s-${a.status})">${statusOptions(a.status)}</select>
  </div>`;

  function draw() {
    const content = main.querySelector('#content');
    if (!apps.length) { content.innerHTML = `<div class="card empty"><h2>No applications yet</h2><p>Add one here, or open a job application in Chrome and the extension will offer to track it.</p><a class="btn primary" href="#/new">${I.plus} Add your first application</a></div>`; return; }
    const shown = apps.filter((a) => (!q || `${a.company} ${a.role}`.toLowerCase().includes(q)) && (filter === 'all' || a.status === filter));
    content.innerHTML = shown.length ? `<div class="jobs">${shown.map(card).join('')}</div>` : `<div class="card empty">No ${STATUS_LABEL[filter].toLowerCase()} applications${q ? ' matching your search' : ''}.</div>`;
    content.querySelectorAll('.status-select').forEach((sel) => (sel.onchange = guard(async () => {
      const a = apps.find((x) => x.id === +sel.dataset.id);
      Object.assign(a, await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { status: sel.value } }));
      toast(`Moved to ${a.status}`); drawTabs(); draw();
      if (a.status === 'interview') promptAI(a, 'interview_prep', 'Interview stage! Want Claude to prep you for it?');
      if (a.status === 'rejected' || a.status === 'ghosted') promptAI(a, 'rejection', 'Sorry about that. Want Claude to narrow down what might have cost you?');
    })));
  }
  main.querySelector('#search').oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  const ax = main.querySelector('#a2hsX'); if (ax) ax.onclick = () => { try { localStorage.setItem('jt_hide_a2hs', '1'); } catch {} main.querySelector('#a2hs').remove(); };
  const mb = main.querySelector('#mergeBtn'); if (mb) mb.onclick = () => mergeModal(dupes);
  main.querySelectorAll('[data-email]').forEach((r) => (r.onclick = () => emailModal(+r.dataset.email, (x) => { if (x === 'seen') r.classList.remove('unseen'); else viewBoard(); })));
  const sa = main.querySelector('#seenAll'); if (sa) sa.onclick = guard(async () => { await api('/api/emails/seen', { method: 'POST', body: {} }); viewBoard(); });
  drawTabs(); draw();
}

function mergeModal(groups) {
  const m = modal(`<div class="modal-head"><h2>${I.merge} Merge duplicates</h2><span class="spacer"></span><button class="btn ghost sm" data-close>✕</button></div>
    <p class="muted small">Pick the record to keep. Documents, answers, reviews and history from the others move into it, and the others are removed.</p>
    ${groups.map((g, gi) => `<div class="card" data-g="${gi}">${g.map((a, i) => `<label class="row merge-opt" style="margin:0 0 8px;color:var(--text);font-weight:500">
      <input type="radio" name="keep${gi}" value="${a.id}" ${i === 0 ? 'checked' : ''} style="width:auto;min-height:0">${avatar(a, 34)}
      <span style="flex:1"><b>${esc(a.role)}</b> @ ${esc(a.company)}<br><span class="small muted">${a.status} · added ${fmtDate(a.created_at)}${a.url ? ' · ' + esc(a.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 45)) : ''}</span></span></label>`).join('')}
      <button class="btn primary sm" data-merge="${gi}">Merge into selected</button></div>`).join('')}`, 'wide');
  m.querySelectorAll('[data-merge]').forEach((b) => (b.onclick = guard(async () => {
    const gi = +b.dataset.merge, g = groups[gi];
    const keep = +m.querySelector(`input[name=keep${gi}]:checked`).value;
    for (const a of g) if (a.id !== keep) await api(`/api/applications/${keep}/merge`, { method: 'POST', body: { from_id: a.id } });
    b.closest('.card').innerHTML = '<p style="margin:0;color:var(--ok)">✓ Merged</p>';
    toast('Merged'); if (!m.querySelector('[data-merge]')) setTimeout(() => { m.close(); viewBoard(); }, 600);
  })));
}

function promptAI(a, type, msg) {
  const m = modal(`<div class="modal-head"><h2>${esc(msg)}</h2></div><p class="muted">${esc(a.role)} @ ${esc(a.company)}</p>
    <div class="row"><button class="btn primary" data-go>${I.spark} ${REVIEW_LABEL[type]}</button><button class="btn" data-close>Not now</button></div>`);
  m.querySelector('[data-go]').onclick = () => { m.close(); aiModal({ type, app_id: a.id }); };
}

// ---------- modal ----------
function modal(html, cls = '') {
  const bg = h(`<div class="modal-bg"><div class="modal ${cls}">${html}</div></div>`);
  bg.close = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg) bg.close(); };
  bg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = bg.close));
  document.body.append(bg);
  return bg;
}

// ---------- new application ----------
async function viewNew() {
  const docs = await api('/api/documents');
  const latest = latestVersions(docs);
  const p = query();
  const main = layout('new');
  main.innerHTML = `<div class="topbar"><h1>New application</h1></div>
  <form class="card" id="f" style="max-width:860px">
    <div class="field"><label>Job posting URL</label><div class="row" style="flex-wrap:nowrap"><input name="url" type="url" placeholder="https://boards.greenhouse.io/…" value="${esc(p.get('url') || '')}"><button type="button" class="btn" id="fetch">Fetch details</button></div>
    <p class="small muted" style="margin:4px 0 0">Paste a link and JobTrack pulls in the company, role and full job description, so you still have it if the posting comes down.</p></div>
    <div id="dupe"></div>
    <div class="grid2">
      <div class="field"><label>Company</label><input name="company" required></div>
      <div class="field"><label>Role</label><input name="role" required value="${esc(p.get('title') || '')}"></div>
      <div class="field"><label>Location</label><input name="location"></div>
      <div class="field"><label>Salary</label><input name="salary"></div>
      <div class="field"><label>Source</label><input name="source" placeholder="LinkedIn, Greenhouse, referral…"></div>
      <div class="field"><label>Status</label><select name="status"><option value="draft">Draft (not submitted yet)</option><option value="applied">Applied</option></select></div>
    </div>
    <div class="field"><label>Job description</label><textarea name="jd_text" rows="8" placeholder="Fetched automatically from the URL, or paste it here"></textarea></div>
    <div class="field"><label>Documents sent</label>
      ${latest.length ? `<div class="stack" style="margin-bottom:10px">${latest.map((d) => `<label class="row" style="font-weight:500;color:var(--text);margin:0"><input type="checkbox" name="doc" value="${d.id}" style="width:auto;min-height:0"> ${esc(d.title)} <span class="pill">${KIND_LABEL[d.kind]} v${d.version}</span></label>`).join('')}</div>` : ''}
      <div class="dropzone" id="dz">Drop a CV or cover letter here, or <u>browse</u> (PDF, DOCX, TXT)<input type="file" id="file" multiple accept=".pdf,.docx,.txt,.md" hidden></div>
      <div id="newFiles" class="small"></div>
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="3" placeholder="Referral, recruiter name, anything worth remembering"></textarea></div>
    <div class="row"><button class="btn primary">Save application</button><a class="btn" href="#/">Cancel</a></div>
  </form>`;
  const f = main.querySelector('#f');
  const pending = [];
  const fill = (j) => { for (const k of ['company', 'role', 'location', 'salary', 'source', 'jd_text']) if (j[k] && !f[k].value) f[k].value = j[k]; checkDupe(); };
  const doFetch = guard(async () => {
    if (!f.url.value) return toast('Paste a URL first');
    const b = main.querySelector('#fetch'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { fill(await api('/api/extract-job', { method: 'POST', body: { url: f.url.value } })); toast('Details fetched'); }
    finally { b.disabled = false; b.textContent = 'Fetch details'; }
  });
  main.querySelector('#fetch').onclick = doFetch;
  if (p.get('url')) doFetch();
  let blocking = null, forceNew = false;
  async function checkDupe() {
    if (!f.company.value && !f.url.value) return;
    const d = await api(`/api/duplicates?company=${encodeURIComponent(f.company.value)}&role=${encodeURIComponent(f.role.value)}&url=${encodeURIComponent(f.url.value)}`);
    const box = main.querySelector('#dupe');
    blocking = forceNew ? null : d.find((x) => x.reason !== 'same_company') || null;
    if (blocking) {
      box.innerHTML = `<div class="banner dupe"><div class="row" style="gap:12px;flex-wrap:nowrap">${avatar(blocking, 40)}<div style="flex:1"><strong>${blocking.reason === 'same_job' ? 'You\'re already tracking this job.' : 'This looks like a duplicate.'}</strong>
        <div class="small">${esc(blocking.role)} @ ${esc(blocking.company)} · ${blocking.status} · added ${fmtDate(blocking.created_at)}</div></div></div>
        <div class="row" style="margin-top:10px"><a class="btn primary sm" href="#/app/${blocking.id}">Open existing</a>${blocking.reason === 'same_role' ? '<button type="button" class="btn sm" id="diff">It\'s a different role. Save anyway</button>' : ''}</div></div>`;
      const diff = box.querySelector('#diff'); if (diff) diff.onclick = () => { forceNew = true; checkDupe(); };
    } else {
      const prior = d.filter((x) => x.reason === 'same_company');
      box.innerHTML = prior.length ? `<div class="banner warn"><strong>Heads up:</strong> you've applied to ${esc(prior[0].company)} before: ${prior.map((x) => `<a href="#/app/${x.id}">${esc(x.role)} (${x.status})</a>`).join(', ')}</div>` : '';
    }
  }
  f.company.onchange = checkDupe; f.role.onchange = checkDupe; f.url.onchange = checkDupe;
  setupDropzone(main.querySelector('#dz'), main.querySelector('#file'), (files) => {
    pending.push(...files);
    main.querySelector('#newFiles').innerHTML = pending.map((x) => `<div>📎 ${esc(x.name)}</div>`).join('');
  });
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(['company', 'role', 'url', 'location', 'salary', 'source', 'status', 'jd_text', 'notes'].map((k) => [k, f[k].value]));
    body.doc_ids = [...f.querySelectorAll('input[name=doc]:checked')].map((c) => +c.value);
    await checkDupe();
    if (blocking) { main.querySelector('#dupe').scrollIntoView({ behavior: 'smooth', block: 'center' }); return toast('Already tracked. Open the existing application instead.'); }
    body.force_new = forceNew;
    let a;
    try { a = await api('/api/applications', { method: 'POST', body }); }
    catch (err) { if (err.queued) { toast(err.message, 4000); location.hash = '#/'; return; } throw err; }
    for (const file of pending) { const fd = new FormData(); fd.append('file', file); fd.append('app_id', a.id); await api('/api/documents', { method: 'POST', body: fd }); }
    toast(a.existing ? 'You were already tracking this one, so here it is' : 'Application saved');
    location.hash = `#/app/${a.id}`;
  });
}

function setupDropzone(dz, input, onFiles) {
  dz.onclick = () => input.click();
  input.onchange = () => { onFiles([...input.files]); input.value = ''; };
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); onFiles([...e.dataTransfer.files]); };
}

function latestVersions(docs) {
  const byRoot = new Map();
  for (const d of docs) { const r = d.parent_id || d.id; const cur = byRoot.get(r); if (!cur || d.version > cur.version) byRoot.set(r, { ...d, versions: (cur?.versions || 0) + 1 }); else cur.versions++; }
  return [...byRoot.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ---------- application detail ----------
async function viewApp(id) {
  const a = await api(`/api/applications/${id}`);
  const main = layout('board');
  const isOut = ['rejected', 'ghosted'].includes(a.status);
  main.innerHTML = `
  <div class="topbar"><a href="#/" class="btn ghost sm">← Back</a></div>
  <div class="topbar" style="align-items:flex-start">
    ${avatar(a, 56)}<div style="flex:1;min-width:200px"><h1>${esc(a.role || 'Untitled role')}</h1><div class="muted">${esc(a.company)}${a.location ? ' · ' + esc(a.location) : ''}${a.salary ? ' · ' + esc(a.salary) : ''}</div></div>
    <select class="status-select" id="status" style="color:var(--s-${a.status})">${statusOptions(a.status)}</select>
    ${a.url ? `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${I.ext} Posting</a>` : ''}
  </div>
  <div class="detail">
    <div>
      ${/Added automatically/.test(a.notes || '') ? (a.documents.length
        ? `<div class="banner small"><b>Added from your email.</b> ${esc((a.notes.match(/CV attached automatically: (.+)/) || [])[1] || 'A CV was attached automatically.')}</div>`
        : `<div class="banner warn"><b>Added from your email.</b> Which CV did you send? Attach it so reviews and stats are accurate.</div>`) : ''}
      <div class="card"><h2>Documents sent</h2>
        <div id="docs">${a.documents.length ? a.documents.map((d) => `<div class="doc-row"><div class="doc-icon">${d.kind === 'cover_letter' ? 'CL' : d.kind === 'cv' ? 'CV' : 'DOC'}</div>
          <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(d.title)} <span class="pill">v${d.version}</span></div><div class="small muted">${KIND_LABEL[d.kind]} · ${fmtDate(d.created_at)}${d.chars ? '' : ' · <span style="color:var(--warn)">no readable text</span>'}</div></div>
          <a class="btn sm" href="#/doc/${d.id}?app=${a.id}">Edit</a>${d.path ? `<a class="btn sm ghost" href="/api/documents/${d.id}/file" target="_blank">Original</a>` : ''}<button class="btn sm ghost danger" data-detach="${d.id}" title="Detach">✕</button></div>`).join('') : '<p class="muted">No documents attached yet. Attach the exact CV and cover letter you send, so you can review them later.</p>'}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="attach">Attach from library</button><button class="btn sm" id="upload">Upload new</button><input type="file" id="upFile" hidden accept=".pdf,.docx,.txt,.md" multiple></div>
      </div>

      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Job description</h2><span class="spacer"></span><button class="btn sm" id="editJd">Edit</button></div>
        <div class="jd" id="jd">${a.jd_text ? esc(a.jd_text) : '<span class="muted">No job description saved. Paste it in so the reviews can compare your documents against it.</span>'}</div></div>

      <details class="card fold" ${isMobile() ? '' : 'open'}><summary><h2 style="margin:0">Details &amp; notes</h2></summary><div style="margin-top:12px">
        <form id="details"><div class="grid2">
          ${[['company', 'Company'], ['role', 'Role'], ['location', 'Location'], ['salary', 'Salary'], ['source', 'Source'], ['url', 'Posting URL'], ['contact_name', 'Recruiter / contact'], ['contact_email', 'Contact email'], ['referral', 'Referral']].map(([k, l]) => `<div class="field"><label>${l}</label><input name="${k}" value="${esc(a[k] || '')}"></div>`).join('')}
          <div class="field"><label>Applied on</label><input type="date" name="applied_at" value="${(a.applied_at || '').slice(0, 10)}"></div>
          <div class="field"><label>Follow up on</label><input type="date" name="follow_up_at" value="${(a.follow_up_at || '').slice(0, 10)}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" rows="4">${esc(a.notes)}</textarea></div>
        <div class="row"><button class="btn primary">Save details</button><span class="spacer"></span><button type="button" class="btn danger ghost" id="del">Delete application</button></div></form></div></details>

      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Application form answers</h2><span class="spacer"></span><button class="btn sm" id="addAns">Add</button></div>
        <div id="answers">${a.answers.length ? a.answers.map((x) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">${x.label ? `<span class="tag" style="margin-bottom:4px">${esc(x.label)}</span>` : ''}<div style="font-weight:600" class="small">${esc(x.question)}</div><div class="small" style="white-space:pre-wrap">${esc(x.answer)}</div><button class="btn sm ghost" data-review-ans="${x.id}">${I.spark} Review</button></div>`).join('') : '<p class="muted small">Key questions (visa sponsorship, right to work, time in the UK, clearance, why this company…) are saved here automatically by the extension, or you can add them manually.</p>'}</div></div>
    </div>

    <div>
      ${a.emails.length || ['rejected', 'ghosted'].includes(a.status) ? `<div class="card"><h2>${I.mail} Emails</h2>
        ${a.emails.length ? a.emails.map((e) => `<div class="mail-row ${e.seen ? '' : 'unseen'}" data-email="${e.id}"><div class="mail-main"><div class="row" style="gap:8px;flex-wrap:nowrap">${catChip(e.category)}<span class="spacer"></span><span class="small muted nowrap">${fmtDate(e.date)}</span></div>
          <div class="ellipsis" style="font-weight:600">${esc(e.subject)}</div><div class="small muted ellipsis">${esc(e.from_name || e.from_email)} · ${esc(e.snippet)}</div></div></div>`).join('') : '<p class="small muted">No emails linked yet.</p>'}
        ${['rejected', 'ghosted'].includes(a.status) ? `<a class="btn primary" style="width:100%;margin-top:10px" href="#/app/${a.id}/insight">${I.spark} Why might I have been rejected?</a>` : ''}</div>` : ''}
      <div class="card"><h2>${I.spark} AI review</h2>
        <div class="ai-actions">
          <button class="btn ${a.status === 'draft' ? 'primary' : ''}" data-ai="pre_submit">Pre-submit check</button>
          <button class="btn" data-ai="tailor">Tailor my CV</button>
          <button class="btn ${isOut ? 'primary' : ''}" data-ai="rejection">Why no offer?</button>
          <button class="btn ${a.status === 'interview' ? 'primary' : ''}" data-ai="interview_prep">Interview prep</button>
          <button class="btn" data-ai="fix" title="Rewrites your CV using the latest pre-submit review">Fix issues</button>
          <button class="btn" data-ai="cover_letter">Cover letter</button>
        </div>
        <p class="small muted" style="margin-bottom:0">Runs on your Claude Pro plan, with web research on the company. You can also copy the prompt into the Claude app.</p>
        ${a.reviews.length ? `<div style="margin-top:12px">${a.reviews.map((r) => `<div class="doc-row" style="cursor:pointer" data-review="${r.id}"><div style="flex:1"><div style="font-weight:600" class="small">${REVIEW_LABEL[r.type] || r.type}</div><div class="small muted">${fmtDate(r.created_at)} · ${r.engine === 'manual' ? 'pasted' : 'Claude'}</div></div>${r.status === 'running' ? '<span class="spin"></span>' : r.status === 'error' ? '<span class="pill" style="color:var(--danger)">error</span>' : '›'}</div>`).join('')}</div>` : ''}
      </div>

      <div class="card"><h2>Keyword match</h2><div id="match"><p class="muted small">${a.documents.length && a.jd_text ? 'Calculating…' : 'Attach a document and add the job description to see how well they match.'}</p></div></div>

      <div class="card"><h2>Timeline</h2><ul class="timeline">${a.history.map((x) => `<li>${pill(x.status)}<span class="muted">${fmtDate(x.at)}</span></li>`).join('')}</ul>
        ${a.status === 'applied' && daysAgo(a.status_updated_at) >= 14 ? `<p class="small" style="color:var(--warn)">No update in ${daysAgo(a.status_updated_at)} days. Time to follow up or mark it ghosted.</p>` : ''}</div>
    </div>
  </div>`;

  const reload = () => viewApp(id);
  main.querySelector('#status').onchange = guard(async (e) => {
    const s = e.target.value;
    await api(`/api/applications/${id}`, { method: 'PATCH', body: { status: s } });
    toast(`Status: ${s}`);
    await reload();
    if (s === 'interview') promptAI(a, 'interview_prep', 'Interview stage! Want Claude to prep you for it?');
    if (s === 'rejected' || s === 'ghosted') promptAI(a, 'rejection', 'Sorry about that. Want Claude to narrow down what might have cost you?');
  });
  main.querySelector('#details').onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.applied_at ||= null; body.follow_up_at ||= null;
    await api(`/api/applications/${id}`, { method: 'PATCH', body }); toast('Saved'); reload();
  });
  main.querySelector('#del').onclick = guard(async () => {
    if (!confirm('Delete this application and its reviews? Your documents stay in the library.')) return;
    await api(`/api/applications/${id}`, { method: 'DELETE' }); location.hash = '#/';
  });
  main.querySelector('#editJd').onclick = () => {
    const m = modal(`<div class="modal-head"><h2>Job description</h2></div><textarea id="jdT" rows="18">${esc(a.jd_text)}</textarea>
      <div class="row" style="margin-top:10px">${a.url ? '<button class="btn" id="refetch">Re-fetch from URL</button>' : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveJd">Save</button></div>`, 'wide');
    m.querySelector('#saveJd').onclick = guard(async () => { await api(`/api/applications/${id}`, { method: 'PATCH', body: { jd_text: m.querySelector('#jdT').value } }); m.close(); reload(); });
    const rf = m.querySelector('#refetch');
    if (rf) rf.onclick = guard(async () => { rf.innerHTML = '<span class="spin"></span>'; const j = await api('/api/extract-job', { method: 'POST', body: { url: a.url } }); m.querySelector('#jdT').value = j.jd_text; rf.textContent = 'Re-fetch from URL'; });
  };
  main.querySelectorAll('[data-detach]').forEach((b) => (b.onclick = guard(async () => { await api(`/api/applications/${id}/documents/${b.dataset.detach}`, { method: 'DELETE' }); reload(); })));
  main.querySelector('#attach').onclick = guard(async () => {
    const docs = latestVersions(await api('/api/documents'));
    const all = await api('/api/documents');
    const m = modal(`<div class="modal-head"><h2>Attach from library</h2></div>
      ${docs.length ? docs.map((d) => `<div class="doc-row"><div class="doc-icon">${d.kind === 'cover_letter' ? 'CL' : 'CV'}</div><div style="flex:1"><div style="font-weight:600">${esc(d.title)}</div>
        <select data-ver style="margin-top:4px;min-height:32px;padding:4px 8px">${all.filter((x) => (x.parent_id || x.id) === (d.parent_id || d.id)).sort((x, y) => y.version - x.version).map((x) => `<option value="${x.id}">v${x.version} · ${fmtDate(x.created_at)}</option>`).join('')}</select></div>
        <button class="btn sm primary" data-pick>Attach</button></div>`).join('') : '<p class="muted">Your library is empty. Upload a document instead.</p>'}
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn" data-close>Done</button></div>`);
    m.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = guard(async () => {
      const ver = b.closest('.doc-row').querySelector('[data-ver]').value;
      await api(`/api/applications/${id}/documents`, { method: 'POST', body: { doc_id: +ver } }); m.close(); reload();
    })));
  });
  const up = main.querySelector('#upFile');
  main.querySelector('#upload').onclick = () => up.click();
  up.onchange = guard(async () => {
    for (const file of up.files) { const fd = new FormData(); fd.append('file', file); fd.append('app_id', id); await api('/api/documents', { method: 'POST', body: fd }); }
    toast('Uploaded'); reload();
  });
  main.querySelector('#addAns').onclick = () => {
    const m = modal(`<div class="modal-head"><h2>Add form answer</h2></div><div class="field"><label>Question</label><input id="q"></div><div class="field"><label>Your answer</label><textarea id="ans" rows="8"></textarea></div>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="s">Save</button></div>`);
    m.querySelector('#s').onclick = guard(async () => { await api('/api/answers', { method: 'POST', body: { app_id: id, question: m.querySelector('#q').value, answer: m.querySelector('#ans').value } }); m.close(); reload(); });
  };
  main.querySelectorAll('[data-review-ans]').forEach((b) => (b.onclick = () => { const x = a.answers.find((y) => y.id === +b.dataset.reviewAns); aiModal({ type: 'answer', app_id: id, question: x.question, answer: x.answer }); }));
  main.querySelectorAll('[data-ai]').forEach((b) => (b.onclick = () => {
    const type = b.dataset.ai;
    if (type === 'rejection') { location.hash = `#/app/${id}/insight`; return; }
    if (type !== 'answer' && !a.documents.length) return toast('Attach your CV / cover letter first');
    if (type === 'tailor' || type === 'fix') return pickDoc(a, (doc_id) => aiModal({ type, app_id: id, doc_id }));
    aiModal({ type, app_id: id });
  }));
  main.querySelectorAll('[data-review]').forEach((el) => (el.onclick = () => showReview(+el.dataset.review, reload)));
  main.querySelectorAll('[data-email]').forEach((el) => (el.onclick = () => emailModal(+el.dataset.email, (x) => { if (x === 'seen') el.classList.remove('unseen'); else reload(); })));

  // keyword match
  if (a.documents.length && a.jd_text) {
    const cvs = a.documents;
    const box = main.querySelector('#match');
    const drawMatch = (docId) => drawMatchInner(docId).catch(() => { box.innerHTML = '<p class="small muted">Keyword match needs your laptop to be online.</p>'; });
    const drawMatchInner = (async (docId) => {
      const r = await api('/api/match', { method: 'POST', body: { app_id: id, doc_id: docId } });
      box.innerHTML = `${cvs.length > 1 ? `<select id="mdoc" style="margin-bottom:10px">${cvs.map((d) => `<option value="${d.id}" ${d.id === docId ? 'selected' : ''}>${esc(d.title)} v${d.version}</option>`).join('')}</select>` : ''}
        <div class="row"><span class="score" style="color:${r.score >= 70 ? 'var(--ok)' : r.score >= 45 ? 'var(--warn)' : 'var(--danger)'}">${r.score}%</span><span class="muted small">of the job description's key terms appear in this document</span></div>
        ${r.missing.length ? `<div class="small" style="margin-top:8px;font-weight:600">Missing</div><div>${r.missing.map((k) => `<span class="kw miss">${esc(k.term)}</span>`).join('')}</div>` : ''}
        ${r.matched.length ? `<div class="small" style="margin-top:8px;font-weight:600">Matched</div><div>${r.matched.slice(0, 18).map((k) => `<span class="kw hit">${esc(k.term)}</span>`).join('')}</div>` : ''}
        <p class="small muted" style="margin-bottom:0">Only add a missing term if you genuinely have that experience.</p>`;
      const sel = box.querySelector('#mdoc'); if (sel) sel.onchange = () => drawMatch(+sel.value);
    });
    drawMatch((cvs.find((d) => d.kind === 'cv') || cvs[0]).id);
  }
  // keep polling if a review is running
  if (a.reviews.some((r) => r.status === 'running')) setTimeout(() => { if (location.hash.startsWith(`#/app/${id}`) && !document.querySelector('.modal-bg')) reload(); }, 5000);
}

function pickDoc(a, cb) {
  const docs = a.documents;
  if (docs.length === 1) return cb(docs[0].id);
  const m = modal(`<div class="modal-head"><h2>Which document?</h2></div>${docs.map((d) => `<button class="btn" style="width:100%;margin-bottom:8px;justify-content:flex-start" data-d="${d.id}">${esc(d.title)} · ${KIND_LABEL[d.kind]} v${d.version}</button>`).join('')}`);
  m.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { m.close(); cb(+b.dataset.d); }));
}

// ---------- AI modal ----------
function aiModal(ctx) {
  const m = modal(`<div class="modal-head"><h2>${I.spark} ${REVIEW_LABEL[ctx.type]}</h2><span class="spacer"></span><button class="btn ghost sm" data-close>✕</button></div>
    <div id="aiBody">
      <p class="muted">Claude reads your documents and the job description${ctx.type === 'answer' ? '' : ', researches the company on the web,'} and writes up its findings. It usually takes 30–90 seconds.</p>
      <div class="row"><button class="btn primary" id="run">${I.spark} Run with Claude</button><button class="btn" id="cp">Copy prompt for the Claude app</button></div>
      <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">Already ran it in the Claude app? Paste the result here</summary>
        <textarea id="paste" rows="8" style="margin-top:8px" placeholder="Paste Claude's response"></textarea><button class="btn sm" id="savePaste" style="margin-top:8px">Save result</button></details>
    </div>`, 'wide');
  const body = m.querySelector('#aiBody');
  m.querySelector('#cp').onclick = guard(async () => {
    const { prompt } = await api('/api/ai/prompt', { method: 'POST', body: ctx });
    await copy(prompt);
    toast('Prompt copied. Paste it into Claude (turn on web search), then paste the reply back here.', 5000);
  });
  m.querySelector('#savePaste').onclick = guard(async () => {
    const result = m.querySelector('#paste').value.trim(); if (!result) return;
    const r = await api('/api/reviews', { method: 'POST', body: { ...ctx, result } });
    m.close(); showReview(r.id, () => route());
  });
  m.querySelector('#run').onclick = guard(async () => {
    const r = await api('/api/ai/run', { method: 'POST', body: ctx });
    body.innerHTML = `<div class="row"><span class="spin"></span><strong>Claude is working…</strong></div><p class="muted small">You can close this. The result is saved to the application when it's done.</p>`;
    const t0 = Date.now();
    const poll = async () => {
      if (!document.body.contains(m)) return;
      const rv = await api(`/api/reviews/${r.id}`);
      if (rv.status === 'running') { body.querySelector('.small').textContent = `Working for ${Math.round((Date.now() - t0) / 1000)}s… You can close this; the result is saved to the application.`; return setTimeout(poll, 3000); }
      renderReviewInto(body, rv, () => { m.close(); route(); });
    };
    setTimeout(poll, 2500);
  });
}

async function showReview(id, onChange) {
  const rv = await api(`/api/reviews/${id}`);
  const m = modal(`<div class="modal-head"><h2>${REVIEW_LABEL[rv.type] || rv.type}</h2><span class="spacer"></span><button class="btn ghost sm" data-close>✕</button></div><div id="rb"></div>`, 'wide');
  renderReviewInto(m.querySelector('#rb'), rv, () => { m.close(); onChange?.(); });
}

function renderReviewInto(el, rv, done) {
  if (rv.status === 'running') { el.innerHTML = '<div class="row"><span class="spin"></span> Still running…</div>'; return; }
  const [notes, tailored] = rv.result.includes('=====TAILORED=====') ? rv.result.split('=====TAILORED=====') : [rv.result, null];
  el.innerHTML = `${rv.status === 'error' ? `<div class="banner warn md">${md(rv.result)}</div>` : `<div class="md">${md(notes)}</div>`}
    ${tailored ? `<h3 style="margin-top:16px">Tailored document</h3><div class="paper md" style="min-height:0;max-height:50vh;overflow:auto">${md(tailored)}</div>` : ''}
    <div class="row" style="margin-top:14px">
      ${tailored ? `<button class="btn primary" id="saveTail">${rv.type === 'cover_letter' ? 'Save cover letter &amp; edit' : 'Save as new version &amp; edit'}</button>` : ''}
      <button class="btn" id="cpR">Copy</button><span class="spacer"></span><button class="btn danger ghost" id="delR">Delete</button></div>`;
  el.querySelector('#cpR').onclick = () => copy(tailored ? tailored.trim() : rv.result);
  el.querySelector('#delR').onclick = guard(async () => { await api(`/api/reviews/${rv.id}`, { method: 'DELETE' }); done(); });
  const st = el.querySelector('#saveTail');
  if (st) st.onclick = guard(async () => {
    let nd;
    if (rv.type === 'cover_letter' || !rv.doc_id) {
      const app = rv.app_id ? await api(`/api/applications/${rv.app_id}`) : null;
      nd = await api('/api/documents', { method: 'POST', body: { kind: rv.type === 'cover_letter' ? 'cover_letter' : 'cv', title: `${rv.type === 'cover_letter' ? 'Cover letter' : 'CV'}: ${app?.company || 'draft'}`, text: tailored.trim(), app_id: rv.app_id || '' } });
      toast('Saved and attached to this application');
    } else {
      nd = await api(`/api/documents/${rv.doc_id}/versions`, { method: 'POST', body: { text: tailored.trim(), app_id: rv.app_id } });
      toast(`Saved as v${nd.version} and attached to this application`);
    }
    location.hash = `#/doc/${nd.id}${rv.app_id ? '?app=' + rv.app_id : ''}`;
  });
}

// Group rows under the application they belong to (newest application first)
function groupByApp(rows, appsOf) {
  const groups = new Map(), loose = [];
  for (const r of rows) {
    const apps = appsOf(r);
    if (!apps.length) { loose.push(r); continue; }
    for (const a of apps) { if (!groups.has(a.id)) groups.set(a.id, { app: a, items: [] }); groups.get(a.id).items.push(r); }
  }
  const sorted = [...groups.values()].sort((x, y) => (y.app.applied_at || y.app.created_at || '').localeCompare(x.app.applied_at || x.app.created_at || ''));
  return { sorted, loose };
}
const appHeader = (a, extra = '') => `<div class="group-head" style="--c:var(--s-${a.status})">${avatar(a, 40)}
  <a href="#/app/${a.id}" class="group-title"><b>${esc(a.company || 'Unknown company')}</b><span>${esc(a.role || '')}</span></a>${pill(a.status)}${extra}</div>`;
const docIcon = (d) => `<div class="doc-icon ${d.kind}">${d.kind === 'cover_letter' ? 'CL' : d.kind === 'cv' ? 'CV' : 'DOC'}</div>`;

// ---------- documents ----------
async function viewDocs() {
  const docs = await api('/api/documents');
  const main = layout('docs');
  let mode = localStorage.getItem('jt_docs_mode') || 'apps';
  main.innerHTML = `<div class="topbar"><h1>Documents</h1><span class="spacer"></span><button class="btn" id="paste">Paste from Claude</button><button class="btn primary" id="blank">${I.plus} New blank</button></div>
    <div class="card" style="margin-bottom:16px"><div class="row" style="margin-bottom:10px"><label style="margin:0">Upload as</label><select id="kind" style="width:auto"><option value="">Auto-detect</option><option value="cv">CV</option><option value="cover_letter">Cover letter</option><option value="other">Other</option></select></div>
      <div class="dropzone" id="dz">Drop CVs or cover letters here, or <u>browse</u> (PDF, DOCX, TXT)<input type="file" id="file" multiple accept=".pdf,.docx,.txt,.md" hidden></div></div>
    <div class="status-tabs"><button class="stab ${mode === 'apps' ? 'active' : ''}" data-m="apps">By application</button><button class="stab ${mode === 'library' ? 'active' : ''}" data-m="library">All documents</button></div>
    <div id="list"></div>`;

  const docRow = (d, appId) => `<div class="doc-row">${docIcon(d)}
      <a href="#/doc/${d.id}${appId ? '?app=' + appId : ''}" style="flex:1;min-width:0;color:var(--text)"><div style="font-weight:600">${esc(d.title)} <span class="pill">v${d.version}</span></div>
      <div class="small muted">${KIND_LABEL[d.kind]} · ${fmtDate(d.created_at)}${!appId && d.apps.length ? ` · sent to ${d.apps.map((a) => esc(a.company)).join(', ')}` : ''}</div></a>
      ${d.mime ? `<a class="btn sm ghost" href="/api/documents/${d.id}/file" target="_blank">Original</a>` : ''}<a class="btn sm" href="#/doc/${d.id}${appId ? '?app=' + appId : ''}">Open</a></div>`;

  function draw() {
    const list = main.querySelector('#list');
    if (!docs.length) { list.innerHTML = '<div class="card empty">No documents yet. Upload your CV to get started.</div>'; return; }
    if (mode === 'library') {
      list.innerHTML = `<div class="card">${latestVersions(docs).map((d) => docRow({ ...d, apps: docs.filter((x) => (x.parent_id || x.id) === (d.parent_id || d.id)).flatMap((x) => x.apps) })).join('')}</div>`;
      return;
    }
    const { sorted, loose } = groupByApp(docs, (d) => d.apps);
    const unusedLatest = latestVersions(loose).filter((d) => !docs.some((x) => (x.parent_id || x.id) === (d.parent_id || d.id) && x.apps.length));
    list.innerHTML = sorted.map(({ app, items }) => `<div class="card group">${appHeader(app)}
        ${items.sort((a, b) => (a.kind === 'cv' ? -1 : 1) - (b.kind === 'cv' ? -1 : 1)).map((d) => docRow(d, app.id)).join('')}</div>`).join('')
      + (unusedLatest.length ? `<div class="card group"><div class="group-head" style="--c:var(--muted)"><span class="avatar" style="width:40px;height:40px;background:var(--surface-2);color:var(--muted)">${I.doc}</span>
          <div class="group-title"><b>Not used in an application yet</b><span>Your master CVs and drafts</span></div></div>${unusedLatest.map((d) => docRow(d)).join('')}</div>` : '');
  }
  main.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { mode = b.dataset.m; localStorage.setItem('jt_docs_mode', mode); main.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('active', x === b)); draw(); }));
  draw();

  setupDropzone(main.querySelector('#dz'), main.querySelector('#file'), guard(async (files) => {
    for (const file of files) { const fd = new FormData(); fd.append('file', file); if (main.querySelector('#kind').value) fd.append('kind', main.querySelector('#kind').value); await api('/api/documents', { method: 'POST', body: fd }); }
    toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`); viewDocs();
  }));
  const newDoc = async (pasted) => {
    const apps = await api('/api/applications');
    const m = modal(`<div class="modal-head"><h2>${pasted ? 'Paste a document from Claude' : 'New document'}</h2></div>
      <div class="grid2"><div class="field"><label>Title</label><input id="t" placeholder="e.g. CV: SOC Analyst"></div><div class="field"><label>Type</label><select id="k"><option value="cv">CV</option><option value="cover_letter">Cover letter</option><option value="other">Other</option></select></div></div>
      <div class="field"><label>Attach to application (optional)</label><select id="ap"><option value="">None, keep in library</option>${apps.map((a) => `<option value="${a.id}">${esc(a.company)}: ${esc(a.role)}</option>`).join('')}</select></div>
      ${pasted ? '<div class="field"><label>Content (Markdown works: # Name, ## Section, - bullet)</label><textarea id="x" rows="12"></textarea></div>' : ''}
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="c">Create</button></div>`);
    m.querySelector('#c').onclick = guard(async () => {
      const ap = m.querySelector('#ap').value;
      const d = await api('/api/documents', { method: 'POST', body: { title: m.querySelector('#t').value || 'Untitled', kind: m.querySelector('#k').value, app_id: ap, text: m.querySelector('#x')?.value || '# Your Name\nemail · phone · location · linkedin\n\n## Summary\n\n## Experience\n\n## Skills\n\n## Education\n' } });
      location.hash = `#/doc/${d.id}${ap ? '?app=' + ap : ''}`;
    });
  };
  main.querySelector('#blank').onclick = () => newDoc(false);
  main.querySelector('#paste').onclick = () => newDoc(true);
}

async function viewEditor(id) {
  const [d, apps] = await Promise.all([api(`/api/documents/${id}`), api('/api/applications')]);
  const appId = +query().get('app') || d.applications[0]?.id || '';
  const main = layout('docs');
  main.innerHTML = `<div class="topbar"><a href="${appId && query().get('app') ? `#/app/${appId}` : '#/docs'}" class="btn ghost sm">← Back</a>
    <input id="title" value="${esc(d.title)}" style="flex:1;min-width:180px;font-weight:600;font-size:1.05rem">
    <select id="ver" style="width:auto">${d.versions.map((v) => `<option value="${v.id}" ${v.id === d.id ? 'selected' : ''}>v${v.version} · ${fmtDate(v.created_at)}</option>`).join('')}</select></div>
    <div class="row" style="margin-bottom:12px">
      <button class="btn primary" id="save">Save as v${Math.max(...d.versions.map((v) => v.version)) + 1}</button>
      <a class="btn" href="/api/documents/${d.id}/export.docx">Export DOCX</a>
      <button class="btn" id="pdf">Print / PDF</button>
      ${d.path ? `<a class="btn" href="/api/documents/${d.id}/file" target="_blank">Original file</a>` : ''}
      <button class="btn" id="togglePrev" style="display:${isMobile() ? '' : 'none'}">Preview</button>
      <span class="spacer"></span>
      <select id="app" style="width:auto;max-width:260px"><option value="">Compare with application…</option>${apps.map((a) => `<option value="${a.id}" ${a.id === appId ? 'selected' : ''}>${esc(a.role)} @ ${esc(a.company)}</option>`).join('')}</select>
      <button class="btn" id="review">${I.spark} Review</button>
    </div>
    ${!d.text && d.path ? '<div class="banner warn">No text could be read from this file (it may be a scanned image). Paste the text below to edit and review it.</div>' : ''}
    ${d.applications.length ? `<p class="small muted">This exact version was sent to: ${d.applications.map((a) => `<a href="#/app/${a.id}">${esc(a.company)}</a>`).join(', ')}. Saving creates a new version, so that record stays intact.</p>` : ''}
    <div id="matchBar" class="small" style="margin-bottom:10px"></div>
    <div class="editor" id="ed"><textarea id="text" spellcheck="true">${esc(d.text)}</textarea><div class="paper md" id="prev"></div></div>`;
  const ta = main.querySelector('#text'), prev = main.querySelector('#prev'), sel = main.querySelector('#app');
  let dirty = false, mt;
  const render = () => { prev.innerHTML = md(ta.value); };
  const matchNow = async () => {
    if (!sel.value) { main.querySelector('#matchBar').innerHTML = ''; return; }
    const r = await api('/api/match', { method: 'POST', body: { app_id: +sel.value, text: ta.value } });
    main.querySelector('#matchBar').innerHTML = `Keyword match: <strong style="color:${r.score >= 70 ? 'var(--ok)' : r.score >= 45 ? 'var(--warn)' : 'var(--danger)'}">${r.score}%</strong> ${r.missing.length ? '· missing: ' + r.missing.slice(0, 10).map((k) => `<span class="kw miss">${esc(k.term)}</span>`).join('') : ''}`;
  };
  ta.oninput = () => { dirty = true; render(); clearTimeout(mt); mt = setTimeout(matchNow, 600); };
  sel.onchange = matchNow;
  render(); matchNow();
  window.onbeforeunload = () => (dirty ? true : undefined);
  main.querySelector('#ver').onchange = (e) => { location.hash = `#/doc/${e.target.value}${query().get('app') ? '?app=' + query().get('app') : ''}`; };
  main.querySelector('#title').onchange = guard(async (e) => { await api(`/api/documents/${d.id}`, { method: 'PATCH', body: { title: e.target.value } }); toast('Renamed'); });
  main.querySelector('#save').onclick = guard(async () => {
    const swap = query().get('app') && d.applications.some((a) => a.id === +query().get('app'));
    const nd = await api(`/api/documents/${d.id}/versions`, { method: 'POST', body: { text: ta.value, title: main.querySelector('#title').value, app_id: swap ? +query().get('app') : undefined } });
    dirty = false; window.onbeforeunload = null;
    toast(`Saved v${nd.version}${swap ? ' and attached to the application' : ''}`);
    location.hash = `#/doc/${nd.id}${query().get('app') ? '?app=' + query().get('app') : ''}`;
  });
  main.querySelector('#pdf').onclick = () => { main.querySelector('#ed').classList.add('show-preview'); setTimeout(() => { window.print(); main.querySelector('#ed').classList.remove('show-preview'); }, 50); };
  main.querySelector('#togglePrev').onclick = (e) => { const ed = main.querySelector('#ed'); ed.classList.toggle('show-preview'); e.target.textContent = ed.classList.contains('show-preview') ? 'Edit' : 'Preview'; };
  main.querySelector('#review').onclick = guard(async () => {
    if (!sel.value) return toast('Pick the application to review against');
    if (dirty) return toast('Save your changes first, so Claude reviews the latest version');
    const app = await api(`/api/applications/${sel.value}`);
    if (!app.documents.some((x) => x.id === d.id)) await api(`/api/applications/${sel.value}/documents`, { method: 'POST', body: { doc_id: d.id } });
    aiModal({ type: 'pre_submit', app_id: +sel.value, doc_id: d.id });
  });
}

// ---------- answers (grouped by application) ----------
async function viewAnswers() {
  const rows = await api('/api/answers');
  const main = layout('answers');
  main.innerHTML = `<div class="topbar"><h1>Answers</h1><span class="spacer"></span><input id="s" placeholder="Search questions or answers" style="width:240px;min-height:38px"><button class="btn primary" id="add">${I.plus} Add</button></div>
    <p class="muted">What you told each company, grouped by application. Reusable answers live in your answer bank, and the extension suggests them when it sees a similar question.</p><div id="list"></div>`;
  const find = (id) => rows.find((r) => r.id === +id);
  const qa = (r) => `<div class="qa-item">
      <div class="row" style="gap:6px">${r.label ? `<span class="tag doc">${esc(r.label)}</span>` : ''}<strong style="flex:1;min-width:0">${esc(r.question)}</strong></div>
      <div class="qa-answer">${esc(r.answer)}</div>
      <div class="row qa-actions"><button class="btn sm ghost" data-copy="${r.id}">Copy</button><button class="btn sm ghost" data-edit="${r.id}">Edit</button>
        ${r.app_id ? `<button class="btn sm ghost" data-bank="${r.id}">Save to bank</button>` : ''}<button class="btn sm ghost" data-rev="${r.id}">${I.spark} Review</button>
        <span class="spacer"></span><button class="btn sm ghost danger" data-del="${r.id}">Delete</button></div></div>`;

  function draw(q = '') {
    const shown = rows.filter((r) => !q || `${r.question} ${r.answer} ${r.company || ''}`.toLowerCase().includes(q));
    const { sorted, loose } = groupByApp(shown, (r) => (r.app_id ? [{ id: r.app_id, company: r.company, role: r.role, status: r.status, logo_url: r.logo_url, applied_at: r.applied_at }] : []));
    main.querySelector('#list').innerHTML = (sorted.length || loose.length) ? [
      ...sorted.map(({ app, items }) => `<details class="card group" open><summary>${appHeader(app, `<span class="muted small">${items.length} answer${items.length > 1 ? 's' : ''}</span>`)}</summary>${items.map(qa).join('')}</details>`),
      loose.length ? `<details class="card group" open><summary><div class="group-head" style="--c:var(--primary)"><span class="avatar" style="width:40px;height:40px;background:var(--grad)">${I.chat}</span>
        <div class="group-title"><b>Answer bank</b><span>Reusable answers for any application</span></div><span class="muted small">${loose.length}</span></div></summary>${loose.map(qa).join('')}</details>` : '',
    ].join('') : '<div class="card empty">No saved answers yet. They appear here when you submit an application with the extension, or add them yourself.</div>';
    main.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(find(b.dataset.copy).answer)));
    main.querySelectorAll('[data-rev]').forEach((b) => (b.onclick = () => { const r = find(b.dataset.rev); aiModal({ type: 'answer', app_id: r.app_id, question: r.question, answer: r.answer }); }));
    main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = guard(async () => { if (!confirm('Delete this answer?')) return; await api(`/api/answers/${b.dataset.del}`, { method: 'DELETE' }); viewAnswers(); })));
    main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => edit(find(b.dataset.edit))));
    main.querySelectorAll('[data-bank]').forEach((b) => (b.onclick = guard(async () => { const r = find(b.dataset.bank); await api('/api/answers', { method: 'POST', body: { question: r.question, answer: r.answer } }); toast('Saved to your answer bank'); viewAnswers(); })));
  }
  const edit = (r) => {
    const m = modal(`<div class="modal-head"><h2>${r ? 'Edit' : 'Add to answer bank'}</h2></div><div class="field"><label>Question</label><input id="q" value="${esc(r?.question || '')}"></div><div class="field"><label>Answer</label><textarea id="a" rows="10">${esc(r?.answer || '')}</textarea></div>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Save</button></div>`);
    m.querySelector('#sv').onclick = guard(async () => {
      const body = { question: m.querySelector('#q').value, answer: m.querySelector('#a').value };
      if (r) await api(`/api/answers/${r.id}`, { method: 'PATCH', body }); else await api('/api/answers', { method: 'POST', body });
      m.close(); viewAnswers();
    });
  };
  main.querySelector('#add').onclick = () => edit(null);
  main.querySelector('#s').oninput = (e) => draw(e.target.value.toLowerCase());
  draw();
}

// ---------- email ----------
const CAT = {
  rejection: { label: 'Rejection', color: 'var(--s-rejected)', icon: '✕' }, interview: { label: 'Interview', color: 'var(--s-interview)', icon: '📅' },
  assessment: { label: 'Assessment', color: 'var(--s-screening)', icon: '📝' }, offer: { label: 'Offer', color: 'var(--s-offer)', icon: '🎉' },
  received: { label: 'Received', color: 'var(--s-applied)', icon: '✓' }, viewed: { label: 'Viewed', color: 'var(--s-draft)', icon: '👁' },
  other: { label: 'Other', color: 'var(--muted)', icon: '✉️' },
};
const catChip = (c) => `<span class="cat" style="--c:${(CAT[c] || CAT.other).color}">${(CAT[c] || CAT.other).icon} ${(CAT[c] || CAT.other).label}</span>`;
const fmtDateTime = (s) => new Date(s).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeAgo = (s) => { const m = Math.round((Date.now() - new Date(s)) / 6e4); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

async function emailModal(id, onChange) {
  const [e, apps] = await Promise.all([api(`/api/emails/${id}`), api('/api/applications')]);
  const m = modal(`<div class="modal-head">${catChip(e.category)}<span class="spacer"></span><button class="btn ghost sm" data-close>✕</button></div>
    <h2 style="margin:4px 0 10px">${esc(e.subject)}</h2>
    <div class="email-meta"><div class="email-from"><span class="avatar" style="width:38px;height:38px;background:var(--grad);font-size:.85rem">${esc((e.from_name || e.from_email || '?')[0].toUpperCase())}</span>
      <div><b>${esc(e.from_name || e.from_email)}</b><div class="small muted">${esc(e.from_email)}</div></div></div>
      <div class="small muted" style="text-align:right">${fmtDateTime(e.date)}<br>${timeAgo(e.date)}</div></div>
    ${e.applied_status ? `<div class="banner" style="margin:12px 0 0">This email moved <b>${esc(e.company)}</b> to ${pill(e.applied_status)}</div>` : ''}
    <div class="email-body">${esc(e.body || e.snippet)}</div>
    <div class="email-fix">
      <div class="field"><label>Application</label><select id="eApp"><option value="">Not linked</option>${apps.map((a) => `<option value="${a.id}" ${a.id === e.app_id ? 'selected' : ''}>${esc(a.company)}: ${esc(a.role)}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><select id="eCat">${Object.keys(CAT).map((c) => `<option value="${c}" ${c === e.category ? 'selected' : ''}>${CAT[c].label}</option>`).join('')}</select></div>
    </div>
    <div class="row" style="margin-top:4px">
      ${e.app_id ? `<a class="btn" href="#/app/${e.app_id}">Open application</a>` : '<button class="btn primary" id="eCreate">Create application from this email</button>'}
      ${e.app_id && e.category === 'rejection' ? `<a class="btn primary" href="#/app/${e.app_id}/insight">${I.spark} Why was I rejected?</a>` : ''}
      ${e.app_id && ['interview', 'assessment'].includes(e.category) ? `<button class="btn primary" id="ePrep">${I.spark} Interview prep</button>` : ''}
      <span class="spacer"></span><button class="btn" id="eSave">Save changes</button></div>`, 'wide');
  m.querySelector('#eSave').onclick = guard(async () => {
    const r = await api(`/api/emails/${id}`, { method: 'PATCH', body: { app_id: +m.querySelector('#eApp').value || null, category: m.querySelector('#eCat').value } });
    toast(r.moved ? `Saved. Application moved to ${r.moved}` : 'Saved'); m.close(); onChange?.();
  });
  const cr = m.querySelector('#eCreate');
  if (cr) cr.onclick = () => {
    const guessCo = (e.from_name || '').replace(/\b(careers|recruit\w*|talent|hiring|team|hr|jobs|via .*|no-?reply)\b/gi, '').trim() || (e.from_email.split('@')[1] || '').split('.')[0];
    const c = modal(`<div class="modal-head"><h2>New application from email</h2></div>
      <div class="field"><label>Company</label><input id="cCo" value="${esc(guessCo)}"></div><div class="field"><label>Role</label><input id="cRole" placeholder="From the email subject or body"></div>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="cGo">Create</button></div>`);
    c.querySelector('#cGo').onclick = guard(async () => {
      const a = await api(`/api/emails/${id}/create-app`, { method: 'POST', body: { company: c.querySelector('#cCo').value, role: c.querySelector('#cRole').value } });
      c.close(); m.close(); toast('Application created'); location.hash = `#/app/${a.id}`;
    });
  };
  const pr = m.querySelector('#ePrep'); if (pr) pr.onclick = () => { m.close(); aiModal({ type: 'interview_prep', app_id: e.app_id }); };
  onChange?.('seen');
}

async function viewInbox() {
  const st = await api('/api/mail/status');
  const main = layout('inbox');
  if (!st.connected && !st.counts.total) {
    main.innerHTML = `<div class="hero"><div><h1>Inbox</h1><p>Replies from employers, matched to your applications automatically.</p></div></div>
      <div class="card empty"><h2>Connect your Gmail</h2><p>JobTrack reads job-related emails (read-only), links each one to its application and updates the status when you get a rejection, interview or offer.</p>
      <a class="btn primary" href="#/profile?tab=email">Connect email</a></div>`;
    return;
  }
  let filter = query().get('f') || 'all';
  main.innerHTML = `<div class="hero"><div><h1>Inbox</h1><p>${st.connected ? `${esc(st.user)} · last checked ${st.last_sync ? timeAgo(st.last_sync) : 'never'} · checks every 15 minutes` : 'Email disconnected. Showing saved emails.'}</p></div>
      ${st.connected ? '<button class="btn primary" id="syncNow">↻ Check now</button>' : '<a class="btn primary" href="#/profile?tab=email">Connect email</a>'}</div>
    ${st.last_error ? `<div class="banner warn">Last check failed: ${esc(st.last_error.replace(/^\S+\s/, ''))}</div>` : ''}
    <div class="status-tabs" id="ftabs"></div><div id="list"><div class="card"><span class="spin"></span></div></div>`;
  const FILTERS = [['all', 'All'], ['new', 'New'], ['unmatched', 'Needs linking'], ['interview', 'Interviews'], ['rejection', 'Rejections'], ['offer', 'Offers']];
  async function draw() {
    main.querySelector('#ftabs').innerHTML = FILTERS.map(([k, l]) => `<button class="stab ${k === filter ? 'active' : ''}" data-f="${k}">${l}${k === 'unmatched' && st.counts.unmatched ? `<span class="n">${st.counts.unmatched}</span>` : ''}${k === 'new' && st.counts.unseen ? `<span class="n">${st.counts.unseen}</span>` : ''}</button>`).join('');
    main.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    const rows = await api(`/api/emails?filter=${filter}`);
    main.querySelector('#list').innerHTML = rows.length ? `<div class="card" style="padding:6px 0">${rows.map((e) => `<div class="mail-row ${e.seen ? '' : 'unseen'}" data-id="${e.id}">
        ${e.app_id ? avatar({ company: e.company, logo_url: e.logo_url }, 38) : `<span class="avatar" style="width:38px;height:38px;background:var(--surface-2);color:var(--muted)">?</span>`}
        <div class="mail-main"><div class="row" style="gap:8px;flex-wrap:nowrap"><b class="ellipsis">${esc(e.app_id ? e.company : (e.from_name || e.from_email))}</b>${catChip(e.category)}<span class="spacer"></span><span class="small muted nowrap">${fmtDate(e.date)}</span></div>
          <div class="ellipsis">${esc(e.subject)}</div><div class="small muted ellipsis">${st.accounts.length > 1 && e.account ? `<span class="tag">${esc(e.account.split('@')[0])}</span> ` : ''}${e.app_id ? esc(e.role) + ' · ' : '<span style="color:var(--warn)">Not linked to an application</span> · '}${esc(e.snippet)}</div></div></div>`).join('')}</div>`
      : `<div class="card empty">${filter === 'unmatched' ? 'Every job email is linked to an application. 🎉' : 'No emails here yet.'}</div>`;
    main.querySelectorAll('.mail-row').forEach((r) => (r.onclick = () => emailModal(+r.dataset.id, (x) => { if (x !== 'seen') viewInbox(); else r.classList.remove('unseen'); })));
  }
  if (st.connected) main.querySelector('#syncNow').onclick = guard(async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.innerHTML = '<span class="spin"></span> Checking…';
    try { const r = await api('/api/mail/sync', { method: 'POST', body: {} }); const x = r.result;
      toast(x.saved ? `${x.saved} new job email${x.saved > 1 ? 's' : ''}${x.statusChanges.length ? `, ${x.statusChanges.length} status update${x.statusChanges.length > 1 ? 's' : ''}` : ''}` : 'No new job emails', 4000);
    } finally { viewInbox(); }
  });
  draw();
}

// Separate page: why might this rejection have happened?
async function viewInsight(id) {
  const a = await api(`/api/applications/${id}`);
  const main = layout('board');
  const rej = a.emails.find((e) => e.category === 'rejection');
  const review = a.reviews.find((r) => r.type === 'rejection' && r.status !== 'error');
  const applied = a.applied_at ? new Date(a.applied_at.replace(' ', 'T') + 'Z') : null;
  const turnaround = rej && applied ? Math.max(0, Math.round((new Date(rej.date) - applied) / 864e5)) : null;
  main.innerHTML = `<div class="topbar"><a href="#/app/${id}" class="btn ghost sm">← ${esc(a.company)}</a></div>
    <div class="hero insight-hero">${avatar(a, 56)}<div style="flex:1;min-width:200px"><h1>Why no offer?</h1><p>${esc(a.role)} @ ${esc(a.company)}. These are possible reasons, not certainties.</p></div></div>
    <div class="kpis">
      <div class="kpi"><div class="v">${a.applied_at ? fmtDate(a.applied_at) : '—'}</div><div class="l">Applied</div></div>
      <div class="kpi"><div class="v">${rej ? fmtDate(rej.date) : '—'}</div><div class="l">${a.status === 'ghosted' ? 'No reply' : 'Rejection received'}</div></div>
      <div class="kpi"><div class="v">${turnaround === null ? '—' : turnaround === 0 ? 'Same day' : turnaround + ' days'}</div><div class="l">Turnaround${turnaround !== null && turnaround <= 1 ? ' (fast replies are often automated)' : ''}</div></div>
      <div class="kpi"><div class="v">${a.documents.length}</div><div class="l">Documents sent</div></div>
    </div>
    <div class="detail">
      <div>
        <div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">${I.spark} Analysis</h2><span class="spacer"></span>${review ? `<span class="small muted">${fmtDate(review.created_at)}</span>` : ''}</div>
          <div id="analysis">${review ? '<span class="spin"></span>' : `<p class="muted">Claude compares your CV and cover letter with the job description, reads the rejection email, and researches the company (hiring freezes, layoffs, who they usually hire). It ranks the likely reasons, including ones that had nothing to do with you.</p>`}</div>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="run">${I.spark} ${review ? 'Run again' : 'Analyse this rejection'}</button><button class="btn" id="cp">Copy prompt for the Claude app</button></div></div>
      </div>
      <div>
        ${rej ? `<div class="card"><h2>The email</h2><div class="small muted">${esc(rej.from_name)} · ${fmtDateTime(rej.date)}</div><div style="font-weight:600;margin:6px 0">${esc(rej.subject)}</div>
          <div class="email-body" style="max-height:340px">${esc(rej.snippet)}…</div><button class="btn sm" id="openMail" style="margin-top:8px">Read full email</button></div>` : `<div class="card"><h2>No rejection email</h2><p class="small muted">${a.status === 'ghosted' ? 'They never replied. The analysis will weigh that.' : 'Connect your email in Profile → Email to see employer replies here.'}</p></div>`}
        <div class="card"><h2>Worth remembering</h2><ul class="small" style="padding-left:1.1em;margin:0">
          <li>Many roles get hundreds of applicants. A "no" is often about volume or timing, not you.</li>
          <li>Roles are sometimes filled internally, or closed before applications are read.</li>
          <li>Instant rejections usually come from automated screening (location, visa, keywords).</li></ul></div>
      </div>
    </div>`;
  const box = main.querySelector('#analysis');
  if (review) { const rv = await api(`/api/reviews/${review.id}`); box.innerHTML = rv.status === 'running' ? '<div class="row"><span class="spin"></span> Claude is working…</div>' : `<div class="md">${md(rv.result)}</div>`; if (rv.status === 'running') setTimeout(() => location.hash.endsWith('/insight') && viewInsight(id), 5000); }
  main.querySelector('#run').onclick = guard(async () => {
    if (!a.documents.length) return toast('Attach the CV you sent first, so Claude can compare it');
    await api('/api/ai/run', { method: 'POST', body: { type: 'rejection', app_id: id } });
    box.innerHTML = '<div class="row"><span class="spin"></span> Claude is working. This takes about a minute…</div>';
    setTimeout(() => viewInsight(id), 4000);
  });
  main.querySelector('#cp').onclick = guard(async () => { const { prompt } = await api('/api/ai/prompt', { method: 'POST', body: { type: 'rejection', app_id: id } }); copy(prompt); });
  const om = main.querySelector('#openMail'); if (om) om.onclick = () => emailModal(rej.id);
}

// ---------- insights ----------
async function viewInsights() {
  const [s, reviews] = await Promise.all([api('/api/stats'), api('/api/reviews')]);
  const main = layout('insights');
  const bars = (rows, label = 'interview rate') => rows.length ? rows.map((r) => `<div class="bar-row"><span title="${esc(r.key)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.key)}</span><div class="bar"><i style="width:${r.rate}%"></i></div><span class="muted">${r.progressed}/${r.total}</span></div>`).join('') : '<p class="muted small">Not enough data yet.</p>';
  const maxW = Math.max(1, ...s.weekly.map((w) => w.n));
  const patterns = reviews.filter((r) => r.type === 'patterns');
  main.innerHTML = `<div class="topbar"><h1>Insights</h1><span class="spacer"></span><button class="btn primary" id="pat">${I.spark} Analyse my patterns</button></div>
    <div class="kpis">
      <div class="kpi"><div class="v">${s.total}</div><div class="l">Applications sent</div></div>
      <div class="kpi"><div class="v">${s.responseRate}%</div><div class="l">Got any response</div></div>
      <div class="kpi"><div class="v">${s.interviewRate}%</div><div class="l">Reached interview</div></div>
      <div class="kpi"><div class="v">${s.byStatus.offer}</div><div class="l">Offers</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Pipeline</h2>${STATUSES.filter((x) => x !== 'draft').map((x) => `<div class="bar-row"><span style="text-transform:capitalize">${x}</span><div class="bar"><i style="width:${s.total ? (s.byStatus[x] / s.total) * 100 : 0}%;background:var(--s-${x})"></i></div><span class="muted">${s.byStatus[x]}</span></div>`).join('')}</div>
      <div class="card"><h2>Applications per week</h2>${s.weekly.length ? `<div style="display:flex;align-items:flex-end;gap:6px;height:140px">${s.weekly.map((w) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px"><span class="small muted">${w.n}</span><div style="width:100%;background:var(--primary);border-radius:4px 4px 0 0;height:${(w.n / maxW) * 100}px"></div><span class="small muted" style="font-size:.65rem">${fmtDate(w.start).split(' ').slice(0, 2).join(' ')}</span></div>`).join('')}</div>` : '<p class="muted small">No data yet.</p>'}</div>
      <div class="card"><h2>Success by CV version</h2><p class="small muted">Applications that reached screening or further</p>${bars(s.byCv)}</div>
      <div class="card"><h2>Success by source</h2><p class="small muted">Applications that reached screening or further</p>${bars(s.bySource)}</div>
    </div>
    ${patterns.length ? `<div class="card" style="margin-top:16px"><h2>Past pattern analyses</h2>${patterns.map((r) => `<div class="doc-row" style="cursor:pointer" data-r="${r.id}"><div style="flex:1">${fmtDate(r.created_at)}</div>${r.status === 'running' ? '<span class="spin"></span>' : '›'}</div>`).join('')}</div>` : ''}`;
  main.querySelector('#pat').onclick = () => { if (s.total < 3) return toast('Track at least 3 applications first'); aiModal({ type: 'patterns' }); };
  main.querySelectorAll('[data-r]').forEach((el) => (el.onclick = () => showReview(+el.dataset.r, viewInsights)));
}

async function drawMail(box) {
  const st = await api('/api/mail/status');
  const accountRows = st.accounts.map((a) => `<div class="acct-row"><span class="avatar" style="width:34px;height:34px;background:var(--grad);font-size:.8rem">${esc(a.user[0].toUpperCase())}</span>
      <div style="flex:1;min-width:0"><b class="ellipsis" style="display:block">${esc(a.user)}</b><span class="small muted">${a.last_error ? `<span style="color:var(--danger)">Problem: ${esc(a.last_error.replace(/^\S+\s/, ''))}</span>` : `Checked ${a.last_sync ? timeAgo(a.last_sync) : 'not yet'}`}</span></div>
      <button class="btn sm ghost danger" data-off="${esc(a.user)}">Disconnect</button></div>`).join('');
  const r = st.last_result;
  box.innerHTML = `
    ${st.connected ? `<p class="small muted" style="margin-top:0">JobTrack checks ${st.accounts.length > 1 ? `all ${st.accounts.length} accounts` : 'this account'} every 15 minutes. ${st.counts.total || 0} job emails found${st.counts.unmatched ? `, <a href="#/inbox?f=unmatched">${st.counts.unmatched} need linking</a>` : ''}.${r ? ` Last check: ${r.saved} new, ${r.statusChanges.length} status update${r.statusChanges.length === 1 ? '' : 's'}${r.added?.length ? `, ${r.added.length} application${r.added.length === 1 ? '' : 's'} added` : ''}.` : ''}</p>
      <div class="acct-list">${accountRows}</div>
      <div class="row" style="margin:12px 0 18px"><button class="btn primary" id="mSync">↻ Check now</button><button class="btn" id="mDeep">Scan last 180 days</button><a class="btn" href="#/inbox">Open inbox</a></div>
      <h3>Add another Gmail</h3><p class="small muted">E.g. your student email if LinkedIn sends its emails there.</p>`
    : '<p class="small">Connect Gmail and JobTrack will spot replies from employers, link them to your applications and update the status for rejections, interviews and offers. You can connect more than one account (e.g. personal and student).</p>'}
    <ol class="small steps">
      <li>That Google account needs <b>2-Step Verification</b> on: <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener">turn it on here</a> (sign into the right account first).</li>
      <li>Create an <b>App Password</b> at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>. Name it "JobTrack" and copy the 16-character password.</li>
      <li>Paste it below. School and work accounts sometimes block App Passwords; if the page says the setting isn't available, see the note underneath.</li></ol>
    <form id="mForm" class="grid2"><div class="field"><label>Gmail address</label><input name="user" type="email" required autocomplete="off"></div>
      <div class="field"><label>App password</label><input name="pass" type="password" required autocomplete="off" placeholder="xxxx xxxx xxxx xxxx"></div>
      <div class="field full"><button class="btn ${st.connected ? '' : 'primary'}">${st.connected ? 'Add account' : 'Connect'}</button> <span class="small muted" style="margin-left:8px">Read-only. The password goes into your macOS Keychain.</span></div></form>
    <details class="small" style="margin-top:6px"><summary style="cursor:pointer;font-weight:600">My student or work account won't allow App Passwords</summary>
      <p>Two options: <b>(1)</b> switch LinkedIn (and other job sites) to send emails to your personal Gmail. In the LinkedIn app: <i>Me → Settings → Sign in &amp; security → Email addresses → Add email address</i>, verify it, then tap <i>Make primary</i>. Or <b>(2)</b> in the student Gmail, set up forwarding to your personal Gmail: <i>Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address</i>, then create a filter for <code>from:(linkedin.com OR indeed.com OR totaljobs.com OR cv-library.co.uk OR reed.co.uk)</code> → Forward it. Your school may block forwarding too, in which case option 1 is the way.</p></details>
    <p class="small muted" style="margin-bottom:0">Read-only: JobTrack never sends, deletes or marks emails as read.</p>`;
  const busy = (b) => { b.disabled = true; b.innerHTML = '<span class="spin"></span> Checking…'; };
  const syncBtn = box.querySelector('#mSync');
  if (syncBtn) syncBtn.onclick = guard(async (e) => { busy(e.currentTarget); const r = await api('/api/mail/sync', { method: 'POST', body: {} }).finally(() => drawMail(box)); toast(`${r.result.saved} new job emails`); });
  const deep = box.querySelector('#mDeep');
  if (deep) deep.onclick = guard(async (e) => { busy(e.currentTarget); const r = await api('/api/mail/sync', { method: 'POST', body: { days: 180 } }).finally(() => drawMail(box)); toast(`${r.result.saved} new job emails`); });
  box.querySelectorAll('[data-off]').forEach((b) => (b.onclick = guard(async () => {
    const purge = confirm(`Disconnect ${b.dataset.off}?\n\nOK = also delete the emails JobTrack saved from it\nCancel = keep them`);
    await api('/api/mail/disconnect', { method: 'POST', body: { user: b.dataset.off, purge } }); drawMail(box);
  })));
  box.querySelector('#mForm').onsubmit = guard(async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Connecting…';
    try { await api('/api/mail/connect', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Connected. Scanning the last 90 days in the background…', 5000); }
    finally { drawMail(box); }
  });
}

const b64ToBytes = (b64) => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

async function drawPhone(box, profile) {
  const [pushInfo, mailSt, docs] = await Promise.all([api('/api/push'), api('/api/mail/status'), api('/api/documents')]);
  const cvs = latestVersions(docs).filter((d) => d.kind === 'cv');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const reg = supported ? await navigator.serviceWorker.ready.catch(() => null) : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const origin = location.origin;
  box.innerHTML = `
  <div class="card"><h2>📱 Applying from your phone</h2>
    <p class="small">You don't need to do anything special when you apply in the <b>LinkedIn, Indeed, Totaljobs, CV-Library or Reed apps</b>. They all email you a confirmation, and JobTrack turns that email into an application within 15 minutes, with the company, role, job link and (where available) the full job description.</p>
    ${mailSt.connected ? '' : '<div class="banner warn small">This needs your Gmail connected. <a href="#/profile?tab=email">Connect it in the Email tab</a>.</div>'}
    <label class="toggle"><input type="checkbox" id="autoAdd" ${mailSt.auto_add ? 'checked' : ''}> <span>Automatically add applications from confirmation emails</span></label>
    <p class="small" style="margin:12px 0 4px"><b>Which CV gets attached?</b> JobTrack picks it automatically: first a CV named in the confirmation email (Indeed and many company sites list it), otherwise whichever of your CVs best matches that job's description, otherwise the default below. The application page says which it chose and why, so you can swap it in one tap.</p>
    <div class="field" style="margin-top:8px;max-width:420px"><label>Default CV (used when nothing better is found)</label>
      <select id="defCv"><option value="">None, I'll attach one myself</option>${cvs.map((d) => `<option value="${d.parent_id || d.id}" ${String(profile.default_cv_id) === String(d.parent_id || d.id) ? 'selected' : ''}>${esc(d.title)} (latest version)</option>`).join('')}</select></div>
  </div>

  <div class="card"><h2>🔔 Notifications</h2>
    <p class="small">Get a buzz when an application is added, or an employer replies with an interview, assessment, rejection or offer, even when JobTrack is closed.</p>
    ${!supported ? `<div class="banner warn small">${isIOS() && !isStandalone() ? 'On iPhone, open JobTrack from its <b>Home Screen icon</b> (Share → Add to Home Screen), then come back here.' : 'This browser doesn\'t support notifications.'}</div>` : ''}
    ${supported && location.protocol !== 'https:' && location.hostname !== 'localhost' ? '<div class="banner warn small">Notifications need the secure Tailscale address (https://…ts.net), not a plain http address.</div>' : ''}
    <div class="row">${supported ? (sub ? '<span class="pill" style="color:var(--ok)"><span class="dot"></span>On for this device</span><button class="btn" id="pTest">Send a test</button><button class="btn ghost danger" id="pOff">Turn off here</button>'
      : '<button class="btn primary" id="pOn">Turn on notifications for this device</button>') : ''}</div>
    <p class="small muted" style="margin-bottom:0">${pushInfo.devices.length} device${pushInfo.devices.length === 1 ? '' : 's'} receiving notifications${pushInfo.devices.length ? ': ' + pushInfo.devices.map((d) => esc(d.device || 'device')).join(', ') : ''}.</p>
  </div>

  <div class="card"><h2>⚡ Ask me after I use LinkedIn or Indeed (iPhone)</h2>
    <p class="small">iPhone won't let any app watch what you do inside LinkedIn, but Apple's own <b>Shortcuts</b> app can react when you <i>close</i> it. Set this up once and your phone asks <i>"Did you just apply?"</i> every time you leave LinkedIn or Indeed. Tap Yes and JobTrack opens ready to add it, so you can attach the right CV straight away instead of waiting for the email.</p>
    <ol class="small steps">
      <li>Open <b>Shortcuts</b> → <b>Automation</b> → <b>+</b> → <b>App</b>.</li>
      <li>Choose <b>LinkedIn</b>, <b>Indeed</b> (and any other job apps), tick <b>Is Closed</b>, untick <i>Is Opened</i>, and select <b>Run Immediately</b>.</li>
      <li>Add the action <b>Choose from Menu</b>, with the prompt <i>Did you just apply for a job?</i> and two options: <b>Yes</b> and <b>No</b>.</li>
      <li>Under <b>Yes</b>, add <b>Open URLs</b> with <code class="copyable" id="autoUrl">${esc(origin)}/#/new</code>. Leave <b>No</b> empty.</li></ol>
    <p class="small muted" style="margin-bottom:0">If the confirmation email arrives later, JobTrack links it to what you added instead of creating a duplicate.</p>
  </div>

  <div class="card"><h2>↗ Share a job from the LinkedIn or Indeed app</h2>
    <p class="small">Want to save a job <i>before</i> you apply, so you can check your CV against it first? Share it to JobTrack.</p>
    <div class="grid2">
      <div><h3>Android</h3><ol class="small steps"><li>Install JobTrack (Chrome menu → <b>Install app</b>).</li><li>In LinkedIn or Indeed, tap <b>Share</b> on a job and pick <b>JobTrack</b>.</li></ol></div>
      <div><h3>iPhone</h3><ol class="small steps"><li>Open the <b>Shortcuts</b> app → <b>+</b> → name it <b>JobTrack</b>.</li>
        <li>Tap the ⓘ, turn on <b>Show in Share Sheet</b>, set it to receive <b>URLs</b>.</li>
        <li>Add the action <b>Open URLs</b> with: <code class="copyable" id="scUrl">${esc(origin)}/share?url=</code> followed by <b>Shortcut Input</b>.</li>
        <li>In LinkedIn or Indeed: <b>Share → JobTrack</b>.</li></ol></div>
    </div>
  </div>

  <div class="card"><h2>Setting up phone access</h2>
    <p class="small">Your phone reaches JobTrack through <strong>Tailscale</strong>, a private network that only your own devices can join.</p>
    <ol class="small steps"><li>Install Tailscale on the laptop and the phone, and sign in with the same account on both.</li>
      <li>On the laptop, run: <code>tailscale serve --bg 3005</code></li>
      <li>On the phone, open the <code>https://&lt;laptop&gt;.&lt;tailnet&gt;.ts.net</code> address it prints, sign in, then <b>Share → Add to Home Screen</b>.</li></ol>
    <p class="small muted" style="margin-bottom:0">Your laptop does the background work (email checks, notifications). It needs to be awake with JobTrack running, which happens automatically at login.</p></div>`;

  box.querySelector('#autoAdd').onchange = guard(async (e) => { await api('/api/mail/settings', { method: 'POST', body: { auto_add: e.target.checked } }); toast(e.target.checked ? 'Auto-add on' : 'Auto-add off'); });
  box.querySelector('#defCv').onchange = guard(async (e) => { await api('/api/profile', { method: 'PUT', body: { default_cv_id: e.target.value } }); toast('Default CV saved'); });
  box.querySelector('#scUrl').onclick = () => copy(`${origin}/share?url=`);
  box.querySelector('#autoUrl').onclick = () => copy(`${origin}/#/new`);
  const on = box.querySelector('#pOn');
  if (on) on.onclick = guard(async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications were blocked. Allow them in your browser or phone settings.', 5000);
    const r = await navigator.serviceWorker.ready;
    const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(pushInfo.key) });
    const device = `${isIOS() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Device'}${isStandalone() ? ' app' : ' browser'}`;
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: s.toJSON(), device } });
    toast('Notifications on'); drawPhone(box, profile);
  });
  const t = box.querySelector('#pTest'); if (t) t.onclick = guard(async () => { const r = await api('/api/push/test', { method: 'POST' }); toast(r.sent ? 'Test sent' : 'No devices to send to'); });
  const off = box.querySelector('#pOff');
  if (off) off.onclick = guard(async () => { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); toast('Notifications off for this device'); drawPhone(box, profile); });
}

// ---------- profile ----------
async function viewProfile() {
  const p = await api('/api/profile');
  const main = layout('profile');
  const initials = (p.name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const field = (k, label, opts = {}) => `<div class="field ${opts.full ? 'full' : ''}"><label>${label}</label>${opts.select
    ? `<select name="${k}"><option value="">—</option>${opts.select.map((o) => `<option ${p[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : opts.area ? `<textarea name="${k}" rows="${opts.rows || 4}" placeholder="${opts.ph || ''}">${esc(p[k] || '')}</textarea>`
    : `<input name="${k}" value="${esc(p[k] || '')}" placeholder="${opts.ph || ''}" ${opts.type ? `type="${opts.type}"` : ''}>`}</div>`;

  main.innerHTML = `
  <div class="profile-hero">
    <label class="profile-avatar ${p.has_avatar ? 'has-img' : ''}" title="${p.has_avatar ? 'Change photo' : 'Add a photo'}">${p.has_avatar ? `<img src="/api/profile/avatar?v=${p.avatar_v}" alt="">` : `${esc(initials)}<span class="cam">📷</span>`}
      <input type="file" id="avatarIn" accept="image/*" hidden></label>
    <div class="profile-id">
      <h1>${esc(p.name || 'Your profile')}${p.pronouns ? ` <span class="pron">${esc(p.pronouns)}</span>` : ''}</h1>
      <p>${esc(p.headline || 'Add a headline, e.g. "SOC Analyst · Threat Detection · MSc Cybersecurity"')}</p>
      <div class="profile-meta">${[p.current_title && `💼 ${esc(p.current_title)}${p.current_company ? ` at ${esc(p.current_company)}` : ''}`, p.location && `📍 ${esc(p.location)}`,
        p.experience_years && `⏳ ${esc(p.experience_years)} yrs experience`, p.education && `🎓 ${esc(p.education)}`].filter(Boolean).map((x) => `<span>${x}</span>`).join('')}
        ${p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ''}${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}</div>
      ${p.skills || p.certifications ? `<div class="profile-chips">${(p.certifications || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span class="chip-cert">🏅 ${esc(x)}</span>`).join('')}${(p.skills || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    </div>
  </div>
  ${p.has_avatar ? '<div class="row" style="margin:-8px 0 12px"><button class="btn sm ghost" id="avatarDel">Remove photo</button></div>' : ''}
  <div class="tabs" id="ptabs">
    <button class="active" data-t="about">About you</button><button data-t="work">Work eligibility</button><button data-t="email">Email</button><button data-t="phone">Phone</button><button data-t="account">Account</button><button data-t="connections">Claude &amp; devices</button>
  </div>

  <form id="pf">
    <section data-sec="about" class="card"><h2>About you</h2><p class="muted small">Used in cover letters and CV rewrites, and shared with Claude so reviews know your background.</p>
      <div class="grid2">
        ${field('name', 'Full name')}${field('headline', 'Headline', { ph: 'SOC Analyst · Threat Detection · Cloud Security' })}
        ${field('email', 'Contact email (shown on CVs)', { type: 'email' })}${field('phone', 'Phone')}
        ${field('location', 'Location', { ph: 'Sidcup, London' })}${field('linkedin', 'LinkedIn URL')}
        ${field('website', 'Website / GitHub')}${field('target_roles', 'Target roles', { ph: 'SOC Analyst, Detection Engineer' })}
      </div>
      <div class="grid2">
        ${field('pronouns', 'Pronouns (optional)', { ph: 'he/him, she/her, they/them' })}${field('current_title', 'Current / most recent job title')}
        ${field('current_company', 'Current / most recent company')}${field('experience_years', 'Years of experience', { ph: 'e.g. 2' })}
        ${field('education', 'Education', { ph: 'MSc Cybersecurity (Distinction)' })}${field('certifications', 'Certifications (comma separated)', { ph: 'SC-200, Security+, CCNA' })}
      </div>
      ${field('skills', 'Key skills (comma separated)', { ph: 'Splunk, Microsoft Sentinel, KQL, Incident Response, Python' })}
      ${field('summary', 'Professional summary', { area: true, rows: 5, ph: 'A few lines about your experience and what you are looking for' })}
      <button class="btn primary">Save profile</button></section>

    <section data-sec="work" class="card hidden"><h2>Work eligibility & preferences</h2><p class="muted small">Answers to the questions every application asks. Claude uses them, so it won't flag a sponsorship risk if you don't need sponsorship.</p>
      <div class="grid2">
        ${field('right_to_work', 'Right to work in the UK', { select: ['Yes — British/Irish citizen', 'Yes — settled / pre-settled status', 'Yes — indefinite leave to remain', 'Yes — Graduate visa', 'Yes — Skilled Worker visa', 'Yes — other visa', 'No'] })}
        ${field('needs_sponsorship', 'Need visa sponsorship?', { select: ['No', 'Yes — now', 'Yes — in the future'] })}
        ${field('years_in_uk', 'Years living in the UK', { ph: 'e.g. 4' })}
        ${field('clearance', 'Security clearance', { select: ['None', 'Eligible for SC', 'BPSS', 'CTC', 'SC — active', 'DV — active', 'NPPV'] })}
        ${field('notice_period', 'Notice period / availability', { ph: 'Immediately, 1 month…' })}
        ${field('salary_expectation', 'Salary expectation', { ph: '£35,000–£40,000' })}
        ${field('work_mode', 'Preferred work mode', { select: ['Any', 'Remote', 'Hybrid', 'On-site'] })}
        ${field('relocation', 'Willing to relocate?', { select: ['Yes', 'No', 'Within the UK', 'Depends on role'] })}
      </div>
      <button class="btn primary">Save</button></section>
  </form>

  <section data-sec="email" class="card hidden"><h2>${I.mail} Email</h2><div id="mailBox"><span class="spin"></span></div></section>

  <section data-sec="phone" class="hidden"><div id="phoneBox"><div class="card"><span class="spin"></span></div></div></section>

  <section data-sec="account" class="card hidden"><h2>Account</h2>
    <form id="acct" class="grid2">
      <div class="field"><label>Sign-in email</label><input name="email" type="email" value="${esc(p.account_email)}" placeholder="you@example.com"></div>
      <div class="field"><label>New password (leave blank to keep)</label><input name="password" type="password" minlength="8" autocomplete="new-password"></div>
      <div class="field"><label>Current password (required to save)</label><input name="current" type="password" required autocomplete="current-password"></div>
      <div class="field" style="align-self:end"><button class="btn primary">Update account</button></div>
    </form>
    <p class="small muted">Changing your password signs out your other devices. Your data lives only on this laptop, in <code>jobtrack/data</code>.</p>
    <div class="row" style="margin-top:12px"><select id="theme" style="width:auto"><option value="">System light/dark</option><option value="light">Light</option><option value="dark">Dark</option></select>
      <select id="palette" style="width:auto"><option value="sunset">Colours: Sunset</option><option value="ocean">Colours: Ocean</option><option value="indigo">Colours: Indigo (original)</option></select><span class="spacer"></span><button class="btn danger" id="out">Sign out</button></div>
  </section>

  <section data-sec="connections" class="hidden">
    <div class="card"><h2><span class="icon-badge">AI</span> Claude (AI reviews)</h2><div id="ai"><span class="spin"></span> Checking…</div></div>
    <div class="card"><h2>Browser extension</h2>
      <ol class="small" style="padding-left:1.2em"><li>Open <code>chrome://extensions</code>, turn on <strong>Developer mode</strong>, click <strong>Load unpacked</strong> and choose the <code>jobtrack/extension</code> folder.</li>
      <li>In the extension's options, paste the server address <code>${esc(location.origin)}</code> and the token below.</li></ol>
      <div class="row"><input id="tok" readonly value="••••••••••••••••" style="flex:1;font-family:monospace"><button class="btn" id="show">Show</button><button class="btn" id="cpTok">Copy</button><button class="btn danger ghost" id="rot">Rotate</button></div>
      <p class="small muted">The token gives full access to your JobTrack. Keep it private, and rotate it if it ever leaks.</p></div>
  </section>`;

  const tabs = main.querySelectorAll('#ptabs button');
  const show = (t) => { tabs.forEach((b) => b.classList.toggle('active', b.dataset.t === t)); main.querySelectorAll('[data-sec]').forEach((s) => s.classList.toggle('hidden', s.dataset.sec !== t)); };
  tabs.forEach((b) => (b.onclick = () => show(b.dataset.t)));
  if (query().get('tab')) show(query().get('tab')); else if (!p.account_email) show('account');
  drawMail(main.querySelector('#mailBox'));
  drawPhone(main.querySelector('#phoneBox'), p);

  main.querySelector('#pf').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('/api/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    toast('Profile saved'); const cur = main.querySelector('#ptabs .active').dataset.t; await viewProfile(); document.querySelector(`#ptabs [data-t="${cur}"]`)?.click();
  });
  main.querySelector('#acct').onsubmit = guard(async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    if (!b.password) delete b.password;
    await api('/api/auth/account', { method: 'POST', body: b });
    e.target.current.value = ''; e.target.password.value = ''; toast('Account updated');
  });
  let token = null;
  const getTok = async () => (token ||= (await api('/api/auth/token')).token);
  const tok = main.querySelector('#tok');
  main.querySelector('#show').onclick = guard(async () => { tok.value = await getTok(); });
  main.querySelector('#cpTok').onclick = guard(async () => copy(await getTok()));
  main.querySelector('#rot').onclick = guard(async () => { if (!confirm('Rotate the token? The extension will need the new one.')) return; token = (await api('/api/auth/token/rotate', { method: 'POST' })).token; tok.value = token; toast('New token generated'); });
  main.querySelector('#out').onclick = guard(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    try { await caches.delete('jobtrack-data'); localStorage.removeItem(OUTBOX_KEY); } catch {}
    renderAuth();
  });
  const pal = main.querySelector('#palette'); pal.value = currentPalette();
  pal.onchange = guard(async () => { setPalette(pal.value); await api('/api/profile', { method: 'PUT', body: { palette: pal.value } }); toast('Colours updated'); });
  const av = main.querySelector('#avatarIn');
  av.onchange = guard(async () => {
    const f = av.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', await shrinkImage(f), 'avatar.jpg');
    const r = await api('/api/profile/avatar', { method: 'POST', body: fd });
    try { localStorage.setItem('jt_avatar_v', r.v); } catch {}
    toast('Photo updated'); viewProfile();
  });
  const ad = main.querySelector('#avatarDel'); if (ad) ad.onclick = guard(async () => { await api('/api/profile/avatar', { method: 'DELETE' }); try { localStorage.removeItem('jt_avatar_v'); } catch {} viewProfile(); });
  try { if (p.has_avatar) localStorage.setItem('jt_avatar_v', p.avatar_v); else localStorage.removeItem('jt_avatar_v'); } catch {}
  if (p.palette && p.palette !== currentPalette()) setPalette(p.palette);
  const th = main.querySelector('#theme'); th.value = localStorage.getItem('jt_theme') || '';
  th.onchange = () => { localStorage.setItem('jt_theme', th.value); applyTheme(); };
  const st = await api('/api/ai/status');
  main.querySelector('#ai').innerHTML = st.available
    ? `<p><span class="pill" style="color:var(--ok)"><span class="dot"></span>Connected</span> Signed in through Claude Code (${esc(st.authMethod || 'Claude account')}). Reviews use your Pro plan, with no API key and no extra cost.</p>`
    : `<p><span class="pill" style="color:var(--warn)"><span class="dot"></span>Not connected</span> ${esc(st.reason)}</p><p class="small">In Terminal, run:</p>
       <pre class="jd" style="max-height:none">${!st.bin || st.bundled ? 'curl -fsSL https://claude.ai/install.sh | bash\n' : ''}claude auth login</pre>`;
}

// Resize photos on the device first (phone photos are huge) and save as JPEG
async function shrinkImage(file, max = 512) {
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.88));
  } catch { return file; }
}
const PALETTE_THEME_COLOR = { sunset: '#f2542d', ocean: '#0284c7', indigo: '#4f46e5' };
const currentPalette = () => { try { return localStorage.getItem('jt_palette') || 'sunset'; } catch { return 'sunset'; } };
function setPalette(p) {
  document.documentElement.dataset.palette = p;
  try { localStorage.setItem('jt_palette', p); } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PALETTE_THEME_COLOR[p] || '#f2542d');
}

function applyTheme() { const t = localStorage.getItem('jt_theme'); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

// ---------- boot ----------
applyTheme();
setPalette(currentPalette());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('hashchange', () => { window.onbeforeunload = null; route(); });
// Safari on iPhone puts its address bar at the bottom, over a bottom tab bar, so in the browser the
// menu moves to the top. Opened from the Home Screen there's no Safari bar and it stays at the bottom.
if (/iPhone|iPod/.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.documentElement.classList.add('ios-browser');
(async () => {
  let st;
  try { const r = await fetch('/api/auth/status'); st = await r.json(); if (r.headers.get('X-JobTrack-Offline')) setOffline(true); }
  catch { st = { authed: false }; }
  if (!st.authed) return renderAuth();
  route();
  renderOfflineBar(); flushOutbox();
  setTimeout(warmCache, 8000);
})();
