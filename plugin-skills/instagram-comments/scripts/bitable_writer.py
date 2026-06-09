#!/usr/bin/env python3
"""Write Instagram comment analysis rows to Lark Bitable."""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests

OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"
LARK_SECRETS = Path.home() / ".openclaw" / "credentials" / "lark.secrets.json"

DEFAULT_WIKI_TOKEN = "SMC1w2k1ciYvagk9iceuwroEtCA"
DEFAULT_TABLE_ID = "tblQQsesKEACgERy"
BATCH_CREATE_LIMIT = 100


def load_json(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def load_lark_credentials():
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
        raise RuntimeError("Lark appId/appSecret not configured")
    return api_base, app_id, app_secret


def get_tenant_token(api_base, app_id, app_secret):
    resp = requests.post(
        f"{api_base}/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=15,
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"Failed to get tenant_token: {data.get('msg')}")
    return data["tenant_access_token"]


def resolve_app_token(api_base, tenant_token, wiki_token):
    resp = requests.get(
        f"{api_base}/open-apis/wiki/v2/spaces/get_node",
        headers={"Authorization": f"Bearer {tenant_token}"},
        params={"token": wiki_token},
        timeout=15,
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"Failed to resolve wiki node: {data.get('msg')}")

    node = data.get("data", {}).get("node", {})
    app_token = node.get("obj_token") or node.get("token")
    if not app_token:
        raise RuntimeError("Wiki node does not contain bitable app_token")
    return app_token


def format_bitable_time(ts):
    if not ts:
        return ""
    return ts[:16].replace("T", " ")


def row_to_fields(item):
    account_name = item.get("ig_username") or item.get("page_name") or "Unknown"
    return {
        "Time": format_bitable_time(item.get("comment_time") or item.get("timestamp") or ""),
        "Source": f"Instagram-{account_name}",
        "Level": item.get("sentiment") or "neutral",
        "Language": item.get("language") or "Unknown",
        "Type": item.get("project_type") or "Glorify",
        "Questions&Comments": item.get("text") or "",
        "Recommened Reply": item.get("recommended_reply") or "",
        "url": item.get("media_url") or "",
    }


def batch_create_records(api_base, tenant_token, app_token, table_id, rows):
    created = 0
    headers = {
        "Authorization": f"Bearer {tenant_token}",
        "Content-Type": "application/json",
    }
    for start in range(0, len(rows), BATCH_CREATE_LIMIT):
        chunk = rows[start : start + BATCH_CREATE_LIMIT]
        payload = {"records": [{"fields": row_to_fields(item)} for item in chunk]}
        resp = requests.post(
            f"{api_base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create",
            headers=headers,
            json=payload,
            timeout=30,
        )
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"Bitable batch_create failed: {data.get('msg')}")
        created += len(data.get("data", {}).get("records") or chunk)
    return created


def write_analysis_rows(rows, skill_config, log_fn):
    if not rows:
        return 0

    bitable_cfg = skill_config.get("bitable", {})
    wiki_token = bitable_cfg.get("wiki_token", DEFAULT_WIKI_TOKEN)
    table_id = bitable_cfg.get("table_id", DEFAULT_TABLE_ID)
    app_token = bitable_cfg.get("app_token", "").strip()

    api_base, app_id, app_secret = load_lark_credentials()
    tenant_token = get_tenant_token(api_base, app_id, app_secret)

    if not app_token:
        app_token = resolve_app_token(api_base, tenant_token, wiki_token)

    created = batch_create_records(api_base, tenant_token, app_token, table_id, rows)
    log_fn(f"  📊 Wrote {created} rows to Lark Bitable")
    return created
