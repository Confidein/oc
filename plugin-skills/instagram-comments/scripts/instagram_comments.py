#!/usr/bin/env python3
"""
Instagram 媒体评论增量抓取
逻辑：
  1. /me/accounts 获取所有 Page 及关联的 instagram_business_account
  2. 每个 IG 账号分页拉取全部 media（含 comments.limit(1){id,timestamp}）
  3. 对比 state 中 last_comment_ts，仅时间变化时拉评论（since 窗口）
  4. 状态持久化到 state.json（last_run_at + media_last_comment_ts）
  5. 新评论数量汇总推送到飞书群（仅总数，不含详情）
  6. 调用 LLM 分析评论并写入 Lark 多维表格
"""

import json
import os
import sys
import time
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent.parent / "_lib"))
sys.path.insert(0, str(SCRIPT_DIR))
from run_logger import RunRecorder
from comment_analyzer import analyze_and_save_comments, count_sentiments

# ── 路径 ──────────────────────────────────────────────────────────────────────
SKILL_DIR   = Path(__file__).resolve().parent.parent
CONFIG_FILE = SKILL_DIR / "assets" / "config.json"
STATE_FILE  = SKILL_DIR / "assets" / "state.json"
OUTPUT_FILE = SKILL_DIR / "assets" / "new_comments_latest.json"

GRAPH_BASE         = "https://graph.facebook.com/v19.0"
COMMENT_PAGE_SIZE  = 50
COMMENT_MAX        = 200
PUSHED_IDS_MAX     = 2000
DEFAULT_POLL_WINDOW_HOURS = 2
DEFAULT_OVERLAP_MINUTES   = 5
DEFAULT_MEDIA_PAGE_SIZE   = 100
DEFAULT_MEDIA_MAX_PAGES   = 100
DEFAULT_FORCE_FULL_SCAN_HOURS = 168
DEFAULT_API_DELAY_MS = 200
MEDIA_FIELDS = (
    "id,caption,timestamp,permalink,comments_count,"
    "comments.limit(1){id,timestamp}"
)
OPENCLAW_CONFIG   = Path.home() / ".openclaw" / "openclaw.json"
LARK_SECRETS      = Path.home() / ".openclaw" / "credentials" / "lark.secrets.json"


# ── 工具 ──────────────────────────────────────────────────────────────────────
def log(msg):
    print(f"[{now_iso()}] {msg}", flush=True)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def api_get(url, params=None, retries=2):
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, params=params or {}, timeout=30)
            data = resp.json()
            if "error" in data:
                err = data["error"]
                raise RuntimeError(
                    f"[{err.get('code')}:{err.get('error_subcode', '')}] {err.get('message')}"
                )
            return data
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_err = e
            if attempt < retries:
                continue
            raise RuntimeError(str(e)) from e


# ── Step 1: 获取所有 IG 商业账号 ───────────────────────────────────────────────
def get_ig_accounts(token, ig_user_id_filter=None):
    data = api_get(f"{GRAPH_BASE}/me/accounts", {
        "fields": "id,name,access_token,instagram_business_account",
        "limit": 100,
        "access_token": token,
    })

    accounts = []
    for page in data.get("data", []):
        ig_id = page.get("instagram_business_account", {}).get("id")
        if not ig_id:
            continue
        if ig_user_id_filter and ig_id != ig_user_id_filter:
            continue
        accounts.append({
            "page_id":      page["id"],
            "page_name":    page["name"],
            "ig_user_id":   ig_id,
            "access_token": page.get("access_token", token),
        })
    return accounts


def get_ig_username(ig_user_id, token):
    try:
        data = api_get(f"{GRAPH_BASE}/{ig_user_id}", {
            "fields": "username",
            "access_token": token,
        })
        return data.get("username") or ""
    except RuntimeError:
        return ""


def poll_settings(config):
    return {
        "poll_window_hours": config.get("poll_window_hours", DEFAULT_POLL_WINDOW_HOURS),
        "overlap_minutes": config.get("overlap_minutes", DEFAULT_OVERLAP_MINUTES),
        "media_page_size": config.get("media_page_size", DEFAULT_MEDIA_PAGE_SIZE),
        "media_max_pages": config.get("media_max_pages", DEFAULT_MEDIA_MAX_PAGES),
        "force_full_comment_scan_hours": config.get(
            "force_full_comment_scan_hours", DEFAULT_FORCE_FULL_SCAN_HOURS
        ),
        "api_delay_ms": config.get("api_delay_ms", DEFAULT_API_DELAY_MS),
    }


