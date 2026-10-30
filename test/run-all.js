/* ============================================================
 * test/run-all.js —— 一口气跑完全部测试
 *
 * 每个测试文件是独立进程（jsdom 全局状态互不污染），
 * 汇总退出码：任何一个失败整体就是失败。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
const failures = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  // 每个测试文件自己会打 "通过 N 项，失败 M 项"，这里取最后一行
  const lines = String(r.stdout || '').trim().split('\n');
  const summary = (lines[lines.length - 1] || '').trim();
  const ok = r.status === 0;
  if (!ok) { failed++; failures.push(f); }
  console.log((ok ? '✓' : '✗') + ' ' + f.padEnd(24) + (summary || ('退出码 ' + r.status)));
}

console.log('─'.repeat(44));
if (failed) {
  console.log('失败的测试文件：' + failures.join('、'));
  process.exit(1);
}
console.log('全部 ' + files.length + ' 个测试文件通过');
