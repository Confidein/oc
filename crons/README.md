# Cron Jobs

## shared-crons.json
所有机器都需要注册的定时任务，通过 `setup.sh --crons` 自动注册。

## 机器特定 cron（手动注册）

以下 cron 含用户特定信息，需在各机器手动创建：

### poll-lark-minutes-as-{open_id}
- **作用**：轮询指定用户的飞书妙记
- **间隔**：15 分钟
- **需要替换**：`{open_id}` 换成目标用户的飞书 open_id
- **参考**：生产机上已有示例，参考其 payload 结构创建
