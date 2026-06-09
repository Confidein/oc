import pg from "pg";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveApiKeyForProvider } from "/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/provider-auth-runtime.js";

const { Pool } = pg;
const PLUGIN_ID = "company-memory";
const ENC_ALGO = "aes-256-gcm";

// ── 默认配置 ─────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  pgvector: {
    connectionString: "",
    ssl: true,
    poolMin: 1,
    poolMax: 5
  },
  localPath: "~/.openclaw/company-memory/private",
  tableName: "memories",
  tenantId: "default",
  vectorDimensions: 1536,
  defaultModules: ["general"],   // 搜索时默认查哪些模块
  allowedModules: null,          // null = 不限制；数组 = 白名单
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com/v1"
  },
  limits: {
    defaultSearchLimit: 8,
    maxSearchLimit: 20,
    maxStoreChars: 12000
  }
};

// ── Tool 参数 Schema ──────────────────────────────────────────

const SearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Question or search text." },
    limit: { type: "number", description: "Maximum memories to return." },
    includePrivate: {
      type: "boolean",
      description: "Direct chats include private memory by default. Set false for public-only."
    },
    modules: {
      type: "array",
      items: { type: "string" },
      description: "Public modules to search, e.g. ['general'], ['hr','finance']. Default: configured defaultModules. Use ['*'] for all."
    }
  },
  required: ["query"],
  additionalProperties: false
};

const PrivateStoreSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "Private memory text (will be encrypted locally)." },
    category: { type: "string", description: "Optional category, e.g. preference, project, todo." },
    importance: { type: "number", description: "Importance score 0–1." },
    source_id: { type: "string", description: "Optional source id." }
  },
  required: ["text"],
  additionalProperties: false
};

const PublicStoreSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "Public company memory text (will be encrypted in RDS)." },
    module: { type: "string", description: "Target module. Default: 'general'. Examples: 'hr', 'finance'." },
    category: { type: "string", description: "Optional category." },
    importance: { type: "number", description: "Importance score 0–1." },
    source: { type: "string", description: "Source label, e.g. lark_group, lark_wiki, manual." },
    source_id: { type: "string", description: "Stable source id for deduplication." }
  },
  required: ["text"],
  additionalProperties: false
};

const PublicBatchStoreSchema = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["insert_only", "upsert"],
      description: "insert_only skips duplicate source_id. upsert replaces existing."
    },
    delete_source_ids: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_id: { type: "string" },
          module: { type: "string" }
        },
        required: ["source", "source_id"],
        additionalProperties: false
      }
    },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          module: { type: "string", description: "Target module. Default: 'general'." },
          category: { type: "string" },
          importance: { type: "number" },
          source: { type: "string" },
          source_id: { type: "string" },
          chat_id: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    items_file: { type: "string" },
    dryRun: { type: "boolean" }
  },
  required: [],
  additionalProperties: false
};

// ── 配置 ─────────────────────────────────────────────────────

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    pgvector: { ...base.pgvector, ...(override?.pgvector ?? {}) },
    embedding: { ...base.embedding, ...(override?.embedding ?? {}) },
    limits: { ...base.limits, ...(override?.limits ?? {}) }
  };
}

function resolveConfig(api, ctx) {
  const runtimeConfig = ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api?.config ?? {};
  const pluginConfig = runtimeConfig?.plugins?.entries?.[PLUGIN_ID]?.config ?? api?.pluginConfig ?? {};
  return mergeConfig(DEFAULT_CONFIG, pluginConfig);
}

