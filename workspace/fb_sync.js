#!/usr/bin/env node
/**
 * Facebook 帖子 + 评论 增量抓取脚本
 *
 * 环境变量：
 *   FB_ACCESS_TOKEN  长期 User Access Token
 *
 * 首次运行：每个 Page 抓取最近 200 条帖子及其评论
 * 后续运行：只抓 since 上次记录时间的新内容
 */

const fs   = require('fs');
const path = require('path');

const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const STATE_FILE   = path.join(__dirname, 'fb_sync_state.json');
const LOG_FILE     = path.join(__dirname, 'fb_sync.log');
const BASE_URL     = 'https://graph.facebook.com/v19.0';

// ─── 工具函数 ────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchJSON(url) {
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`FB API Error ${data.error.code}: ${data.error.message}`);
  return data;
}

// ─── 获取所有 Page ───────────────────────────────────────────────

async function getPages() {
  const data = await fetchJSON(
    `${BASE_URL}/me/accounts?fields=id,name,access_token&limit=100&access_token=${ACCESS_TOKEN}`
  );
  return data.data || [];
}

// ─── 获取帖子（支持增量 since） ──────────────────────────────────

async function fetchPosts(pageId, pageToken, since, isFirstRun) {
  const limit = isFirstRun ? 200 : 100;
  const sinceParam = since ? `&since=${since}` : '';

  let url = `${BASE_URL}/${pageId}/posts`
    + `?fields=id,message,story,created_time,permalink_url`
    + `&limit=${limit}`
    + sinceParam
    + `&access_token=${pageToken}`;

  const posts = [];

  while (url) {
    const data = await fetchJSON(url);
    posts.push(...(data.data || []));

    // 首次抓取不分页（已有 limit=200），增量只取第一页
    url = (!isFirstRun || posts.length >= limit) ? null : (data.paging?.next || null);
  }

  return posts;
}

// ─── 获取帖子的所有评论（分页） ──────────────────────────────────

async function fetchComments(postId, pageToken, since) {
  const sinceParam = since ? `&since=${since}` : '';

  let url = `${BASE_URL}/${postId}/comments`
    + `?fields=id,message,from,created_time,like_count,comment_count`
    + `&limit=100`
    + sinceParam
    + `&access_token=${pageToken}`;

  const comments = [];

  while (url) {
    const data = await fetchJSON(url);
    comments.push(...(data.data || []));
    url = data.paging?.next || null;
  }

  return comments;
}

// ─── 处理单条数据（可替换为你自己的推送逻辑） ───────────────────

function handlePost(page, post) {
  log(`  📝 Post [${post.id}] ${(post.message || post.story || '').substring(0, 60)}`);
  // TODO: 写入数据库 / 推送到队列
}

function handleComment(page, post, comment) {
  log(`    💬 Comment [${comment.id}] ${comment.message?.substring(0, 60)}`);
  // TODO: 写入数据库 / 推送到队列
}

// ─── 主流程 ─────────────────────────────────────────────────────

async function main() {
  if (!ACCESS_TOKEN) {
    log('❌ 未设置 FB_ACCESS_TOKEN 环境变量');
    process.exit(1);
  }

  const state      = loadState();
  const isFirstRun = Object.keys(state).length === 0;

  log(`🚀 开始同步 (${isFirstRun ? '首次全量 200 条' : '增量更新'})`);

  const pages = await getPages();
  log(`📋 共找到 ${pages.length} 个 Page`);

  for (const page of pages) {
    log(`\n▶ Page: ${page.name} (${page.id})`);

    const pageState = state[page.id] || {};
    const since     = pageState.lastPostTime || null;

    // ── 抓帖子 ──
    let posts;
    try {
      posts = await fetchPosts(page.id, page.access_token, since, isFirstRun);
    } catch (err) {
      log(`  ⚠️  抓帖子失败: ${err.message}`);
      continue;
    }

    log(`  获取到 ${posts.length} 条帖子`);

    let latestPostTime = since ? Number(since) : 0;

    for (const post of posts) {
      const postTime = Math.floor(new Date(post.created_time).getTime() / 1000);
      if (postTime > latestPostTime) latestPostTime = postTime;

      handlePost(page, post);

      // ── 抓评论 ──
      const commentSince = pageState.lastCommentTime?.[post.id] || null;
      let comments;
      try {
        comments = await fetchComments(post.id, page.access_token, commentSince);
      } catch (err) {
        log(`    ⚠️  抓评论失败 (${post.id}): ${err.message}`);
        continue;
      }

      log(`    获取到 ${comments.length} 条评论`);

      let latestCommentTime = commentSince ? Number(commentSince) : 0;
      for (const comment of comments) {
        const ct = Math.floor(new Date(comment.created_time).getTime() / 1000);
        if (ct > latestCommentTime) latestCommentTime = ct;
        handleComment(page, post, comment);
      }

      // 记录该帖子评论最新时间
      if (!pageState.lastCommentTime) pageState.lastCommentTime = {};
      if (latestCommentTime > 0) pageState.lastCommentTime[post.id] = latestCommentTime;
    }

    // 记录该 Page 帖子最新时间
    if (latestPostTime > 0) pageState.lastPostTime = latestPostTime;
    state[page.id] = pageState;

    // 每个 Page 处理完立即保存，防止中途崩溃丢失进度
    saveState(state);
    log(`  ✅ Page ${page.name} 同步完成，状态已保存`);
  }

  log(`\n✅ 全部同步完成`);
}

main().catch(err => {
  log(`❌ 同步异常: ${err.message}`);
  process.exit(1);
});
