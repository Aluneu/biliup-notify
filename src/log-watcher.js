'use strict';
// biliup WebSocket 日志监听:并行监听 3 个日志频道,断线指数退避重连
const config = require('./config');

const CHANNELS = ['ds_update.log', 'download.log', 'upload.log'];

class LogWatcher extends (require('events').EventEmitter) {
  constructor() {
    super();
    this.clients = new Map(); // channel -> WebSocket
    this.states = new Map();  // channel -> { connected, retries, lastError, lastMsgAt }
    this.stopped = false;
    for (const ch of CHANNELS) {
      this.states.set(ch, { connected: false, retries: 0, lastError: '', lastMsgAt: 0, noFile: false });
    }
  }

  start() {
    if (!config.get().biliup.enabled) return;
    for (const ch of CHANNELS) this.connect(ch);
  }

  stop() {
    this.stopped = true;
    for (const [ch, ws] of this.clients) {
      try { ws.close(); } catch (e) {}
      this.clients.delete(ch);
    }
  }

  // 重启监听(biliup 地址变更后调用:断开旧连接,重置状态,重新连接)
  restart() {
    this.stop();
    this.stopped = false;
    this.states.clear();
    for (const ch of CHANNELS) {
      this.states.set(ch, { connected: false, retries: 0, lastError: '', lastMsgAt: 0, noFile: false });
    }
    this.emit('status', this.getStatus());
    this.start();
  }

  connect(channel) {
    if (this.stopped || !config.get().biliup.enabled) return;
    // 清理残留连接,避免 map 状态错乱
    const prev = this.clients.get(channel);
    if (prev && prev.readyState !== prev.CLOSED) {
      try { prev.close(); } catch (e) {}
    }
    const base = config.get().biliup.baseUrl.replace(/\/+$/, '');
    // ws:// → wss:// 处理
    const wsUrl = base.replace(/^http/, 'ws') + '/v1/ws/logs?file=' + encodeURIComponent(channel);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      this._scheduleReconnect(channel, e.message);
      return;
    }
    this.clients.set(channel, ws);
    const st = this.states.get(channel);

    ws.onopen = () => {
      st.connected = true;
      st.retries = 0;
      st.lastError = '';
      this.emit('status', this.getStatus());
      this.emit('log', `[${channel}] 已连接`);
    };

    ws.onmessage = (ev) => {
      st.lastMsgAt = Date.now();
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      // 日志文件不存在 → biliup 会立刻关闭连接,此时用长间隔重连(文件可能尚未生成)
      if (/日志文件.*不存在/.test(text)) {
        st.noFile = true;
        st.lastError = '日志文件尚未生成';
      } else {
        st.noFile = false;
      }
      this.emit('line', { channel, text });
    };

    ws.onerror = (ev) => {
      st.lastError = (ev && ev.message) || 'WebSocket error';
    };

    ws.onclose = (ev) => {
      st.connected = false;
      this.clients.delete(channel);
      this.emit('status', this.getStatus());
      const reason = (ev && (ev.reason || ev.code)) || '';
      this.emit('log', `[${channel}] 连接断开${reason ? ':' + reason : ''},准备重连`);
      this._scheduleReconnect(channel, reason);
    };
  }

  _scheduleReconnect(channel, errMsg) {
    if (this.stopped || !config.get().biliup.enabled) return;
    const st = this.states.get(channel);
    st.retries += 1;
    const baseDelay = Math.max(1, config.get().biliup.reconnectBaseDelay || 3);
    // 文件不存在时:长间隔慢速探测(30s),文件生成后会自动连上
    if (st.noFile) {
      st.lastError = '日志文件尚未生成,30s 后重试';
      this.emit('log', `[${channel}] 日志文件尚未生成,30s 后重试`);
      setTimeout(() => this.connect(channel), 30000);
      this.emit('status', this.getStatus());
      return;
    }
    const delay = Math.min(60, baseDelay * Math.pow(2, Math.min(st.retries, 4)));
    if (errMsg) st.lastError = String(errMsg);
    setTimeout(() => this.connect(channel), delay * 1000);
  }

  getStatus() {
    const out = {};
    for (const [ch, st] of this.states) {
      out[ch] = {
        connected: st.connected,
        retries: st.retries,
        lastError: st.lastError,
        lastMsgAt: st.lastMsgAt ? new Date(st.lastMsgAt).toISOString() : null
      };
    }
    return out;
  }
}

module.exports = { LogWatcher, CHANNELS };
