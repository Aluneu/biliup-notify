'use strict';
/* biliup-notify 网页端 */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let state = { config: null, hist: [] };
let saveDirty = false;

/* ---------- 工具 ---------- */
function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function fmtTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Tab ---------- */
$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  $$('.tab').forEach(t => t.classList.toggle('active', t === btn));
  $$('.panel').forEach(p => p.classList.remove('active'));
  $('#panel-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'history') loadHistory();
  if (btn.dataset.tab === 'config') loadConfig();
});
$('#btnGoConfig').addEventListener('click', () => {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'config'));
  $$('.panel').forEach(p => p.classList.remove('active'));
  $('#panel-config').classList.add('active');
  loadConfig();
});

// 未配置引导:无任何可用推送通道时显示
function refreshSetupBanner() {
  const banner = $('#setupBanner');
  if (!banner || !state.config) return;
  const tg = state.config.telegram || {};
  const hooks = (state.config.webhooks || []).filter(h => h && h.url && h.enabled !== false);
  const hasChannel = (tg.enabled && tg.botToken && tg.chatIds) || hooks.length > 0;
  banner.hidden = hasChannel;
}

/* ---------- 状态轮询 ---------- */
async function pollState() {
  try {
    const s = await api('/api/state');
    // 后端
    const bd = $('#backendDot'), bt = $('#backendText');
    bd.className = 'dot ' + (s.backend.alive ? 'ok' : 'err');
    bt.textContent = s.backend.alive ? '后端在线' : '后端离线';
    $('#ovBackend').textContent = s.backend.alive ? '在线' : '离线';
    $('#ovBaseUrl').textContent = s.backend.baseUrl;
    $('#ovUptime').textContent = Math.floor(s.service.uptime / 60) + ' 分钟';
    $('#ovHistTotal').textContent = s.stats.historyTotal;
    $('#ovEvtCount').textContent = s.stats.recentEvents;
    // WS 通道
    const wsNames = ['ds_update.log', 'download.log', 'upload.log'];
    let anyOk = 0, anyErr = 0;
    $('#ovWs').innerHTML = wsNames.map(ch => {
      const w = s.ws[ch] || { connected: false };
      let cls = 'pending', label = '未连接';
      if (w.connected) { cls = 'ok'; label = '已连接'; anyOk++; }
      else if (w.retries > 0) { cls = 'err'; label = '重连中'; anyErr++; }
      return `<div class="ws-row"><span class="ws-name">${ch}</span><span class="ws-state ${cls}">${label}</span></div>`;
    }).join('');
    const wd = $('#wsDot'), wt = $('#wsText');
    if (anyOk === 3) { wd.className = 'dot ok'; wt.textContent = '监听正常'; }
    else if (anyOk > 0) { wd.className = 'dot ok'; wt.textContent = `监听 ${anyOk}/3`; }
    else if (anyErr > 0) { wd.className = 'dot err'; wt.textContent = '重连中'; }
    else { wd.className = 'dot off'; wt.textContent = '未连接'; }
  } catch (e) {
    $('#backendDot').className = 'dot err';
    $('#backendText').textContent = '服务异常';
  }
}
setInterval(pollState, 5000);
pollState();

/* ---------- 时钟 ---------- */
setInterval(() => { const el = $('#ovClock'); if (el) el.textContent = new Date().toLocaleString('zh-CN', { hour12: false }); }, 1000);

/* ---------- 事件列表 ---------- */
async function loadEvents() {
  try {
    const { events } = await api('/api/events');
    const box = $('#eventList');
    if (!events.length) { box.innerHTML = '<div class="empty">暂无事件,等待 biliup 产生日志…</div>'; return; }
    box.innerHTML = events.map(ev => `
      <div class="event-item">
        <span class="ev-emoji">${ev.emoji}</span>
        <div class="ev-main">
          <div class="ev-title">
            <span class="ev-type">${esc(ev.typeLabel)}</span>
            <span class="ev-name">${esc(ev.streamerName || ev.url || '')}</span>
            <span class="ev-time">${fmtTime(ev.time)}</span>
          </div>
          <div class="ev-raw" title="${esc(ev.raw)}">${esc(ev.channelLabel)} · ${esc(ev.raw)}</div>
        </div>
      </div>`).join('');
  } catch (e) { /* ignore */ }
}
$('#btnRefreshEvents').addEventListener('click', loadEvents);
setInterval(loadEvents, 15000);
loadEvents();

