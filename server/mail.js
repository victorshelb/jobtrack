// Gmail sync: finds job-related emails, links each to an application, classifies it
// (rejection / interview / assessment / offer / received / viewed) and updates the application's status.
// Read-only: the mailbox is opened with EXAMINE, so nothing is ever marked read, moved or deleted.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const { db, getSetting, setSetting } = require('./db');
const { getSecret } = require('./secrets');
const { fetchJob, canonicalUrl } = require('./jobs');
const ai = require('./ai');
const push = require('./push');

db.exec(`
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  thread_id TEXT,
  uid INTEGER,
  from_name TEXT, from_email TEXT, subject TEXT,
  date TEXT,
  snippet TEXT, body TEXT,
  app_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  match_score REAL DEFAULT 0,
  matched_by TEXT DEFAULT 'auto',           -- auto | manual
  category TEXT DEFAULT 'other',            -- rejection|interview|assessment|offer|received|viewed|other
  category_by TEXT DEFAULT 'auto',
  applied_status TEXT,                      -- status this email moved the application to, if any
  seen INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS emails_app ON emails(app_id);
`);
if (!db.prepare('PRAGMA table_info(emails)').all().some((c) => c.name === 'account')) {
  db.exec(`ALTER TABLE emails ADD COLUMN account TEXT`);
  db.prepare('UPDATE emails SET account=? WHERE account IS NULL').run(getSetting('mail_user') || null);
}

