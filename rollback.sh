#!/bin/bash
# =============================================================
# rollback.sh - 回滚到上一次备份
# 用法: bash rollback.sh           # 回滚到最新备份
#       bash rollback.sh --list    # 查看所有备份
#       bash rollback.sh 20260609-093440  # 回滚到指定备份
# =============================================================

set -e
BACKUP_ROOT="$HOME/.openclaw-backups"
OC_DIR="$HOME/.openclaw"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[rollback]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# 列出备份
if [ "${1}" = "--list" ]; then
  log "可用备份："
  ls -1dt "$BACKUP_ROOT"/* 2>/dev/null | while read dir; do
    echo "  $(basename $dir)  ($(du -sh $dir | cut -f1))"
  done
  exit 0
fi

# 选择备份
if [ -n "$1" ]; then
  BACKUP_DIR="$BACKUP_ROOT/$1"
  [ -d "$BACKUP_DIR" ] || err "备份不存在: $BACKUP_DIR"
else
  BACKUP_DIR=$(ls -1dt "$BACKUP_ROOT"/* 2>/dev/null | head -1)
  [ -n "$BACKUP_DIR" ] || err "没有找到备份，请先运行 deploy.sh"
fi

echo ""
warn "即将回滚到: $(basename $BACKUP_DIR)"
read -p "确认回滚？[y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { log "已取消"; exit 0; }

log "停止 OC..."
openclaw gateway stop 2>/dev/null || true

log "恢复文件..."
[ -d "$BACKUP_DIR/extensions" ]    && cp -r "$BACKUP_DIR/extensions"    "$OC_DIR/"
[ -d "$BACKUP_DIR/plugin-skills" ] && cp -r "$BACKUP_DIR/plugin-skills" "$OC_DIR/"
[ -d "$BACKUP_DIR/workspace" ]     && cp -r "$BACKUP_DIR/workspace"     "$OC_DIR/"
[ -f "$BACKUP_DIR/openclaw.json" ] && cp    "$BACKUP_DIR/openclaw.json" "$OC_DIR/"

log "重启 OC..."
openclaw gateway start

echo ""
log "回滚完成 ✓"
log "已恢复到: $(basename $BACKUP_DIR)"
