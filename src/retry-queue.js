'use strict';
// 推送持久化重试队列:失败的推送落盘,后台定时重投,成功才移除
// 数据文件: DATA_DIR/pending-queue.json
const fs = require('fs');
const path = require('path');
const config = require('./config');
const notifier = require('./notifier');

const QUEUE_FILE = path.join(config.DATA_DIR, 'pending-queue.json');
const MAX_ATTEMPTS = 10;        // 单条消息最大重试次数
const DEFAULT_INTERVAL_MS = 60 * 1000; // 重投间隔

let items = [];
let loaded = false;
let timer = null;
let running = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    items = JSON.parse(raw).items || [];
  } catch (e) {
    items = [];
  }
}

function save() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({ items }, null, 2), 'utf8');
  } catch (e) { /* 磁盘失败不阻塞 */ }
}

// 记录一次失败的推送(有真实通道尝试但失败)
function enqueue(event, result) {
  load();
  // 只入队"尝试过且失败"的;skipped(未启用通道)与成功的不入队
  if (!result || result.skipped) return null;
  if (result.ok) return null;
  const entry = {
    id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    event,
    reason: result.reason || (result.results || []).filter(r => !r.ok).map(r => `${r.channel}:${r.error || r.reason || ''}`).join('; ') || '未知错误',
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastAttemptAt: null,
    dead: false
  };
  items.unshift(entry);
  save();
  return entry;
}

// 立即重投队列(或指定单条)
async function retryAll(onlyId) {
  load();
  const targets = onlyId ? items.filter(i => i.id === onlyId) : items;
  if (!targets.length) return { retried: 0, ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (const entry of targets) {
    if (entry.dead) continue;
    // 重投绕过推送级去重(重投是"必须送达"操作)
    const result = await notifier.dispatch(entry.event, { skipDedup: true });
    entry.attempts += 1;
    entry.lastAttemptAt = new Date().toISOString();
    if (result.ok) {
      items = items.filter(i => i.id !== entry.id);
      ok++;
    } else {
      if (entry.attempts >= MAX_ATTEMPTS) {
        entry.dead = true;
        entry.reason += ` (已重试 ${entry.attempts} 次,放弃)`;
      }
      failed++;
    }
    save();
  }
  return { retried: targets.length, ok, failed };
}

// 后台定时重投循环(60s 一次,幂等防重入)
function startRetryLoop() {
  if (timer) return;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      if (listActive().length) {
        const r = await retryAll();
        if (r.retried > 0) console.log(`[queue] 重投完成: 成功 ${r.ok} / 失败 ${r.failed}`);
      }
    } catch (e) {
      console.error('[queue] 重投异常:', e.message);
    } finally {
      running = false;
    }
    timer = setTimeout(loop, DEFAULT_INTERVAL_MS);
  };
  timer = setTimeout(loop, DEFAULT_INTERVAL_MS);
}

function stopRetryLoop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

function listActive() {
  load();
  return items.filter(i => !i.dead);
}

function listAll() {
  load();
  return items;
}

function clear() {
  load();
  items = [];
  save();
  return true;
}

function remove(id) {
  load();
  const before = items.length;
  items = items.filter(i => i.id !== id);
  if (items.length !== before) save();
  return items.length !== before;
}

module.exports = { enqueue, retryAll, startRetryLoop, stopRetryLoop, listActive, listAll, clear, remove };
