/* ============================================================
 * test/logic.test.js —— 纯函数逻辑测试
 *
 * 为什么只测这几个函数：
 *   匹配和解析一旦出错不会抛异常，只会静默点错选项，事后很难发现。
 *   这类"沉默的错误"必须用断言钉死。DOM 相关的部分没法在这里测，
 *   留给实际页面验证。
 *
 * 运行：node test/logic.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
// 只加载纯逻辑模块：00 提供工具，30 提供解析/归一化，40 提供判断题常量，50 提供匹配
const MODULES = ['00-core.js', '30-llm.js', '40-parser.js', '50-matcher.js'];

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

const EXPORTS = [
  'normalizeText', 'scoreOption', 'matchSingle', 'matchMulti', 'matchJudge', 'matchAnswer',
  'extractJSON', 'normalizeAnswer', 'cacheKeyOf', 'hashKey', 'stripOptionPrefix', 'stripStemPrefix',
];

// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { ${EXPORTS.join(', ')} };`)();

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; }
  else { failed++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}

function group(name, fn) {
  console.log(`\n[${name}]`);
  fn();
}

/* ---------- 文本归一化 ---------- */
group('归一化', () => {
  eq(api.normalizeText('马克思主义中国化。'), api.normalizeText('马克思主义中国化'), '去尾部句号');
  eq(api.normalizeText('ＡＢＣ'), 'abc', '全角转半角并小写');
  eq(api.normalizeText(' 人民  群众 '), '人民群众', '去所有空白');
  eq(api.normalizeText('“实践”是检验真理的标准'), '实践是检验真理的标准', '去中文引号');
});

/* ---------- 打分：这是静默点错的重灾区 ---------- */
group('选项打分', () => {
  eq(api.scoreOption('北京', '北京'), 100, '完全一致');
  eq(api.scoreOption('北京', '北京市'), 0, '短串被长串包含且长度比 0.67，不采信');
  eq(api.scoreOption('1921年', '1921'), 75, '长度比 0.8 的包含关系，中等置信');
  // 高置信档只在长选项里才可能触发（长度比 >0.9），这里用构造数据验证分档边界
  eq(api.scoreOption('ABCDEFGHIJ', 'ABCDEFGHIJK'), 95, '长度比 0.91，高置信档');
  eq(api.scoreOption('人民群众', '人民'), 0, '★ 危险包含：人民 vs 人民群众 必须拒绝');
  eq(api.scoreOption('马克思主义中国化', '马克思主义'), 0, '★ 危险包含：马克思主义 vs 马克思主义中国化 必须拒绝');
  eq(api.scoreOption('广州', '上海'), 0, '无关选项');
});

/* ---------- 单选题匹配 ---------- */
const singleQ = {
  type: 'single',
  stem: '中国的首都是？',
  options: [{ key: 'A', text: '上海' }, { key: 'B', text: '北京' }, { key: 'C', text: '广州' }],
};

group('单选匹配', () => {
  const r1 = api.matchSingle(singleQ, { choice: 'B', text: '北京', confidence: 0.95 });
  eq(r1 && r1.option.key, 'B', '原文精确匹配到 B（字母与顺序无关）');

  // 选项顺序和模型以为的不一样：模型说 A，但原文是"北京"，应信原文
  const r2 = api.matchSingle(singleQ, { choice: 'A', text: '北京', confidence: 0.9 });
  eq(r2 && r2.option.key, 'B', '原文优先于字母，即使字母说 A');

  const r3 = api.matchSingle(singleQ, { choice: 'B', text: '首都北京', confidence: 0.9 });
  eq(r3, null, '改写过的原文匹配不上，拒绝而非瞎猜');

  const r4 = api.matchSingle(singleQ, { choice: 'C', text: null, confidence: 0.8 });
  eq(r4 && r4.option.key, 'C', '只给字母时按字母兜底');
});

/* ---------- 判断题 ---------- */
const judgeQ = {
  type: 'judge',
  stem: '地球是平的。',
  options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
};

