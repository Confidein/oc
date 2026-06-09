# Facebook Page 评论抓取 — 配置指南

## 1. 创建 Meta App

1. 打开 https://developers.facebook.com/
2. 创建 Business 类型 App
3. 添加 **Facebook Login** 和 **Instagram** 产品（与 IG 评论共用同一 App）

## 2. 申请权限

在 App Review 中申请以下权限（建议 Advanced Access）：

| 权限 | 用途 |
|------|------|
| `pages_show_list` | 列出管理的 Page |
| `pages_read_engagement` | 读取 Page 互动数据 |
| `pages_read_user_content` | **读取评论正文和评论者**（关键） |
| `pages_manage_engagement` | 管理评论（可选，仅读取可不申请） |

## 3. 生成 Token

1. 打开 https://developers.facebook.com/tools/explorer/
2. 选择 App，勾选上述权限
3. 点击 **Generate Access Token** 并完成授权
4. 换成长效 Token：

```bash
curl "https://graph.facebook.com/oauth/access_token \
  ?grant_type=fb_exchange_token \
  &client_id=你的APP_ID \
  &client_secret=你的APP_SECRET \
  &fb_exchange_token=短期TOKEN"
```

5. 写入 `assets/config.json` 的 `access_token`

## 4. 验证 API

```bash
# 列出 Page
curl "https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=TOKEN"

# 拉帖子（用 Page Token）
curl "https://graph.facebook.com/v19.0/PAGE_ID/published_posts?fields=id,message,comments.limit(0).summary(true)&limit=5&access_token=PAGE_TOKEN"

# 拉评论
curl "https://graph.facebook.com/v19.0/POST_ID/comments?fields=id,message,from,created_time&filter=stream&access_token=PAGE_TOKEN"
```

若 `comments.summary.total_count > 0` 但 `comments` 返回空数组，通常是：
- `pages_read_user_content` 未获 Advanced Access 批准
- 帖子为 Instagram 交叉发布，评论仅在 IG 侧

## 5. 飞书群

在 `config.json` 配置 `feishu_chat_id`，与 instagram-comments 可共用同一群或分开配置。
