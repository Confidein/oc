# Instagram Graph API 配置指南

## 第一步：账号要求

- Instagram 账号必须是 **创作者账号** 或 **商业账号**
- 必须关联一个 **Facebook 主页（Page）**

切换方式：Instagram → 设置 → 账号 → 切换至专业账号

---

## 第二步：创建 Meta App

1. 进入 https://developers.facebook.com/
2. 点击右上角 **我的应用** → **创建应用**
3. 类型选 **其他** → **商业**
4. 填写应用名称，创建完成

---

## 第三步：添加 Instagram Graph API 权限

1. 进入应用后台 → **添加产品** → 找到 **Instagram Graph API** → 设置
2. 在左侧菜单 **角色** → **测试用户** 中添加自己的 Instagram 账号
3. 申请以下权限（开发模式下只需自己测试，不用审核）：
   - `instagram_basic`
   - `instagram_manage_comments`
   - `pages_read_engagement`（可选，读取 Page 关联数据）

---

## 第四步：获取 Access Token

### 方式 A：Graph API Explorer（最快）

1. 进入 https://developers.facebook.com/tools/explorer/
2. 选择你的应用，点击 **生成 Access Token**
3. 勾选所需权限，授权
4. 复制生成的 **短效 Token**（有效 1 小时）

### 方式 B：换取长效 Token（推荐，有效 60 天）

```bash
curl "https://graph.facebook.com/oauth/access_token \
  ?grant_type=fb_exchange_token \
  &client_id=你的AppID \
  &client_secret=你的AppSecret \
  &fb_exchange_token=上面的短效Token"
```

返回的 `access_token` 即为长效 Token，复制到 `config.json`。

---

## 第五步：获取 Instagram Business 用户 ID

```bash
curl "https://graph.instagram.com/me?fields=id,username&access_token=你的Token"
```

返回示例：
```json
{ "id": "17841400000000000", "username": "yourhandle" }
```

将 `id` 填入 `config.json` 的 `ig_user_id`。

---

## 第六步：完成配置

```bash
cp ~/.openclaw/plugin-skills/instagram-comments/assets/config.json.example \
   ~/.openclaw/plugin-skills/instagram-comments/assets/config.json

# 编辑填入真实值
nano ~/.openclaw/plugin-skills/instagram-comments/assets/config.json
```

---

## Token 刷新提醒

长效 Token 有效期 **60 天**，在到期前重新执行第四步 B 即可续期。  
建议每 45 天刷新一次，避免中断。

---

## 测试运行

```bash
python ~/.openclaw/plugin-skills/instagram-comments/scripts/instagram_comments.py
```

正常输出示例：
```
[INFO] 上次检查时间: 2026-06-05T08:00:00Z
[INFO] 拉取最近 20 条媒体...
[INFO] 获取到 15 条媒体
[2026-06-05T10:00:00Z] 共发现 2 条新评论
  @alice on 「测试帖子」: "太棒了！" (2026-06-05 09:10)
  @bob   on 「测试帖子」: "期待更多内容" (2026-06-05 09:45)
[INFO] 已更新 last_checked → 2026-06-05T10:00:00Z
```
