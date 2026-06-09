#!/usr/bin/env python3
"""
Facebook Page 帖子评论增量抓取
逻辑：
  1. /me/accounts 获取所有 Page 及 Page Access Token
  2. 每个 Page 拉最近 POST_LIMIT 条 published_posts
  3. 每条帖子拉评论，按时间过滤增量
  4. 状态持久化到 state.json（按 page_id 记录）
  5. 新评论按「账号-用户名-评论-时间-帖子地址」格式推送到飞书群
"""

import json
import os
import sys
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "_lib"))
from run_logger import RunRecorder

SKILL_DIR   = Path(__file__).resolve().parent.parent
CONFIG_FILE = SKILL_DIR / "assets" / "config.json"
STATE_FILE  = SKILL_DIR / "assets" / "state.json"
OUTPUT_FILE = SKILL_DIR / "assets" / "new_comments_latest.json"

GRAPH_BASE         = "https://graph.facebook.com/v19.0"
POST_LIMIT         = 20
COMMENT_PAGE_SIZE  = 50
COMMENT_MAX        = 200
FIRST_RUN_HOURS    = 24
FEISHU_BATCH_CHARS = 3500
PUSHED_IDS_MAX     = 2000
OPENCLAW_CONFIG    = Path.home() / ".openclaw" / "openclaw.json"
LARK_SECRETS       = Path.home() / ".openclaw" / "credentials" / "lark.secrets.json"


def log(msg):
    print(f"[{now_iso()}] {msg}", flush=True)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_offset(hours):
    return (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).strftime("%Y-%m-%dT%H:%M:%S+0000")


