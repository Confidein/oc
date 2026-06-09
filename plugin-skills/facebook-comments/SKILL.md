---
name: facebook-comments
description: "通过 Facebook Graph API 轮询 Page 帖子新评论，增量去重并推送到飞书群。"
---

# Facebook Comments Skill

定时通过官方 Graph API 查询 Facebook Page `published_posts` 的新增评论，状态持久化到 `state.json`。

## 前提配置

在 `~/.openclaw/plugin-skills/facebook-comments/assets/config.json` 填入：

```json
{
  "access_token": "你的长效 User Access Token",
  "feishu_chat_id": "飞书群 chat_id"
}
```

可选：只监控单个 Page 时加 `"page_id": "110772240836804"`。

获取方式见 `references/setup.md`。

## 工作流

1. 读取 `assets/config.json` 获取 Token。
2. `GET /me/accounts` 获取 Page 列表及 **Page Access Token**。
3. 每个 Page 拉最近 20 条 `published_posts`。
4. 对有评论的帖子拉 `/{post_id}/comments`，按 `created_time` 增量过滤。
5. 新评论推送到飞书群；状态写入 `assets/state.json`。

## 执行方式

```bash
python3 ~/.openclaw/plugin-skills/facebook-comments/scripts/facebook_comments.py
python3 ~/.openclaw/plugin-skills/facebook-comments/scripts/facebook_comments.py --send-only
```

## Cron 任务

任务名：`facebook-comments-poll`（每 30 分钟）

## 推送格式

```
账号-用户名-评论-时间-帖子地址
```

示例：

```
Glorify Brasil-Maria Silva-Amém!-2026-06-06 07:00-https://www.facebook.com/...
```

## 注意事项

- 必须使用 **Page Access Token**（脚本通过 `/me/accounts` 自动获取）。
- 需要 `pages_read_engagement` 和 `pages_read_user_content` 权限。
- 若帖子显示有评论数但 API 返回空，常见原因是 IG 交叉发布帖子的评论只在 Instagram 侧可见。
- 帖子列表为最近 **发布** 的 20 条，不是「最近有评论更新」的 20 条。
