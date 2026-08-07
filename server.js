'use strict';
// biliup-notify 服务入口:HTTP API + 静态网页端 + biliup 日志监听
const path = require('path');
const express = require('express');
const config = require('./src/config');
const history = require('./src/history');
const notifier = require('./src/notifier');
const biliupClient = require('./src/biliup-client');
const { LogWatcher } = require('./src/log-watcher');
const eventParser = require('./src/event-parser');
const { TgBot } = require('./src/tg-bot');
const { AlertWatch } = require('./src/alert-watch');
const retryQueue = require('./src/retry-queue');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 网页端鉴权(可选) ----------
// 配置了 server.authToken 后,所有 /api 请求需带 Authorization: Bearer <token> 或 ?token=
app.use('/api', (req, res, next) => {
  const token = config.get().server.authToken;
  if (!token) return next();
  const headerAuth = req.headers.authorization || '';
  const queryToken = req.query.token;
  if (headerAuth === `Bearer ${token}` || queryToken === token) return next();
  res.status(401).json({ ok: false, error: '未授权:请在请求头带 Authorization: Bearer <token>' });
});

// ---------- 事件流 ----------
const watcher = new LogWatcher();
const recentEvents = []; // 最近事件(供网页端展示)

function pushRecent(event) {
  recentEvents.unshift(event);
  if (recentEvents.length > 100) recentEvents.length = 100;
}

watcher.on('line', async ({ channel, text }) => {
  try {
    const event = await eventParser.buildEvent(text, channel);
    if (!event) return;
    console.log(`[event] ${event.emoji} ${event.typeLabel} ${event.streamerName || ''} ${event.url || ''}`);
    pushRecent(event);
    const result = await notifier.dispatch(event);
    history.record(event, result);
    // 推送失败(真实通道尝试但失败)→ 进入持久化重试队列
    if (!result.skipped && !result.ok) retryQueue.enqueue(event, result);
    const status = result.skipped ? 'SKIP' : (result.ok ? 'OK' : 'FAIL');
    console.log(`[push] ${status} ${JSON.stringify(result.summary || result.reason || '')}`);
  } catch (e) {
    console.error('[event] 处理异常:', e.message);
  }
});

watcher.on('status', () => { /* 状态变化,由 /api/state 拉取 */ });
watcher.on('log', msg => console.log('[ws]', msg));

// ---------- 双向控制 Bot ----------
const tgBot = new TgBot();

// ---------- 告警检查器(空录制 / 磁盘空间) ----------
const alertWatch = new AlertWatch();
alertWatch.on('alert', async (event) => {
  console.log(`[alert] ${event.emoji} ${event.typeLabel}: ${event.raw}`);
  pushRecent(event);
  const result = await notifier.dispatch(event);
  history.record(event, result);
  if (!result.skipped && !result.ok) retryQueue.enqueue(event, result);
});

// ---------- API ----------
app.get('/api/state', async (req, res) => {
  let backendAlive = false;
  try { backendAlive = await biliupClient.ping(); } catch (e) {}
  res.json({
    service: {
      version: '1.0.0',
      startedAt: process.startedAt,
      uptime: Math.round(process.uptime())
    },
    backend: { alive: backendAlive, baseUrl: config.get().biliup.baseUrl },
    ws: watcher.getStatus(),
    stats: {
      historyTotal: history.list(1000).length,
      recentEvents: recentEvents.length
    }
  });
});

app.get('/api/config', (req, res) => res.json(config.getPublic()));

app.put('/api/config', (req, res) => {
  try {
    const oldBase = config.get().biliup.baseUrl;
    const cfg = config.update(req.body || {});
    // biliup 地址变更 → 重启日志监听(新地址重新连接)
    const newBase = cfg.biliup.baseUrl;
    if (newBase !== oldBase) {
      console.log(`[ws] biliup 地址变更: ${oldBase} -> ${newBase},重启监听`);
      watcher.restart();
    }
    // Bot 控制 / 告警配置变更 → 重启对应模块
    tgBot.stop(); tgBot.start();
    alertWatch.stop(); alertWatch.start();
    res.json({ ok: true, config: cfg });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/config/reset', (req, res) => {
  res.json({ ok: true, config: config.reset() });
});

app.post('/api/test', async (req, res) => {
  const { channel, eventType } = req.body || {};
  if (!['telegram', 'webhook', 'all'].includes(channel)) {
    return res.status(400).json({ ok: false, error: 'channel 必须是 telegram / webhook / all' });
  }
  const result = await notifier.testChannel(channel === 'all' ? 'all' : channel, eventType || 'record_stop');
  res.json({ ok: result.ok, skipped: result.skipped, reason: result.reason, summary: result.summary, results: result.results });
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ entries: history.list(limit) });
});

