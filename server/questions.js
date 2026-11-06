// Decide which application-form questions are worth keeping, and label them.
// Keeps: motivation, visa/right to work, UK residency, clearance, notice, salary, experience, relocation…
// Drops: age, gender, ethnicity, contact details and other equal-opportunities / admin fields.

const CATEGORIES = [
  ['sponsorship', 'Visa sponsorship', /sponsor|visa/i],
  ['right_to_work', 'Right to work', /right to work|work(ing)? (permit|authori[sz])|eligib\w* to work|legally (able|entitled)|authori[sz]ed to work/i],
  ['uk_residency', 'Time in the UK', /(how long|years?).{0,40}(uk|united kingdom|country)|resid(ed|ent|ency)|lived in|living in the uk|been in the uk|indefinite leave|settled status|citizen|nationality/i],
  ['clearance', 'Security clearance', /clearance|\bsc\b|\bdv\b|bpss|vetting|nppv|ctc/i],
  ['motivation', 'Why this company', /why (do )?(you )?(want|wish|are you interested|apply|this|join|us)|what (attracts|interests|excites)|motivat|interest(ed)? in (this|the|our)/i],
  ['experience', 'Experience', /how many years|years of (relevant )?experience|experience (with|in|of)|have you (worked|used)|familiar with|proficien/i],
  ['salary', 'Salary expectation', /salary|compensation|pay (expect|range)|expected (pay|rate)|day rate|desired pay/i],
  ['notice', 'Notice / start date', /notice period|start date|when (can|could) you start|availab(le|ility) to start|earliest start/i],
  ['location', 'Location / relocation', /relocat|commut|on-?site|hybrid|in the office|willing to (travel|work from)|based in/i],
  ['qualifications', 'Qualifications', /degree|certif|qualif|licen[cs]e|driving/i],
  ['about_you', 'About you', /tell us|describe|cover letter|additional information|anything else|summar|strength|achievement|why should we|what makes you/i],
];

const EXCLUDE = /\bage\b|date of birth|\bdob\b|gender|\bsex\b|ethnic|\brace\b|religio|belief|disab|sexual orientation|pronoun|marital|veteran|caring responsib|first name|last name|surname|full name|e-?mail|phone|mobile|address|post ?code|zip|linkedin|website|portfolio|github|url|how did you (hear|find)|referr(al|ed) (by|source)|consent|privacy|terms|agree|signature|captcha/i;

function categorize(question) {
  const q = question || '';
  if (EXCLUDE.test(q) && !/sponsor|visa|right to work|clearance/i.test(q)) return null;
  for (const [key, label, re] of CATEGORIES) if (re.test(q)) return { key, label };
  return null;
}

// Long written answers are usually worth keeping even if the question isn't recognised
function isRelevant(question, answer) {
  if (categorize(question)) return true;
  return !EXCLUDE.test(question || '') && (answer || '').trim().length >= 120;
}

const PRIORITY = ['sponsorship', 'right_to_work', 'uk_residency', 'clearance', 'motivation', 'salary', 'notice', 'experience', 'location', 'qualifications', 'about_you'];
const rank = (q) => { const c = categorize(q); return c ? PRIORITY.indexOf(c.key) : 99; };

module.exports = { categorize, isRelevant, rank };
