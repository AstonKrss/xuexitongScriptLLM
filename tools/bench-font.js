/* ============================================================
 * tools/bench-font.js —— 字体解码各阶段耗时实测
 *
 * 目的：回答「会不会卡」和「有多快」。用真实字体走一遍完整流程，
 * 每一步单独计时，而不是估算。
 *
 * 用的字体是 Noto Sans SC 的 500 字子集（196KB），比超星的字体
 * （常见 10~30KB）还大，属于偏保守的估计。
 *
 * 运行：NODE_PATH=<jsdom 所在目录> node tools/bench-font.js [字体路径]
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '05-lib-typr.js', '06-cx-table.js', '45-font.js'];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

/* 构造一个「像超星作业页」的环境：内嵌 base64 字体 + 一堆 .font-cxsecret 文本 */
function makePage(b64, text, repeat) {
  const body = Array.from({ length: repeat || 1 }, () => `<div class="font-cxsecret">${text}</div>`).join('');
  const html = `<!doctype html><html><head>
    <style id="cxSecretStyle">@font-face{font-family:font-cxsecret;src:url("data:application/font-ttf;base64,${b64}")}.font-cxsecret{font-family:font-cxsecret}</style>
  </head><body>${body}</body></html>`;
  return new JSDOM(html, { url: 'https://mooc1.chaoxing.com/' }).window.document;
}

async function main() {
  const fontPath = process.argv[2] || 'C:/Users/fang/AppData/Local/Temp/subset.ttf';
  if (!fs.existsSync(fontPath)) {
    console.log('找不到字体文件：' + fontPath);
    console.log('先跑：python -c "..." 生成子集，或传一个 TTF 路径进来');
    process.exit(1);
  }

  const ttf = fs.readFileSync(fontPath);
  const b64 = ttf.toString('base64');

  // 60 题的题干量级：约 300 个不同汉字
  const sampleText = '聚厩2035年建成文化强国战略廆标我们厦深廅把握社会主廋文廇本质主动顺应信息技术发展潮流将繁荣互联网条件下廌大众文廇写入当前阴霾不散怮威胁怮挑战怲增无减世界进愜怮的动荡变革期全怰治理走怬怮的十怭路口面怸人类向何处怳这一重怵课题我国提出构建人类命运共同体理怶和各国人民是懟球恌恊的根恷参与者愷受益者最高价值取懨联合国是全球最悖的恬府悒国悍组织普遍悓代悕悓悆威悓排他悓';

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mooc1.chaoxing.com/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.GM_getValue = () => undefined;
  global.GM_setValue = () => {};
  global.GM_xmlhttpRequest = function () {};

  const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  // eslint-disable-next-line no-new-func
  const api = new Function(`${code}\nreturn { FontDecoder, getCxGlyphMap, CX_GLYPH_COUNT, Typr, md5Hex };`)();
  const FD = api.FontDecoder;

  console.log('\n字体：' + path.basename(fontPath) + '  ' + Math.round(ttf.length / 1024) + ' KB');
  console.log('（超星的字体常见 10~30KB，这里用的是 500 字子集，属于偏大）');

  /* ---------- 1. 建字形哈希表（全局一次） ---------- */
  console.log('\n[1] 建对照表');
  {
    const t0 = process.hrtime.bigint();
    const m = api.getCxGlyphMap();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + api.CX_GLYPH_COUNT + ' 条 → Map：' + ms.toFixed(1) + ' ms');
    ok(m.size === api.CX_GLYPH_COUNT, '表建好了');
  }

  /* ---------- 2. base64 解码 ---------- */
  console.log('\n[2] base64 解码');
  {
    const t0 = process.hrtime.bigint();
    // 走一遍真实的解码路径（至少解出字节）
    const bytes = Buffer.from(b64, 'base64');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + Math.round(bytes.length / 1024) + ' KB：' + ms.toFixed(1) + ' ms');
    ok(bytes.length === ttf.length, '字节数一致');
  }

  /* ---------- 3. Typr 解析字体 ---------- */
  console.log('\n[3] 解析字体（Typr）');
  {
    const ab = ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength);
    const t0 = process.hrtime.bigint();
    const font = api.Typr.parse(ab)[0];
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + ms.toFixed(1) + ' ms');
    ok(!!font, '解析成功');
  }

  /* ---------- 4. 整页解码（ensureReady 全流程） ---------- */
  console.log('\n[4] 整页解码（页面 300 个字，重复 5 次共 1500 个）');
  {
    const doc = makePage(b64, sampleText, 5);
    const uniq = new Set();
    doc.querySelectorAll('.font-cxsecret').forEach((n) => { for (const c of n.textContent) uniq.add(c); });
    console.log('  页面上不同的字：' + uniq.size + ' 个');

    const t0 = process.hrtime.bigint();
    const okk = await FD.ensureReady(doc);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ensureReady：' + ms.toFixed(1) + ' ms（返回 ' + okk + '）');
    ok(ms < 500, '整页解码在 500ms 内完成（实际 ' + ms.toFixed(1) + 'ms）');
  }

  /* ---------- 5. 解码失败后的重试 ---------- */
  console.log('\n[5] 失败后再次点击（giveUp 生效）');
  {
    const doc = makePage(b64, sampleText, 1);
    const t0 = process.hrtime.bigint();
    await FD.ensureReady(doc);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  第二次调用：' + ms.toFixed(2) + ' ms（应立即返回，不做任何解析）');
    ok(ms < 5, 'giveUp 后瞬时返回，不会每次点都重新解析');
  }

  /* ---------- 6. decode 文本替换 ---------- */
  console.log('\n[6] 文本替换（纯查表）');
  {
    const text = sampleText.repeat(10);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) FD.decode(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
    console.log('  ' + text.length + ' 字 × 单次：' + ms.toFixed(3) + ' ms');
    ok(ms < 5, '单次替换可忽略');
  }

  console.log(`\n${'─'.repeat(46)}`);
  console.log('结论：全部是毫秒级，且没有任何渲染或分批等待——不会卡。');
  console.log(`（${passed} 项检查通过，${failed} 项失败）`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
