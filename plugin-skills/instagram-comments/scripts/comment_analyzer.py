#!/usr/bin/env python3
"""Analyze Instagram comments with Claude Haiku and persist structured results."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

from bitable_writer import write_analysis_rows

AUTH_PROFILES = Path.home() / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"
ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5"
BATCH_SIZE = 10
MAX_TOKENS = 4096
ANALYZED_IDS_MAX = 2000
DEFAULT_SENTIMENT_RULES = "assets/sentiment_rules.json"

SENTIMENT_ALIASES = {
    "positive": "positive",
    "neutral": "neutral",
    "negative": "negative",
    "正向": "positive",
    "中性": "neutral",
    "负向": "negative",
}

LANGUAGE_ALIASES = {
    "english": "English",
    "spanish": "Spanish",
    "portuguese": "Portuguese",
    "french": "French",
    "german": "German",
    "italian": "Italian",
    "英语": "English",
    "西班牙语": "Spanish",
    "葡萄牙语": "Portuguese",
    "法语": "French",
    "德语": "German",
    "意大利语": "Italian",
}

_OUTPUT_FORMAT = """Output ONLY a JSON array, no markdown or extra text:
[
  {
    "comment_id": "original comment_id",
    "language": "English",
    "project_type": "Glorify or NFC",
    "sentiment": "positive/neutral/negative",
    "recommended_reply": "reply in comment language, or empty string for neutral"
  }
]"""


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_sentiment_rules_path(skill_dir, skill_config=None):
    skill_config = skill_config or {}
    rel = skill_config.get("sentiment_rules", DEFAULT_SENTIMENT_RULES)
    path = Path(rel)
    if not path.is_absolute():
        path = skill_dir / rel
    return path


def load_sentiment_rules(skill_dir, skill_config=None):
    path = resolve_sentiment_rules_path(skill_dir, skill_config)
    rules = load_json(path)
    if not rules:
        raise RuntimeError(f"情感规则文件为空或不存在: {path}")
    return rules, path


def _render_category_block(label, block):
    lines = [f"--- {label.upper()} ---", block.get("core", "")]
    if block.get("match_any"):
        lines.append("Match ANY of the following categories:")
    for cat in block.get("categories", []):
        lines.append(f"\n[{cat.get('name', 'Category')}]")
        if cat.get("note"):
            lines.append(cat["note"])
        for signal in cat.get("signals", []):
            lines.append(f"- {signal}")
    for example in block.get("examples", []):
        lines.append(f"Example: {example}")
    return "\n".join(lines)


def render_sentiment_rules_prompt(rules):
    parts = [
        "=== COMMENT SENTIMENT RULES (positive / neutral / negative) ===",
        "",
    ]

    priority = rules.get("priority", {})
    if priority:
        parts.append("PRIORITY (apply first):")
        if priority.get("order"):
            parts.append(f"- {priority['order']}")
        if priority.get("note"):
            parts.append(f"- {priority['note']}")
        if priority.get("example"):
            parts.append(f"- Example: {priority['example']}")
        parts.append("")

    for key, label in (("positive", "Positive"), ("negative", "Negative"), ("neutral", "Neutral")):
        if rules.get(key):
            parts.append(_render_category_block(label, rules[key]))
            parts.append("")

    faith_priority = rules.get("faith_with_product_priority", [])
    if faith_priority:
        parts.append("FAITH + PRODUCT COMBINED (product opinion wins):")
        for item in faith_priority:
            parts.append(f"- {item}")
        parts.append("")

    return "\n".join(parts).strip()


def build_system_prompt(rules):
    project_lines = ["project_type must be exactly one of:"]
    for pt in rules.get("project_types", []):
        project_lines.append(f"- {pt['id']}: {pt['description']}")

    output_notes = rules.get("output_notes", {})
    reply_note = output_notes.get(
        "recommended_reply",
        "Required for positive/negative only; empty string for neutral",
    )
    lang_note = output_notes.get(
        "language",
        "Primary language in English (e.g. English, Spanish, Portuguese)",
    )

    return f"""You analyze Instagram comments for a Christian faith-based company. Return structured JSON for each comment.

General output rules:
- language and project_type values MUST be in English only.
- Do NOT rewrite or translate the original comment text; you only analyze it.

{chr(10).join(project_lines)}

{render_sentiment_rules_prompt(rules)}

language: {lang_note}

recommended_reply:
- {reply_note}

