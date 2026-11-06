// AI reviews run through the Claude Code CLI, signed in with your Claude Pro account —
// no API key, no extra cost (it counts toward your normal Pro usage limits).
// Every prompt can also be copied and pasted into the Claude app manually.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { db, DATA_DIR } = require('./db');

const SANDBOX = path.join(DATA_DIR, 'ai-sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

function findClaude() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || null; } catch {}
  // Fall back to the copy bundled with the Claude desktop app (newest version)
  const base = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
  try {
    const versions = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const h of fs.readdirSync(path.join(base, v))) {
        const p = path.join(base, v, h, 'claude.app/Contents/MacOS/claude');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

function status() {
  const bin = findClaude();
  if (!bin) return { available: false, reason: 'Claude Code CLI not found' };
  try {
    let raw;
    try { raw = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 }); }
    catch (e) { raw = e.stdout; if (!raw) throw e; } // exits non-zero when signed out
    const s = JSON.parse(raw);
    return { available: !!s.loggedIn, bin, bundled: bin.includes('Application Support/Claude'), loggedIn: !!s.loggedIn, authMethod: s.authMethod, reason: s.loggedIn ? '' : 'Not signed in' };
  } catch (e) {
    return { available: false, bin, reason: 'Could not check sign-in: ' + e.message };
  }
}

// ---------- Prompts ----------
const clip = (s, n = 12000) => (s || '').slice(0, n);
function docBlock(docs) {
  if (!docs.length) return '(no documents attached)';
  return docs.map((d) => `### ${d.kind === 'cover_letter' ? 'COVER LETTER' : d.kind === 'cv' ? 'CV' : 'DOCUMENT'}: ${d.title} (v${d.version})\n${clip(d.text, 15000) || '(no text could be extracted from this file)'}`).join('\n\n');
}
function appBlock(a) {
  return `Company: ${a.company || '?'}\nRole: ${a.role || '?'}\nLocation: ${a.location || '?'}\nPosting URL: ${a.url || 'n/a'}\nStatus: ${a.status}\nApplied: ${a.applied_at || 'not yet'}\n\n## JOB DESCRIPTION\n${clip(a.jd_text, 14000) || '(no job description saved)'}`;
}

// What Claude should know about the candidate (from Profile). Only filled-in fields are included.
function profileBlock(p = {}) {
  const rows = [['Name', p.name], ['Headline', p.headline], ['Location', p.location], ['Target roles', p.target_roles], ['Current role', [p.current_title, p.current_company].filter(Boolean).join(' at ')],
    ['Years of experience', p.experience_years], ['Key skills', p.skills], ['Certifications', p.certifications], ['Education', p.education],
    ['Right to work', p.right_to_work], ['Needs visa sponsorship', p.needs_sponsorship], ['Years in the UK', p.years_in_uk],
    ['Security clearance', p.clearance], ['Notice period', p.notice_period], ['Salary expectation', p.salary_expectation],
    ['Relocation', p.relocation], ['Preferred work mode', p.work_mode], ['About me', p.summary]].filter(([, v]) => v && String(v).trim());
  return rows.length ? `\n## CANDIDATE PROFILE (facts, use them; e.g. don't flag sponsorship risk if none is needed)\n${rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n` : '';
}
function contactBlock(p = {}) {
  return [p.name, p.email, p.phone, p.location, p.linkedin, p.website].filter(Boolean).join(' · ');
}

const RULES = `Be direct, specific and honest — like a sharp recruiter friend, not a cheerleader. Quote the exact lines you want changed and give rewritten versions. Use Markdown with short headings and bullets. Do not invent experience the candidate does not have.`;

