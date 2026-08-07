'use strict';
// 告警检查器:疑似空录制检测 + 磁盘空间预警
// 诚实降级:biliup 后端没有磁盘接口,磁盘预警基于本地录播目录探测(同机部署时可用,失败则跳过)
const { execFileSync } = require('child_process');
const config = require('./config');
const biliupClient = require('./biliup-client');

const MB = 1048576;
const GB = 1073741824;
const DISK_COOLDOWN_MS = 24 * 3600 * 1000; // 磁盘告警去抖:24h 一次

class AlertWatch extends (require('events').EventEmitter) {
  constructor() {
    super();
    this.timer = null;
    this.stopped = false;
    this.seen = new Set();       // 已见过的文件 key(name|updateTime|size)
    this.lastDiskAlert = 0;
  }

  start() {
    const a = config.get().alerts || {};
    const interval = Math.max(30, a.checkInterval || 600) * 1000;
    this.stopped = false;
    // 首次运行先建立基线(不误报历史文件),然后进入周期
    this._seedBaseline().then(() => {
      this.log('已启动,检查间隔 ' + Math.round(interval / 1000) + 's');
      this._tick();
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  log(msg) { console.log('[alert]', msg); }

  _emit(typeLabel, emoji, raw) {
    const event = {
      id: 'alert_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      type: 'alert',
      typeLabel,
      emoji,
      level: 'WARN',
      time: new Date().toISOString(),
      url: '',
      streamerName: '',
      channel: 'alerts',
      channelLabel: '告警检查',
      raw,
      source: 'alert-watch'
    };
    this.emit('alert', event);
  }

  async _seedBaseline() {
    try {
      const list = await biliupClient.fetchJson('/v1/videos');
      (list || []).forEach(v => this.seen.add(this._key(v)));
    } catch (e) { /* 后端不可达:基线为空,下次 tick 再试 */ }
  }

  _key(v) {
    return `${v.name || v.key}|${v.updateTime}|${v.size}`;
  }

  async _tick() {
    if (this.stopped) return;
    const a = config.get().alerts || {};
    try {
      if (a.emptyFileMB > 0) await this._checkEmptyFiles(a);
      if (a.diskPath) await this._checkDisk(a);
    } catch (e) {
      this.log('检查出错:' + e.message);
    }
    const interval = Math.max(30, a.checkInterval || 600) * 1000;
    if (!this.stopped) this.timer = setTimeout(() => this._tick(), interval);
  }

  async _checkEmptyFiles(a) {
    const list = await biliupClient.fetchJson('/v1/videos');
    const threshold = a.emptyFileMB * MB;
    for (const v of list || []) {
      const key = this._key(v);
      if (this.seen.has(key)) continue;
      this.seen.add(key); // 先登记,防重复告警
      if (Number(v.size) < threshold) {
        const name = String(v.name || v.key || '未知文件').split(/[\\/]/).pop();
        this.log(`疑似空录制: ${name} (${(v.size / MB).toFixed(2)} MB < ${a.emptyFileMB} MB)`);
        this._emit('疑似空录制', '⚠️', `疑似空录制: ${name}(${(v.size / MB).toFixed(2)} MB),小于阈值 ${a.emptyFileMB} MB,请检查是否录制异常`);
      }
    }
    // 控制 seen 集合大小(最多保留 2000 个键,防止内存膨胀)
    if (this.seen.size > 2000) {
      const arr = [...this.seen];
      this.seen = new Set(arr.slice(arr.length - 1000));
    }
  }

  async _checkDisk(a) {
    const freeGB = this._getFreeGB(a.diskPath);
    if (freeGB === null) { this.log('磁盘探测不可用,跳过'); return; }
    if (freeGB < a.diskFreeGB && Date.now() - this.lastDiskAlert > DISK_COOLDOWN_MS) {
      this.lastDiskAlert = Date.now();
      this.log(`磁盘剩余 ${freeGB.toFixed(1)} GB < ${a.diskFreeGB} GB,发出预警`);
      this._emit('磁盘空间不足', '💾', `磁盘剩余 ${freeGB.toFixed(1)} GB,低于预警线 ${a.diskFreeGB} GB,请及时清理录制文件`);
    }
  }

  _getFreeGB(p) {
    try {
      if (process.platform === 'win32') {
        const letter = String(p).replace(/^[\\/]+/, '').charAt(0).toUpperCase();
        if (!/^[A-Z]$/.test(letter)) return null;
        const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-PSDrive ${letter}).Free`], { encoding: 'utf8', timeout: 8000 });
        return parseFloat(out.trim()) / GB;
      } else {
        const out = execFileSync('df', ['-P', p], { encoding: 'utf8', timeout: 8000 });
        const line = out.trim().split('\n').pop();
        const kb = parseInt(line.split(/\s+/)[3], 10);
        if (!Number.isFinite(kb)) return null;
        return kb / 1048576; // KB → GB
      }
    } catch (e) {
      return null;
    }
  }
}

module.exports = { AlertWatch };
