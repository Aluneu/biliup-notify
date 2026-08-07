'use strict';
/* hermes-verify-biliup-notify.js — biliup-notify 核心行为系统验证(临时脚本,验证后从 Temp 清理;固化版在项目 tests/verify.js) */
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
let passed = 0, failed = 0;
const results = [];

function check(name, cond, extra) {
  if (cond) { passed++; results.push('PASS ' + name); }
  else { failed++; results.push('FAIL ' + name + (extra ? ' => ' + JSON.stringify(extra) : '')); }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

(async () => {
  // 1. 服务健康
  const st = await api('/api/state');
  check('state 200', st.status === 200);
  check('biliup 后端在线', st.data.backend && st.data.backend.alive === true, st.data.backend);
  check('WS 状态含 3 频道', st.data.ws && ['ds_update.log', 'download.log', 'upload.log'].every(c => c in st.data.ws), st.data.ws);

  // 2. 静态资源
  for (const f of ['/', '/style.css', '/app.js']) {
    const r = await fetch(BASE + f);
    check(`静态资源 ${f} 200`, r.status === 200);
  }

  // 3. 配置读写往返
  const rc = await startReceiver();
  const webhookCfg = {
    webhooks: [{
      id: 'verify-hook', name: '验证', url: `http://127.0.0.1:${rc.port}/hook`,
      enabled: true, headers: { 'X-Verify': 'yes' }, timeout: 5
    }]
  };
  const putCfg = await api('/api/config', { method: 'PUT', body: webhookCfg });
  check('配置保存 webhooks=1', putCfg.data && putCfg.data.config && putCfg.data.config.webhooks && putCfg.data.config.webhooks.length === 1, putCfg.data);
  const getCfg = await api('/api/config');
  const savedHook = getCfg.data && getCfg.data.webhooks && getCfg.data.webhooks[0];
  check('配置读回一致(url+header)', savedHook && savedHook.url === webhookCfg.webhooks[0].url && savedHook.headers['X-Verify'] === 'yes');

  // 4. 事件解析:各类日志行
  const cases = [
    ['ds_update.log', '2026-08-07 12:00:00  INFO url="https://live.bilibili.com/6" room: is live -> 开播了', 'streamer_live'],
    ['ds_update.log', '2026-08-07 12:00:01  INFO "成功开始录制 https://live.bilibili.com/6"', 'record_start'],
    ['download.log', '2026-08-07 12:05:00  INFO url="https://live.bilibili.com/6" "Download workflow completed => Working"', 'record_stop'],
    ['upload.log', '2026-08-07 12:06:00  INFO "开始上传文件：[/data/1.flv]"', 'upload_start'],
    ['upload.log', '2026-08-07 12:08:00  INFO "Submit successful"', 'upload_success'],
    ['ds_update.log', '2026-08-07 12:09:00 ERROR e="err" "检查直播间出错"', 'error']
  ];
  for (const [ch, line, expect] of cases) {
    const r = await api('/api/demo/line', { method: 'POST', body: { line, channel: ch } });
    check(`解析 ${expect}`, r.status === 200 && r.data.event && r.data.event.type === expect, r.data);
  }
  // 主播名应从 biliup REST API 解析(用不同 url 避开去抖)
  const liveCase = await api('/api/demo/line', { method: 'POST', body: { line: '2026-08-07 13:00:00  INFO url="https://live.bilibili.com/60213" "Download workflow completed"', channel: 'download.log' } });
  check('主播名非空', liveCase.data && liveCase.data.event && !!liveCase.data.event.streamerName, liveCase.data && liveCase.data.event);

  // 5. 去抖:同 (type,url) 8 秒内重复注入被拒
  const dup = await api('/api/demo/line', { method: 'POST', body: { line: '2026-08-07 13:00:01  INFO url="https://live.bilibili.com/6" "Download workflow completed"', channel: 'download.log' } });
  check('去抖生效(重复行 422)', dup.status === 422, { status: dup.status, error: dup.data && dup.data.error });

  // 6. Webhook 端到端:注入事件 → 接收器收到完整 payload(带 url 避开与第 4 步的去抖键冲突)
  const baseCount = rc.received.length;
  const whTest = await api('/api/demo/line', { method: 'POST', body: { line: '2026-08-07 13:10:00  INFO url="https://live.bilibili.com/60213" "Submit successful"', channel: 'upload.log' } });
  check('webhook 推送 ok', whTest.data && whTest.data.result && whTest.data.result.ok === true, whTest.data && whTest.data.result);
  await new Promise(r => setTimeout(r, 300));
  const got = rc.received.length > baseCount ? rc.received[rc.received.length - 1] : null;
  check('webhook 收到新 payload', !!got, { base: baseCount, now: rc.received.length });
  if (got) {
    check('payload 字段齐全', ['event', 'type_label', 'streamer', 'url', 'time', 'channel', 'message', 'text'].every(k => k in got.body), got.body);
    check('payload 事件类型正确', got.body.event === 'upload_success', got.body.event);
    check('自定义 header 送达', got.headers['x-verify'] === 'yes', got.headers);
  }

  // 6b. 事件开关过滤:关闭 error 后注入 error 行应 skipped(不推送)
  const sw = await api('/api/config', { method: 'PUT', body: { events: { error: false } } });
  check('事件开关保存', sw.data && sw.data.config && sw.data.config.events && sw.data.config.events.error === false);
  const errOff = await api('/api/demo/line', { method: 'POST', body: { line: '2026-08-07 13:20:00 ERROR url="https://live.bilibili.com/6" "Process segment event failed: disk full"', channel: 'upload.log' } });
  check('error 开关关闭后跳过推送', errOff.data && errOff.data.event && errOff.data.event.type === 'error' && errOff.data.result && errOff.data.result.skipped === true, errOff.data && errOff.data.result);
  const sw2 = await api('/api/config', { method: 'PUT', body: { events: { error: true } } }); // 恢复
  check('事件开关恢复', sw2.data && sw2.data.config && sw2.data.config.events && sw2.data.config.events.error === true);

  // 7. 历史记录 + 重发
  const hist = await api('/api/history?limit=50');
  check('历史有记录', hist.data && hist.data.entries && hist.data.entries.length > 0, hist.data && hist.data.entries && hist.data.entries.length);
  const firstId = hist.data.entries[0].id;
  const retry = await api('/api/history/' + firstId + '/retry', { method: 'POST' });
  check('历史重发接口可用', retry.status === 200, retry.data);

  // 8. 事件流
  const evs = await api('/api/events');
  check('事件流非空', evs.data && evs.data.events && evs.data.events.length > 0);

  // ---- 清理测试数据 ----
  await api('/api/config', { method: 'PUT', body: { webhooks: [] } });
  await api('/api/history', { method: 'DELETE' });
  rc.server.close();

  console.log(results.join('\n'));
  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
