// JobTrack background worker: the only place that talks to your JobTrack server.
// Content scripts never see the token; they send messages here.

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {}); // Chrome only; Safari has no side panel
  const { server, token } = await chrome.storage.local.get(['server', 'token']);
  if (reason === 'install' || !server || !token) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {}));
// Safari (Mac/iPhone): no side panel, so the toolbar button opens the JobTrack dashboard instead
if (!chrome.sidePanel) chrome.action?.onClicked?.addListener(async () => { const { server } = await cfg(); chrome.tabs.create({ url: `${server}/#/` }); });

// Where "Open panel" goes when there's no side panel (Safari): this application in the dashboard
async function openFallback(tab) {
  const { server } = await cfg();
  const appId = await tabApp(tab.id);
  await chrome.tabs.create({ url: `${server}/#/${appId ? `app/${appId}` : ''}` });
}

async function cfg() {
  const { server = 'http://localhost:3005', token = '' } = await chrome.storage.local.get(['server', 'token']);
  return { server: server.replace(/\/$/, ''), token };
}

async function api(path, { method = 'GET', body, form } = {}) {
  const { server, token } = await cfg();
  if (!token) throw new Error('JobTrack is not connected. Open the extension options.');
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(server + path, { method, headers, body: payload });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || `JobTrack server error ${r.status}`);
  return data;
}

// tabId -> appId, kept in session storage so it survives worker restarts
async function tabApp(tabId, appId) {
  const key = `tab_${tabId}`;
  if (appId === undefined) return (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.set({ [key]: appId });
}
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab_${tabId}`));

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function extract(page) {
  // LinkedIn: the server reads LinkedIn's clean public job page (the live page mixes in other jobs)
  if (/linkedin\.com\/jobs\/view\//.test(page.url)) {
    try { return { ...(await api('/api/extract-job', { method: 'POST', body: { url: page.url } })), url: page.url }; } catch {}
  }
  let job = await api('/api/extract-job', { method: 'POST', body: { html: page.html, url: page.url } });
  // Apply pages often lack the description (e.g. Lever's /apply). Try the posting page itself.
  if ((job.jd_text || '').length < 400) {
    const base = page.url.replace(/\/(apply|application)\/?(\?.*)?$/i, '');
    try {
      const j2 = await api('/api/extract-job', { method: 'POST', body: { url: base } });
      if ((j2.jd_text || '').length > (job.jd_text || '').length) job = { ...j2, ...Object.fromEntries(Object.entries(job).filter(([k, v]) => v && k !== 'jd_text')), jd_text: j2.jd_text };
    } catch {}
  }
  // Page-title hints fill any gaps (company is often missing from raw HTML)
  for (const [k, v] of Object.entries(page.hints || {})) if (v && !job[k]) job[k] = v;
  return { ...job, url: page.url };
}

const handlers = {
  async status({ url }, tab) {
    const app = await api(`/api/lookup?url=${encodeURIComponent(url)}`);
    if (app) await tabApp(tab.id, app.id);
    return { app, connected: true };
  },

  async track({ page, status = 'draft' }, tab) {
    const job = await extract(page);
    const dupes = job.company ? await api(`/api/duplicates?company=${encodeURIComponent(job.company)}`) : [];
    const app = await api('/api/applications', { method: 'POST', body: { ...job, url: page.url, status } });
    await tabApp(tab.id, app.id);
    return { app, dupes: dupes.filter((d) => d.id !== app.id) };
  },

  async saveFile({ name, mime, b64, kind }, tab) {
    const appId = await tabApp(tab.id);
    if (!appId) throw new Error('Track this application first');
    const form = new FormData();
    form.append('file', b64ToBlob(b64, mime || 'application/octet-stream'), name);
    form.append('app_id', appId);
    if (kind) form.append('kind', kind);
    const doc = await api('/api/documents', { method: 'POST', form });
    return { doc };
  },

  async submitted({ answers }, tab) {
    const appId = await tabApp(tab.id);
    if (!appId) return { skipped: true };
    if (answers?.length) await api('/api/answers', { method: 'POST', body: answers.map((a) => ({ ...a, app_id: appId })) });
    const app = await api(`/api/applications/${appId}`, { method: 'PATCH', body: { status: 'applied' } });
    return { app };
  },

  async markApplied(_, tab) {
    const appId = await tabApp(tab.id);
    return { app: await api(`/api/applications/${appId}`, { method: 'PATCH', body: { status: 'applied' } }) };
  },

  // Latest version of each document in the library, for the in-page CV picker
  async docs() {
    const all = await api('/api/documents');
    const latest = new Map();
    for (const d of all) { const r = d.parent_id || d.id; if (!latest.has(r) || d.version > latest.get(r).version) latest.set(r, d); }
    return [...latest.values()].sort((a, b) => (a.kind === 'cv' ? -1 : 1) - (b.kind === 'cv' ? -1 : 1) || b.created_at.localeCompare(a.created_at));
  },

  async attach({ doc_id }, tab) {
    const appId = await tabApp(tab.id);
    if (!appId) throw new Error('Track this application first');
    await api(`/api/applications/${appId}/documents`, { method: 'POST', body: { doc_id } });
    return {};
  },

  async match(_, tab) {
    const appId = await tabApp(tab.id);
    if (!appId) return null;
    const app = await api(`/api/applications/${appId}`);
    const cv = app.documents.find((d) => d.kind === 'cv') || app.documents[0];
    if (!cv || !app.jd_text) return null;
    return api('/api/match', { method: 'POST', body: { app_id: appId, doc_id: cv.id } });
  },

  async startReview({ type }, tab) {
    const appId = await tabApp(tab.id);
    if (!appId) throw new Error('Track this application first');
    const r = await api('/api/ai/run', { method: 'POST', body: { type, app_id: appId } });
    await chrome.storage.session.set({ [`pending_review_${tab.id}`]: r.id });
    return r;
  },

  async suggest({ q }) { return api(`/api/answers/suggest?q=${encodeURIComponent(q)}`); },

  async reviewAnswer({ question, answer }, tab) {
    const appId = await tabApp(tab.id);
    const r = await api('/api/ai/run', { method: 'POST', body: { type: 'answer', app_id: appId, question, answer } });
    await chrome.storage.session.set({ [`pending_review_${tab.id}`]: r.id });
    return r;
  },

  async openPanel(_, tab) { if (chrome.sidePanel?.open) await chrome.sidePanel.open({ tabId: tab.id }); else await openFallback(tab); return {}; },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg.type];
  if (!fn || !sender.tab) return false;
  if (msg.type === 'openPanel') {
    const p = chrome.sidePanel?.open ? chrome.sidePanel.open({ tabId: sender.tab.id }) : openFallback(sender.tab);
    p.then(() => reply({ ok: true }), (e) => reply({ error: e.message })); return true;
  }
  fn(msg, sender.tab).then((data) => reply({ ok: true, data }), (e) => reply({ error: e.message }));
  return true;
});

// Side panel + options use these too
self.jobtrackApi = api;