const PROMPTS = {
  pre_submit: ({ app, docs, profile }) => `You are reviewing a job application BEFORE it is submitted.
${RULES}

Use web search briefly to check what this company values (mission, recent news, tech stack, culture) if it would sharpen the advice.

Return:
1. **Verdict** — Ready / Nearly / Not yet, with one-line reason and a 0–100 fit score.
2. **Top 5 fixes** — highest-impact first. For each: the problem, the exact current text, and a rewritten replacement.
3. **Missing keywords / requirements** from the job description that the documents don't evidence.
4. **ATS & formatting risks** (things automated screeners may choke on).
5. **Red flags** a recruiter would notice in 10 seconds.
6. **Company-specific angle** — one or two lines worth adding to show genuine interest.

${appBlock(app)}
${profileBlock(profile)}
## CANDIDATE DOCUMENTS
${docBlock(docs)}`,

  rejection: ({ app, docs, answers, profile, emails }) => `This application was ${app.status === 'ghosted' ? 'ignored (no response)' : 'rejected'}. Help the candidate narrow down the most likely reasons, knowing the true reason is usually unknowable.
Treat this as hypotheses, not verdicts. Explicitly weigh reasons that have nothing to do with the candidate (role filled before they applied,
internal candidate, very high applicant volume, budget or hiring freeze, location/visa screening) against reasons in their documents.
If the rejection email gives clues (speed of reply, wording like "high volume", "position filled", automated vs personal), use them:
an instant automated rejection usually means a screening filter or the role closing, not a judgement on the CV.
${RULES}

Use web search to research the company and this type of role (who they typically hire, seniority signals, required certifications, location/visa constraints, hiring freezes or layoffs around ${app.applied_at || 'the application date'}).

Return:
1. **What the email tells us**: reply speed, automated vs personal, any stated reason. Skip if no email is provided.
2. **Most likely reasons**: ranked, each with a confidence (High / Medium / Low) and the specific evidence from the CV, cover letter, job description or email behind it.
3. **Factors outside your control** worth knowing about (role already filled, internal candidate, volume, company news, hiring freeze).
4. **What to change next time** — concrete edits, with before → after text.
5. **Is this role worth re-applying for later?** and what would need to be true.

${appBlock(app)}
${profileBlock(profile)}
## CANDIDATE DOCUMENTS (exact versions that were sent)
${docBlock(docs)}
${emails?.length ? `\n## EMAILS FROM THE EMPLOYER (oldest first)\n${emails.map((e) => `### ${e.date.slice(0, 16).replace('T', ' ')} · ${e.category} · from ${e.from_name} <${e.from_email}>\nSubject: ${e.subject}\n${clip(e.body, 3000)}`).join('\n\n')}\nApplied on: ${app.applied_at || 'unknown'}` : ''}
${answers?.length ? `\n## APPLICATION FORM ANSWERS\n${answers.map((x) => `Q: ${x.question}\nA: ${x.answer}`).join('\n\n')}` : ''}`,

  tailor: ({ app, docs, profile }) => `Tailor the candidate's document to this job. Keep every fact truthful — reorder, reword and emphasise; never fabricate.
Keep the same overall structure and length (one to two pages). Mirror the job description's language where the candidate genuinely has the experience.

Output EXACTLY in this format:
## What I changed
- bullet list of the key changes and why

=====TAILORED=====
(the full tailored document in plain Markdown: "# " for the name, "## " for section headings, "- " for bullets)

${appBlock(app)}
${profileBlock(profile)}
## DOCUMENT TO TAILOR
${docBlock(docs.slice(0, 1))}`,

  fix: ({ app, docs, profile, lastReview }) => `Rewrite the candidate's document for this job, fixing the problems found in the review below.
Keep every fact truthful: reword, reorder, quantify where the original gives numbers, and mirror the job description's language
only where the candidate genuinely has the experience. Where a fix needs a detail you don't have (a number, an employer name),
leave a clear [placeholder] rather than inventing it. Keep it to one to two pages, and make it ATS-friendly (simple headings, no tables).

Output EXACTLY in this format:
## What I fixed
- bullet list: each issue from the review and how it was addressed (or why it couldn't be)

=====TAILORED=====
(the full corrected document in plain Markdown: "# " for the name, a contact line, "## " for section headings, "- " for bullets)

${appBlock(app)}
${profileBlock(profile)}
## REVIEW TO ACT ON
${lastReview || '(No saved review yet. First identify the top issues yourself against the job description, then fix them.)'}

## DOCUMENT TO FIX
${docBlock(docs.slice(0, 1))}`,

  cover_letter: ({ app, docs, profile }) => `Write a cover letter for this application.
Use web search briefly to find one or two genuine, specific things about the company (recent news, product, mission) to reference.
Rules: 250–350 words, UK English, confident but not boastful, no clichés ("I am writing to apply…", "passionate team player").
Structure: a hook tied to the company → two short paragraphs mapping the candidate's real experience to the top requirements
(with specifics from the CV) → a closing line. Never invent experience. Use [placeholders] for anything unknown.

Output EXACTLY in this format:
## Notes
- the company facts you used and which requirements you targeted

=====TAILORED=====
(the letter in plain Markdown, starting with: ${contactBlock(profile) || '[Your name · email · phone]'}, then the date and greeting)

${appBlock(app)}
${profileBlock(profile)}
## CANDIDATE DOCUMENTS
${docBlock(docs)}`,

  interview_prep: ({ app, docs, profile }) => `The candidate has an interview for this role. Prepare them.
${RULES}

Use web search to research the company: what they do, recent news, products, values, interview process reports (e.g. Glassdoor), and who the likely interviewers are if public.

Return:
1. **Company briefing** — 6–8 bullets they should know cold.
2. **Likely questions** — 10 questions (mix of technical, behavioural, role-specific) with why each is likely.
3. **Suggested answers** — for the 5 hardest, a STAR-style outline built ONLY from the candidate's real experience in the CV.
4. **Gaps to prepare for** — weaknesses vs the job description and how to address them honestly.
5. **Smart questions to ask them** — 5.

${appBlock(app)}
${profileBlock(profile)}
## CANDIDATE DOCUMENTS
${docBlock(docs)}`,

  answer: ({ app, question, answer, profile }) => `Review this answer to a job application form question.
${RULES}
Return: a one-line verdict, 3 specific improvements, then an improved version (same length or shorter, in the candidate's voice, no invented facts).

${app ? appBlock(app) : ''}
${profileBlock(profile)}
## QUESTION
${question}

## CANDIDATE'S ANSWER
${answer}`,

  patterns: ({ apps, profile }) => `Analyse this candidate's job search as a whole. Compare applications that progressed (screening/interview/offer) with those that were rejected or ghosted.
${RULES}

Return:
1. **Headline numbers** and what they say.
2. **What the successful applications have in common** (role types, seniority, keywords, CV version, cover letter or not, source).
3. **What the unsuccessful ones have in common.**
4. **Three changes most likely to raise the interview rate**, specific and actionable.
5. **Roles to target more / less.**

${profileBlock(profile)}
## APPLICATIONS
${apps.map((a) => `- [${a.status}] ${a.role} @ ${a.company} | source: ${a.source || '?'} | applied ${a.applied_at || '?'} | docs: ${a.docs || 'none'} | JD keywords: ${clip(a.jd_text, 400).replace(/\s+/g, ' ')}`).join('\n')}`,
};

function buildPrompt(type, ctx) {
  if (!PROMPTS[type]) throw new Error('Unknown review type');
  return PROMPTS[type](ctx);
}

// ---------- Runner ----------
let running = 0;
const queue = [];

function run(reviewId, prompt) {
  const go = () => {
    running++;
    const st = status();
    if (!st.available) {
      finish(reviewId, 'error', `Claude isn't available: ${st.reason}.\n\nFix: open Terminal and run \`claude auth login\` (sign in with your Claude Pro account). Or use **Copy prompt** and paste it into the Claude app.`);
      return next();
    }
    const args = ['-p', '--output-format', 'json', '--tools', 'WebSearch', 'WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', '--strict-mcp-config', '--setting-sources', ''];
    const child = spawn(st.bin, args, { cwd: SANDBOX, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'jobtrack' } });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60e3);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) finish(reviewId, 'error', `Claude returned an error: ${j.result || j.terminal_reason}`);
        else finish(reviewId, 'done', j.result || '');
      } catch {
        finish(reviewId, 'error', `Claude exited (${code}). ${err.slice(0, 600) || out.slice(0, 600) || 'Timed out or no output.'}`);
      }
      next();
    });
    child.stdin.end(prompt);
  };
  const next = () => { running--; if (queue.length) queue.shift()(); };
  running < 2 ? go() : queue.push(go);
}

function finish(id, st, result) {
  db.prepare('UPDATE reviews SET status=?, result=? WHERE id=?').run(st, result, id);
}

// Mark anything left "running" from a previous server session as failed
db.prepare(`UPDATE reviews SET status='error', result='Interrupted (server restarted).' WHERE status='running'`).run();

// One-off structured question with no tools (used to read job confirmation emails). Resolves to Claude's text.
function ask(prompt, timeoutMs = 120e3) {
  return new Promise((resolve, reject) => {
    const st = status();
    if (!st.available) return reject(new Error(st.reason));
    const child = spawn(st.bin, ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', ''], { cwd: SANDBOX });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); j.is_error ? reject(new Error(j.result)) : resolve(j.result || ''); }
      catch { reject(new Error('Claude returned no output')); }
    });
    child.stdin.end(prompt);
  });
}

module.exports = { buildPrompt, run, status, findClaude, ask };