{_OUTPUT_FORMAT}"""


def phrase_to_regex(phrase):
    return r"\s+".join(re.escape(part) for part in phrase.split())


def compile_pure_faith_patterns(rules):
    phrases = rules.get("pure_faith_phrases") or []
    return tuple(phrase_to_regex(p) for p in phrases if p.strip())


def load_anthropic_api_key():
    profiles = load_json(AUTH_PROFILES)
    profile = profiles.get("profiles", {}).get("anthropic:default", {})
    key = profile.get("key", "").strip()
    if not key:
        raise RuntimeError("未找到 anthropic:default API key")
    return key


def get_analyzed_comment_ids(state):
    ids = state.get("analyzed_comment_ids", [])
    return set(ids) if isinstance(ids, list) else set()


def filter_unanalyzed_comments(comments, state):
    analyzed = get_analyzed_comment_ids(state)
    return [
        comment for comment in comments
        if comment.get("id") and comment.get("id") not in analyzed
    ]


def mark_comments_analyzed(comment_ids, state):
    analyzed = get_analyzed_comment_ids(state)
    for comment_id in comment_ids:
        analyzed.add(comment_id)
    state["analyzed_comment_ids"] = list(analyzed)[-ANALYZED_IDS_MAX:]


def build_user_prompt(comments, rules):
    payload = []
    for comment in comments:
        payload.append({
            "comment_id": comment.get("id"),
            "account": comment.get("page_name"),
            "username": comment.get("username") or comment_username(comment),
            "text": comment.get("text") or "",
            "timestamp": comment.get("timestamp") or "",
            "caption": (comment.get("caption") or "")[:200],
            "media_url": comment.get("media_url") or "",
        })
    priority = rules.get("priority", {}).get("order", "negative > positive > neutral")
    return (
        "Analyze the following Instagram comments using the sentiment rules. "
        f"Apply priority: {priority}. "
        "Pure faith expressions alone (Amen, Praise God, etc.) are neutral. "
        "Return language, project_type, sentiment, and recommended_reply for each. "
        "Reply only for positive/negative in the comment's language; use empty string for neutral.\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )


def format_comment_time(ts):
    if not ts:
        return ""
    return ts[:19].replace("T", " ")


def comment_username(comment):
    username = comment.get("username")
    if username:
        return username
    from_user = comment.get("from") or {}
    if isinstance(from_user, dict):
        return from_user.get("username") or from_user.get("name") or "unknown"
    return "unknown"


def parse_llm_json(text):
    text = (text or "").strip()
    if not text:
        raise RuntimeError("LLM 返回为空")

    fenced = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    if fenced:
        text = fenced.group(1)

    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise RuntimeError(f"LLM 返回不是 JSON 数组: {text[:300]}")

    return json.loads(text[start : end + 1])


def call_anthropic(api_key, user_prompt, system_prompt):
    resp = requests.post(
        ANTHROPIC_API,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        },
        timeout=120,
    )
    data = resp.json()
    if resp.status_code != 200:
        raise RuntimeError(data.get("error", {}).get("message") or resp.text[:300])

    content = data.get("content", [])
    text = "".join(
        block.get("text", "")
        for block in content
        if block.get("type") == "text"
    )
    usage = data.get("usage", {})
    return parse_llm_json(text), {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
    }


def normalize_sentiment(value):
    key = (value or "").strip().lower()
    return SENTIMENT_ALIASES.get(key, SENTIMENT_ALIASES.get(value, "neutral"))


def normalize_language(value):
    key = (value or "").strip().lower()
    if key in LANGUAGE_ALIASES:
        return LANGUAGE_ALIASES[key]
    raw = (value or "").strip()
    if raw and not any("\u4e00" <= ch <= "\u9fff" for ch in raw):
        return raw[:1].upper() + raw[1:] if raw else "Unknown"
    return "Unknown"


def _tail_is_only_emojis_punctuation(tail):
    if not tail:
        return True
    return not any(ch.isalnum() for ch in tail)


def is_pure_faith_response(text, faith_patterns=()):
    """Faith-only comment with no product opinion — force neutral."""
    t = (text or "").strip()
    if not t:
        return False
    if not any(ch.isalnum() for ch in t):
        return True
    for phrase in faith_patterns:
        match = re.match(rf"^({phrase})(.*)$", t, re.IGNORECASE)
        if match:
            tail = (match.group(2) or "").strip()
            if _tail_is_only_emojis_punctuation(tail):
                return True
            remainder = re.sub(
                rf"\b{phrase}\b|[\s,!.y]+",
                "",
                tail,
                flags=re.IGNORECASE,
            )
            if not remainder or not any(ch.isalnum() for ch in remainder):
                return True
    return False


def is_amen_comment(text, faith_patterns=()):
    """Backward-compatible alias."""
    return is_pure_faith_response(text, faith_patterns)


def normalize_project_type(value):
    key = (value or "").strip().lower()
    if key == "nfc":
        return "NFC"
    return "Glorify"


def merge_analysis(comments, llm_rows, faith_patterns=()):
    by_id = {row.get("comment_id"): row for row in llm_rows if row.get("comment_id")}
    merged = []
    for comment in comments:
        row = by_id.get(comment.get("id"), {})
        raw_ts = comment.get("timestamp") or ""
        sentiment = normalize_sentiment(row.get("sentiment"))
        if is_pure_faith_response(comment.get("text"), faith_patterns):
            sentiment = "neutral"
        reply = (row.get("recommended_reply") or "").strip()
        if sentiment == "neutral":
            reply = ""
        merged.append({
            "comment_id": comment.get("id"),
            "page_name": comment.get("page_name"),
            "ig_username": comment.get("ig_username") or "",
            "username": comment_username(comment),
            "text": comment.get("text") or "",
            "timestamp": raw_ts,
            "comment_time": format_comment_time(raw_ts),
            "media_url": comment.get("media_url") or "",
            "caption": comment.get("caption") or "",
            "language": normalize_language(row.get("language")),
            "project_type": normalize_project_type(row.get("project_type")),
            "sentiment": sentiment,
            "recommended_reply": reply,
        })
    return merged


def count_sentiments(rows):
    counts = {"positive": 0, "neutral": 0, "negative": 0}
    for row in rows:
        sentiment = row.get("sentiment", "neutral")
        if sentiment in counts:
            counts[sentiment] += 1
    return counts


def append_token_usage(skill_dir, record):
    path = skill_dir / "assets" / "analyses" / "token_usage.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def analyze_and_save_comments(comments, skill_dir, state, log_fn, state_file, skill_config=None):
    pending = filter_unanalyzed_comments(comments, state)
    if not pending:
        log_fn("ℹ️  新评论均已分析过，跳过 LLM 分析")
        return {
            "analyzed": 0,
            "batches": 0,
            "rows": [],
            "sentiment_counts": {"positive": 0, "neutral": 0, "negative": 0},
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        }

    skill_config = skill_config or {}
    rules, rules_path = load_sentiment_rules(skill_dir, skill_config)
    system_prompt = build_system_prompt(rules)
    faith_patterns = compile_pure_faith_patterns(rules)
    log_fn(f"📋 情感规则: {rules_path.name} (v{rules.get('version', '?')})")

    api_key = load_anthropic_api_key()

    all_rows = []
    bitable_written = 0
    total_input = 0
    total_output = 0
    batches = []

    batch_total = (len(pending) + BATCH_SIZE - 1) // BATCH_SIZE
    for batch_index, start in enumerate(range(0, len(pending), BATCH_SIZE), start=1):
        batch = pending[start : start + BATCH_SIZE]
        log_fn(f"🤖 LLM 分析第 {batch_index}/{batch_total} 批（{len(batch)} 条评论）")
        llm_rows, usage = call_anthropic(
            api_key,
            build_user_prompt(batch, rules),
            system_prompt,
        )
        merged = merge_analysis(batch, llm_rows, faith_patterns)
        write_analysis_rows(merged, skill_config, log_fn)
        bitable_written += len(merged)
        mark_comments_analyzed([item["comment_id"] for item in merged], state)
        save_json(state_file, state)
        all_rows.extend(merged)

        input_tokens = usage["input_tokens"]
        output_tokens = usage["output_tokens"]
        total_input += input_tokens
        total_output += output_tokens

        batch_record = {
            "timestamp": now_iso(),
            "model": MODEL,
            "batch_index": batch_index,
            "batch_total": batch_total,
            "comments": len(batch),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }
        batches.append(batch_record)
        append_token_usage(skill_dir, batch_record)
        log_fn(
            f"  ✅ 第 {batch_index} 批完成，token: "
            f"input={input_tokens} output={output_tokens}"
        )

    log_fn(
        f"📝 Analysis saved to Lark Bitable ({bitable_written} rows), "
        f"token total={total_input + total_output}"
    )
    return {
        "analyzed": len(all_rows),
        "batches": len(batches),
        "bitable_written": bitable_written,
        "rows": all_rows,
        "sentiment_counts": count_sentiments(all_rows),
        "input_tokens": total_input,
        "output_tokens": total_output,
        "total_tokens": total_input + total_output,
    }
