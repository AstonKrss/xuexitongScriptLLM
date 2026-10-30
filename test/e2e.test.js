/* ============================================================
 * test/e2e.test.js —— 端到端联调（假模型）
 *
 * 把真实模块全部载入 jsdom，用一个假的 GM_xmlhttpRequest 冒充大模型接口，
 * 跑完 Runner.start() 的完整链路，最后检查页面上的单选框/复选框是否真的被勾上了。
 *
 * 这一步覆盖的是单元测试碰不到的东西：DOM 点击是否生效、题型分派是否正确、
 * 提交按钮能不能找到。跑通它，说明脚本在真实页面上大概率也能跑通。
 *
 * 运行：node test/e2e.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
// 注意：不加载 80-ui（面板）和 90-main（路由），它们依赖真实浏览器环境
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '50-matcher.js', '60-cache.js', '70-runner.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

/* ---------- 构造页面 ---------- */
const HTML = `
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
    <div class="stem">2. 以下属于水果的有？</div>
    <ul>
      <li><label><input type="checkbox" name="q2" value="A">A. 苹果</label></li>
      <li><label><input type="checkbox" name="q2" value="B">B. 白菜</label></li>
      <li><label><input type="checkbox" name="q2" value="C">C. 香蕉</label></li>
    </ul>
  </div>
  <div class="question">
    <div class="stem">3. 地球是平的。</div>
    <ul>
      <li><label><input type="radio" name="q3" value="t">正确</label></li>
      <li><label><input type="radio" name="q3" value="f">错误</label></li>
    </ul>
  </div>
</div>
<div class="footer"><button id="submitBtn">提交</button></div>
</body></html>
`;

/* ---------- 假模型：按题干关键词给答案 ---------- */
function fakeAnswer(userPrompt) {
  if (userPrompt.includes('首都')) return { choice: 'B', text: '北京', confidence: 0.95 };
  if (userPrompt.includes('水果')) return { choice: ['A', 'C'], text: ['苹果', '香蕉'], confidence: 0.9 };
  if (userPrompt.includes('地球是平的')) return { choice: 'false', text: '错误', confidence: 0.95 };
  return { choice: '', text: '', confidence: 0 };
}

const requestLog = [];

