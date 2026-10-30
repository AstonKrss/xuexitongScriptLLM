/* ============================================================
 * test/save.test.js —— 「填完到底有没有保存」
 *
 * 这个用例来自一次实测反馈：用户答完 60 题，脚本显示「已填完」，
 * 但页面上一个「暂时保存」都没点。刷新一下答案全丢。
 *
 * 根因是 finish() 的分支漏了：覆盖率达标 + 自动提交关闭时，只打了一行
 * 日志就 return，压根没走保存。另外「找不到提交按钮」那条路径也一样。
 *
 * 所以这里把结束路径逐条钉死：只要填过答案，离开前必须尝试保存。
 *
 * 运行：node test/save.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '50-matcher.js', '60-cache.js', '70-runner.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

function pageHtml(withSubmit) {
  return `
<html><body>
<div class="quiz-list">
  <div class="question">
    <div class="stem">1. 中国的首都是哪座城市？</div>
    <ul>
      <li><label><input type="radio" name="q1" value="A">A. 上海</label></li>
      <li><label><input type="radio" name="q1" value="B">B. 北京</label></li>
    </ul>
  </div>
  <div class="question">
    <div class="stem">2. 中华人民共和国的国旗是什么颜色？</div>
    <ul>
      <li><label><input type="radio" name="q2" value="A">A. 红色</label></li>
      <li><label><input type="radio" name="q2" value="B">B. 蓝色</label></li>
    </ul>
  </div>
</div>
<div class="footer">
  <button id="saveBtn">暂时保存</button>
  ${withSubmit ? '<button id="submitBtn">提交</button>' : ''}
</div>
</body></html>`;
}

function fakeAnswer(prompt) {
  if (prompt.includes('首都')) return { choice: 'B', text: '北京', confidence: 0.95 };
  if (prompt.includes('国旗')) return { choice: 'A', text: '红色', confidence: 0.95 };
  return { choice: '', text: '', confidence: 0 };
}

function setup(withSubmit, opts) {
  const dom = new JSDOM(pageHtml(withSubmit), { url: 'https://mooc1.chaoxing.com/work/phone/doHomeWork?workId=1', pretendToBeVisual: true });
  const w = dom.window;

  global.document = w.document;
  global.window = w;
  global.location = w.location;
  global.getComputedStyle = w.getComputedStyle.bind(w);

  const mem = new Map();
  global.GM_getValue = (k) => mem.get(k);
  global.GM_setValue = (k, v) => { mem.set(k, v); };

  global.GM_xmlhttpRequest = function (req) {
    const body = JSON.parse(req.data);
    const userMsg = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    setTimeout(() => {
      req.onload({
        status: 200,
        finalUrl: req.url,
        responseText: JSON.stringify({
          model: body.model,
          choices: [{ message: { content: JSON.stringify(fakeAnswer(userMsg)) } }],
        }),
      });
    }, 2);
  };

  // 记录按钮点击
  const clicks = [];
  ['saveBtn', 'submitBtn'].forEach((id) => {
    const el = w.document.getElementById(id);
    if (el) el.addEventListener('click', () => clicks.push(id));
  });

  const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  const prefix = `var UI = { setStatus: function(){}, mount: function(){}, openSettings: function(){} };\nvar unsafeWindow = undefined;\n`;
  // eslint-disable-next-line no-new-func
  const api = new Function(`${prefix}${code}\nreturn { Config, Runner, auditAnswerState, formatRanges, readAnswerValue, verifyChoiceValue, isOptionChecked, makeGuess: Runner.makeGuess, decideAfterSave };`)();

  const cfg = api.Config.load();
  cfg.profiles.default.apiKey = 'sk-test';
  cfg.profiles.default.baseUrl = 'https://api.deepseek.com';
  cfg.profiles.default.model = 'deepseek-chat';
  cfg.quiz.fillDelayMin = 1;
  cfg.quiz.fillDelayMax = 2;
  cfg.quiz.enforceMinDuration = false;
  cfg.quiz.autoSubmit = !!opts.autoSubmit;
  cfg.quiz.autoSave = opts.autoSave !== false;
  api.Config.save();

  return { api, w, clicks };
}

(async () => {
  /* ---------- 场景 1：覆盖率达标 + 自动提交关闭 ---------- */
  console.log('\n[达标但关闭自动提交]');
  {
    const { api, clicks } = setup(true, { autoSubmit: false });
    await api.Runner.start();
    ok(clicks.indexOf('saveBtn') >= 0, '★ 点了「暂时保存」');
    ok(clicks.indexOf('submitBtn') < 0, '没有点「提交」');
  }

  /* ---------- 场景 2：达标 + 自动提交开启 ---------- */
  console.log('\n[达标且开启自动提交]');
  {
    const { api, clicks } = setup(true, { autoSubmit: true });
    await api.Runner.start();
    ok(clicks.indexOf('submitBtn') >= 0, '点了「提交」');
    ok(clicks.indexOf('saveBtn') < 0, '没有多点一次保存');
  }

  /* ---------- 场景 3：开了自动提交但页面上没有提交按钮 ---------- */
  console.log('\n[找不到提交按钮]');
  {
    const { api, clicks } = setup(false, { autoSubmit: true });
    await api.Runner.start();
    ok(clicks.indexOf('saveBtn') >= 0, '★ 找不到提交按钮时退而保存，而不是什么都不做');
  }

  /* ---------- 场景 4：手动停止 ---------- */
  console.log('\n[手动停止]');
  {
    const { api, clicks } = setup(true, { autoSubmit: true });
    // 必须等至少一题真的填进去再停，否则「没有答案可保存」是正确行为，
    // 测不到我们想验证的那条路径
    const p = api.Runner.start();
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (api.Runner.stats && api.Runner.stats.answered > 0) {
          clearInterval(t);
          api.Runner.stop();
          resolve();
        }
      }, 2);
      setTimeout(() => { clearInterval(t); resolve(); }, 3000);
    });
    await p;
    ok(clicks.indexOf('saveBtn') >= 0, '★ 停止后先保存再退出');
  }

  /* ---------- 场景 5：关闭自动保存就不该点 ---------- */
  console.log('\n[关闭自动保存]');
  {
    const { api, clicks } = setup(true, { autoSubmit: false, autoSave: false });
    await api.Runner.start();
    ok(clicks.length === 0, '自动保存关闭时什么都不点（尊重设置）');
  }

  /* ---------- 场景 6：提交前自检能不能照超星的口径发现漏题 ---------- */
  console.log('\n[提交前自检]');
  {
    const { api } = setup(true, { autoSubmit: true });
    // 造三题：选择已答、选择未答、填空的 inpDiv 无内容
    const box = (inner) => {
      const d = global.document.createElement('div');
      d.innerHTML = inner;
      return d;
    };
    const q1 = { type: 'single', container: box('<input name="answer1" value="B">') };
    const q2 = { type: 'single', container: box('<input name="answer2" value="">') };
    const q3 = { type: 'blank', container: box('<div id="inpDiv9"></div>'), blanks: [{ kind: 'richtext', container: null }] };
    q3.blanks[0].container = q3.container;

    const empty = api.auditAnswerState([q1, q2, q3]);
    ok(empty.indexOf(1) < 0, '第 1 题有 value，算已答');
    ok(empty.indexOf(2) >= 0, '★ 第 2 题 input 为空 → 判定未完成');
    ok(empty.indexOf(3) >= 0, '★ 第 3 题 inpDiv 为空 → 判定未完成');
    ok(api.formatRanges([41, 42, 43, 50]) === '41-43、50', '题号区间压缩：41-43、50');
    ok(api.formatRanges([7]) === '7', '单题不带短横线');
    ok(api.formatRanges([]) === '', '空数组安全');
  }

  /* ---------- 场景 7：页面自带保存函数时优先调它 ---------- */
  console.log('\n[优先调页面函数]');
  {
    let called = null;
    const { api, w, clicks } = setup(true, { autoSubmit: false });
    // 超星的作业页在 iframe 里，函数挂在那个 window 上。
    // 这里直接挂在 jsdom 的 window 上，等价于"当前文档的 window"。
    w.noSubmit = function () { called = 'noSubmit'; };
    await api.Runner.start();
    ok(called === 'noSubmit', '★ 优先调用页面自带的 noSubmit()');
    ok(clicks.length === 0, '既然调函数成功，就不再点按钮');
  }

  /* ---------- 场景 8：manual 档什么都不做 ---------- */
  console.log('\n[手动档]');
  {
    const { api, w, clicks } = setup(true, { autoSubmit: false, autoSave: false });
    let called = null;
    w.noSubmit = function () { called = 'noSubmit'; };
    await api.Runner.start();
    ok(clicks.length === 0, '★ manual 档一个按钮都不点');
    ok(called === null, '★ 也不调用页面保存函数');
  }

  /* ---------- 场景 9：诊断能打出排查所需的信息 ---------- */
  console.log('\n[诊断输出]');
  {
    const { api, w } = setup(true, { autoSubmit: false, autoSave: false });
    w.noSubmit = function () {};
    await api.Runner.start();
    const text = api.Runner.diagnose();
    ok(text.indexOf('页面函数探测') >= 0, '含页面函数探测段');
    ok(text.indexOf('noSubmit = function') >= 0, '能看出 noSubmit 存在');
    ok(text.indexOf('可见按钮') >= 0, '含按钮清单段');
    ok(text.indexOf('暂时保存') >= 0, '清单里能看到「暂时保存」');
    ok(text.indexOf('每题在页面上的落点') >= 0, '含每题状态段');
    ok(text.indexOf('自检结论') >= 0, '含自检结论段');
  }

  /* ---------- 场景 10：答案状态读取（answertype 陷阱） ---------- */
  console.log('\n[答案状态读取]');
  {
    const { api } = setup(true, {});
    const mk = (html) => {
      const d = global.document.createElement('div');
      d.innerHTML = html;
      return d;
    };

    // 陷阱：input[name^="answer"] 会把 answertypeXXX 一起匹配进来，
    // 那个字段存的是题型（0/1/3），读到它等于每题都"已作答"
    const onlyType = mk('<input name="answertype123" value="0">');
    const r1 = api.readAnswerValue(onlyType);
    ok(r1 === null || r1 === '', '★ 只有 answertype 时读不到值（不会把题型当成答案）');

    const both = mk('<input name="answertype123" value="0"><input name="answer123" value="B">');
    ok(api.readAnswerValue(both) === 'B', '★ 跳过 answertype，读到真正的 answer123');

    ok(api.readAnswerValue(mk('<div></div>')) === null, '没有字段时返回 null');
    ok(api.readAnswerValue(null) === null, '空容器安全');
  }

  /* ---------- 场景 11：按超星字段核对填入结果 ---------- */
  console.log('\n[填入结果核对]');
  {
    const { api } = setup(true, {});
    const mk = (v) => {
      const d = global.document.createElement('div');
      d.innerHTML = '<input name="answer9" value="' + v + '">';
      return d;
    };

    const multi = { type: 'multi', container: mk('AC') };
    ok(api.verifyChoiceValue(multi, [{ key: 'A' }, { key: 'C' }]) === true, '多选 AC 对上 A、C');
    ok(api.verifyChoiceValue(multi, [{ key: 'A' }, { key: 'C' }, { key: 'D' }]) === false,
      '★ 多选少了 D → 判定不一致，会触发重试');
    ok(api.verifyChoiceValue(multi, [{ key: 'A' }]) === false, '★ 多选多选了 C → 也判定不一致');

    const single = { type: 'single', container: mk('B') };
    ok(api.verifyChoiceValue(single, [{ key: 'B' }]) === true, '单选对上');
    ok(api.verifyChoiceValue(single, [{ key: 'A' }]) === false, '单选对不上');

    const judge = { type: 'judge', container: mk('true') };
    ok(api.verifyChoiceValue(judge, [{ key: 'true' }]) === true, '判断 true 对上');

    // 真实数据里选项 key 是 A/B，字段值却是 true/false。
    // 用字母比必然对不上，会把所有判断题判成"点击未生效"。
    ok(api.verifyChoiceValue(judge, [{ key: 'A' }]) === true,
      '★ 判断题不会因为 key 是 A/B 就被判失败');

    // 超星多选题的字段可能带分隔符
    const multiComma = { type: 'multi', container: mk('A,C') };
    ok(api.verifyChoiceValue(multiComma, [{ key: 'A' }, { key: 'C' }]) === true,
      '★ 多选写成 A,C 也能正确比对');

    const noField = { type: 'single', container: mk('') };
    ok(api.verifyChoiceValue(noField, [{ key: 'A' }]) === false, '空值判定不一致');
  }

  /* ---------- 场景 12：已选中的选项不能被点掉 ---------- */
  console.log('\n[幂等填入]');
  {
    const { api } = setup(true, {});
    const d = global.document.createElement('div');
    d.innerHTML = '<input name="answer7" value="B"><li class="font-cxsecret">选项行</li>';
    const li = d.querySelector('li');

    // 类名里没有 cur/active 这类信号，只能靠 answer 字段判断
    ok(api.isOptionChecked({ key: 'A', clickEl: li, input: null }, d) === false, 'A 判定为未选');
    ok(api.isOptionChecked({ key: 'B', clickEl: li, input: null }, d) === true,
      '★ B 判定为已选 —— 不会再点它一下把答案点掉');
  }

  {
    // 判断题：选项 key 是 A/B，但 li 上带 val-param="true|false"
    const { api } = setup(true, {});
    const d = global.document.createElement('div');
    d.innerHTML = '<input name="answer8" value="true"><li val-param="true">对</li><li val-param="false">错</li>';
    const [liT, liF] = d.querySelectorAll('li');
    ok(api.isOptionChecked({ key: 'A', clickEl: liT, input: null }, d) === true,
      '★ 判断题 val-param=true 的选项判定为已选');
    ok(api.isOptionChecked({ key: 'B', clickEl: liF, input: null }, d) === false,
      '判断题 val-param=false 的选项判定为未选');
  }

  /* ---------- 场景 13：跳过等待 ---------- */
  console.log('\n[跳过等待]');
  {
    const { api } = setup(true, {});
    let threw = false;
    try { api.Runner.skipWait(); } catch (e) { threw = true; }
    ok(!threw, '不在等待中时调用 skipWait 安全');
  }

  /* ---------- 场景 7.5：猜题兜底 ---------- */
  console.log('\n[猜题兜底]');
  {
    const { api } = setup(true, {});
    const opt = (k, t) => ({ key: k, text: t || k });
    const single = { type: 'single', options: [opt('A'), opt('B'), opt('C'), opt('D')] };
    ok(api.makeGuess(single).length === 1 && api.makeGuess(single)[0].key === 'B', '★ 单选猜 B（原脚本同款）');

    const multi = { type: 'multi', options: [opt('A'), opt('B'), opt('C'), opt('D')] };
    ok(api.makeGuess(multi).length === 4, '★ 多选猜全选');

    const judge = { type: 'judge', options: [opt('A', '正确'), opt('B', '错误')] };
    ok(api.makeGuess(judge)[0].text === '错误', '★ 判断猜「错」');

    const noB = { type: 'single', options: [opt('甲'), opt('乙')] };
    ok(api.makeGuess(noB).length === 1, '没有 B 选项时退到第二个');

    ok(api.makeGuess(null) === null, '空输入安全');
  }

  /* ---------- 保存后的完成判定（原脚本行为：保存即继续） ---------- */
  console.log('\n[保存后的完成判定]');

  {
    const { api } = setup(true, {});
    const D = api.decideAfterSave;
    const cfg = { autoSave: true, minAnswerRate: 90 };

    // 1) 原脚本行为的核心：保存成功 + autoSave → 完成，刷课继续
    const r1 = D(true, cfg, 88.3, null);
    ok(r1.status === 'done', '★ 保存成功 + 自动保存 → done（原脚本行为，不再卡在原地）');
    ok(r1.submitted === false && r1.saved === true, 'done 但标记未提交、已保存');

    // 2) 卷面含填空/简答这类写不进的题型 → 同样保存即继续
    const r2 = D(true, cfg, 53, ['填空题']);
    ok(r2.status === 'done', '★ 含不支持题型 + 已保存 → done（原脚本从不为此卡流程）');

    // 3) 保存失败 → 答案没落库，必须停
    const r3 = D(false, cfg, 88.3, null);
    ok(r3.status === 'incomplete', '保存失败 → incomplete（继续会丢答案）');
    ok(/保存失败/.test(r3.reason), '失败原因写明保存没成功');

    // 4) 关掉自动保存 → 不代做决定，停下等用户
    const cfgNoSave = { autoSave: false, minAnswerRate: 90 };
    const r4 = D(true, cfgNoSave, 88.3, null);
    ok(r4.status === 'incomplete', 'autoSave 关闭 → 即使点了保存也不算完成');
  }

  console.log(`\n${'─'.repeat(44)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
