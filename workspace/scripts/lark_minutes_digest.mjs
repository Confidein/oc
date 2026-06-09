#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { storePublicMemoryItem } from "./lib/public_memory_store.mjs";

const WORKSPACE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_STATE_PATH = path.join(WORKSPACE, "state", "lark_minutes_digest_state.json");
const DEFAULT_UAT_DIR = path.join(os.homedir(), ".local", "share", "openclaw-feishu-uat");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    statePath: process.env.MINUTES_DIGEST_STATE || DEFAULT_STATE_PATH,
    lookbackMinutes: Number(process.env.MINUTES_DIGEST_LOOKBACK_MINUTES || 60),
    overlapMinutes: Number(process.env.MINUTES_DIGEST_OVERLAP_MINUTES || 10),
    ignoreLastChecked: false,
    noAdvanceCheckpoint: false,
    createDocs: process.env.MINUTES_DIGEST_CREATE_DOCS !== "false",
    storePublicMemory: process.env.MINUTES_DIGEST_STORE_PUBLIC_MEMORY !== "false",
    dryRun: false,
    minStartDate: process.env.MINUTES_DIGEST_MIN_START_DATE || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--ignore-last-checked" || arg === "--force-lookback") args.ignoreLastChecked = true;
    else if (arg === "--no-advance-checkpoint") args.noAdvanceCheckpoint = true;
    else if (arg === "--no-create-doc") args.createDocs = false;
    else if (arg === "--no-store-public-memory") args.storePublicMemory = false;
    else if (arg === "--state") args.statePath = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--overlap-minutes") args.overlapMinutes = Number(argv[++i]);
    else if (arg === "--min-start-date") args.minStartDate = argv[++i];
    else if (arg === "--today-only") args.minStartDate = "today";
  }
  return args;
}

function resolveMinStartDate(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.toLowerCase() === "today") {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  }
  // Accept YYYY-MM-DD or full ISO timestamps.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --min-start-date value: ${value}`);
  return parsed;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function pickFeishuConfig(config) {
  const accounts = config?.integrations?.feishu?.accounts || config?.channels?.feishu?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const value of Object.values(accounts)) {
      if (value?.appId) return value;
    }
  }
  if (config?.channels?.feishu?.appId) return config.channels.feishu;
  if (config?.feishu?.appId) return config.feishu;
  return null;
}

function mcpDomain(domain) {
  return domain === "lark" ? "https://mcp.larksuite.com" : "https://mcp.feishu.cn";
}

function extractMcpEndpoint(feishu, domain) {
  const configured = feishu?.mcpEndpoint || feishu?.mcp_url || process.env.FEISHU_MCP_ENDPOINT;
  return configured || `${mcpDomain(domain)}/mcp`;
}

async function loadAppConfig() {
  const configPath = process.env.OPENCLAW_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json");
  const config = await readJson(configPath, {});
  const feishu = pickFeishuConfig(config);
  const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || feishu?.appId;
  let appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appSecret && feishu?.appSecret?.source === "file") {
    const providerId = feishu.appSecret.provider;
    const secretId = feishu.appSecret.id;
    const provider = config?.secrets?.providers?.[providerId] || config?.secrets?.[providerId];
    const secretPath = provider?.path?.replace(/^~/, os.homedir());
    const secretDoc = secretPath ? await readJson(secretPath, {}) : {};
    appSecret = secretId?.split("/").filter(Boolean).reduce((obj, key) => obj?.[key], secretDoc);
  }
  const domain = process.env.LARK_DOMAIN || process.env.FEISHU_DOMAIN || feishu?.domain || "feishu";
  const apiBase = process.env.LARK_API_BASE || process.env.FEISHU_API_BASE ||
    (domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
  const mcpEndpoint = extractMcpEndpoint(feishu, domain);
  if (!appId || !appSecret) throw new Error("missing appId/appSecret; set LARK_APP_ID and LARK_APP_SECRET or configure OpenClaw Feishu");
  return { appId, appSecret, apiBase, domain, mcpEndpoint };
}

