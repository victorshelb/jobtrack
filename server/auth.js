const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');

const SESSION_DAYS = 30;
const attempts = new Map(); // ip -> { count, until }

function hash(pass, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pass, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verify(pass, stored) {
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(pass, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
}

function apiToken() {
  let t = getSetting('api_token');
  if (!t) { t = crypto.randomBytes(24).toString('hex'); setSetting('api_token', t); }
  return t;
}

function newSession(res, req) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions(token, expires_at) VALUES(?, datetime('now', '+${SESSION_DAYS} days'))`).run(token);
  res.cookie('jt_session', token, {
    httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_DAYS * 864e5, path: '/',
  });
}

function isAuthed(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    const t = apiToken();
    return bearer.length === t.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(t));
  }
  const s = req.cookies?.jt_session;
  if (!s) return false;
  return !!db.prepare(`SELECT 1 FROM sessions WHERE token=? AND expires_at > datetime('now')`).get(s);
}

function routes(app) {
  app.get('/api/auth/status', (req, res) => {
    res.json({ setup: !!getSetting('pin_hash'), hasEmail: !!getSetting('account_email'), authed: isAuthed(req) });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (getSetting('pin_hash')) return res.status(400).json({ error: 'Already set up' });
    const { pin, name, email } = req.body || {};
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter your name and a valid email' });
    if (!pin || String(pin).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    setSetting('pin_hash', hash(String(pin)));
    setSetting('account_email', email.trim().toLowerCase());
    setSetting('profile', JSON.stringify({ name: name.trim(), email: email.trim() }));
    apiToken();
    newSession(res, req);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { count: 0, until: 0 };
    if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const stored = getSetting('pin_hash');
    const email = getSetting('account_email');
    const emailOk = !email || String(req.body?.email || '').trim().toLowerCase() === email;
    if (!stored || !verify(String(req.body?.pin || ''), stored) || !emailOk) {
      a.count++;
      if (a.count >= 5) { a.until = Date.now() + 5 * 60e3; a.count = 0; }
      attempts.set(ip, a);
      return res.status(401).json({ error: email ? 'Wrong email or password' : 'Wrong password' });
    }
    attempts.delete(ip);
    newSession(res, req);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies?.jt_session) db.prepare('DELETE FROM sessions WHERE token=?').run(req.cookies.jt_session);
    res.clearCookie('jt_session');
    res.json({ ok: true });
  });

  // Everything else under /api requires auth
  app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Not signed in' })));

  app.get('/api/auth/token', (req, res) => res.json({ token: apiToken() }));

  // Account: email + password changes require the current password
  app.post('/api/auth/account', (req, res) => {
    const { current, email, password } = req.body || {};
    if (!verify(String(current || ''), getSetting('pin_hash'))) return res.status(401).json({ error: 'Current password is wrong' });
    if (email !== undefined) {
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
      setSetting('account_email', email.trim().toLowerCase());
    }
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      setSetting('pin_hash', hash(String(password)));
      db.prepare('DELETE FROM sessions WHERE token != ?').run(req.cookies?.jt_session || ''); // sign out other devices
    }
    res.json({ ok: true, email: getSetting('account_email') });
  });
  app.post('/api/auth/token/rotate', (req, res) => {
    setSetting('api_token', crypto.randomBytes(24).toString('hex'));
    res.json({ token: apiToken() });
  });
}

module.exports = { routes, isAuthed };