/* ---------- 演示注入 ---------- */
$('#btnDemoInject').addEventListener('click', async () => {
  const line = $('#demoLine').value.trim();
  if (!line) { toast('请先填写要注入的日志行', false); return; }
  try {
    const r = await api('/api/demo/line', { method: 'POST', body: { line, channel: $('#demoChannel').value } });
    if (!r.event) { toast('无法解析该行（未命中关键词或与 8 秒内同类事件去抖）', false); return; }
    toast(`已解析事件: ${r.event.emoji} ${r.event.typeLabel} → ` + (r.result.skipped ? '无通道启用' : (r.result.ok ? '推送成功' : '推送失败')));
    loadEvents(); loadHistory();
  } catch (e) { toast(e.message, false); }
});

/* ---------- 配置 ---------- */
const EVENT_ORDER = [
  ['streamer_live', '🔴', '主播开播'],
  ['streamer_offline', '⚫', '主播下播'],
  ['record_start', '⏺️', '开始录制'],
  ['record_stop', '✅', '录制完成'],
  ['upload_start', '📤', '开始上传'],
  ['upload_success', '🎉', '投稿成功'],
  ['error', '⚠️', '出错']
];

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    $('#tgEnabled').checked = !!cfg.telegram.enabled;
    $('#tgToken').value = cfg.telegram.botToken || '';
    $('#tgChatIds').value = cfg.telegram.chatIds || '';
    $('#tgBotControl').checked = cfg.telegram.botControl !== false;
    $('#netProxy').value = (cfg.network && cfg.network.proxy) || '';
    $('#biliupBaseUrl').value = (cfg.biliup && cfg.biliup.baseUrl) || '';
    const al = cfg.alerts || {};
    $('#alertEmptyMB').value = al.emptyFileMB ?? 1;
    $('#alertDiskPath').value = al.diskPath || '';
    $('#alertDiskGB').value = al.diskFreeGB ?? 5;
    $('#alertInterval').value = al.checkInterval ?? 600;
    renderHooks(cfg.webhooks || []);
    renderEventSwitches(cfg.events || {});
    refreshSetupBanner();
    saveDirty = false;
  } catch (e) { toast('加载配置失败: ' + e.message, false); }
}

function renderEventSwitches(events) {
  $('#eventSwitches').innerHTML = EVENT_ORDER.map(([key, emoji, label]) => `
    <div class="event-switch">
      <span class="es-label"><span class="es-emoji">${emoji}</span>${label}</span>
      <label class="switch">
        <input type="checkbox" data-evkey="${key}" ${events[key] === false ? '' : 'checked'}>
        <span class="track"></span>
      </label>
    </div>`).join('');
}

