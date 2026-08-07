// build-exe.mjs — 打包 biliup-notify 为 Windows 单文件 exe(Node SEA)
// 用法: node scripts/build-exe.mjs
// 产物: dist/biliup-notify-windows-x64.zip(含 biliup-notify.exe + public/ + 说明)
import { build } from 'esbuild';
import { execSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const require = createRequire(import.meta.url);

const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const OUT_CJS = path.join(DIST, 'biliup-notify.cjs');
const BLOB = path.join(DIST, 'sea-prep.blob');
const EXE = path.join(DIST, 'biliup-notify.exe');
const ZIP = path.join(DIST, 'biliup-notify-windows-x64.zip');

function step(msg) { console.log(`\n== ${msg} ==`); }
function run(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.status !== 0) { console.error(`[FAIL] ${cmd} ${args.join(' ')}`); process.exit(1); }
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. esbuild bundle(server + src + express + undici → 单 CJS)
step('esbuild bundle');
await build({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: OUT_CJS,
  banner: { js: "#!/usr/bin/env node\n'use strict';" },
  logLevel: 'info'
});

// 2. SEA 配置
step('SEA config');
writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
  main: OUT_CJS,
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  useSnapshot: false
}, null, 2));

// 3. 生成 blob(cwd 必须在 dist,sea-config.json 在那里)
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], DIST);

// 4. 复制 node.exe 为产物
step('copy node.exe');
const nodeExe = process.execPath; // 当前 node.exe(CI 中即 Windows node)
copyFileSync(nodeExe, EXE);

// 5. postject 注入 blob
step('postject inject');
const postjectBin = require.resolve('postject/dist/cli.js');
run(process.execPath, [postjectBin, EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', SENTINEL]);

// 6. 打 zip(exe + public/ + 说明)
step('zip');
const { default: archiver } = await import('archiver').catch(() => ({ default: null }));
if (archiver) {
  const out = createWriteStream(ZIP);
  const ar = archiver('zip', { zlib: { level: 9 } });
  ar.pipe(out);
  ar.file(EXE, { name: 'biliup-notify.exe' });
  ar.directory(path.join(ROOT, 'public'), 'public');
  ar.file(path.join(ROOT, 'README.md'), { name: 'README.md' });
  await ar.finalize();
  await new Promise(r => out.on('close', r));
} else {
  // 兜底:PowerShell Compress-Archive
  const tmp = path.join(DIST, 'zip-tmp');
  mkdirSync(tmp, { recursive: true });
  copyFileSync(EXE, path.join(tmp, 'biliup-notify.exe'));
  execSync(`xcopy /E /I /Y "${path.join(ROOT, 'public')}" "${path.join(tmp, 'public')}"`, { stdio: 'ignore' });
  copyFileSync(path.join(ROOT, 'README.md'), path.join(tmp, 'README.md'));
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${tmp}\\*' -DestinationPath '${ZIP}' -Force"`, { stdio: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
}

const statSize = existsSync(ZIP) ? (await import('fs')).statSync(ZIP).size : 0;
console.log(`\n✅ 完成: ${ZIP} (${(statSize / 1048576).toFixed(1)} MB)`);
