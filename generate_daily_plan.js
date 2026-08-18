#!/usr/bin/env node
/**
 * generate_daily_plan.js
 * ------------------------------------------------------------
 * Regenerates the Pre-Ops Intelligence dashboard for "today" and
 * keeps a durable record of every generation run + every
 * notification ever logged, across however many days this is run.
 *
 * WHAT IT DOES EACH RUN:
 *   1. Loads the persisted case data from data/plans.json (source of truth —
 *      NOT the HTML; the HTML is a rendering of this data).
 *   2. If this is a new calendar day since the last run, rolls the 3-day
 *      window forward by one day (effective_date +1 for every plan) so the
 *      dashboard always shows "today, tomorrow, day after" rather than
 *      going stale.
 *   3. Injects the current data into template.html to produce a fresh
 *      dashboard HTML.
 *   4. Writes it to BOTH:
 *        - day_<YYYY-MM-DD>/preops_agent.html   (new file every day, kept)
 *        - latest.html                          (always overwritten/"refreshed")
 *   5. Appends one row to manifest.json (every run, forever) and mirrors
 *      every notification event into notifications_log.csv (append-only).
 *
 * HOW TO ACTUALLY RUN THIS DAILY (I cannot execute this myself in the
 * future — see the chat message for the honest explanation of why):
 *   - Simplest: run `node generate_daily_plan.js` by hand each morning.
 *   - OS cron (Linux/Mac):   0 6 * * * cd /path/to/planning && node generate_daily_plan.js
 *   - Windows Task Scheduler: same command, daily trigger, 06:00.
 *   - Claude Cowork scheduled task / Claude Code Loop: paste the prompt
 *     from RUNBOOK.md into the scheduler UI.
 * ------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PLANS_PATH = path.join(DATA_DIR, 'plans.json');
const NOTIF_PATH = path.join(DATA_DIR, 'notifications.json');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const NOTIF_LOG_PATH = path.join(ROOT, 'notifications_log.csv');
const TEMPLATE_PATH = path.join(ROOT, 'template.html');
const LATEST_PATH = path.join(ROOT, 'latest.html');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextCronUTC(hourUTC, minuteUTC) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, minuteUTC, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function parseCsvLine(line) {
  // minimal CSV parser that respects double-quoted fields containing commas
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function main() {
  const today = todayISO();
  const manifest = loadJSON(MANIFEST_PATH, { runs: [], last_run_date: null });
  const plans = loadJSON(PLANS_PATH, []);
  const notifications = loadJSON(NOTIF_PATH, []);

  const isNewDay = manifest.last_run_date !== today;
  let rolled = false;

  if (isNewDay && manifest.last_run_date !== null) {
    // Roll every plan's effective_date forward by exactly the number of
    // calendar days that passed since the last run, so the dashboard keeps
    // showing "today + next two days" instead of drifting into the past.
    const daysPassed = Math.round(
      (new Date(today) - new Date(manifest.last_run_date)) / 86400000
    );
    if (daysPassed > 0) {
      plans.forEach(p => { p.effective_date = addDays(p.effective_date, daysPassed); });
      rolled = true;
    }
  }

  saveJSON(PLANS_PATH, plans);
  saveJSON(path.join(DATA_DIR, 'meta.json'), {
    generated_at: new Date().toISOString(),
    plans_count: plans.length
  });

  // ---- render HTML from template ----
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const plansBlock = 'const PLANS = ' + JSON.stringify(plans, null, 2) + ';';
  const notifBlock = 'const NOTIFICATIONS = ' + JSON.stringify(notifications, null, 2) + ';';

  const plansRe = /const PLANS = \[[\s\S]*?\n\];/;
  const notifRe = /const NOTIFICATIONS = \[[\s\S]*?\n\];/;
  const genInfoRe = /const GENERATION_INFO = \{.*?\};/;

  if (!plansRe.test(template)) throw new Error('Could not find PLANS block in template.html');
  if (!notifRe.test(template)) throw new Error('Could not find NOTIFICATIONS block in template.html');
  if (!genInfoRe.test(template)) throw new Error('Could not find GENERATION_INFO block in template.html');

  // "deployed" is true only when this run came from CI (GitHub Actions sets
  // the GITHUB_ACTIONS env var automatically) — a manual/local run is real
  // data, but it's not evidence a schedule is actually wired up, so the
  // dashboard should say so honestly rather than implying automation exists.
  const deployed = process.env.GITHUB_ACTIONS === 'true';
  const nextScheduled = nextCronUTC(6, 0); // matches the 06:00 UTC cron in daily-refresh.yml — update both together if you change the schedule
  const generationInfo = {
    generated_at: new Date().toISOString(),
    next_scheduled_utc: nextScheduled,
    source: deployed ? 'GitHub Actions scheduled workflow' : 'manual/local run (node generate_daily_plan.js)',
    deployed
  };
  const genInfoBlock = 'const GENERATION_INFO = ' + JSON.stringify(generationInfo) + ';';

  let html = template.replace(plansRe, plansBlock);
  html = html.replace(notifRe, notifBlock);
  html = html.replace(genInfoRe, genInfoBlock);

  // ---- write dated snapshot + refreshed latest ----
  const dayDir = path.join(ROOT, `day_${today}`);
  fs.mkdirSync(dayDir, { recursive: true });
  const dayFile = path.join(dayDir, 'preops_agent.html');
  fs.writeFileSync(dayFile, html);
  fs.writeFileSync(LATEST_PATH, html);

  // ---- manifest ----
  const activeCount = plans.filter(p => p.status === 'Active').length;
  const redCount = plans.filter(p => p.risk_level === 'Red').length;
  const stageCount = {};
  plans.forEach(p => { const s = p.caseStage || 'New'; stageCount[s] = (stageCount[s] || 0) + 1; });

  const runRecord = {
    run_at: new Date().toISOString(),
    date: today,
    rolled_window_forward: rolled,
    output_file: path.relative(ROOT, dayFile),
    latest_file: path.relative(ROOT, LATEST_PATH),
    active_cases: activeCount,
    red_cases: redCount,
    case_stage_breakdown: stageCount,
    total_notifications_on_file: notifications.length
  };
  manifest.runs.push(runRecord);
  manifest.last_run_date = today;
  saveJSON(MANIFEST_PATH, manifest);

  // ---- notifications_log.csv (append-only, deduplicated — only logs notifications not already recorded) ----
  const csvHeader = 'run_date,notification_date,plan_title,risk,priority,contacts,status\n';
  if (!fs.existsSync(NOTIF_LOG_PATH)) fs.writeFileSync(NOTIF_LOG_PATH, csvHeader);
  const existingCsv = fs.readFileSync(NOTIF_LOG_PATH, 'utf8');
  const existingKeys = new Set(
    existingCsv.split('\n').slice(1).filter(Boolean).map(line => {
      const f = parseCsvLine(line); // run_date,notification_date,plan_title,risk,priority,contacts,status
      return [f[1], f[2], f[3], f[4], f[5]].join('\u0001');
    })
  );
  let newRows = 0;
  const csvLines = [];
  notifications.forEach(n => {
    const key = [n.date, n.plan, n.risk, n.priority, n.contacts].join('\u0001');
    if (!existingKeys.has(key)) {
      const rowKey = [n.date, `"${n.plan.replace(/"/g, '""')}"`, n.risk, n.priority, `"${n.contacts.replace(/"/g, '""')}"`].join(',');
      csvLines.push([today, rowKey, n.status].join(','));
      existingKeys.add(key);
      newRows++;
    }
  });
  if (csvLines.length) fs.appendFileSync(NOTIF_LOG_PATH, csvLines.join('\n') + '\n');

  // ---- console summary ----
  console.log(`Run complete for ${today}`);
  console.log(`  Window rolled forward: ${rolled}`);
  console.log(`  Active cases: ${activeCount} (${redCount} Red)`);
  console.log(`  Case stages: ${JSON.stringify(stageCount)}`);
  console.log(`  Output: ${runRecord.output_file}`);
  console.log(`  Latest (refreshed): ${runRecord.latest_file}`);
  console.log(`  New notification rows logged this run: ${newRows} (${existingKeys.size} total on file)`);
  console.log(`  Manifest entries so far: ${manifest.runs.length}`);
}

main();
