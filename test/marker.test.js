/* ============================================================
 * test/marker.test.js —— 不依赖类名的定位
 *
 * 背景：用户在超星 web 端打开章节测验，脚本只认出 1 道填空题，
 * 50 道选择题一道没抓到。原因是页面既不是 .Py-mian1（手机版）也不是 .TiMu（PC 经典版），
 * 而通用适配器又要求 radio/checkbox 可见——超星把它们设成了 display:none。
 *
 * 这里用四种真实可能出现的结构分别验证：
 *   1. 字母单独成节点的布局（超星新版）—— 靠【题型】文字定位
 *   2. .TiMu 布局（PC 经典版）
 *   3. radio 隐藏的布局 —— 靠 DOM 层级关系定位
 *   4. 简答题误报的边界
 *
 * 运行：node test/marker.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '40-parser.js'];

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

function load(html) {
  const dom = new JSDOM(html, { url: 'https://mooc1.chaoxing.com/work/doHomeWork?x=1', pretendToBeVisual: true });
  global.document = dom.window.document;
  global.window = dom.window;
  global.location = dom.window.location;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn { Parser };`)();
}

/* ================= 1. 字母单独成节点 ================= */
console.log('\n[1] 新版布局：字母和选项文本是并列节点，无 radio');

const MARKER_HTML = `
<html><body><div class="wrap">
  <div class="qblock">
    <div class="qn">1</div>
    <div class="qt">【单选题】2035年建成文化强国战略目标，将“繁荣互联网条件下的大众文艺”写入( )。</div>
    <div class="qs">
      <div class="op"><span class="k">A</span><span class="v">《关于推动高质量发展的若干经济政策》</span></div>
      <div class="op"><span class="k">B</span><span class="v">《中共中央关于制定国民经济和社会发展第十五个五年规划的建议》</span></div>
      <div class="op"><span class="k">C</span><span class="v">《文化产业促进法》</span></div>
      <div class="op"><span class="k">D</span><span class="v">《“十四五”文化发展规划》</span></div>
    </div>
  </div>
  <div class="qblock">
    <div class="qn">2</div>
    <div class="qt">【判断题】地球是平的。( )</div>
    <div class="qs">
      <div class="op"><span class="k">A</span><span class="v">对</span></div>
      <div class="op"><span class="k">B</span><span class="v">错</span></div>
    </div>
  </div>
</div></body></html>`;

{
  const { Parser } = load(MARKER_HTML);
  const r = Parser.parse();
  eq(r.adapter, 'marker', '命中「按题型标记定位」适配器');
  eq(r.questions.length, 2, '解析出 2 道题');
  if (r.questions.length === 2) {
    const q1 = r.questions[0];
    eq(q1.type, 'single', '第一题识别为单选');
    eq(q1.options.length, 4, '四个选项');
    eq(q1.options[0].key, 'A', '选项字母正确');
    eq(q1.options[1].text, '《中共中央关于制定国民经济和社会发展第十五个五年规划的建议》',
      '★ 选项文本剥离了字母，保留书名号');
    ok(q1.stem.indexOf('2035年建成文化强国') >= 0, '题干包含正文');
    ok(q1.stem.indexOf('【单选题】') === -1, '题干里没有残留题型标记');
    ok(q1.stem.indexOf('《关于推动') === -1, '题干里没有残留选项文本');
    eq(r.questions[1].type, 'judge', '第二题识别为判断');
  }
}

/* ================= 2. .TiMu 经典 PC 布局 ================= */
console.log('\n[2] .TiMu 布局');

const TIMU_HTML = `
<html><body>
<div class="TiMu">
  <div class="Zy_TItle clearfix"><i class="fl">2</i><div class="fl"><p>【判断题】光速比声速快。</p></div></div>
  <ul class="Zy_ulTop">
    <li><a href="javascript:;"><span class="fl">A</span><div class="fl after">对</div></a></li>
    <li><a href="javascript:;"><span class="fl">B</span><div class="fl after">错</div></a></li>
  </ul>
  <input type="radio" name="answer2" value="true" style="display:none">
  <input type="radio" name="answer2" value="false" style="display:none">
</div>
</body></html>`;

{
  const { Parser } = load(TIMU_HTML);
  const r = Parser.parse();
  eq(r.adapter, 'cx-pc', '命中 PC 作业页适配器');
  eq(r.questions.length, 1, '解析出 1 道题');
  if (r.questions.length === 1) {
    eq(r.questions[0].type, 'judge', '识别为判断题');
    eq(r.questions[0].options.map((o) => o.text), ['对', '错'], '选项文本正确');
  }
}

/* ================= 3. radio 被隐藏 ================= */
console.log('\n[3] radio 为 display:none 的布局');

const HIDDEN_HTML = `
<html><body><div class="qlist">
  <div class="q">
    <div class="t">1. 中国的首都是哪座城市？</div>
    <div class="o"><input type="radio" name="a1" style="display:none">A. 上海</div>
    <div class="o"><input type="radio" name="a1" style="display:none">B. 北京</div>
  </div>
  <div class="q">
    <div class="t">2. 以下属于水果的有？</div>
    <div class="o"><input type="checkbox" name="a2" style="display:none">A. 苹果</div>
    <div class="o"><input type="checkbox" name="a2" style="display:none">B. 白菜</div>
  </div>
</div></body></html>`;

{
  const { Parser } = load(HIDDEN_HTML);
  const r = Parser.parse();
  eq(r.adapter, 'generic', '命中通用适配器');
  eq(r.questions.length, 2, '★ 隐藏的 radio 也能被统计到（旧版会得到 0 题）');
  if (r.questions.length === 2) {
    eq(r.questions[0].options.map((o) => o.text), ['上海', '北京'], '选项文本正确');
    eq(r.questions[1].type, 'multi', '第二题是多选');
  }
}

/* ================= 4. 简答题误报边界 ================= */
console.log('\n[4] 简答题判定边界');

const STATS_ONLY = `
<html><body>
  <div class="stats">题型：单选题 多选题 填空题 判断题 简答题</div>
  <div class="q"><div class="t">【单选题】1+1=?</div>
    <div class="o"><input type="radio" name="a">A. 1</div>
    <div class="o"><input type="radio" name="a">B. 2</div>
  </div>
</body></html>`;

{
  const { Parser } = load(STATS_ONLY);
  const r = Parser.parse();
  eq(r.unsupported, [], '★ 仅在统计栏提到「简答题」不算未支持题型（不阻断提交）');
}

const REAL_SHORT_ANSWER = `
<html><body>
  <div class="q"><div class="t">【简答题】请论述新大众文艺的意义。</div><textarea></textarea></div>
  <div class="q"><div class="t">【单选题】1+1=?</div>
    <div class="o"><input type="radio" name="a">A. 1</div>
    <div class="o"><input type="radio" name="a">B. 2</div>
  </div>
</body></html>`;

{
  const { Parser } = load(REAL_SHORT_ANSWER);
  const r = Parser.parse();
  ok(r.unsupported.indexOf('简答题') >= 0, '★ 真的出现【简答题】时要报出来（阻断提交）');
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
