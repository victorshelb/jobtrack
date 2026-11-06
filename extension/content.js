// JobTrack content script: spots job applications, offers to track them, lets you attach a CV and see the
// keyword match right on the page, captures files you upload, and saves the important form answers on submit.
// Nothing leaves your browser except to your own JobTrack server, and only for pages you choose to track.
(() => {
  if (window.__jobtrack) return;
  window.__jobtrack = true;
  if (document.querySelector('meta[name="jobtrack-app"]')) return; // never track the JobTrack dashboard itself

  const ATS = /greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|ashbyhq\.com|smartrecruiters\.com|icims\.com|taleo\.net|workable\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|jobvite\.com|successfactors|linkedin\.com\/jobs|indeed\.com|applytojob\.com|breezy\.hr|pinpointhq\.com|personio|rippling\.com|dover\.com|wellfound\.com|otta\.com|welcometothejungle|reed\.co\.uk|totaljobs\.com|cv-library\.co\.uk|civilservicejobs/i;
  const isTop = window === window.top;
  const send = (type, data = {}) => new Promise((res) => {
    try { chrome.runtime.sendMessage({ type, ...data }, (r) => res(r || { error: chrome.runtime.lastError?.message || 'No response' })); }
    catch (e) { res({ error: 'JobTrack was updated. Reload this page.' }); }
  });

  // ---------- URLs ----------
  function linkedinJobId() {
    if (!/linkedin\.com$/.test(location.hostname.replace(/^www\./, ''))) return null;
    return new URLSearchParams(location.search).get('currentJobId') || (location.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/) || [])[1] || null;
  }
  const isLinkedIn = () => /linkedin\.com$/.test(location.hostname.replace(/^www\./, ''));
  function canonicalUrl() {
    const li = linkedinJobId();
    if (li) return `https://www.linkedin.com/jobs/view/${li}/`;
    const u = new URL(location.href);
    [...u.searchParams.keys()].forEach((k) => { if (/^(utm_|ref|refid|trackingid|trk|src|source|gh_src)/i.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    return u.toString();
  }

  let state = { app: null, connected: true, pendingFiles: [], submitted: false, answers: new Map(), collapsed: false, docs: null, match: null };
  const dismissKey = () => `jobtrack_dismiss_${canonicalUrl()}`;

  // ---------- detection ----------
  function labelFor(el) {
    const bits = [];
    if (el.type === 'radio' || el.type === 'checkbox') {
      const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend');
      if (lg) return lg.innerText.replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, 300);
    }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) bits.push(l.innerText); }
    const wrap = el.closest('label'); if (wrap && !bits.length) bits.push(wrap.innerText);
    if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(n.innerText); });
    if (!bits.length) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && !bits.length; i++, p = p.parentElement) {
        const t = [...p.childNodes].filter((n) => n !== el && !n.contains?.(el)).map((n) => n.innerText || n.textContent || '').join(' ').trim();
        if (t.length > 3) bits.push(t);
      }
    }
    if (el.placeholder && !bits.length) bits.push(el.placeholder);
    // de-duplicate repeated label text (LinkedIn repeats it for screen readers)
    const text = [...new Set(bits.join('\n').split('\n').map((x) => x.trim()).filter(Boolean))].join(' ');
    return text.replace(/\s+/g, ' ').replace(/\*/g, '').replace(/\b(Required|Optional)\b/gi, '').trim().slice(0, 300);
  }

  function score() {
    if (isLinkedIn()) return linkedinJobId() ? 5 : 0; // only on an actual LinkedIn job, not the feed/search list
    let s = 0;
    if (ATS.test(location.href)) s += 3;
    if ([...document.querySelectorAll('script[type="application/ld+json"]')].some((x) => /"JobPosting"/.test(x.textContent))) s += 2;
    const files = [...document.querySelectorAll('input[type=file]')];
    if (files.some((f) => /resume|cv\b|curriculum|cover/i.test(labelFor(f)))) s += 3;
    else if (files.length && document.querySelector('form')) s += 1;
    const text = [...document.querySelectorAll('label, legend, h1, h2, h3, button')].slice(0, 400).map((n) => n.innerText).join(' ');
    if (/cover letter|resume|curriculum vitae|\bCV\b/i.test(text)) s += 1;
    if (/submit application|apply now|apply for this job|easy apply|work authori[sz]ation|sponsorship/i.test(text)) s += 1;
    if (/\/(apply|application|careers?|jobs?)\b/i.test(location.pathname)) s += 1;
    return s;
  }

  function pageSnapshot() {
    const parts = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => parts.push(s.outerHTML));
    document.querySelectorAll('meta[property^="og:"], title').forEach((m) => parts.push(m.outerHTML));
    const h1 = document.querySelector('h1'); if (h1) parts.push(h1.outerHTML);
    const main = document.querySelector('[class*="job-description" i], [class*="jobDescription" i], #job-details, main, [role=main], article') || document.body;
    parts.push(`<main>${main.innerHTML.slice(0, 600000)}</main>`);
    return { html: parts.join('\n'), url: canonicalUrl(), hints: hints() };
  }

  // Role/company from the page title: "Role | Company | LinkedIn", "Job Application for Role at Company", "Company - Role"
  function hints() {
    const t = document.title.replace(/^\(\d+\)\s*/, '');
    let m;
    if ((m = t.match(/^(.+?) \| (.+?) \| LinkedIn$/))) return { role: m[1], company: m[2] };
    if ((m = t.match(/^Job Application for (.+?) at (.+)$/i))) return { role: m[1], company: m[2] };
    return { role: (document.querySelector('h1')?.innerText || '').trim().slice(0, 120) };
  }

  // ---------- UI ----------
  // Lives in a closed shadow root. When a site opens a modal (LinkedIn Easy Apply), we move inside it so we stay
  // clickable above it, and stop our clicks from reaching the page so they never count as "click outside → close".
  let host, root;
  function ui() {
    if (root) return root;
    host = document.createElement('jobtrack-ui');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;display:block;';
    for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress', 'wheel']) {
      host.addEventListener(ev, (e) => e.stopPropagation());
    }
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial} *{box-sizing:border-box;font-family:Inter,-apple-system,system-ui,sans-serif}
      .card{width:340px;background:#fff;color:#161a2b;border:1px solid #e3e6ef;border-radius:16px;box-shadow:0 16px 48px rgba(16,24,40,.22);font-size:13.5px;line-height:1.45;overflow:hidden}
      .top{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:10px 14px;display:flex;align-items:center;gap:8px;font-weight:700}
      .top .ic{margin-left:auto;display:flex;gap:2px} .top button{border:0;background:rgba(255,255,255,.15);color:#fff;width:24px;height:24px;border-radius:6px;cursor:pointer;font-size:13px;line-height:1}
      .top button:hover{background:rgba(255,255,255,.3)}
      .body{padding:12px 14px} .muted{color:#636b84;font-size:12.5px} .role{font-weight:650;font-size:14.5px}
      .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;align-items:center}
      button.b{border:1px solid #e3e6ef;background:#fff;color:#161a2b;padding:7px 11px;border-radius:9px;font-size:13px;font-weight:550;cursor:pointer}
      button.b:hover{background:#f1f3f9} button.p{background:#4f46e5;border-color:#4f46e5;color:#fff} button.p:hover{background:#4338ca}
      button.b:disabled{opacity:.6;cursor:default}
      select{width:100%;padding:7px 8px;border:1px solid #e3e6ef;border-radius:9px;font-size:13px;background:#fff;color:#161a2b}
      .pill{display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:99px;padding:8px 14px 8px 10px;box-shadow:0 8px 24px rgba(79,70,229,.35);cursor:pointer;font-size:13px;font-weight:600}
      .dot{width:8px;height:8px;border-radius:50%;background:#4ade80}
      .warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:9px;padding:7px 9px;margin-top:8px;font-size:12.5px}
      .score{display:flex;align-items:center;gap:10px;margin-top:10px;padding:9px 10px;border-radius:10px;background:#f6f7fb}
      .score b{font-size:22px} .kw{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:6px;margin:2px 2px 0 0;background:#fee2e2;color:#b91c1c}
      .lbl{font-size:11.5px;font-weight:700;color:#636b84;text-transform:uppercase;letter-spacing:.04em;margin-top:12px}
      .toast{background:#161a2b;color:#fff;border-radius:10px;padding:9px 13px;font-size:13px;margin-top:8px;box-shadow:0 6px 20px rgba(0,0,0,.2);max-width:340px}
      @media (prefers-color-scheme: dark){.card{background:#161a24;color:#e8ebf3;border-color:#2a3142} .muted,.lbl{color:#97a0b8}
        button.b,select{background:#1d2230;color:#e8ebf3;border-color:#2a3142} button.b:hover{background:#262c3d} .score{background:#1d2230}
        .warn{background:#3a2a12;border-color:#7c4a12;color:#fdba74} .kw{background:#3b1d22;color:#fca5a5}}
    </style><div id="box"></div><div id="toasts"></div>`;
    place();
    return root;
  }

  function openModal() {
    const cands = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], .artdeco-modal, [data-test-modal]')];
    return cands.reverse().find((m) => m.offsetParent !== null || m.matches('dialog[open]')) || null;
  }
  function place() {
    if (!host) return;
    const target = openModal() || document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  }
  let queued = false; // LinkedIn mutates the DOM constantly, so check at most once per frame
  new MutationObserver(() => {
    if (!host || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; place(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    ui().getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
  }
  const top = (title, extraBtns = '') => `<div class="top"><span>✓ ${title}</span><span class="ic">${extraBtns}<button data-act="min" title="Minimise">–</button></span></div>`;

  function renderOffer() {
    const box = ui().getElementById('box');
    const h = hints();
    const n = state.pendingFiles.length;
    box.innerHTML = `<div class="card">${top('JobTrack', '<button data-act="never" title="Not for this page">✕</button>')}<div class="body">
      <div class="muted">Looks like a job application</div><div class="role">${esc(h.role || 'This job')}</div>${h.company ? `<div>${esc(h.company)}</div>` : ''}
      ${n ? `<div class="muted" style="margin-top:6px">📎 ${n} file${n > 1 ? 's' : ''} ready to save: ${state.pendingFiles.map((f) => esc(f.name)).join(', ')}</div>` : ''}
      <div class="row"><button class="b p" data-act="track">${n ? 'Track & save files' : 'Track this application'}</button><button class="b" data-act="later">Not now</button></div></div></div>`;
    wire(box);
  }

  function renderTracked(notice = '') {
    const box = ui().getElementById('box');
    const a = state.app;
    if (state.collapsed) {
      box.innerHTML = `<div class="pill" data-act="expand"><span class="dot" style="background:${a.status === 'draft' ? '#cbd5e1' : '#4ade80'}"></span>JobTrack · ${esc(a.status)}${state.match ? ` · ${state.match.score}% match` : ''}</div>`;
      return wire(box);
    }
    const attached = (a.documents || []).filter((d) => d.kind !== 'cover_letter');
    const docs = (state.docs || []).filter((d) => !attached.some((x) => x.id === d.id));
    const m = state.match;
    box.innerHTML = `<div class="card">${top('JobTrack · tracked')}<div class="body">
      <div class="role">${esc(a.role || 'Untitled role')}</div><div class="muted">${esc(a.company || '')} · ${esc(a.status)}</div>
      ${notice}
      <div class="lbl">CV for this application</div>
      ${attached.length ? attached.map((d) => `<div style="margin-top:4px">📄 ${esc(d.title)} <span class="muted">v${d.version}</span></div>`).join('') : '<div class="muted" style="margin-top:4px">None attached yet</div>'}
      ${docs.length ? `<div class="row"><select id="pick"><option value="">${attached.length ? 'Swap / add another…' : 'Choose a CV from your library…'}</option>${docs.map((d) => `<option value="${d.id}">${esc(d.title)} · ${d.kind === 'cover_letter' ? 'Cover letter' : 'CV'} v${d.version}</option>`).join('')}</select></div>` : ''}
      ${m ? `<div class="score"><b style="color:${m.score >= 70 ? '#16a34a' : m.score >= 45 ? '#d97706' : '#dc2626'}">${m.score}%</b><span class="muted">keyword match with this job</span></div>
        ${m.missing.length ? `<div style="margin-top:6px">${m.missing.slice(0, 8).map((k) => `<span class="kw">${esc(k.term)}</span>`).join('')}</div><div class="muted" style="margin-top:4px;font-size:11.5px">Missing. Add only if you genuinely have them.</div>` : ''}` : ''}
      <div class="row"><button class="b p" data-act="review" ${attached.length ? '' : 'disabled'}>✨ Review with Claude</button><button class="b" data-act="panel">Open panel</button>
      ${a.status === 'draft' ? '<button class="b" data-act="applied">Mark applied</button>' : ''}</div></div></div>`;
    wire(box);
    const pick = box.querySelector('#pick');
    if (pick) pick.onchange = async () => {
      if (!pick.value) return;
      pick.disabled = true;
      const r = await send('attach', { doc_id: +pick.value });
      if (r.error) { toast(r.error); pick.disabled = false; return; }
      await refresh(); toast('CV attached');
    };
  }

  function wire(box) {
    box.querySelectorAll('[data-act]').forEach((el) => (el.onclick = async (e) => {
      e.preventDefault();
      const act = el.dataset.act;
      if (act === 'track') return track(el);
      if (act === 'later') { box.innerHTML = ''; return; }
      if (act === 'never') { sessionStorage.setItem(dismissKey(), '1'); box.innerHTML = ''; return; }
      if (act === 'min') { if (state.app) { state.collapsed = true; renderTracked(); } else box.innerHTML = ''; return; }
      if (act === 'expand') { state.collapsed = false; return renderTracked(); }
      if (act === 'panel') return send('openPanel');
      if (act === 'applied') { const r = await send('markApplied'); if (r.data?.app) { state.app.status = r.data.app.status; renderTracked(); toast('Marked as applied'); } return; }
      if (act === 'review') {
        send('openPanel');
        const r = await send('startReview', { type: 'pre_submit' });
        toast(r.error || 'Claude is reviewing. The result will appear in the JobTrack panel.');
      }
    }));
  }

  async function refresh() {
    const r = await send('status', { url: canonicalUrl() });
    if (r.data?.app) state.app = r.data.app;
    const [d, m] = await Promise.all([send('docs'), send('match')]);
    state.docs = d.data || [];
    state.match = m.data || null;
    renderTracked();
  }

  async function track(btn) {
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await send('track', { page: pageSnapshot() });
    if (r.error) { toast(r.error); renderOffer(); return; }
    state.app = { ...r.data.app, documents: [] };
    const files = state.pendingFiles.splice(0);
    for (const f of files) await saveFile(f.file, f.kind, true);
    await refresh();
    const d = r.data.dupes;
    if (d?.length) renderTracked(`<div class="warn">Heads up: you've applied to <b>${esc(d[0].company)}</b> before (${esc(d[0].role)}, ${esc(d[0].status)}).</div>`);
    toast(r.data.app.existing ? 'Already tracked. Linked to this page.' : 'Tracking this application');
  }

  // ---------- file capture ----------
  const OK_FILE = /\.(pdf|docx|doc|txt|md|rtf|odt)$/i;
  function kindFor(input) {
    const l = input ? labelFor(input) : '';
    return /cover/i.test(l) ? 'cover_letter' : /resume|cv\b|curriculum/i.test(l) ? 'cv' : '';
  }
  async function saveFile(file, kind, quiet) {
    if (!OK_FILE.test(file.name) || file.size > 15 * 1024 * 1024) return;
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
    const r = await send('saveFile', { name: file.name, mime: file.type, b64, kind: kind || (/cover|letter/i.test(file.name) ? 'cover_letter' : '') });
    if (r.error) return toast(r.error);
    toast(`📎 Saved "${file.name}" to JobTrack`);
    if (!quiet) refresh();
  }
  function onFiles(files, input) {
    const list = [...files].filter((f) => OK_FILE.test(f.name));
    if (!list.length) return;
    const kind = kindFor(input);
    if (state.app) list.forEach((f) => saveFile(f, kind));
    else if (state.connected) {
      list.forEach((f) => state.pendingFiles.push({ file: f, name: f.name, kind }));
      if (isTop || ATS.test(location.href) || score() >= 3) renderOffer();
    }
  }
  document.addEventListener('change', (e) => { const t = e.target; if (t instanceof HTMLInputElement && t.type === 'file' && t.files?.length) onFiles(t.files, t); }, true);
  document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files, e.target.closest?.('form')?.querySelector('input[type=file]')); }, true);

  // ---------- answers (collected as you go, so multi-page forms like Easy Apply keep earlier pages) ----------
  const SKIP = /\bage\b|date of birth|gender|\bsex\b|ethnic|\brace\b|religio|disab|orientation|pronoun|marital|veteran|first name|last name|surname|full name|e-?mail|phone|mobile|country code|address|post ?code|zip|city|linkedin|website|portfolio|github|how did you hear|consent|privacy|agree/i;
  function answerOf(el) {
    if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 ? el.options[el.selectedIndex].text.trim() : '';
    if (el.type === 'radio') { if (!el.checked) return ''; const l = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`); return (l?.innerText || el.value || '').trim(); }
    if (el.type === 'checkbox' || el.type === 'file' || el.type === 'hidden' || el.type === 'password') return '';
    return (el.value || '').trim();
  }
  function capture(el) {
    if (!state.app) return;
    const q = labelFor(el); const a = answerOf(el);
    if (!q || q.length < 6 || !a || SKIP.test(q)) return;
    state.answers.set(q, a);
  }
  document.addEventListener('change', (e) => { if (e.target.matches?.('input, select, textarea')) capture(e.target); }, true);
  document.addEventListener('focusout', (e) => { if (e.target.matches?.('input[type=text], input:not([type]), textarea')) capture(e.target); }, true);

  async function onSubmit() {
    if (!state.app || state.submitted) return;
    state.submitted = true;
    document.querySelectorAll('input, select, textarea').forEach(capture);
    const answers = [...state.answers].map(([question, answer]) => ({ question, answer }));
    const r = await send('submitted', { answers });
    if (r.data?.app) { state.app.status = r.data.app.status; renderTracked(); toast(`Marked as applied ✓${answers.length ? ` · ${answers.length} answer${answers.length > 1 ? 's' : ''} checked` : ''}`); }
  }
  document.addEventListener('submit', () => onSubmit(), true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button, input[type=submit], [role=button], a.button');
    if (!b) return;
    const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
    if (/^(submit( (your )?application)?|send application|complete application|finish|submit & apply)$/i.test(t)) onSubmit();
    // Moving between pages of a multi-step form: grab what's on screen before it disappears
    if (/^(next|continue|review|save and continue|save & continue)$/i.test(t)) document.querySelectorAll('input, select, textarea').forEach(capture);
  }, true);

  // ---------- saved-answer suggestions under long-answer fields ----------
  let chip, chipFor;
  function hideChip() { chip?.remove(); chip = null; chipFor = null; }
  async function showChip(el) {
    if (!state.app || el === chipFor) return;
    hideChip(); chipFor = el;
    const q = labelFor(el);
    if (q.length < 12) return;
    const sug = await send('suggest', { q });
    if (chipFor !== el) return;
    const items = sug.data || [];
    chip = document.createElement('jobtrack-chip');
    chip.style.cssText = 'all:initial;display:block;margin-top:4px;';
    for (const ev of ['pointerdown', 'mousedown', 'click', 'focusin']) chip.addEventListener(ev, (e) => e.stopPropagation());
    const sr = chip.attachShadow({ mode: 'closed' });
    sr.innerHTML = `<style>*{font-family:Inter,system-ui,sans-serif;font-size:12px} .w{display:flex;gap:6px;flex-wrap:wrap} button{border:1px solid #c7cbe0;background:#eef0ff;color:#3730a3;border-radius:99px;padding:4px 10px;cursor:pointer} button:hover{background:#e0e3ff}</style>
      <div class="w">${items.map((s, i) => `<button data-i="${i}" title="${esc(s.answer.slice(0, 200))}">💡 Use saved answer${items.length > 1 ? ' ' + (i + 1) : ''}</button>`).join('')}<button id="rv">✨ Review with Claude</button></div>`;
    el.insertAdjacentElement('afterend', chip); // inline, so it scrolls with the field (and stays inside modals)
    sr.querySelectorAll('[data-i]').forEach((b) => b.onmousedown = (e) => {
      e.preventDefault();
      const v = items[+b.dataset.i].answer;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; // works with React-controlled inputs
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      toast('Inserted. Tweak it for this company!');
    });
    sr.getElementById('rv').onmousedown = async (e) => {
      e.preventDefault();
      if ((el.value || '').trim().length < 30) return toast('Write a bit more first');
      send('openPanel');
      const res = await send('reviewAnswer', { question: q, answer: el.value });
      toast(res.error || 'Claude is reviewing. See the JobTrack panel.');
    };
  }
  document.addEventListener('focusin', (e) => { if (e.target instanceof HTMLTextAreaElement) showChip(e.target); }, true);
  document.addEventListener('focusout', (e) => { if (e.target === chipFor) setTimeout(() => { if (document.activeElement !== chipFor) hideChip(); }, 250); }, true);

  // ---------- boot (and re-run on SPA navigation: LinkedIn, Workday…) ----------
  let lastKey = '';
  async function init() {
    const key = canonicalUrl();
    if (key === lastKey) return;
    lastKey = key;
    state = { ...state, app: null, submitted: false, answers: new Map(), match: null, docs: null, collapsed: false };
    if (root) ui().getElementById('box').innerHTML = '';
    if (score() < 3) return;
    const r = await send('status', { url: key });
    if (r.error) { state.connected = !/not connected/i.test(r.error); return; }
    if (!(isTop || ATS.test(location.href))) return;
    if (r.data.app) { state.app = r.data.app; state.collapsed = true; refresh(); return; }
    if (!sessionStorage.getItem(dismissKey())) renderOffer();
  }
  setInterval(() => { if (canonicalUrl() !== lastKey) setTimeout(init, 700); }, 1000);
  setTimeout(init, 600);
})();
