'use strict';
// biliup 后端 REST API 客户端:主播列表 / 状态 / 视频
const config = require('./config');

let streamersCache = { list: [], ts: 0 };
let infoCache = { list: [], ts: 0 };

async function fetchJson(path, opts = {}) {
  const base = config.get().biliup.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const res = await fetch(base + path, {
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
      method: opts.method || 'GET',
      body: opts.body,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// 主播列表(带 60s 缓存)
async function getStreamers(force = false) {
  const now = Date.now();
  const cacheMs = (config.get().biliup.refreshStreamersInterval || 60) * 1000;
  if (!force && streamersCache.list.length && now - streamersCache.ts < cacheMs) {
    return streamersCache.list;
  }
  const list = await fetchJson('/v1/streamers');
  streamersCache = { list: list || [], ts: now };
  return streamersCache.list;
}

// 主播实时信息(status / upload_status / title 等)
async function getStreamerInfo(force = false) {
  const now = Date.now();
  if (!force && infoCache.list.length && now - infoCache.ts < 15000) {
    return infoCache.list;
  }
  const list = await fetchJson('/v1/streamer-info');
  infoCache = { list: list || [], ts: now };
  return infoCache.list;
}

// 根据 url 找主播备注名(remark 优先,其次 title,最后 url 里的房号)
async function resolveStreamerName(url, extra = {}) {
  if (!url) return '';
  try {
    const streamers = await getStreamers();
    const hit = streamers.find(s => s.url === url || (url && s.url && s.url.replace(/\/+$/, '') === url.replace(/\/+$/, '')));
    if (hit && (hit.remark || hit.name)) return hit.remark || hit.name;
    const info = await getStreamerInfo();
    const hit2 = info.find(i => i.url === url);
    if (hit2 && (hit2.title || hit2.name)) return hit2.title || hit2.name;
  } catch (e) { /* 后端不可达时静默 */ }
  // 兜底:从 url 提取房号
  const m = String(url || '').match(/(\d+)/);
  return m ? `直播间 ${m[1]}` : (extra.fallbackName || url || '未知主播');
}

// 健康检查:后端是否可达
async function ping() {
  try {
    await fetchJson('/v1/status', { timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { fetchJson, getStreamers, getStreamerInfo, resolveStreamerName, ping };
