#!/usr/bin/env node
/**
 * migrate-lancedb-to-rds.mjs
 * 
 * 将生产机旧版 LanceDB 公共记忆迁移到 AWS RDS pgvector
 * 
 * 在生产机上运行：
 *   node migrate-lancedb-to-rds.mjs
 * 
 * 前提：
 *   1. 生产机已有 ~/.openclaw/company-memory/lancedb/ 数据
 *   2. 已安装加密密钥 ~/.openclaw/credentials/company-memory.key
 *   3. RDS 安全组已放行本机 IP
 */

import fs   from "node:fs/promises";
import os   from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ── 配置（按需修改）────────────────────────────────────────
const CONFIG = {
  // 旧 LanceDB 路径（通常是这个，如有自定义请修改）
  lanceDbPath: path.join(os.homedir(), ".openclaw/company-memory/lancedb"),
  tableName:   "memories",

  // 新 RDS 连接
  rdsConnection: "postgresql://postgres:ocpgsql2026@ocmemory.ca1a4imso7ia.us-east-1.rds.amazonaws.com:5432/postgres",

  // 加密密钥文件
  keyFile: path.join(os.homedir(), ".openclaw/credentials/company-memory.key"),

  // 迁移控制
  dryRun:    false,  // true = 只预览不写入
  batchSize: 50,     // 每批写入条数
  onlyPublic: true,  // 只迁移 public 记忆（private 留在本地）
};

const ENC_ALGO = "aes-256-gcm";

// ── 工具函数 ─────────────────────────────────────────────────