def compute_since_unix(state, settings):
    now = datetime.now(timezone.utc)
    overlap = timedelta(minutes=settings["overlap_minutes"])
    window = timedelta(hours=settings["poll_window_hours"])
    last_run = state.get("last_run_at")
    if last_run:
        try:
            dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
            return int((dt - overlap).timestamp())
        except ValueError:
            pass
    return int((now - window).timestamp())


def since_unix_to_cutoff(since_unix):
    return datetime.fromtimestamp(since_unix, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S+0000"
    )


def should_force_full_scan(state, settings):
    last_full = state.get("last_full_scan_at")
    if not last_full:
        return True
    try:
        dt = datetime.fromisoformat(last_full.replace("Z", "+00:00"))
    except ValueError:
        return True
    hours = settings["force_full_comment_scan_hours"]
    return datetime.now(timezone.utc) - dt >= timedelta(hours=hours)


def get_account_media_counts(state, ig_id):
    return state.setdefault("media_counts", {}).setdefault(ig_id, {})


def get_account_media_last_comment_ts(state, ig_id):
    return state.setdefault("media_last_comment_ts", {}).setdefault(ig_id, {})


def parse_iso_ts(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00").replace("+0000", "+00:00"))
    except ValueError:
        return None


def latest_comment_ts(media):
    comments = (media.get("comments") or {}).get("data") or []
    if not comments:
        return ""
    return comments[0].get("timestamp") or ""


def migrate_media_last_comment_ts(state):
    """从旧版 per-account media.last_comment_time 回填时间戳。"""
    store = state.setdefault("media_last_comment_ts", {})
    reserved = {
        "pushed_comment_ids", "media_counts", "media_last_comment_ts",
        "media_last_fetch", "periodic_cursor", "last_run_at", "last_full_scan_at",
        "analyzed_comment_ids",
    }
    for ig_id, val in state.items():
        if ig_id in reserved or not isinstance(val, dict):
            continue
        media_map = val.get("media") or {}
        if not media_map:
            continue
        account_store = store.setdefault(ig_id, {})
        for media_id, info in media_map.items():
            ts = (info or {}).get("last_comment_time")
            if ts and media_id not in account_store:
                account_store[media_id] = ts
    return state


def migrate_state(state):
    """Upgrade legacy state.json to last_run_at / last_full_scan_at."""
    if not state.get("last_run_at"):
        candidates = []
        for key, val in state.items():
            if not isinstance(val, dict):
                continue
            lc = val.get("last_checked")
            if lc:
                candidates.append(lc)

        if candidates:
            state["last_run_at"] = max(candidates)
            state["last_full_scan_at"] = state["last_run_at"]
            log(f"📦 已从旧 state 迁移 last_run_at={state['last_run_at']}")
    return migrate_media_last_comment_ts(state)


# ── Step 2: 分页拉取 IG media（逐页 yield，边拉边处理）────────────────────────
def iterate_media_pages(ig_user_id, token, page_size, max_pages):
    url = f"{GRAPH_BASE}/{ig_user_id}/media"
    params = {
        "fields": MEDIA_FIELDS,
        "limit": page_size,
        "access_token": token,
    }
    pages = 0
    while url and pages < max_pages:
        data = api_get(url, params)
        pages += 1
        yield data.get("data", []), pages
        next_url = data.get("paging", {}).get("next")
        if not next_url:
            break
        url = next_url
        params = {}


def should_fetch_comments(media, prev_ts, latest_ts, prev_count, cutoff_iso=""):
    """用 media 列表里最新评论时间判断是否需要拉评论。"""
    count = int(media.get("comments_count") or 0)
    if not count and not latest_ts:
        return False, None

    if not latest_ts:
        if prev_count is not None and prev_count != count:
            return True, "count_changed"
        return False, None

    if prev_ts is None:
        if prev_count is not None:
            # 迁移：最新评论早于轮询窗口则只记时间戳，避免首轮全量拉评论
            if cutoff_iso and latest_ts <= cutoff_iso:
                return False, "bootstrap"
            return True, "ts_init"
        return False, "bootstrap"

    if latest_ts != prev_ts:
        return True, "ts_changed"
    if prev_count is not None and prev_count != count:
        return True, "count_changed"
    return False, None


# ── Step 3: 拉取单条 media 的评论（支持 since）────────────────────────────────
def get_media_comments(media_id, token, since_unix=None):
    all_comments = []
    url = f"{GRAPH_BASE}/{media_id}/comments"
    params = {
        "fields": "id,text,username,timestamp,user{id,username}",
        "limit": COMMENT_PAGE_SIZE,
        "access_token": token,
    }
    if since_unix:
        params["since"] = since_unix

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
    return comment.get("timestamp", "")


def comment_username(comment):
    username = comment.get("username")
    if username:
        return username
    user = comment.get("user") or {}
    if isinstance(user, dict) and user.get("username"):
        return user["username"]
    from_user = comment.get("from") or {}
    if isinstance(from_user, dict):
        return from_user.get("username") or from_user.get("name") or "unknown"
    return "unknown"


def is_own_account_comment(comment, ig_username, ig_user_id=None):
    """Skip comments posted by the account itself (e.g. replies to users)."""
    user = comment.get("user") or {}
    if ig_user_id and user.get("id") == ig_user_id:
        return True
    if not ig_username:
        return False
    author = comment_username(comment)
    if user.get("username"):
        author = user["username"]
    if not author or author == "unknown":
        return False
    return author.lower() == ig_username.lower()


def format_comment_time(ts):
    if not ts:
        return ""
    return ts[:16].replace("T", " ")


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


def filter_unpushed_comments(comments, state):
    """过滤已推送评论，不修改 state。"""
    pushed = get_pushed_comment_ids(state)
    return [
        c for c in comments
        if c.get("id") and c["id"] not in pushed
    ]


def commit_pushed_comments(comments, state):
    """飞书发送成功后，将评论 ID 写入 state。"""
    if not comments:
        return
    pushed = get_pushed_comment_ids(state)
    for comment in comments:
        comment_id = comment.get("id")
        if comment_id:
            pushed.add(comment_id)
    state["pushed_comment_ids"] = list(pushed)[-PUSHED_IDS_MAX:]
    save_json(STATE_FILE, state)


def send_feishu_alert(chat_id, text):
    api_base, app_id, app_secret = load_feishu_credentials()
    tenant_token = get_feishu_tenant_token(api_base, app_id, app_secret)
    send_feishu_text(chat_id, text, api_base, tenant_token)


def send_comment_count_to_feishu(count, chat_id, sentiment_counts=None):
    api_base, app_id, app_secret = load_feishu_credentials()
    tenant_token = get_feishu_tenant_token(api_base, app_id, app_secret)
    counts = sentiment_counts or {"positive": 0, "neutral": 0, "negative": 0}
    text = (
        f"📬 Instagram new comments: {count} added\n"
        f"🟢 positive: {counts.get('positive', 0)}"
        f"  🔵 neutral: {counts.get('neutral', 0)}"
        f"  🔴 negative: {counts.get('negative', 0)}"
    )
    send_feishu_text(chat_id, text, api_base, tenant_token)
    log(f"  📤 已发送汇总到飞书群：本次新增 {count} 条")
    return 1


# ── 输出单条评论 ──────────────────────────────────────────────────────────────
def push_comment(account_name, media, comment):
    ts      = format_comment_time(comment_ts(comment))
    msg     = comment.get("text", "")[:100]
    sender  = comment_username(comment)
    caption = (media.get("caption") or "")[:40].replace("\n", " ")
    log(f"    💬 @{sender} on 「{caption}」: \"{msg}\" ({ts})")


def _process_media_comments(
    media, reason, account, ig_id, page_name, ig_username, page_token,
    since_unix, cutoff_iso, state, settings, rec, all_new_comments, api_delay_sec,
):
    """拉取并处理单条 media 的评论，返回新增用户评论数。"""
    media_id = media["id"]
    fetch_since = since_unix
    fetch_cutoff = cutoff_iso

    try:
        comments = get_media_comments(media_id, page_token, fetch_since)
    except RuntimeError as e:
        log(f"  ⚠️  media {media_id} 评论拉取失败: {e}")
        rec.add_error(f"media {media_id}: {e}")
        return 0, reason, False

    if api_delay_sec:
        time.sleep(api_delay_sec)

    new_comments = [c for c in comments if comment_ts(c) > fetch_cutoff]
    if not new_comments:
        return 0, reason, True

    new_comments.sort(key=comment_ts)
    user_comments = [
        c for c in new_comments
        if not is_own_account_comment(c, ig_username, ig_id)
    ]
    log(
        f"  🗨  media {media_id} 窗口内 {len(new_comments)} 条"
        f"（用户评论 {len(user_comments)} 条，原因={reason}）"
    )

    skipped_own = len(new_comments) - len(user_comments)
    added = 0
    for comment in user_comments:
        push_comment(page_name, media, comment)
        all_new_comments.append({
            "ig_user_id":  ig_id,
            "page_id":     account["page_id"],
            "page_name":   page_name,
            "ig_username": ig_username,
            "media_id":    media_id,
            "media_url":   media.get("permalink"),
            "caption":     media.get("caption"),
            **comment,
        })
        added += 1

    if skipped_own:
        log(f"  ℹ️  media {media_id} skipped {skipped_own} own-account replies")
    return added, reason, True


def _sync_account(
    account, state, settings, since_unix, cutoff_iso,
    all_new_comments, rec, api_delay_sec,
):
    ig_id      = account["ig_user_id"]
    page_name  = account["page_name"]
    page_token = account["access_token"]

    ig_username = account.get("ig_username") or get_ig_username(ig_id, page_token)
    account["ig_username"] = ig_username
    log(f"\n▶ {page_name} (@{ig_username or 'unknown'}) (IG: {ig_id})")

    media_counts = get_account_media_counts(state, ig_id)
    media_last_comment_ts = get_account_media_last_comment_ts(state, ig_id)
    skipped_unchanged = 0
    skipped_bootstrap = 0
    scanned_comments = 0
    scanned_ts_changed = 0
    scanned_ts_init = 0
    scanned_count_changed = 0
    total_media = 0
    with_comments = 0
    page_count = 0
    account_new = 0

    page_iter = iterate_media_pages(
        ig_id, page_token,
        settings["media_page_size"],
        settings["media_max_pages"],
    )

    for page_media, page_count in page_iter:
        total_media += len(page_media)
        for media in page_media:
            media_id = media["id"]
            count = int(media.get("comments_count") or 0)
            prev_count = media_counts.get(media_id)
            latest_ts = latest_comment_ts(media)
            prev_ts = media_last_comment_ts.get(media_id)
            media_counts[media_id] = count

            if count or latest_ts:
                with_comments += 1

            fetch, reason = should_fetch_comments(
                media, prev_ts, latest_ts, prev_count, cutoff_iso
            )

            if fetch:
                added, reason, ok = _process_media_comments(
                    media, reason, account, ig_id, page_name, ig_username, page_token,
                    since_unix, cutoff_iso, state, settings, rec, all_new_comments,
                    api_delay_sec,
                )
                if ok:
                    scanned_comments += 1
                    account_new += added
                    if reason == "ts_changed":
                        scanned_ts_changed += 1
                    elif reason == "ts_init":
                        scanned_ts_init += 1
                    elif reason == "count_changed":
                        scanned_count_changed += 1
                    if latest_ts:
                        media_last_comment_ts[media_id] = latest_ts
                continue

            if reason == "bootstrap":
                if latest_ts:
                    media_last_comment_ts[media_id] = latest_ts
                skipped_bootstrap += 1
            else:
                skipped_unchanged += 1

    log(
        f"  📸 获取到 {total_media} 条 media（{page_count} 页），"
        f"其中 {with_comments} 条有评论"
    )
    save_json(STATE_FILE, state)
    log(
        f"  ✅ {page_name} 完成：扫描 {scanned_comments} 帖"
        f"（时间变化 {scanned_ts_changed}，初始化 {scanned_ts_init}，"
        f"count兜底 {scanned_count_changed}），"
        f"跳过无变化 {skipped_unchanged} 帖"
        + (f"，首次快照 {skipped_bootstrap} 帖" if skipped_bootstrap else "")
    )
    return account_new


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main():
    rec = RunRecorder(SKILL_DIR, "instagram")
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

    ig_filter = config.get("ig_user_id", "").strip() or None
    state     = migrate_state(load_json(STATE_FILE))
    settings = poll_settings(config)
    force_full = should_force_full_scan(state, settings)
    since_unix = compute_since_unix(state, settings)
    cutoff_iso = since_unix_to_cutoff(since_unix)

    log("🚀 开始同步 Instagram 评论")
    log(
        f"⏱️  评论窗口 since={cutoff_iso}"
        f"（{'周检标记' if force_full else '增量'}，触发=最新评论时间）"
    )

    accounts = get_ig_accounts(token, ig_filter)
    if not accounts:
        log("❌ 未找到关联 Instagram 商业账号的 Page")
        rec.add_error("未找到 IG 商业账号")
        return 1

    rec.accounts_scanned = len(accounts)
    log(f"📋 共找到 {len(accounts)} 个 IG 账号")

    total            = 0
    all_new_comments = []

    api_delay_sec = settings["api_delay_ms"] / 1000.0

    for account in accounts:
        try:
            total += _sync_account(
                account, state, settings, since_unix, cutoff_iso,
                all_new_comments, rec, api_delay_sec,
            )
        except Exception as e:
            log(f"  ❌ {account['page_name']} 处理失败: {e}")
            rec.add_error(f"{account['page_name']}: {e}")

    rec.new_comments = total
    log(f"\n✅ 同步完成，共 {total} 条新评论")

    to_push = []
    analysis_usage = None
    sync_ok = not rec.errors

    if all_new_comments:
        save_json(OUTPUT_FILE, {
            "fetched_at": now_iso(),
            "total":      total,
            "comments":   all_new_comments,
        })
        log(f"📄 详细数据 → {OUTPUT_FILE}")
        to_push = filter_unpushed_comments(all_new_comments, state)

        if config.get("enable_llm_analysis", True):
            try:
                analysis_usage = analyze_and_save_comments(
                    all_new_comments, SKILL_DIR, state, log, STATE_FILE, config
                )
                rec.llm_analyzed = analysis_usage["analyzed"]
                rec.llm_batches = analysis_usage["batches"]
                rec.llm_model = "claude-haiku-4-5"
                rec.llm_input_tokens = analysis_usage["input_tokens"]
                rec.llm_output_tokens = analysis_usage["output_tokens"]
                rec.bitable_written = analysis_usage.get("bitable_written", 0)
            except Exception as e:
                rec.add_error(f"LLM 分析: {e}")
                log(f"⚠️  LLM 分析失败: {e}")
        else:
            log("ℹ️  enable_llm_analysis=false，跳过 LLM 分析")

    chat_id = config.get("feishu_chat_id", "").strip()
    if chat_id:
        try:
            if sync_ok or to_push or total == 0:
                sentiment_counts = {"positive": 0, "neutral": 0, "negative": 0}
                if analysis_usage and analysis_usage.get("rows") and to_push:
                    push_ids = {c["id"] for c in to_push}
                    push_rows = [
                        row for row in analysis_usage["rows"]
                        if row.get("comment_id") in push_ids
                    ]
                    if push_rows:
                        sentiment_counts = count_sentiments(push_rows)
                send_comment_count_to_feishu(len(to_push), chat_id, sentiment_counts)
                commit_pushed_comments(to_push, state)
                rec.pushed_comments = len(to_push)
                rec.feishu_status = "ok"
                log(f"✅ 已推送本次新增 {len(to_push)} 条评论到飞书群")
            else:
                err_summary = "; ".join(rec.errors[:3])
                send_feishu_alert(
                    chat_id,
                    f"⚠️ Instagram sync failed\n{err_summary}",
                )
                rec.feishu_status = "alert"
                log(f"⚠️  已发送失败告警到飞书群")
        except Exception as e:
            rec.feishu_status = "failed"
            rec.add_error(f"飞书推送: {e}")
            log(f"⚠️  飞书推送失败: {e}")
    else:
        log("ℹ️  config.json 未配置 feishu_chat_id，跳过飞书推送")
        rec.feishu_status = "skipped"

    if sync_ok:
        state["last_run_at"] = now_iso()
        if force_full:
            state["last_full_scan_at"] = state["last_run_at"]
        save_json(STATE_FILE, state)
        log(f"💾 已更新 last_run_at={state['last_run_at']}")

    return 0 if sync_ok else 1


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

    log(f"📤 准备发送 {len(comments)} 条评论汇总到飞书群 {chat_id}")
    try:
        send_comment_count_to_feishu(len(comments), chat_id)
        log(f"✅ 已推送本次新增 {len(comments)} 条评论")
    except Exception as e:
        log(f"❌ 飞书推送失败: {e}")
        sys.exit(1)


def analyze_only():
    config = load_json(CONFIG_FILE)
    state = load_json(STATE_FILE)
    payload = load_json(OUTPUT_FILE)
    comments = payload.get("comments", [])
    if not comments:
        log("❌ 没有可分析的评论数据")
        sys.exit(1)

    log(f"🤖 准备分析 {len(comments)} 条评论")
    try:
        usage = analyze_and_save_comments(comments, SKILL_DIR, state, log, STATE_FILE, config)
        log(
            f"✅ 分析完成 {usage['analyzed']} 条，"
            f"token input={usage['input_tokens']} output={usage['output_tokens']}"
        )
    except Exception as e:
        log(f"❌ LLM 分析失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--send-only":
        send_only()
    elif len(sys.argv) > 1 and sys.argv[1] == "--analyze-only":
        analyze_only()
    else:
        main()
