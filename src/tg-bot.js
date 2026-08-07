'use strict';
// Telegram Bot 双向控制:轮询 getUpdates,白名单 chat 可用命令管理 biliup
// 命令:/start /help /status /live /add <url> [备注] /pause <id> /del <id> /files [n] /info <id>
const fs = require('fs');
const path = require('path');
const { fetch: ufetch, ProxyAgent } = require('undici');
const config = require('./config');
const biliupClient = require('./biliup-client');

const OFFSET_FILE = path.join(config.DATA_DIR, 'tg-offset.json');

let dispatcherCache = null;
function getDispatcher() {
  const proxy = (config.get().network || {}).proxy;
  if (!proxy) return undefined;
  if (!dispatcherCache) dispatcherCache = new ProxyAgent(proxy);
  return dispatcherCache;
}

async function tgApi(method, urlPath, body) {
  const cfg = config.get().telegram;
  const base = `https://api.telegram.org/bot${cfg.botToken}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await ufetch(base + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      dispatcher: getDispatcher()
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`TG ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 150)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 状态与格式化 ----------
const STATUS_META = {
  Working: { dot: '🟢', label: '录制中' },
  Pending: { dot: '🟡', label: '等待中' },
  Idle: { dot: '⚪', label: '空闲' },
  Pause: { dot: '🟠', label: '已暂停' }
};
function statusTag(s) {
  const m = STATUS_META[s] || { dot: '⚪', label: s || '未知' };
  return `${m.dot} ${m.label}`;
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function shortUrl(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}
function fmtTime(sec) {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 命令实现 ----------
async function cmdStatus() {
  const list = await biliupClient.getStreamers(true);
  if (!list.length) return '📭 还没有添加任何主播\n用 /add https://live.bilibili.com/xxx 添加';
  const lines = list.map((s, i) => {
    const name = s.remark || s.name || shortUrl(s.url);
    return `${statusTag(s.status)} <b>${esc(name)}</b>  [${s.id}]  ${esc(shortUrl(s.url))}${s.upload_status && s.upload_status !== 'Idle' ? `  📤${esc(s.upload_status)}` : ''}`;
  });
  return `📡 主播状态 (${list.length})\n━━━━━━━━━━\n${lines.join('\n')}\n\n<i>查看详情 /info &lt;id&gt; · 暂停 /pause &lt;id&gt; · 删除 /del &lt;id&gt;</i>`;
}

async function cmdLive() {
  const list = await biliupClient.getStreamers(true);
  const live = list.filter(s => s.status === 'Working' || s.status === 'Pending');
  if (!live.length) return '😴 当前没有正在录制的主播';
  return `🔴 正在录制/等待 (${live.length})\n${live.map(s => `· <b>${esc(s.remark || shortUrl(s.url))}</b> [${s.id}]`).join('\n')}`;
}

async function cmdAdd(args) {
  const m = String(args || '').match(/^(https?:\/\/\S+)\s*(.*)$/);
  if (!m) return '❌ 用法:/add <直播间URL> [备注]\n例:/add https://live.bilibili.com/123 阿梓';
  const url = m[1];
  const remark = m[2] || '';
  const body = remark ? { url, remark } : { url };
  const res = await biliupClient.fetchJson('/v1/streamers', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return `✅ 已添加 [${res.id}] ${esc(remark || shortUrl(url))}\n${esc(url)}`;
}

async function cmdPause(id) {
  if (!id) return '❌ 用法:/pause <主播ID>(再次执行恢复)\n主播 ID 用 /status 查看';
  const res = await biliupClient.fetchJson(`/v1/streamers/${id}/pause`, { method: 'PUT' });
  return `⏯️ 已切换 [${id}] 暂停/恢复状态`;
}

async function cmdDel(id) {
  if (!id) return '❌ 用法:/del <主播ID>';
  await biliupClient.fetchJson(`/v1/streamers/${id}`, { method: 'DELETE' });
  return `🗑️ 已删除主播 [${id}]`;
}

async function cmdFiles(args) {
  const n = Math.min(parseInt(args) || 10, 20);
  const list = await biliupClient.fetchJson('/v1/videos');
  const sorted = [...(list || [])].sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0)).slice(0, n);
  if (!sorted.length) return '📁 还没有录制文件';
  const lines = sorted.map(v => {
    const name = String(v.name || v.key || '').split(/[\\/]/).pop();
    return `· ${fmtSize(v.size)}  ${fmtTime(v.updateTime)}  ${esc(name)}`;
  });
  return `📁 最近录制文件 (${sorted.length})\n━━━━━━━━━━\n${lines.join('\n')}`;
}

async function cmdInfo(id) {
  if (!id) return '❌ 用法:/info <主播ID>';
  const list = await biliupClient.getStreamers(true);
  const s = list.find(x => String(x.id) === String(id));
  if (!s) return `❌ 找不到主播 [${id}]`;
  const lines = [
    `ℹ️ <b>${esc(s.remark || shortUrl(s.url))}</b> [${s.id}]`,
    `链接: ${esc(s.url)}`,
    `状态: ${statusTag(s.status)}${s.upload_status && s.upload_status !== 'Idle' ? ` / 上传:${esc(s.upload_status)}` : ''}`,
    s.filename_prefix ? `文件名前缀: ${esc(s.filename_prefix)}` : null,
    s.time_range ? `录制时段: ${esc(s.time_range)}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

const HELP = [
  '🤖 <b>biliup 遥控命令</b>',
  '━━━━━━━━━━',
  '/status — 所有主播状态',
  '/live — 正在录制的主播',
  '/add &lt;URL&gt; [备注] — 添加主播',
  '/pause &lt;id&gt; — 暂停/恢复(切换)',
  '/del &lt;id&gt; — 删除主播',
  '/files [n] — 最近录制文件',
  '/info &lt;id&gt; — 主播详情',
  '/help — 本帮助',
  '━━━━━━━━━━',
  '<i>主播 ID 用 /status 查看</i>'
].join('\n');

const COMMANDS = {
  start: async () => HELP,
  help: async () => HELP,
  commands: async () => HELP,
  status: cmdStatus,
  live: cmdLive,
  add: cmdAdd,
  pause: cmdPause,
  del: cmdDel,
  files: cmdFiles,
  info: cmdInfo
};

// ---------- Bot 主循环 ----------
class TgBot {
  constructor() {
    this.stopped = false;
    this.offset = this._loadOffset();
    this.pollTimer = null;
    this.log = msg => console.log('[tg-bot]', msg);
  }

  start() {
    const cfg = config.get().telegram;
    if (!cfg.enabled || !cfg.botToken || !cfg.botControl) return;
    this.stopped = false;
    this.log('启动,等待命令(白名单 chat: ' + (cfg.chatIds || '(无)') + ')');
    this._poll();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  _loadOffset() {
    try { return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0; }
    catch (e) { return 0; }
  }
  _saveOffset() {
    try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset: this.offset }), 'utf8'); } catch (e) {}
  }

  async _poll() {
    if (this.stopped) return;
    const cfg = config.get().telegram;
    if (!cfg.enabled || !cfg.botToken || !cfg.botControl) return;
    try {
      const data = await tgApi('GET', `/getUpdates?timeout=30&offset=${this.offset + 1}&allowed_updates=["message"]`);
      const updates = data.result || [];
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id);
        await this._handleUpdate(u);
      }
      if (updates.length) this._saveOffset();
    } catch (e) {
      this.log('轮询错误:' + e.message);
    }
    if (!this.stopped) this.pollTimer = setTimeout(() => this._poll(), 1000);
  }

  _isAllowed(chatId) {
    const ids = String(config.get().telegram.chatIds || '').split(',').map(s => s.trim()).filter(Boolean);
    return ids.includes(String(chatId));
  }

  async _handleUpdate(u) {
    const msg = u.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat && msg.chat.id;
    if (!this._isAllowed(chatId)) {
      this.log(`忽略非白名单消息: chat=${chatId} text=${String(msg.text).slice(0, 40)}`);
      return;
    }
    const text = String(msg.text).trim();
    const [cmdPart, ...rest] = text.split(/\s+/);
    const cmd = (cmdPart || '').replace(/^@\w+$/, '').toLowerCase().replace(/^\//, '');
    const args = rest.join(' ').trim();
    this.log(`命令 from ${chatId}: /${cmd} ${args.slice(0, 40)}`);

    try {
      if (COMMANDS[cmd]) {
        const reply = await COMMANDS[cmd](args);
        await tgApi('POST', '/sendMessage', { chat_id: chatId, text: reply, parse_mode: 'HTML', disable_web_page_preview: true });
      } else if (text.startsWith('/')) {
        await tgApi('POST', '/sendMessage', { chat_id: chatId, text: '❓ 未知命令,发送 /help 查看可用命令', parse_mode: 'HTML' });
      }
      // 非 / 开头的普通消息:忽略
    } catch (e) {
      this.log('命令执行失败:' + e.message);
      try {
        await tgApi('POST', '/sendMessage', { chat_id: chatId, text: '⚠️ 执行失败:' + esc(e.message.slice(0, 200)), parse_mode: 'HTML' });
      } catch (e2) {}
    }
  }
}

module.exports = { TgBot, COMMANDS, statusTag, fmtSize, fmtTime, esc };