async function apiFetch(apiBase, urlPath, { method = "GET", token, body, query } = {}) {
  const url = new URL(`${apiBase}${urlPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    if (!res.ok) throw new Error(`${method} ${urlPath} failed: HTTP ${res.status}`);
    return await res.text();
  }
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    const err = new Error(`${method} ${urlPath} failed: code=${data.code ?? res.status} msg=${data.msg || res.statusText}`);
    err.code = data.code;
    err.response = data;
    throw err;
  }
  return data;
}

function unwrapJsonRpcResult(value) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.jsonrpc === "string" && ("result" in value || "error" in value)) {
    if (value.error) throw new Error(value.error.message || "MCP returned error");
    return unwrapJsonRpcResult(value.result);
  }
  if ("result" in value && !("error" in value) && !("jsonrpc" in value)) return unwrapJsonRpcResult(value.result);
  return value;
}

async function callMcpTool(cfg, name, args, userToken) {
  const id = `minutes-digest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Lark-MCP-UAT": userToken,
    "X-Lark-MCP-Allowed-Tools": name,
  };
  const bearer = process.env.FEISHU_MCP_BEARER_TOKEN || process.env.FEISHU_MCP_TOKEN;
  if (bearer) headers.Authorization = bearer.toLowerCase().startsWith("bearer ") ? bearer : `Bearer ${bearer}`;
  const res = await fetch(cfg.mcpEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${name} failed: HTTP ${res.status} ${text.slice(0, 1000)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MCP ${name} returned non-JSON: ${text.slice(0, 1000)}`);
  }
  if (data.error) throw new Error(`MCP ${name} error ${data.error.code}: ${data.error.message}`);
  const unwrapped = unwrapJsonRpcResult(data.result);
  const content = unwrapped?.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return { text: content[0].text };
    }
  }
  return unwrapped;
}

async function getTenantToken({ apiBase, appId, appSecret }) {
  const data = await apiFetch(apiBase, "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: { app_id: appId, app_secret: appSecret },
  });
  return data.tenant_access_token;
}

function safeTokenFileName(account) {
  return `${account.replace(/[^a-zA-Z0-9._-]/g, "_")}.enc`;
}

async function decryptStoredToken(filePath, masterKey) {
  const data = await fs.readFile(filePath);
  if (data.length < 28) return null;
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const payload = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

async function encryptStoredToken(filePath, masterKey, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
  await fs.writeFile(filePath, Buffer.concat([iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
}

async function loadUserTokens(appId) {
  const dir = process.env.OPENCLAW_FEISHU_UAT_DIR || DEFAULT_UAT_DIR;
  const masterKey = await fs.readFile(path.join(dir, "master.key"));
  const entries = await fs.readdir(dir).catch(() => []);
  const tokens = new Map();
  for (const file of entries.filter((name) => name.endsWith(".enc"))) {
    try {
      const token = await decryptStoredToken(path.join(dir, file), masterKey);
      if (token?.appId === appId && token?.userOpenId) {
        tokens.set(token.userOpenId, { token, filePath: path.join(dir, file), masterKey });
      }
    } catch {
      // Ignore unreadable credential entries from other apps/versions.
    }
  }
  return tokens;
}

async function refreshOAuthToken(cfg, refreshToken) {
  const url = `${cfg.apiBase}/open-apis/authen/v2/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
    }).toString(),
  });
  const data = await res.json();
  const errCode = data.code ?? data.error;
  if ((errCode !== undefined && errCode !== 0) || data.error) {
    const err = new Error(`POST /open-apis/authen/v2/oauth/token failed: code=${errCode} msg=${data.msg || data.error_description || data.error || res.statusText}`);
    err.code = errCode;
    throw err;
  }
  if (!data.access_token) throw new Error("Token refresh returned no access_token");
  return data;
}

