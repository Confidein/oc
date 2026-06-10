/**
 * feishu-memory-sync — 飞书群聊 & Wiki 同步到公共记忆库
 *
 * 提供两个工具：
 *   feishu_im_bot_sync_group_messages  — 增量同步群聊消息
 *   feishu_doc_sync_public_memory      — 增量同步 Wiki / 云文档
 *
 * 两个工具均使用 Feishu 应用级 tenant_access_token（Bot 权限），
 * 不需要用户 OAuth，只需在配置中填入 appId / appSecret。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PLUGIN_ID = "feishu-memory-sync";

const DEFAULT_CONFIG = {
  feishu: {
    appId: "",
    appSecret: "",
    domain: "open.feishu.cn"   // 国内版；海外版用 open.larksuite.com
  },
  groups: {
    enabled: true,
    module: "general",
    minTextLength: 10,          // 消息最短字数，太短的跳过
    maxChatsPerRun: 100,
    maxMessagesPerChat: 50
  },
  docs: {
    enabled: true,
    module: "general",
    chunkSize: 800,             // 每条记忆的字符数
    maxChunksPerDoc: 100,
    maxDocsPerRun: 20
  }
};

// ── 配置 ────────────────────────────────────────────────────

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    feishu: { ...base.feishu, ...(override?.feishu ?? {}) },
    groups: { ...base.groups, ...(override?.groups ?? {}) },
    docs:   { ...base.docs,   ...(override?.docs   ?? {}) }
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

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

// ── 状态管理 ─────────────────────────────────────────────────

const STATE_DIR = expandHome("~/.openclaw/feishu-memory-sync");

async function loadState(name) {
  const file = path.join(STATE_DIR, `${name}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

async function saveState(name, state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(STATE_DIR, `${name}.json`),
    JSON.stringify(state, null, 2)
  );
}

// ── Feishu API 基础层 ─────────────────────────────────────────

// Token 缓存（内存级，重启后重新获取）
let _tokenCache = null;

async function getTenantToken(feishu) {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60000) {
    return _tokenCache.token;
  }

  const res = await fetch(
    `https://${feishu.domain}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret })
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg}`);

  _tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + data.expire * 1000
  };
  return _tokenCache.token;
}

async function feishuGet(domain, token, path_, signal) {
  const res = await fetch(`https://${domain}${path_}`, {
    headers: { authorization: `Bearer ${token}` },
    signal
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu API ${path_}: ${data.msg}`);
  return data.data;
}

// 分页拉取所有数据（自动翻页）
async function feishuPaginateGet(domain, token, basePath, dataKey, maxItems = 1000, signal) {
  const items = [];
  let pageToken = null;
  while (items.length < maxItems) {
    const url = pageToken
      ? `${basePath}&page_token=${encodeURIComponent(pageToken)}`
      : basePath;
    const data = await feishuGet(domain, token, url, signal);
    const batch = data[dataKey] ?? [];
    items.push(...batch);
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return items.slice(0, maxItems);
}

// ── 飞书文档 URL 识别 ────────────────────────────────────────

const DOC_URL_PATTERNS = [
  { re: /feishu\.cn\/docx\/([A-Za-z0-9_-]{10,})/,     type: "docx"     },
  { re: /feishu\.cn\/docs\/([A-Za-z0-9_-]{10,})/,     type: "doc"      },
  { re: /feishu\.cn\/sheets\/([A-Za-z0-9_-]{10,})/,   type: "sheet"    },
  { re: /feishu\.cn\/base\/([A-Za-z0-9_-]{10,})/,     type: "bitable"  },
  { re: /feishu\.cn\/wiki\/([A-Za-z0-9_-]{10,})/,     type: "wiki"     },
  { re: /feishu\.cn\/file\/([A-Za-z0-9_-]{10,})/,     type: "file"     },
  { re: /larksuite\.com\/docx\/([A-Za-z0-9_-]{10,})/, type: "docx"     },
  { re: /larksuite\.com\/docs\/([A-Za-z0-9_-]{10,})/, type: "doc"      },
  { re: /larksuite\.com\/sheets\/([A-Za-z0-9_-]{10,})/,type: "sheet"   },
  { re: /larksuite\.com\/base\/([A-Za-z0-9_-]{10,})/,  type: "bitable" },
  { re: /larksuite\.com\/wiki\/([A-Za-z0-9_-]{10,})/,  type: "wiki"    },
];

function extractDocLinks(text) {
  const results = [];
  for (const { re, type } of DOC_URL_PATTERNS) {
    const m = text.match(re);
    if (m) results.push({ token: m[1], type });
  }
  return results;
}

// ── 用户 token 加载（授权回退用）────────────────────────────

async function loadUserTokens() {
  const authPath = path.join(
    os.homedir(), ".openclaw/agents/main/agent/auth-state.json"
  );
  try {
    const raw = JSON.parse(await fs.readFile(authPath, "utf8"));
    // 收集所有 access_token
    const tokens = [];
    function walk(obj) {
      if (!obj || typeof obj !== "object") return;
      if (obj.access_token && typeof obj.access_token === "string") {
        tokens.push(obj.access_token);
      }
      for (const v of Object.values(obj)) walk(v);
    }
    walk(raw);
    return [...new Set(tokens)];
  } catch { return []; }
}

// ── 飞书文档内容获取（带权限回退）────────────────────────────

async function fetchDocContent(domain, botToken, docType, docToken, userTokens = []) {
  const tryTokens = [botToken, ...userTokens];

  for (const token of tryTokens) {
    try {
      const content = await fetchDocWithToken(domain, token, docType, docToken);
      if (content) return content;
    } catch (err) {
      // 403 权限不足，换下一个 token
      if (err.message?.includes("403") || err.message?.includes("permission") ||
          err.message?.includes("99991663") || err.message?.includes("99991401")) {
        continue;
      }
      throw err;
    }
  }
  return null; // 所有 token 都没权限
}

async function fetchDocWithToken(domain, token, docType, docToken) {
  const headers = { authorization: `Bearer ${token}` };

  if (docType === "docx") {
    const r = await fetch(
      `https://${domain}/open-apis/docx/v1/documents/${docToken}/raw_content`,
      { headers }
    );
    const d = await r.json();
    if (d.code === 99991663 || d.code === 99991401) throw new Error("403 permission");
    if (d.code !== 0) throw new Error(`docx API error: ${d.msg}`);
    return d.data?.content?.trim() ?? null;
  }

  if (docType === "doc") {
    const r = await fetch(
      `https://${domain}/open-apis/doc/v2/${docToken}/raw_content`,
      { headers }
    );
    const d = await r.json();
    if (d.code === 99991663 || d.code === 99991401) throw new Error("403 permission");
    if (d.code !== 0) throw new Error(`doc API error: ${d.msg}`);
    return d.data?.content?.trim() ?? null;
  }

  if (docType === "sheet") {
    // 读取第一个 sheet 的前 100 行
    const r1 = await fetch(
      `https://${domain}/open-apis/sheets/v2/spreadsheets/${docToken}/metainfo`,
      { headers }
    );
    const d1 = await r1.json();
    if (d1.code === 99991663 || d1.code === 99991401) throw new Error("403 permission");
    if (d1.code !== 0) throw new Error(`sheet meta error: ${d1.msg}`);
    const sheets = d1.data?.sheets ?? [];
    if (!sheets.length) return null;
    const sheetId = sheets[0].sheetId;
    const title   = d1.data?.properties?.title ?? docToken;

    const r2 = await fetch(
      `https://${domain}/open-apis/sheets/v2/spreadsheets/${docToken}/values/${sheetId}!A1:Z100`,
      { headers }
    );
    const d2 = await r2.json();
    if (d2.code !== 0) return `[电子表格: ${title}]`;
    const rows = d2.data?.valueRange?.values ?? [];
    const text = rows.map(row =>
      row.filter(Boolean).join("\t")
    ).filter(Boolean).join("\n");
    return `[电子表格: ${title}]\n${text}`;
  }

  if (docType === "bitable") {
    const r1 = await fetch(
      `https://${domain}/open-apis/bitable/v1/apps/${docToken}`,
      { headers }
    );
    const d1 = await r1.json();
    if (d1.code === 99991663 || d1.code === 99991401) throw new Error("403 permission");
    const appName = d1.data?.app?.name ?? docToken;

    const r2 = await fetch(
      `https://${domain}/open-apis/bitable/v1/apps/${docToken}/tables?page_size=10`,
      { headers }
    );
    const d2 = await r2.json();
    const tables = d2.data?.items ?? [];
    const parts  = [`[多维表格: ${appName}]`];

    for (const tbl of tables.slice(0, 3)) {
      // 读每个表的字段名 + 前 20 条记录
      const r3 = await fetch(
        `https://${domain}/open-apis/bitable/v1/apps/${docToken}/tables/${tbl.table_id}/records?page_size=20`,
        { headers }
      );
      const d3 = await r3.json();
      const records = d3.data?.items ?? [];
      const rows = records.map(rec =>
        Object.entries(rec.fields ?? {}).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join(" | ")
      );
      parts.push(`表[${tbl.name}]:\n${rows.join("\n")}`);
    }
    return parts.join("\n\n");
  }

  if (docType === "wiki") {
    // wiki token 先转 obj_token
    const r1 = await fetch(
      `https://${domain}/open-apis/wiki/v2/nodes?token=${docToken}`,
      { headers }
    );
    const d1 = await r1.json();
    const node = d1.data?.node;
    if (!node) return null;
    const objToken = node.obj_token;
    const objType  = node.obj_type; // docx / doc
    return fetchDocWithToken(domain, token, objType, objToken);
  }

  if (docType === "file") {
    // 获取文件信息（名称、类型），下载后尝试提取文本
    const r1 = await fetch(
      `https://${domain}/open-apis/drive/v1/files/${docToken}`,
      { headers }
    );
    const d1 = await r1.json();
    if (d1.code === 99991663 || d1.code === 99991401) throw new Error("403 permission");
    const name = d1.data?.file?.name ?? docToken;
    const mimeType = d1.data?.file?.type ?? "";

    // PDF：尝试下载并提取文字（需 pdfjs-dist，没有则只记录文件名）
    if (mimeType.includes("pdf") || name.toLowerCase().endsWith(".pdf")) {
      try {
        const text = await extractPdfText(domain, token, docToken, name);
        return text ? `[PDF: ${name}]\n${text}` : `[PDF 文件: ${name}（无法提取文字）]`;
      } catch {
        return `[PDF 文件: ${name}（提取失败）]`;
      }
    }

    // 其他文件类型：只记录文件名
    return `[文件: ${name}（类型: ${mimeType || "未知"}，暂不支持提取内容）]`;
  }

  return null;
}

// ── PDF 文本提取（动态加载 pdfjs-dist）──────────────────────

async function extractPdfText(domain, token, fileToken, fileName) {
  // 1. 下载文件
  const r = await fetch(
    `https://${domain}/open-apis/drive/v1/medias/${fileToken}/download`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`下载失败: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());

  // 2. 尝试用 pdfjs-dist 解析（可选依赖）
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js").catch(() => null);
    if (!pdfjs) return null;

    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const parts = [];
    for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
      const page    = await doc.getPage(i);
      const content = await page.getTextContent();
      const text    = content.items.map(it => it.str).join(" ");
      if (text.trim()) parts.push(text.trim());
    }
    return parts.join("\n\n");
  } catch { return null; }
}

// ── 消息内容提取（文本 + 文档 + 文件）───────────────────────

async function extractMessageContent(domain, botToken, userTokens, msg) {
  const results = [];

  // ① 文本 / 富文本 → 提取文字 + 识别文档链接
  if (msg.msg_type === "text" || msg.msg_type === "post") {
    let rawText = "";
    try {
      if (msg.msg_type === "text") {
        rawText = JSON.parse(msg.body?.content ?? "{}").text ?? "";
      } else {
        const post = JSON.parse(msg.body?.content ?? "{}");
        const content = post.zh_cn?.content ?? post.en_us?.content ?? [];
        rawText = content.flat()
          .map(e => e.tag === "text" ? e.text : e.tag === "a" ? e.text + " " + e.href : "")
          .join(" ");
      }
    } catch {}

    const docLinks = extractDocLinks(rawText);

    if (docLinks.length === 0) {
      // 普通文本
      return rawText.trim() || null;
    }

    // 有文档链接 → 先保留原始文字，再追加文档内容
    const pureText = rawText.replace(/https?:\/\/\S+/g, "").trim();
    if (pureText) results.push(pureText);

    for (const { token: docTok, type } of docLinks) {
      const content = await fetchDocContent(domain, botToken, type, docTok, userTokens);
      if (content) results.push(content);
      else results.push(`[文档链接（无权限或不支持）: ${type}/${docTok}]`);
    }
    return results.join("\n\n") || null;
  }

  // ② 文件消息
  if (msg.msg_type === "file") {
    try {
      const body    = JSON.parse(msg.body?.content ?? "{}");
      const fileKey = body.file_key;
      if (!fileKey) return null;
      // file_key 开头是 file_，后面接 token
      const fToken  = fileKey.replace(/^file_/, "");
      const content = await fetchDocContent(domain, botToken, "file", fToken, userTokens);
      return content ?? `[文件消息（无法获取内容）]`;
    } catch { return null; }
  }

  // ③ 分享文档卡片（share_doc / interactive）
  if (msg.msg_type === "share_doc" || msg.msg_type === "interactive") {
    try {
      const body = JSON.parse(msg.body?.content ?? "{}");
      // share_doc 直接有 token
      const docTok = body.token ?? body.doc_token;
      const type   = body.type ?? "docx";
      if (docTok) {
        const content = await fetchDocContent(domain, botToken, type, docTok, userTokens);
        return content ?? `[共享文档（无权限）: ${type}/${docTok}]`;
      }
      // interactive 卡片里找 URL
      const cardStr = JSON.stringify(body);
      const links   = extractDocLinks(cardStr);
      for (const { token: t, type: tp } of links) {
        const content = await fetchDocContent(domain, botToken, tp, t, userTokens);
        if (content) return content;
      }
    } catch {}
    return null;
  }

  return null; // image / media / sticker 等跳过
}

// ── 文档分块 ────────────────────────────────────────────────

function chunkText(text, chunkSize) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (current.length + para.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());

  // 超长段落强制切分
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= chunkSize) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += chunkSize) {
        result.push(chunk.slice(i, i + chunkSize));
      }
    }
  }
  return result;
}

// ── Tool 1: feishu_im_bot_sync_group_messages ───────────────

const GroupSyncSchema = {
  type: "object",
  properties: {
    use_cursor:               { type: "boolean", description: "使用游标断点续传（推荐 true）" },
    initial_lookback_minutes: { type: "number",  description: "首次同步往前看多少分钟（0=不导入历史）" },
    overlap_minutes:          { type: "number",  description: "每次同步时间重叠分钟数（防漏）" },
    max_chats:                { type: "number",  description: "最多处理群数" },
    max_messages_per_chat:    { type: "number",  description: "每群最多读取消息数" },
    write_items_file:         { type: "boolean", description: "写入临时文件（供 public_memory_store_batch 使用）" }
  },
  additionalProperties: false
};

function createGroupSyncTool(api, ctx) {
  return {
    name: "feishu_im_bot_sync_group_messages",
    label: "Feishu Group Message Sync",
    description: "增量同步飞书群聊消息到公共记忆库。使用 Bot 应用级 token，只同步 Bot 所在的群。",
    parameters: GroupSyncSchema,
    execute: async (_id, params, signal) => {
      const config = resolveConfig(api, ctx);
      const { feishu, groups } = config;

      if (!feishu.appId || !feishu.appSecret) {
        throw new Error("feishu-memory-sync: 请在配置中填写 feishu.appId 和 feishu.appSecret");
      }

      const token = await getTenantToken(feishu);
      const state = await loadState("group-sync");

      // 加载用户 token（文档权限回退用）
      const userTokens = await loadUserTokens();

      const maxChats    = params.max_chats             ?? groups.maxChatsPerRun   ?? 100;
      const maxMsgs     = params.max_messages_per_chat ?? groups.maxMessagesPerChat ?? 50;
      const lookback    = params.initial_lookback_minutes ?? 0;
      const overlapSecs = (params.overlap_minutes ?? 5) * 60;
      const minLen      = groups.minTextLength ?? 10;
      const module      = groups.module ?? "general";

      // 1. 获取 Bot 所在群列表
      const chats = await feishuPaginateGet(
        feishu.domain, token,
        `/open-apis/im/v1/chats?page_size=100`,
        "items", maxChats, signal
      );

      const items = [];
      const nowSecs = Math.floor(Date.now() / 1000);

      for (const chat of chats) {
        const chatId   = chat.chat_id;
        const chatName = chat.name ?? chatId;
        const chatState = state[chatId] ?? {};

        // 确定起始时间
        let startTime;
        if (chatState.last_message_time) {
          startTime = chatState.last_message_time - overlapSecs;
        } else {
          startTime = lookback > 0 ? nowSecs - lookback * 60 : nowSecs;
        }

        // 2. 拉取消息
        const url = `/open-apis/im/v1/messages` +
          `?container_id=${encodeURIComponent(chatId)}` +
          `&container_id_type=chat` +
          `&start_time=${startTime}` +
          `&sort_type=ByCreateTimeAsc` +
          `&page_size=${Math.min(maxMsgs, 50)}`;

        let messages;
        try {
          const data = await feishuGet(feishu.domain, token, url, signal);
          messages = data.items ?? [];
        } catch (err) {
          console.warn(`[feishu-memory-sync] 跳过群 ${chatId}: ${err.message}`);
          continue;
        }

        let lastTs = chatState.last_message_time ?? 0;

        for (const msg of messages) {
          // 跳过 Bot 自己发的消息
          if (msg.sender?.sender_type !== "user") continue;

          const msgTs = parseInt(msg.create_time ?? "0");
          if (msgTs <= (chatState.last_message_time ?? 0)) continue;

          // 提取内容（文本、文档链接、文件消息全支持）
          let content = null;
          try {
            content = await extractMessageContent(
              feishu.domain, token, userTokens, msg
            );
          } catch (err) {
            console.warn(`[feishu-memory-sync] 消息内容提取失败 ${msg.message_id}: ${err.message}`);
          }

          if (!content || content.trim().length < minLen) {
            if (msgTs > lastTs) lastTs = msgTs;
            continue;
          }

          // 根据内容长度和类型判断 category
          const isDoc = content.includes("[PDF:") || content.includes("[文件:") ||
                        content.includes("[电子表格:") || content.includes("[多维表格:");
          const category = isDoc ? "doc" : "chat";

          items.push({
            text: `[${chatName}] ${content.trim()}`,
            source: "lark_group",
            source_id: msg.message_id,
            module,
            category,
            chat_id: chatId
          });

          if (msgTs > lastTs) lastTs = msgTs;
        }

        if (lastTs > (chatState.last_message_time ?? 0)) {
          state[chatId] = { ...chatState, last_message_time: lastTs, chat_name: chatName };
        }
      }

      await saveState("group-sync", state);

      if (params.write_items_file && items.length > 0) {
        const tmpDir = expandHome("~/.openclaw/tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, "group-sync-items.json");
        await fs.writeFile(filePath, JSON.stringify({ mode: "insert_only", items }));
        return jsonResult({
          chat_count: chats.length,
          item_count: items.length,
          public_memory_store_batch_params: { items_file: filePath }
        });
      }

      return jsonResult({
        chat_count: chats.length,
        item_count: items.length,
        items: items.length > 0 ? items : undefined
      });
    }
  };
}

// ── Tool 2: feishu_doc_sync_public_memory ───────────────────

const DocSyncSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["prepare", "commit"],
      description: "prepare=扫描并准备批量数据；commit=写入成功后更新状态"
    },
    page_size:         { type: "number",  description: "每页 Wiki 节点数" },
    max_pages:         { type: "number",  description: "最多翻页数" },
    max_docs:          { type: "number",  description: "本次最多处理文档数" },
    chunk_size:        { type: "number",  description: "每条记忆字符数" },
    max_chunks_per_doc:{ type: "number",  description: "每篇文档最多切分块数" },
    write_items_file:  { type: "boolean", description: "写入临时文件" },
    commit:            { type: "object",  description: "commit 时传入 prepare 返回的 commit_params.commit" }
  },
  required: ["action"],
  additionalProperties: false
};

function createDocSyncTool(api, ctx) {
  return {
    name: "feishu_doc_sync_public_memory",
    label: "Feishu Doc Sync to Memory",
    description: "增量同步飞书 Wiki 和云文档到公共记忆库。两阶段：prepare 准备数据，commit 提交状态。",
    parameters: DocSyncSchema,
    execute: async (_id, params, signal) => {
      const config = resolveConfig(api, ctx);
      const { feishu, docs } = config;

      if (!feishu.appId || !feishu.appSecret) {
        throw new Error("feishu-memory-sync: 请在配置中填写 feishu.appId 和 feishu.appSecret");
      }

      // ── commit 阶段 ───────────────────────────────────────
      if (params.action === "commit") {
        if (!params.commit) throw new Error("commit 阶段需要传入 commit_params.commit");
        const state = await loadState("doc-sync");
        const { synced_tokens } = params.commit;
        if (Array.isArray(synced_tokens)) {
          state.synced_tokens = [...new Set([...(state.synced_tokens ?? []), ...synced_tokens])];
        }
        state.last_commit_time = new Date().toISOString();
        await saveState("doc-sync", state);
        return jsonResult({ committed: true, total_synced: state.synced_tokens?.length ?? 0 });
      }

      // ── prepare 阶段 ──────────────────────────────────────
      const token    = await getTenantToken(feishu);
      const state    = await loadState("doc-sync");
      const synced   = new Set(state.synced_tokens ?? []);

      const pageSize       = params.page_size          ?? 10;
      const maxDocs        = params.max_docs            ?? docs.maxDocsPerRun  ?? 20;
      const chunkSize      = params.chunk_size          ?? docs.chunkSize      ?? 800;
      const maxChunks      = params.max_chunks_per_doc  ?? docs.maxChunksPerDoc ?? 100;
      const module         = docs.module ?? "general";
      const maxPages       = params.max_pages ?? 1;

      const items = [];
      const newlySynced = [];
      let docsProcessed = 0;
      let full_scan_complete = false;
      let wiki_scan_complete = false;

      // 1. 扫描 Wiki 空间
      try {
        const spaces = await feishuPaginateGet(
          feishu.domain, token,
          `/open-apis/wiki/v2/spaces?page_size=${pageSize}`,
          "items", 50, signal
        );
        wiki_scan_complete = true;

        for (const space of spaces) {
          if (docsProcessed >= maxDocs) break;

          // 获取该空间的节点列表
          let pageToken = null;
          let page = 0;
          while (page < maxPages && docsProcessed < maxDocs) {
            const url = `/open-apis/wiki/v2/spaces/${space.space_id}/nodes` +
              `?page_size=${pageSize}` +
              (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
            let data;
            try {
              data = await feishuGet(feishu.domain, token, url, signal);
            } catch { break; }

            for (const node of data.items ?? []) {
              if (docsProcessed >= maxDocs) break;
              const nodeToken = node.node_token;
              const objToken  = node.obj_token;
              const title     = node.title ?? "Untitled";
              const objType   = node.obj_type; // "doc" "docx" "sheet" etc.

              // 跳过已同步
              if (synced.has(nodeToken)) continue;
              // 只处理文档类型
              if (!["doc", "docx"].includes(objType)) continue;

              // 获取文档内容
              let rawContent = "";
              try {
                const docUrl = objType === "docx"
                  ? `/open-apis/docx/v1/documents/${objToken}/raw_content`
                  : `/open-apis/doc/v2/${objToken}/raw_content`;
                const docData = await feishuGet(feishu.domain, token, docUrl, signal);
                rawContent = docData.content ?? "";
              } catch { continue; }

              if (!rawContent.trim()) continue;

              // 切块
              const chunks = chunkText(rawContent, chunkSize).slice(0, maxChunks);
              for (const [i, chunk] of chunks.entries()) {
                items.push({
                  text: `[${space.name ?? space.space_id} / ${title}] ${chunk}`,
                  source: "lark_wiki",
                  source_id: `${nodeToken}:chunk_${i}`,
                  module,
                  category: "wiki"
                });
              }
              newlySynced.push(nodeToken);
              docsProcessed++;
            }

            if (!data.has_more || !data.page_token) { full_scan_complete = true; break; }
            pageToken = data.page_token;
            page++;
          }
        }
      } catch (err) {
        console.warn("[feishu-memory-sync] Wiki 扫描失败:", err.message);
      }

      // 2. 写入临时文件
      let batchParams = null;
      if (params.write_items_file && items.length > 0) {
        const tmpDir = expandHome("~/.openclaw/tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, "doc-sync-items.json");
        await fs.writeFile(filePath, JSON.stringify({ mode: "upsert", items }));
        batchParams = { items_file: filePath };
      }

      return jsonResult({
        docs_seen: docsProcessed,
        item_count: items.length,
        full_scan_complete,
        wiki_scan_complete,
        drive_pending_remaining: 0,
        public_memory_store_batch_params: batchParams,
        commit_params: {
          commit: { synced_tokens: newlySynced }
        },
        items: batchParams ? undefined : items.slice(0, 20)
      });
    }
  };
}

// ── 插件入口 ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: "Feishu Memory Sync",
  description: "飞书群聊 & Wiki 增量同步到公共记忆库（company-memory）。",
  register(api) {
    api.registerTool((ctx) => createGroupSyncTool(api, ctx), { name: "feishu_im_bot_sync_group_messages" });
    api.registerTool((ctx) => createDocSyncTool(api, ctx),   { name: "feishu_doc_sync_public_memory" });
  }
};
