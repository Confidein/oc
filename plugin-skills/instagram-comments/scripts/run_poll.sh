#!/usr/bin/env bash
# 系统 crontab 入口：执行轮询并留存完整 stdout 日志
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SKILL_DIR/assets/logs"
LOCK_FILE="$SKILL_DIR/assets/.poll.lock"
mkdir -p "$LOG_DIR"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_LOG="$LOG_DIR/run_${STAMP}.log"

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[${STAMP}] skip: previous instagram poll still running" >> "$SKILL_DIR/assets/cron.log"
  exit 0
fi

python3 "$SCRIPT_DIR/instagram_comments.py" >> "$RUN_LOG" 2>&1
EXIT=$?

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] instagram wrapper exit=$EXIT log=$RUN_LOG" \
  >> "$SKILL_DIR/assets/cron.log"

exit $EXIT
