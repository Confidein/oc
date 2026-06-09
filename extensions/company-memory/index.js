import pg from "pg";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveApiKeyForProvider } from "/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/provider-auth-runtime.js";

const { Pool } = pg;

const PLUGIN_ID = "company-memory";
const DEFAULT_CONFIG = {
  pgvector: {
    connectionString: "",
    ssl: true,
    poolMin: 1,
    poolMax: 5
  },
  tableName: "memories",
  tenantId: "default",
  vectorDimensions: 1536,
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

// ── Tool 参数 Schema（与原版保持一致）─────────────────────

const SearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Question or search text." },
    limit: { type: "number", description: "Maximum memories to return." },
    includePrivate: {
      type: "boolean",
      description: "Direct chats include private memory by default. Set false for public-only search."
    }
  },
  required: ["query"],
  additionalProperties: false
};

const PrivateStoreSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "Private memory text to store for the current direct-chat user." },
    category: { type: "string", description: "Optional memory category, e.g. preference, project, decision, todo." },
    importance: { type: "number", description: "Optional importance score 0–1." },
    source_id: { type: "string", description: "Optional source message, document, or event id." }
  },
  required: ["text"],
  additionalProperties: false
};

const PublicStoreSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "Public company memory text to store." },
    category: { type: "string", description: "Optional memory category, e.g. handbook, policy, project, decision." },
    importance: { type: "number", description: "Optional importance score 0–1." },
    source: { type: "string", description: "Optional public source, e.g. lark_group, lark_wiki, manual." },
    source_id: { type: "string", description: "Optional source message, document, or event id." }
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
      description: "insert_only skips duplicate source_id values. upsert replaces existing rows."
    },
    delete_source_ids: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_id: { type: "string" }
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
    items_file: {
      type: "string",
      description: "Optional local JSON file path containing { items, delete_source_ids, mode }."
    },
    dryRun: { type: "boolean", description: "Validate without writing." }
  },
  required: [],
  additionalProperties: false
};

// ── 配置合并 ────────────────────────────────────────────────

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

// ── 连接池管理 ───────────────────────────────────────────────

let _pool = null;
let _poolKey = null;

function getPoolKey(config) {
  const pv = config.pgvector ?? {};
  return JSON.stringify({
    cs: pv.connectionString,
    host: pv.host, port: pv.port, db: pv.database, user: pv.user
  });
}

function getPool(config) {
  const key = getPoolKey(config);
  if (_pool && key === _poolKey) return _pool;

  if (_pool) _pool.end().catch(() => {});

  const pv = config.pgvector ?? {};
  const ssl = pv.ssl !== false ? { rejectUnauthorized: false } : false;

  // 去掉 connectionString 里的 sslmode 参数，改由 ssl 对象统一控制
  // （pg v8 新版把 sslmode=require 升级为 verify-full，会导致 AWS RDS 自签名证书报错）
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

  // 连接错误不崩进程
  _pool.on("error", (err) => {
    console.error("[company-memory] pg pool error:", err.message);
  });

  _poolKey = key;
  return _pool;
}

