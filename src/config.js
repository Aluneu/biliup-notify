'use strict';
const fs = require('fs');
const path = require('path');

// 数据目录:默认项目根目录;Docker 等场景用环境变量 BILIUP_NOTIFY_DATA_DIR 指向挂载卷
const DATA_DIR = process.env.BILIUP_NOTIFY_DATA_DIR || path.join(__dirname, '..');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// 默认配置
const DEFAULTS = {
  server: {
    port: 4000
  },
  // 出站网络代理(Telegram API / Webhook 推送都走;留空 = 直连)
  // 本机无法直连外网时填如 http://127.0.0.1:7890
  network: {
    proxy: ''
  },
  biliup: {
    // biliup 后端地址(不带末尾斜杠)
    baseUrl: 'http://localhost:19159',
    // 是否启用 WebSocket 日志监听
    enabled: true,
    // 重连间隔(秒)
    reconnectBaseDelay: 3,
    // 每 60s 轮询一次 /v1/streamers 用于主播名映射
    refreshStreamersInterval: 60
  },
  telegram: {
    enabled: false,
    // Bot Token(从 @BotFather 获取)
    botToken: '',
    // 接收者 chat_id,多个用英文逗号分隔(支持 -100xxx 群组)
    chatIds: '',
    // 推送超时(秒)
    timeout: 10
  },
  webhooks: [
    // {
    //   id: 'wx-1',
    //   name: '企业微信机器人',
    //   url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
    //   headers: { 'Content-Type': 'application/json' },
    //   timeout: 10
    // }
  ],
  // 事件开关:eventType -> 是否启用通知(全局)
  events: {
    streamer_live: true,      // 主播开播
    streamer_offline: true,   // 主播下播
    record_start: true,       // 开始录制
    record_stop: true,        // 录制完成
    upload_start: true,       // 开始上传
    upload_success: true,     // 投稿成功
    error: true               // 出错
  },
  history: {
    maxEntries: 200   // 保留最近推送记录条数
  }
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cache = deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[config] 读取失败,使用默认配置:', e.message);
    cache = structuredClone(DEFAULTS);
  }
  applyEnvOverrides(cache);
  return cache;
}

// 环境变量覆盖(12-factor;Docker/无头部署用,优先级高于 config.json):
//   BILIUP_NOTIFY_PORT, BILIUP_NOTIFY_BILIUP_BASEURL, BILIUP_NOTIFY_PROXY,
//   BILIUP_NOTIFY_TELEGRAM_ENABLED, BILIUP_NOTIFY_TELEGRAM_BOTTOKEN, BILIUP_NOTIFY_TELEGRAM_CHATIDS
const ENV_MAP = {
  PORT: ['server', 'port'],
  BILIUP_BASEURL: ['biliup', 'baseUrl'],
  PROXY: ['network', 'proxy'],
  TELEGRAM_ENABLED: ['telegram', 'enabled'],
  TELEGRAM_BOTTOKEN: ['telegram', 'botToken'],
  TELEGRAM_CHATIDS: ['telegram', 'chatIds']
};
function applyEnvOverrides(cfg) {
  for (const [suffix, pathArr] of Object.entries(ENV_MAP)) {
    const val = process.env['BILIUP_NOTIFY_' + suffix];
    if (val === undefined || val === '') continue;
    let node = cfg;
    for (let i = 0; i < pathArr.length - 1; i++) node = node[pathArr[i]];
    const key = pathArr[pathArr.length - 1];
    const orig = node[key];
    if (typeof orig === 'boolean') node[key] = (val === 'true' || val === '1');
    else if (typeof orig === 'number') node[key] = Number(val);
    else node[key] = val;
  }
}

function deepMerge(base, extra) {
  if (Array.isArray(base)) return extra !== undefined ? extra : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(extra || {})) {
      if (extra[k] === undefined) continue;
      out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && extra[k] && typeof extra[k] === 'object'
        ? deepMerge(base[k], extra[k])
        : extra[k];
    }
    return out;
  }
  return extra !== undefined ? extra : base;
}

function save() {
  const cfg = load();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function get() {
  return load();
}

// 浅拷贝返回,防止外部直接改内部引用
function getPublic() {
  return JSON.parse(JSON.stringify(load()));
}

function update(patch) {
  const cfg = load();
  cache = deepMerge(cfg, patch);
  save();
  return getPublic();
}

function reset() {
  cache = structuredClone(DEFAULTS);
  save();
  return getPublic();
}

module.exports = { get, getPublic, update, reset, save, CONFIG_PATH };