group('判断题匹配', () => {
  eq(api.matchJudge(judgeQ, { choice: 'false' }) && api.matchJudge(judgeQ, { choice: 'false' }).option.key, 'B', 'false → 错误');
  eq(api.matchJudge(judgeQ, { choice: 'true' }) && api.matchJudge(judgeQ, { choice: 'true' }).option.key, 'A', 'true → 正确');

  const answers = ['正确', '对', '是', '√', 'T', 'true', 'YES'];
  answers.forEach((v) => {
    const n = api.normalizeAnswer({ choice: v }, judgeQ);
    eq(n.choice, 'true', `判断题真值归一化：${v}`);
  });
  const falsy = ['错误', '错', '否', '×', 'F', 'false', 'NO'];
  falsy.forEach((v) => {
    const n = api.normalizeAnswer({ choice: v }, judgeQ);
    eq(n.choice, 'false', `判断题假值归一化：${v}`);
  });
});

/* ---------- 多选题 ---------- */
const multiQ = {
  type: 'multi',
  stem: '以下属于水果的有？',
  options: [
    { key: 'A', text: '苹果' }, { key: 'B', text: '白菜' },
    { key: 'C', text: '香蕉' }, { key: 'D', text: '土豆' },
  ],
};

group('多选匹配', () => {
  const r1 = api.matchMulti(multiQ, { choice: ['A', 'C'], text: ['苹果', '香蕉'] });
  eq(r1 && r1.options.map((o) => o.key), ['A', 'C'], '两个选项都匹配');

  const r2 = api.matchMulti(multiQ, { choice: ['A', 'C'], text: ['苹果', '榴莲'] });
  eq(r2, null, '有一个文本匹配不上，整题作废（少选即全错，不冒险）');

  const r3 = api.matchMulti(multiQ, { choice: ['A'], text: [] });
  eq(r3 && r3.options.map((o) => o.key), ['A'], '只有字母时按字母');
});

/* ---------- 模型输出解析 ---------- */
group('模型输出解析', () => {
  eq(api.extractJSON('{"choice":"A"}'), { choice: 'A' }, '干净 JSON');
  eq(api.extractJSON('```json\n{"choice":"A"}\n```'), { choice: 'A' }, '带 markdown 围栏');
  eq(api.extractJSON('好的，答案是 {"choice":"A","text":"x"} 希望有用'), { choice: 'A', text: 'x' }, '前后有废话');
  eq(api.extractJSON('完全不是 JSON'), null, '无法解析返回 null');
  eq(api.extractJSON('{"text":"含{}大括号"}'), { text: '含{}大括号' }, '字符串内的大括号不干扰配对');
});

/* ---------- 缓存键 ---------- */
group('缓存键', () => {
  const a = { stem: '中国的首都是？', options: [{ key: 'A', text: '上海' }, { key: 'B', text: '北京' }] };
  const b = { stem: '中国的首都是?', options: [{ key: 'B', text: '北京' }, { key: 'A', text: '上海' }] };
  eq(api.cacheKeyOf(a) === api.cacheKeyOf(b), true, '选项顺序与全半角标点不影响缓存键');

  const c = { stem: '中国的首都是？', options: [{ key: 'A', text: '上海' }, { key: 'B', text: '南京' }] };
  eq(api.cacheKeyOf(a) === api.cacheKeyOf(c), false, '选项内容不同则缓存键不同');
});

/* ---------- 选项前缀剥离 ---------- */
group('文本清洗', () => {
  eq(api.stripOptionPrefix('A. 北京'), '北京', '剥离 A. 前缀');
  eq(api.stripOptionPrefix('（B）上海'), '上海', '剥离全角括号前缀');
  eq(api.stripOptionPrefix('C、广州'), '广州', '剥离顿号前缀');
  eq(api.stripStemPrefix('1. 中国的首都是？'), '中国的首都是？', '剥离题号');
  eq(api.stripStemPrefix('【单选题】地球是圆的'), '地球是圆的', '剥离题型标记');
});

/* ---------- 汇总 ---------- */
console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
