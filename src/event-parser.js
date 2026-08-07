'use strict';
// 日志行 → 标准化事件解析
// 依据 biliup 源码(crates/biliup-cli/src/server)确认的关键日志:
//   ds_update.log : "room: is live -> 开播了" / "成功开始录制 {url}" / "检查直播间出错"
//   download.log  : "开始下载，已解析流直链" / "finished downloading" / "Download workflow completed {url}" / "Stream went offline, stopping download"
//   upload.log    : "开始上传文件：{files}" / "Submit successful" / "Process segment event failed"
const biliupClient = require('./biliup-client');

// 事件类型定义:key -> { label, emoji, 是否值得默认通知 }
const EVENT_TYPES = {
  streamer_live:    { label: '主播开播',     emoji: '🔴' },
  streamer_offline: { label: '主播下播',     emoji: '⚫' },
  record_start:     { label: '开始录制',     emoji: '⏺️' },
  record_stop:      { label: '录制完成',     emoji: '✅' },
  upload_start:     { label: '开始上传',     emoji: '📤' },
  upload_success:   { label: '投稿成功',     emoji: '🎉' },
  error:            { label: '出错',         emoji: '⚠️' },
  alert:            { label: '告警',         emoji: '🔔' }
};

// 解析规则:优先顺序匹配
const RULES = [
  { type: 'streamer_live',    re: /开播了/ },
  { type: 'record_start',     re: /成功开始录制/ },
  { type: 'record_start',     re: /开始下载，已解析流直链|开始下载,已解析流直链/ },
  { type: 'streamer_offline', re: /Stream went offline|流已下线|直播已结束/ },
  { type: 'record_stop',      re: /Download workflow completed|下载流程完成|录制完成|下载完成/ },
  { type: 'upload_start',     re: /开始上传文件/ },
  { type: 'upload_success',   re: /Submit successful|投稿成功|上传成功/ },
  { type: 'error',            re: /Process segment event failed|处理分段事件失败|检查直播间出错|上传失败/ }
];

const CHANNEL_NAMES = {
  'ds_update.log': '直播检测',
  'download.log': '录制下载',
  'upload.log': '上传投稿'
};

// 从日志行提取 url:优先 kv 字段,其次行内链接
function extractUrl(line) {
  let m = line.match(/url\s*=\s*"?(https?:\/\/[^"\s,]+)"?/);
  if (m) return m[1];
  m = line.match(/page_url\s*=\s*"?(https?:\/\/[^"\s,]+)"?/);
  if (m) return m[1];
  m = line.match(/https?:\/\/[^\s"')]+/);
  return m ? m[0] : '';
}

// 提取日志级别
function extractLevel(line) {
  const m = line.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/);
  return m ? m[1] : 'INFO';
}

// 是否通用错误行(ERROR 级别且没匹配到业务规则)
function looksLikeError(line) {
  return /\bERROR\b/.test(line) && !/\bDEBUG\b/.test(line);
}

// 解析一行日志。返回 { type, level, url, raw, channel } 或 null
function parseLine(line, channel) {
  if (!line || !line.trim()) return null;
  const raw = line.trim();
  // 跳过 WS 控制消息(如 "日志文件 xxx 不存在")
  if (/日志文件.*不存在|读取日志文件错误|监控日志文件错误|日志文件被截断/.test(raw)) return null;

  const url = extractUrl(raw);
  const level = extractLevel(raw);

  let matched = null;
  for (const rule of RULES) {
    if (rule.re.test(raw)) { matched = rule; break; }
  }

  // 未命中业务规则但 ERROR 级别 → 通用错误
  if (!matched && looksLikeError(raw)) {
    matched = { type: 'error' };
  }

  if (!matched) return null;

  return { type: matched.type, level, url, raw, channel };
}

// 去抖:同 (type,url) 在去抖窗口内只保留第一条
const debounceMap = new Map();
const DEBOUNCE_MS = 8000;

function debounce(key) {
  const now = Date.now();
  const last = debounceMap.get(key) || 0;
  if (now - last < DEBOUNCE_MS) return false;
  debounceMap.set(key, now);
  return true;
}

// 解析并丰富成完整事件(异步补充主播名)
async function buildEvent(line, channel) {
  const parsed = parseLine(line, channel);
  if (!parsed) return null;
  if (parsed.type === 'error' && !parsed.url && looksLikeError(parsed.raw)) {
    // 通用错误没有 url,直接用频道名做键
  }
  const key = parsed.type + '|' + (parsed.url || channel);
  if (!debounce(key)) return null;

  const streamerName = parsed.url ? await biliupClient.resolveStreamerName(parsed.url) : '';

  return {
    id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    type: parsed.type,
    typeLabel: EVENT_TYPES[parsed.type] ? EVENT_TYPES[parsed.type].label : parsed.type,
    emoji: EVENT_TYPES[parsed.type] ? EVENT_TYPES[parsed.type].emoji : '🔔',
    level: parsed.level,
    time: new Date().toISOString(),
    url: parsed.url,
    streamerName,
    channel,
    channelLabel: CHANNEL_NAMES[channel] || channel,
    raw: parsed.raw,
    source: 'biliup-log'
  };
}

module.exports = { parseLine, buildEvent, EVENT_TYPES, CHANNEL_NAMES };
