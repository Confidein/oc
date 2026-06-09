#!/bin/bash
# prod-setup.sh - 生产机配置补丁脚本
# 用法：bash ~/my-oc-config/scripts/prod-setup.sh
#
# 完成：
#   Step 3 - openclaw.json 加入 company-memory / feishu-memory-sync / tools
#   Step 4 - auth-profiles.json 加入 OpenAI key
#   Step 5 - 迁移 LanceDB 数据到 RDS

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

OC_DIR="$HOME/.openclaw"
OC_JSON="$OC_DIR/openclaw.json"
AUTH_JSON="$OC_DIR/agents/main/agent/auth-profiles.json"

# ── 读取参数 ────────────────────────────────────────────────
echo ""
echo "=== 生产机配置补丁 ==="
echo ""

# OpenAI Key
read -p "请输入 OpenAI API Key (sk-...): " OPENAI_KEY
[ -z "$OPENAI_KEY" ] && err "OpenAI Key 不能为空"

# 飞书 AppID / AppSecret
read -p "请输入飞书 App ID (cli_...): "   FEISHU_APP_ID
read -p "请输入飞书 App Secret: "          FEISHU_APP_SECRET

echo ""

# ── Step 3: 修改 openclaw.json ───────────────────────────────
log "Step 3: 更新 openclaw.json..."

[ -f "$OC_JSON" ] || err "未找到 $OC_JSON，请先运行 bash setup.sh"

cp "$OC_JSON" "$OC_JSON.bak-prod-$(date +%Y%m%d%H%M%S)"
log "  已备份原配置"

python3 - "$OC_JSON" "$OPENAI_KEY" "$FEISHU_APP_ID" "$FEISHU_APP_SECRET" << 'PY'
import json, sys

path        = sys.argv[1]
openai_key  = sys.argv[2]
feishu_id   = sys.argv[3]
feishu_sec  = sys.argv[4]

with open(path) as f:
    cfg = json.load(f)

plugins = cfg.setdefault('plugins', {})
entries = plugins.setdefault('entries', {})
allow   = plugins.setdefault('allow', [])

# ── company-memory ──
entries['company-memory'] = {
    "enabled": True,
    "config": {
        "pgvector": {
            "connectionString": "postgresql://postgres:ocpgsql2026@ocmemory.ca1a4imso7ia.us-east-1.rds.amazonaws.com:5432/postgres",
            "ssl": True,
            "poolMin": 1,
            "poolMax": 5
        },
        "tableName": "memories",
        "tenantId": "default",
        "vectorDimensions": 1536,
        "embedding": {
            "provider": "openai",
            "model": "text-embedding-3-small",
            "apiKey": openai_key
        },
        "limits": {
            "defaultSearchLimit": 8,
            "maxSearchLimit": 20,
            "maxStoreChars": 12000
        }
    }
}

# ── feishu-memory-sync ──
entries['feishu-memory-sync'] = {
    "enabled": True,
    "config": {
        "feishu": {
            "appId":     feishu_id,
            "appSecret": feishu_sec,
            "domain":    "open.feishu.cn"
        },
        "groups": {"enabled": True, "module": "general", "minTextLength": 10, "maxChatsPerRun": 100, "maxMessagesPerChat": 50},
        "docs":   {"enabled": True, "module": "general", "chunkSize": 800, "maxChunksPerDoc": 100, "maxDocsPerRun": 20}
    }
}

# ── allow 白名单 ──
for p in ['company-memory', 'feishu-memory-sync']:
    if p not in allow:
        allow.append(p)

# ── tools.alsoAllow ──
tools = cfg.setdefault('tools', {})
also  = tools.setdefault('alsoAllow', [])
memory_tools = [
    'company_context_search', 'private_memory_store',
    'public_memory_store', 'public_memory_store_batch',
    'feishu_im_bot_sync_group_messages', 'feishu_doc_sync_public_memory'
]
for t in memory_tools:
    if t not in also:
        also.append(t)

with open(path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print("  ✅ company-memory 配置已写入")
print("  ✅ feishu-memory-sync 配置已写入")
print("  ✅ plugins.allow 已更新:", allow)
print("  ✅ tools.alsoAllow 已添加 memory 工具")
PY

log "Step 3 完成 ✓"
echo ""

# ── Step 4: 修改 auth-profiles.json ─────────────────────────
log "Step 4: 写入 OpenAI Key 到 auth-profiles.json..."

[ -f "$AUTH_JSON" ] || err "未找到 $AUTH_JSON，请确认 OC 已初始化"

python3 - "$AUTH_JSON" "$OPENAI_KEY" << 'PY'
import json, sys

path       = sys.argv[1]
openai_key = sys.argv[2]

with open(path) as f:
    data = json.load(f)

data.setdefault('profiles', {})['openai:default'] = {
    "type":     "api_key",
    "provider": "openai",
    "key":      openai_key
}

with open(path, 'w') as f:
    json.dump(data, f, indent=2)

print("  ✅ openai:default 已写入 auth-profiles.json")
print("  当前 profiles:", list(data['profiles'].keys()))
PY

log "Step 4 完成 ✓"
echo ""

# ── Step 5: 迁移 LanceDB 数据 ────────────────────────────────
MIGRATE_SCRIPT="$HOME/my-oc-config/scripts/migrate-lancedb-to-rds.mjs"
LANCE_DIR="$OC_DIR/company-memory/lancedb"

if [ ! -d "$LANCE_DIR" ]; then
    warn "Step 5: 未找到 LanceDB 数据目录 ($LANCE_DIR)，跳过迁移"
    warn "  如果数据在其他路径，请手动运行: node $MIGRATE_SCRIPT"
else
    log "Step 5: 发现 LanceDB 数据，开始迁移..."
    echo ""
    node "$MIGRATE_SCRIPT" || warn "迁移脚本报错，请检查日志后手动重跑"
    log "Step 5 完成 ✓"
fi

echo ""
log "=== 所有步骤完成！==="
log "运行以下命令重启 OC："
echo ""
echo "    openclaw gateway restart"
echo ""
log "重启后验证："
echo ""
echo "    openclaw plugins list"
echo ""
