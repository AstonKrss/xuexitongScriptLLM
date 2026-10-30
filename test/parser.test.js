/* ============================================================
 * test/parser.test.js —— 解析器 DOM 测试
 *
 * 用 jsdom 造几份还原超星结构的最低限度页面，验证两件事：
 *   1. 老版 .Py-mian1 结构能被正确解析；
 *   2. 完全不含超星类名的通用结构也能靠语义解析出来。
 * 第二点是关键——它决定了超星改版后脚本还能不能用。
 *
 * 运行：node test/parser.test.js
 * 依赖：jsdom（装在托管的 node workspace 里）
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '40-parser.js'];

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

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

// 在指定 HTML 上载入解析模块，返回全新的 Parser（每次都是干净的作用域，互不污染）
function loadParser(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://mooc1.chaoxing.com/work/phone/doHomeWork?workId=1' });
  const w = dom.window;
  // 模块内部直接引用这些浏览器全局，这里挂到 Node 的 global 上
  global.document = w.document;
  global.window = w;
  global.location = w.location;
  global.getComputedStyle = w.getComputedStyle.bind(w);
  // eslint-disable-next-line no-new-func
  const api = new Function(`${code}\nreturn { Parser, stripOptionPrefix, stripStemPrefix };`)();
  return api;
}

/* ================= 用例 1：老版超星手机作业页 ================= */
console.log('\n[用例 1] 老版 .Py-mian1 结构');

const PY_HTML = `
<div class="Py-mian1">
  <div class="Py-m1-title fs16">1.【单选题】中国的首都是哪座城市？</div>
  <ul class="answerList">
    <li id-param="A" val-param="A"><em id-param="A">A</em>上海</li>
    <li id-param="B" val-param="B"><em id-param="B">B</em>北京</li>
    <li id-param="C" val-param="C"><em id-param="C">C</em>广州</li>
  </ul>
</div>
<div class="Py-mian1">
  <div class="Py-m1-title fs16">2.【判断题】地球是平的。</div>
  <ul class="answerList">
    <li id-param="true" val-param="true"><em id-param="true">正确</em></li>
    <li id-param="false" val-param="false"><em id-param="false">错误</em></li>
  </ul>
</div>
`;

{
  const api = loadParser(PY_HTML);
  const r = api.Parser.parse();
  eq(r.adapter, 'py-mian1', '命中 py-mian1 适配器');
  eq(r.questions.length, 2, '解析出 2 道题');

  if (r.questions.length === 2) {
    const q1 = r.questions[0];
    eq(q1.type, 'single', '第一题识别为单选');
    eq(q1.stem, '中国的首都是哪座城市？', '题干去掉题号与题型标记');
    eq(q1.options.map((o) => o.text), ['上海', '北京', '广州'], '选项文本剥离字母前缀');

    const q2 = r.questions[1];
    eq(q2.type, 'judge', '第二题识别为判断');
  }
}

/* ================= 用例 2：无超星类名的通用结构 ================= */
console.log('\n[用例 2] 通用语义解析（模拟新版 React 页面）');

const GENERIC_HTML = `
<div class="quiz-list">
  <div class="question">
    <div class="stem">1. 中国的首都是哪座城市？</div>
    <ul>
      <li><label><input type="radio" name="q1" value="A">A. 上海</label></li>
      <li><label><input type="radio" name="q1" value="B">B. 北京</label></li>
    </ul>
  </div>
  <div class="question">
    <div class="stem">2. 以下属于水果的有？</div>
    <ul>
      <li><label><input type="checkbox" name="q2" value="A">A. 苹果</label></li>
      <li><label><input type="checkbox" name="q2" value="B">B. 白菜</label></li>
      <li><label><input type="checkbox" name="q2" value="C">C. 香蕉</label></li>
    </ul>
  </div>
  <div class="question">
    <div class="stem">3. 光速比声速快。</div>
    <ul>
      <li><label><input type="radio" name="q3" value="t">正确</label></li>
      <li><label><input type="radio" name="q3" value="f">错误</label></li>
    </ul>
  </div>
</div>
`;

{
  const api = loadParser(GENERIC_HTML);
  const r = api.Parser.parse();
  eq(r.adapter, 'generic', '命中 generic 适配器');
  eq(r.questions.length, 3, '解析出 3 道题');

  if (r.questions.length === 3) {
    eq(r.questions.map((q) => q.type), ['single', 'multi', 'judge'], '题型分别是单选/多选/判断');
    eq(r.questions[0].stem, '中国的首都是哪座城市？', '题干干净，没有残留选项字母');
    eq(r.questions[0].options.map((o) => o.text), ['上海', '北京'], '选项文本剥离前缀');
    eq(r.questions[1].options.length, 3, '多选题三个选项');
  }
}

/* ================= 用例 3：整页只有一道题 ================= */
console.log('\n[用例 3] 单题页面（容器定位的回退分支）');

const ONE_Q = `
<div id="wrap">
  <div class="q">
    <div class="title">唯一的题目：1+1=?</div>
    <label><input type="radio" name="a">A. 1</label>
    <label><input type="radio" name="a">B. 2</label>
  </div>
</div>
`;

{
  const api = loadParser(ONE_Q);
  const r = api.Parser.parse();
  eq(r.questions.length, 1, '单题页面也能解析出 1 道题');
  if (r.questions.length === 1) {
    eq(r.questions[0].options.map((o) => o.text), ['1', '2'], '单题选项正确');
  }
}

/* ================= 用例 4：前缀剥离的边界 ================= */
console.log('\n[用例 4] 文本清洗边界');

{
  const api = loadParser('<div></div>');
  eq(api.stripOptionPrefix('AI技术'), 'AI技术', '★ AI技术 不能被剥成 I技术');
  eq(api.stripOptionPrefix('B超检查'), 'B超检查', '★ B超检查 不能被剥成 超检查');
  eq(api.stripOptionPrefix('A. 北京'), '北京', 'A. 北京 → 北京');
  eq(api.stripOptionPrefix('（C）广州'), '广州', '（C）广州 → 广州');
  eq(api.stripOptionPrefix('D、深圳'), '深圳', 'D、深圳 → 深圳');
  eq(api.stripOptionPrefix('北京'), '北京', '无前缀不动');
}

/* ================= 汇总 ================= */
console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
