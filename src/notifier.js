'use strict';
// 推送引擎:Telegram Bot + 自定义 Webhook,带超时与重试;出站走可配置 HTTP 代理
// 注意:必须用 undici 包的 fetch(Node 全局 fetch 与 undici ProxyAgent 版本混用会报 onRequestStart 错误)
const { fetch: ufetch, ProxyAgent } = require('undici');
const config = require('./config');

const MAX_RETRIES = 3;
const RETRY_DELAYS = [0, 1500, 4000]; // 每次重试前等待(ms)

let dispatcherCache = new Map(); // proxyUrl -> ProxyAgent
function getDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!dispatcherCache.has(proxyUrl)) {
    dispatcherCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return dispatcherCache.get(proxyUrl);
}
// Telegram 用的代理(全局配置)
function getGlobalProxy() {
  return (config.get().network || {}).proxy || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Telegram 文本需转义的字符(HTML parse mode 下)
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 从 tracing 日志行提取消息主体(去掉时间戳/级别/字段前缀),供 Telegram 紧凑展示
function extractLogMessage(raw) {
  const s = String(raw || '').trim();
  // 优先取行尾引号包裹的消息(如 `INFO url="..." "Download workflow completed"` → `Download workflow completed`)
  const m = s.match(/"([^"]*)"\s*$/);
  if (m) return m[1];
  // 兜底:去掉时间戳前缀
  return s.replace(/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}(\.\d+)?(Z)?\s+(INFO|WARN|ERROR|DEBUG|TRACE)\s*/, '').slice(0, 120) || s.slice(0, 120);
}

// 格式化事件为 Telegram 消息(HTML;含分隔线排版与可点击链接)
function formatTelegram(event) {
  const t = event.time ? new Date(event.time) : new Date();
  const timeStr = t.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const url = event.url ? String(event.url) : '';
  // 分隔线:Telegram 对全角字符按 2 倍宽渲染,过长会折行;12 个细线 ≈ 24 半角宽,单行安全
  const sep = '─'.repeat(12);
  const lines = [];

  // 标题
  lines.push(`${event.emoji} <b>${escHtml(event.typeLabel)}</b>`);
  lines.push(sep);

  // 主体字段
  if (event.streamerName) {
    lines.push(`👤 主播  ${escHtml(event.streamerName)}`);
  }
  if (url) {
    const display = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    lines.push(`🔗 直播  <a href="${escHtml(url)}">${escHtml(display)}</a>`);
  }
  lines.push(`🕐 时间  ${timeStr}`);
  if (event.channelLabel) {
    lines.push(`📡 来源  ${escHtml(event.channelLabel)}`);
  }
  if (event.level && event.level !== 'INFO') {
    lines.push(`🚨 级别  <b>${escHtml(event.level)}</b>`);
  }

  // 日志消息主体(截断,保留诊断价值;不嵌入整行原始日志以免超宽)
  if (event.raw) {
    const raw = extractLogMessage(event.raw).slice(0, 120);
    if (raw) {
      lines.push(sep);
      lines.push(`<code>${escHtml(raw)}</code>`);
    }
  }
  return lines.join('\n');
}

// 事件 → 内联按钮(有直播间链接时返回"打开直播间"按钮)
function telegramKeyboard(event) {
  const url = event.url ? String(event.url) : '';
  if (!/^https?:\/\//.test(url)) return undefined;
  return {
    inline_keyboard: [
      [{ text: '🔗 打开直播间', url }]
    ]
  };
}

// 格式化事件为 Webhook JSON payload(与 Telegram 一致结构,便于对接)
function formatWebhook(event) {
  return {
    event: event.type,
    event_type: event.type,
    type_label: event.typeLabel,
    emoji: event.emoji,
    streamer: event.streamerName || '',
    url: event.url || '',
    time: event.time,
    channel: event.channel || '',
    channel_label: event.channelLabel || '',
    level: event.level || 'INFO',
    message: event.raw || '',
    // 兼容常见 webhook 约定的字段
    text: `${event.emoji} ${event.typeLabel}${event.streamerName ? ' ' + event.streamerName : ''}${event.url ? ' ' + event.url : ''}`
  };
}

// 带重试的 HTTP POST。proxyUrl 非空时走该代理,为空则直连(本地/内网 webhook 不受影响)
async function postWithRetry(url, body, headers, timeoutMs, label, proxyUrl) {
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await ufetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        dispatcher: getDispatcher(proxyUrl)
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, status: res.status, body: (await res.text()).slice(0, 500) };
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? '超时' : e.message;
    }
  }
  return { ok: false, error: lastErr, label };
}

