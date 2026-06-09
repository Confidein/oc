"""Structured run logging for plugin-skills cron scripts."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

KEEP_DAYS = 30
RUNS_JSONL_MAX_LINES = 500


class RunRecorder:
    def __init__(self, skill_dir: Path, platform: str):
        self.skill_dir = Path(skill_dir)
        self.platform = platform
        self.started_at = datetime.now(timezone.utc)
        self.accounts_scanned = 0
        self.new_comments = 0
        self.pushed_comments = 0
        self.feishu_status = "skipped"
        self.llm_analyzed = 0
        self.llm_batches = 0
        self.llm_model = ""
        self.llm_input_tokens = 0
        self.llm_output_tokens = 0
        self.bitable_written = 0
        self.errors: list[str] = []
        self.log_dir = self.skill_dir / "assets" / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def add_error(self, msg: str) -> None:
        self.errors.append(msg)

    def finish(self, exit_code: int = 0) -> None:
        finished_at = datetime.now(timezone.utc)
        duration = (finished_at - self.started_at).total_seconds()
        if exit_code != 0:
            status = "error"
        elif self.errors:
            status = "partial"
        else:
            status = "ok"

        record = {
            "platform": self.platform,
            "started_at": self.started_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "finished_at": finished_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration_sec": round(duration, 1),
            "status": status,
            "exit_code": exit_code,
            "accounts_scanned": self.accounts_scanned,
            "new_comments": self.new_comments,
            "pushed_comments": self.pushed_comments,
            "feishu_status": self.feishu_status,
            "llm_analyzed": self.llm_analyzed,
            "llm_batches": self.llm_batches,
            "llm_model": self.llm_model or None,
            "llm_input_tokens": self.llm_input_tokens,
            "llm_output_tokens": self.llm_output_tokens,
            "llm_total_tokens": self.llm_input_tokens + self.llm_output_tokens,
            "bitable_written": self.bitable_written,
            "errors": self.errors,
        }

        runs_file = self.log_dir / "runs.jsonl"
        with runs_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        token_record = {
            "platform": self.platform,
            "started_at": record["started_at"],
            "finished_at": record["finished_at"],
            "status": status,
            "new_comments": self.new_comments,
            "llm_analyzed": self.llm_analyzed,
            "llm_batches": self.llm_batches,
            "model": self.llm_model or None,
            "input_tokens": self.llm_input_tokens,
            "output_tokens": self.llm_output_tokens,
            "total_tokens": self.llm_input_tokens + self.llm_output_tokens,
        }
        token_file = self.log_dir / "token_usage.jsonl"
        with token_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(token_record, ensure_ascii=False) + "\n")
        self._prune(token_file)

        cron_log = self.skill_dir / "assets" / "cron.log"
        line = (
            f"[{record['finished_at']}] {self.platform} "
            f"status={status} accounts={self.accounts_scanned} "
            f"new={self.new_comments} pushed={self.pushed_comments} "
            f"feishu={self.feishu_status} llm={self.llm_analyzed} "
            f"tokens={self.llm_input_tokens}+{self.llm_output_tokens} "
            f"duration={duration:.1f}s"
        )
        if self.errors:
            line += f" errors={self.errors!r}"
        if exit_code != 0:
            line += f" exit={exit_code}"
        with cron_log.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

        print(
            f"[{record['finished_at']}] 📊 运行摘要 "
            f"status={status} new={self.new_comments} "
            f"pushed={self.pushed_comments} llm={self.llm_analyzed} "
            f"tokens={self.llm_input_tokens}+{self.llm_output_tokens} "
            f"duration={duration:.1f}s",
            flush=True,
        )

        self._prune(runs_file)

    def _prune(self, runs_file: Path) -> None:
        import time

        cutoff = time.time() - KEEP_DAYS * 86400
        for path in self.log_dir.glob("run_*.log"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass

        if not runs_file.exists() or runs_file.stat().st_size <= 500_000:
            return
        lines = runs_file.read_text(encoding="utf-8").splitlines()
        if len(lines) > RUNS_JSONL_MAX_LINES:
            runs_file.write_text(
                "\n".join(lines[-RUNS_JSONL_MAX_LINES:]) + "\n",
                encoding="utf-8",
            )
