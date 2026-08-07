'use strict';
// 推送历史:内存环形缓冲 + 落盘持久化
const fs = require('fs');
const path = require('path');
const config = require('./config');

// 数据目录:默认项目根目录;Docker 等场景用环境变量 BILIUP_NOTIFY_DATA_DIR 指向挂载卷
const DATA_DIR = process.env.BILIUP_NOTIFY_DATA_DIR || path.join(__dirname, '..');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const MAX_KEEP = 500;

let entries = [];
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    entries = JSON.parse(raw).entries || [];
  } catch (e) {
    entries = [];
  }
}

function save() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({ entries }, null, 2), 'utf8');
  } catch (e) { /* 磁盘失败不阻塞推送 */ }
}

// 记录一次推送(含各通道结果)
function record(event, result) {
  load();
  const max = Math.min(config.get().history.maxEntries || 200, MAX_KEEP);
  entries.unshift({
    id: 'h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    event,
    result: {
      ok: !!result.ok,
      skipped: !!result.skipped,
      reason: result.reason || null,
      summary: result.summary || null,
      details: result.results || null
    },
    time: new Date().toISOString()
  });
  if (entries.length > max) entries = entries.slice(0, max);
  save();
  return entries[0];
}

function list(limit = 100) {
  load();
  return entries.slice(0, limit);
}

function clear() {
  load();
  entries = [];
  save();
  return true;
}

function getById(id) {
  load();
  return entries.find(e => e.id === id) || null;
}

function remove(id) {
  load();
  const before = entries.length;
  entries = entries.filter(e => e.id !== id);
  if (entries.length !== before) save();
  return entries.length !== before;
}

module.exports = { record, list, clear, getById, remove };
