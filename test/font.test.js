/* ============================================================
 * test/font.test.js —— 字体解码（v3：字形轮廓哈希）
 *
 * v2 用 canvas 位图比对，在 Node 里根本没法验证，也测不出「解错了」——
 * 因为它从不报错，只会给出一个看似合理的错字。
 *
 * v3 改成解析字体轮廓算哈希，每一步都能单独验证：
 *   MD5 实现对不对、base64 解的对不对、CSS 里的字体找得对不对，
 *   以及最关键的——**表和字体对不上时会不会正确地停下来**。
 *
 * 最后一项用系统自带黑体做真实链路：黑体的字形哈希必然查不到思源黑体的表，
 * 正确行为是判定失败并停用，而不是硬解出一堆错字。
 *
 * 运行：node test/font.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '05-lib-typr.js', '06-cx-table.js', '45-font.js'];

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

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mooc1.chaoxing.com/' });
const w = dom.window;
global.window = w;
global.document = w.document;
// 注意：不要用 jsdom 的 atob —— 它依赖内部 window 状态，脱离上下文调用会误报
// 「contains invalid characters」。Node 16+ 自带全局 atob，浏览器里也有。
global.GM_getValue = () => undefined;
global.GM_setValue = () => {};
global.GM_xmlhttpRequest = function () {};

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { FontDecoder, md5Hex, base64ToBytes, getCxGlyphMap, CX_GLYPH_KEYS, CX_GLYPH_CHARS, CX_GLYPH_COUNT, Typr };`)();
const FD = api.FontDecoder;

/* ---------- MD5 ---------- */
console.log('\n[MD5]');

