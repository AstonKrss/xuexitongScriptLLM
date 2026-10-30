/* ============================================================
 * test/iframe.test.js —— iframe 内题目 + 填空题
 *
 * 这个用例针对的是一次真实误判：
 *   用户打开 mooc1.chaoxing.com/mycourse/studentstudy 这张课程学习页，
 *   页面顶部怎么都判定"不是答题页"。原因是章节测验渲染在**页内的 iframe** 里，
 *   而当时的实现只数了顶层文档的 input 数量。
 *
 * 同时覆盖填空题：那份卷子 60 题里有 10 道填空，不支持的话覆盖率永远到不了 100%。
 *
 * 运行：node test/iframe.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '50-matcher.js',
  '60-cache.js', '70-runner.js', '80-ui.js', '90-main.js'];

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

/* ---------- 外层页面：含搜索框，但没有任何题目 ---------- */
const OUTER_HTML = `
<html><body>
  <div class="header"><input type="text" placeholder="搜索课程"></div>
  <div class="left">课程目录</div>
  <div class="right"><iframe id="content"></iframe></div>
</body></html>`;

/* ---------- iframe 内：真正的测验 ---------- */
const INNER_HTML = `
<html><body>
<div class="Py-mian1">
  <div class="Py-m1-title fs16">1.【单选题】中国的首都是哪座城市？</div>
  <ul class="answerList">
    <li id-param="A"><em id-param="A">A</em>上海</li>
    <li id-param="B"><em id-param="B">B</em>北京</li>
  </ul>
</div>
<div class="Py-mian1">
  <div class="Py-m1-title fs16">2.【判断题】地球是平的。</div>
  <ul class="answerList">
    <li id-param="true" val-param="true"><em id-param="true">对</em></li>
    <li id-param="false" val-param="false"><em id-param="false">错</em></li>
  </ul>
</div>
<div class="Py-mian1">
  <div class="Py-m1-title fs16">3.【填空题】文化创造核心在____。</div>
  <div class="blank-row">第1空：<input type="text"></div>
</div>
<div class="footer"><button id="saveBtn">暂时保存</button><button id="submitBtn">提交</button></div>
</body></html>`;

const dom = new JSDOM(OUTER_HTML, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&mooc2=1', pretendToBeVisual: true });
const w = dom.window;

global.document = w.document;
global.window = w;
global.location = w.location;
global.getComputedStyle = w.getComputedStyle.bind(w);

// 把测验内容写进 iframe
const iframe = w.document.getElementById('content');
const idoc = iframe.contentDocument;
idoc.open();
idoc.write(INNER_HTML);
idoc.close();

// 测试环境不自动初始化
w.__LLM_QUIZ_NO_AUTOINIT__ = true;

const mem = new Map();
global.GM_getValue = (k) => mem.get(k);
global.GM_setValue = (k, v) => { mem.set(k, v); };

const requestLog = [];
function fakeAnswer(prompt) {
  if (prompt.includes('首都')) return { choice: 'B', text: '北京', confidence: 0.95 };
  if (prompt.includes('地球是平的')) return { choice: 'false', text: '错', confidence: 0.95 };
  if (prompt.includes('文化创造核心')) return { text: ['人民'], confidence: 0.9 };
  return { confidence: 0 };
}
global.GM_xmlhttpRequest = function (opts) {
  const body = JSON.parse(opts.data);
  const userMsg = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  requestLog.push(userMsg);
  setTimeout(() => {
    opts.onload({
      status: 200,
      finalUrl: opts.url,
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeAnswer(userMsg)) } }] }),
    });
  }, 3);
};

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`var UI_STUB = null;${code}\nreturn { Main, Parser, Runner, Config };`)();

(async () => {
  /* ---------- 1. 顶层文档确实没有题目 ---------- */
  console.log('\n[1] 复现原始误判场景');
  eq(w.document.querySelectorAll('input[type=radio],input[type=checkbox]').length, 0,
    '外层页面确实一个单选框都没有（这就是当初误判的原因）');

  /* ---------- 2. 能穿透 iframe 找到题目 ---------- */
  console.log('\n[2] 跨 iframe 定位');
  const doc = api.Main.resolveQuizDoc(true);
  ok(doc === idoc, '定位到了 iframe 里的文档，而不是顶层文档');
  eq(api.Main.quizKind, 'quiz', '状态标记为答题页');
  ok(api.Runner.doc === idoc, 'Runner 的答题文档同步指向 iframe');

  /* ---------- 3. 解析出选择 + 判断 + 填空 ---------- */
  console.log('\n[3] 解析三种题型');
  const parsed = api.Parser.parse(doc);
  eq(parsed.questions.length, 3, '一共解析出 3 题');
  eq(parsed.questions.map((q) => q.type), ['single', 'judge', 'blank'], '题型依次是 单选 / 判断 / 填空');
  const blankQ = parsed.questions[2];
  eq(blankQ.blanks.length, 1, '填空题识别到 1 个空');
  ok(blankQ.stem.indexOf('文化创造核心') >= 0, '填空题题干正确');
  ok(blankQ.stem.indexOf('第1空') === -1, '题干里没有残留「第1空」标签');
  eq(parsed.unsupported, [], '没有未支持的题型');

  /* ---------- 4. 跑完整流程，检查 DOM 是否真被填上 ---------- */
  console.log('\n[4] 完整作答');
  const cfg = api.Config.load();
  cfg.profiles.default.apiKey = 'sk-test';
  cfg.profiles.default.baseUrl = 'https://api.deepseek.com';
  cfg.quiz.fillDelayMin = 1;
  cfg.quiz.fillDelayMax = 2;
  cfg.quiz.enforceMinDuration = false;
  api.Config.save();

  await api.Runner.start();

  eq(requestLog.length, 3, `向模型发了 3 次请求（实际 ${requestLog.length}）`);
  ok(requestLog.some((p) => p.indexOf('【题型】填空题') >= 0), '填空题也走了模型，没有被跳过');

  const blankInput = idoc.querySelector('input[type=text]');
  eq(blankInput.value, '人民', '填空框被写入了「人民」');
  eq(api.Runner.stats.answered, 3, `三题全部填入（实际 ${api.Runner.stats.answered}）`);
  eq(api.Runner.unsupported, [], '没有触发未支持题型的拦截');

  /* ---------- 5. 卷面有简答题时必须拦住提交 ---------- */
  console.log('\n[5] 含不支持题型时禁止自动提交');
  const doc2 = new JSDOM('<html><body><div>【简答题】请论述……</div><div>【单选题】1+1=?<input type="radio" name="a"><input type="radio" name="a"></div></body></html>').window.document;
  const p2 = api.Parser.parse(doc2);
  ok(p2.unsupported.indexOf('简答题') >= 0, '识别出卷面含简答题并标记为不支持');

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
