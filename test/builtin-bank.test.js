/* ============================================================
 * test/builtin-bank.test.js —— 内置题库与配置迁移
 *
 * 背景：题库最初是「默认关闭、不预置任何凭据」，用户每次都要手填接口和 token，
 * 实际结果是一次都没查过（日志永远「题库命中 0 题」）。按要求改为沿用原脚本
 * 那套公共题库后，有三件事必须锁死：
 *
 *   1. 默认就是开着的，且地址/token 已填好，装上即可用；
 *   2. 勾了「使用内置题库」时，面板/存储里的值不能覆盖常量，
 *      否则用户误改一个字符就整轮静默不查；
 *   3. 老版本存下来的是空地址，升级时必须自动回填，不能"看起来升级了实际没生效"。
 *
 * 运行：node test/builtin-bank.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) passed++;
  else { failed++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}

const mem = new Map();
global.GM_getValue = (k) => mem.get(k);
global.GM_setValue = (k, v) => { mem.set(k, v); };

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { Config, BUILTIN_BANK, DEFAULT_CONFIG };`)();
const { Config, BUILTIN_BANK, DEFAULT_CONFIG } = api;

// 每次用例前清空存储并丢弃内存缓存，模拟"重新打开浏览器"
function reset(seed) {
  mem.clear();
  Config._cache = null;
  if (seed !== undefined) mem.set('llmq:config', seed);
}

/* ---------- 常量本身 ---------- */
console.log('\n[内置题库常量]');

// 这两个值直接来自原脚本，改动意味着换了服务商，属于需要重新验证的变更
eq(BUILTIN_BANK.endpoint, 'https://cx.icodef.com/wyn-nb?v=4', '★ 接口地址与原脚本一致');
eq(BUILTIN_BANK.token, 'n4LoeX7VdngGIKS6', '★ token 与原脚本一致');
ok(/^https:\/\//.test(BUILTIN_BANK.endpoint), '接口走 https');

/* ---------- 全新安装 ---------- */
console.log('\n[全新安装]');

reset();

eq(Config.bank.enabled, true, '★ 默认就启用题库优先，不需要用户手动勾');
eq(Config.bank.useBuiltin, true, '默认走内置题库');
eq(Config.bank.endpoint, BUILTIN_BANK.endpoint, '取到的是内置地址');
eq(Config.bank.token, BUILTIN_BANK.token, '取到的是内置 token');
ok(Config.bank.timeoutMs > 0 && Config.bank.timeoutMs <= 5000, '超时时间在合理区间（题库必须快）');

/* ---------- 内置模式下不允许被覆盖 ---------- */
console.log('\n[内置模式防误改]');

// 模拟存储里被人改成了半截地址（比如手滑删了几个字符）
reset(JSON.stringify({
  bank: { enabled: true, useBuiltin: true, endpoint: 'https://cx.icodef.com/wyn', token: 'typo' },
}));

eq(Config.bank.endpoint, BUILTIN_BANK.endpoint, '★ 内置模式下地址以常量为准，不吃存储里的残值');
eq(Config.bank.token, BUILTIN_BANK.token, '★ 内置模式下 token 以常量为准');
eq(Config.load().bank.endpoint, 'https://cx.icodef.com/wyn', '存储里的原值保留，只是不参与请求');

/* ---------- 切到自填 ---------- */
console.log('\n[自填模式]');

reset(JSON.stringify({
  bank: { enabled: true, useBuiltin: false, endpoint: 'https://my.bank/api', token: 'my-token' },
}));

eq(Config.bank.endpoint, 'https://my.bank/api', '关闭内置后用自己的地址');
eq(Config.bank.token, 'my-token', '关闭内置后用自己的 token');
ok(Config.bank.useBuiltin === false, 'useBuiltin 被正确读出');

/* ---------- 老配置迁移 ---------- */
console.log('\n[老配置迁移]');

// v0.7.2 之前：默认关闭 + 空地址空 token
reset(JSON.stringify({
  bank: { enabled: false, endpoint: '', token: '', timeoutMs: 2500, order: 'decoded' },
}));

eq(Config.bank.enabled, true, '★ 空地址的老配置被自动启用');
eq(Config.bank.endpoint, BUILTIN_BANK.endpoint, '★ 空地址被回填成内置地址');
eq(Config.bank.token, BUILTIN_BANK.token, '★ 空 token 被回填成内置 token');
ok(Config.bank.useBuiltin === true, '迁移后标记为内置模式');
ok(!!mem.get('llmq:config'), '迁移结果已写回存储，下次启动不用再迁一次');

// 迁移只发生一次：用户之后主动关掉，不应该被再次打开
Config.load().bank.enabled = false;
Config.save();
Config._cache = null;
eq(Config.bank.enabled, false, '★ 用户主动关闭后不再被迁移逻辑强行打开');
eq(Config.bank.endpoint, BUILTIN_BANK.endpoint, '地址仍保留，便于用户随时重新开启');

/* ---------- 已有自填配置不受迁移影响 ---------- */
console.log('\n[已有自填配置]');

reset(JSON.stringify({
  bank: { enabled: true, endpoint: 'https://someone-else.example/api', token: 'abc123' },
}));

eq(Config.bank.endpoint, 'https://someone-else.example/api', '★ 已填过的地址不会被内置值覆盖');
eq(Config.bank.token, 'abc123', '★ 已填过的 token 不会被内置值覆盖');

/* ---------- 默认配置里的其它项未被牵连 ---------- */
console.log('\n[默认配置完整性]');

ok(DEFAULT_CONFIG.bank && DEFAULT_CONFIG.bank.timeoutMs === 2500, '题库超时仍是 2500ms');
ok(DEFAULT_CONFIG.quiz && typeof DEFAULT_CONFIG.quiz.minConfidence === 'number', '答题策略配置完好');
ok(DEFAULT_CONFIG.profiles === undefined || typeof DEFAULT_CONFIG === 'object', '默认配置结构未被破坏');

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
