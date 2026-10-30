/* ============================================================
 * tools/gen-table.js —— 把「字形哈希 → 汉字」对照表压成可直接内联的 JS
 *
 * 源文件 tools/cx-glyph-table.json 的格式是 {"8位十六进制哈希": 十进制码点}，
 * 共两万余条。直接内联约 355KB，压成「哈希串 + 汉字串」后约 210KB：
 *
 *   CX_GLYPH_KEYS  ：所有哈希按字典序拼成一个长字符串，每条固定 8 字符
 *   CX_GLYPH_CHARS ：对应位置的真实汉字，一条一个字符
 *
 * 用两个平行字符串而不是对象，是因为对象字面量的键名引号和冒号本身就占
 * 了三分之一的体积，而这两种形式在运行时建 Map 的成本几乎一样。
 *
 * 运行：node tools/gen-table.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'cx-glyph-table.json');
const OUT = path.join(__dirname, '..', 'src', '06-cx-table.js');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const entries = Object.keys(raw)
  // 表里有 4 条键长不是 8 的脏数据（生成脚本的边角 bug），筛掉。
  // 保留会导致按固定步长切片时整串错位，一条坏数据毁掉全表。
  .filter((k) => /^[0-9a-f]{8}$/i.test(k))
  .map((k) => [k.toLowerCase(), raw[k]])
  .filter(([, v]) => Number.isInteger(v) && v > 0 && v <= 0x10ffff)
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const keys = entries.map((e) => e[0]).join('');
const chars = entries.map((e) => String.fromCharCode(e[1])).join('');

if (keys.length !== entries.length * 8) throw new Error('键串长度异常');
if (chars.length !== entries.length) throw new Error('字串长度异常');

// 同一哈希不应映射到两个字；同一码点可能出现多次是正常的（保留首条）
const seen = new Set();
for (const [k] of entries) {
  if (seen.has(k)) throw new Error('哈希重复：' + k);
  seen.add(k);
}

const out = `/* ============================================================
 * 06-cx-table.js —— 超星字形哈希对照表（生成文件，请勿手改）
 *
 * 来源：超星把思源黑体的「码位 → 字形」映射打乱来混淆题目文本。
 * 字形本身没变，所以对字形轮廓算哈希就能反查出原来的字——
 * 这张表就是「字形轮廓哈希 → 真实汉字」的对照。
 *
 * 关键性质：**与字体文件无关**。每页的字体文件都不同（码位随机分配），
 * 但同一个汉字的字形轮廓永远一样，哈希自然一样。所以一张表通用所有页面。
 *
 * 生成：node tools/gen-table.js
 * 条目：${entries.length} 条，覆盖 CJK 基本区（U+4E00–U+9FA5）
 * ============================================================ */

const CX_GLYPH_KEYS = ${JSON.stringify(keys)};
const CX_GLYPH_CHARS = ${JSON.stringify(chars)};
const CX_GLYPH_COUNT = ${entries.length};

let _cxGlyphMap = null;

/** 懒加载：第一次用到才建 Map，避免脚本在非答题页白跑两万次插入 */
function getCxGlyphMap() {
  if (_cxGlyphMap) return _cxGlyphMap;
  _cxGlyphMap = new Map();
  for (let i = 0; i < CX_GLYPH_COUNT; i++) {
    _cxGlyphMap.set(CX_GLYPH_KEYS.substring(i * 8, i * 8 + 8), CX_GLYPH_CHARS.charCodeAt(i));
  }
  return _cxGlyphMap;
}
`;

fs.writeFileSync(OUT, out, 'utf8');
console.log('✓ 已生成 src/06-cx-table.js');
console.log('  条目 ' + entries.length + ' 条');
console.log('  体积 ' + (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1) + ' KB');
