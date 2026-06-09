---
name: instagram-comments
description: "通过 Instagram Graph API 轮询新评论，记录时间节点，每次只拉取节点之后的新增评论。"
---

# Instagram Comments Skill

每 2 小时通过官方 Graph API 查询账号下所有媒体的新增评论，状态持久化到 `state.json`。

## 前提配置

在 `~/.openclaw/plugin-skills/instagram-comments/assets/config.json` 填入：

```json
{
  "access_token": "你的长效 Access Token",
  "ig_user_id":   "你的 Instagram Business 用户 ID"
}
```

获取方式见 `references/setup.md`。

## 工作流

1. 读取 `assets/config.json` 获取 Token 与轮询参数。
2. 以 `state.last_run_at` 计算 2 小时评论窗口（首次用 `poll_window_hours`）。
3. 每个 IG 账号**分页拉取全部 media**（不限帖子发布时间）。
4. media 列表附带 `comments.limit(1){id,timestamp}`，对比 `state.media_last_comment_ts`；**仅最新评论时间变化**时拉评论（`comments_count` 仅作兜底）。全量分页覆盖所有帖子，无需周期补扫。
5. 分页边拉边处理；评论 API 间加 200ms 节流；cron 有锁防重叠。
6. 过滤本账号回复，收集新评论 → LLM → Lark 表 → 飞书通知（成功后才标记已推送）。
7. 单账号失败不影响其他账号；失败时飞书发告警。成功才更新 `last_run_at`。

## 执行方式

```bash
python ~/.openclaw/plugin-skills/instagram-comments/scripts/instagram_comments.py
```

## Cron 任务

每 2 小时由 cron 自动触发（首次运行时注册）。  
任务名：`instagram-comments-poll`

## 状态文件

- `assets/config.json` — Token 配置（手动填写，不可自动生成）
- `assets/state.json` — `last_run_at`、`media_last_comment_ts`、`media_counts`、`pushed_comment_ids`、`analyzed_comment_ids`

## 输出格式

日志中会输出每条新评论详情；飞书群推送本次新增总数及倾向分布：

```
📬 Instagram new comments: 3 added
🟢 positive: 2  🔵 neutral: 1  🔴 negative: 0
```

无新评论时：

```
📬 Instagram new comments: 0 added
🟢 positive: 0  🔵 neutral: 0  🔴 negative: 0
```

无新评论时仍推送飞书通知，数量均为 0。

## LLM 分析

有新评论时自动调用 `claude-haiku-4-5`，每条评论提取：

| 字段 | 说明 |
|------|------|
| comment_time | 评论时间（原始时间，不修改） |
| language | 评论语言（英文描述，如 English） |
| project_type | NFC 或 Glorify |
| sentiment | positive / neutral / negative |
| recommended_reply | 推荐回复（英文） |

分析输出文档（JSON/Markdown）除原始评论 `text`、`caption` 外，全部使用英文。

写入 [Lark 多维表格](https://clarkus8pcpkf8xh.usttp.larksuite.com/wiki/SMC1w2k1ciYvagk9iceuwroEtCA?table=tblQQsesKEACgERy&view=vewTfwTR6E) 字段映射：

| 表格字段 | 内容 |
|----------|------|
| Time | 评论时间（精确到分钟） |
| Source | `Instagram-{帖子账号用户名}` |
| Level | positive（夸奖赞美）/ neutral（无意义）/ negative（负面） |
| Language | 评论语言（英文描述） |
| Type | Glorify / NFC |
| Questions&Comments | 原始评论内容 |
| Note | 推荐回复（仅正向/负向，使用评论同语言） |
| url | 帖子链接 |

本地运行记录：

- `assets/logs/runs.jsonl` — 每次运行完整摘要（含 token）
- `assets/logs/token_usage.jsonl` — 每次运行 token 消耗专档
- `assets/analyses/token_usage.jsonl` — LLM 分批 token 明细（可选查阅）

评论过多时按 10 条一批拆分 LLM 调用。可在 `config.json` 设置 `"enable_llm_analysis": false` 关闭。

手动重跑分析：

```bash
python3 ~/.openclaw/plugin-skills/instagram-comments/scripts/instagram_comments.py --analyze-only
```

## 过滤与规则

- **本账号回复**：帖子下由本 IG 账号发出的评论（含回复用户）一律跳过，不抓取、不分析、不入表。
- **情感规则**：可编辑配置文件 `assets/sentiment_rules.json`（`config.json` 中 `sentiment_rules` 指定路径）。正面/负面/中性判定规则、优先级（负面 > 正面 > 中性）、纯信仰短语列表均在此文件维护，改配置即可生效，无需改代码。

## 注意事项

- Access Token 有效期 60 天，需定期刷新（见 `references/setup.md`）。
- 请求频率限制：每用户每小时 200 次 API 调用；媒体分页仍全量，但评论 API 仅在最新评论时间变化时触发。
- `config.json` 可调：`poll_window_hours`、`overlap_minutes`、`media_page_size`、`media_max_pages`、`force_full_comment_scan_hours`、`api_delay_ms`（默认 200）。
