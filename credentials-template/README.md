# Credentials 说明

## 需要在每台机器手动创建的文件

目标路径：`~/.openclaw/credentials/`

### lark.secrets.json（必须）
参考 `lark.secrets.json.template`，填入真实值后复制到目标路径：
```bash
cp credentials-template/lark.secrets.json.template ~/.openclaw/credentials/lark.secrets.json
# 然后编辑填入真实的 appSecret 等
vim ~/.openclaw/credentials/lark.secrets.json
```

### feishu-default-allowFrom.json（自动部署）
飞书用户白名单，由 setup.sh 自动复制，无需手动处理。

## 绝对不进 git 的文件
- `lark.secrets.json`（含 appSecret）
- `feishu-pairing.json`（运行时配对状态）
- OpenAI / Anthropic / Tavily API Key（在 openclaw.json 中单独填写）