async function refreshUserTokenIfNeeded(cfg, entry) {
  const now = Date.now();
  if (entry.token.expiresAt && now < entry.token.expiresAt - 5 * 60 * 1000) return entry.token.accessToken;
  if (!entry.token.refreshToken || (entry.token.refreshExpiresAt && now >= entry.token.refreshExpiresAt)) {
    throw new Error("user token expired and cannot refresh");
  }
  const next = await refreshOAuthToken(cfg, entry.token.refreshToken);
  entry.token = {
    ...entry.token,
    accessToken: next.access_token,
    refreshToken: next.refresh_token || entry.token.refreshToken,
    expiresAt: now + Number(next.expires_in || 0) * 1000,
    refreshExpiresAt: next.refresh_token_expires_in
      ? now + Number(next.refresh_token_expires_in) * 1000
      : entry.token.refreshExpiresAt,
    scope: next.scope || entry.token.scope,
  };
  await encryptStoredToken(entry.filePath, entry.masterKey, entry.token);
  return entry.token.accessToken;
}

async function listDepartments(cfg, tenantToken) {
  const ids = new Set(["0"]);
  const data = await apiFetch(cfg.apiBase, "/open-apis/contact/v3/departments/0/children", {
    token: tenantToken,
    query: { department_id_type: "open_department_id", fetch_child: true, page_size: 50 },
  }).catch(() => null);
  for (const item of data?.data?.items || []) {
    const id = item.open_department_id || item.department_id;
    if (id) ids.add(id);
  }
  return [...ids];
}

async function listUsersInDepartment(cfg, tenantToken, departmentId) {
  const users = [];
  let pageToken = "";
  do {
    const data = await apiFetch(cfg.apiBase, "/open-apis/contact/v3/users/find_by_department", {
      token: tenantToken,
      query: {
        department_id: departmentId,
        department_id_type: "open_department_id",
        user_id_type: "open_id",
        page_size: 50,
        page_token: pageToken,
      },
    });
    users.push(...(data.data?.items || []));
    pageToken = data.data?.page_token || "";
  } while (pageToken);
  return users;
}

async function listEmployees(cfg, tenantToken, authorizedTokenMap) {
  const employees = new Map();
  try {
    for (const dept of await listDepartments(cfg, tenantToken)) {
      for (const user of await listUsersInDepartment(cfg, tenantToken, dept)) {
        const id = user.open_id || user.user_id || user.union_id;
        if (id && !user.status?.is_frozen && !user.status?.is_resigned) employees.set(id, user);
      }
    }
  } catch (err) {
    console.warn(`employee list failed, falling back to authorized tokens only: ${err.message}`);
  }
  for (const userId of authorizedTokenMap.keys()) {
    if (!employees.has(userId)) employees.set(userId, { open_id: userId, name: userId });
  }
  return employees;
}

async function searchMinutesWindow(cfg, userToken, startTime, endTime) {
  const items = [];
  let pageToken = "";
  let hasMore = false;
  do {
    const data = await apiFetch(cfg.apiBase, "/open-apis/minutes/v1/minutes/search", {
      method: "POST",
      token: userToken,
      query: { page_size: 30, page_token: pageToken, user_id_type: "open_id" },
      body: {
        query: "",
        sorter: "create_time_desc",
        filter: { create_time: { start_time: startTime, end_time: endTime } },
      },
    });
    items.push(...(data.data?.items || []));
    hasMore = Boolean(data.data?.has_more);
    pageToken = hasMore ? data.data?.page_token || "" : "";
  } while (hasMore && pageToken);
  return items;
}

async function searchMinutes(cfg, userToken, startDate, endDate) {
  const maxWindowMinutes = Number(process.env.MINUTES_DIGEST_SEARCH_WINDOW_MINUTES || 60);
  const items = [];
  let cursor = new Date(startDate);
  while (cursor < endDate) {
    const next = new Date(Math.min(endDate.getTime(), cursor.getTime() + maxWindowMinutes * 60_000));
    try {
      items.push(...await searchMinutesWindow(cfg, userToken, formatIso(cursor), formatIso(next)));
    } catch (err) {
      if (err.code === 2094007 && maxWindowMinutes > 10) {
        const old = process.env.MINUTES_DIGEST_SEARCH_WINDOW_MINUTES;
        process.env.MINUTES_DIGEST_SEARCH_WINDOW_MINUTES = "10";
        items.push(...await searchMinutes(cfg, userToken, cursor, next));
        if (old === undefined) delete process.env.MINUTES_DIGEST_SEARCH_WINDOW_MINUTES;
        else process.env.MINUTES_DIGEST_SEARCH_WINDOW_MINUTES = old;
      } else {
        throw err;
      }
    }
    cursor = next;
    await sleep(150);
  }
  return items;
}

