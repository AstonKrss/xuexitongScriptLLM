/* ============================================================
 * test/realpage.test.js —— 用真实页面结构回归
 *
 * HTML 直接取自用户导出的 dump（mooc-ans/work/doHomeWorkNew）。
 * 这个页面暴露了三个 bug，全部在此锁定：
 *   1. 选项文本取整个 li，得到 "A 上海"，字母重复一遍，文本匹配全废；
 *   2. 把「请输入验证码」输入框当成填空题，答案被填进验证码；
 *   3. 填空题是 UEditor 富文本，不是 input，一个都没抓到。
 *
 * 运行：node test/realpage.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '50-matcher.js',
  '60-cache.js', '70-runner.js', '80-ui.js'];

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

const HTML = `
<html><body>
<div class="TiMu newTiMu" data="0">
  <div class="Zy_TItle clearfix">
    <i class="fl" tabindex="0">1</i>
    <div class="clearfix font-cxsecret fontLabel" tabindex="0"><span class="newZy_TItle">【单选题】</span>中国的首都是(        )。</div>
  </div>
  <div class="clearfix">
    <ul class="Zy_ulTop w-top fl">
      <li class="font-cxsecret before-after" qid="1001" qtype="0" role="radio" tabindex="0"><label class="fl before"><span class="num_option choice1001 " name="answer1001" data="A">A</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">上海</a><div class="clear"></div></li>
      <li class="font-cxsecret before-after" qid="1001" qtype="0" role="radio" tabindex="0"><label class="fl before"><span class="num_option choice1001 " name="answer1001" data="B">B</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">北京</a><div class="clear"></div></li>
      <li class="font-cxsecret before-after" qid="1001" qtype="0" role="radio" tabindex="0"><label class="fl before"><span class="num_option choice1001 " name="answer1001" data="C">C</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">广州</a><div class="clear"></div></li>
    </ul>
  </div>
</div>

<div class="TiMu newTiMu" data="0">
  <div class="Zy_TItle clearfix">
    <i class="fl" tabindex="0">2</i>
    <div class="clearfix font-cxsecret fontLabel" tabindex="0"><span class="newZy_TItle">【填空题】</span>文化创造核心在____。</div>
  </div>
  <div class="clearfix">
    <div id="answerEditor4058890891" style="width:100%"></div>
    <div id="inpDiv4058890891" style="display:none"></div>
  </div>
</div>

<div class="TiMu newTiMu" data="0">
  <div class="Zy_TItle clearfix">
    <i class="fl" tabindex="0">3</i>
    <div class="clearfix font-cxsecret fontLabel" tabindex="0"><span class="newZy_TItle">【多选题】</span>以下属于水果的有(        )。</div>
  </div>
  <div class="clearfix">
    <ul class="Zy_ulTop w-top fl">
      <li class="font-cxsecret before-after" qtype="1" role="radio" tabindex="0"><label class="fl before"><span class="num_option" data="A">A</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">苹果</a></li>
      <li class="font-cxsecret before-after" qtype="1" role="radio" tabindex="0"><label class="fl before"><span class="num_option" data="B">B</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">白菜</a></li>
      <li class="font-cxsecret before-after" qtype="1" role="radio" tabindex="0"><label class="fl before"><span class="num_option" data="C">C</span></label><a tabindex="-1" href="javascript:void(0);" class="fl after">香蕉</a></li>
    </ul>
  </div>
</div>

<div class="mask-dialog"><input type="text" id="captchaInput" placeholder="请输入验证码"></div>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?x=1', pretendToBeVisual: true });
const w = dom.window;
global.document = w.document;
global.window = w;
global.location = w.location;
global.getComputedStyle = w.getComputedStyle.bind(w);

const mem = new Map();
global.GM_getValue = (k) => mem.get(k);
global.GM_setValue = (k, v) => { mem.set(k, v); };

let requests = [];
function fakeAnswer(prompt) {
  if (prompt.indexOf('首都') >= 0) return { choice: 'B', text: '北京', confidence: 0.95 };
  if (prompt.indexOf('水果') >= 0) return { choice: ['A', 'C'], text: ['苹果', '香蕉'], confidence: 0.9 };
  if (prompt.indexOf('文化创造核心') >= 0) return { text: ['人民'], confidence: 0.9 };
  return { confidence: 0 };
}
global.GM_xmlhttpRequest = function (opts) {
  const body = JSON.parse(opts.data);
  const userMsg = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  requests.push(userMsg);
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
const api = new Function(`${code}\nreturn { Parser, Runner, Config };`)();

(async () => {
  console.log('\n[1] 解析');

  const parsed = api.Parser.parse(w.document);
  eq(parsed.adapter, 'cx-pc', '命中 PC 作业页适配器');
  eq(parsed.questions.length, 3, '解析出 3 题（单选 + 填空 + 多选）');

  const single = parsed.questions.find((q) => q.type === 'single');
  const blank = parsed.questions.find((q) => q.type === 'blank');
  const multi = parsed.questions.find((q) => q.type === 'multi');

  ok(!!single, '找到单选题');
  ok(!!blank, '找到填空题');
  ok(!!multi, '★ 找到多选题（qtype="1" 但选项是 role="radio" 也能正确识别）');
  eq(multi && multi.options.length, 3, '多选题有三个选项');

  if (single) {
    // ★ 这是最关键的回归点：选项文本不能带字母前缀
    eq(single.options.map((o) => o.text), ['上海', '北京', '广州'],
      '★ 选项文本不含重复的字母（旧版会得到 "A 上海"）');
    eq(single.options.map((o) => o.key), ['A', 'B', 'C'], '选项字母取自 num_option 的 data 属性');
  }

  if (blank) {
    eq(blank.blanks.length, 1, '填空题识别到 1 个空');
    eq(blank.blanks[0].kind, 'richtext', '★ 识别为富文本编辑器，而不是普通输入框');
  }

  // ★ 验证码不能被当成填空题
  const blankStems = parsed.questions.filter((q) => q.type === 'blank').map((q) => q.stem);
  ok(blankStems.every((s) => s.indexOf('验证码') === -1), '★ 验证码输入框没有被当成填空题');

  console.log('\n[2] 字体加密检测');
  // 这段 HTML 只有 .font-cxsecret 这个 class，没有对应的 @font-face。
  // 医学英语那类页面就是这样，文字本来就是明文。v0.8.0 起不再只看 class，
  // 必须同时存在真正的加密字体才算「有加密」——这里断言的是**没有误报**。
  ok(!parsed.obfuscated, '★ 只有 class 没有 @font-face 时不误判为加密');
  // 有真字体时 available() 为 true 的场景在 test/font.test.js 里用真实 TTF 覆盖

  console.log('\n[3] 完整作答');

  // 给每个选项挂一个点击记录器，同时切换 cur 类（模拟超星的真实行为），
  // 这样才能验证"多选题到底点了几个选项"
  const clicked = [];
  w.document.querySelectorAll('.TiMu').forEach((t) => {
    const no = (t.querySelector('i') || {}).textContent || '';
    t.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        const badge = li.querySelector('.num_option');
        clicked.push(no + (badge ? badge.getAttribute('data') : '?'));
        li.classList.toggle('cur');
      });
    });
  });

  const cfg = api.Config.load();
  cfg.profiles.default.apiKey = 'sk-test';
  cfg.profiles.default.baseUrl = 'https://api.deepseek.com';
  cfg.quiz.fillDelayMin = 1;
  cfg.quiz.fillDelayMax = 2;
  cfg.quiz.enforceMinDuration = false;
  api.Config.save();

  await api.Runner.start();

  eq(requests.length, 3, `发了 3 次请求（实际 ${requests.length}）`);
  ok(requests.some((p) => p.indexOf('【题型】填空题') >= 0), '填空题走了模型');

  const inpDiv = w.document.getElementById('inpDiv4058890891');
  eq(inpDiv.innerHTML, '人民', '★ 填空题答案写进了超星的 answer 容器');

  const captcha = w.document.getElementById('captchaInput');
  eq(captcha.value, '', '★ 验证码输入框保持为空（旧版会被写成"人民"）');

  // ★ 多选题必须真的点两个选项，单选只能点一个
  eq(clicked.filter((k) => k === '3A').length, 1, '★ 多选题点了选项 A');
  eq(clicked.filter((k) => k === '3C').length, 1, '★ 多选题点了选项 C');
  eq(clicked.filter((k) => k === '3B').length, 0, '★ 多选题没有点不该选的 B');
  eq(clicked.filter((k) => k === '1B').length, 1, '单选题点了 B');
  eq(clicked.filter((k) => k === '1A').length, 0, '单选题没点 A');

  eq(api.Runner.stats.answered, 3, `三题都填入了（实际 ${api.Runner.stats.answered}）`);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