function setup(html) {
  const dom = new JSDOM(html, { url: 'https://mooc1.chaoxing.com/work/phone/doHomeWork?workId=1', pretendToBeVisual: true });
  const w = dom.window;

  global.document = w.document;
  global.window = w;
  global.location = w.location;
  global.getComputedStyle = w.getComputedStyle.bind(w);

  // GM 存储用内存 Map 冒充
  const mem = new Map();
  global.GM_getValue = (k) => mem.get(k);
  global.GM_setValue = (k, v) => { mem.set(k, v); };

  // 假的大模型接口：把请求体里的 user prompt 丢给 fakeAnswer，包成 OpenAI 格式返回
  global.GM_xmlhttpRequest = function (opts) {
    const body = JSON.parse(opts.data);
    const userMsg = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    requestLog.push({ url: opts.url, model: body.model, hasJsonMode: !!body.response_format, prompt: userMsg });

    setTimeout(() => {
      const ans = fakeAnswer(userMsg);
      opts.onload({
        status: 200,
        finalUrl: opts.url,
        responseText: JSON.stringify({
          model: body.model,
          choices: [{ message: { role: 'assistant', content: JSON.stringify(ans) } }],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
      });
    }, 5);
  };

  const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  // 注入 UI 桩，避免加载真实面板
  const prefix = `var UI = { setStatus: function(){}, mount: function(){}, openSettings: function(){} };\nvar unsafeWindow = undefined;\n`;
  // eslint-disable-next-line no-new-func
  const api = new Function(`${prefix}${code}\nreturn { Config, Runner, Parser, AnswerCache, computeMinDurationWait, formatDuration };`)();
  return { api, dom, w };
}

(async () => {
  console.log('\n[e2e] 开始联调');
  const { api, w } = setup(HTML);

  // 配置：填一个假 key，把填答案的间隔压到最短以免测试太慢
  const cfg = api.Config.load();
  cfg.profiles.default.apiKey = 'sk-test-key';
  cfg.profiles.default.baseUrl = 'https://api.deepseek.com';
  cfg.profiles.default.model = 'deepseek-chat';
  cfg.quiz.fillDelayMin = 1;
  cfg.quiz.fillDelayMax = 2;
  // 测试里关掉最短作答时长，否则 3 题 × 25 秒要真等 75 秒；
  // 这段逻辑改用下面的纯函数断言来验证
  cfg.quiz.enforceMinDuration = false;
  api.Config.save();

  const t0 = Date.now();
  await api.Runner.start();
  const elapsed = Date.now() - t0;

  const doc = w.document;
  const radio = (name, val) => {
    const el = doc.querySelector(`input[name="${name}"][value="${val}"]`);
    return el ? el.checked : null;
  };

  console.log('\n[断言]');
  ok(requestLog.length === 3, `向模型发了 3 次请求（实际 ${requestLog.length} 次）`);
  ok(requestLog.every((r) => r.url === 'https://api.deepseek.com/chat/completions'), '请求地址拼接正确（未重复拼 /chat/completions）');
  ok(requestLog.every((r) => r.model === 'deepseek-chat'), '请求带上模型名');
  ok(requestLog.every((r) => r.hasJsonMode === true), 'DeepSeek 预设启用了 JSON 模式');

  ok(radio('q1', 'B') === true, '单选题勾选了「北京」');
  ok(radio('q1', 'A') === false, '单选题没勾「上海」');

  ok(radio('q2', 'A') === true, '多选题勾选了「苹果」');
  ok(radio('q2', 'C') === true, '多选题勾选了「香蕉」');
  ok(radio('q2', 'B') === false, '多选题没勾「白菜」');

  ok(radio('q3', 'f') === true, '判断题勾选了「错误」');
  ok(radio('q3', 't') === false, '判断题没勾「正确」');

  ok(api.Runner.stats.answered === 3, `统计：3 题全部填入（实际 ${api.Runner.stats.answered}）`);
  ok(api.Runner.stats.total === 3, `统计：总题数 3（实际 ${api.Runner.stats.total}）`);

  /* ---------- 第二轮：验证缓存命中不再请求模型 ---------- */
  console.log('\n[第二轮] 验证缓存');
  // 重置页面勾选状态
  doc.querySelectorAll('input').forEach((i) => { i.checked = false; });
  const before = requestLog.length;
  const t1 = Date.now();
  await api.Runner.start();
  const second = requestLog.length - before;

  ok(second === 0, `第二轮没有再请求模型（实际 ${second} 次）`);
  ok(radio('q1', 'B') === true, '第二轮仍然正确填入（来自缓存）');
  ok(api.Runner.stats.cached === 3, `第二轮 3 题全部命中缓存（实际 ${api.Runner.stats.cached}）`);

  console.log(`\n耗时：首轮 ${elapsed}ms，次轮 ${Date.now() - t1}ms`);

  /* ---------- 第三轮：最短作答时长的计算 ---------- */
  console.log('\n[第三轮] 最短作答时长计算（纯函数）');
  {
    // 20 题 × 25 秒 = 500 秒，已过 60 秒 → 还差 440 秒
    const a = api.computeMinDurationWait(20, 25, 0, 60000);
    ok(a.requiredMs === 500000, `20题×25秒 = 500000ms（实际 ${a.requiredMs}）`);
    ok(a.remainMs === 440000, `已过60秒还应等440000ms（实际 ${a.remainMs}）`);

    // 已经超时就不该再等
    const b = api.computeMinDurationWait(20, 25, 0, 600000);
    ok(b.remainMs === 0, `已满足时等待为 0（实际 ${b.remainMs}）`);

    // 关掉开关或秒数为 0 时，由调用方跳过，这里只验证公式本身不产生负数
    const c = api.computeMinDurationWait(0, 25, 0, 0);
    ok(c.remainMs === 0, `0 题时等待为 0（实际 ${c.remainMs}）`);

    ok(api.formatDuration(500000) === '8 分 20 秒', `格式化 500 秒（实际 ${api.formatDuration(500000)}）`);
    ok(api.formatDuration(45000) === '45 秒', `格式化 45 秒（实际 ${api.formatDuration(45000)}）`);
  }

  console.log(`${'─'.repeat(40)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('联调异常：', e);
  process.exit(1);
});