// ── Schema 初始化（只跑一次）────────────────────────────────

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
        created_at    TEXT         NOT NULL,
        updated_at    TEXT         NOT NULL,
        visibility    TEXT         NOT NULL,
        owner_user_id TEXT         NOT NULL DEFAULT '',
        chat_id       TEXT         NOT NULL DEFAULT '',
        channel       TEXT         NOT NULL DEFAULT '',
        vector        vector(${dims}) NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_vector_hnsw_idx
        ON ${table} USING hnsw (vector vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_filter_idx
        ON ${table} (tenant_id, visibility)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_source_idx
        ON ${table} (tenant_id, visibility, source, source_id)
        WHERE source_id <> ''
    `);
    _schemaEnsured = true;
  } finally {
    client.release();
  }
}

// ── DB 操作层 ────────────────────────────────────────────────

async function addRecord(config, record) {
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";
  const vectorStr = `[${record.vector.join(",")}]`;

  await pool.query(
    `INSERT INTO ${table}
       (id, tenant_id, text, category, importance, source, source_id,
        created_at, updated_at, visibility, owner_user_id, chat_id, channel, vector)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector)`,
    [
      record.id, record.tenant_id, record.text, record.category, record.importance,
      record.source, record.source_id, record.created_at, record.updated_at,
      record.visibility, record.owner_user_id, record.chat_id, record.channel,
      vectorStr
    ]
  );
}

async function deletePublicSourceRecord(config, source, sourceId) {
  if (!source || !sourceId) return { deleted: false, reason: "missing_source_or_source_id" };
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";

  const result = await pool.query(
    `DELETE FROM ${table}
     WHERE tenant_id = $1 AND visibility = 'public' AND source = $2 AND source_id = $3`,
    [config.tenantId, source, sourceId]
  );
  return { deleted: true, source, source_id: sourceId, deleted_count: result.rowCount };
}

async function searchRecords(config, vector, filterParams, limit) {
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";
  const vectorStr = `[${vector.join(",")}]`;

  let queryText, params;
  const cols = "id, tenant_id, text, category, importance, source, source_id, created_at, updated_at, visibility, owner_user_id, chat_id, channel";

  if (filterParams.ownerUserId) {
    queryText = `
      SELECT ${cols}, 1 - (vector <=> $1::vector) AS score
      FROM ${table}
      WHERE tenant_id = $2
        AND (visibility = 'public' OR (visibility = 'private' AND owner_user_id = $3))
      ORDER BY vector <=> $1::vector
      LIMIT $4`;
    params = [vectorStr, filterParams.tenantId, filterParams.ownerUserId, limit];
  } else {
    queryText = `
      SELECT ${cols}, 1 - (vector <=> $1::vector) AS score
      FROM ${table}
      WHERE tenant_id = $2 AND visibility = 'public'
      ORDER BY vector <=> $1::vector
      LIMIT $3`;
    params = [vectorStr, filterParams.tenantId, limit];
  }

  const result = await pool.query(queryText, params);
  return result.rows;
}

async function sourceRecordExists(config, source, sourceId) {
  if (!source || !sourceId) return false;
  await ensureSchema(config);
  const pool = getPool(config);
  const table = config.tableName ?? "memories";

  const result = await pool.query(
    `SELECT 1 FROM ${table}
     WHERE tenant_id = $1 AND visibility = 'public' AND source = $2 AND source_id = $3
     LIMIT 1`,
    [config.tenantId, source, sourceId]
  );
  return result.rowCount > 0;
}

// ── 工具函数 ─────────────────────────────────────────────────

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload
  };
}

function readString(params, name, options = {}) {
  const value = params?.[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (options.required) throw new Error(`${name} is required.`);
  return undefined;
}

function readNumber(params, name) {
  const value = params?.[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function readArray(params, name, options = {}) {
  const value = params?.[name];
  if (Array.isArray(value)) return value;
  if (options.required) throw new Error(`${name} is required.`);
  return [];
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateText(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function normalizeImportance(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
  const channel = ctx?.messageChannel ?? delivery.channel ?? parsed.channel;
  const ownerUserId = ctx?.requesterSenderId ?? (parsed.chatType === "direct" ? parsed.peerId : undefined);
  return {
    tenantId: config.tenantId,
    chatType: parsed.chatType,
    channel,
    chatId: delivery.to ?? parsed.peerId,
    ownerUserId
  };
}

function buildSearchFilter(runContext, includePrivate) {
  if (runContext.chatType === "direct" && includePrivate && runContext.ownerUserId) {
    return { tenantId: runContext.tenantId, ownerUserId: runContext.ownerUserId };
  }
  return { tenantId: runContext.tenantId, ownerUserId: null };
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
    created_at: now,
    updated_at: now
  };
}

async function resolveEmbeddingApiKey(config, ctx) {
  const configured = config.embedding?.apiKey;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const provider = config.embedding?.provider ?? "openai";
  const fromRuntime = await ctx?.resolveApiKeyForProvider?.(provider);
  if (fromRuntime) return fromRuntime;
  const auth = await resolveApiKeyForProvider({
    provider,
    cfg: ctx?.config ?? ctx?.runtimeConfig,
    agentDir: ctx?.agentDir,
    workspaceDir: ctx?.workspaceDir
  }).catch(() => null);
  if (auth?.apiKey) return auth.apiKey;
  throw new Error(`Missing embedding API key for provider ${provider}.`);
}

async function embedText(config, ctx, text, signal) {
  const apiKey = await resolveEmbeddingApiKey(config, ctx);
  const baseUrl = String(config.embedding?.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
  const model = config.embedding?.model ?? "text-embedding-3-small";

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: text })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }

  const data = await response.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("Embedding response missing vector.");
  return vector;
}

// ── Tools ────────────────────────────────────────────────────

function createSearchTool(api, ctx) {
  return {
    name: "company_context_search",
    label: "Company Context Search",
    description: "Search company memory with hard visibility filtering. Direct chats return public + sender's private memories. Group chats return public only.",
    parameters: SearchSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      const query = readString(rawParams, "query", { required: true });
      const defaultLimit = config.limits?.defaultSearchLimit ?? 8;
      const maxLimit = config.limits?.maxSearchLimit ?? 20;
      const limit = clampInt(readNumber(rawParams, "limit"), 1, maxLimit, defaultLimit);
      const includePrivate = rawParams?.includePrivate !== false;

      const vector = await embedText(config, ctx, query, signal);
      const filterParams = buildSearchFilter(runContext, includePrivate);
      const results = await searchRecords(config, vector, filterParams, limit);

      return jsonResult({
        query,
        scope: filterParams.ownerUserId ? "public+private" : "public",
        tenant_id: runContext.tenantId,
        result_count: results.length,
        results
      });
    }
  };
}

function createPrivateStoreTool(api, ctx) {
  return {
    name: "private_memory_store",
    label: "Private Memory Store",
    description: "Store a private memory for the current direct-chat sender.",
    parameters: PrivateStoreSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      if (runContext.chatType !== "direct" || !runContext.ownerUserId) {
        throw new Error("private_memory_store is only available in direct chats with a trusted sender id.");
      }
      const maxChars = config.limits?.maxStoreChars ?? 12000;
      const text = truncateText(readString(rawParams, "text", { required: true }), maxChars);
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text,
          category: readString(rawParams, "category"),
          importance: readNumber(rawParams, "importance"),
          source: "direct",
          source_id: readString(rawParams, "source_id")
        }),
        visibility: "private",
        owner_user_id: runContext.ownerUserId,
        chat_id: runContext.chatId ?? "",
        channel: runContext.channel ?? "",
        vector
      };
      await addRecord(config, record);
      return jsonResult({ stored: true, visibility: "private", id: record.id, category: record.category });
    }
  };
}

function createPublicStoreTool(api, ctx) {
  return {
    name: "public_memory_store",
    label: "Public Memory Store",
    description: "Store a public company memory available to all users and group chats.",
    parameters: PublicStoreSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      const maxChars = config.limits?.maxStoreChars ?? 12000;
      const text = truncateText(readString(rawParams, "text", { required: true }), maxChars);
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text,
          category: readString(rawParams, "category"),
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
      await addRecord(config, record);
      return jsonResult({ stored: true, visibility: "public", id: record.id, category: record.category });
    }
  };
}

function createPublicBatchStoreTool(api, ctx) {
  return {
    name: "public_memory_store_batch",
    label: "Public Memory Store Batch",
    description: "Batch-store public company memories. insert_only skips duplicate source_ids; upsert replaces existing.",
    parameters: PublicBatchStoreSchema,
    execute: async (_toolCallId, rawParams, signal) => {
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
          if (!item || typeof item !== "object") throw new Error("item must be an object");
          const source = readString(item, "source", { required: true });
          const sourceId = readString(item, "source_id", { required: true });
          if (dryRun) {
            deleted.push({ index, dryRun: true, source, source_id: sourceId });
          } else {
            deleted.push({ index, ...(await deletePublicSourceRecord(config, source, sourceId)) });
          }
        } catch (error) {
          errors.push({ index, phase: "delete", error: error instanceof Error ? error.message : String(error) });
        }
      }

      for (const [index, item] of items.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("item must be an object");
          const text = truncateText(readString(item, "text", { required: true }), maxChars);
          const source = readString(item, "source") ?? "manual";
          const sourceId = readString(item, "source_id");
          const chatId = readString(item, "chat_id") ?? runContext.chatId ?? "";

          if (sourceId && mode === "insert_only" && await sourceRecordExists(config, source, sourceId)) {
            skipped.push({ index, reason: "duplicate_source_id", source, source_id: sourceId });
            continue;
          }
          if (sourceId && mode === "upsert" && !dryRun) {
            deleted.push({ index, phase: "upsert_replace", ...(await deletePublicSourceRecord(config, source, sourceId)) });
          }
          if (dryRun) {
            stored.push({ index, dryRun: true, source, source_id: sourceId ?? "", chars: text.length });
            continue;
          }

          const vector = await embedText(config, ctx, text, signal);
          const record = {
            ...baseRecord(config, {
              text,
              category: readString(item, "category"),
              importance: readNumber(item, "importance"),
              source,
              source_id: sourceId
            }),
            visibility: "public",
            owner_user_id: "",
            chat_id: chatId,
            channel: runContext.channel ?? "",
            vector
          };
          await addRecord(config, record);
          stored.push({ index, id: record.id, source, source_id: record.source_id, category: record.category });
        } catch (error) {
          errors.push({ index, error: error instanceof Error ? error.message : String(error) });
        }
      }

      return jsonResult({
        stored_count: dryRun ? 0 : stored.filter(i => !i.dryRun).length,
        would_store_count: dryRun ? stored.length : undefined,
        deleted_count: dryRun ? 0 : deleted.filter(i => i.deleted).length,
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

function formatMemoryContext(results, scope) {
  if (!results.length) return "";
  const lines = [
    "Company memory retrieved from PostgreSQL pgvector for this turn.",
    `Scope: ${scope}. Use these facts when relevant; do not reveal private memory in group chats.`,
    ""
  ];
  for (const [i, row] of results.entries()) {
    const label = row.visibility === "private" ? "private" : "public";
    const cat = row.category ? `, category=${row.category}` : "";
    const score = typeof row.score === "number" ? ` [score=${row.score.toFixed(3)}]` : "";
    lines.push(`${i + 1}. [${label}${cat}${score}] ${row.text}`);
  }
  return lines.join("\n");
}

function createContextEngine(api, factoryCtx = {}) {
  const config = resolveConfig(api, { config: factoryCtx.config });
  return {
    info: {
      id: PLUGIN_ID,
      name: "Company Memory Context Engine",
      version: "0.2.0",
      hostRequirements: { "agent-run": { requiredCapabilities: ["assemble-before-prompt"] } }
    },
    async ingest() { return { ingested: false }; },
    async ingestBatch(params) { return { ingestedCount: params.messages?.length ?? 0 }; },
    async afterTurn() {},
    async maintain() {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "company-memory delegates transcript retention to the host" };
    },
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
        const vector = await embedText(config, {
          config: factoryCtx.config,
          agentDir: factoryCtx.agentDir,
          workspaceDir: factoryCtx.workspaceDir
        }, prompt);
        const filterParams = buildSearchFilter(runContext, true);
        const limit = config.limits?.defaultSearchLimit ?? 8;
        const results = await searchRecords(config, vector, filterParams, limit);
        const scope = filterParams.ownerUserId ? "public+private" : "public";
        const memoryContext = formatMemoryContext(results, scope);

        if (!memoryContext) return { messages, estimatedTokens: estimateTokens(messages) };

        const injected = [{ role: "system", content: memoryContext }, ...messages];
        return {
          messages: injected,
          estimatedTokens: estimateTokens(injected),
          systemPromptAddition: "Company memory has been automatically retrieved for this turn. Treat private memory as confidential to the current direct-chat user."
        };
      } catch (error) {
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
          systemPromptAddition: `Company memory auto-recall was unavailable: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    },
    async compact() {
      return { ok: true, compacted: false, reason: "company-memory delegates transcript retention to the host" };
    }
  };
}

// ── 插件入口 ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: "Company Memory",
  description: "Scoped public/private pgvector memory tools for company OpenClaw agents.",
  register(api) {
    api.registerTool((ctx) => createSearchTool(api, ctx), { name: "company_context_search" });
    api.registerTool((ctx) => createPrivateStoreTool(api, ctx), { name: "private_memory_store" });
    api.registerTool((ctx) => createPublicStoreTool(api, ctx), { name: "public_memory_store" });
    api.registerTool((ctx) => createPublicBatchStoreTool(api, ctx), { name: "public_memory_store_batch" });
    api.registerContextEngine(PLUGIN_ID, (ctx) => createContextEngine(api, ctx));
  }
};
