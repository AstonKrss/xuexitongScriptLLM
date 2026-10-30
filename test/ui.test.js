/* ============================================================
 * test/ui.test.js —— 面板挂载测试
 *
 * 这个用例是补出来的：初版只在答题页挂载面板，用户在课程页什么都看不到，
 * 连设置入口都没有，误以为脚本没生效。这类"功能在、但用户找不到入口"的问题
 * 单元测试和 e2e 都发现不了，只能专门测"挂载"这件事本身。
 *
 * 运行：node test/ui.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js', '40-parser.js', '60-cache.js', '70-runner.js', '80-ui.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

// 注意：这里刻意用「没有任何输入框」的普通页面，模拟用户所在的课程页
const PLAIN_PAGE = '<html><body><div id="app">学习通课程页面</div></body></html>';

const dom = new JSDOM(PLAIN_PAGE, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1', pretendToBeVisual: true });
const w = dom.window;

global.document = w.document;
global.window = w;
global.location = w.location;
global.getComputedStyle = w.getComputedStyle.bind(w);

const mem = new Map();
global.GM_getValue = (k) => mem.get(k);
global.GM_setValue = (k, v) => { mem.set(k, v); };
global.GM_xmlhttpRequest = function () { /* 本测试不发请求 */ };

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { UI, Config, AnswerCache };`)();
const { UI, Config } = api;

console.log('\n[面板挂载]');

UI.mount();

const shadow = UI.root && UI.root.shadowRoot;
ok(!!shadow, '面板挂载到了页面上（有 Shadow Root）');
ok(!!shadow.querySelector('.ball'), '悬浮齿轮按钮存在');
ok(!!shadow.querySelector('.panel'), '日志面板存在');
ok(!!shadow.querySelector('.sheet'), '设置面板存在');

console.log('\n[首次使用引导]');
ok(UI.ballEl.classList.contains('unconfigured'), '未填 key 时齿轮上有红点');
ok(UI.sheetEl.classList.contains('open'), '未填 key 时自动弹出设置面板（用户不用猜入口在哪）');

const presetSel = shadow.querySelector('#f-preset');
ok(!!presetSel && presetSel.options.length >= 7, `服务商下拉有预设（实际 ${presetSel ? presetSel.options.length : 0} 项）`);
ok(presetSel.value === 'deepseek', `默认选中 DeepSeek（实际 ${presetSel ? presetSel.value : '无'}）`);

console.log('\n[接口调试相关控件]');
ok(!!shadow.querySelector('#f-protocol'), '有「请求格式」下拉（OpenAI / Anthropic）');
ok(shadow.querySelector('#f-protocol').options.length === 2, '请求格式有两个选项');
ok(!!shadow.querySelector('#f-fetchmodels'), '有「拉取模型」按钮');
ok(!!shadow.querySelector('#f-result'), '有就地的测试结果容器（不再只写进隐藏的日志区）');
ok(!!shadow.querySelector('#f-jsonmode'), '有「使用 JSON 模式」开关');

console.log('\n[填完 key 后的状态]');
const cfg = Config.load();
cfg.profiles[cfg.activeProfileId].apiKey = 'sk-test-123';
Config.save();
UI.refreshConfigState();
ok(!UI.ballEl.classList.contains('unconfigured'), '填完 key 后红点消失');

console.log('\n[非答题页的分支]');
UI.setPageKind('other');
ok(UI.pageKind === 'other', '页面类型记录为「非答题页」');
UI.setPageKind('quiz');
ok(UI.pageKind === 'quiz', '页面类型可切换为「答题页」');

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
