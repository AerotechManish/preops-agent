# Pre-Ops Planning Folder — Runbook

## What this is
A self-contained generator that regenerates the Pre-Ops Intelligence dashboard
each day, rolls the 3-day case window forward automatically, and keeps a
permanent, deduplicated record of every run and every notification.

```
planning/
├── template.html              ← the dashboard shell (rarely changes)
├── generate_daily_plan.js     ← run this once per day
├── data/
│   ├── plans.json             ← source of truth for all 31 cases (edit this, not the HTML)
│   └── notifications.json     ← source of truth for the notification log
├── manifest.json              ← append-only record of every generation run, forever
├── notifications_log.csv      ← append-only, deduplicated log of every notification
├── latest.html                ← always the most recent build ("refreshed" copy)
└── day_YYYY-MM-DD/
    └── preops_agent.html      ← a permanent dated snapshot, one per calendar day
```

Every run does three things at once, which is why both halves of your ask are
covered: **latest.html gets refreshed** in place, AND **a new dated file gets
created** under `day_YYYY-MM-DD/` — nothing gets thrown away.

## The honest limitation, upfront
I (Claude, in this chat) cannot execute code autonomously in the future. Once
this conversation ends, nothing runs on its own — I have no background
process, no cron daemon, no memory of "come back tomorrow." Anything that
claims otherwise would be wrong. So "schedule a daily trigger" needs to
attach to something that actually persists outside this chat. Here are the
real options, in order of how little setup they need:

### Option A — Ask me again each day (zero setup, manual)
Just say "run today's plan" in a chat with me on day 2 and day 3. I'll run
`node generate_daily_plan.js` in this same folder. Lowest effort, but depends
on you remembering.

### Option B — Claude Cowork scheduled task (recommended if you have it)
Claude Cowork supports recurring scheduled tasks on paid plans. Create one
with:
- **Cadence:** daily, 3 occurrences (or daily indefinitely, your call)
- **Prompt:** "Run `node generate_daily_plan.js` in the `planning/` folder
  from [conversation/project link] and confirm the run summary."

This is the closest thing to "true" scheduling without leaving Claude.

### Option C — Claude Code Loop (built for exactly this: up to 3 days)
If you have Claude Code, its Loop feature runs a recurring task for up to
3 days from a single config — which matches your ask precisely. Point it at
this repo/folder with the same command as above.

### Option D — A real OS cron job (most durable, needs your own machine/server)

Use the wrapper script, not the bare node command — it resolves node's path
explicitly (cron's PATH is minimal and this is the #1 reason "it works when I
run it myself but not from cron" happens), logs every run with a timestamp,
and exits non-zero on failure so any cron failure-alerting you have actually
fires.

**Linux / macOS — cron:**
```bash
chmod +x run_daily.sh          # only needed once
crontab -e
# add this line (runs daily at 06:00 server time):
0 6 * * * /absolute/path/to/planning/run_daily.sh
```

**Linux — systemd timer (more robust than cron, restarts survive reboots):**
```bash
cp run_daily.service.example /etc/systemd/system/run_daily.service
cp run_daily.timer.example   /etc/systemd/system/run_daily.timer
# edit both files: replace /absolute/path/to/planning with the real path
sudo systemctl daemon-reload
sudo systemctl enable --now run_daily.timer
systemctl list-timers | grep run_daily   # confirm it's scheduled
```

**Windows — Task Scheduler:**
1. Install Node.js and WSL (or Git Bash) if not already present.
2. Task Scheduler → Create Task → Trigger: Daily, 06:00.
3. Action → Program/script: `wsl.exe` (or `bash.exe` if using Git Bash)
   Arguments: `-lc "/path/to/planning/run_daily.sh"`
4. Test with "Run" in Task Scheduler and check `planning/logs/` for the day's log file.

Every run appends to `planning/logs/run_YYYY-MM-DD.log` — check there first
if a scheduled run doesn't seem to have happened.

## One real gap worth knowing about
The dashboard's "Notify OCC / Dispatch / Flight Ops" buttons run **in the
user's browser only** — there's no server behind this HTML file, so clicks
made while someone is using `latest.html` don't automatically flow back into
`data/notifications.json`. Today's `notifications_log.csv` reflects what was
seeded in the data file at generation time, not live clicks during the day.
Closing that gap for real would mean standing up a small backend (even a
lightweight one) that the HTML posts to — a real next step, not something a
static file can do on its own.

## To generate a run right now
```bash
cd planning
node generate_daily_plan.js
```
Check the console summary, then open `latest.html` or the newest
`day_YYYY-MM-DD/preops_agent.html`.

## Getting rid of the daily download entirely (recommended)

Everything above still ends with "and then someone opens a file." If the
goal is a URL you just leave open — no download, no manual step, ever —
the dashboard needs to live somewhere reachable by a browser, and that
somewhere needs to be kept current automatically. That's a hosting problem,
not a scheduling problem, and it needs solving on top of (not instead of)
the generator we already built.

**Recommended: GitHub Actions + GitHub Pages** — free, no server to
maintain, reuses `generate_daily_plan.js` unchanged.

```
.github/workflows/daily-refresh.yml   ← runs generate_daily_plan.js at 06:00 UTC daily,
                                          commits the refresh, publishes latest.html
                                          to GitHub Pages as index.html
```

Setup (one-time, ~10 minutes):
1. Push this whole `planning/` folder (including `.github/`) to a GitHub repo.
2. Repo → Settings → Pages → Source: "GitHub Actions".
3. Repo → Settings → Actions → General → Workflow permissions →
   "Read and write permissions" (the workflow commits the daily refresh back).
4. Done. The workflow runs automatically at 06:00 UTC, and also has a manual
   "Run workflow" button under the Actions tab if you want to trigger it
   on demand instead of waiting.
5. Your dashboard is now live at `https://<your-username>.github.io/<repo-name>/`
   — bookmark it, put it on a wallboard screen, share the link. Nobody
   downloads anything again.

**If GitHub isn't usable in your environment:** the same pattern works with
any static host — an internal web server, S3 + CloudFront, Azure Static Web
Apps, whatever you already run. Only the "publish" step in the workflow
changes; the generation logic stays identical.

**The dashboard also now auto-refreshes itself** if left open in a browser
tab (every 30 minutes, pausing politely if someone has a card expanded so it
doesn't yank the page from under them). This does not replace the daily
generation — it just means a screen mounted in an ops room notices a new
version without anyone touching it.

**Honest limits of this setup, worth knowing before you commit to it:**
- GitHub's cron scheduler can lag by a few minutes under platform load —
  fine for a daily ops brief, not for anything second-critical.
- This publishes a **public** GitHub Pages URL by default unless your GitHub
  plan supports private Pages (GitHub Enterprise / certain paid tiers) —
  check your org's policy on operational data before using public GitHub
  Pages for anything sensitive.
- The "Notify" buttons are still browser-only (see the gap noted above) —
  hosting the file doesn't change that; it would need a real backend to fix.

