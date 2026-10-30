/* ============================================================
 * build.js —— 把 src/ 下的模块拼成一个可安装的 .user.js
 *
 * 为什么要这个文件：
 *   油猴脚本必须是单文件，但单文件写到 2000 行就没法审阅了。
 *   所以源码按职责拆成多个模块，构建时按文件名排序拼接（文件名前缀即加载顺序），
 *   统一包进一个 IIFE 里，避免污染页面全局作用域。
 *
 * 用法：node build.js
 * 无第三方依赖，只用 Node 内置模块。
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = 'chaoxing-llm-quiz.user.js';

function build() {
  const headerPath = path.join(SRC, 'header.txt');
  if (!fs.existsSync(headerPath)) throw new Error('缺少 src/header.txt');
  const header = fs.readFileSync(headerPath, 'utf8').trimEnd();

  // 版本号唯一来源：header 里的 @version。
  // 源码里凡是写 __BUILD_VERSION__ 的地方都会被替换成这个值，
  // 避免"文档写 0.1.1、脚本里还是 0.1.0"这种对不上的情况。
  const versionMatch = header.match(/^\/\/\s*@version\s+(\S+)\s*$/m);
  if (!versionMatch) throw new Error('header.txt 里找不到 @version');
  const version = versionMatch[1];

  const files = fs.readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .sort(); // 文件名前缀即加载顺序：00 最先，90 最后

  if (!files.length) throw new Error('src/ 下没有 .js 文件');

  let placeholderUsed = 0;
  const parts = files.map((f) => {
    let code = fs.readFileSync(path.join(SRC, f), 'utf8').trimEnd();
    const hits = (code.match(/__BUILD_VERSION__/g) || []).length;
    if (hits) {
      placeholderUsed += hits;
      code = code.split('__BUILD_VERSION__').join(version);
    }
    return `\n\n/* ============================================================\n * ${f}\n * ============================================================ */\n${code}`;
  });

  // 占位符没被用上，说明有人把 VERSION 改回硬编码了，直接让构建失败
  if (placeholderUsed === 0) {
    throw new Error('源码里找不到 __BUILD_VERSION__ 占位符，VERSION 可能被改成了硬编码');
  }

  const body = parts.join('\n');
  // 注意：油猴的 ==UserScript== 元数据块必须是文件开头第一段内容，
  // 所以"生成文件"的提示只能放在元数据块之后，且必须是 // 注释而非 #。
  const out = `${header}\n// 生成文件，请勿直接编辑。修改 src/ 下的模块后运行 node build.js 重新生成。\n(function () {\n'use strict';\n${body}\n\n})();\n`;

  fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, OUT_NAME);
  fs.writeFileSync(outPath, out, 'utf8');

  // 构建后校验：产物里的版本号必须和 header 一致
  const built = fs.readFileSync(outPath, 'utf8');
  const builtVersion = (built.match(/^\/\/\s*@version\s+(\S+)\s*$/m) || [])[1];
  if (builtVersion !== version) {
    throw new Error(`版本号不一致：header=${version}，产物=${builtVersion}`);
  }

  const lines = out.split('\n').length;
  console.log(`✓ ${files.length} 个模块已合并`);
  console.log(`  版本 ${version}`);
  console.log(`  ${outPath}`);
  console.log(`  ${lines} 行 / ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
  return outPath;
}

try {
  build();
} catch (e) {
  console.error('构建失败：' + e.message);
  process.exit(1);
}
