'use strict';
/* verify-upload-prep.js — 上传准备自检:config.example.json 零凭据 + .gitignore 覆盖敏感文件
   用法: node tests/verify-upload-prep.js(需在项目根目录运行) */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { passed++; results.push('PASS ' + name); }
  else { failed++; results.push('FAIL ' + name + (extra ? ' => ' + JSON.stringify(extra) : '')); }
}

// 1. config.example.json:合法 JSON 且零凭据
let example;
try {
  example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  check('config.example.json 可解析', true);
} catch (e) {
  check('config.example.json 可解析', false, e.message);
}
if (example) {
  check('botToken 为空', example.telegram.botToken === '');
  check('chatIds 为空', example.telegram.chatIds === '');
  check('proxy 为空', example.network.proxy === '');
  check('webhooks 为空数组', Array.isArray(example.webhooks) && example.webhooks.length === 0);
  check('telegram 默认关闭', example.telegram.enabled === false);
}

// 2. .gitignore 覆盖敏感文件
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check('.gitignore 含 config.json', /(^|\n)config\.json($|\n)/m.test(gi));
check('.gitignore 含 history.json', /(^|\n)history\.json($|\n)/m.test(gi));
check('.gitignore 含 node_modules', gi.includes('node_modules/'));

// 3. 本地敏感文件确实存在(上传时须排除)
check('本地存在 config.json(待排除)', fs.existsSync(path.join(ROOT, 'config.json')));

console.log(results.join('\n'));
console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