def load_json(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def api_get(url, params=None):
    resp = requests.get(url, params=params or {}, timeout=15)
    data = resp.json()
    if "error" in data:
        err = data["error"]
        raise RuntimeError(
            f"[{err.get('code')}:{err.get('error_subcode', '')}] {err.get('message')}"
        )
    return data


def get_pages(token, page_id_filter=None):
    data = api_get(f"{GRAPH_BASE}/me/accounts", {
        "fields": "id,name,access_token",
        "limit": 100,
        "access_token": token,
    })

    pages = []
    for page in data.get("data", []):
        page_id = page.get("id")
        if not page_id:
            continue
        if page_id_filter and page_id != page_id_filter:
            continue
        pages.append({
            "page_id":      page_id,
            "page_name":    page.get("name", page_id),
            "access_token": page.get("access_token", token),
        })
    return pages


def get_published_posts(page_id, token):
    params = {
        "fields": "id,message,created_time,permalink_url,comments.limit(0).summary(true)",
        "limit":  POST_LIMIT,
        "access_token": token,
    }
    data = api_get(f"{GRAPH_BASE}/{page_id}/published_posts", params)
    return data.get("data", [])


def post_comment_count(post):
    summary = (post.get("comments") or {}).get("summary") or {}
    return int(summary.get("total_count") or 0)


def get_post_comments(post_id, token):
    all_comments = []
    url = f"{GRAPH_BASE}/{post_id}/comments"
    params = {
        "fields":       "id,message,from,created_time",
        "filter":       "stream",
        "order":        "reverse_chronological",
        "limit":        COMMENT_PAGE_SIZE,
        "access_token": token,
    }

    while url and len(all_comments) < COMMENT_MAX:
        data = api_get(url, params)
        batch = data.get("data", [])
        all_comments.extend(batch)
        if len(all_comments) >= COMMENT_MAX:
            break
        url = data.get("paging", {}).get("next")
        params = {}

    return all_comments[:COMMENT_MAX]


def comment_ts(comment):
    return comment.get("created_time", "")


def comment_username(comment):
    from_user = comment.get("from") or {}
    if isinstance(from_user, dict):
        return from_user.get("name") or from_user.get("username") or "unknown"
    return "unknown"


def comment_text(comment):
    return (comment.get("message") or comment.get("text") or "").strip()


def format_comment_time(ts):
    if not ts:
        return ""
    return ts[:16].replace("T", " ")


def format_comment_line(item):
    account   = (item.get("page_name") or "unknown").replace("\n", " ")
    username  = comment_username(item).replace("\n", " ")
    text      = comment_text(item).replace("\n", " ").strip()
    ts        = format_comment_time(item.get("created_time", ""))
    post_url  = (item.get("post_url") or "").replace("\n", " ").strip()
    return f"{account}-{username}-{text}-{ts}-{post_url}"


def chunk_lines(lines, max_chars=FEISHU_BATCH_CHARS):
    batches, current, size = [], [], 0
    for line in lines:
        extra = len(line) + (1 if current else 0)
        if current and size + extra > max_chars:
            batches.append("\n".join(current))
            current, size = [line], len(line)
        else:
            current.append(line)
            size += extra
    if current:
        batches.append("\n".join(current))
    return batches


def load_feishu_credentials():
    cfg = load_json(OPENCLAW_CONFIG)
    feishu = cfg.get("channels", {}).get("feishu", {})
    app_id = feishu.get("appId") or os.environ.get("LARK_APP_ID")
    app_secret = os.environ.get("LARK_APP_SECRET")

    secret_ref = feishu.get("appSecret") or {}
    if not app_secret and secret_ref.get("source") == "file":
        provider = cfg.get("secrets", {}).get("providers", {}).get(secret_ref.get("provider"), {})
        secret_path = Path(provider.get("path", str(LARK_SECRETS)).replace("~", str(Path.home())))
        secret_doc = load_json(secret_path)
        for key in (secret_ref.get("id") or "").strip("/").split("/"):
            if key:
                secret_doc = secret_doc.get(key, {}) if isinstance(secret_doc, dict) else {}
        if isinstance(secret_doc, str):
            app_secret = secret_doc

    domain = feishu.get("domain", "feishu")
    api_base = (
        "https://open.larksuite.com"
        if domain == "lark"
        else "https://open.feishu.cn"
    )
    if not app_id or not app_secret:
        raise RuntimeError("飞书 appId/appSecret 未配置")
    return api_base, app_id, app_secret


def get_feishu_tenant_token(api_base, app_id, app_secret):
    resp = requests.post(
        f"{api_base}/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=15,
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"获取 tenant_token 失败: {data.get('msg')}")
    return data["tenant_access_token"]


def send_feishu_text(chat_id, text, api_base, tenant_token):
    resp = requests.post(
        f"{api_base}/open-apis/im/v1/messages",
        params={"receive_id_type": "chat_id"},
        headers={"Authorization": f"Bearer {tenant_token}"},
        json={
            "receive_id": chat_id,
            "msg_type":   "text",
            "content":    json.dumps({"text": text}, ensure_ascii=False),
        },
        timeout=15,
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"飞书发送失败: {data.get('msg')}")
    return data


def get_pushed_comment_ids(state):
    ids = state.get("pushed_comment_ids", [])
    return set(ids) if isinstance(ids, list) else set()


def reserve_unpushed_comments(comments, state):
    pushed = get_pushed_comment_ids(state)
    to_push = []
    for comment in comments:
        comment_id = comment.get("id")
        if not comment_id or comment_id in pushed:
            continue
        pushed.add(comment_id)
        to_push.append(comment)

    if to_push:
        state["pushed_comment_ids"] = list(pushed)[-PUSHED_IDS_MAX:]
        save_json(STATE_FILE, state)
    return to_push


def send_comments_to_feishu(comments, chat_id):
    if not comments:
        return 0

    lines = [format_comment_line(item) for item in comments]
    api_base, app_id, app_secret = load_feishu_credentials()
    tenant_token = get_feishu_tenant_token(api_base, app_id, app_secret)

    sent = 0
    batches = chunk_lines(lines)
    for idx, batch in enumerate(batches, start=1):
        header = f"📘 Facebook 新评论 ({len(comments)} 条)"
        if len(batches) > 1:
            header += f" [{idx}/{len(batches)}]"
        send_feishu_text(chat_id, f"{header}\n{batch}", api_base, tenant_token)
        sent += 1
        log(f"  📤 已发送第 {idx} 批到飞书群")
    return sent


def push_comment(page_name, post, comment):
    ts      = format_comment_time(comment_ts(comment))
    msg     = comment_text(comment)[:100]
    sender  = comment_username(comment)
    preview = (post.get("message") or "")[:40].replace("\n", " ")
    log(f"    💬 {sender} on 「{preview}」: \"{msg}\" ({ts})")


def main():
    rec = RunRecorder(SKILL_DIR, "facebook")
    code = 0
    try:
        code = _sync(rec)
    except Exception as e:
        rec.add_error(str(e))
        log(f"❌ 未捕获异常: {e}")
        code = 1
    finally:
        rec.finish(code)
    sys.exit(code)


def _sync(rec):
    config = load_json(CONFIG_FILE)
    token  = config.get("access_token", "").strip()
    if not token:
        log("❌ config.json 中 access_token 为空")
        rec.add_error("access_token 为空")
        return 1

    page_filter = config.get("page_id", "").strip() or None
    state       = load_json(STATE_FILE)

    log("🚀 开始同步 Facebook Page 评论")

    pages = get_pages(token, page_filter)
    if not pages:
        log("❌ 未找到可管理的 Facebook Page")
        rec.add_error("未找到 Facebook Page")
        return 1

    rec.accounts_scanned = len(pages)
    log(f"📋 共找到 {len(pages)} 个 Page")

    total            = 0
    all_new_comments = []

    for page in pages:
        page_id    = page["page_id"]
        page_name  = page["page_name"]
        page_token = page["access_token"]

        log(f"\n▶ {page_name} (Page: {page_id})")

        account_state     = state.get(page_id, {})
        posts_state       = account_state.get("posts", {})
        is_first_for_page = page_id not in state
        first_run_cutoff  = ts_offset(FIRST_RUN_HOURS)

        try:
            post_list = get_published_posts(page_id, page_token)
        except RuntimeError as e:
            log(f"  ⚠️  获取 published_posts 失败: {e}")
            rec.add_error(f"{page_name} posts: {e}")
            continue

        log(f"  📄 获取到 {len(post_list)} 条帖子")

        for post in post_list:
            post_id = post["id"]
            summary_count = post_comment_count(post)
            if summary_count <= 0:
                continue

            last_comment_time = posts_state.get(post_id, {}).get("last_comment_time")
            if last_comment_time:
                cutoff = last_comment_time
            elif is_first_for_page:
                cutoff = first_run_cutoff
            else:
                cutoff = account_state.get("last_checked", first_run_cutoff)

            try:
                comments = get_post_comments(post_id, page_token)
            except RuntimeError as e:
                log(f"  ⚠️  post {post_id} 评论拉取失败: {e}")
                rec.add_error(f"post {post_id}: {e}")
                continue

            if summary_count > 0 and not comments:
                log(f"  ℹ️  post {post_id} 显示 {summary_count} 条评论，但 API 未返回内容（可能为 IG 交叉发布评论或权限不足）")
                continue

            new_comments = [
                c for c in comments
                if comment_ts(c) > cutoff
            ]
            if not new_comments:
                continue

            new_comments.sort(key=comment_ts)
            log(f"  🗨  post {post_id} 有 {len(new_comments)} 条新评论")

            latest_comment_time = last_comment_time
            for comment in new_comments:
                ct = comment_ts(comment)
                if not latest_comment_time or ct > latest_comment_time:
                    latest_comment_time = ct

                push_comment(page_name, post, comment)
                all_new_comments.append({
                    "page_id":   page_id,
                    "page_name": page_name,
                    "post_id":   post_id,
                    "post_url":  post.get("permalink_url"),
                    "message":   post.get("message"),
                    "text":      comment_text(comment),
                    **comment,
                })
                total += 1

            if post_id not in posts_state:
                posts_state[post_id] = {}
            if latest_comment_time:
                posts_state[post_id]["last_comment_time"] = latest_comment_time

        state[page_id] = {
            "page_name":    page_name,
            "last_checked": now_iso(),
            "posts":        posts_state,
        }
        save_json(STATE_FILE, state)
        log(f"  ✅ {page_name} 完成，状态已保存")

    rec.new_comments = total
    log(f"\n✅ 同步完成，共 {total} 条新评论")

    if all_new_comments:
        save_json(OUTPUT_FILE, {
            "fetched_at": now_iso(),
            "total":      total,
            "comments":   all_new_comments,
        })
        log(f"📄 详细数据 → {OUTPUT_FILE}")

        chat_id = config.get("feishu_chat_id", "").strip()
        if chat_id:
            try:
                to_push = reserve_unpushed_comments(all_new_comments, state)
                if not to_push:
                    log("ℹ️  新评论均已推送过，跳过飞书发送")
                    rec.feishu_status = "skipped"
                else:
                    batches = send_comments_to_feishu(to_push, chat_id)
                    rec.pushed_comments = len(to_push)
                    rec.feishu_status = "ok"
                    log(f"✅ 已推送 {len(to_push)} 条评论到飞书群（{batches} 条消息）")
            except Exception as e:
                rec.feishu_status = "failed"
                rec.add_error(f"飞书推送: {e}")
                log(f"⚠️  飞书推送失败: {e}")
        else:
            log("ℹ️  config.json 未配置 feishu_chat_id，跳过飞书推送")
            rec.feishu_status = "skipped"

    return 0


def send_only():
    config = load_json(CONFIG_FILE)
    chat_id = config.get("feishu_chat_id", "").strip()
    if not chat_id:
        log("❌ config.json 未配置 feishu_chat_id")
        sys.exit(1)

    payload = load_json(OUTPUT_FILE)
    comments = payload.get("comments", [])
    if not comments:
        log("❌ 没有可发送的评论数据")
        sys.exit(1)

    log(f"📤 准备发送 {len(comments)} 条评论到飞书群 {chat_id}")
    try:
        batches = send_comments_to_feishu(comments, chat_id)
        log(f"✅ 已推送 {len(comments)} 条评论（{batches} 条消息）")
    except Exception as e:
        log(f"❌ 飞书推送失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--send-only":
        send_only()
    else:
        main()