function renderHooks(hooks) {
  const box = $('#hookList');
  if (!hooks.length) {
    box.innerHTML = '<div class="empty" style="padding:14px 0">尚未配置 Webhook,点击右上角添加</div>';
    return;
  }
  box.innerHTML = hooks.map((h, i) => {
    const hdrStr = Object.entries(h.headers || {}).map(([k, v]) => `${k}=${v}`).join(',');
    return `
    <div class="hook-item" data-hook-index="${i}">
      <div class="hook-head">
        <span class="hook-index">#${i + 1}</span>
        <input type="text" class="name" data-hk="name" value="${esc(h.name)}" placeholder="名称,如: 企业微信">
        <label class="switch">
          <input type="checkbox" data-hk="enabled" ${h.enabled === false ? '' : 'checked'}>
          <span class="track"></span>
        </label>
        <button class="hook-del" data-hk="del" title="删除">✕</button>
      </div>
      <input type="text" class="url" data-hk="url" value="${esc(h.url)}" placeholder="https://example.com/webhook">
      <div class="hook-headers">
        <input type="text" data-hk="hk" value="${esc(hdrStr)}" placeholder="自定义 Header: Key=Value,多个用逗号分隔 (可选)">
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-hk="del"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.hook-item');
      const idx = +item.dataset.hookIndex;
      state.config.webhooks.splice(idx, 1);
      renderHooks(state.config.webhooks);
      saveDirty = true;
    });
  });
}

$('#btnAddHook').addEventListener('click', () => {
  if (!state.config) return;
  state.config.webhooks.push({ name: '', url: '', enabled: true, headers: {}, timeout: 10 });
  renderHooks(state.config.webhooks);
  saveDirty = true;
});

// 收集表单 → config patch
function collectConfig() {
  const cfg = JSON.parse(JSON.stringify(state.config || {}));
  cfg.telegram = cfg.telegram || {};
  cfg.telegram.enabled = $('#tgEnabled').checked;
  cfg.telegram.botToken = $('#tgToken').value.trim();
  cfg.telegram.chatIds = $('#tgChatIds').value.trim();
  cfg.telegram.botControl = $('#tgBotControl').checked;
  cfg.network = cfg.network || {};
  cfg.network.proxy = $('#netProxy').value.trim();
  cfg.biliup = cfg.biliup || {};
  cfg.biliup.baseUrl = $('#biliupBaseUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:19159';
  cfg.alerts = {
    emptyFileMB: Math.max(0, parseFloat($('#alertEmptyMB').value) || 0),
    diskPath: $('#alertDiskPath').value.trim(),
    diskFreeGB: Math.max(0, parseFloat($('#alertDiskGB').value) || 0),
    checkInterval: Math.max(30, parseInt($('#alertInterval').value) || 600)
  };
  // 事件开关
  cfg.events = cfg.events || {};
  $$('#eventSwitches input[data-evkey]').forEach(inp => {
    cfg.events[inp.dataset.evkey] = inp.checked;
  });
  // Webhook
  cfg.webhooks = $$('.hook-item').map(item => {
    const g = k => item.querySelector(`[data-hk="${k}"]`);
    const hdrStr = g('hk').value.trim();
    const headers = {};
    if (hdrStr) {
      hdrStr.split(',').forEach(kv => {
        const i = kv.indexOf('=');
        if (i > 0) headers[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });
    }
    return {
      id: (g('name').value || 'hook').toLowerCase().replace(/\s+/g, '-'),
      name: g('name').value.trim(),
      url: g('url').value.trim(),
      enabled: g('enabled').checked,
      headers,
      timeout: 10
    };
  }).filter(h => h.url);
  return cfg;
}

$('#btnSave').addEventListener('click', async () => {
  try {
    const patch = collectConfig();
    const r = await api('/api/config', { method: 'PUT', body: patch });
    state.config = r.config;
    refreshSetupBanner();
    saveDirty = false;
    toast('配置已保存');
  } catch (e) { toast('保存失败: ' + e.message, false); }
});

$('#btnReset').addEventListener('click', async () => {
  if (!confirm('恢复默认配置?当前配置将被覆盖。')) return;
  try {
    const r = await api('/api/config/reset', { method: 'POST' });
    state.config = r.config;
    $('#tgEnabled').checked = false;
    $('#tgToken').value = '';
    $('#tgChatIds').value = '';
    $('#tgBotControl').checked = true;
    $('#netProxy').value = '';
    $('#biliupBaseUrl').value = 'http://localhost:19159';
    $('#alertEmptyMB').value = 1;
    $('#alertDiskPath').value = '';
    $('#alertDiskGB').value = 5;
    $('#alertInterval').value = 600;
    renderHooks([]);
    renderEventSwitches(r.config.events);
    toast('已恢复默认配置');
  } catch (e) { toast(e.message, false); }
});

$('#btnTest').addEventListener('click', async () => {
  // 先保存当前表单
  try {
    const patch = collectConfig();
    const r = await api('/api/config', { method: 'PUT', body: patch });
    state.config = r.config;
  } catch (e) { toast('保存配置失败: ' + e.message, false); return; }
  toast('正在发送测试推送…');
  try {
    const r = await api('/api/test', { method: 'POST', body: { channel: 'all', eventType: 'record_stop' } });
    if (r.skipped) toast('没有已启用的推送通道,请先配置并开启', false);
    else if (r.ok) toast('测试推送成功 ✅');
    else {
      const fails = (r.results || []).filter(x => !x.ok).map(x => (x.target || x.label) + ': ' + (x.error || x.reason)).join('; ');
      toast('部分失败: ' + fails, false);
    }
    loadHistory();
  } catch (e) { toast(e.message, false); }
});

/* ---------- 历史 ---------- */
async function loadHistory() {
  try {
    const { entries } = await api('/api/history?limit=100');
    state.hist = entries;
    $('#histCount').textContent = entries.length ? `共 ${entries.length} 条` : '';
    const box = $('#historyList');
    if (!entries.length) { box.innerHTML = '<div class="empty">暂无推送记录</div>'; return; }
    box.innerHTML = entries.map(h => {
      const r = h.result;
      let badge = '<span class="hist-result skip">未推送</span>';
      if (r.skipped) badge = `<span class="hist-result skip">跳过</span>`;
      else if (r.ok) badge = '<span class="hist-result ok">成功</span>';
      else badge = '<span class="hist-result fail">失败</span>';
      const summary = r.summary
        ? `TG:${r.summary.telegram} / WH:${r.summary.webhook}`
        : (r.reason || '');
      return `
      <div class="hist-item">
        <span class="ev-emoji">${h.event.emoji || '🔔'}</span>
        ${badge}
        <div class="ev-main">
          <div class="ev-title">
            <span class="ev-type">${esc(h.event.typeLabel)}</span>
            <span class="ev-name">${esc(h.event.streamerName || h.event.url || '')}</span>
          </div>
          <div class="hist-detail" title="${esc(summary)}">${esc(summary || h.event.raw || '')}</div>
        </div>
        <span class="ev-time">${fmtTime(h.time)}</span>
        <div class="hist-actions">
          <button class="btn ghost sm" data-retry="${h.id}" title="重发">重发</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-retry]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const r = await api('/api/history/' + btn.dataset.retry + '/retry', { method: 'POST' });
          toast(r.result && r.result.skipped ? '该事件未启用推送通道' : (r.result && r.result.ok ? '重发成功 ✅' : '重发失败 ❌'), !!(r.result && r.result.ok));
          loadHistory();
        } catch (e) { toast(e.message, false); }
      });
    });
  } catch (e) { /* ignore */ }
}
$('#btnRefreshHist').addEventListener('click', loadHistory);
$('#btnClearHist').addEventListener('click', async () => {
  if (!confirm('清空全部推送历史?')) return;
  try { await api('/api/history', { method: 'DELETE' }); toast('已清空'); loadHistory(); }
  catch (e) { toast(e.message, false); }
});

// 表单变更标记
['tgEnabled', 'tgToken', 'tgChatIds', 'tgBotControl', 'netProxy', 'biliupBaseUrl', 'alertEmptyMB', 'alertDiskPath', 'alertDiskGB', 'alertInterval'].forEach(id => {
  $('#' + id).addEventListener('change', () => saveDirty = true);
  $('#' + id).addEventListener('input', () => saveDirty = true);
});

// 初始加载配置 → 刷新引导 banner
api('/api/config').then(cfg => {
  state.config = cfg;
  refreshSetupBanner();
}).catch(() => {});
