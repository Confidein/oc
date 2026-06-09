#!/bin/bash
# =============================================================
# setup.sh - 在新机器上部署 OC 配置，或更新已有机器
#
# 用法:
#   bash setup.sh              # 部署全部（不含 cron 注册）
#   bash setup.sh --all        # 部署全部 + 注册 cron
#   bash setup.sh --crons      # 只注册 cron
#   bash setup.sh --links      # 建软链接（测试机用）
# =============================================================

set -e
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC_DIR="$HOME/.openclaw"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

MODE="${1:---default}"

# ── 1. 同步 workspace ──────────────────────────────────────
sync_workspace() {
  log "同步 workspace..."
  rsync -av \
    --exclude='.git/' --exclude='.backups/' --exclude='.openclaw/' \
    --exclude='state/' --exclude='memory/' \
    --exclude='*.log' --exclude='*_state.json' \
    --exclude='__pycache__/' --exclude='*.pyc' \
    "$REPO_DIR/workspace/" "$OC_DIR/workspace/"
  log "workspace ✓"
}

# ── 2. 同步自定义 plugin-skills ────────────────────────────
sync_skills() {
  log "同步自定义 plugin-skills..."
  for skill_dir in "$REPO_DIR/plugin-skills"/*/; do
    skill_name=$(basename "$skill_dir")
    rsync -av \
      --exclude='assets/logs/' --exclude='assets/state.json' \
      --exclude='assets/*.lock' --exclude='assets/new_comments_latest.json' \
      --exclude='assets/analyses/' --exclude='__pycache__/' --exclude='*.pyc' \
      "$skill_dir" "$OC_DIR/plugin-skills/$skill_name/"
    log "  ✓ $skill_name"
  done
}

# ── 3. 同步自定义 extensions ───────────────────────────────
sync_extensions() {
  log "同步自定义 extensions..."
  for ext_dir in "$REPO_DIR/extensions"/*/; do
    [ -d "$ext_dir" ] || continue
    ext_name=$(basename "$ext_dir")
    dest="$OC_DIR/extensions/$ext_name"
    rsync -av --exclude='node_modules/' "$ext_dir" "$dest/"
    if [ -f "$dest/package.json" ]; then
      log "  安装依赖: $ext_name"
      cd "$dest" && npm install --production --silent && cd - > /dev/null
    fi
    log "  ✓ $ext_name"
  done
}

# ── 4. 同步 credentials-template ──────────────────────────
sync_credentials() {
  log "同步 credentials..."
  mkdir -p "$OC_DIR/credentials"
  # 只同步非 secret 文件（白名单等）
  cp "$REPO_DIR/credentials-template/feishu-default-allowFrom.json" \
     "$OC_DIR/credentials/feishu-default-allowFrom.json"
  # secret 文件：如不存在则提示用户手动创建
  if [ ! -f "$OC_DIR/credentials/lark.secrets.json" ]; then
    warn "credentials/lark.secrets.json 不存在！"
    warn "请参考 credentials-template/lark.secrets.json.template 手动创建"
  fi
  log "credentials ✓"
}

# ── 5. 应用配置模板 ─────────────────────────────────────────
apply_config() {
  TEMPLATE="$REPO_DIR/openclaw.template.json"
  DEST="$OC_DIR/openclaw.json"
  if [ -f "$DEST" ]; then
    warn "openclaw.json 已存在，跳过（避免覆盖已有 token）"
    warn "如需重置: cp $TEMPLATE $DEST 然后手动填入 API key"
  else
    cp "$TEMPLATE" "$DEST"
    log "openclaw.json 已创建，请填入 API key 和 token！"
  fi
}

# ── 6. 安装官方插件 ─────────────────────────────────────────
install_plugins() {
  log "安装官方插件..."
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    pkg=$(echo "$line" | awk '{print $NF}')
    log "  安装 $pkg..."
    openclaw plugins install "$pkg" 2>/dev/null || warn "  $pkg 安装失败，请手动检查"
  done < "$REPO_DIR/plugins.list"
  log "plugins ✓"
}

# ── 7. 注册 cron 定时任务 ───────────────────────────────────
register_crons() {
  log "注册定时任务..."
  CRONS_FILE="$REPO_DIR/crons/shared-crons.json"
  [ -f "$CRONS_FILE" ] || { warn "crons/shared-crons.json 不存在，跳过"; return; }

  # 获取当前已有的 cron 名称
  existing=$(openclaw cron list --json 2>/dev/null | python3 -c "
import json,sys
jobs = json.load(sys.stdin).get('jobs', [])
print('\n'.join(j['name'] for j in jobs))
" 2>/dev/null || echo "")

  python3 -c "
import json, sys
with open('$CRONS_FILE') as f:
    crons = json.load(f)
existing = '''$existing'''.strip().split('\n')
for cron in crons:
    if cron['name'] in existing:
        print(f'  跳过（已存在）: {cron[\"name\"]}')
    else:
        print(f'  待注册: {cron[\"name\"]}')
"
  warn "cron 自动注册需要 OC 运行中，请在 OC 启动后手动注册或使用 OC cron 工具"
  log "crons ✓（请检查上方提示）"
}

# ── 8. 建软链接（测试机专用）───────────────────────────────
setup_symlinks() {
  log "建立软链接（测试机模式）..."
  for skill_dir in "$REPO_DIR/plugin-skills"/*/; do
    skill_name=$(basename "$skill_dir")
    dest="$OC_DIR/plugin-skills/$skill_name"
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      rm -rf "$dest"
    fi
    ln -sfn "$skill_dir" "$dest"
    log "  ✓ 软链接: plugin-skills/$skill_name"
  done
  for ext_dir in "$REPO_DIR/extensions"/*/; do
    [ -d "$ext_dir" ] || continue
    ext_name=$(basename "$ext_dir")
    dest="$OC_DIR/extensions/$ext_name"
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      rm -rf "$dest"
    fi
    ln -sfn "$ext_dir" "$dest"
    # 安装依赖（软链接目录里）
    if [ -f "$ext_dir/package.json" ]; then
      cd "$ext_dir" && npm install --production --silent && cd - > /dev/null
    fi
    log "  ✓ 软链接: extensions/$ext_name"
  done
  log "软链接建立完成 ✓"
}

# ── 主流程 ──────────────────────────────────────────────────
log "OC 配置部署 (mode: $MODE)"
log "来源: $REPO_DIR"
log "目标: $OC_DIR"
echo ""

case "$MODE" in
  --links)
    # 测试机：建软链接 + 同步 workspace + credentials
    sync_workspace
    sync_credentials
    apply_config
    setup_symlinks
    install_plugins
    ;;
  --crons)
    register_crons
    ;;
  --all)
    sync_workspace
    sync_skills
    sync_extensions
    sync_credentials
    apply_config
    install_plugins
    register_crons
    ;;
  --default | *)
    # 生产机默认：硬拷贝，不建软链接
    sync_workspace
    sync_skills
    sync_extensions
    sync_credentials
    apply_config
    install_plugins
    ;;
esac

echo ""
log "部署完成！"
if [ "$MODE" != "--crons" ]; then
  log "下一步: openclaw gateway restart"
fi
