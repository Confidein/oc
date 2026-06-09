# Lark Minutes Digest

`lark_minutes_digest.mjs` polls Feishu/Lark Minutes for employees that already have
an OpenClaw stored user OAuth token, summarizes new minutes with OpenAI, and sends
the summary to the users who saw that minute during polling. It also creates a
Feishu/Lark summary document for each summarized minute and includes the doc link
in the notification.

Important limits:

- It lists employees with the app's tenant token, but it can only query Minutes
  for employees who have completed user OAuth. Employees without a stored token
  are skipped.
- It does not bypass Minutes permissions. Transcript/export failures are reported
  in the run output and the user receives a permission note instead of a summary.
- The recipient set is the union of users whose user-token search returned the
  minute, plus the minute owner when the detail API returns `owner_id`.
- Summary documents are created with the same authorized user token used to read
  the minute. Set one of the destination env vars below to place docs in a shared
  folder or wiki; otherwise they are created in that user's default doc space.

Useful commands:

```bash
node scripts/lark_minutes_digest.mjs --dry-run --lookback-minutes 90
node scripts/lark_minutes_digest.mjs --lookback-minutes 60
node scripts/lark_minutes_digest.mjs --force-lookback --lookback-minutes 180
node scripts/lark_minutes_digest.mjs --force-lookback --lookback-minutes 180 --no-advance-checkpoint
node scripts/lark_minutes_digest.mjs --force-lookback --lookback-minutes 180 --no-create-doc
```

Backfill behavior:

- Normal runs use `state.lastCheckedAt` plus overlap, so each cron run only scans
  the incremental window.
- `--force-lookback` ignores `lastCheckedAt` and scans the requested lookback
  window. It still uses `minute_token` and recipient state to avoid duplicate
  sends.
- `--no-advance-checkpoint` is useful for one-off backfills: it sends any missing
  summaries but does not move the normal cron checkpoint forward.
- If a minute was already processed and a newly authorized user later sees it,
  the script sends that summary to the newly visible recipient without resending
  to users already recorded in state.
- If a minute was previously summarized before document creation was enabled,
  a force-lookback run will create the missing summary document and send only the
  document link to users who already received the original summary.

Environment overrides:

- `MINUTES_DIGEST_LOOKBACK_MINUTES`
- `MINUTES_DIGEST_OVERLAP_MINUTES`
- `MINUTES_DIGEST_SEARCH_WINDOW_MINUTES`
- `MINUTES_DIGEST_STATE`
- `MINUTES_DIGEST_CREATE_DOCS=false`
- `MINUTES_DIGEST_DOC_FOLDER_TOKEN`
- `MINUTES_DIGEST_DOC_WIKI_NODE`
- `MINUTES_DIGEST_DOC_WIKI_SPACE`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
