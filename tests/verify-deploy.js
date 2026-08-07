'use strict';
/* verify-deploy.js — 部署易用性回归:env 覆盖 / DATA_DIR / 部署配套文件 / 前端引导资源
   用法: node tests/verify-deploy.js(需服务已启动于 :4000) */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let passed = 0, failed = 0;
const results = [];
const check = (n, c, x) => { if (c) { passed++; results.push('PASS ' + n); } else { failed++; results.push('FAIL ' + n + (x ? ' => ' + JSON.stringify(x) : '')); } };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
async function api(p) { const r = await fetch(BASE + p); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; }

(async () => {
  // 1. 服务健康 + 前端 banner 资源
  const st = await api('/api/state');
  check('服务健康', st.status === 200 && st.data.backend.alive === true);
  check('index.html 含 banner', read('public/index.html').includes('setupBanner'));
  check('style.css 含 banner 样式', read('public/style.css').includes('.setup-banner'));
  check('app.js 含 banner 逻辑', read('public/app.js').includes('refreshSetupBanner'));

  // 2. env 覆盖(独立进程,含 PORT 数字类型回归)
  const r = spawnSync(process.execPath, ['-e', `
    process.env.BILIUP_NOTIFY_PORT='4999';
    process.env.BILIUP_NOTIFY_TELEGRAM_ENABLED='true';
    process.env.BILIUP_NOTIFY_TELEGRAM_BOTTOKEN='env-token';
    process.env.BILIUP_NOTIFY_PROXY='http://p:9';
    const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});
    const g = c.get();
    console.log(JSON.stringify({port: g.server.port, tg: g.telegram.enabled, token: g.telegram.botToken, proxy: g.network.proxy}));
  `], { encoding: 'utf8' });
  const o = JSON.parse(r.stdout.trim());
  check('env PORT 数字类型', o.port === 4999, o);
  check('env TELEGRAM_ENABLED', o.tg === true);
  check('env BOTTOKEN', o.token === 'env-token');
  check('env PROXY', o.proxy === 'http://p:9');

  // 3. DATA_DIR(config + history 落盘独立目录)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nvd-'));
  const d = spawnSync(process.execPath, ['-e', `
    process.env.BILIUP_NOTIFY_DATA_DIR = ${JSON.stringify(tmp)};
    const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});
    c.update({server: {port: 4321}});
    const h = require(${JSON.stringify(path.join(ROOT, 'src', 'history.js'))});
    h.record({id:'x',type:'test',typeLabel:'t',emoji:'',time:new Date().toISOString()}, {ok:true});
    const fs = require('fs');
    console.log(fs.existsSync(${JSON.stringify(path.join(tmp, 'config.json'))}) && fs.existsSync(${JSON.stringify(path.join(tmp, 'history.json'))}) ? 'BOTH' : 'PARTIAL');
  `], { encoding: 'utf8' });
  check('DATA_DIR config+history 落盘', /^BOTH$/.test(d.stdout.trim()), d.stdout);
  fs.rmSync(tmp, { recursive: true, force: true });

  // 4. 部署配套文件内容
  check('install.bat 检测 Node', read('install.bat').includes('where node'));
  check('install.bat winget 引导', read('install.bat').includes('winget install OpenJS.NodeJS.LTS'));
  check('start.bat 自装依赖', read('start.bat').includes('if not exist node_modules'));
  check('start.bat 提示可配地址', read('start.bat').includes('网页端') && read('start.bat').includes('修改'));
  check('Dockerfile node:20-alpine', read('Dockerfile').includes('FROM node:20-alpine'));
  check('Dockerfile 设 NO_OPEN', read('Dockerfile').includes('BILIUP_NOTIFY_NO_OPEN=1'));
  check('server.js 自动开浏览器', read('server.js').includes('BILIUP_NOTIFY_NO_OPEN') && read('server.js').includes('start "" http://localhost:'));
  check('compose 只含 notify 服务', !read('docker-compose.yml').includes('ghcr.io/biliup/caution:latest') && read('docker-compose.yml').includes('services:'));
  check('compose 地址 env 化', read('docker-compose.yml').includes('BILIUP_BASEURL:-http://host.docker.internal:19159'));
  check('compose 含 DATA_DIR 卷', read('docker-compose.yml').includes('BILIUP_NOTIFY_DATA_DIR') && read('docker-compose.yml').includes('./data/notify:/app/data'));
  check('.env.example 含 BILIUP_BASEURL', read('.env.example').includes('BILIUP_BASEURL'));
  check('前端含 biliup 地址输入框', read('public/index.html').includes('biliupBaseUrl'));
  check('app.js 采集 biliup 地址', read('public/app.js').includes("cfg.biliup.baseUrl = $('#biliupBaseUrl')"));
  check('server.js baseUrl 变更重启监听', read('server.js').includes('watcher.restart()'));
  check('log-watcher 有 restart', read('src/log-watcher.js').includes('restart()'));

  console.log(results.join('\n'));
  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(2); });
