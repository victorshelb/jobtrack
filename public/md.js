// Tiny, safe Markdown renderer (escapes HTML first).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '', list = null, para = [], table = null;
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => inline(c.trim())));
    html += '<table>' + rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('') + '</table>';
    table = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table ||= []).push(line); continue; } else flushTable();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); const n = Math.min(m[1].length, 3); html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,}|={3,}.*)$/.test(line.trim())) { flushPara(); flushList(); html += '<hr>'; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList(); flushTable();
  return html;
}
