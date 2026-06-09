import * as lancedb from "@lancedb/lancedb";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveApiKeyForProvider } from "/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/provider-auth-runtime.js";

const PLUGIN_ID = "company-memory";
const DEFAULT_CONFIG = {
  dbPath: "~/.openclaw/company-memory/lancedb",
  tableName: "memories",
  tenantId: "default",
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

const SearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Question or search text."
    },
    limit: {
      type: "number",
      description: "Maximum memories to return."
    },
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
    text: {
      type: "string",
      description: "Private memory text to store for the current direct-chat user."
    },
    category: {
      type: "string",
      description: "Optional memory category, for example preference, project, decision, todo."
    },
    importance: {
      type: "number",
      description: "Optional importance score from 0 to 1."
    },
    source_id: {
      type: "string",
      description: "Optional source message, document, or event id."
    }
  },
  required: ["text"],
  additionalProperties: false
};

const PublicStoreSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "Public company memory text to store."
    },
    category: {
      type: "string",
      description: "Optional memory category, for example handbook, policy, project, decision."
    },
    importance: {
      type: "number",
      description: "Optional importance score from 0 to 1."
    },
    source: {
      type: "string",
      description: "Optional public source, for example lark_group, lark_wiki, manual."
    },
    source_id: {
      type: "string",
      description: "Optional source message, document, or event id."
    }
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
      description: "insert_only skips duplicate source_id values. upsert replaces existing rows with the same public source/source_id before storing."
    },
    delete_source_ids: {
      type: "array",
      description: "Optional stable public source/source_id pairs to delete before storing, used when a synced document now has fewer chunks.",
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Public source, for example lark_wiki."
          },
          source_id: {
            type: "string",
            description: "Stable source id to delete."
          }
        },
        required: ["source", "source_id"],
        additionalProperties: false
      }
    },
    items: {
      type: "array",
      description: "Public memory items to store. Use source_id for message/document ids so repeated syncs can skip duplicates.",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Public company memory text to store."
          },
          category: {
            type: "string",
            description: "Optional memory category, for example lark_group, lark_wiki, policy, decision."
          },
          importance: {
            type: "number",
            description: "Optional importance score from 0 to 1."
          },
          source: {
            type: "string",
            description: "Public source, for example lark_group, lark_wiki, manual."
          },
          source_id: {
            type: "string",
            description: "Stable source id, for example a Feishu message_id or wiki/doc token. Used for deduplication."
          },
          chat_id: {
            type: "string",
            description: "Optional Feishu group chat id for lark_group items."
          }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    items_file: {
      type: "string",
      description: "Optional local JSON file containing { items, delete_source_ids, mode }. Used by sync jobs to avoid returning large document payloads through the model context."
    },
    dryRun: {
      type: "boolean",
      description: "Validate and report what would be stored without writing LanceDB."
    }
  },
  required: [],
  additionalProperties: false
};

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    embedding: {
      ...base.embedding,
      ...(override?.embedding ?? {})
    },
    limits: {
      ...base.limits,
      ...(override?.limits ?? {})
    }
  };
}

function resolveConfig(api, ctx) {
  const runtimeConfig = ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api?.config ?? {};
  const pluginConfig = runtimeConfig?.plugins?.entries?.[PLUGIN_ID]?.config ?? api?.pluginConfig ?? {};
  return mergeConfig(DEFAULT_CONFIG, pluginConfig);
}