function minuteTokenOf(item) {
  return item.minute_token || item.token || item.object_token || item.id;
}

function ownerOpenIdOf(detail) {
  return detail.owner_id ||
    detail.owner_open_id ||
    detail.owner?.open_id ||
    detail.owner?.owner_id ||
    detail.creator_id ||
    detail.creator?.open_id ||
    null;
}

async function getMinuteDetail(cfg, token, minuteToken) {
  const data = await apiFetch(cfg.apiBase, `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`, { token });
  return data.data?.minute || data.data || {};
}

async function getTranscript(cfg, token, minuteToken) {
  return await apiFetch(cfg.apiBase, `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript`, {
    token,
    query: { file_format: "txt", need_speaker: true, need_timestamp: true },
  });
}

async function loadOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const profile = await readJson(path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json"), {});
  return profile?.profiles?.["openai:default"]?.key || null;
}

async function summarizeTranscript(title, transcript) {
  const key = await loadOpenAIKey();
  const clipped = transcript.slice(0, Number(process.env.MINUTES_DIGEST_MAX_TRANSCRIPT_CHARS || 45000));
  if (!key) {
    return [
      "AI 总结未执行：未配置 OPENAI_API_KEY。",
      "",
      "转写摘录：",
      clipped.slice(0, 1200),
    ].join("\n");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "你是公司会议纪要助手。用中文输出简洁、可执行的会议总结。" },
        { role: "user", content: `会议标题：${title || "未命名妙记"}\n\n请基于转写输出：1. 核心结论；2. 决策；3. 待办（负责人/时间如有）；4. 风险或未决问题。\n\n转写：\n${clipped}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI summary failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "AI 总结为空。";
}

async function sendText(cfg, tenantToken, openId, text) {
  return await apiFetch(cfg.apiBase, "/open-apis/im/v1/messages", {
    method: "POST",
    token: tenantToken,
    query: { receive_id_type: "open_id" },
    body: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
  });
}

function formatIso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function escapeMarkdownText(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]<>()#+.!|~-]/g, "\\$&");
}

function formatMessage(detail, summary, docUrl) {
  const title = detail.title || detail.topic || "新妙记";
  const url = detail.url || detail.app_link || "";
  return [
    `发现新的飞书妙记：${title}`,
    url ? `链接：${url}` : "",
    docUrl ? `总结文档：${docUrl}` : "",
    "",
    "AI 总结：",
    summary,
  ].filter(Boolean).join("\n");
}

function summaryDocTitle(detail) {
  const title = detail.title || detail.topic || "未命名妙记";
  const date = new Date().toISOString().slice(0, 10);
  return `妙记总结 - ${title} - ${date}`.slice(0, 120);
}

function buildMeetingMemoryText(detail, summary, minuteToken, summaryDoc) {
  const title = detail.title || detail.topic || "未命名妙记";
  const minuteUrl = detail.url || detail.app_link || "";
  const createdAt = detail.create_time || detail.created_at || detail.start_time || "";
  return [
    "[飞书妙记会议总结]",
    `标题: ${title}`,
    `妙记 Token: ${minuteToken}`,
    minuteUrl ? `原始妙记: ${minuteUrl}` : "",
    summaryDoc?.docUrl ? `总结文档: ${summaryDoc.docUrl}` : "",
    createdAt ? `创建时间: ${createdAt}` : "",
    "",
    "AI 总结:",
    summary || "未生成总结。",
  ].filter(Boolean).join("\n");
}

async function storeMeetingSummaryToPublicMemory(detail, summary, minuteToken, summaryDoc, stats, { dryRun = false } = {}) {
  const result = await storePublicMemoryItem({
    text: buildMeetingMemoryText(detail, summary, minuteToken, summaryDoc),
    category: "meeting_summary",
    source: "lark_minutes",
    source_id: minuteToken,
    importance: 0.75,
  }, { dryRun });
  if (result.skipped) {
    stats.memorySkipped += 1;
    return { ...result, status: "skipped" };
  }
  if (result.dryRun) {
    stats.memoryStored += 1;
    return { ...result, status: "dry_run" };
  }
  if (result.stored) {
    stats.memoryStored += 1;
    return { ...result, status: "stored" };
  }
  return { ...result, status: "unknown" };
}

function summaryDocMarkdown(detail, summary, minuteToken) {
  const title = detail.title || detail.topic || "未命名妙记";
  const minuteUrl = detail.url || detail.app_link || "";
  const createdAt = detail.create_time || detail.created_at || detail.start_time || "";
  return [
    `<callout emoji="📝" background-color="light-blue">`,
    `本页由 OpenClaw 自动根据飞书妙记转写生成，用于快速回顾会议结论与行动项。`,
    `</callout>`,
    "",
    "## 基本信息",
    "",
    `| 字段 | 内容 |`,
    `|------|------|`,
    `| 妙记标题 | ${escapeMarkdownText(title)} |`,
    `| 妙记 Token | \`${minuteToken}\` |`,
    minuteUrl ? `| 原始妙记 | ${minuteUrl} |` : `| 原始妙记 | 未获取到链接 |`,
    createdAt ? `| 创建时间 | ${escapeMarkdownText(createdAt)} |` : "",
    "",
    "---",
    "",
    "## AI 总结",
    "",
    summary || "未生成总结。",
    "",
    "---",
    "",
    "## 后续处理",
    "",
    "- [ ] 确认决策是否准确",
    "- [ ] 补充遗漏的负责人和截止时间",
    "- [ ] 将需要跟进的事项同步到任务系统",
  ].filter(Boolean).join("\n");
}

