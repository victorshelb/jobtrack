const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { db, FILES_DIR } = require('./db');

async function extractText(buf, mime, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  try {
    if (mime === 'application/pdf' || ext === '.pdf') return tidy((await pdfParse(buf)).text);
    if (ext === '.docx' || mime?.includes('wordprocessingml')) return tidy((await mammoth.extractRawText({ buffer: buf })).value);
    if (ext === '.txt' || ext === '.md' || mime?.startsWith('text/')) return buf.toString('utf8');
  } catch (e) {
    console.warn('Text extraction failed for', filename, e.message);
  }
  return '';
}

const tidy = (t) => (t || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function guessKind(name = '') {
  const n = name.toLowerCase();
  if (/cover|letter|motivation/.test(n)) return 'cover_letter';
  if (/cv|resume|résumé/.test(n)) return 'cv';
  return 'cv';
}

async function saveUpload({ buffer, originalname, mimetype }, { kind, title, parent_id } = {}) {
  const safe = originalname.replace(/[^\w.\- ]+/g, '_').slice(-80);
  const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
  fs.writeFileSync(path.join(FILES_DIR, stored), buffer, { mode: 0o600 });
  const text = await extractText(buffer, mimetype, originalname);
  return insertDoc({
    kind: kind || guessKind(originalname), title: title || originalname.replace(/\.[^.]+$/, ''),
    parent_id, filename: originalname, mime: mimetype, path: stored, text,
  });
}

function insertDoc({ kind, title, parent_id = null, filename = null, mime = null, path: p = null, text = '' }) {
  let version = 1;
  if (parent_id) {
    const root = rootOf(parent_id);
    parent_id = root;
    version = (db.prepare('SELECT MAX(version) v FROM documents WHERE id=? OR parent_id=?').get(root, root).v || 1) + 1;
  }
  const r = db.prepare(`INSERT INTO documents(kind,title,parent_id,version,filename,mime,path,text) VALUES(?,?,?,?,?,?,?,?)`)
    .run(kind, title, parent_id, version, filename, mime, p, text);
  return db.prepare('SELECT * FROM documents WHERE id=?').get(r.lastInsertRowid);
}

function rootOf(id) {
  const d = db.prepare('SELECT id,parent_id FROM documents WHERE id=?').get(id);
  return d?.parent_id || d?.id;
}

// Very small markdown subset -> docx: "# " headings, "- " bullets, **bold**
async function toDocx(doc) {
  const paras = (doc.text || '').split('\n').map((line) => {
    const runs = (s) => s.split(/(\*\*[^*]+\*\*)/).filter(Boolean)
      .map((p) => (p.startsWith('**') ? new TextRun({ text: p.slice(2, -2), bold: true }) : new TextRun(p)));
    if (/^# /.test(line)) return new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(line.slice(2)) });
    if (/^## /.test(line)) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(line.slice(3)) });
    if (/^### /.test(line)) return new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs(line.slice(4)) });
    if (/^\s*[-*•] /.test(line)) return new Paragraph({ bullet: { level: 0 }, children: runs(line.replace(/^\s*[-*•] /, '')) });
    return new Paragraph({ children: runs(line) });
  });
  const d = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: paras }],
  });
  return Packer.toBuffer(d);
}

module.exports = { saveUpload, insertDoc, extractText, toDocx, rootOf, guessKind };
