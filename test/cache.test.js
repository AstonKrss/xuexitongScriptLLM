/* ============================================================
 * test/cache.test.js —— 答案缓存（版本化 + 类型校验）
 *
 * 这两个机制都来自一次真实的误判：
 *
 *   1. v0.7.1 之前多选题被误判成单选，只点第一个选项。这些**错误答案被
 *      原样存进了缓存**。修好判定逻辑后缓存照旧命中，日志里多选题还是只显示
 *      一个字母——改代码看不出问题，因为根本没走到匹配逻辑。
 *   2. 同理，判断题如果用奇怪的形态存进去（比如 "正确" 而不是 "true"），
 *      命中后也会填错。
 *
 * 所以缓存必须做两件事：规则变更时整库作废（键带版本号），以及读取时校验
 * 类型是否与题型匹配。
 *
 * 运行：node test/cache.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '50-matcher.js', '60-cache.js'];

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
const api = new Function(`${code}\nreturn { AnswerCache, Config };`)();
const Cache = api.AnswerCache;

function reset() {
  mem.clear();
  Cache._data = null;
  Cache._dirty = false;
  api.Config._cache = null;
  api.Config.load().quiz.useCache = true;
}

function mkQ(type, stem) {
  return {
    type: type,
    stem: stem || '中国的首都是哪座城市',
    options: [
      { key: 'A', text: '上海' },
      { key: 'B', text: '北京' },
      { key: 'C', text: '广州' },
      { key: 'D', text: '深圳' },
    ],
  };
}

/* ---------- 基本读写 ---------- */
console.log('\n[基本读写]');

reset();
{
  const q = mkQ('single');
  ok(Cache.get(q) === null, '空缓存返回 null');

  Cache.set(q, { choice: 'B', text: '北京', confidence: 0.95 });
  const hit = Cache.get(q);
  eq(hit.choice, 'B', '单选答案能取回');
  eq(hit.text, '北京', '选项原文能取回');
  ok(hit.fromCache === true, '标记为来自缓存');
  eq(Cache.size(), 1, '缓存条数 1');
}

/* ---------- 多选题：单字母答案必须作废 ---------- */
console.log('\n[多选题类型校验]');

reset();
{
  const q = mkQ('multi', '以下哪些是直辖市');
  Cache.set(q, { choice: ['A', 'B'], text: ['上海', '北京'], confidence: 0.9 });
  const hit = Cache.get(q);
  eq(hit.choice, ['A', 'B'], '多选题正常存取数组');
}

reset();
{
  // 模拟旧版本留下的脏数据：多选题只存了单字母
  const q = mkQ('multi', '以下哪些是直辖市');
  Cache.set(q, { choice: ['A', 'B'], text: ['上海', '北京'], confidence: 0.9 });
  const stored = Cache.load();
  Object.keys(stored).forEach((k) => { stored[k].c = 'A'; });   // ← 旧版本写的就是这个样子
  Cache._data = stored;

  eq(Cache.get(q), null, '★ 多选题存着单字母 → 视为未命中，重新问模型');
}

/* ---------- 判断题：只接受 true/false ---------- */
console.log('\n[判断题类型校验]');

reset();
{
  const q = mkQ('judge', '地球是圆的');
  Cache.set(q, { choice: 'true', text: '正确', confidence: 0.95 });
  eq(Cache.get(q).choice, 'true', '判断题存 true 能取回');
}

reset();
{
  const q = mkQ('judge', '地球是圆的');
  Cache.set(q, { choice: 'true', text: '正确', confidence: 0.95 });
  const stored = Cache.load();
  Object.keys(stored).forEach((k) => { stored[k].c = '正确'; });   // 非法形态
  Cache._data = stored;
  eq(Cache.get(q), null, '★ 判断题存着中文"正确" → 视为未命中');
}

/* ---------- 版本隔离 ---------- */
console.log('\n[版本隔离]');

reset();
{
  // 旧版本的数据存在 llmq:cache（无版本号）里
  mem.set('llmq:cache', {
    abc123: { c: 'A', t: '上海', f: 0.9, at: Date.now(), hits: 0 },
  });
  eq(Cache.size(), 0, '★ 旧版本缓存键不会被新版本读到');
  ok(Cache._key !== 'llmq:cache', '缓存键带版本号（' + Cache._key + '）');
  ok(Cache.SCHEMA >= 3, 'SCHEMA 已升到 ' + Cache.SCHEMA);
}

/* ---------- LRU 淘汰 ---------- */
console.log('\n[容量控制]');

reset();
{
  api.Config.load().quiz.cacheLimit = 100;   // prune 的下限是 100
  for (let i = 0; i < 130; i++) {
    Cache.set(mkQ('single', '题目' + i), { choice: 'A', text: '上海', confidence: 0.9 });
  }
  ok(Cache.size() <= 100, `超出上限后淘汰到 100 条以内（实际 ${Cache.size()}）`);
}

/* ---------- 关闭缓存 ---------- */
console.log('\n[关闭缓存]');

reset();
{
  const q = mkQ('single');
  api.Config.load().quiz.useCache = false;
  Cache.set(q, { choice: 'B', text: '北京', confidence: 0.95 });
  eq(Cache.get(q), null, '关闭缓存后不读也不写');
  eq(Cache.size(), 0, '关闭缓存时 set 不落库');
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