async function createSummaryDoc(cfg, userToken, detail, summary, minuteToken) {
  const args = {
    title: summaryDocTitle(detail),
    markdown: summaryDocMarkdown(detail, summary, minuteToken),
  };
  if (process.env.MINUTES_DIGEST_DOC_WIKI_NODE) args.wiki_node = process.env.MINUTES_DIGEST_DOC_WIKI_NODE;
  else if (process.env.MINUTES_DIGEST_DOC_WIKI_SPACE) args.wiki_space = process.env.MINUTES_DIGEST_DOC_WIKI_SPACE;
  else if (process.env.MINUTES_DIGEST_DOC_FOLDER_TOKEN) args.folder_token = process.env.MINUTES_DIGEST_DOC_FOLDER_TOKEN;
  const result = await callMcpTool(cfg, "create-doc", args, userToken);
  return {
    docId: result.doc_id || result.docx_token || result.token || result.document_id || null,
    docUrl: result.doc_url || result.url || result.document_url || null,
    raw: result,
  };
}

function normalizeState(state) {
  return {
    processed: state?.processed && typeof state.processed === "object" ? state.processed : {},
    sent: state?.sent && typeof state.sent === "object" ? state.sent : {},
    docNotified: state?.docNotified && typeof state.docNotified === "object" ? state.docNotified : {},
    lastCheckedAt: state?.lastCheckedAt || null,
    lastRun: state?.lastRun || null,
  };
}

async function buildMinuteArtifacts(cfg, found, minuteToken, stats, { createDoc = true, dryRun = false } = {}) {
  let detail = found.item;
  let summary = "";
  let summaryDoc = null;
  try {
    detail = { ...found.item, ...await getMinuteDetail(cfg, found.accessToken, minuteToken) };
    const transcript = await getTranscript(cfg, found.accessToken, minuteToken);
    summary = await summarizeTranscript(detail.title || detail.topic, transcript);
  } catch (err) {
    summary = `无法读取完整转写或生成 AI 总结：${err.message}\n\n已记录到新妙记索引，请检查该妙记导出/阅读权限。`;
    stats.errors.push({ minute: minuteToken, error: err.message });
  }
  if (createDoc) {
    if (dryRun) {
      stats.docsCreated += 1;
      summaryDoc = { docId: null, docUrl: "(dry-run)" };
    } else {
      try {
        summaryDoc = await createSummaryDoc(cfg, found.accessToken, detail, summary, minuteToken);
        stats.docsCreated += 1;
      } catch (err) {
        stats.docErrors += 1;
        stats.errors.push({ minute: minuteToken, createDoc: true, error: err.message });
      }
    }
  }
  return { detail, summary, summaryDoc, message: formatMessage(detail, summary, summaryDoc?.docUrl) };
}