// 自己实现的 MD5 必须和 OpenSSL 完全一致，否则所有哈希都对不上表
const md5Inputs = ['', 'abc', '中文', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '{"cmds":["M"],"crds":[1,2]}'];
let md5ok = true;
for (const s of md5Inputs) {
  const mine = api.md5Hex(s);
  const ref = crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');
  if (mine !== ref) {
    md5ok = false;
    console.log('    不一致: ' + JSON.stringify(s.slice(0, 20)) + ' ' + mine + ' != ' + ref);
  }
}
ok(md5ok, '★ 自实现 MD5 与 Node crypto 一致（8 组输入，含 55/56/64 字节分块边界）');
eq(api.md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72', '标准测试向量 abc');
eq(api.md5Hex('中文').length, 32, '中文输入输出 32 位十六进制');

/* ---------- base64 ---------- */
console.log('\n[base64]');

{
  const raw = 'font-binary-\u0000\u0001\u00ff';
  const buf = Buffer.from(raw, 'latin1');
  const out = api.base64ToBytes(buf.toString('base64'));
  ok(out.length === buf.length, 'base64 解出的长度一致');
  let same = true;
  for (let i = 0; i < buf.length; i++) if (out[i] !== buf[i]) same = false;
  ok(same, '★ base64 解出的字节完全一致');
  ok(api.base64ToBytes('YWJj\n  ').length === 3, '忽略换行和空格');
}

/* ---------- 对照表结构 ---------- */
console.log('\n[对照表]');

ok(api.CX_GLYPH_COUNT > 20000, `对照表条目数 ${api.CX_GLYPH_COUNT}（应覆盖 CJK 基本区）`);
eq(api.CX_GLYPH_KEYS.length, api.CX_GLYPH_COUNT * 8, '★ 哈希串长度 = 条目数 × 8（错位一位就整表失效）');
eq(api.CX_GLYPH_CHARS.length, api.CX_GLYPH_COUNT, '汉字串长度 = 条目数');

{
  const m = api.getCxGlyphMap();
  eq(m.size, api.CX_GLYPH_COUNT, 'Map 条目数与表一致');
  // 随机抽 200 条验证「键 → 值」的对应关系没被切片错位
  let spot = true;
  for (let i = 0; i < 200; i++) {
    const idx = Math.floor(Math.random() * api.CX_GLYPH_COUNT);
    const k = api.CX_GLYPH_KEYS.substring(idx * 8, idx * 8 + 8);
    if (m.get(k) !== api.CX_GLYPH_CHARS.charCodeAt(idx)) { spot = false; break; }
  }
  ok(spot, '★ 随机抽查 200 条，哈希与汉字的对应关系正确');
  ok(/^[0-9a-f]{8}$/.test(api.CX_GLYPH_KEYS.slice(0, 8)), '哈希是小写 8 位十六进制');
}

/* ---------- 从 CSS 里找字体 ---------- */
console.log('\n[定位字体]');

{
  const css = '<style id="cxSecretStyle">@font-face{font-family:font-cxsecret;src:url("data:application/font-ttf;base64,AAAA")}.font-cxsecret{font-family:font-cxsecret}</style>';
  const r = FD.extractFontSrc(css);
  ok(!!r, '能认出标准的内嵌 base64 字体');
  eq(r && r.kind, 'base64', '类型是 base64');
  eq(r && r.value, 'AAAA', '取到 base64 内容');
}

{
  const css = "@font-face{font-family:'font-cxsecret';src:url(https://cdn.example.com/a.woff?v=2) format('woff')}";
  const r = FD.extractFontSrc(css);
  eq(r && r.kind, 'url', '外链 woff 也能认出来');
  eq(r && r.value, 'https://cdn.example.com/a.woff?v=2', '外链地址完整保留');
}

{
  // 反例：只有 class 没有 @font-face。医学英语这类页面就是这样，文字本来是明文
  eq(FD.extractFontSrc('.font-cxsecret{font-family:font-cxsecret}'), null,
    '★ 只有 class 没有 @font-face → 判定没有加密字体');
  eq(FD.extractFontSrc(''), null, '空 CSS 安全');
  eq(FD.extractFontSrc('<style>.a{color:red}</style>'), null, '无关 CSS 返回 null');
}

{
  // 没有 font-cxsecret 字样但确实有字体 data URL：兜底路径
  const r = FD.extractFontSrc('body{background:url(data:application/x-font-ttf;base64,BBBB)}');
  ok(!!r, '兜底能匹配不带 font-cxsecret 字样的字体 data URL');
}

/* ---------- 未就绪时不能改字 ---------- */
console.log('\n[未就绪]');

(async () => {
{
  eq(FD.decode('聚厩2035年'), '聚厩2035年', '★ 未就绪时 decode 原样返回');
  eq(FD.decode(''), '', '空串安全');
  eq(FD.decode(null), null, 'null 安全');
  eq(FD.decode(undefined), undefined, 'undefined 安全');
  ok(FD.describeSamples().length > 0, 'describeSamples 有兜底文案');
}

{
  // 页面没有字体时 ensureReady 要返回 false，而不是抛错或卡住
  const empty = new JSDOM('<html><body><div class="font-cxsecret">聚厩</div></body></html>').window.document;
  const ready = await FD.ensureReady(empty);
  ok(ready === false, '没有字体时 ensureReady 返回 false');
  ok(FD.failedReason.indexOf('没有') >= 0, '给出了可读的失败原因');
  ok(FD.giveUp === false, '这种情况不算"表不匹配"，不置 giveUp');
}

/* ---------- 真实字体：表不匹配必须停下 ---------- */
console.log('\n[真实字体链路]');

const FONT_PATH = 'C:/Windows/Fonts/simhei.ttf';
if (fs.existsSync(FONT_PATH)) {
  const b64 = fs.readFileSync(FONT_PATH).toString('base64');
  const html = `<!doctype html><html><head>
    <style id="cxSecretStyle">@font-face{font-family:font-cxsecret;src:url("data:application/font-ttf;base64,${b64}")}.font-cxsecret{font-family:font-cxsecret}</style>
  </head><body><div class="font-cxsecret">中国的首都是北京</div></body></html>`;
  const d = new JSDOM(html, { url: 'https://mooc1.chaoxing.com/' }).window.document;

  ok(FD.available(d) === true, '能识别出页面里有加密字体');

  const chars = Array.from(FD.collectEncryptedChars(d));
  ok(chars.length === 8, `采集到 8 个加密字符（实际 ${chars.length}）`);

  // 黑体的字形和思源黑体不同，哈希必然查不到表。
  // 正确行为：判定失败、置 giveUp、绝不硬解。
  const ready = await FD.ensureReady(d);
  ok(ready === false, '★ 字形与对照表不符时 ensureReady 返回 false');
  ok(FD.giveUp === true, '★ 置 giveUp，本次会话不再重试（避免每次点开始都白等）');
  ok(/匹配失败|命中率过低/.test(FD.failedReason), '失败原因指向哈希不匹配：' + FD.failedReason);
  eq(FD.decode('中国的首都'), '中国的首都', '★ 失败后 decode 一个字都不改');
} else {
  console.log('  （跳过：本机没有 ' + FONT_PATH + '）');
}

/* ---------- 视觉识别未收录字形（v1.6.0） ---------- */
console.log('\n[视觉识别]');

{
  // glyphImageDataUrl / loadFontFace 依赖 canvas 和 FontFace，Node 里没有；
  // 但 identifyMissedGlyphs 的核心逻辑（请求编排、结果解析、持久化、跳过已知）
  // 可以通过替换这两个方法 + mock GM 层做端到端验证。

  // 可变的 GM 存储，模拟脚本管理器的持久化
  const store = {};
  global.GM_getValue = (k, d) => (k in store ? store[k] : d);
  global.GM_setValue = (k, v) => { store[k] = v; };

  // 收集所有发出的请求，按序回放预设响应
  let pendingRequests = [];
  let sentRequests = [];
  global.GM_xmlhttpRequest = function (opts) {
    sentRequests.push(opts);
    const r = pendingRequests.shift();
    if (r) setTimeout(() => opts.onload(r), 0);
    else setTimeout(() => opts.onerror && opts.onerror({ error: 'no mock' }), 0);
  };

  // 独立的解码器实例（避免污染上面真实链路测试的状态）
  const VD = Object.create(FD);
  VD.map = new Map();
  VD.samples = [];
  VD.stats = { chars: 2, matched: 0, missed: 2, notInFont: 0 };
  VD.missedGlyphs = [{ key: 'hashAAA', ch: '吜' }, { key: 'hashBBB', ch: '嬤' }];
  VD.fontBytes = new Uint8Array([1]);
  // canvas / FontFace 都没有 → 渲染和挂载用桩顶上
  VD.glyphImageDataUrl = (ch) => 'data:image/png;base64,FAKE_' + ch;
  VD.loadFontFace = async () => true;

  const mkRes = (text) => ({ responseText: JSON.stringify({ choices: [{ message: { content: text } }] }) });

  // 1) 模型正常认出两个字
  pendingRequests = [mkRes('党'), mkRes('成')];
  const r1 = await (async () => {
    try { return await VD.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' }); }
    catch (e) { return { identified: -1, failed: -1, err: e.message }; }
  })();
  eq(r1, { identified: 2, failed: 0 }, '两个未收录字形全部识别成功');
  eq(sentRequests.length, 2, '发出 2 次视觉请求');
  ok(sentRequests[0].data.indexOf('data:image/png') >= 0, '请求体带 PNG dataURL（image_url 格式）');
  ok(sentRequests[0].data.indexOf('test-vision') >= 0, '请求体带模型名');
  ok(sentRequests[0].headers.Authorization === 'Bearer k', '带 Bearer 鉴权头');
  eq(VD.map.get('吜'), '党', '识别结果写入内存映射（吜→党）');
  eq(VD.map.get('嬤'), '成', '识别结果写入内存映射（嬤→成）');

  // 2) 持久化：扩展表里按字形哈希存了码点。
  //    gmSet 以 JSON 字符串落盘，读回时必须 parse（这里曾经直读字符串导致误报）
  const extra = JSON.parse(store['llmq:glyphExtra'] || '{}');
  eq(extra['hashAAA'], '党'.codePointAt(0), '扩展表按哈希存码点（hashAAA→党）');
  eq(extra['hashBBB'], '成'.codePointAt(0), '扩展表按哈希存码点（hashBBB→成）');

  // 3) 已经认过的字形不再发请求
  sentRequests = [];
  const VD2 = Object.create(FD);
  VD2.map = new Map();
  VD2.samples = [];
  VD2.stats = { chars: 1, matched: 0, missed: 1, notInFont: 0 };
  VD2.missedGlyphs = [{ key: 'hashAAA', ch: '吜' }];
  VD2.fontBytes = new Uint8Array([1]);
  VD2.glyphImageDataUrl = () => 'data:image/png;base64,X';
  VD2.loadFontFace = async () => true;
  const r2 = await VD2.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  eq(r2.identified, 1, '已识别过的字形直接命中，identified 计数');
  eq(sentRequests.length, 0, '★ 已识别过的字形不再发请求（一次识别永久生效）');

  // 4) 模型回答含杂质（"是【党】。"）→ 只留汉字
  sentRequests = [];
  const VD3 = Object.create(FD);
  VD3.map = new Map();
  VD3.samples = [];
  VD3.stats = { chars: 1, matched: 0, missed: 1, notInFont: 0 };
  VD3.missedGlyphs = [{ key: 'hashCCC', ch: '呉' }];
  VD3.fontBytes = new Uint8Array([1]);
  VD3.glyphImageDataUrl = () => 'data:image/png;base64,X';
  VD3.loadFontFace = async () => true;
  pendingRequests = [mkRes('是【党】。')];
  const r3 = await VD3.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  eq(r3, { identified: 1, failed: 0 }, '模型回答带杂质时仍能提取汉字');
  eq(VD3.map.get('呉'), '党', '杂质被过滤，映射正确');

  // 5) 模型答非汉字 → failed 计数，不写表
  sentRequests = [];
  pendingRequests = [mkRes('sorry I cannot')];
  const r4 = await VD3.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  // 注意 VD3 的 missedGlyphs 只有 1 项且已被标记 → 换新 key 才会真的请求
  ok(r4.identified === 1 && r4.failed === 0, '已识别的不重复处理');
  const VD4 = Object.create(FD);
  VD4.map = new Map();
  VD4.samples = [];
  VD4.stats = { chars: 1, matched: 0, missed: 1, notInFont: 0 };
  VD4.missedGlyphs = [{ key: 'hashDDD', ch: '吚' }];
  VD4.fontBytes = new Uint8Array([1]);
  VD4.glyphImageDataUrl = () => 'data:image/png;base64,X';
  VD4.loadFontFace = async () => true;
  pendingRequests = [mkRes('???')];
  const r5 = await VD4.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  eq(r5, { identified: 0, failed: 1 }, '模型答非汉字 → 计入 failed');
  eq(VD4.map.get('吚'), undefined, 'failed 不写映射');
  ok(!JSON.parse(store['llmq:glyphExtra'] || '{}')['hashDDD'], 'failed 不写持久化表');

  // 6) 网络失败（onerror）→ failed，不崩
  sentRequests = [];
  pendingRequests = [];  // 空队列 → 走 onerror
  const VD5 = Object.create(FD);
  VD5.map = new Map();
  VD5.samples = [];
  VD5.stats = { chars: 1, matched: 0, missed: 1, notInFont: 0 };
  VD5.missedGlyphs = [{ key: 'hashEEE', ch: '妑' }];
  VD5.fontBytes = new Uint8Array([1]);
  VD5.glyphImageDataUrl = () => 'data:image/png;base64,X';
  VD5.loadFontFace = async () => true;
  const r6 = await VD5.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  eq(r6, { identified: 0, failed: 1 }, '请求失败（onerror）→ failed 且不抛异常');

  // 7) 没填模型名 → 直接 no-op
  sentRequests = [];
  const r7 = await VD5.identifyMissedGlyphs({});
  eq(r7, { identified: 0, failed: 1 }, '未配置视觉模型 → no-op 不发请求');
  eq(sentRequests.length, 0, 'no-op 确实没发请求');

  // 8) 停止指令生效
  const VD6 = Object.create(FD);
  VD6.map = new Map();
  VD6.samples = [];
  VD6.stats = { chars: 2, matched: 0, missed: 2, notInFont: 0 };
  VD6.missedGlyphs = [{ key: 'hashF1', ch: '吥' }, { key: 'hashF2', ch: '玢' }];
  VD6.fontBytes = new Uint8Array([1]);
  VD6.glyphImageDataUrl = () => 'data:image/png;base64,X';
  VD6.loadFontFace = async () => true;
  VD6.stopGlyphScan = true;
  sentRequests = [];
  const r8 = await VD6.identifyMissedGlyphs({ model: 'test-vision', apiKey: 'k' });
  eq(sentRequests.length, 0, '停止指令下不发请求');

  // 9) buildMap 的扩展表查找：extra 里的哈希要能顶上内置表没有的字形。
  //    直接验证查找表达式（table.get(key) || extra[key]）的语义：
  const table = new Map();                      // 内置表为空
  const extra2 = { hashAAA: '党'.codePointAt(0) };
  const key = 'hashAAA';
  const real = table.get(key) || (extra2[key] || null);
  eq(String.fromCharCode(real), '党', '扩展表码点还原为字符');
  const miss = table.get('nope') || (extra2['nope'] || null);
  eq(miss, null, '两边都查不到 → null → 进 missedList');

  // 恢复全局 GM 桩，避免影响其它测试文件（同进程无此问题，但保持整洁）
  global.GM_getValue = () => undefined;
  global.GM_setValue = () => {};
  global.GM_xmlhttpRequest = function () {};
}

/* ---------- Typr 可用性 ---------- */
console.log('\n[Typr]');

ok(api.Typr && typeof api.Typr.parse === 'function', 'Typr.parse 可用');
ok(api.Typr.U && typeof api.Typr.U.codeToGlyph === 'function', 'Typr.U.codeToGlyph 可用');
ok(api.Typr.U && typeof api.Typr.U.glyphToPath === 'function', 'Typr.U.glyphToPath 可用');

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