app.delete('/api/history', (req, res) => {
  history.clear();
  res.json({ ok: true });
});

// 重发某条历史推送
app.post('/api/history/:id/retry', async (req, res) => {
  const entry = history.getById(req.params.id);
  if (!entry) return res.status(404).json({ ok: false, error: '记录不存在' });
  const result = await notifier.dispatch(entry.event);
  const updated = history.record(entry.event, result);
  res.json({ ok: result.ok || result.skipped, result, updated });
});

app.get('/api/events', (req, res) => res.json({ events: recentEvents }));

// 演示/调试:注入一条模拟日志行,走完整解析+推送管道
app.post('/api/demo/line', async (req, res) => {
  const { line, channel } = req.body || {};
  if (!line) return res.status(400).json({ ok: false, error: '缺少 line' });
  const ch = channel || 'download.log';
  const event = await eventParser.buildEvent(line, ch);
  if (!event) return res.status(422).json({ ok: false, error: '无法从该行解析出事件(可能未命中关键词或已被去抖)' });
  pushRecent(event);
  const result = await notifier.dispatch(event);
  history.record(event, result);
  if (!result.skipped && !result.ok) retryQueue.enqueue(event, result);
  res.json({ ok: true, event, result });
});

// 从 biliup 拉主播列表(网页端展示用)
app.get('/api/streamers', async (req, res) => {
  try {
    const list = await biliupClient.getStreamers(true);
    res.json({ ok: true, list });
  } catch (e) {
    res.status(502).json({ ok: false, error: '无法连接 biliup 后端: ' + e.message });
  }
});

// ---------- 待重投队列 ----------
app.get('/api/queue', (req, res) => {
  const all = retryQueue.listAll();
  res.json({
    ok: true,
    active: all.filter(i => !i.dead).length,
    dead: all.filter(i => i.dead).length,
    entries: all.slice(0, 50)
  });
});

app.post('/api/queue/retry', async (req, res) => {
  const { id } = req.body || {};
  const result = await retryQueue.retryAll(id || null);
  res.json({ ok: true, ...result });
});

app.delete('/api/queue', (req, res) => {
  retryQueue.clear();
  res.json({ ok: true });
});

app.post('/api/queue/:id/remove', (req, res) => {
  res.json({ ok: retryQueue.remove(req.params.id) });
});

// 兜底 404(非 /api 交给静态托管)
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not found' }));

// ---------- 启动 ----------
const port = config.get().server.port;
app.listen(port, () => {
  process.startedAt = new Date().toISOString();
  console.log('========================================');
  console.log('  biliup-notify 推送服务已启动');
  console.log(`  网页端:  http://localhost:${port}`);
  console.log(`  biliup:  ${config.get().biliup.baseUrl}`);
  console.log('========================================');
  // Windows 桌面环境:启动后自动打开浏览器(容器/无头环境用 BILIUP_NOTIFY_NO_OPEN=1 关闭)
  if (!process.env.BILIUP_NOTIFY_NO_OPEN && process.platform === 'win32') {
    setTimeout(() => {
      try {
        require('child_process').exec(`start "" http://localhost:${port}`);
      } catch (e) { /* 打开失败不影响服务 */ }
    }, 800);
  }
  watcher.start();
  tgBot.start();
  alertWatch.start();
  retryQueue.startRetryLoop();
});

process.on('SIGINT', () => { watcher.stop(); tgBot.stop(); alertWatch.stop(); retryQueue.stopRetryLoop(); process.exit(0); });
process.on('SIGTERM', () => { watcher.stop(); tgBot.stop(); alertWatch.stop(); retryQueue.stopRetryLoop(); process.exit(0); });
