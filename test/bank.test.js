/* ============================================================
 * test/bank.test.js —— 题库优先查询
 *
 * 覆盖四件关键行为：
 *   1. 题库返回的答案格式很随意（"B" / "ABC" / 多选拼接串 / 选项原文），都要能正确归一化；
 *   2. 默认先用页面加密态原文（raw）查，查不到再用解码后的文字查——因为众包题库
 *      靠 hookHTML 直接上传页面 HTML，存的就是加密态乱码原文；
 *   3. 题库返回加密态选项原文时，既能在已解码题目上匹配，也能通过 rawOrigText 命中；
 *   4. 接口连续失败时整轮停用，不然 60 道题每题都要白等几秒超时。
 *
 * 运行：node test/bank.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '30-llm.js', '40-parser.js', '50-matcher.js', '35-bank.js'];

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

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { QuestionBank, bankToAnswer, matchAnswer };`)();
const QB = api.QuestionBank;
const toAns = api.bankToAnswer;

/* ---------- 答案归一化 ---------- */
console.log('\n[题库答案归一化]');

eq(toAns('B', 'single').choice, 'B', '单选返回 "B"');
eq(toAns('B.', 'single').choice, 'B', '单选返回 "B." 带句点');
eq(toAns('（C）', 'single').choice, 'C', '单选返回全角括号');
eq(toAns('北京', 'single').text, '北京', '单选返回选项原文');
eq(toAns('AC', 'multi').choice, ['A', 'C'], '多选返回 "AC"');
eq(toAns('A、C', 'multi').choice, ['A', 'C'], '多选返回 "A、C"');
eq(toAns('苹果#香蕉', 'multi').text, ['苹果', '香蕉'], '多选 # 分隔返回多项');
eq(toAns('苹果---香蕉', 'multi').text, ['苹果', '香蕉'], '多选 --- 分隔返回多项');
eq(toAns('正确', 'judge').choice, 'true', '判断返回"正确"');
eq(toAns('错', 'judge').choice, 'false', '判断返回"错"');
eq(toAns('', 'single'), null, '空答案返回 null');
eq(toAns('AB', 'single'), null, '单选却给两个字母，判定格式异常并放弃');

/* ---------- 查询流程 ---------- */
console.log('\n[查询流程]');

let calls = [];
function stubGM(handler) {
  calls = [];
  global.GM_xmlhttpRequest = function (opts) {
    calls.push(opts);
    setTimeout(() => handler(opts, calls.length), 1);
  };
}

const CFG = { enabled: true, endpoint: 'https://bank.example/q', token: 'tk', timeoutMs: 1000, order: 'raw' };

(async () => {
  console.log('\n[1] 默认（raw 优先）：第一个形式就命中加密原文');
  stubGM((opts) => opts.onload({ status: 200, responseText: JSON.stringify({ code: 0, data: 'C' }) }));
  QB.reset();
  const q1 = { type: 'single', stem: '解码后的题干', rawStem: '加密态题干' };
  const a1 = await QB.lookup(q1, CFG);
  eq(a1 && a1.choice, 'C', '拿到答案 C');
  eq(calls.length, 1, '只发了一次请求');
  ok(decodeURIComponent(calls[0].data).indexOf('加密态题干') >= 0, '★ 优先用页面加密原文查询（与众包题库一致）');
  ok(calls[0].headers.Authorization === 'tk', '带上 token');

  console.log('\n[2] 加密原文查不到，回退用解码后的明文');
  stubGM((opts) => {
    const body = decodeURIComponent(opts.data);
    if (body.indexOf('解码后的题干') >= 0) {
      opts.onload({ status: 200, responseText: JSON.stringify({ code: 0, data: '北京' }) });
    } else {
      opts.onload({ status: 200, responseText: JSON.stringify({ code: -1, msg: '未找到' }) });
    }
  });
  QB.reset();
  const a2 = await QB.lookup(q1, CFG);
  eq(calls.length, 2, '★ 发了两次请求');
  ok(decodeURIComponent(calls[1].data).indexOf('解码后的题干') >= 0, '第二次用解码后的明文');
  eq(a2 && a2.text, '北京', '回退后拿到答案');

  console.log('\n[2.5] 显式指定 order=decoded 时仍可先查解码文');
  stubGM((opts) => opts.onload({ status: 200, responseText: JSON.stringify({ code: 0, data: 'A' }) }));
  QB.reset();
  await QB.lookup(q1, Object.assign({}, CFG, { order: 'decoded' }));
  ok(decodeURIComponent(calls[0].data).indexOf('解码后的题干') >= 0, 'order=decoded 先查解码文');

  console.log('\n[2.6] 题库返回加密态选项原文时，也能匹配到已解码选项');
  const qEnc = {
    type: 'multi',
    stem: '解码后的题干',
    rawStem: '加密态题干',
    options: [
      { key: 'A', text: '完善社会治理体系', rawOrigText: '完呚社会治呟体系' },
      { key: 'B', text: '不断健全国家安全体系', rawOrigText: '不呒健全国家安全体系' },
      { key: 'C', text: '错误选项', rawOrigText: '错呫选项' },
    ],
  };
  const mEnc = api.matchAnswer(qEnc, toAns('完呚社会治呟体系#不呒健全国家安全体系', 'multi'));
  eq(mEnc && mEnc.options.map((o) => o.key), ['A', 'B'], '★ 加密态选项原文命中 rawOrigText，不会丢弃');

  console.log('\n[3] 两种形式都没收录');
  stubGM((opts) => opts.onload({ status: 200, responseText: JSON.stringify({ code: -1 }) }));
  QB.reset();
  eq(await QB.lookup(q1, CFG), null, '返回 null，交给模型');

  console.log('\n[4] 填空题不查题库');
  QB.reset();
  const before = calls.length;
  eq(await QB.lookup({ type: 'blank', stem: '填空' }, CFG), null, '填空题直接返回 null');
  eq(calls.length, before, '★ 没有为填空题发请求');

  console.log('\n[5] 接口连续失败后停用');
  stubGM((opts) => opts.onerror({ error: 'network down' }));
  QB.reset();
  await QB.lookup(q1, CFG);
  await QB.lookup(q1, CFG);
  ok(QB.disabled, '★ 连续两次失败后整轮停用');
  const n = calls.length;
  await QB.lookup(q1, CFG);
  eq(calls.length, n, '停用后不再发请求');

  console.log('\n[6] 未启用时不请求');
  stubGM(() => {});
  QB.reset();
  eq(await QB.lookup(q1, Object.assign({}, CFG, { enabled: false })), null, '未启用返回 null');
  eq(calls.length, 0, '一次请求都没发');

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
