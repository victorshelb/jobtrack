const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { db, FILES_DIR, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const { saveUpload, insertDoc, toDocx, rootOf } = require('./docs');
const { fetchJob, parse, sourceOf, canonicalUrl, linkedinJobId } = require('./jobs');
const { categorize, isRelevant, rank } = require('./questions');
const { match } = require('./match');
const ai = require('./ai');
const mail = require('./mail');
const push = require('./push');
const { setSecret, deleteSecret } = require('./secrets');

const PORT = Number(process.env.PORT || 3005);
const HOST = process.env.HOST || '127.0.0.1'; // localhost only; phone access goes through Tailscale

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src 'self' blob:; object-src 'self' blob:",
  });
  next();
});
// Only the browser extension may call the API cross-origin (it uses a bearer token, never cookies)
app.use('/api', (req, res, next) => {
  const o = req.headers.origin;
  if (o && /^(chrome|moz)-extension:\/\//.test(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

auth.routes(app);

const STATUSES = ['draft', 'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const getApp = (id) => db.prepare('SELECT * FROM applications WHERE id=?').get(id);
const docsFor = (appId) => db.prepare(`SELECT d.* FROM documents d JOIN app_documents ad ON ad.doc_id=d.id WHERE ad.app_id=? ORDER BY d.kind`).all(appId);
const link = (appId, docId) => db.prepare('INSERT OR IGNORE INTO app_documents(app_id,doc_id) VALUES(?,?)').run(appId, docId);
const normCompany = (s) => (s || '').toLowerCase().replace(/\b(inc|ltd|llc|plc|limited|corp|corporation|group|gmbh)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

// ---------- Applications ----------
app.get('/api/applications', (req, res) => {
  const rows = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM app_documents WHERE app_id=a.id) doc_count,
    (SELECT COUNT(*) FROM reviews WHERE app_id=a.id) review_count FROM applications a ORDER BY COALESCE(a.applied_at, a.created_at) DESC`).all();
  const docs = db.prepare(`SELECT ad.app_id, d.id, d.kind, d.title, d.version FROM app_documents ad JOIN documents d ON d.id=ad.doc_id`).all();
  const answers = db.prepare(`SELECT app_id, question, answer FROM answers WHERE app_id IS NOT NULL`).all();
  const latest = db.prepare(`SELECT e.app_id, e.id, e.category, e.date, e.subject, e.seen FROM emails e
    WHERE e.app_id IS NOT NULL AND e.category != 'other' AND e.date = (SELECT MAX(date) FROM emails x WHERE x.app_id=e.app_id AND x.category != 'other')`).all();
  for (const r of rows) {
    r.latest_email = latest.find((e) => e.app_id === r.id) || null;
    r.docs = docs.filter((d) => d.app_id === r.id).map(({ app_id, ...d }) => d);
    r.key_answers = answers.filter((x) => x.app_id === r.id && categorize(x.question))
      .sort((x, y) => rank(x.question) - rank(y.question)).slice(0, 4)
      .map((x) => ({ label: categorize(x.question).label, answer: x.answer }));
  }
  res.json(rows);
});

app.get('/api/applications/:id', (req, res) => {
  const a = getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...a,
    documents: docsFor(a.id).map(({ text, ...d }) => ({ ...d, chars: (text || '').length })),
    history: db.prepare('SELECT status, at FROM status_history WHERE app_id=? ORDER BY at').all(a.id),
    answers: db.prepare('SELECT * FROM answers WHERE app_id=? ORDER BY id').all(a.id)
      .map((x) => ({ ...x, label: categorize(x.question)?.label || '' })).sort((x, y) => rank(x.question) - rank(y.question)),
    reviews: db.prepare('SELECT id,type,engine,status,created_at,doc_id FROM reviews WHERE app_id=? ORDER BY id DESC').all(a.id),
    emails: db.prepare('SELECT id,from_name,from_email,subject,date,snippet,category,applied_status,seen FROM emails WHERE app_id=? ORDER BY date DESC').all(a.id),
  });
});

// Same job = same posting URL, or same company + (nearly) the same role title
const roleWords = (r) => new Set((r || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !['and', 'the', 'of', 'm', 'f', 'remote', 'hybrid', 'uk'].includes(w)));
function sameRole(a, b) {
  const x = roleWords(a), y = roleWords(b);
  if (!x.size || !y.size) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.min(x.size, y.size) >= 0.8 && inter / Math.max(x.size, y.size) >= 0.6;
}
function findDuplicates({ company = '', role = '', url = '' }, excludeId) {
  const nc = normCompany(company), nu = url ? normUrl(url) : '';
  return db.prepare('SELECT id, company, role, status, applied_at, url, created_at, logo_url FROM applications').all()
    .filter((a) => a.id !== excludeId)
    .map((a) => {
      if (nu && a.url && normUrl(a.url) === nu) return { ...a, reason: 'same_job' };
      if (nc && normCompany(a.company) === nc && sameRole(a.role, role)) return { ...a, reason: 'same_role' };
      if (nc && normCompany(a.company) === nc) return { ...a, reason: 'same_company' };
      return null;
    }).filter(Boolean)
    .sort((a, b) => ['same_job', 'same_role', 'same_company'].indexOf(a.reason) - ['same_job', 'same_role', 'same_company'].indexOf(b.reason));
}
app.get('/api/duplicates', (req, res) => res.json(findDuplicates(req.query)));

// Groups of applications that look like the same job (for the "merge duplicates" banner)
app.get('/api/duplicates/groups', (req, res) => {
  const all = db.prepare('SELECT id, company, role, url, status, logo_url, created_at FROM applications ORDER BY id').all();
  const seen = new Set(), groups = [];
  for (const a of all) {
    if (seen.has(a.id)) continue;
    const g = [a, ...findDuplicates(a, a.id).filter((d) => d.reason !== 'same_company' && !seen.has(d.id))];
    if (g.length > 1) { g.forEach((x) => seen.add(x.id)); groups.push(g.map(({ reason, ...x }) => x)); }
  }
  res.json(groups);
});

// Merge one application into another: documents, answers, reviews and history move over; blanks get filled
app.post('/api/applications/:id/merge', (req, res) => {
  const keep = getApp(req.params.id), drop = getApp(req.body.from_id);
  if (!keep || !drop || keep.id === drop.id) return res.status(400).json({ error: 'Pick two different applications' });
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO app_documents(app_id, doc_id) SELECT ?, doc_id FROM app_documents WHERE app_id=?').run(keep.id, drop.id);
    for (const t of ['answers', 'reviews', 'status_history']) db.prepare(`UPDATE ${t} SET app_id=? WHERE app_id=?`).run(keep.id, drop.id);
    const fill = FIELDS.filter((f) => !keep[f] && drop[f]);
    if (fill.length) db.prepare(`UPDATE applications SET ${fill.map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...fill.map((f) => drop[f]), keep.id);
    const rankS = (s) => ['draft', 'applied', 'ghosted', 'withdrawn', 'rejected', 'screening', 'interview', 'offer'].indexOf(s);
    if (rankS(drop.status) > rankS(keep.status)) db.prepare('UPDATE applications SET status=? WHERE id=?').run(drop.status, keep.id);
    if (drop.applied_at && (!keep.applied_at || drop.applied_at < keep.applied_at)) db.prepare('UPDATE applications SET applied_at=? WHERE id=?').run(drop.applied_at, keep.id);
    db.prepare('DELETE FROM applications WHERE id=?').run(drop.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(getApp(keep.id));
});

// ---------- Profile picture ----------
const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };
app.post('/api/profile/avatar', upload.single('file'), (req, res) => {
  const f = req.file;
  if (!f || !AVATAR_TYPES[f.mimetype]) return res.status(400).json({ error: 'Choose a JPG, PNG, WebP or HEIC image' });
  if (f.size > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 8 MB' });
  const old = getSetting('avatar_file');
  if (old) fs.rmSync(path.join(FILES_DIR, old), { force: true });
  const name = `avatar-${Date.now()}.${AVATAR_TYPES[f.mimetype]}`;
  fs.writeFileSync(path.join(FILES_DIR, name), f.buffer, { mode: 0o600 });
  setSetting('avatar_file', name);
  res.json({ ok: true, v: Date.now() });
});
app.get('/api/profile/avatar', (req, res) => {
  const f = getSetting('avatar_file');
  if (!f || !fs.existsSync(path.join(FILES_DIR, f))) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(FILES_DIR, f));
});
app.delete('/api/profile/avatar', (req, res) => {
  const f = getSetting('avatar_file');
  if (f) fs.rmSync(path.join(FILES_DIR, f), { force: true });
  setSetting('avatar_file', '');
  res.json({ ok: true });
});

// ---------- Profile ----------
const getProfile = () => { try { return JSON.parse(getSetting('profile') || '{}'); } catch { return {}; } };
app.get('/api/profile', (req, res) => res.json({ ...getProfile(), account_email: getSetting('account_email') || '', has_avatar: !!getSetting('avatar_file'), avatar_v: (getSetting('avatar_file') || '').replace(/\D/g, '') }));
app.put('/api/profile', (req, res) => {
  const allowed = ['name', 'headline', 'email', 'phone', 'location', 'linkedin', 'website', 'summary', 'target_roles',
    'pronouns', 'current_title', 'current_company', 'experience_years', 'skills', 'certifications', 'education', 'palette',
    'default_cv_id', 'right_to_work', 'needs_sponsorship', 'years_in_uk', 'clearance', 'notice_period', 'salary_expectation', 'relocation', 'work_mode'];
  const p = Object.fromEntries(allowed.filter((k) => k in req.body).map((k) => [k, String(req.body[k] ?? '').slice(0, 4000)]));
  setSetting('profile', JSON.stringify({ ...getProfile(), ...p }));
  res.json(getProfile());
});

// Find the tracked application for a page URL (ignores query strings and a trailing /apply)
const normUrl = (u) => {
  try { const x = new URL(canonicalUrl(u)); return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/(apply|application|applications)\/?$/i, '').replace(/\/$/, '') + x.search).toLowerCase(); }
  catch { return ''; }
};
app.get('/api/lookup', (req, res) => {
  const n = normUrl(req.query.url || '');
  const hit = n && db.prepare(`SELECT id,url FROM applications WHERE url != '' ORDER BY id DESC`).all().find((a) => normUrl(a.url) === n);
  if (!hit) return res.json(null);
  res.json({ ...getApp(hit.id), documents: docsFor(hit.id).map(({ id, kind, title, version }) => ({ id, kind, title, version })) });
});

const FIELDS = ['logo_url', 'company', 'role', 'url', 'source', 'location', 'salary', 'status', 'applied_at', 'follow_up_at', 'jd_text', 'notes', 'contact_name', 'contact_email', 'referral'];

app.post('/api/applications', (req, res) => {
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Bad status' });
  // If this URL is already tracked, return the existing record instead of duplicating
  if (!b.force_new) {
    const dup = findDuplicates(b).find((d) => d.reason !== 'same_company');
    if (dup) {
      // Same job tracked again: link it instead of creating a duplicate, and fill in anything new
      const ex = getApp(dup.id);
      const fill = FIELDS.filter((f) => !ex[f] && b[f] && f !== 'status');
      if (b.url && !ex.url) fill.push('url');
      if (fill.length) db.prepare(`UPDATE applications SET ${[...new Set(fill)].map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...[...new Set(fill)].map((f) => (f === 'url' ? canonicalUrl(b.url) : b[f])), ex.id);
      (b.doc_ids || []).forEach((d) => link(ex.id, d));
      return res.json({ ...getApp(ex.id), existing: true, duplicate_reason: dup.reason });
    }
  }
  const status = b.status || 'draft';
  if (b.url) b.url = canonicalUrl(b.url);
  const r = db.prepare(`INSERT INTO applications(company,role,url,source,location,salary,status,applied_at,jd_text,notes,contact_name,contact_email,referral,follow_up_at,logo_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.company || '', b.role || '', b.url || '', b.source || sourceOf(b.url || ''), b.location || '', b.salary || '', status,
    b.applied_at || (status === 'applied' ? now() : null), b.jd_text || '', b.notes || '', b.contact_name || '', b.contact_email || '', b.referral || '', b.follow_up_at || null, b.logo_url || '');
  const id = r.lastInsertRowid;
  db.prepare('INSERT INTO status_history(app_id,status) VALUES(?,?)').run(id, status);
  (b.doc_ids || []).forEach((d) => link(id, d));
  try { mail.rematch(); } catch {}
  res.json(getApp(id));
});

app.patch('/api/applications/:id', (req, res) => {
  const a = getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Bad status' });
  const sets = [], vals = [];
  for (const f of FIELDS) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
  if (b.status && b.status !== a.status) {
    sets.push('status_updated_at=?', 'status_manual_at=?'); vals.push(now(), now()); // a status you set by hand beats older emails
    if (b.status === 'applied' && !a.applied_at && !('applied_at' in b)) { sets.push('applied_at=?'); vals.push(now()); }
    db.prepare('INSERT INTO status_history(app_id,status) VALUES(?,?)').run(a.id, b.status);
  }
  if (sets.length) db.prepare(`UPDATE applications SET ${sets.join(',')} WHERE id=?`).run(...vals, a.id);
  res.json(getApp(a.id));
});

app.delete('/api/applications/:id', (req, res) => {
  db.prepare('DELETE FROM applications WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/applications/:id/documents', (req, res) => {
  link(req.params.id, req.body.doc_id);
  res.json({ ok: true });
});
app.delete('/api/applications/:id/documents/:docId', (req, res) => {
  db.prepare('DELETE FROM app_documents WHERE app_id=? AND doc_id=?').run(req.params.id, req.params.docId);
  res.json({ ok: true });
});

// ---------- Job extraction ----------
app.post('/api/extract-job', async (req, res) => {
  try {
    if (req.body.html && !linkedinJobId(req.body.url || '')) return res.json(parse(req.body.html, canonicalUrl(req.body.url || '')));
    res.json(await fetchJob(req.body.url));
  } catch (e) {
    res.status(400).json({ error: `Couldn't read that page (${e.message}). You can paste the job description manually.` });
  }
});

// ---------- Documents ----------
app.get('/api/documents', (req, res) => {
  const rows = db.prepare(`SELECT d.id,d.kind,d.title,d.parent_id,d.version,d.filename,d.mime,d.created_at,length(d.text) chars,
    (SELECT COUNT(*) FROM app_documents WHERE doc_id=d.id) used_in FROM documents d ORDER BY d.created_at DESC`).all();
  const links = db.prepare(`SELECT ad.doc_id, a.id, a.company, a.role, a.status, a.logo_url, a.applied_at, a.created_at FROM app_documents ad JOIN applications a ON a.id=ad.app_id`).all();
  for (const r of rows) r.apps = links.filter((l) => l.doc_id === r.id).map(({ doc_id, ...a }) => a);
  res.json(rows);
});

app.get('/api/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const root = rootOf(d.id);
  d.versions = db.prepare('SELECT id,version,title,created_at FROM documents WHERE id=? OR parent_id=? ORDER BY version').all(root, root);
  d.applications = db.prepare('SELECT a.id,a.company,a.role,a.status FROM applications a JOIN app_documents ad ON ad.app_id=a.id WHERE ad.doc_id=?').all(d.id);
  res.json(d);
});

app.post('/api/documents', upload.single('file'), async (req, res) => {
  const { kind, title, app_id, parent_id } = req.body;
  let doc;
  if (req.file) doc = await saveUpload(req.file, { kind, title, parent_id: parent_id ? Number(parent_id) : null });
  else doc = insertDoc({ kind: kind || 'cv', title: title || 'Untitled', parent_id: parent_id ? Number(parent_id) : null, text: req.body.text || '' });
  if (app_id) link(Number(app_id), doc.id);
  res.json(doc);
});

// Editing never overwrites: it saves a new version (so the exact version sent with each application is preserved)
app.post('/api/documents/:id/versions', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const nd = insertDoc({ kind: req.body.kind || d.kind, title: req.body.title || d.title, parent_id: d.id, text: req.body.text ?? d.text });
  if (req.body.app_id) {
    // Swap the application's attached version to the new one
    db.prepare('DELETE FROM app_documents WHERE app_id=? AND doc_id=?').run(req.body.app_id, d.id);
    link(req.body.app_id, nd.id);
  }
  res.json(nd);
});

app.patch('/api/documents/:id', (req, res) => {
  const { title, kind } = req.body;
  if (title) db.prepare('UPDATE documents SET title=? WHERE id=?').run(title, req.params.id);
  if (kind) db.prepare('UPDATE documents SET kind=? WHERE id=?').run(kind, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (d?.path) fs.rmSync(path.join(FILES_DIR, d.path), { force: true });
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d?.path) return res.status(404).json({ error: 'No original file for this version' });
  res.set('Content-Type', d.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(d.filename)}"`);
  res.sendFile(path.join(FILES_DIR, d.path));
});

app.get('/api/documents/:id/export.docx', async (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).end();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(`${d.title} v${d.version}.docx`)}"`);
  res.send(await toDocx(d));
});

// ---------- Keyword match ----------
app.post('/api/match', (req, res) => {
  let { jd_text, text, app_id, doc_id } = req.body;
  const a = app_id ? getApp(app_id) : null;
  if (a && !jd_text) jd_text = a.jd_text;
  if (doc_id && !text) text = db.prepare('SELECT text FROM documents WHERE id=?').get(doc_id)?.text;
  res.json(match(jd_text || '', text || '', a?.company || ''));
});

// ---------- Answer bank ----------
app.get('/api/answers', (req, res) => {
  res.json(db.prepare(`SELECT ans.*, a.company, a.role, a.status, a.logo_url, a.applied_at FROM answers ans LEFT JOIN applications a ON a.id=ans.app_id ORDER BY COALESCE(a.applied_at, a.created_at) DESC, ans.id`).all()
    .map((x) => ({ ...x, label: categorize(x.question)?.label || '' })));
});
app.post('/api/answers', (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const ins = db.prepare('INSERT INTO answers(app_id,question,answer) VALUES(?,?,?)');
  const fromExtension = Array.isArray(req.body);
  for (const it of items) if (it.question && it.answer && (!fromExtension || isRelevant(it.question, it.answer))) {
    if (it.app_id) db.prepare('DELETE FROM answers WHERE app_id=? AND question=?').run(it.app_id, it.question);
    ins.run(it.app_id || null, it.question.slice(0, 1000), it.answer.slice(0, 10000));
  }
  res.json({ ok: true });
});
app.patch('/api/answers/:id', (req, res) => {
  db.prepare('UPDATE answers SET question=COALESCE(?,question), answer=COALESCE(?,answer) WHERE id=?').run(req.body.question ?? null, req.body.answer ?? null, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/answers/:id', (req, res) => {
  db.prepare('DELETE FROM answers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Suggest saved answers for a form question (simple word overlap)
app.get('/api/answers/suggest', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (!q.length) return res.json([]);
  const rows = db.prepare('SELECT id,question,answer FROM answers ORDER BY id DESC LIMIT 500').all()
    .map((r) => ({ ...r, s: q.filter((w) => r.question.toLowerCase().includes(w)).length / q.length }))
    .filter((r) => r.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 3);
  res.json(rows);
});

// ---------- AI reviews ----------
app.get('/api/ai/status', (req, res) => res.json(ai.status()));

function reviewContext(type, b) {
  const ctx = {};
  if (b.app_id) {
    ctx.app = getApp(b.app_id);
    ctx.docs = docsFor(b.app_id);
    ctx.answers = db.prepare('SELECT question, answer FROM answers WHERE app_id=?').all(b.app_id);
    ctx.emails = db.prepare(`SELECT from_name, from_email, subject, date, body, category FROM emails WHERE app_id=? AND category != 'other' ORDER BY date`).all(b.app_id);
  }
  if (b.doc_id) {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(b.doc_id);
    ctx.docs = [d, ...(ctx.docs || []).filter((x) => x.id !== d.id)];
  }
  ctx.docs ||= [];
  ctx.profile = getProfile();
  if (type === 'fix') ctx.lastReview = b.app_id && db.prepare(`SELECT result FROM reviews WHERE app_id=? AND type='pre_submit' AND status='done' ORDER BY id DESC LIMIT 1`).get(b.app_id)?.result;
  if (!ctx.app && (type !== 'patterns' && type !== 'answer')) throw new Error('Pick an application first');
  if (type === 'answer') Object.assign(ctx, { question: b.question, answer: b.answer });
  if (type === 'patterns') {
    ctx.apps = db.prepare(`SELECT a.*, (SELECT group_concat(d.title || ' v' || d.version, '; ') FROM documents d JOIN app_documents ad ON ad.doc_id=d.id WHERE ad.app_id=a.id) docs
      FROM applications a WHERE status != 'draft'`).all();
  }
  return ctx;
}

app.post('/api/ai/prompt', (req, res) => {
  try { res.json({ prompt: ai.buildPrompt(req.body.type, reviewContext(req.body.type, req.body)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ai/run', (req, res) => {
  try {
    const { type } = req.body;
    const prompt = ai.buildPrompt(type, reviewContext(type, req.body));
    const r = db.prepare(`INSERT INTO reviews(app_id,doc_id,type,engine,status) VALUES(?,?,?,'claude-cli','running')`)
      .run(req.body.app_id || null, req.body.doc_id || null, type);
    ai.run(r.lastInsertRowid, prompt);
    res.json({ id: r.lastInsertRowid, status: 'running' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Paste a result back from the Claude app
app.post('/api/reviews', (req, res) => {
  const { app_id, doc_id, type, result } = req.body;
  const r = db.prepare(`INSERT INTO reviews(app_id,doc_id,type,engine,status,result) VALUES(?,?,?,'manual','done',?)`).run(app_id || null, doc_id || null, type, result || '');
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/reviews', (req, res) => {
  res.json(db.prepare(`SELECT r.id,r.type,r.status,r.engine,r.created_at,r.app_id,a.company,a.role FROM reviews r LEFT JOIN applications a ON a.id=r.app_id ORDER BY r.id DESC LIMIT 100`).all());
});
app.get('/api/reviews/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/reviews/:id', (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Stats & reminders ----------
app.get('/api/stats', (req, res) => {
  const all = db.prepare(`SELECT * FROM applications WHERE status != 'draft'`).all();
  const progressed = (s) => ['screening', 'interview', 'offer'].includes(s);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  db.prepare('SELECT status, COUNT(*) n FROM applications GROUP BY status').all().forEach((r) => (byStatus[r.status] = r.n));
  const group = (keyFn) => {
    const m = {};
    for (const a of all) {
      const k = keyFn(a) || 'Unknown';
      m[k] ||= { total: 0, progressed: 0 };
      m[k].total++; if (progressed(a.status)) m[k].progressed++;
    }
    return Object.entries(m).map(([k, v]) => ({ key: k, ...v, rate: Math.round((v.progressed / v.total) * 100) })).sort((a, b) => b.total - a.total);
  };
  const docUse = db.prepare(`SELECT d.title || ' v' || d.version label, a.status FROM app_documents ad JOIN documents d ON d.id=ad.doc_id
    JOIN applications a ON a.id=ad.app_id WHERE d.kind='cv' AND a.status != 'draft'`).all();
  const byCv = {};
  docUse.forEach(({ label, status }) => { byCv[label] ||= { total: 0, progressed: 0 }; byCv[label].total++; if (progressed(status)) byCv[label].progressed++; });
  const weekly = db.prepare(`SELECT strftime('%Y-%W', applied_at) wk, MIN(date(applied_at)) start, COUNT(*) n FROM applications WHERE applied_at IS NOT NULL GROUP BY wk ORDER BY wk DESC LIMIT 12`).all().reverse();
  res.json({
    total: all.length, byStatus,
    responseRate: all.length ? Math.round((all.filter((a) => a.status !== 'applied' && a.status !== 'ghosted').length / all.length) * 100) : 0,
    interviewRate: all.length ? Math.round((all.filter((a) => ['interview', 'offer'].includes(a.status)).length / all.length) * 100) : 0,
    bySource: group((a) => a.source), byCv: Object.entries(byCv).map(([key, v]) => ({ key, ...v, rate: Math.round((v.progressed / v.total) * 100) })), weekly,
  });
});

app.get('/api/reminders', (req, res) => {
  const days = Number(req.query.days || 14);
  res.json({
    followUps: db.prepare(`SELECT id,company,role,follow_up_at FROM applications WHERE follow_up_at IS NOT NULL AND date(follow_up_at) <= date('now') AND status IN ('applied','screening','interview')`).all(),
    stale: db.prepare(`SELECT id,company,role,applied_at FROM applications WHERE status='applied' AND applied_at IS NOT NULL AND julianday('now') - julianday(status_updated_at) >= ?`).all(days),
    drafts: db.prepare(`SELECT id,company,role,created_at FROM applications WHERE status='draft' AND julianday('now') - julianday(created_at) >= 2`).all(),
  });
});

// ---------- Email (Gmail over IMAP, read-only) ----------
const mailStatus = () => ({
  connected: mail.accounts().length > 0, user: mail.accounts().join(', '), accounts: mail.accounts().map(mail.accountState), last_sync: getSetting('mail_last_sync') || null,
  last_result: JSON.parse(getSetting('mail_last_result') || 'null'), last_error: getSetting('mail_last_error') || '', syncing: mail.isSyncing(),
  auto_add: getSetting('auto_add') !== 'off',
  counts: db.prepare(`SELECT COUNT(*) total, SUM(app_id IS NULL AND category != 'other') unmatched, SUM(seen=0 AND app_id IS NOT NULL AND category != 'other') unseen FROM emails`).get(),
});
app.get('/api/mail/status', (req, res) => res.json(mailStatus()));
app.post('/api/mail/connect', async (req, res) => {
  const user = String(req.body.user || '').trim().toLowerCase();
  const pass = String(req.body.pass || '').replace(/\s+/g, ''); // Google shows app passwords in groups of 4
  if (!/^\S+@\S+$/.test(user) || pass.length < 16) return res.status(400).json({ error: 'Enter your Gmail address and the 16-character app password' });
  try {
    if (mail.accounts().length >= 5 && !mail.accounts().includes(user)) return res.status(400).json({ error: 'You can connect up to 5 Gmail accounts' });
    await mail.testConnection(user, pass);
    await setSecret(`imap:${user}`, pass);
    mail.setAccounts([...mail.accounts(), user]); setSetting('mail_last_error', '');
    mail.sync({ only: user }).catch((e) => setSetting('mail_last_error', `${new Date().toISOString()} ${e.message}`));
    res.json(mailStatus());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/mail/settings', (req, res) => {
  if ('auto_add' in req.body) setSetting('auto_add', req.body.auto_add ? 'on' : 'off');
  res.json(mailStatus());
});
app.post('/api/mail/disconnect', async (req, res) => {
  const user = String(req.body.user || '').toLowerCase();
  if (!mail.accounts().includes(user)) return res.status(400).json({ error: 'That account is not connected' });
  await deleteSecret(`imap:${user}`);
  mail.setAccounts(mail.accounts().filter((u) => u !== user));
  setSetting(`mail_last_sync:${user}`, ''); setSetting(`mail_error:${user}`, '');
  if (req.body.purge) db.prepare('DELETE FROM emails WHERE account=?').run(user);
  res.json(mailStatus());
});
app.post('/api/mail/sync', async (req, res) => {
  try { const r = await mail.sync({ days: req.body.days }); setSetting('mail_last_error', ''); res.json({ ...mailStatus(), result: r }); }
  catch (e) { setSetting('mail_last_error', `${new Date().toISOString()} ${e.message}`); res.status(400).json({ error: e.message }); }
});

app.get('/api/emails', (req, res) => {
  const f = req.query.filter || 'all';
  const where = { all: `category != 'other' OR app_id IS NOT NULL`, unmatched: `app_id IS NULL AND category != 'other'`, rejection: `category='rejection'`,
    interview: `category IN ('interview','assessment')`, offer: `category='offer'`, new: `seen=0 AND app_id IS NOT NULL` }[f] || '1';
  res.json(db.prepare(`SELECT e.id,e.account,e.from_name,e.from_email,e.subject,e.date,e.snippet,e.category,e.app_id,e.applied_status,e.seen,e.matched_by,
    a.company,a.role,a.logo_url,a.status FROM emails e LEFT JOIN applications a ON a.id=e.app_id WHERE ${where} ORDER BY e.date DESC LIMIT 300`).all());
});
app.get('/api/emails/updates', (req, res) => {
  res.json(db.prepare(`SELECT e.id,e.category,e.date,e.subject,e.applied_status,a.id app_id,a.company,a.role,a.logo_url FROM emails e JOIN applications a ON a.id=e.app_id
    WHERE e.seen=0 AND e.category != 'other' ORDER BY e.date DESC LIMIT 20`).all());
});
app.get('/api/emails/:id', (req, res) => {
  const e = db.prepare(`SELECT e.*, a.company, a.role, a.logo_url, a.status FROM emails e LEFT JOIN applications a ON a.id=e.app_id WHERE e.id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE emails SET seen=1 WHERE id=?').run(e.id);
  res.json(e);
});
app.post('/api/emails/seen', (req, res) => {
  if (req.body.app_id) db.prepare('UPDATE emails SET seen=1 WHERE app_id=?').run(req.body.app_id);
  else db.prepare('UPDATE emails SET seen=1').run();
  res.json({ ok: true });
});
// Manually fix a link or category; the application's status follows
app.patch('/api/emails/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if ('app_id' in req.body) db.prepare(`UPDATE emails SET app_id=?, matched_by='manual', applied_status=NULL WHERE id=?`).run(req.body.app_id || null, e.id);
  if (req.body.category) db.prepare(`UPDATE emails SET category=?, category_by='manual', applied_status=NULL WHERE id=?`).run(req.body.category, e.id);
  const moved = mail.applyStatus(e.id);
  res.json({ ...db.prepare('SELECT * FROM emails WHERE id=?').get(e.id), moved });
});
// Turn an email about a job you never tracked into an application
app.post('/api/emails/:id/create-app', (req, res) => {
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const { company, role } = req.body;
  if (!company) return res.status(400).json({ error: 'Company is required' });
  const status = mail.STATUS_FOR[e.category] || 'applied';
  const r = db.prepare(`INSERT INTO applications(company, role, status, applied_at, source, notes) VALUES(?,?,?,?,?,?)`)
    .run(company, role || '', status, e.date.slice(0, 19).replace('T', ' '), 'Email', `Created from email: "${e.subject}"`);
  db.prepare('INSERT INTO status_history(app_id,status) VALUES(?,?)').run(r.lastInsertRowid, status);
  db.prepare(`UPDATE emails SET app_id=?, matched_by='manual', applied_status=? WHERE id=?`).run(r.lastInsertRowid, status, e.id);
  mail.rematch();
  res.json(getApp(r.lastInsertRowid));
});

// ---------- Push notifications ----------
app.get('/api/push', (req, res) => res.json({ key: push.vapid(), devices: push.devices().map((d) => ({ device: d.device, created_at: d.created_at, endpoint: d.endpoint.slice(-12) })), enabled: getSetting('push_enabled') !== 'off' }));
app.post('/api/push/subscribe', (req, res) => {
  try { push.subscribe(req.body.subscription, req.body.device); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/push/unsubscribe', (req, res) => { push.unsubscribe(req.body.endpoint || ''); res.json({ ok: true }); });
app.post('/api/push/test', async (req, res) => {
  const n = await push.notify({ title: 'JobTrack', body: 'Notifications are working. You\'ll hear about new applications, interviews and rejections here.', url: '/#/inbox', tag: 'test' });
  res.json({ sent: n });
});

// ---------- PWA share target (Android "Share → JobTrack") ----------
app.get('/share', (req, res) => {
  const url = req.query.url || (String(req.query.text || '').match(/https?:\/\/\S+/) || [])[0] || '';
  res.redirect(`/#/new?url=${encodeURIComponent(url)}&title=${encodeURIComponent(req.query.title || '')}`);
});

// ---------- Static app ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

mail.startScheduler();
app.listen(PORT, HOST, () => {
  console.log(`\n  JobTrack running → http://localhost:${PORT}`);
  console.log(`  Bound to ${HOST} only. For phone access: tailscale serve --bg ${PORT}\n`);
});