function expandHome(filePath) {
  if (!filePath || filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function jsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
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
  const int = Math.floor(value);
  return Math.max(min, Math.min(max, int));
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseSessionKey(sessionKey) {
  const parts = String(sessionKey ?? "").split(":").filter(Boolean);
  for (const kind of ["direct", "group", "channel"]) {
    const idx = parts.indexOf(kind);
    if (idx >= 0) {
      return {
        chatType: kind,
        peerId: parts[idx + 1],
        channel: parts[2]
      };
    }
  }
  return {
    chatType: "unknown",
    peerId: undefined,
    channel: parts[2]
  };
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
  throw new Error(`Missing embedding API key for provider ${provider}. Configure company-memory.embedding.apiKey or an auth profile.`);
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
    body: JSON.stringify({
      model,
      input: text
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  const data = await response.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("Embedding response did not include a vector.");
  return vector;
}

async function openDb(config) {
  const dbPath = expandHome(config.dbPath);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return lancedb.connect(dbPath);
}

async function tableExists(db, tableName) {
  const names = await db.tableNames();
  return names.includes(tableName);
}

async function openTableOrNull(config) {
  const db = await openDb(config);
  if (!(await tableExists(db, config.tableName))) return null;
  return db.openTable(config.tableName);
}

async function addRecord(config, record) {
  const db = await openDb(config);
  if (await tableExists(db, config.tableName)) {
    const table = await db.openTable(config.tableName);
    await table.add([record]);
    return;
  }
  await db.createTable(config.tableName, [record]);
}

async function deletePublicSourceRecord(config, source, sourceId) {
  if (!source || !sourceId) return { deleted: false, reason: "missing_source_or_source_id" };
  const table = await openTableOrNull(config);
  if (!table) return { deleted: false, reason: "table_missing" };
  const filter = [
    `tenant_id = ${sqlString(config.tenantId)}`,
    "visibility = 'public'",
    `source = ${sqlString(source)}`,
    `source_id = ${sqlString(sourceId)}`
  ].join(" AND ");
  const result = await table.delete(filter);
  return {
    deleted: true,
    source,
    source_id: sourceId,
    deleted_count: result?.numDeletedRows ?? result?.num_deleted_rows ?? undefined
  };
}

function sanitizeRow(row) {
  const {
    vector,
    _distance,
    ...rest
  } = row;
  return {
    ...rest,
    score: typeof _distance === "number" ? 1 / (1 + _distance) : undefined
  };
}

async function searchRecords(config, vector, filter, limit) {
  const table = await openTableOrNull(config);
  if (!table) return [];
  let query = table.search(vector).limit(limit);
  if (filter) query = query.where(filter);
  const rows = await query.toArray();
  return rows.map(sanitizeRow);
}

async function sourceRecordExists(config, source, sourceId) {
  if (!source || !sourceId) return false;
  const table = await openTableOrNull(config);
  if (!table) return false;
  const filter = [
    `tenant_id = ${sqlString(config.tenantId)}`,
    "visibility = 'public'",
    `source = ${sqlString(source)}`,
    `source_id = ${sqlString(sourceId)}`
  ].join(" AND ");
  const rows = await table.query().where(filter).limit(1).toArray();
  return rows.length > 0;
}

function buildSearchFilter(runContext, includePrivate) {
  const tenant = `tenant_id = ${sqlString(runContext.tenantId)}`;
  if (runContext.chatType === "direct" && includePrivate && runContext.ownerUserId) {
    return `${tenant} AND (visibility = 'public' OR (visibility = 'private' AND owner_user_id = ${sqlString(runContext.ownerUserId)}))`;
  }
  return `${tenant} AND visibility = 'public'`;
}

function normalizeImportance(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function baseRecord(config, params) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenant_id: config.tenantId,
    text: params.text,
    category: params.category ?? "",
    importance: normalizeImportance(params.importance) ?? 0,
    source: params.source ?? "",
    source_id: params.source_id ?? "",
    created_at: now,
    updated_at: now
  };
}

function createSearchTool(api, ctx) {
  return {
    name: "company_context_search",
    label: "Company Context Search",
    description: "Search company memory with hard visibility filtering. Direct chats return public memories plus the current sender's private memories. Group chats return public memories only.",
    parameters: SearchSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      const query = readString(rawParams, "query", { required: true });
      const defaultLimit = config.limits?.defaultSearchLimit ?? DEFAULT_CONFIG.limits.defaultSearchLimit;
      const maxLimit = config.limits?.maxSearchLimit ?? DEFAULT_CONFIG.limits.maxSearchLimit;
      const limit = clampInt(readNumber(rawParams, "limit"), 1, maxLimit, defaultLimit);
      const includePrivate = rawParams?.includePrivate !== false;
      const vector = await embedText(config, ctx, query, signal);
      const filter = buildSearchFilter(runContext, includePrivate);
      const results = await searchRecords(config, vector, filter, limit);
      return jsonResult({
        query,
        scope: runContext.chatType === "direct" && includePrivate && runContext.ownerUserId ? "public+private" : "public",
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
    description: "Store a private memory for the current direct-chat sender. The owner_user_id is taken from OpenClaw runtime context, never from tool parameters.",
    parameters: PrivateStoreSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      if (runContext.chatType !== "direct" || !runContext.ownerUserId) {
        throw new Error("private_memory_store is only available in direct chats with a trusted sender id.");
      }
      const text = truncateText(readString(rawParams, "text", { required: true }), config.limits?.maxStoreChars ?? DEFAULT_CONFIG.limits.maxStoreChars);
      const category = readString(rawParams, "category");
      const sourceId = readString(rawParams, "source_id");
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text,
          category,
          importance: readNumber(rawParams, "importance"),
          source: "direct",
          source_id: sourceId
        }),
        visibility: "private",
        owner_user_id: runContext.ownerUserId,
        chat_id: runContext.chatId ?? "",
        channel: runContext.channel ?? "",
        vector
      };
      await addRecord(config, record);
      return jsonResult({
        stored: true,
        visibility: "private",
        id: record.id,
        tenant_id: record.tenant_id,
        category: record.category
      });
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
      const text = truncateText(readString(rawParams, "text", { required: true }), config.limits?.maxStoreChars ?? DEFAULT_CONFIG.limits.maxStoreChars);
      const category = readString(rawParams, "category");
      const source = readString(rawParams, "source") ?? "manual";
      const sourceId = readString(rawParams, "source_id");
      const vector = await embedText(config, ctx, text, signal);
      const record = {
        ...baseRecord(config, {
          text,
          category,
          importance: readNumber(rawParams, "importance"),
          source,
          source_id: sourceId
        }),
        visibility: "public",
        owner_user_id: "",
        chat_id: runContext.chatId ?? "",
        channel: runContext.channel ?? "",
        vector
      };
      await addRecord(config, record);
      return jsonResult({
        stored: true,
        visibility: "public",
        id: record.id,
        tenant_id: record.tenant_id,
        category: record.category
      });
    }
  };
}

function createPublicBatchStoreTool(api, ctx) {
  return {
    name: "public_memory_store_batch",
    label: "Public Memory Store Batch",
    description: "Batch-store public company memories for sync jobs. insert_only skips duplicate source_id values; upsert replaces existing rows with the same public source/source_id and can delete stale chunk source_ids.",
    parameters: PublicBatchStoreSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const config = resolveConfig(api, ctx);
      const runContext = resolveRunContext(ctx, config);
      let fileParams = {};
      const itemsFile = readString(rawParams, "items_file");
      if (itemsFile) {
        const resolved = path.resolve(itemsFile);
        const stateRoot = path.resolve(process.env.HOME || process.cwd(), ".openclaw");
        if (!resolved.startsWith(stateRoot + path.sep)) {
          throw new Error("items_file must be under ~/.openclaw");
        }
        fileParams = JSON.parse(await fs.readFile(resolved, "utf8"));
      }
      const items = Array.isArray(fileParams.items) ? fileParams.items : readArray(rawParams, "items", { required: !itemsFile });
      const deleteSourceIds = Array.isArray(fileParams.delete_source_ids) ? fileParams.delete_source_ids : readArray(rawParams, "delete_source_ids");
      const mode = (fileParams.mode ?? rawParams?.mode) === "upsert" ? "upsert" : "insert_only";
      const dryRun = rawParams?.dryRun === true;
      const maxStoreChars = config.limits?.maxStoreChars ?? DEFAULT_CONFIG.limits.maxStoreChars;
      const stored = [];
      const deleted = [];
      const skipped = [];
      const errors = [];

      for (const [index, item] of deleteSourceIds.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("delete_source_ids item must be an object");
          const source = readString(item, "source", { required: true });
          const sourceId = readString(item, "source_id", { required: true });
          if (dryRun) {
            deleted.push({ index, dryRun: true, source, source_id: sourceId });
          } else {
            deleted.push({ index, ...(await deletePublicSourceRecord(config, source, sourceId)) });
          }
        } catch (error) {
          errors.push({
            index,
            phase: "delete",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      for (const [index, item] of items.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("item must be an object");
          const text = truncateText(readString(item, "text", { required: true }), maxStoreChars);
          const category = readString(item, "category");
          const source = readString(item, "source") ?? "manual";
          const sourceId = readString(item, "source_id");
          const chatId = readString(item, "chat_id") ?? runContext.chatId ?? "";

          if (sourceId && mode === "insert_only" && await sourceRecordExists(config, source, sourceId)) {
            skipped.push({
              index,
              reason: "duplicate_source_id",
              source,
              source_id: sourceId
            });
            continue;
          }

          if (sourceId && mode === "upsert" && !dryRun) {
            deleted.push({ index, phase: "upsert_replace", ...(await deletePublicSourceRecord(config, source, sourceId)) });
          }

          if (dryRun) {
            stored.push({
              index,
              dryRun: true,
              source,
              source_id: sourceId ?? "",
              chars: text.length
            });
            continue;
          }

          const vector = await embedText(config, ctx, text, signal);
          const record = {
            ...baseRecord(config, {
              text,
              category,
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
          stored.push({
            index,
            id: record.id,
            source,
            source_id: record.source_id,
            category: record.category
          });
        } catch (error) {
          errors.push({
            index,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return jsonResult({
        stored_count: dryRun ? 0 : stored.filter((item) => !item.dryRun).length,
        would_store_count: dryRun ? stored.length : undefined,
        deleted_count: dryRun ? 0 : deleted.filter((item) => item.deleted).length,
        would_delete_count: dryRun ? deleted.length : undefined,
        skipped_count: skipped.length,
        error_count: errors.length,
        mode,
        dryRun,
        stored,
        deleted,
        skipped,
        errors
      });
    }
  };
}

function estimateTokens(messages) {
  const chars = messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
  return Math.ceil(chars / 4);
}

function formatMemoryContext(results, scope) {
  if (!results.length) return "";
  const lines = [
    "Company memory retrieved from LanceDB for this turn.",
    `Scope: ${scope}. Use these facts when relevant; do not reveal private memory in group chats.`,
    ""
  ];
  for (const [index, row] of results.entries()) {
    const label = row.visibility === "private" ? "private" : "public";
    const category = row.category ? `, category=${row.category}` : "";
    lines.push(`${index + 1}. [${label}${category}] ${row.text}`);
  }
  return lines.join("\n");
}

function createContextEngine(api, factoryCtx = {}) {
  const config = resolveConfig(api, { config: factoryCtx.config });
  return {
    info: {
      id: PLUGIN_ID,
      name: "Company Memory Context Engine",
      version: "0.1.0",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt"]
        }
      }
    },
    async ingest() {
      return { ingested: false };
    },
    async ingestBatch(params) {
      return { ingestedCount: params.messages?.length ?? 0 };
    },
    async afterTurn() {},
    async maintain() {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "company-memory does not rewrite transcripts"
      };
    },
    async assemble(params) {
      const messages = [...(params.messages ?? [])];
      const prompt = typeof params.prompt === "string" && params.prompt.trim()
        ? params.prompt.trim()
        : messages.toReversed().find((message) => message?.role === "user")?.content;
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
        const filter = buildSearchFilter(runContext, true);
        const limit = config.limits?.defaultSearchLimit ?? DEFAULT_CONFIG.limits.defaultSearchLimit;
        const results = await searchRecords(config, vector, filter, limit);
        const scope = runContext.chatType === "direct" && runContext.ownerUserId ? "public+private" : "public";
        const memoryContext = formatMemoryContext(results, scope);
        if (!memoryContext) return { messages, estimatedTokens: estimateTokens(messages) };
        const injected = [
          {
            role: "system",
            content: memoryContext
          },
          ...messages
        ];
        return {
          messages: injected,
          estimatedTokens: estimateTokens(injected),
          systemPromptAddition: "Company memory has been automatically retrieved for this turn when relevant. Treat private memory as confidential to the current direct-chat user."
        };
      } catch (error) {
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
          systemPromptAddition: `Company memory auto-recall was unavailable this turn: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    },
    async compact() {
      return {
        ok: true,
        compacted: false,
        reason: "company-memory delegates transcript retention to the host"
      };
    }
  };
}

export default {
  id: PLUGIN_ID,
  name: "Company Memory",
  description: "Scoped public/private LanceDB memory tools for company OpenClaw agents.",
  register(api) {
    api.registerTool((ctx) => createSearchTool(api, ctx), { name: "company_context_search" });
    api.registerTool((ctx) => createPrivateStoreTool(api, ctx), { name: "private_memory_store" });
    api.registerTool((ctx) => createPublicStoreTool(api, ctx), { name: "public_memory_store" });
    api.registerTool((ctx) => createPublicBatchStoreTool(api, ctx), { name: "public_memory_store_batch" });
    api.registerContextEngine(PLUGIN_ID, (ctx) => createContextEngine(api, ctx));
  }
};
