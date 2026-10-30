/* ============================================================
 * test/course.test.js —— 自动刷课的导航逻辑
 *
 * 这部分只能在 jsdom 里验证"找不找得到"和"点不点得对"，
 * 真实播放没法测（jsdom 不实现 HTMLMediaElement）。
 *
 * 重点覆盖的是几个容易出错的判断：
 *   1. 页面到底是不是课程学习页；
 *   2. "下一节"按钮有几套结构，都得能找到；
 *   3. 目录树里不能点到已完成/上锁的节点，否则原地打转；
 *   4. 遇到作业页要停下来，别把作业当视频页硬点下一节。
 *
 * 运行：node test/course.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '50-matcher.js', '60-cache.js', '70-runner.js', '75-course.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

function setup(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1', pretendToBeVisual: true });
  const w = dom.window;
  global.document = w.document;
  global.window = w;
  global.location = w.location;
  global.getComputedStyle = w.getComputedStyle.bind(w);
  global.sessionStorage = w.sessionStorage;
  global.GM_getValue = () => undefined;
  global.GM_setValue = () => {};
  global.GM_xmlhttpRequest = function () {};

  const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  const prefix = `var UI = { setStatus: function(){}, mount: function(){}, openSettings: function(){} };\nvar unsafeWindow = undefined;\n`;
  // eslint-disable-next-line no-new-func
  const api = new Function(`${prefix}${code}\nreturn { CoursePilot, Runner, Config };`)();
  return { api, w, CP: api.CoursePilot, Runner: api.Runner, Config: api.Config };
}

/* ---------- 页面判别 ---------- */
console.log('\n[页面判别]');

{
  // 有目录树 = 学习页
  const { CP } = setup('<html><body><div class="posCatalog_select"></div></body></html>');
  ok(CP.available(document) === true, '有目录树 → 判定为学习页');
}

{
  // 有"下一节"按钮但没目录，也算（有些精简版页面没有目录）
  const { CP } = setup('<html><body><button class="jb_btn jb_btn_92 fs14 prev_next next">下一节</button></body></html>',
    'https://mooc1.chaoxing.com/knowledge/cards?x=1');
  ok(CP.available(document) === true, 'knowledge/cards 路径 → 学习页');
}

{
  const { CP } = setup('<html><body><div>空白</div></body></html>', 'https://mooc1.chaoxing.com/other/page');
  ok(CP.available(document) === false, '★ 没有目录也没有课程路径 → 不误判为学习页');
}

/* ---------- 找"下一节" ---------- */
console.log('\n[找下一节]');

{
  const { CP, CP: p2 } = setup(`<html><body>
    <div class="posCatalog_active posCatalog_select" id="cur123">第一节</div>
    <a class="jb_btn jb_btn_92 fs14 prev_next next">下一节</a>
  </body></html>`);
  const r = CP.findNextControl(document);
  ok(!!r, '能找到下一节控件');
  ok(r && r.kind === 'button', '★ 优先认「下一节」按钮（最可靠）');
  void p2;
}

{
  const { CP } = setup(`<html><body>
    <div class="actions"><span>下一节</span></div>
  </body></html>`);
  const r = CP.findNextControl(document);
  ok(!!r && r.kind === 'text', '没有专用按钮时按文字匹配');
}

{
  // 目录树：当前节点 active，后面两个，其中一个已完成、一个上锁
  const { CP } = setup(`<html><body>
    <div class="posCatalog_select posCatalog_active" id="cur1">第一节</div>
    <div class="posCatalog_select" id="cur2"><span class="icon_Completed prevTips"></span>已完成</div>
    <div class="posCatalog_select" id="cur3"><span class="catalog_points_er"></span>上锁</div>
    <div class="posCatalog_select" id="cur4">第四节</div>
  </body></html>`);
  const r = CP.findNextControl(document);
  ok(!!r, '目录树里能找到下一个节点');
  ok(r && r.kind === 'catalog', '类型是 catalog');
  ok(r && (r.el.textContent || '').indexOf('第四节') >= 0, '★ 跳过已完成和上锁的，直接落到第四节');
}

