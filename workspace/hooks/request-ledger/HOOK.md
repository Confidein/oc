---
name: request-ledger
description: "Log topic summary, model, and token usage for each user request to a local audit JSONL file"
metadata:
  {
    "openclaw":
      {
        "emoji": "📒",
        "events": ["message:preprocessed", "message:sent"],
      },
  }
---

# Request Ledger Hook

Appends one JSONL record per completed user request with:

- topic summary (heuristic from user message)
- model (`provider/modelId`)
- token usage (from trajectory)
- channel / sender / session metadata

Log file default: `~/.openclaw/logs/request-ledger.jsonl`