function expandHome(p) {
  if (!p || p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 根据配置解析要搜索的模块列表
function resolveSearchModules(config, requestedModules) {
  const defaultModules = config.defaultModules ?? ["general"];
  const allowedModules = config.allowedModules; // null = 不限制

  let modules = Array.isArray(requestedModules) && requestedModules.length > 0
    ? requestedModules
    : defaultModules;

  // 应用白名单限制
  if (Array.isArray(allowedModules)) {
    if (modules.includes("*")) {
      return { modules: allowedModules, searchAll: false };
    }
    modules = modules.filter(m => allowedModules.includes(m));
  }

  const searchAll = modules.includes("*");
  return { modules: searchAll ? [] : modules, searchAll };
}

// ── 加密层（AES-256-GCM）────────────────────────────────────

let _encKey = null; // 缓存，避免重复读文件

async function getEncryptionKey(config) {
  if (_encKey) return _encKey;

  // 优先使用 config 里的 key
  if (config.encryptionKey) {
    _encKey = Buffer.from(String(config.encryptionKey), "hex");
    return _encKey;
  }

  // 从本地文件加载或自动生成
  const keyPath = expandHome("~/.openclaw/credentials/company-memory.key");
  try {
    const hex = (await fs.readFile(keyPath, "utf8")).trim();
    _encKey = Buffer.from(hex, "hex");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // 首次运行：自动生成密钥
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, key.toString("hex"), { mode: 0o600 });
    console.log(`[company-memory] 已自动生成加密密钥并保存至 ${keyPath}`);
    _encKey = key;
  }
  return _encKey;
}

// 加密单个字段 → base64 字符串（iv12 + authTag16 + ciphertext）
function encryptField(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

// 解密单个字段
function decryptField(key, ciphertext) {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

// 加密记录（只加密 text 字段，其他字段保持明文供查询使用）
async function encryptRecord(config, record) {
  const key = await getEncryptionKey(config);
  return { ...record, text: encryptField(key, record.text) };
}

// 解密行数据
async function decryptRow(config, row) {
  const key = await getEncryptionKey(config);
  try {
    return { ...row, text: decryptField(key, row.text) };
  } catch {
    // 解密失败（旧数据/密钥不匹配）返回占位符
    return { ...row, text: "[encrypted, cannot decrypt]" };
  }
}

// ── 连接池（公共 RDS）────────────────────────────────────────

let _pool = null;
let _poolKey = null;

function getPoolKey(config) {
  const pv = config.pgvector ?? {};
  return JSON.stringify({ cs: pv.connectionString, host: pv.host, port: pv.port, db: pv.database, user: pv.user });
}

function getPool(config) {
  const key = getPoolKey(config);
  if (_pool && key === _poolKey) return _pool;
  if (_pool) _pool.end().catch(() => {});

  const pv = config.pgvector ?? {};
  const ssl = pv.ssl !== false ? { rejectUnauthorized: false } : false;
  const cleanCs = (pv.connectionString ?? "").replace(/[?&]sslmode=[^&]*/g, "").replace(/\?$/, "");

  const poolConfig = cleanCs
    ? { connectionString: cleanCs, ssl, min: pv.poolMin ?? 1, max: pv.poolMax ?? 5 }
    : {
        host: pv.host ?? "localhost",
        port: pv.port ?? 5432,
        database: pv.database ?? "postgres",
        user: pv.user ?? "postgres",
        password: pv.password ?? "",
        ssl,
        min: pv.poolMin ?? 1,
        max: pv.poolMax ?? 5
      };

  _pool = new Pool(poolConfig);
  _pool.on("error", err => console.error("[company-memory] pg pool error:", err.message));
  _poolKey = key;
  return _pool;
}

// ── Schema 初始化（幂等，支持增量迁移）──────────────────────

let _schemaEnsured = false;

async function ensureSchema(config) {
  if (_schemaEnsured) return;
  const pool = getPool(config);
  const table = config.tableName ?? "memories";
  const dims = config.vectorDimensions ?? 1536;
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id            UUID         PRIMARY KEY,
        tenant_id     TEXT         NOT NULL DEFAULT 'default',
        text          TEXT         NOT NULL,
        category      TEXT         NOT NULL DEFAULT '',
        importance    REAL         NOT NULL DEFAULT 0,
        source        TEXT         NOT NULL DEFAULT '',
        source_id     TEXT         NOT NULL DEFAULT '',
        module        TEXT         NOT NULL DEFAULT 'general',
        created_at    TEXT         NOT NULL,
        updated_at    TEXT         NOT NULL,
        visibility    TEXT         NOT NULL,
        owner_user_id TEXT         NOT NULL DEFAULT '',
        chat_id       TEXT         NOT NULL DEFAULT '',
        channel       TEXT         NOT NULL DEFAULT '',
        vector        vector(${dims}) NOT NULL
      )
    `);
    // 增量迁移：旧表若无 module 列则自动添加
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name = 'module'
        ) THEN
          ALTER TABLE ${table} ADD COLUMN module TEXT NOT NULL DEFAULT 'general';
        END IF;
      END $migration$;
    `);
    // 索引
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_vector_hnsw_idx ON ${table} USING hnsw (vector vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_filter_idx ON ${table} (tenant_id, visibility, module)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_source_idx ON ${table} (tenant_id, source, source_id) WHERE source_id <> ''`);
    _schemaEnsured = true;
  } finally {
    client.release();
  }
}

// ── 公共记忆 DB 操作（RDS）──────────────────────────────────

async function addPublicRecord(config, record) {
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";
  const encrypted = await encryptRecord(config, record);
  const vectorStr = `[${record.vector.join(",")}]`;

  await pool.query(
    `INSERT INTO ${table}
       (id,tenant_id,text,category,importance,source,source_id,module,
        created_at,updated_at,visibility,owner_user_id,chat_id,channel,vector)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)`,
    [
      encrypted.id, encrypted.tenant_id, encrypted.text, encrypted.category,
      encrypted.importance, encrypted.source, encrypted.source_id, encrypted.module,
      encrypted.created_at, encrypted.updated_at, encrypted.visibility,
      encrypted.owner_user_id, encrypted.chat_id, encrypted.channel, vectorStr
    ]
  );
}

async function deletePublicSourceRecord(config, source, sourceId, module = null) {
  if (!source || !sourceId) return { deleted: false, reason: "missing_source_or_source_id" };
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";

  let sql = `DELETE FROM ${table} WHERE tenant_id=$1 AND visibility='public' AND source=$2 AND source_id=$3`;
  const params = [config.tenantId, source, sourceId];
  if (module) { sql += ` AND module=$4`; params.push(module); }

  const result = await pool.query(sql, params);
  return { deleted: true, source, source_id: sourceId, deleted_count: result.rowCount };
}

async function searchPublicRecords(config, vector, filterParams, limit) {
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";
  const vectorStr = `[${vector.join(",")}]`;
  const cols = "id,tenant_id,text,category,importance,source,source_id,module,created_at,updated_at,visibility,owner_user_id,chat_id,channel";

  let queryText, params;
  if (filterParams.searchAll) {
    queryText = `SELECT ${cols}, 1-(vector<=>$1::vector) AS score FROM ${table} WHERE tenant_id=$2 AND visibility='public' ORDER BY vector<=>$1::vector LIMIT $3`;
    params = [vectorStr, filterParams.tenantId, limit];
  } else {
    queryText = `SELECT ${cols}, 1-(vector<=>$1::vector) AS score FROM ${table} WHERE tenant_id=$2 AND visibility='public' AND module=ANY($3::text[]) ORDER BY vector<=>$1::vector LIMIT $4`;
    params = [vectorStr, filterParams.tenantId, filterParams.modules, limit];
  }

  const result = await pool.query(queryText, params);
  // 解密 text 字段
  return Promise.all(result.rows.map(row => decryptRow(config, row)));
}

async function sourceRecordExists(config, source, sourceId, module = null) {
  if (!source || !sourceId) return false;
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";

  let sql = `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND visibility='public' AND source=$2 AND source_id=$3`;
  const params = [config.tenantId, source, sourceId];
  if (module) { sql += ` AND module=$4`; params.push(module); }
  sql += " LIMIT 1";

  const result = await pool.query(sql, params);
  return result.rowCount > 0;
}

// ── 私人记忆本地存储（JSONL，每用户一文件）──────────────────

function getPrivateFilePath(config, ownerUserId) {
  const base = expandHome(config.localPath ?? "~/.openclaw/company-memory/private");
  const safeId = String(ownerUserId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(base, `${safeId}.jsonl`);
}

async function appendPrivateRecord(config, ownerUserId, record) {
  const encrypted = await encryptRecord(config, record);
  const { vector, ...rest } = encrypted; // vector 单独保存（不加密）
  const line = JSON.stringify({ ...rest, vector });
  const filePath = getPrivateFilePath(config, ownerUserId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line + "\n", "utf8");
}

async function searchPrivateRecords(config, ownerUserId, queryVector, limit) {
  const filePath = getPrivateFilePath(config, ownerUserId);
  let records;
  try {
    const content = await fs.readFile(filePath, "utf8");
    records = content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  // 本地余弦相似度计算
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }

  const scored = records
    .filter(r => Array.isArray(r.vector) && r.vector.length > 0)
    .map(r => {
      const { vector, ...rest } = r;
      return { ...rest, score: cosine(queryVector, vector) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // 解密 text 字段
  return Promise.all(scored.map(r => decryptRow(config, r)));
}

// ── Embedding ─────────────────────────────────────────────────

async function resolveEmbeddingApiKey(config, ctx) {
  const configured = config.embedding?.apiKey;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const provider = config.embedding?.provider ?? "openai";
  const fromRuntime = await ctx?.resolveApiKeyForProvider?.(provider);
  if (fromRuntime) return fromRuntime;
  const auth = await resolveApiKeyForProvider({
    provider, cfg: ctx?.config ?? ctx?.runtimeConfig,
    agentDir: ctx?.agentDir, workspaceDir: ctx?.workspaceDir
  }).catch(() => null);
  if (auth?.apiKey) return auth.apiKey;
  throw new Error(`Missing embedding API key for provider ${provider}.`);
}

async function embedText(config, ctx, text, signal) {
  const apiKey = await resolveEmbeddingApiKey(config, ctx);
  const baseUrl = String(config.embedding?.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
  const model = config.embedding?.model ?? "text-embedding-3-small";

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error("Embedding response missing vector.");
  return vector;
}

// ── 工具函数 ─────────────────────────────────────────────────

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function readString(params, name, opts = {}) {
  const v = params?.[name];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (opts.required) throw new Error(`${name} is required.`);
  return undefined;
}

function readNumber(params, name) {
  const v = params?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readArray(params, name, opts = {}) {
  const v = params?.[name];
  if (Array.isArray(v)) return v;
  if (opts.required) throw new Error(`${name} is required.`);
  return [];
}

function clampInt(v, min, max, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function truncateText(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function normalizeImportance(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function parseSessionKey(sessionKey) {
  const parts = String(sessionKey ?? "").split(":").filter(Boolean);
  for (const kind of ["direct", "group", "channel"]) {
    const idx = parts.indexOf(kind);
    if (idx >= 0) return { chatType: kind, peerId: parts[idx + 1], channel: parts[2] };
  }
  return { chatType: "unknown", peerId: undefined, channel: parts[2] };
}

function resolveRunContext(ctx, config) {
  const parsed = parseSessionKey(ctx?.sessionKey);
  const delivery = ctx?.deliveryContext ?? {};
  const ownerUserId = ctx?.requesterSenderId ?? (parsed.chatType === "direct" ? parsed.peerId : undefined);
  return {
    tenantId: config.tenantId,
    chatType: parsed.chatType,
    channel: ctx?.messageChannel ?? delivery.channel ?? parsed.channel,
    chatId: delivery.to ?? parsed.peerId,
    ownerUserId
  };
}

function baseRecord(config, params) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenant_id: config.tenantId,
    text: params.text,
    category: params.category ?? "",
    importance: normalizeImportance(params.importance),
    source: params.source ?? "",
    source_id: params.source_id ?? "",
    module: params.module ?? "general",
    created_at: now,
    updated_at: now
  };
}

// ── Tools ────────────────────────────────────────────────────

function createSearchTool(api, ctx) {
  return {
    name: "company_context_search",
    label: "Company Context Search",
    description: "Search company memory. Direct chats: public (module-filtered) + sender's private (local). Group chats: public only.",
    parameters: SearchSchema,
    execute: async (_id, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      const query = readString(rawParams, "query", { required: true });
      const defaultLimit = config.limits?.defaultSearchLimit ?? 8;
      const maxLimit = config.limits?.maxSearchLimit ?? 20;
      const limit = clampInt(readNumber(rawParams, "limit"), 1, maxLimit, defaultLimit);
      const includePrivate = rawParams?.includePrivate !== false;
      const { modules, searchAll } = resolveSearchModules(config, rawParams?.modules);

      const vector = await embedText(config, ctx, query, signal);

      // 并行：公共 RDS 搜索 + 私人本地搜索
      const filterParams = { tenantId: runContext.tenantId, modules, searchAll };
      const [publicResults, privateResults] = await Promise.all([
        searchPublicRecords(config, vector, filterParams, limit),
        includePrivate && runContext.chatType === "direct" && runContext.ownerUserId
          ? searchPrivateRecords(config, runContext.ownerUserId, vector, limit)
          : Promise.resolve([])
      ]);

      // 合并排序取 top-N
      const combined = [...publicResults, ...privateResults]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);

      return jsonResult({
        query,
        modules: searchAll ? ["*"] : modules,
        scope: privateResults.length > 0 ? "public+private" : "public",
        result_count: combined.length,
        results: combined
      });
    }
  };
}

function createPrivateStoreTool(api, ctx) {
  return {
    name: "private_memory_store",
    label: "Private Memory Store",
    description: "Store a private memory locally (encrypted, never uploaded to cloud).",
    parameters: PrivateStoreSchema,
    execute: async (_id, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      if (runContext.chatType !== "direct" || !runContext.ownerUserId) {
        throw new Error("private_memory_store is only available in direct chats.");
      }
      const maxChars = config.limits?.maxStoreChars ?? 12000;
      const text = truncateText(readString(rawParams, "text", { required: true }), maxChars);
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text, category: readString(rawParams, "category"),
          importance: readNumber(rawParams, "importance"),
          source: "direct", source_id: readString(rawParams, "source_id"),
          module: "private"
        }),
        visibility: "private",
        owner_user_id: runContext.ownerUserId,
        chat_id: runContext.chatId ?? "",
        channel: runContext.channel ?? "",
        vector
      };
      await appendPrivateRecord(config, runContext.ownerUserId, record);
      return jsonResult({ stored: true, storage: "local_encrypted", visibility: "private", id: record.id });
    }
  };
}

function createPublicStoreTool(api, ctx) {
  return {
    name: "public_memory_store",
    label: "Public Memory Store",
    description: "Store a public company memory in cloud RDS (encrypted). Accessible to all OC instances.",
    parameters: PublicStoreSchema,
    execute: async (_id, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      const maxChars = config.limits?.maxStoreChars ?? 12000;
      const text = truncateText(readString(rawParams, "text", { required: true }), maxChars);
      const module = readString(rawParams, "module") ?? "general";
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text, module, category: readString(rawParams, "category"),
          importance: readNumber(rawParams, "importance"),
          source: readString(rawParams, "source") ?? "manual",
          source_id: readString(rawParams, "source_id")
        }),
        visibility: "public",
        owner_user_id: "",
        chat_id: runContext.chatId ?? "",
        channel: runContext.channel ?? "",
        vector
      };
      await addPublicRecord(config, record);
      return jsonResult({ stored: true, storage: "rds_encrypted", visibility: "public", module, id: record.id });
    }
  };
}

function createPublicBatchStoreTool(api, ctx) {
  return {
    name: "public_memory_store_batch",
    label: "Public Memory Store Batch",
    description: "Batch-store public memories into RDS (encrypted). Supports module tagging, insert_only / upsert mode.",
    parameters: PublicBatchStoreSchema,
    execute: async (_id, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);

      let fileParams = {};
      const itemsFile = readString(rawParams, "items_file");
      if (itemsFile) {
        const resolved = path.resolve(itemsFile);
        const stateRoot = path.resolve(process.env.HOME || process.cwd(), ".openclaw");
        if (!resolved.startsWith(stateRoot + path.sep)) throw new Error("items_file must be under ~/.openclaw");
        fileParams = JSON.parse(await fs.readFile(resolved, "utf8"));
      }

      const items = Array.isArray(fileParams.items) ? fileParams.items : readArray(rawParams, "items", { required: !itemsFile });
      const deleteSourceIds = Array.isArray(fileParams.delete_source_ids) ? fileParams.delete_source_ids : readArray(rawParams, "delete_source_ids");
      const mode = (fileParams.mode ?? rawParams?.mode) === "upsert" ? "upsert" : "insert_only";
      const dryRun = rawParams?.dryRun === true;
      const maxChars = config.limits?.maxStoreChars ?? 12000;
      const stored = [], deleted = [], skipped = [], errors = [];

      for (const [index, item] of deleteSourceIds.entries()) {
        try {
          const source = readString(item, "source", { required: true });
          const sourceId = readString(item, "source_id", { required: true });
          const module = readString(item, "module") ?? null;
          if (dryRun) { deleted.push({ index, dryRun: true, source, source_id: sourceId }); continue; }
          deleted.push({ index, ...(await deletePublicSourceRecord(config, source, sourceId, module)) });
        } catch (err) {
          errors.push({ index, phase: "delete", error: err instanceof Error ? err.message : String(err) });
        }
      }

      for (const [index, item] of items.entries()) {
        try {
          const text = truncateText(readString(item, "text", { required: true }), maxChars);
          const module = readString(item, "module") ?? "general";
          const source = readString(item, "source") ?? "manual";
          const sourceId = readString(item, "source_id");
          const chatId = readString(item, "chat_id") ?? runContext.chatId ?? "";

          if (sourceId && mode === "insert_only" && await sourceRecordExists(config, source, sourceId, module)) {
            skipped.push({ index, reason: "duplicate_source_id", source, source_id: sourceId, module }); continue;
          }
          if (sourceId && mode === "upsert" && !dryRun) {
            deleted.push({ index, phase: "upsert_replace", ...(await deletePublicSourceRecord(config, source, sourceId, module)) });
          }
          if (dryRun) { stored.push({ index, dryRun: true, module, source, source_id: sourceId ?? "" }); continue; }

          const vector = await embedText(config, ctx, text, signal);
          const record = {
            ...baseRecord(config, { text, module, category: readString(item, "category"), importance: readNumber(item, "importance"), source, source_id: sourceId }),
            visibility: "public", owner_user_id: "", chat_id: chatId, channel: runContext.channel ?? "", vector
          };
          await addPublicRecord(config, record);
          stored.push({ index, id: record.id, module, source, source_id: record.source_id });
        } catch (err) {
          errors.push({ index, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return jsonResult({
        stored_count: dryRun ? 0 : stored.filter(i => !i.dryRun).length,
        would_store_count: dryRun ? stored.length : undefined,
        skipped_count: skipped.length,
        error_count: errors.length,
        mode, dryRun, stored, deleted, skipped, errors
      });
    }
  };
}

// ── Context Engine ───────────────────────────────────────────

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((t, m) => t + JSON.stringify(m).length, 0) / 4);
}

function formatMemoryContext(results, scope, modules) {
  if (!results.length) return "";
  const moduleLabel = scope === "public+private" ? `public(${modules.join(",")}) + private` : `public(${modules.join(",")})`;
  const lines = [
    `Company memory retrieved [${moduleLabel}] for this turn.`,
    "Use these facts when relevant; do not reveal private memory in group chats.",
    ""
  ];
  for (const [i, row] of results.entries()) {
    const vis = row.visibility === "private" ? "🔒private" : `public/${row.module ?? "general"}`;
    const score = typeof row.score === "number" ? ` [${row.score.toFixed(3)}]` : "";
    lines.push(`${i + 1}. [${vis}${score}] ${row.text}`);
  }
  return lines.join("\n");
}

function createContextEngine(api, factoryCtx = {}) {
  const config = resolveConfig(api, { config: factoryCtx.config });
  return {
    info: {
      id: PLUGIN_ID,
      name: "Company Memory Context Engine",
      version: "0.3.0",
      hostRequirements: { "agent-run": { requiredCapabilities: ["assemble-before-prompt"] } }
    },
    async ingest() { return { ingested: false }; },
    async ingestBatch(params) { return { ingestedCount: params.messages?.length ?? 0 }; },
    async afterTurn() {},
    async maintain() { return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "company-memory delegates transcript retention to the host" }; },
    async assemble(params) {
      const messages = [...(params.messages ?? [])];
      const prompt = typeof params.prompt === "string" && params.prompt.trim()
        ? params.prompt.trim()
        : messages.toReversed().find(m => m?.role === "user")?.content;

      if (typeof prompt !== "string" || !prompt.trim()) {
        return { messages, estimatedTokens: estimateTokens(messages) };
      }

      try {
        const runContext = resolveRunContext({ sessionKey: params.sessionKey }, config);
        const embCtx = { config: factoryCtx.config, agentDir: factoryCtx.agentDir, workspaceDir: factoryCtx.workspaceDir };
        const vector = await embedText(config, embCtx, prompt);
        const limit = config.limits?.defaultSearchLimit ?? 8;
        const { modules, searchAll } = resolveSearchModules(config, null); // 用 defaultModules

        const filterParams = { tenantId: runContext.tenantId, modules, searchAll };
        const [publicResults, privateResults] = await Promise.all([
          searchPublicRecords(config, vector, filterParams, limit),
          runContext.chatType === "direct" && runContext.ownerUserId
            ? searchPrivateRecords(config, runContext.ownerUserId, vector, limit)
            : Promise.resolve([])
        ]);

        const combined = [...publicResults, ...privateResults]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, limit);

        if (!combined.length) return { messages, estimatedTokens: estimateTokens(messages) };

        const scope = privateResults.length > 0 ? "public+private" : "public";
        const memoryContext = formatMemoryContext(combined, scope, searchAll ? ["*"] : modules);
        const injected = [{ role: "system", content: memoryContext }, ...messages];

        return {
          messages: injected,
          estimatedTokens: estimateTokens(injected),
          systemPromptAddition: "Company memory has been retrieved and injected. Private memories are confidential to this direct-chat user."
        };
      } catch (error) {
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
          systemPromptAddition: `Company memory unavailable: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    },
    async compact() { return { ok: true, compacted: false, reason: "company-memory delegates transcript retention to the host" }; }
  };
}

// ── 插件入口 ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: "Company Memory",
  description: "Encrypted public/private pgvector memory. Private→local JSONL, Public→AWS RDS with module isolation.",
  register(api) {
    api.registerTool((ctx) => createSearchTool(api, ctx), { name: "company_context_search" });
    api.registerTool((ctx) => createPrivateStoreTool(api, ctx), { name: "private_memory_store" });
    api.registerTool((ctx) => createPublicStoreTool(api, ctx), { name: "public_memory_store" });
    api.registerTool((ctx) => createPublicBatchStoreTool(api, ctx), { name: "public_memory_store_batch" });
    api.registerContextEngine(PLUGIN_ID, (ctx) => createContextEngine(api, ctx));
  }
};