{
  // 没有可去的节点
  const { CP } = setup(`<html><body>
    <div class="posCatalog_select posCatalog_active" id="cur1">唯一一节</div>
  </body></html>`);
  ok(CP.findNextControl(document) === null, '★ 没有下一节时返回 null，不会原地打转');
}

{
  // active 节点不在 .posCatalog_select 列表里（结构对不上）。
  // 这时候如果从索引 0 开始遍历，会点到"第一节"，甚至当前这一节。
  const { CP } = setup(`<html><body>
    <div class="posCatalog_active">当前节（不属于 select 列表）</div>
    <div class="posCatalog_select" id="cur1">第一节</div>
    <div class="posCatalog_select" id="cur2">第二节</div>
  </body></html>`);
  ok(CP.findNextControl(document) === null, '★ active 不在候选列表里时宁可不动，也不从头点');
}

{
  // 老版目录：h4 带 cur 前缀
  const { CP } = setup(`<html><body>
    <h4 id="cur10" class="currents">第一章</h4>
    <h4 id="cur11">第二章</h4>
  </body></html>`);
  const r = CP.findNextControl(document);
  ok(!!r && r.kind === 'catalog-old', '老版 h4 目录也能定位');
}

/* ---------- 作业页识别 ---------- */
console.log('\n[作业页识别]');

{
  const { CP } = setup('<html><body><div class="TiMu">题目</div></body></html>');
  ok(CP.looksLikeHomework() === true, '★ 有 .TiMu → 认出是作业页，不去点下一节');
}

{
  const { CP } = setup('<html><body><input name="answer123" value="A"><input name="answer456" value="B"></body></html>');
  ok(CP.looksLikeHomework() === true, '有多个 answer 字段 → 也是作业页');
}

{
  const { CP } = setup('<html><body><div>普通学习内容</div></body></html>');
  ok(CP.looksLikeHomework() === false, '普通页面不误判为作业');
}

/* ---------- 找视频 ---------- */
console.log('\n[找视频]');

{
  const { CP, w } = setup('<html><body><div>无视频</div></body></html>');
  ok(CP.findVideo(w) === null, '没有视频时返回 null');
}

{
  // 视频埋在 iframe 里（超星的实际结构）
  const { CP, w } = setup('<html><body><iframe id="f"></iframe></body></html>');
  const ifr = w.document.getElementById('f');
  const idoc = ifr.contentDocument;
  const v = idoc.createElement('video');
  // jsdom 里 duration 默认 NaN，手动给一个，模拟元数据已加载
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  idoc.body.appendChild(v);

  const found = CP.findVideo(w);
  ok(found === v, '★ 递归进入 iframe 找到 video');
}

{
  // 有 video 但元数据没加载（duration 为 NaN）→ 不能返回它
  const { CP, w } = setup('<html><body><video></video></body></html>');
  ok(CP.findVideo(w) === null, '★ 元数据未加载的视频不能返回（播不了会卡住）');
}

/* ---------- 续跑标志 ---------- */
console.log('\n[续跑]');

{
  const { CP, w } = setup('<html><body><div class="posCatalog_select"></div></body></html>');
  let threw = false;
  try { CP.maybeResume(); } catch (e) { threw = true; }
  ok(!threw, '没有续跑标志时安全');
  ok(CP.running === false, '不会自己跑起来');
  void w;
}

{
  const { CP, w } = setup('<html><body><div class="posCatalog_select"></div></body></html>');
  w.sessionStorage.setItem('llmq:pilot', '1');
  let threw = false;
  try { CP.maybeResume(); } catch (e) { threw = true; }
  ok(!threw, '有标志时不抛错');
  // 3 秒后才真正启动，这里不等它，只确认没立刻跑
  ok(CP.running === false, '是延迟启动，不会在加载瞬间突然播视频');
}

