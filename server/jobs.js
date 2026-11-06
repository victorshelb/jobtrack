// Pull company / role / description out of a job posting page.
// Most ATS pages (Greenhouse, Lever, Workday, Ashby, LinkedIn) embed schema.org JobPosting JSON-LD.
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const ATS = [
  ['greenhouse.io', 'Greenhouse'], ['lever.co', 'Lever'], ['myworkdayjobs.com', 'Workday'], ['workday.com', 'Workday'],
  ['ashbyhq.com', 'Ashby'], ['smartrecruiters.com', 'SmartRecruiters'], ['icims.com', 'iCIMS'], ['taleo.net', 'Taleo'],
  ['linkedin.com', 'LinkedIn'], ['indeed.', 'Indeed'], ['workable.com', 'Workable'], ['bamboohr.com', 'BambooHR'],
  ['teamtailor.com', 'Teamtailor'], ['recruitee.com', 'Recruitee'], ['jobvite.com', 'Jobvite'], ['successfactors', 'SuccessFactors'],
  ['glassdoor.', 'Glassdoor'], ['reed.co.uk', 'Reed'], ['totaljobs.com', 'Totaljobs'], ['otta.com', 'Otta'], ['welcometothejungle', 'WTTJ'],
];
const sourceOf = (url) => ATS.find(([h]) => url.includes(h))?.[1] || '';

function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:127.');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function strip(html) {
  let src = html || '';
  if (/&lt;\w/.test(src)) src = cheerio.load(`<div>${src}</div>`)('div').text(); // HTML-escaped HTML (Greenhouse)
  const $ = cheerio.load(`<div id="jt">${src}</div>`);
  return htmlToText($, $('#jt').get(0));
}

function htmlToText($, el) {
  $(el).find('script,style,nav,header,footer,noscript,svg,form').remove();
  $(el).find('br').replaceWith('\n');
  $(el).find('p,div,h1,h2,h3,h4,section,tr').each((_, e) => { $(e).prepend('\n'); });
  $(el).find('li').each((_, e) => { $(e).prepend('\n• '); });
  return $(el).text().replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// One stable URL per job, so tracking/lookup works on search pages that only change a query param
const TRACKING = /^(utm_|ref|refid|trackingid|eBP|trk|lipi|src|source|gh_src|lever-|origin|position|pagenum|savedsearchid|alertaction)/i;
function linkedinJobId(url) {
  try {
    const u = new URL(url);
    if (!/linkedin\.com$/.test(u.hostname.replace(/^www\./, '').replace(/^[a-z]{2}\./, ''))) return null;
    return u.searchParams.get('currentJobId') || (u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/) || [])[1] || null;
  } catch { return null; }
}
function canonicalUrl(url) {
  try {
    const li = linkedinJobId(url);
    if (li) return `https://www.linkedin.com/jobs/view/${li}/`;
    const u = new URL(url);
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    if (/indeed\./.test(u.hostname) && jk) return `https://${u.hostname}/viewjob?jk=${jk}`;
    [...u.searchParams.keys()].forEach((k) => { if (TRACKING.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    return u.toString();
  } catch { return url || ''; }
}

// LinkedIn's public job endpoint has clean title/company/description (no sidebar of other jobs)
async function fetchLinkedIn(id) {
  const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
    signal: AbortSignal.timeout(15000), headers: { 'user-agent': UA, accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`LinkedIn returned ${r.status}`);
  const $ = cheerio.load(await r.text());
  const desc = $('.show-more-less-html__markup').first();
  return {
    url: `https://www.linkedin.com/jobs/view/${id}/`, source: 'LinkedIn',
    role: $('.topcard__title').first().text().trim(),
    company: $('.topcard__org-name-link').first().text().trim() || $('.topcard__flavor').first().text().trim(),
    location: $('.topcard__flavor--bullet').first().text().trim(),
    salary: $('.salary, .compensation__salary').first().text().trim(),
    logo_url: $('img.artdeco-entity-image').first().attr('data-delayed-url') || '',
    jd_text: desc.length ? htmlToText($, desc.get(0)) : '',
  };
}

// greenhouse.io/<co>/…, lever.co/<co>/…, ashbyhq.com/<co>/…, <co>.wd1.myworkdayjobs.com
function companyFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    let c = '';
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com/.test(u.hostname) && seg && !/^(embed|jobs|j|v1)$/.test(seg)) c = seg;
    else if (/myworkdayjobs\.com|bamboohr\.com|teamtailor\.com|icims\.com/.test(u.hostname)) c = u.hostname.split('.')[0].replace(/^careers-/, '');
    return c.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  } catch { return ''; }
}

function parse(html, url) {
  const $ = cheerio.load(html);
  const out = { url, source: sourceOf(url), company: '', role: '', location: '', salary: '', logo_url: '', jd_text: '' };

  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      let data = JSON.parse($(s).contents().text());
      const items = [].concat(data['@graph'] || data);
      const jp = items.find((i) => [].concat(i['@type']).includes('JobPosting'));
      if (!jp) return;
      out.role ||= jp.title || '';
      out.company ||= jp.hiringOrganization?.name || '';
      const logo = jp.hiringOrganization?.logo;
      out.logo_url ||= (typeof logo === 'string' ? logo : logo?.url) || '';
      const loc = [].concat(jp.jobLocation || [])[0]?.address;
      out.location ||= loc ? [loc.addressLocality, loc.addressRegion, loc.addressCountry?.name || loc.addressCountry].filter(Boolean).join(', ') : (jp.jobLocationType || '');
      const sal = jp.baseSalary?.value;
      if (sal) out.salary ||= [sal.minValue, sal.maxValue].filter(Boolean).join('–') + ' ' + (jp.baseSalary.currency || '') + (sal.unitText ? '/' + sal.unitText.toLowerCase() : '');
      out.jd_text ||= strip(jp.description);
    } catch {}
  });

  const og = (p) => $(`meta[property="${p}"]`).attr('content') || '';
  out.role ||= og('og:title') || $('h1').first().text().trim() || $('title').text().trim();
  out.company ||= og('og:site_name');
  if (!out.jd_text) {
    const main = $('main').get(0) || $('[class*="description" i]').get(0) || $('article').get(0) || $('body').get(0);
    out.jd_text = htmlToText($, main).slice(0, 20000);
  }
  out.company ||= companyFromUrl(url);
  if (!out.logo_url && /greenhouse|lever|ashby|workable|teamtailor|recruitee/.test(url)) out.logo_url = og('og:image');
  out.role = out.role.replace(/\s*[|–-]\s*(LinkedIn|Indeed|Glassdoor).*$/i, '').trim();
  return out;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function fetchJob(url) {
  const li = linkedinJobId(url);
  if (li) return fetchLinkedIn(li);
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs');
  const { address } = await dns.lookup(u.hostname);
  if (isPrivate(address)) throw new Error('Refusing to fetch a private address');
  const r = await fetch(u, {
    redirect: 'follow', signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': UA, accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`Page returned ${r.status}`);
  return parse(await r.text(), url);
}

module.exports = { fetchJob, parse, sourceOf, canonicalUrl, linkedinJobId };
