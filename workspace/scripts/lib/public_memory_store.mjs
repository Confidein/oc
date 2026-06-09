import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lancedb from "../../../extensions/company-memory/node_modules/@lancedb/lancedb/dist/index.js";

const OPENCLAW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CONFIG = {
  dbPath: "~/.openclaw/company-memory/lancedb",
  tableName: "memories",
  tenantId: "default",
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com/v1",
  },
  limits: {
    maxStoreChars: 12000,
  },
};

function expandHome(filePath) {
  if (!filePath || filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadCompanyMemoryConfig() {
  const configPath = process.env.OPENCLAW_CONFIG || path.join(OPENCLAW_ROOT, "openclaw.json");
  const config = await readJson(configPath, {});
  const pluginConfig = config?.plugins?.entries?.["company-memory"]?.config ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...pluginConfig,
    embedding: { ...DEFAULT_CONFIG.embedding, ...(pluginConfig.embedding ?? {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(pluginConfig.limits ?? {}) },
  };
}

async function resolveEmbeddingApiKey(config) {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const configured = config.embedding?.apiKey;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const authPath = path.join(OPENCLAW_ROOT, "agents/main/agent/auth-profiles.json");
  const auth = await readJson(authPath, {});
  const provider = config.embedding?.provider ?? "openai";
  const profile = auth?.profiles?.[`${provider}:default`];
  if (profile?.key?.trim()) return profile.key.trim();
  throw new Error(`Missing embedding API key for provider ${provider}`);
}

async function embedText(config, text) {
  const apiKey = await resolveEmbeddingApiKey(config);
  const baseUrl = String(config.embedding?.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
  const model = config.embedding?.model ?? "text-embedding-3-small";
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  const data = await response.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("Embedding response did not include a vector");
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

async function sourceRecordExists(config, source, sourceId) {
  if (!source || !sourceId) return false;
  const table = await openTableOrNull(config);
  if (!table) return false;
  const filter = [
    `tenant_id = ${sqlString(config.tenantId)}`,
    "visibility = 'public'",
    `source = ${sqlString(source)}`,
    `source_id = ${sqlString(sourceId)}`,
  ].join(" AND ");
  const rows = await table.query().where(filter).limit(1).toArray();
  return rows.length > 0;
}

function baseRecord(config, params) {
  const now = new Date().toISOString();
  const importance = typeof params.importance === "number" && Number.isFinite(params.importance)
    ? Math.max(0, Math.min(1, params.importance))
    : 0;
  return {
    id: crypto.randomUUID(),
    tenant_id: config.tenantId,
    text: params.text,
    category: params.category ?? "",
    importance,
    source: params.source ?? "",
    source_id: params.source_id ?? "",
    created_at: now,
    updated_at: now,
  };
}

/**
 * Store one public memory item (insert_only by source/source_id).
 * Returns { stored, skipped, id? }.
 */
export async function storePublicMemoryItem(item, { dryRun = false } = {}) {
  const config = await loadCompanyMemoryConfig();
  const maxStoreChars = config.limits?.maxStoreChars ?? DEFAULT_CONFIG.limits.maxStoreChars;
  const text = truncateText(String(item.text ?? "").trim(), maxStoreChars);
  if (!text) throw new Error("public memory text is empty");
  const source = item.source ?? "manual";
  const sourceId = item.source_id ?? "";
  const category = item.category ?? "";

  if (sourceId && await sourceRecordExists(config, source, sourceId)) {
    return { stored: false, skipped: true, reason: "duplicate_source_id", source, source_id: sourceId };
  }
  if (dryRun) {
    return { stored: false, skipped: false, dryRun: true, source, source_id: sourceId, chars: text.length };
  }

  const vector = await embedText(config, text);
  const record = {
    ...baseRecord(config, {
      text,
      category,
      importance: item.importance,
      source,
      source_id: sourceId,
    }),
    visibility: "public",
    owner_user_id: "",
    chat_id: item.chat_id ?? "",
    channel: "",
    vector,
  };
  await addRecord(config, record);
  return { stored: true, skipped: false, id: record.id, source, source_id: sourceId };
}
