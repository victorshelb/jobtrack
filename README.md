# JobTrack

**A private, self-hosted job-application tracker that does the busywork for you.**

It spots applications as you make them, keeps the exact CV and cover letter you sent, reads employer replies from Gmail to update each application's status, and uses Claude to review your CV before you submit and to narrow down why a rejection might have happened. It runs on your own laptop and works on your phone, and your data never leaves your devices.

## Features

### Capture: wherever you apply
- **Chrome extension**: detects application pages (Greenhouse, Lever, Workday, Ashby, LinkedIn, Indeed and more), shows a "Track this application?" card, and works inside LinkedIn's Easy Apply window
- **Saves the files you upload** to the form, and lets you attach a CV from your library right on the page
- **Records the questions that matter** (sponsorship, right to work, time in the UK, clearance, "why us") across multi-page forms, and marks the application *applied* when you submit
- **Applying from your phone** (LinkedIn or Indeed app, any job board): the confirmation email is turned into an application automatically. Regex extractors cover LinkedIn, Indeed, Totaljobs, CV-Library, Reed and common ATSs, with a Claude fallback for anything unusual. It picks the CV you most likely sent: the file named in the email, then the best keyword match, then your default
- **Share to JobTrack** from any app (Android share target, or an iOS Shortcut)
- **Duplicate prevention**: one record per job, with a merge tool

### Track: replies come to you
- **Gmail sync** (read-only IMAP, several accounts) every 15 minutes: links each employer email to its application and classifies it as rejection, interview, assessment, offer, received or viewed
- **Automatic status updates**, which never override a status you set by hand
- **Push notifications** to your phone (Web Push / VAPID): "Interview! · Radius", "Tracked: SIEM consultant · HCLTech"
- **Inbox** of every job email, with fix-the-link and create-application-from-email actions
- Status pages (Applied, Interview, Offers, Rejected, Ghosted), follow-up reminders and ghosting detection

### Improve: Claude as your reviewer
- **Pre-submit check**: verdict, fit score, top fixes with rewritten lines, missing requirements, ATS risks, a company-specific angle (with web research)
- **Tailor my CV**, **Fix issues** (applies the last review) and **Cover letter**: each saved as a new version, so the original is never overwritten
- **"Why no offer?"**: a separate page that reads the rejection email and its timing, then ranks possible reasons, including the ones outside your control (role already filled, volume, automated screening)
- **Interview prep**, **answer review** and **pattern analysis** across all applications
- **Instant offline keyword match** against the job description (skills, tools and certifications, not filler words)
- AI runs through the **Claude Code CLI on your existing Claude Pro plan**: no API key, no extra cost. Every prompt can also be copied into the Claude app

### Organise
- Document library with **versioning**, an editor with live preview, and **DOCX / PDF export**
- Documents and answers **grouped by company and application**, plus a reusable answer bank
- Insights: interview rate by CV version and by source, weekly activity
- Profile with photo, work-eligibility facts (fed to Claude), and switchable colour palettes

## Architecture

```
 Phone (installable web app) ──┐                    ┌── Gmail (IMAP, read-only, App Password in macOS Keychain)
 Chrome extension ─────────────┼── Tailscale HTTPS ─┤
 Laptop browser ───────────────┘   (tailnet only)   │   Node.js / Express server, bound to 127.0.0.1
                                                    ├── SQLite (node:sqlite): applications, documents, emails, reviews
                                                    ├── Claude Code CLI (Pro login): reviews with web search
                                                    └── Web Push → Apple / Google push services → phone
```

- **Offline-first phone app**: a service worker keeps a copy of your data on the phone, and changes made offline are queued and synced when the laptop is reachable again
- The server runs as a **macOS LaunchAgent**, so it starts at login with no need to run `npm start`

## Security

- The server listens on **127.0.0.1 only**. Remote access goes exclusively through **Tailscale**, which is restricted to your own devices
- Account password hashed with **scrypt**, login lockout after 5 failures, httpOnly SameSite=strict session cookies, and a separate rotatable token for the extension
- **Gmail App Passwords are stored in the macOS Keychain**, never in the database. Mail access is read-only (`EXAMINE`)
- A strict Content-Security-Policy, no inline scripts, and SSRF protection on job-page fetching
- Claude runs with web tools only, so it can't touch files or run commands
- `data/` (database, uploads) is git-ignored and readable only by your user account

## Setup

```bash
npm install
npm start                       # http://localhost:3005, then create your account
./scripts/autostart.sh          # optional: start automatically at login
```

1. **Claude**: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login` (sign in with your Claude Pro account)
2. **Extension**: `chrome://extensions` → Developer mode → Load unpacked → `extension/`, then paste the token from Profile → Claude & devices
3. **Gmail**: Profile → Email → add an App Password (2-Step Verification required)
4. **Phone**: install Tailscale on both devices, run `tailscale serve --bg 3005`, open the `https://…ts.net` address on your phone, then Add to Home Screen → Profile → Phone → turn on notifications

## Tech stack

Node.js, Express 5, SQLite (`node:sqlite`), vanilla JS (no build step), Service Worker / Web Push, Chrome MV3 extension, imapflow + mailparser, cheerio, mammoth, pdf-parse, docx, Claude Code CLI, Tailscale.

## Project layout

```
server/      API, auth, document parsing, job-page extraction, Gmail sync, push, Claude runner
public/      Installable web app (dashboard + offline service worker)
extension/   Chrome extension (content script, background worker, side panel)
scripts/     autostart.sh (macOS LaunchAgent)
data/        your database and files (git-ignored)
```
