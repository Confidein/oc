#!/bin/bash
# =============================================================
# deploy.sh - 生产机专用：备份 → 拉取最新代码 → 部署 → 重启
# 用法: bash deploy.sh
# =============================================================

set -e
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC_DIR="$HOME/.openclaw"
BACKUP_ROOT="$HOME/.openclaw-backups"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

# ── 1. 备份当前状态 ────────────────────────────────────────
backup() {
  log "备份当前状态 → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"

  cp -r "$OC_DIR/workspace"      "$BACKUP_DIR/" 2>/dev/null || true
  cp -r "$OC_DIR/extensions"     "$BACKUP_DIR/" 2>/dev/null || true
  cp -r "$OC_DIR/plugin-skills"  "$BACKUP_DIR/" 2>/dev/null || true
  cp -r "$OC_DIR/credentials"    "$BACKUP_DIR/" 2>/dev/null || true
  cp    "$OC_DIR/openclaw.json"  "$BACKUP_DIR/" 2>/dev/null || true

  log "备份完成 $(du -sh $BACKUP_DIR | cut -f1)"

  # 只保留最近 5 次备份
  ls -1dt "$BACKUP_ROOT"/* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
  log "历史备份：保留最近 5 次"
}

# ── 2. 拉取最新代码 ────────────────────────────────────────
pull() {
  log "拉取最新代码..."
  cd "$REPO_DIR"

  # 显示将要更新的内容
  git fetch origin main
  COMMITS=$(git log HEAD..origin/main --oneline)
  if [ -z "$COMMITS" ]; then
    warn "没有新提交，已是最新版本"
    echo ""
    read -p "仍然继续部署？[y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { log "已取消"; exit 0; }
  else
    log "新提交："
    echo "$COMMITS" | sed 's/^/  /'
    echo ""
    read -p "确认部署？[y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { log "已取消"; exit 0; }
  fi

  git pull origin main
  log "代码已更新"
}

# ── 3. 部署到 OC 目录 ──────────────────────────────────────
deploy() {
  log "部署文件..."
  bash "$REPO_DIR/setup.sh"
}

# ── 4. 重启 OC ─────────────────────────────────────────────
restart() {
  log "重启 OC..."
  openclaw gateway restart
  sleep 3

  # 验证是否启动成功
  STATUS=$(openclaw gateway status 2>/dev/null | grep "Connectivity probe" || echo "")
  if echo "$STATUS" | grep -q "ok"; then
    log "OC 启动成功 ✓"
  else
    err "OC 启动异常，请检查！如需回滚执行：bash $REPO_DIR/rollback.sh"
  fi
}

# ── 主流程 ─────────────────────────────────────────────────
echo ""
log "===== 生产机部署开始 ====="
echo ""

backup
echo ""
pull
echo ""
deploy
echo ""
restart

echo ""
log "===== 部署完成 ====="
log "备份位置: $BACKUP_DIR"
log "如需回滚: bash $REPO_DIR/rollback.sh"
