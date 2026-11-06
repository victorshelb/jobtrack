// Instant, offline keyword match between a job description and a document.
// Only counts things a recruiter or ATS would actually screen for: skills, tools, certifications,
// qualifications and named technologies — not generic words like "team" or "opportunity".

// Multi-word and single-word skills (lowercase). Extend freely.
const SKILLS = `
incident response|incident handling|incident management|threat hunting|threat intelligence|threat detection|threat modelling|threat modeling|
vulnerability management|vulnerability assessment|vulnerability scanning|penetration testing|pen testing|red team|blue team|purple team|
security operations|security monitoring|log analysis|log management|digital forensics|forensics|malware analysis|reverse engineering|
detection engineering|use case development|alert triage|triage|root cause analysis|playbooks|runbooks|tabletop exercises|
risk assessment|risk management|third party risk|security awareness|phishing|email security|endpoint security|network security|
cloud security|application security|appsec|devsecops|identity and access management|iam|privileged access management|pam|
zero trust|data loss prevention|dlp|encryption|pki|firewalls|firewall|ids|ips|ids/ips|waf|proxy|vpn|siem|soar|edr|xdr|mdr|ndr|soc|
active directory|azure ad|entra id|entra|okta|ldap|kerberos|saml|oauth|sso|mfa|
splunk|splunk es|qradar|arcsight|logrhythm|elastic|elk|elasticsearch|kibana|sentinel|microsoft sentinel|azure sentinel|chronicle|sumo logic|
crowdstrike|crowdstrike falcon|sentinelone|carbon black|defender|microsoft defender|defender for endpoint|cortex xdr|cortex xsoar|xsoar|
palo alto|fortinet|fortigate|checkpoint|cisco|zscaler|netskope|proofpoint|mimecast|darktrace|tenable|nessus|qualys|rapid7|nexpose|
burp suite|metasploit|nmap|wireshark|tcpdump|zeek|suricata|snort|yara|sigma|kql|spl|osquery|velociraptor|volatility|autopsy|
mitre att&ck|mitre|att&ck|cyber kill chain|nist|nist csf|nist 800-53|iso 27001|iso27001|soc 2|soc2|pci dss|pci-dss|gdpr|hipaa|cis controls|
cyber essentials|owasp|owasp top 10|cve|cvss|stix|taxii|misp|
aws|amazon web services|azure|microsoft azure|gcp|google cloud|cloudtrail|guardduty|security hub|cloudwatch|
kubernetes|docker|containers|terraform|ansible|cloudformation|ci/cd|jenkins|github actions|gitlab|git|
linux|unix|windows|windows server|macos|bash|powershell|python|javascript|typescript|java|c++|c#|golang|rust|ruby|php|sql|
nosql|postgresql|mysql|mongodb|regex|rest api|apis|json|yaml|scripting|automation|
tcp/ip|dns|dhcp|tls|ssl|smtp|networking|routing|switching|osi model|
machine learning|data analysis|data analytics|power bi|tableau|excel|jira|confluence|servicenow|
itil|agile|scrum|project management|stakeholder management|change management|
report writing|technical writing|documentation|
cissp|cism|cisa|crisc|ccsp|security+|comptia security+|cysa+|comptia cysa+|network+|comptia network+|casp+|
ceh|oscp|oswe|gcih|gcia|gsec|gpen|gcfa|gcfe|btl1|btl2|crest|cpsa|ccna|ccnp|
az-900|az-104|az-500|sc-200|sc-300|sc-900|aws certified|security specialty|
security clearance|sc clearance|dv clearance|bpss|ctc clearance|nppv|
bachelor's degree|master's degree|degree|bsc|msc|phd|computer science|cyber security|cybersecurity|information security|
on-call|shift work|24/7|out of hours|
mdm|intune|jamf|ueba|casb|sase|ztna|grc|isms|business continuity|disaster recovery|itsm|sla|patch management|asset management|
hunting queries|detection rules|correlation rules|dashboards|ticketing|escalation|containment|eradication|
`.split('|').map((s) => s.trim()).filter(Boolean);

