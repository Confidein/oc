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

// ── 文本提取（群消息）────────────────────────────────────────

function extractMessageText(msg) {
  try {
    if (msg.msg_type === "text") {
      return JSON.parse(msg.body?.content ?? "{}").text ?? "";
    }
    if (msg.msg_type === "post") {
      const post = JSON.parse(msg.body?.content ?? "{}");
      const content = post.zh_cn?.content ?? post.en_us?.content ?? [];
      return content.flat().filter(e => e.tag === "text").map(e => e.text).join(" ");
    }
  } catch {}
  return "";
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

          const text = extractMessageText(msg).trim();
          if (text.length < minLen) continue;

          const msgTs = parseInt(msg.create_time ?? "0");
          if (msgTs <= (chatState.last_message_time ?? 0)) continue; // 去重

          items.push({
            text: `[${chatName}] ${text}`,
            source: "lark_group",
            source_id: msg.message_id,
            module,
            category: "chat",
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