function encryptField(key, plaintext) {
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv(ENC_ALGO, key, iv);
  const enc = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function formatSize(bytes) {
  return bytes > 1024*1024 ? `${(bytes/1024/1024).toFixed(1)}MB`
       : bytes > 1024      ? `${(bytes/1024).toFixed(1)}KB`
       : `${bytes}B`;
}

// ── 主流程 ───────────────────────────────────────────────────

async function main() {
  console.log("=== LanceDB → RDS pgvector 迁移工具 ===\n");

  // 1. 检查旧数据目录
  try {
    await fs.access(CONFIG.lanceDbPath);
  } catch {
    console.error(`❌ 未找到 LanceDB 数据目录: ${CONFIG.lanceDbPath}`);
    console.error("   请确认旧版 company-memory 的 dbPath 配置");
    process.exit(1);
  }

  const lanceFiles = await fs.readdir(CONFIG.lanceDbPath);
  console.log(`✅ LanceDB 目录: ${CONFIG.lanceDbPath}`);
  console.log(`   包含文件: ${lanceFiles.join(", ")}\n`);

  // 2. 加载加密密钥
  let encKey;
  try {
    encKey = Buffer.from(
      (await fs.readFile(CONFIG.keyFile, "utf8")).trim(), "hex"
    );
    console.log(`✅ 加密密钥已加载: ${CONFIG.keyFile}`);
  } catch {
    console.error(`❌ 未找到加密密钥: ${CONFIG.keyFile}`);
    console.error("   请先从测试机复制密钥：");
    console.error("   echo '<hex内容>' > ~/.openclaw/credentials/company-memory.key");
    console.error("   chmod 600 ~/.openclaw/credentials/company-memory.key");
    process.exit(1);
  }

  // 3. 动态加载 LanceDB（需要旧版扩展的 node_modules）
  const lancedbPaths = [
    path.join(os.homedir(), ".openclaw/extensions/company-memory/node_modules/@lancedb/lancedb"),
    path.join(os.homedir(), "my-oc-config/extensions/company-memory/node_modules/@lancedb/lancedb"),
    "/home/ubuntu/.openclaw/extensions/company-memory/node_modules/@lancedb/lancedb",
  ];

  let lancedb = null;
  for (const p of lancedbPaths) {
    try {
      await fs.access(p);
      lancedb = await import(`${p}/dist/index.js`);
      console.log(`✅ LanceDB 模块: ${p}\n`);
      break;
    } catch {}
  }

  if (!lancedb) {
    console.error("❌ 找不到 LanceDB 模块。请安装旧依赖后重试：");
    console.error("   cd ~/.openclaw/extensions/company-memory && npm install @lancedb/lancedb");
    process.exit(1);
  }

  // 4. 读取 LanceDB 数据
  console.log("📖 读取 LanceDB 数据...");
  const db    = await lancedb.connect(CONFIG.lanceDbPath);
  const names = await db.tableNames();
  console.log(`   表: ${names.join(", ")}`);

  if (!names.includes(CONFIG.tableName)) {
    console.error(`❌ 表 "${CONFIG.tableName}" 不存在`);
    process.exit(1);
  }

  const table   = await db.openTable(CONFIG.tableName);
  let   allRows = await table.search([0]).limit(999999).toArray().catch(async () => {
    // 有些版本需要不同方式全量读
    return table.query().limit(999999).toArray();
  });

  // 过滤
  if (CONFIG.onlyPublic) {
    allRows = allRows.filter(r => r.visibility === "public");
  }

  console.log(`   共读取 ${allRows.length} 条${CONFIG.onlyPublic ? "公共" : ""}记忆\n`);

  if (allRows.length === 0) {
    console.log("⚠️  没有数据需要迁移");
    process.exit(0);
  }

  // 5. 连接 RDS
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: CONFIG.rdsConnection,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  // 检查连接
  const { rows: [ver] } = await pool.query("SELECT version()");
  console.log(`✅ RDS 已连接: ${ver.version.split(",")[0]}`);

  // 检查重复
  const { rows: [cnt] } = await pool.query(
    "SELECT COUNT(*) AS n FROM memories WHERE visibility='public'"
  );
  console.log(`   RDS 现有公共记忆: ${cnt.n} 条\n`);

  if (CONFIG.dryRun) {
    console.log("🔍 [DRY RUN 模式] 预览前 5 条：");
    for (const row of allRows.slice(0, 5)) {
      console.log(`   [${row.visibility}][${row.category}] ${String(row.text).slice(0, 60)}...`);
    }
    console.log(`\n共 ${allRows.length} 条待迁移，设 dryRun=false 后正式执行`);
    await pool.end();
    return;
  }

  // 6. 批量写入 RDS
  console.log(`📤 开始迁移（批次大小: ${CONFIG.batchSize}）...\n`);

  let migrated = 0, skipped = 0, errors = 0;
  const batches = Math.ceil(allRows.length / CONFIG.batchSize);

  for (let b = 0; b < batches; b++) {
    const batch = allRows.slice(b * CONFIG.batchSize, (b+1) * CONFIG.batchSize);

    for (const row of batch) {
      try {
        // 检查是否已迁移（source_id 去重）
        if (row.source_id) {
          const { rows: dup } = await pool.query(
            "SELECT 1 FROM memories WHERE source_id=$1 AND source=$2 LIMIT 1",
            [row.source_id, row.source ?? ""]
          );
          if (dup.length > 0) { skipped++; continue; }
        }

        const encText  = encryptField(encKey, String(row.text ?? ""));
        const vector   = Array.isArray(row.vector) ? row.vector
                       : Array.from(row.vector ?? []);
        const vectorStr = `[${vector.join(",")}]`;

        await pool.query(
          `INSERT INTO memories
             (id,tenant_id,text,category,importance,source,source_id,module,
              created_at,updated_at,visibility,owner_user_id,chat_id,channel,vector)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
           ON CONFLICT (id) DO NOTHING`,
          [
            row.id         ?? crypto.randomUUID(),
            row.tenant_id  ?? "default",
            encText,
            row.category   ?? "",
            row.importance ?? 0,
            row.source     ?? "",
            row.source_id  ?? "",
            row.module     ?? "general",
            row.created_at ?? new Date().toISOString(),
            row.updated_at ?? new Date().toISOString(),
            row.visibility ?? "public",
            row.owner_user_id ?? "",
            row.chat_id    ?? "",
            row.channel    ?? "",
            vectorStr,
          ]
        );
        migrated++;
      } catch (err) {
        errors++;
        console.error(`   ❌ 第 ${migrated+skipped+errors} 条失败: ${err.message}`);
      }
    }

    const pct = Math.round(((b+1)/batches)*100);
    process.stdout.write(`\r   进度: ${pct}% (${migrated}迁移 / ${skipped}跳过 / ${errors}错误)`);
  }

  console.log("\n");

  // 7. 最终统计
  const { rows: [final] } = await pool.query(
    "SELECT COUNT(*) AS n FROM memories WHERE visibility='public'"
  );

  console.log("=== 迁移完成 ===");
  console.log(`✅ 成功迁移: ${migrated} 条`);
  console.log(`⏭️  跳过重复: ${skipped} 条`);
  console.log(`❌ 失败:     ${errors} 条`);
  console.log(`📊 RDS 现有公共记忆: ${final.n} 条`);

  await pool.end();
}

main().catch(err => {
  console.error("\n❌ 迁移失败:", err.message);
  process.exit(1);
});
