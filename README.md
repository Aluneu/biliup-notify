# biliup-notify

基于 [biliup](https://github.com/biliup/biliup) 后端的直播事件推送服务:监听 biliup 的实时日志(WebSocket),解析出**开播 / 下播 / 开始录制 / 录制完成 / 开始上传 / 投稿成功 / 出错**等事件,推送到 **Telegram Bot** 与**自定义 Webhook**,自带网页端配置面板。

> 纯 Node.js(>=18)实现,零构建,`npm install && npm start` 即可运行。默认端口 `4000`。

> 🔒 敏感文件不入库:`config.json`(含 Bot Token / Chat ID)与 `history.json` 已被 `.gitignore` 排除;首次运行自动生成 `config.json`,可参考 `config.example.json` 模板。

## 原理

biliup 后端(`:19159`)通过 `GET /v1/ws/logs?file=<频道>` WebSocket 逐行推送日志文件:

| 频道 | 含义 | 解析出的事件 |
| --- | --- | --- |
| `ds_update.log` | 直播检测 / 开播更新 | 主播开播、下播、开始录制 |
| `download.log` | 下载 / 录制 | 开始下载、录制完成 |
| `upload.log` | 上传 / 投稿 | 开始上传、投稿成功 |

本服务并行监听 3 个频道,按关键词解析日志行(规则与 biliup 源码 `crates/biliup-cli/src/server` 中的日志输出对应),再从 biliup REST API(`/v1/streamers`、`/v1/streamer-info`)补齐主播名,最后分发到已启用的推送通道。同类事件 8 秒内自动去抖,断线自动重连(日志文件未生成时 30s 慢速探测)。

## 快速开始

### 🪟 Windows 小白版(双击即用)

**方式一:Release 下载(无需装 Node)**

到 [Releases](https://github.com/Aluneu/biliup-notify/releases) 下载 `biliup-notify-windows-x64.zip`,解压后**双击 `biliup-notify.exe`** 即可,浏览器自动打开网页端。配置保存在 exe 同目录的 `config.json`(更新版本时保留该文件即可迁移配置)。

**方式二:源码运行**

1. 下载项目,解压到任意目录
2. 双击 **`install.bat`** ——自动检测 Node.js,没装会引导你一键安装
3. 双击 **`start.bat`** ——自动安装依赖、启动服务,浏览器自动打开网页端
4. 按网页端顶部提示配置 Telegram / Webhook,点「保存」→「发送测试推送」验证

> 每次开机只需双击 `start.bat`;关闭窗口即停止服务。

### 🐳 Docker 版(服务器 / VPS)

本 compose **只启动推送服务**;biliup 请用你自己的部署(本机进程 / 已有容器 / 远程服务器)。

```bash
# 1. 复制环境变量模板并填写 BILIUP_BASEURL(必填)与 Telegram 配置(可选)
cp .env.example .env

# 2. 启动推送服务
docker compose up -d

# 3. 打开 http://<服务器IP>:4000
```

`BILIUP_BASEURL` 指向你的 biliup 后端(不一定是 19159,按实际部署填):宿主机上的 biliup 填 `http://host.docker.internal:<端口>`;另一个容器填 `http://<容器名>:<端口>`;远程填 `http://<IP>:<端口>`。配置持久化在 `data/notify/` 卷,Telegram 配置可通过 `.env` 注入,也可之后在网页端修改。

### 手动部署(有 Node 环境)

```bash
npm install
npm start          # 默认 http://localhost:4000
```

打开 `http://localhost:4000` 即可配置。

> 环境变量(优先级高于 config.json):`BILIUP_NOTIFY_PORT`、`BILIUP_NOTIFY_BILIUP_BASEURL`、`BILIUP_NOTIFY_PROXY`、`BILIUP_NOTIFY_TELEGRAM_ENABLED`、`BILIUP_NOTIFY_TELEGRAM_BOTTOKEN`、`BILIUP_NOTIFY_TELEGRAM_CHATIDS`、`BILIUP_NOTIFY_DATA_DIR`(数据目录,Docker 用)、`BILIUP_NOTIFY_NO_OPEN=1`(禁止自动打开浏览器,容器用)。

### 配置项(config.json)

```jsonc
{
  "server": { "port": 4000 },
  "network": {
    "proxy": ""            // 出站代理(Telegram 推送走;留空 = 直连)
                           // 直连 Telegram 不通时必须填,如 "http://127.0.0.1:7890"
  },
  "biliup": {
    "baseUrl": "http://localhost:19159",   // biliup 后端地址(默认端口 19159,但可能不同——按实际部署填,网页端可改)
    "enabled": true,                        // 是否监听日志
    "reconnectBaseDelay": 3,                // 断线重连基础间隔(秒)
    "refreshStreamersInterval": 60          // 主播名映射缓存刷新(秒)
  },
  "telegram": {
    "enabled": false,
    "botToken": "123456:AAF-xxxx",          // @BotFather 创建机器人获取
    "chatIds": "123456,-1001234567890",     // 接收 chat_id,逗号分隔(群组用 -100 开头)
    "timeout": 10
  },
  "webhooks": [
    {
      "id": "qyweixin",
      "name": "企业微信",
      "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
      "enabled": true,
      "headers": { "X-Webhook-Secret": "your-secret" },  // 自定义请求头
      "timeout": 10
    }
  ],
  "events": {          // 各事件类型总开关
    "streamer_live": true, "streamer_offline": true,
    "record_start": true, "record_stop": true,
    "upload_start": true, "upload_success": true,
    "error": true
  },
  "history": { "maxEntries": 200 }
}
```

Telegram 与 Webhook 也可全部在网页端配置,保存即生效(无需重启)。

> ⚠️ **网络代理**:Telegram 推送通过 `network.proxy` 配置的出站 HTTP 代理发送(Node 不走系统代理)。本机无法直连 `api.telegram.org` 时必须填写(如 `http://127.0.0.1:7890`),否则推送会超时失败。Webhook 默认直连(适配本地/内网),如某个 webhook 需要走代理,在其配置对象里加 `"proxy": "http://…"` 字段。

### Telegram 消息格式

HTML 排版(标题 + 分隔线 + 图标字段),有直播间链接时附「🔗 打开直播间」内联按钮,点击直达直播间:

```
🎉 投稿成功
────────────
👤 主播  某主播
🔗 直播  live.bilibili.com/123
🕐 时间  08/07 20:15:30
📡 来源  上传投稿
────────────
<code>2026-08-07 20:15:30  INFO "Submit successful"</code>

[🔗 打开直播间]  ← 内联按钮
```

### Webhook 载荷

`POST application/json`,字段: `event` / `event_type` / `type_label` / `emoji` / `streamer` / `url` / `time` / `channel` / `channel_label` / `level` / `message`(原始日志),另有 `text` 纯文本摘要,可直接对接企业微信 / 钉钉 / 飞书等常见机器人格式。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 服务状态、biliup 连通性、WS 通道连接状态、统计 |
| GET/PUT | `/api/config` | 读取 / 保存配置 |
| POST | `/api/config/reset` | 恢复默认配置 |
| POST | `/api/test` | 测试推送 `{ channel: "telegram"\|"webhook"\|"all", eventType? }` |
| GET | `/api/history` | 推送历史 `?limit=` |
| DELETE | `/api/history` | 清空历史 |
| POST | `/api/history/:id/retry` | 重发某条记录 |
| GET | `/api/events` | 最近解析到的事件(网页端事件流) |
| POST | `/api/demo/line` | 注入一条模拟日志行,走完整解析 + 推送管道(调试用) |
| GET | `/api/streamers` | 从 biliup 拉主播列表 |

## 常见问题

- **网页端显示"日志监听未连接"**:说明 biliup 还未产生对应日志文件(通常是没有添加主播或检测周期未触发)。服务会 30 秒慢速探测,一旦 biliup 生成日志文件会自动连上;文件存在时连接保持常驻。
- **测试推送收不到**:先在网页端保存配置并确认对应通道开关已打开;Webhook 可用任意本地 HTTP 服务验证载荷。
- **biliup 启用了 `--auth`**:目前日志 WS 端点不受登录守卫保护(官方文档已注明),本服务直连即可;如需保护 biliup 端口请走反向代理。

## 回归验证

项目自带 ad-hoc 验证脚本(非正式测试套件),覆盖服务健康、静态资源、配置读写往返、6 类事件解析、主播名解析、去抖、Webhook 端到端(payload 字段/自定义 header)、事件开关过滤、历史与重发。需先启动服务与 biliup 后端:

```bash
npm start          # 先启动服务(另一终端)
node tests/verify.js   # 全部断言通过退出码为 0
```

脚本会在结束时自动清理测试数据(webhook 配置与历史记录)。

## 项目结构

```
biliup-notify/
├── server.js              # 入口:HTTP API + 静态托管 + 装配
├── config.json            # 运行时配置(自动生成)
├── history.json           # 推送历史(自动生成)
├── src/
│   ├── config.js          # 配置读写
│   ├── biliup-client.js   # biliup REST API 客户端(主播名解析)
│   ├── log-watcher.js     # WebSocket 日志监听(3 频道 + 重连)
│   ├── event-parser.js    # 日志行 → 事件(关键词规则 + 去抖)
│   ├── notifier.js        # 推送引擎(Telegram / Webhook,重试)
│   └── history.js         # 历史记录
├── public/                # 网页端(原生 HTML/CSS/JS,无构建)
└── tests/webhook-receiver.js  # 本地 Webhook 调试接收器
```