/* ---------- 停止 ---------- */
console.log('\n[停止]');

{
  const { CP } = setup('<html><body><div class="posCatalog_select"></div></body></html>');
  let threw = false;
  try { CP.stop(); } catch (e) { threw = true; }
  ok(!threw, '没在运行时调用 stop 安全');
}

/* ---------- 作业自动作答 ---------- */
console.log('\n[作业自动作答]');

(async () => {
{
  const { CP } = setup('<html><body><div class="TiMu" qid="405890069">第一题</div><div class="TiMu" qid="405890070">第二题</div></body></html>');
  const hw = CP.detectHomework();
  ok(!!hw, '能认出作业');
  ok(!!hw.key, '★ 能给出作业标识：' + (hw.key || ''));
  ok(hw.key.indexOf('405890069') >= 0, '标识里带首个题目 id');
}

{
  // 同一份卷子，两次检测的 key 必须一样，否则去重失效会反复重做
  const { CP } = setup('<html><body><div class="TiMu" qid="111">题</div><div class="TiMu" qid="222">题</div></body></html>');
  const a = CP.detectHomework();
  const b = CP.detectHomework();
  ok(a && b && a.key === b.key, '★ 同一份卷子的标识稳定，去重才成立');
}

{
  // 换一份卷子要能区分开
  const { CP: c1 } = setup('<html><body><div class="TiMu" qid="111">题</div></body></html>');
  const k1 = c1.detectHomework().key;
  const { CP: c2 } = setup('<html><body><div class="TiMu" qid="999">题</div></body></html>');
  const k2 = c2.detectHomework().key;
  ok(k1 !== k2, '不同卷子的标识不同');
}

{
  const { CP } = setup('<html><body><div class="TiMu" qid="777">题</div></body></html>');
  const hw = CP.detectHomework();
  ok(CP.ranHomework()[hw.key] === undefined, '一开始没有做过记录');
  CP.markHomework(hw.key);
  ok(!!CP.ranHomework()[hw.key], '★ 标记之后能读到，下次会跳过这份卷子');
}

{
  // 没配 API Key 时不能硬跑，否则会空转
  const { CP } = setup('<html><body><div class="TiMu" qid="1">题</div></body></html>');
  const ran = await CP.runHomework();
  ok(ran === false, '★ 没配 API Key 时返回 false，不硬跑');
}

{
  const { CP } = setup('<html><body><div>普通页面</div></body></html>');
  ok(CP.detectHomework() === null, '不是作业时返回 null');
}

/* ---------- 作业必须真的做完 ---------- */
console.log('\n[作业完成判定]');

{
  const { CP, Runner, Config } = setup('<html><body><div class="TiMu" qid="1">题</div></body></html>');
  const cfg = Config.load();
  cfg.profiles.default.apiKey = 'sk-test';
  Config.save();

  // 模拟"跑完了但没做完"——这是真实发生过的情况：
  // 模型答不出、覆盖率不足，Runner 照常返回，但作业并没完成
  Runner.start = async () => {
    Runner.lastResult = { status: 'incomplete', reason: '覆盖率 50.0% 未达 100%', rate: 50, saved: false, submitted: false };
  };
  const r1 = await CP.runHomework();
  ok(r1 === false, '★ 覆盖率不足 → 判定没做完，主循环会停下来');

  Runner.start = async () => {
    Runner.lastResult = { status: 'done', reason: '', rate: 100, saved: true, submitted: false };
  };
  const r2 = await CP.runHomework();
  ok(r2 === true, '★ 填满且已保存 → 才算做完');

  Runner.start = async () => {
    Runner.lastResult = { status: 'filled', reason: '设置为「只填不存」', rate: 100, saved: false, submitted: false };
  };
  const r3 = await CP.runHomework();
  ok(r3 === false, '★ 只填不存 → 不算做完（答案没落库，跳过去就白做）');

  Runner.start = async () => {
    Runner.lastResult = { status: 'stopped', reason: '你点了停止', rate: 60, saved: true, submitted: false };
  };
  const r4 = await CP.runHomework();
  ok(r4 === false, '★ 中途停止 → 不算做完');

  Runner.start = async () => { Runner.lastResult = null; };
  const r5 = await CP.runHomework();
  ok(r5 === false, '★ 拿不到结果时不乐观放行，按没做完处理');
}

/* ---------- 任务清单（mArg）---------- */
console.log('\n[任务清单 mArg]');

{
  // 超星把任务清单埋在 script 里，格式和真实页面一致
  const { CP, w } = setup(`<html><body>
    <script>
      try{
          mArg = {"defaults":{"clazzId":"99","knowledgeid":"888","courseid":"777"},
                  "attachments":[
                    {"type":"video","job":true,"isPassed":false,"property":{"name":"第一章视频"},"jobid":"v1"},
                    {"type":"document","job":true,"isPassed":false,"jtoken":"tk1","property":{"name":"讲义"}},
                    {"type":"workid","job":true,"isPassed":false,"property":{"workid":"w9","title":"测验"},"jobid":"work-w9"},
                    {"type":"video","job":true,"isPassed":true,"property":{"name":"已看完"},"jobid":"v2"}
                  ]};
      }catch(e){}
    </script>
  </body></html>`);

  const marg = CP.findMarg(w);
  ok(!!marg && Array.isArray(marg.attachments), '★ 能从 script 里解析出 mArg');

  const t = CP.parseTasks(marg);
  ok(t.videos.length === 1, '未完成的视频收进待办（1 个）');
  ok(t.videos[0] && t.videos[0].property.name === '第一章视频', '视频名字带出来了');
  ok(t.documents.length === 1, '文档收进待办');
  ok(t.works.length === 1, '作业收进待办');
  ok(t.totalJobs === 4, '★ totalJobs = 4：已完成的也算，用来区分「本节无任务」和「任务全做完」');
  ok(t.defaults.clazzId === '99', 'defaults 里的 clazzId 带出来了');
}

{
  // mArg = "" 的空页面不能误解析
  const { CP, w } = setup('<html><body><script>try{\n    mArg = "";\n}catch(e){}</script></body></html>');
  ok(CP.findMarg(w) === null, '★ 空的 mArg 返回 null');
}

{
  // 真实页面的格式：先有占位声明 mArg = "";，try 块里才是对象。
  // 提取必须取「最后一个 mArg = {」，被占位那段干扰就什么都解析不出来
  const { CP, w } = setup(`<html><body>
    <script>
      mArg = "";
      try{
          mArg = {"defaults":{"clazzId":"55"},"attachments":[
            {"type":"document","job":true,"isPassed":false,"jtoken":"tk","property":{"name":"手册.pdf"}}
          ]};
      }catch(e){}
    </script>
  </body></html>`);

  const marg = CP.findMarg(w);
  ok(!!marg, '★ 占位声明 + try 赋值的真实格式能解析出来');
  const t = CP.parseTasks(marg);
  ok(t.documents.length === 1 && t.documents[0].property.name === '手册.pdf', '文档任务读到了');
}

{
  // 没有任务清单 → parseTasks 返回空
  const { CP, w } = setup('<html><body><script>var x = 1;</script></body></html>');
  ok(CP.findMarg(w) === null, '没有 mArg 返回 null');
  const t = CP.parseTasks(null);
  ok(t.videos.length + t.documents.length + t.works.length === 0 && t.totalJobs === 0, 'null 输入安全');
}

{
  // 我们自己的脚本文本里也有 "mArg" 字样（注释），不能被解析
  const { CP, w } = setup('<html><body><script>/* ==UserScript== */ var s = "mArg = 1;";</script></body></html>');
  ok(CP.findMarg(w) === null, '★ 带用户脚本标记的 script 不解析');
}

console.log(`\n${'─'.repeat(44)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