// 推送 Telegram(支持多个 chat_id)
async function pushTelegram(event) {
  const cfg = config.get().telegram;
  if (!cfg.enabled || !cfg.botToken) return { ok: false, skipped: true, reason: 'telegram 未启用或缺少 botToken' };
  const chatIds = String(cfg.chatIds || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!chatIds.length) return { ok: false, skipped: true, reason: '未配置 chatId' };

  const text = formatTelegram(event);
  const keyboard = telegramKeyboard(event);
  const results = [];
  const proxyUrl = getGlobalProxy();
  for (const chatId of chatIds) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) body.reply_markup = JSON.stringify(keyboard);
    const r = await postWithRetry(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      body,
      {},
      (cfg.timeout || 10) * 1000,
      `telegram:${chatId}`,
      proxyUrl
    );
    results.push({ channel: 'telegram', target: chatId, ...r });
  }
  return { ok: results.every(r => r.ok), results };
}

// 推送所有启用的 webhook
async function pushWebhooks(event) {
  const hooks = (config.get().webhooks || []).filter(h => h && h.url);
  if (!hooks.length) return { ok: false, skipped: true, reason: '未配置 webhook' };
  const payload = formatWebhook(event);
  const results = [];
  for (const hook of hooks) {
    // webhook 默认直连(本地/内网);如该 webhook 需走代理,在配置里加 proxy 字段
    const r = await postWithRetry(
      hook.url,
      payload,
      hook.headers || {},
      (hook.timeout || 10) * 1000,
      `webhook:${hook.name || hook.url}`,
      hook.proxy || ''
    );
    results.push({ channel: 'webhook', target: hook.name || hook.url, hookId: hook.id, ...r });
  }
  return { ok: results.every(r => r.ok), results };
}

// ---------- 推送级去重 ----------
const dedupMap = new Map(); // type|url -> lastTs
function shouldDedup(event) {
  const sec = (config.get().events || {}).dedupWindowSec || 0;
  if (!sec) return false;
  const key = `${event.type}|${event.url || ''}`;
  const now = Date.now();
  if (now - (dedupMap.get(key) || 0) < sec * 1000) return true;
  dedupMap.set(key, now);
  return false;
}

// 总入口:按事件类型开关过滤 + 推送级去重,分发到所有通道
// opts.skipDedup=true 时绕过去重(重试队列重投等"必须送达"场景)
async function dispatch(event, opts = {}) {
  const enabled = config.get().events;
  if (enabled[event.type] === false) {
    return { ok: false, skipped: true, reason: `事件类型 ${event.type} 已关闭` };
  }
  if (!opts.skipDedup && shouldDedup(event)) {
    return { ok: false, skipped: true, reason: `去重窗口(${enabled.dedupWindowSec}s)内已推送过同类事件` };
  }
  const [tg, wh] = await Promise.all([pushTelegram(event), pushWebhooks(event)]);
  const results = [...(tg.results || []), ...(wh.results || [])];
  const anyTried = results.length > 0;
  const allOk = results.length > 0 && results.every(r => r.ok);
  return { ok: allOk, skipped: !anyTried, results, summary: {
    telegram: tg.skipped ? '未启用' : (tg.ok ? '成功' : '失败'),
    webhook: wh.skipped ? '未启用' : (wh.ok ? '成功' : '失败')
  }};
}

// 测试推送:构造一条示例事件,发给指定通道
async function testChannel(channel, eventType) {
  const now = new Date().toISOString();
  const fake = {
    id: 'evt_test_' + Date.now().toString(36),
    type: eventType || 'record_stop',
    typeLabel: (require('./event-parser').EVENT_TYPES[eventType] || {}).label || '录制完成',
    emoji: (require('./event-parser').EVENT_TYPES[eventType] || {}).emoji || '✅',
    level: 'INFO',
    time: now,
    url: 'https://live.bilibili.com/123456',
    streamerName: '测试主播',
    channel: 'download.log',
    channelLabel: '录制下载',
    raw: `2026-01-01 12:00:00  INFO url="https://live.bilibili.com/123456" "Download workflow completed"`,
    source: 'test'
  };
  if (channel === 'telegram') return pushTelegram(fake);
  if (channel === 'webhook') return pushWebhooks(fake);
  return dispatch(fake);
}

module.exports = { dispatch, pushTelegram, pushWebhooks, testChannel, formatTelegram, formatWebhook, telegramKeyboard, extractLogMessage };