async function maybeStoreMeetingSummaryToPublicMemory(args, detail, summary, minuteToken, summaryDoc, stats) {
  if (!args.storePublicMemory || !summaryDoc?.docUrl || !summary) return null;
  try {
    return await storeMeetingSummaryToPublicMemory(detail, summary, minuteToken, summaryDoc, stats, { dryRun: args.dryRun });
  } catch (err) {
    stats.memoryErrors += 1;
    stats.errors.push({ minute: minuteToken, publicMemory: true, error: err.message });
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadAppConfig();
  const state = normalizeState(await readJson(args.statePath, {}));
  const now = new Date();
  const previous = !args.ignoreLastChecked && state.lastCheckedAt
    ? new Date(state.lastCheckedAt)
    : new Date(now.getTime() - args.lookbackMinutes * 60_000);
  const start = new Date(previous.getTime() - args.overlapMinutes * 60_000);
  const end = now;

  const minStart = resolveMinStartDate(args.minStartDate);
  let startFloored = false;
  if (minStart && start < minStart) {
    start.setTime(minStart.getTime());
    startFloored = true;
  }
  if (minStart && end < minStart) {
    // Nothing to search if the entire window is before the floor.
    console.log(JSON.stringify({
      status: "ok",
      window: { start: formatIso(start), end: formatIso(end) },
      minStartDate: minStart.toISOString(),
      skipped: "window-before-min-start",
      stats: { searched: 0, discoveredMinutes: 0, newMinutes: 0, sent: 0 },
    }, null, 2));
    return;
  }

  const tenantToken = await getTenantToken(cfg);
  const userTokens = await loadUserTokens(cfg.appId);
  const employees = await listEmployees(cfg, tenantToken, userTokens);

  const discovered = new Map();
  const stats = {
    employees: employees.size,
    authorized: 0,
    skippedNoToken: 0,
    searched: 0,
    discoveredMinutes: 0,
    newMinutes: 0,
    knownMinutes: 0,
    newRecipients: 0,
    docsCreated: 0,
    docErrors: 0,
    docNotificationsSent: 0,
    memoryStored: 0,
    memorySkipped: 0,
    memoryErrors: 0,
    sent: 0,
    sendErrors: 0,
    errors: [],
  };

  for (const [openId] of employees) {
    const entry = userTokens.get(openId);
    if (!entry) {
      stats.skippedNoToken += 1;
      continue;
    }
    stats.authorized += 1;
    try {
      const accessToken = await refreshUserTokenIfNeeded(cfg, entry);
      const items = await searchMinutes(cfg, accessToken, start, end);
      stats.searched += items.length;
      for (const item of items) {
        const minuteToken = minuteTokenOf(item);
        if (!minuteToken) continue;
        if (!discovered.has(minuteToken)) discovered.set(minuteToken, { item, visibleUsers: new Set(), accessToken });
        discovered.get(minuteToken).visibleUsers.add(openId);
      }
      await sleep(250);
    } catch (err) {
      stats.errors.push({ user: openId, error: err.message });
    }
  }

  for (const [minuteToken, found] of discovered) {
    stats.discoveredMinutes += 1;
    const existing = state.processed[minuteToken] || null;
    if (existing) stats.knownMinutes += 1;
    else stats.newMinutes += 1;

    state.sent[minuteToken] ||= {};
    const existingOwnerOpenId = existing?.ownerOpenId || null;
    const initialRecipients = new Set(found.visibleUsers);
    if (existingOwnerOpenId) initialRecipients.add(existingOwnerOpenId);
    const hasUnsentInitialRecipients = [...initialRecipients].some((openId) => !state.sent[minuteToken][openId]);
    const needsSummaryDoc = args.createDocs && !existing?.summaryDocUrl;
    if (existing && !hasUnsentInitialRecipients && !needsSummaryDoc) {
      existing.lastSeenAt = new Date().toISOString();
      existing.visibleUsers = [...new Set([...(existing.visibleUsers || []), ...found.visibleUsers])];
      continue;
    }

    const { detail, summary, summaryDoc } = await buildMinuteArtifacts(cfg, found, minuteToken, stats, {
      createDoc: args.createDocs && (!existing?.summaryDocUrl),
      dryRun: args.dryRun,
    });
    const memoryResult = await maybeStoreMeetingSummaryToPublicMemory(args, detail, summary, minuteToken, summaryDoc, stats);
    const message = formatMessage(detail, summary, summaryDoc?.docUrl);
    const recipients = new Set(initialRecipients);
    const ownerOpenId = ownerOpenIdOf(detail);
    if (ownerOpenId) recipients.add(ownerOpenId);
    for (const openId of recipients) {
      if (state.sent[minuteToken][openId]) continue;
      stats.newRecipients += 1;
      if (args.dryRun) {
        stats.sent += 1;
        continue;
      }
      try {
        await sendText(cfg, tenantToken, openId, message);
        state.sent[minuteToken][openId] = new Date().toISOString();
        stats.sent += 1;
        await sleep(250);
      } catch (err) {
        stats.sendErrors += 1;
        stats.errors.push({ sendTo: openId, minute: minuteToken, error: err.message });
      }
    }
    if (existing && !hasUnsentInitialRecipients && summaryDoc?.docUrl) {
      state.docNotified[minuteToken] ||= {};
      const docMessage = [
        `已为飞书妙记生成总结文档：${detail.title || detail.topic || existing.title || "新妙记"}`,
        `总结文档：${summaryDoc.docUrl}`,
        existing.url ? `原始妙记：${existing.url}` : "",
      ].filter(Boolean).join("\n");
      for (const openId of recipients) {
        if (state.docNotified[minuteToken][openId]) continue;
        if (args.dryRun) {
          stats.docNotificationsSent += 1;
          continue;
        }
        try {
          await sendText(cfg, tenantToken, openId, docMessage);
          state.docNotified[minuteToken][openId] = new Date().toISOString();
          stats.docNotificationsSent += 1;
          await sleep(250);
        } catch (err) {
          stats.sendErrors += 1;
          stats.errors.push({ docNotifyTo: openId, minute: minuteToken, error: err.message });
        }
      }
    }
    state.processed[minuteToken] = {
      firstSeenAt: existing?.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      title: detail.title || detail.topic || found.item.title,
      url: detail.url || detail.app_link || found.item.url,
      ownerOpenId,
      summaryDocId: summaryDoc?.docId || existing?.summaryDocId || null,
      summaryDocUrl: summaryDoc?.docUrl || existing?.summaryDocUrl || null,
      publicMemoryStoredAt: memoryResult?.stored || memoryResult?.dryRun
        ? new Date().toISOString()
        : (existing?.publicMemoryStoredAt || null),
      visibleUsers: [...new Set([...(existing?.visibleUsers || []), ...found.visibleUsers])],
    };
  }

  if (!args.dryRun) {
    if (!args.noAdvanceCheckpoint) state.lastCheckedAt = end.toISOString();
    state.lastRun = {
      at: new Date().toISOString(),
      window: { start: formatIso(start), end: formatIso(end) },
      ignoreLastChecked: args.ignoreLastChecked,
      advancedCheckpoint: !args.noAdvanceCheckpoint,
      minStartDate: minStart ? minStart.toISOString() : null,
      startFloored,
      stats: { ...stats, errors: stats.errors.slice(0, 20) },
    };
    await writeJson(args.statePath, state);
  }
  console.log(JSON.stringify({
    status: "ok",
    window: { start: formatIso(start), end: formatIso(end) },
    minStartDate: minStart ? minStart.toISOString() : null,
    startFloored,
    dryRun: args.dryRun,
    ignoreLastChecked: args.ignoreLastChecked,
    advancedCheckpoint: !args.dryRun && !args.noAdvanceCheckpoint,
    createDocs: args.createDocs,
    storePublicMemory: args.storePublicMemory,
    stats,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "error", error: err.message }, null, 2));
  process.exit(1);
});
