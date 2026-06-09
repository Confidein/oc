#!/usr/bin/env bash
# 系统 crontab 入口：执行轮询并留存完整 stdout 日志
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SKILL_DIR/assets/logs"
mkdir -p "$LOG_DIR"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_LOG="$LOG_DIR/run_${STAMP}.log"

python3 "$SCRIPT_DIR/facebook_comments.py" >> "$RUN_LOG" 2>&1
EXIT=$?

if [[ $EXIT -ne 0 ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] facebook wrapper exit=$EXIT log=$RUN_LOG" \
    >> "$SKILL_DIR/assets/cron.log"
fi

exit $EXIT
