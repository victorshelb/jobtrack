// Push notifications to the installed JobTrack app on your phone (and desktop browsers).
// Works on iPhone (iOS 16.4+, app added to Home Screen) and Android. Messages are end-to-end
// encrypted by the Web Push standard; Apple/Google only relay ciphertext.
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, device TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);

function vapid() {
  let pub = getSetting('vapid_public'), priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    setSetting('vapid_public', pub); setSetting('vapid_private', priv);
  }
  webpush.setVapidDetails('mailto:jobtrack@localhost.invalid', pub, priv);
  return pub;
}

function subscribe(sub, device) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid subscription');
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Invalid push endpoint');
  db.prepare('INSERT INTO push_subs(endpoint, keys, device) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, device=excluded.device')
    .run(sub.endpoint, JSON.stringify(sub.keys), (device || '').slice(0, 120));
}
const unsubscribe = (endpoint) => db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint);
const devices = () => db.prepare('SELECT endpoint, device, created_at FROM push_subs ORDER BY created_at').all();

async function notify({ title, body, url = '/', tag }) {
  if (getSetting('push_enabled') === 'off') return 0;
  vapid();
  let sent = 0;
  for (const s of db.prepare('SELECT * FROM push_subs').all()) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title, body, url, tag }), { TTL: 86400 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); // device unsubscribed / expired
      else console.warn('push failed', e.statusCode || e.message);
    }
  }
  return sent;
}

module.exports = { vapid, subscribe, unsubscribe, devices, notify };
