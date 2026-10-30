/* ============================================================
 * tools/verify-font.js —— 用真实字体 + 真实题面校验解码准确率
 *
 * 为什么要这个工具：
 *   「对照表到底能不能对上超星当前这套字体」这个问题，没法靠推测回答。
 *   拿一份真实字体，对着已知的密文/明文字对跑一遍，准确率是多少就是多少。
 *
 * 数据来源：tools/real-samples.json —— 密文取自用户导出的真实页面文本，
 *   明文是根据上下文推断的（时政题固定表述多，可靠性高）。所以它验证的是
 *   「解码结果和人的理解是否一致」，而不是「和超星官方答案是否一致」。
 *
 * 用法：
 *   node tools/verify-font.js <字体路径> [group]
 *   例：node tools/verify-font.js ~/Downloads/cx-font.ttf global-governance
 *
 * 退出码：准确率 >= 90% 返回 0，否则 1（方便脚本判断）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '05-lib-typr.js', '06-cx-table.js', '45-font.js'];

// Node 里跑 Typr 需要一个 window（它读 window.TextDecoder）
global.window = global;
global.atob = global.atob || ((s) => Buffer.from(s, 'base64').toString('latin1'));
global.GM_getValue = () => undefined;
global.GM_setValue = () => {};
global.GM_xmlhttpRequest = function () {};

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { Typr, md5Hex, getCxGlyphMap };`)();

const fontPath = process.argv[2];
const groupName = process.argv[3];

if (!fontPath) {
  console.log('用法：node tools/verify-font.js <字体路径> [group]');
  console.log('可用 group：');
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'real-samples.json'), 'utf8'));
  Object.keys(s.groups).forEach((k) => console.log('  ' + k + ' —— ' + s.groups[k].label));
  process.exit(1);
}
if (!fs.existsSync(fontPath)) {
  console.log('找不到字体：' + fontPath);
  process.exit(1);
}

const samples = JSON.parse(fs.readFileSync(path.join(__dirname, 'real-samples.json'), 'utf8'));
const groups = groupName ? { [groupName]: samples.groups[groupName] } : samples.groups;
if (groupName && !samples.groups[groupName]) {
  console.log('没有这个 group：' + groupName);
  process.exit(1);
}

const ttf = fs.readFileSync(fontPath);
console.log('\n字体：' + path.basename(fontPath) + '  ' + Math.round(ttf.length / 1024) + ' KB');

console.time('解析字体');
let font;
try {
  font = api.Typr.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength))[0];
} catch (e) {
  console.log('解析失败：' + e.message);
  console.log('如果是 woff2，先用 fontTools 转成 ttf：');
  console.log('  python -c "from fontTools.ttLib import TTFont; TTFont(\'a.woff2\').save(\'a.ttf\')"');
  process.exit(1);
}
console.timeEnd('解析字体');

const table = api.getCxGlyphMap();
const cache = new Map();

/** 解一个字符：不在字体里就返回 null（说明没加密） */
function decodeChar(ch) {
  if (cache.has(ch)) return cache.get(ch);
  const gid = api.Typr.U.codeToGlyph(font, ch.codePointAt(0));
  if (!gid) { cache.set(ch, null); return null; }
  const key = api.md5Hex(JSON.stringify(api.Typr.U.glyphToPath(font, gid))).slice(24);
  const real = table.get(key);
  const out = real ? String.fromCharCode(real) : false;   // false = 在字体里但表没收录
  cache.set(ch, out);
  return out;
}

let totalAll = 0;
let hitAll = 0;
let ranAny = false;

for (const [name, g] of Object.entries(groups)) {
  if (!g) continue;
  ranAny = true;
  console.log('\n=== ' + name + ' —— ' + g.label + ' ===');
  const pairs = Object.entries(g.pairs);
  let hit = 0;
  let miss = 0;
  let notInFont = 0;
  const wrong = [];

  for (const [cipher, plain] of pairs) {
    const got = decodeChar(cipher);
    if (got === null) {
      notInFont++;
      continue;
    }
    if (got === plain) hit++;
    else {
      miss++;
      wrong.push(cipher + ' 期望「' + plain + '」实际' + (got === false ? '（表里没有）' : '「' + got + '」'));
    }
  }

  totalAll += hit + miss;
  hitAll += hit;

  const judged = hit + miss;
  const rate = judged ? (hit / judged * 100) : 0;
  console.log('  可判定 ' + judged + ' 个（另有 ' + notInFont + ' 个不在字体里，说明该字未被加密）');
  console.log('  命中 ' + hit + ' / ' + judged + '  → 准确率 ' + rate.toFixed(1) + '%');
  if (wrong.length) {
    console.log('  不一致的：');
    wrong.slice(0, 20).forEach((w) => console.log('    ' + w));
    if (wrong.length > 20) console.log('    …共 ' + wrong.length + ' 个');
  }

  // 整段解码的效果，方便肉眼判断
  if (g.sample) {
    let out = '';
    let unknown = 0;
    for (const ch of g.sample) {
      const got = decodeChar(ch);
      if (got && got !== false) out += got;
      else { out += ch; if (got === false) unknown++; }
    }
    console.log('\n  解码后的题干：');
    console.log('  ' + out);
    if (unknown) console.log('  （其中 ' + unknown + ' 个字在字体里但表没收录）');
  }
}

if (!ranAny) {
  console.log('没有可用的样本组');
  process.exit(1);
}

const finalRate = totalAll ? hitAll / totalAll * 100 : 0;
console.log('\n' + '─'.repeat(50));
console.log('总体准确率：' + finalRate.toFixed(1) + '%（' + hitAll + '/' + totalAll + '）');
if (finalRate >= 90) {
  console.log('结论：对照表与这份字体匹配，可以正常使用。');
} else if (finalRate > 0) {
  console.log('结论：部分匹配，说明字体版本接近但不完全一致 —— 需要重建表。');
} else {
  console.log('结论：完全不匹配。这份字体的字形和对照表来源不是同一个版本，必须重建。');
}

// 同时做一次整表自检：字体里的字形有多少能在表中找到（不依赖样本，覆盖面更广）
let inFont = 0;
let found = 0;
const cjkStart = 0x4E00;
const cjkEnd = 0x9FA5;
for (let cp = cjkStart; cp <= cjkEnd; cp++) {
  const gid = api.Typr.U.codeToGlyph(font, cp);
  if (!gid) continue;
  inFont++;
  const key = api.md5Hex(JSON.stringify(api.Typr.U.glyphToPath(font, gid))).slice(24);
  if (table.has(key)) found++;
}
if (inFont) {
  console.log('\n全字表扫描：字体里含 ' + inFont + ' 个 CJK 字形，其中 ' + found +
    ' 个能在对照表中找到（' + (found / inFont * 100).toFixed(1) + '%）');
}

process.exit(finalRate >= 90 ? 0 : 1);
