'use strict';
// biliup 后端 REST API 客户端:主播列表 / 状态 / 视频
// 支持后端 --auth 认证:Session Cookie(biliup.sid),自动登录/注册,401 自动重登
const config = require('./config');

let streamersCache = { list: [], ts: 0 };
let infoCache = { list: [], ts: 0 };

// ---- 认证会话 ----
let sessionCookie = '';       // 形如 "biliup.sid=xxx"
let sessionExpireAt = 0;      // 会话过期时间(7 天,留 10 分钟余量提前重登)
let authDegraded = false;     // 后端未开 --auth 时降级为直连(仅本次运行)
let authDegradedBase = '';    // 降级时对应的 baseUrl(地址变化后重置)

function authConfig() {
  const a = (config.get().biliup || {}).auth || {};
  return a;
}

// 原生 fetch:不跟随重定向(login 成功返回 303 + Set-Cookie,跟随会丢失 cookie),以便捕获 Set-Cookie
async function rawFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeout || 8000);
  try {
    return await fetch(url, {
      redirect: 'manual',
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body,
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function captureSession(res) {
  // undici: getSetCookie() 返回所有 Set-Cookie;Node 18.14+
  let cookies = [];
  try { cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch (e) {}
  if (!cookies.length) {
    const raw = res.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  const sid = cookies.map(c => c.split(';')[0].trim()).find(c => c.startsWith('biliup.sid='));
  if (sid) {
    sessionCookie = sid;
    sessionExpireAt = Date.now() + (7 * 24 * 3600 - 600) * 1000;
    console.log('[biliup] 认证成功,已获取会话');
  } else {
    throw new Error('登录成功但未收到 biliup.sid 会话 Cookie');
  }
}

async function login() {
  const a = authConfig();
  const base = config.get().biliup.baseUrl.replace(/\/+$/, '');
  const creds = { username: a.username || 'biliup', password: a.password || '' };
  let res;
  try {
    res = await rawFetch(base + '/v1/users/login', { method: 'POST', body: JSON.stringify(creds) });
  } catch (e) {
    throw new Error(`biliup 登录失败(无法连接): ${e.message}`);
  }
  if (res.ok || res.status === 303) {
    // login 成功返回 303 Redirect(Set-Cookie 在该响应头),register 返回 200/201
    captureSession(res);
    return;
  }
  // 未开启 --auth 的后端没有 login 路由(404/405),降级直连
  if (res.status === 404 || res.status === 405) {
    throw new Error('LOGIN_ROUTE_MISSING');
  }
  // 登录失败(401 等)可能是用户不存在(首次部署)→ 尝试注册(注册成功即建会话)
  if (res.status === 401 || res.status === 400 || res.status === 403) {
    const reg = await rawFetch(base + '/v1/users/register', { method: 'POST', body: JSON.stringify(creds) });
    if (reg.ok) {
      captureSession(reg);
      return;
    }
  }
  const text = await res.text();
  throw new Error(`biliup 登录失败: HTTP ${res.status} ${text.slice(0, 120)}`);
}

async function ensureAuth() {
  const a = authConfig();
  const base = config.get().biliup.baseUrl;
  // baseUrl 变化 → 重置降级状态(可能指向了另一个带 --auth 的后端)
  if (authDegraded && authDegradedBase !== base) {
    authDegraded = false;
    authDegradedBase = '';
  }
  if (!a.enabled || authDegraded) return;
  if (sessionCookie && Date.now() < sessionExpireAt) return;
  sessionCookie = '';
  const err = await login().catch(e => e);
  if (err && err.message === 'LOGIN_ROUTE_MISSING') {
    // 后端未开启 --auth:认证路由不存在,静默降级为直连
    console.log(`[biliup] 后端未开启 --auth(${base}),直连模式`);
    authDegraded = true;
    authDegradedBase = base;
    return;
  }
  if (err) throw err;
}

async function fetchJson(path, opts = {}) {
  const base = config.get().biliup.baseUrl.replace(/\/+$/, '');
  await ensureAuth();
  const doRequest = async () => {
    const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
    if (sessionCookie) headers.Cookie = sessionCookie;
    return rawFetch(base + path, { ...opts, headers });
  };
  let res = await doRequest();
  if (res.status === 401 && sessionCookie) {
    // 会话失效 → 重新登录后重试一次
    sessionCookie = '';
    await ensureAuth();
    res = await doRequest();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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