// Equivalent spellings: if the JD says the key, any of these in the CV counts
const ALIASES = {
  aws: ['amazon web services'], gcp: ['google cloud'], azure: ['microsoft azure'], sentinel: ['microsoft sentinel', 'azure sentinel'],
  'mitre att&ck': ['mitre', 'att&ck'], 'att&ck': ['mitre'], mitre: ['att&ck'], 'entra id': ['azure ad', 'entra'], 'azure ad': ['entra id', 'entra'],
  'iso 27001': ['iso27001'], 'pci dss': ['pci-dss'], 'soc 2': ['soc2'], cybersecurity: ['cyber security'], 'cyber security': ['cybersecurity'],
  'penetration testing': ['pen testing', 'pentest'], 'threat modelling': ['threat modeling'], 'security+': ['comptia security+'],
  defender: ['microsoft defender', 'defender for endpoint'], crowdstrike: ['crowdstrike falcon', 'falcon'],
  'ids/ips': ['ids', 'ips'], degree: ['bsc', 'msc', 'bachelor', 'master', 'phd'], 'sc clearance': ['security clearance'],
  'security clearance': ['sc clearance', 'dv clearance', 'sc cleared', 'dv cleared'], 'incident response': ['incident handling'],
};

// Acronyms / capitalised words that look technical but aren't skills
const NOT_SKILLS = new Set(`a i we us our the and or uk usa eu emea apac ceo cto cfo coo hr ltd plc llc inc gbp usd eur ote dei eeo faq asap
fte pto tbc tbd n/a etc cv job role team london manchester england scotland wales remote hybrid please apply about linkedin
benefits salary bonus pension you your who what why how when where this that monday friday ai it ok
ftse nhs gmt bst ote kpi kpis okr okrs b2b b2c saas smb sme`.split(/\s+/));

// Make aliases symmetric: "AWS" in the JD matches "Amazon Web Services" in the CV and vice versa
for (const [k, vs] of Object.entries(ALIASES)) for (const v of vs) { ALIASES[v] ||= []; if (!ALIASES[v].includes(k)) ALIASES[v].push(k); }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = (term, flags = 'i') => new RegExp(`(^|[^a-z0-9+#])${esc(term)}($|[^a-z0-9+#])`, flags);
const has = (text, term) => re(term).test(text);

function candidates(jd, company = '') {
  const lower = jd.toLowerCase();
  const found = new Map(); // term -> weight
  const companyWords = new Set(company.toLowerCase().split(/\W+/).filter(Boolean));

  // 1. Known skills (longest first so "microsoft sentinel" covers "sentinel")
  const taken = [];
  for (const term of [...SKILLS].sort((a, b) => b.length - a.length)) {
    if (!has(lower, term)) continue;
    if (taken.some((t) => t !== term && has(t, term))) continue;
    const n = (lower.match(re(term, 'gi')) || []).length;
    found.set(term, 1.5 + Math.min(n - 1, 3) * 0.5);
    taken.push(term);
  }

  // 2. Named technologies the dictionary doesn't know: CamelCase, ACRONYMS, things with digits
  const tokens = jd.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b|\b[A-Z]{2,6}\b|\b[A-Z][A-Za-z]{0,5}-?\d{2,}[A-Za-z0-9-]*\b/g) || [];
  const counts = {};
  tokens.forEach((t) => (counts[t] = (counts[t] || 0) + 1));
  for (const [t, n] of Object.entries(counts)) {
    const l = t.toLowerCase();
    if (NOT_SKILLS.has(l) || companyWords.has(l)) continue;
    if (taken.some((k) => has(k, l))) continue;
    if (n < 2) continue; // unknown acronyms only count if the posting repeats them
    found.set(l, 1 + Math.min(n - 2, 2) * 0.5);
  }
  return found;
}

function match(jd, doc, company = '') {
  const terms = candidates(jd || '', company);
  const text = (doc || '').toLowerCase();
  const matched = [], missing = [];
  for (const [term, weight] of [...terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    const ok = has(text, term) || (ALIASES[term] || []).some((a) => has(text, a));
    (ok ? matched : missing).push({ term, weight: +weight.toFixed(1) });
  }
  const total = [...matched, ...missing].reduce((s, m) => s + m.weight, 0);
  const got = matched.reduce((s, m) => s + m.weight, 0);
  return { score: total ? Math.round((got / total) * 100) : 0, matched, missing: missing.slice(0, 15), considered: matched.length + missing.length };
}

module.exports = { match };
