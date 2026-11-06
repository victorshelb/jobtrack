import { md, esc } from './md.js';

const root = document.getElementById('root');
const STATUSES = ['draft', 'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];
const LABEL = { pre_submit: 'Pre-submit check', tailor: 'Tailored CV', rejection: 'Why no offer?', interview_prep: 'Interview prep', answer: 'Answer review' };
let cfg, tab, app, polling;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(cfg.server + path, { method, headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(d?.error || `Server error ${r.status}`);
  return d;
}
const dash = (hash) => `${cfg.server}/${hash}`;
function openEditor(hash) { chrome.windows.create({ url: dash(hash), type: 'popup', width: 1100, height: 850 }); }

async function load() {
  clearTimeout(polling);
  const s = await chrome.storage.local.get(['server', 'token']);
  cfg = { server: (s.server || 'http://localhost:3005').replace(/\/$/, ''), token: s.token };
  if (!cfg.token) { root.innerHTML = `<div class="card"><h2>Connect JobTrack</h2><p>Add your server address and token in the extension options.</p><button class="btn p" id="o">Open options</button></div>`; root.querySelector('#o').onclick = () => chrome.runtime.openOptionsPage(); return; }
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    app = /^https?:/.test(tab?.url || '') ? await api(`/api/lookup?url=${encodeURIComponent(tab.url)}`) : null;
  } catch (e) {
    root.innerHTML = `<div class="banner">Can't reach JobTrack at <b>${esc(cfg.server)}</b>. Is the server running?<br><span class="small muted">${esc(e.message)}</span></div><button class="btn" id="r">Retry</button>`;
    root.querySelector('#r').onclick = load; return;
  }
  app ? renderApp() : renderNone();
}

async function renderNone() {
  const recent = (await api('/api/applications')).slice(0, 6);
  root.innerHTML = `<div class="card"><h2>This page isn't tracked</h2><p class="muted small">Open a job application and JobTrack will offer to track it. Or save this page as a job now:</p>
    <button class="btn p" id="t">Track this page</button></div>
    <div class="card"><div class="row"><h2 style="margin:0">Recent</h2><span class="spacer"></span><a class="btn sm" href="${dash('#/')}" target="_blank">Dashboard</a></div>
    ${recent.map((a) => `<div class="doc"><div style="flex:1"><b>${esc(a.role)}</b><div class="small muted">${esc(a.company)} · ${a.status}</div></div><a class="btn sm" href="${dash(`#/app/${a.id}`)}" target="_blank">Open</a></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`;
  root.querySelector('#t').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Saving…';
    try {
      let job = {};
      try { job = await api('/api/extract-job', { method: 'POST', body: { url: tab.url } }); } catch {}
      await api('/api/applications', { method: 'POST', body: { ...job, role: job.role || tab.title, url: tab.url, status: 'draft' } });
      chrome.tabs.reload(tab.id); load();
    } catch (err) { e.target.textContent = err.message; }
  };
}

async function renderApp() {
  const full = await api(`/api/applications/${app.id}`);
  const cv = full.documents.find((d) => d.kind === 'cv') || full.documents[0];
  const m = cv && full.jd_text ? await api('/api/match', { method: 'POST', body: { app_id: app.id, doc_id: cv.id } }) : null;
  root.innerHTML = `
  <div class="card"><h1>${esc(full.role || 'Untitled role')}</h1><div class="muted">${esc(full.company)}</div>
    <div class="row" style="margin-top:8px"><select id="st" style="flex:1">${STATUSES.map((s) => `<option ${s === full.status ? 'selected' : ''}>${s}</option>`).join('')}</select><a class="btn sm" href="${dash(`#/app/${app.id}`)}" target="_blank">Open ↗</a></div>
    ${full.jd_text ? '' : '<p class="small" style="color:var(--warn)">No job description captured. Add it in the dashboard for better reviews.</p>'}</div>

  <div class="card"><h2>Documents</h2>
    ${full.documents.map((d) => `<div class="doc"><span class="tag">${d.kind === 'cover_letter' ? 'CL' : 'CV'}</span><div style="flex:1;min-width:0">${esc(d.title)} <span class="muted small">v${d.version}</span></div><button class="btn sm" data-edit="${d.id}">Edit</button></div>`).join('') || '<p class="muted small">None yet. Attach your CV on the form and JobTrack saves a copy automatically.</p>'}
  </div>

  ${m ? `<div class="card"><h2>Keyword match (${esc(cv.title)})</h2><div class="row"><span class="score" style="color:${m.score >= 70 ? 'var(--ok)' : m.score >= 45 ? 'var(--warn)' : 'var(--danger)'}">${m.score}%</span><span class="small muted">of key terms found</span></div>
    ${m.missing.length ? `<div style="margin-top:4px">${m.missing.slice(0, 12).map((k) => `<span class="kw">${esc(k.term)}</span>`).join('')}</div>` : ''}</div>` : ''}

  <div class="card"><h2>✨ Review with Claude</h2>
    <div class="grid"><button class="btn p" data-ai="pre_submit">Pre-submit check</button><button class="btn" data-ai="tailor">Tailor CV</button>
    <button class="btn" data-ai="interview_prep">Interview prep</button><button class="btn" data-ai="rejection">Why no offer?</button></div>
    <button class="btn sm" id="cp" style="margin-top:8px">Copy prompt for the Claude app</button>
    <div id="out" style="margin-top:10px"></div></div>
  ${full.reviews.length ? `<div class="card"><h2>Past reviews</h2>${full.reviews.slice(0, 6).map((r) => `<div class="doc" style="cursor:pointer" data-rv="${r.id}"><div style="flex:1">${LABEL[r.type] || r.type}<div class="small muted">${r.created_at.slice(0, 16)}</div></div>${r.status === 'running' ? '<span class="spin"></span>' : '›'}</div>`).join('')}</div>` : ''}`;

  root.querySelector('#st').onchange = async (e) => { await api(`/api/applications/${app.id}`, { method: 'PATCH', body: { status: e.target.value } }); };
  root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEditor(`#/doc/${b.dataset.edit}?app=${app.id}`)));
  root.querySelectorAll('[data-rv]').forEach((el) => (el.onclick = () => watch(+el.dataset.rv)));
  const pick = () => (full.documents.find((d) => d.kind === 'cv') || full.documents[0])?.id;
  root.querySelectorAll('[data-ai]').forEach((b) => (b.onclick = async () => {
    if (!full.documents.length) return (root.querySelector('#out').innerHTML = '<p class="small" style="color:var(--warn)">Attach your CV first.</p>');
    const type = b.dataset.ai;
    try { const r = await api('/api/ai/run', { method: 'POST', body: { type, app_id: app.id, doc_id: type === 'tailor' ? pick() : undefined } }); watch(r.id); }
    catch (e) { root.querySelector('#out').innerHTML = `<p class="small" style="color:var(--danger)">${esc(e.message)}</p>`; }
  }));
  root.querySelector('#cp').onclick = async (e) => {
    const { prompt } = await api('/api/ai/prompt', { method: 'POST', body: { type: 'pre_submit', app_id: app.id } });
    await navigator.clipboard.writeText(prompt); e.target.textContent = 'Copied. Paste into Claude';
  };
  // An answer review started from the page?
  const key = `pending_review_${tab.id}`;
  const p = (await chrome.storage.session.get(key))[key];
  if (p) { chrome.storage.session.remove(key); watch(p); }
}

async function watch(id) {
  clearTimeout(polling);
  const out = root.querySelector('#out');
  out.scrollIntoView({ behavior: 'smooth' });
  const t0 = Date.now();
  const tick = async () => {
    const r = await api(`/api/reviews/${id}`);
    if (r.status === 'running') { out.innerHTML = `<div class="row"><span class="spin"></span><b>${LABEL[r.type] || 'Review'}</b><span class="muted small">${Math.round((Date.now() - t0) / 1000)}s</span></div><p class="small muted">Claude is reading your documents and researching the company…</p>`; polling = setTimeout(tick, 3000); return; }
    const [notes, tailored] = r.result.includes('=====TAILORED=====') ? r.result.split('=====TAILORED=====') : [r.result, null];
    out.innerHTML = `<h3 style="margin-top:0">${LABEL[r.type] || 'Review'}</h3><div class="md" ${r.status === 'error' ? 'style="color:var(--danger)"' : ''}>${md(notes)}</div>
      ${tailored ? `<div class="row" style="margin-top:8px"><button class="btn p" id="saveT">Save tailored version & edit</button></div>` : ''}
      <button class="btn sm" id="cpy" style="margin-top:8px">Copy</button>`;
    out.querySelector('#cpy').onclick = () => navigator.clipboard.writeText(tailored ? tailored.trim() : r.result);
    const st = out.querySelector('#saveT');
    if (st) st.onclick = async () => { const nd = await api(`/api/documents/${r.doc_id}/versions`, { method: 'POST', body: { text: tailored.trim(), app_id: r.app_id } }); openEditor(`#/doc/${nd.id}?app=${r.app_id}`); load(); };
  };
  tick();
}

chrome.tabs.onActivated.addListener(load);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' && id === tab?.id) load(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'session' && tab && ch[`pending_review_${tab.id}`]?.newValue) load();
  if (area === 'local' && (ch.token || ch.server)) load();
});
load();
