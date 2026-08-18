#!/usr/bin/env bash
# run_daily.sh — wrapper for scheduled execution (cron / Task Scheduler / systemd timer)
#
# Why this exists instead of calling `node generate_daily_plan.js` directly:
#   - cron runs with a minimal environment (often no PATH to node) — this
#     script resolves node explicitly and fails loudly if it's missing.
#   - Logs every run's output with a timestamp so you can check what
#     happened without re-running it.
#   - Non-zero exit code on failure, so cron's own failure-mail/alerting
#     (if you have it configured) actually fires.
#
# USAGE:
#   ./run_daily.sh
#
# CRON EXAMPLE (Linux/Mac) — runs daily at 06:00 server time:
#   crontab -e
#   0 6 * * * /absolute/path/to/planning/run_daily.sh
#
# WINDOWS TASK SCHEDULER:
#   Program/script:  wsl.exe   (if using WSL)  — or a .bat wrapper calling node.exe directly
#   Arguments:        bash -lc "/path/to/planning/run_daily.sh"
#   Trigger:          Daily, 06:00
#
# SYSTEMD TIMER (Linux, more robust than cron for servers):
#   See run_daily.service.example and run_daily.timer.example in this folder.
#   Copy both to /etc/systemd/system/ (drop the .example suffix, fill in the
#   real path), then: systemctl daemon-reload && systemctl enable --now run_daily.timer

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/run_$(date -u +%Y-%m-%d).log"
NODE_BIN="$(command -v node || true)"

mkdir -p "$LOG_DIR"

{
  echo "===== $(date -u +'%Y-%m-%dT%H:%M:%SZ') — starting daily plan generation ====="

  if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node not found on PATH. Install Node.js or set NODE_BIN explicitly in this script."
    exit 1
  fi
  echo "Using node at: $NODE_BIN ($($NODE_BIN --version))"

  cd "$SCRIPT_DIR"
  "$NODE_BIN" generate_daily_plan.js

  echo "===== $(date -u +'%Y-%m-%dT%H:%M:%SZ') — done ====="
} >> "$LOG_FILE" 2>&1

# also echo the last run's summary to stdout so cron mail / manual runs show it immediately
tail -n 12 "$LOG_FILE"