// ---------- classification ----------
const RULES = [
  ['offer', /\b(pleased|delighted|happy|excited) to (offer|extend)|offer of employment|formal offer|job offer|offer letter|verbal offer/i],
  ['rejection', /unfortunately|regret to (inform|let you know|advise)|not (be )?(moving|progressing|proceeding|taking) (forward |further )?(with )?your|decided not to (move|proceed|progress|continue)|decided to (move|proceed|progress|go) (forward )?with (other|another|a different)|other candidates (whose|who)|more closely (match|align)|not been successful|were unsuccessful|unsuccessful on this occasion|position has (now )?been filled|role has (now )?been filled|no longer (being )?(considered|under consideration)|will not be (moving|progressing)|not selected|decided to pursue other/i],
  ['interview', /invite you (to|for) (an? |the )?(first |second |final |next |initial )?(stage )?(interview|call|chat|conversation|meeting)|(schedule|arrange|book|set up) (an? |your |the )?(interview|call|time|slot|chat)|interview (invitation|request|confirmation)|availability for (an? )?(interview|call|chat)|move (you )?(forward|on) to the (next|interview) stage|calendly\.com|would like to (speak|talk|chat) (with|to) you|next stage of (the|our) (process|recruitment)/i],
  ['assessment', /online (assessment|test)|coding (challenge|test|assessment)|technical (test|assessment|exercise)|take[- ]home|hackerrank|codility|testgorilla|hirevue|sova|psychometric|situational judg|video interview|complete (the|an|your) assessment/i],
  ['received', /thank(s| you) for (your )?(applying|application|interest in)|(we('ve| have)|has been) received your application|application (has been |was )?(received|submitted|sent)|your application (to|for) .{0,80} (was|has been) (sent|received)|successfully applied/i],
  ['viewed', /viewed your application|application (was|has been) viewed|looked at your application/i],
];
function classify(subject, body) {
  const text = `${subject}\n${(body || '').slice(0, 5000)}`;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return 'other';
}
const STATUS_FOR = { rejection: 'rejected', interview: 'interview', assessment: 'screening', offer: 'offer' };

// ---------- reading confirmation emails (apply anywhere: phone apps, job boards, company sites) ----------
const PLATFORMS = [['linkedin', 'LinkedIn'], ['indeed', 'Indeed'], ['totaljobs', 'Totaljobs'], ['cv-library', 'CV-Library'], ['cvlibrary', 'CV-Library'],
  ['reed.co.uk', 'Reed'], ['glassdoor', 'Glassdoor'], ['otta', 'Otta'], ['welcometothejungle', 'WTTJ'], ['monster', 'Monster'], ['adzuna', 'Adzuna'],
  ['jobsite', 'Jobsite'], ['civilservicejobs', 'Civil Service Jobs'], ['nhs.', 'NHS Jobs'], ['greenhouse', 'Greenhouse'], ['lever', 'Lever'],
  ['myworkday', 'Workday'], ['ashby', 'Ashby'], ['smartrecruiters', 'SmartRecruiters'], ['workable', 'Workable'], ['teamtailor', 'Teamtailor']];
const platformOf = (e) => PLATFORMS.find(([k]) => `${e.from_email} ${e.from_name}`.toLowerCase().includes(k))?.[1] || '';
const ATS_SENDER = /greenhouse|lever|myworkday|workday|ashby|smartrecruiters|workable|teamtailor|recruitee|bamboohr|icims|jobvite|pinpoint|personio|breezy/i;
const cleanCo = (c) => (c || '').replace(/^(the )?(team at|hiring team at)\s+/i, '').replace(/[!.,:;]+$/, '').replace(/\s+(team|careers|recruiting|recruitment|talent( acquisition)?|hiring( team)?|hr)$/i, '').trim().slice(0, 80);
const cleanRole = (r) => (r || '').replace(/^(the |a |an )/i, '').replace(/\s+(position|role|vacancy|job)$/i, '').replace(/[!.,:;]+$/, '').replace(/\s*\(.*?ref.*?\)$/i, '').trim().slice(0, 120);

function jobLink(text) {
  let m;
  if ((m = text.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/\s"?]*?-)?(\d{6,})/i))) return `https://www.linkedin.com/jobs/view/${m[1]}/`;
  if ((m = text.match(/https?:\/\/[a-z.]*indeed\.[a-z.]+\/[^\s"<>]*?[?&](?:jk|vjk)=([a-f0-9]{10,})/i))) return `https://uk.indeed.com/viewjob?jk=${m[1]}`;
  if ((m = text.match(/https?:\/\/(?:www\.)?(?:totaljobs\.com|cv-library\.co\.uk|reed\.co\.uk|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.ashbyhq\.com|[a-z0-9-]+\.myworkdayjobs\.com)\/[^\s"<>)]*?(?:job|jobs|apply)[^\s"<>)]*/i))) return canonicalUrl(m[0]);
  return '';
}

// Regex first (fast, free). Returns whatever it could find; Claude fills the gaps later.
function extractJob(e) {
  const s = (e.subject || '').replace(/^(re|fwd?):\s*/i, '').trim();
  const b = (e.body || '').slice(0, 6000);
  const out = { company: '', role: '', url: jobLink(b), source: platformOf(e) };
  let m;
  if ((m = s.match(/application was sent to (.+)$/i))) {                       // LinkedIn
    out.company = m[1];
    const lines = b.split('\n').map((x) => x.trim()).filter(Boolean);
    const i = lines.findIndex((l) => /application was sent to/i.test(l));
    if (i >= 0 && lines[i + 1] && !/^(applied|view|see)/i.test(lines[i + 1])) out.role = lines[i + 1];
  } else if ((m = s.match(/^indeed application:\s*(.+)$/i))) {                 // Indeed
    out.role = m[1];
    if ((m = b.match(/(?:submitted|sent|delivered) to ([^\n.]+?)(?:\.|\n| on )/i))) out.company = m[1];
  } else if ((m = s.match(/application (?:for|to) (?:the )?(.+?) (?:at|with) (.+?)(?: (?:has been|was|is) .*)?$/i))) {
    out.role = m[1]; out.company = m[2];
  } else if ((m = s.match(/(?:thank(?:s| you) for (?:applying|your application|your interest)) (?:to|at|with|in) (.+?)(?:[!.]|$)/i))) {
    out.company = m[1];
  } else if ((m = s.match(/your application (?:to|with|at) (.+?)(?: (?:has|was|is) .*)?$/i))) {
    out.company = m[1];
  } else if ((m = s.match(/(?:application|applied)(?: confirmation| received| submitted| sent)?\s*[-:–|]\s*(.+?)(?:\s+(?:at|with|[-–|])\s+(.+))?$/i))) {
    out.role = m[1]; out.company = m[2] || '';
  }
  if ((!out.role || !out.company) && (m = b.match(/(?:applied|application|applying) for (?:the )?(?:position of |role of |post of )?([^\n.]{3,80}?) (?:at|with) ([A-Z][^\n.,]{1,60})/))) { out.role ||= m[1]; out.company ||= m[2]; }
  // Workday sends from <company>@myworkday.com; other ATSs usually put the company in the sender name
  if (!out.company && /@myworkday(jobs)?\.com$/i.test(e.from_email)) out.company = e.from_email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!out.company && ATS_SENDER.test(e.from_email) && !ATS_SENDER.test(e.from_name)) out.company = e.from_name;
  if (/^(we|you|our|us|linkedin|indeed|workday|greenhouse|lever)$/i.test(out.company) || out.company.toLowerCase() === out.source.toLowerCase()) out.company = '';
  out.company = cleanCo(out.company); out.role = cleanRole(out.role);
  return out;
}

// For confirmations the patterns couldn't read: one batched Claude call (no tools, your Pro plan)
async function extractWithClaude(emails) {
  if (!emails.length) return [];
  const prompt = `Each item below is an email confirming a job application. Extract the hiring company (the employer, not the job board or ATS) and the job title.
Return ONLY a JSON array, one object per item in the same order: {"i": <index>, "company": "...", "role": "..."}. Use "" when the email does not say.

${emails.map((e, i) => `### ITEM ${i}\nFrom: ${e.from_name} <${e.from_email}>\nSubject: ${e.subject}\n${(e.body || '').slice(0, 1500)}`).join('\n\n')}`;
  const text = await ai.ask(prompt);
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  return JSON.parse(json);
}

const roleSimilar = (a, b) => {
  const w = (x) => new Set((x || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1));
  const x = w(a), y = w(b);
  if (!x.size || !y.size) return true; // unknown role: don't block a company match
  return [...x].filter((t) => y.has(t)).length / Math.min(x.size, y.size) >= 0.5;
};

// Which CV did you send? 1) a file named in the email (Indeed and many ATSs list it),
// 2) otherwise the CV that best matches the job description, 3) otherwise your default CV.
const { match: keywordMatch } = require('./match');
function pickCv(e, jd, company) {
  const all = db.prepare(`SELECT id, parent_id, version, title, filename, text, kind FROM documents WHERE kind='cv'`).all();
  const latest = new Map();
  for (const d of all) { const r = d.parent_id || d.id; if (!latest.has(r) || d.version > latest.get(r).version) latest.set(r, d); }
  const cvs = [...latest.values()];
  if (!cvs.length) return null;
  const text = (e.body || '').toLowerCase();
  const named = cvs.find((d) => [d.filename, d.title].filter(Boolean).some((n) => {
    const base = n.toLowerCase().replace(/\.(pdf|docx?|txt|md)$/, '');
    return base.length > 3 && text.includes(base);
  }));
  if (named) return { ...named, why: 'named in the confirmation email' };
  if (jd && cvs.length > 1) {
    const ranked = cvs.map((d) => ({ d, s: keywordMatch(jd, d.text || '', company).score })).sort((a, b) => b.s - a.s);
    if (ranked[0].s > 0) return { ...ranked[0].d, why: `best keyword match for this job, ${ranked[0].s}%` };
  }
  try {
    const p = JSON.parse(getSetting('profile') || '{}');
    const def = p.default_cv_id && cvs.find((d) => String(d.parent_id || d.id) === String(p.default_cv_id) || String(d.id) === String(p.default_cv_id));
    if (def) return { ...def, why: 'your default CV' };
  } catch {}
  return cvs.length === 1 ? { ...cvs[0], why: 'your only CV' } : null;
}

// Create an application from a confirmation email (deduped against what's already tracked)
async function addFromEmail(e, job) {
  if (!job.company) return null;
  const apps = db.prepare('SELECT * FROM applications').all();
  const nc = norm(job.company);
  const existing = apps.find((a) => norm(a.company) === nc && roleSimilar(a.role, job.role));
  let id;
  if (existing) id = existing.id;
  else {
    let details = {};
    if (job.url) { try { details = await fetchJob(job.url); } catch {} }
    const at = e.date.slice(0, 19).replace('T', ' ');
    const r = db.prepare(`INSERT INTO applications(company, role, url, source, location, logo_url, jd_text, status, applied_at, status_updated_at, notes)
      VALUES(?,?,?,?,?,?,?,'applied',?,?,?)`).run(
      job.company, job.role || details.role || '', job.url || '', job.source || details.source || 'Email', details.location || '', details.logo_url || '',
      details.jd_text || '', at, at, `Added automatically from a confirmation email: "${e.subject}"`);
    id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO status_history(app_id,status,at) VALUES(?,?,?)').run(id, 'applied', at);
    // Attach the CV you most likely sent (see pickCv)
    try {
      const pick = pickCv(e, details.jd_text || '', job.company);
      if (pick) {
        db.prepare('INSERT OR IGNORE INTO app_documents(app_id, doc_id) VALUES(?,?)').run(id, pick.id);
        db.prepare(`UPDATE applications SET notes = notes || ? WHERE id=?`).run(`\nCV attached automatically: "${pick.title}" (${pick.why}). Change it if that's wrong.`, id);
      }
    } catch (err) { console.warn('CV pick failed', err.message); }
  }
  db.prepare(`UPDATE emails SET app_id=?, match_score=10, applied_status=? WHERE id=?`).run(id, existing ? null : 'applied', e.id);
  return existing ? null : { id, company: job.company, role: job.role, source: job.source };
}

// ---------- matching ----------
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol|greenhouse|greenhouse-mail|lever|hire|myworkday|myworkdayjobs|workday|ashbyhq|ashby|smartrecruiters|icims|workable|workablemail|bamboohr|teamtailor|recruitee|jobvite|taleo|successfactors|linkedin|indeed|indeedemail|reed|totaljobs|glassdoor|otta|welcometothejungle|pinpointhq|personio|rippling|breezy|applytojob|jazzhr|hirebridge|beamery|eightfold|avature|oraclecloud|sendgrid|mailgun|amazonses|mail|email|noreply|no-reply|notifications|careers|jobs|talent|recruiting|recruitment|hr|people)$/i;
const norm = (s) => (s || '').toLowerCase().replace(/\b(inc|ltd|llc|plc|limited|corp|corporation|group|gmbh|uk|the|co)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (text, phrase) => phrase.length > 2 && new RegExp(`(^|[^a-z0-9])${esc(phrase.toLowerCase())}($|[^a-z0-9])`, 'i').test(text);

function domainWords(email) {
  const host = (email.split('@')[1] || '').toLowerCase();
  return host.split('.').slice(0, -1).filter((p) => p.length > 1 && !GENERIC_DOMAINS.test(p) && !/^(co|com|org|net|io|ac)$/.test(p)).map((p) => p.replace(/[^a-z0-9]/g, ''));
}

function matchApp(mail, apps) {
  const subj = (mail.subject || '').toLowerCase();
  const body = (mail.body || '').slice(0, 6000).toLowerCase();
  const fromName = (mail.from_name || '').toLowerCase();
  const dWords = domainWords(mail.from_email || '');
  const mailDate = new Date(mail.date);
  let best = null;
  for (const a of apps) {
    if (!a.company) continue;
    const since = new Date(((a.applied_at && a.applied_at < a.created_at) ? a.applied_at : a.created_at).replace(' ', 'T') + 'Z');
    if (mailDate < new Date(since - 21 * 864e5)) continue; // can't be a reply to something you hadn't applied for yet
    const c = norm(a.company), name = a.company.replace(/\b(Ltd|Limited|PLC|Inc|LLC|Group)\b\.?/gi, '').trim();
    let score = 0;
    if (dWords.some((w) => w === c || (c.length > 3 && (w.includes(c) || c.includes(w)) && w.length > 3))) score += 5;
    if (c && norm(fromName).includes(c)) score += 4;
    if (wordIn(subj, name)) score += 4;
    else if (wordIn(body, name)) score += 2;
    if (a.role && wordIn(subj, a.role)) score += 2;
    else if (a.role && wordIn(body, a.role)) score += 1.5;
    if (score > (best?.score || 0) || (score === best?.score && a.id > best.app.id)) best = { app: a, score };
  }
  return best && best.score >= 4 ? best : null;
}

// ---------- applying results ----------
const ORDER = ['draft', 'applied', 'screening', 'interview', 'offer'];
function applyStatus(emailId) {
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(emailId);
  if (!e?.app_id) return null;
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(e.app_id);
  let next = STATUS_FOR[e.category];
  if (e.category === 'received' && a.status === 'draft') next = 'applied';
  if (!next || next === a.status) return null;
  // Only move forward through the pipeline; a rejection or offer always counts. Never undo a newer manual change.
  const emailAt = e.date.slice(0, 19).replace('T', ' ');
  if (a.status_manual_at && emailAt < a.status_manual_at) return null;
  if (!['rejected', 'offer'].includes(next) && ORDER.includes(a.status) && ORDER.indexOf(next) <= ORDER.indexOf(a.status)) return null;
  if (a.status === 'offer' && next !== 'offer') return null;
  db.prepare('UPDATE applications SET status=?, status_updated_at=? WHERE id=?').run(next, emailAt > (a.status_updated_at || '') ? emailAt : a.status_updated_at, a.id);
  if (next === 'applied' && !a.applied_at) db.prepare('UPDATE applications SET applied_at=? WHERE id=?').run(emailAt, a.id);
  db.prepare('INSERT INTO status_history(app_id,status,at) VALUES(?,?,?)').run(a.id, next, emailAt);
  db.prepare('UPDATE emails SET applied_status=? WHERE id=?').run(next, e.id);
  return next;
}

function htmlToText(html) {
  const $ = cheerio.load(html || '');
  $('script,style,head').remove();
  $('br').replaceWith('\n'); $('p,div,tr,li,h1,h2,h3').each((_, el) => $(el).append('\n'));
  return $.text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// ---------- sync ----------
const QUERY = '-in:sent -in:chats -in:drafts {application applying applied interview unfortunately candidacy "next steps" recruitment recruiter assessment "your interest" vacancy hiring "thank you for applying" "position" "role" offer}';
let syncing = null;

// ---------- accounts (you can connect several Gmail addresses, e.g. personal + student) ----------
function accounts() {
  let list = [];
  try { list = JSON.parse(getSetting('mail_accounts') || '[]'); } catch {}
  const legacy = getSetting('mail_user');                       // migrate the single-account setting
  if (legacy && !list.includes(legacy)) { list.push(legacy); setSetting('mail_accounts', JSON.stringify(list)); }
  return list;
}
const setAccounts = (list) => { setSetting('mail_accounts', JSON.stringify([...new Set(list)])); setSetting('mail_user', list[0] || ''); };
const accountState = (user) => ({ user, last_sync: getSetting(`mail_last_sync:${user}`) || null, last_error: getSetting(`mail_error:${user}`) || '' });

async function connect(user) {
  const pass = await getSecret(`imap:${user}`);
  if (!pass) throw new Error('App password missing from Keychain. Reconnect this account in Profile → Email.');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, emitLogs: false });
  await client.connect();
  return client;
}

async function testConnection(user, pass) {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  try { await client.connect(); await client.logout(); return true; }
  catch (e) { throw new Error(e.authenticationFailed || /auth/i.test(e.message) ? 'Gmail rejected the email or app password' : `Couldn't connect: ${e.message}`); }
}

// Pull new job-related emails from one mailbox into the emails table
async function fetchAccount(user, days, stats) {
  const client = await connect(user);
  try {
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === '\\All')?.path || 'INBOX';
    const lock = await client.getMailboxLock(all, { readOnly: true });
    try {
      const window = days || (getSetting(`mail_last_sync:${user}`) ? 14 : 90);
      let uids = await client.search({ gmraw: `newer_than:${window}d ${QUERY}` }, { uid: true });
      uids = (uids || []).sort((a, b) => a - b).slice(-400);
      const known = new Set(db.prepare('SELECT uid FROM emails WHERE uid IS NOT NULL AND account=?').all(user).map((r) => r.uid));
      const todo = uids.filter((u) => !known.has(u));
      const apps = db.prepare('SELECT * FROM applications').all();
      if (!todo.length) return;
      for await (const msg of client.fetch(todo, { uid: true, envelope: true, source: true, threadId: true }, { uid: true })) {
        stats.scanned++;
        const p = await simpleParser(msg.source);
        const body = (p.text && p.text.trim()) || htmlToText(p.html);
        const from = p.from?.value?.[0] || {};
        const rec = {
          message_id: p.messageId || `${user}-uid-${msg.uid}`, thread_id: msg.threadId || null, uid: msg.uid,
          from_name: from.name || '', from_email: (from.address || '').toLowerCase(), subject: p.subject || '(no subject)',
          date: (p.date || new Date()).toISOString(), body: body.slice(0, 30000),
        };
        rec.snippet = body.replace(/\s+/g, ' ').slice(0, 240);
        rec.category = classify(rec.subject, body);
        rec.attachments = (p.attachments || []).map((x) => x.filename).filter(Boolean).join('\n');
        let m = matchApp(rec, apps);
        if (m && rec.category === 'received') {
          const job = extractJob(rec);
          if (job.role && !roleSimilar(m.app.role, job.role)) m = null; // new role at a company you've applied to before
        }
        if (rec.category === 'other' && !m) continue; // not job-related enough to keep
        const r = db.prepare(`INSERT OR IGNORE INTO emails(message_id,thread_id,uid,account,from_name,from_email,subject,date,snippet,body,app_id,match_score,category)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(rec.message_id, rec.thread_id, rec.uid, user, rec.from_name, rec.from_email, rec.subject, rec.date, rec.snippet,
          rec.attachments ? `${rec.body}\n\n[Attachments]\n${rec.attachments}` : rec.body, m?.app.id || null, m?.score || 0, rec.category);
        if (!r.changes) continue;
        stats.saved++;
        if (m) stats.matched++;
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

async function sync({ days, only } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const stats = { scanned: 0, saved: 0, matched: 0, statusChanges: [], added: [], errors: [] };
    const list = only ? [only] : accounts();
    if (!list.length) throw new Error('Email is not connected');
    for (const user of list) {
      try { await fetchAccount(user, days, stats); setSetting(`mail_last_sync:${user}`, new Date().toISOString()); setSetting(`mail_error:${user}`, ''); }
      catch (e) { setSetting(`mail_error:${user}`, `${new Date().toISOString()} ${e.message}`); stats.errors.push(`${user}: ${e.message}`); }
    }
    if (stats.errors.length === list.length) throw new Error(stats.errors.join('; '));

    // Applications you made elsewhere (phone apps, job boards): create them from confirmation emails
    if (getSetting('auto_add') !== 'off') {
      const pending = db.prepare(`SELECT * FROM emails WHERE app_id IS NULL AND category='received' AND matched_by='auto' ORDER BY date`).all();
      const needAI = [];
      for (const e of pending) {
        const job = extractJob(e);
        if (job.company && (job.role || job.url)) { const a = await addFromEmail(e, job); if (a) stats.added.push(a); }
        else needAI.push({ e, job });
      }
      for (let i = 0; i < needAI.length; i += 12) {
        const batch = needAI.slice(i, i + 12);
        try {
          const res = await extractWithClaude(batch.map((x) => x.e));
          for (const r of res) {
            const item = batch[r.i]; if (!item) continue;
            const job = { ...item.job, company: cleanCo(r.company || item.job.company), role: cleanRole(r.role || item.job.role) };
            const a = await addFromEmail(item.e, job); if (a) stats.added.push(a);
          }
        } catch (err) { console.warn('Claude extraction skipped:', err.message); }
      }
    }
    // Apply status changes oldest → newest so the latest email wins
    for (const e of db.prepare(`SELECT id, app_id FROM emails WHERE app_id IS NOT NULL AND applied_status IS NULL AND category IN ('rejection','interview','assessment','offer','received') ORDER BY date`).all()) {
      const s = applyStatus(e.id);
      if (s) stats.statusChanges.push({ app_id: e.app_id, status: s });
    }
    setSetting('mail_last_sync', new Date().toISOString());
    setSetting('mail_last_error', stats.errors.join('; '));
    notifyResults(stats).catch((e) => console.warn('notify failed', e.message));
    setSetting('mail_last_result', JSON.stringify(stats));
    return stats;
  })();
  try { return await syncing; } finally { syncing = null; }
}

// Phone notifications, only for recent emails (the first 90-day scan shouldn't buzz 40 times)
async function notifyResults(stats) {
  const recent = (iso) => Date.now() - new Date(iso) < 3 * 864e5;
  for (const a of stats.added || []) {
    const e = db.prepare('SELECT date FROM emails WHERE app_id=? ORDER BY date LIMIT 1').get(a.id);
    if (e && recent(e.date)) await push.notify({ title: `Tracked: ${a.role || 'new application'}`, body: `${a.company}${a.source ? ` · applied via ${a.source}` : ''}. Tap to check the CV is right.`, url: `/#/app/${a.id}`, tag: `app-${a.id}` });
  }
  const MSG = { rejected: ['Not this time', 'won\'t be progressing your application'], interview: ['Interview!', 'wants to interview you'],
    screening: ['Assessment', 'sent you an assessment'], offer: ['Offer!', 'made you an offer'] };
  for (const c of stats.statusChanges || []) {
    const [t, verb] = MSG[c.status] || []; if (!t) continue;
    const a = db.prepare('SELECT company, role FROM applications WHERE id=?').get(c.app_id);
    const e = db.prepare(`SELECT date FROM emails WHERE app_id=? AND applied_status=? ORDER BY date DESC LIMIT 1`).get(c.app_id, c.status);
    if (a && e && recent(e.date)) await push.notify({ title: `${t} · ${a.company}`, body: `${a.company} ${verb} (${a.role}).`, url: `/#/app/${c.app_id}${c.status === 'rejected' ? '/insight' : ''}`, tag: `status-${c.app_id}` });
  }
}

// Re-run matching for unmatched emails (e.g. after you add a new application)
function rematch() {
  const apps = db.prepare('SELECT * FROM applications').all();
  let n = 0;
  for (const e of db.prepare(`SELECT * FROM emails WHERE app_id IS NULL AND matched_by='auto'`).all()) {
    const m = matchApp(e, apps);
    if (m) { db.prepare('UPDATE emails SET app_id=?, match_score=? WHERE id=?').run(m.app.id, m.score, e.id); applyStatus(e.id); n++; }
  }
  return n;
}

let timer;
function startScheduler() {
  clearInterval(timer);
  const tick = () => { if (accounts().length) sync().catch((e) => { setSetting('mail_last_error', `${new Date().toISOString()} ${e.message}`); }); };
  setTimeout(tick, 20e3);
  timer = setInterval(tick, 15 * 60e3);
}

module.exports = { accounts, setAccounts, accountState, extractJob, addFromEmail, notifyResults, sync, testConnection, rematch, applyStatus, classify, matchApp, startScheduler, STATUS_FOR, isSyncing: () => !!syncing };
