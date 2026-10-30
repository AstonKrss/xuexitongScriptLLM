/* ============================================================
 * test/models.test.js —— 模型列表拉取
 *
 * 中转站的模型 ID 往往带前缀（deepseek-ai/DeepSeek-V4.1-Flash-1017），
 * 靠猜几乎不可能猜对，所以「拉取模型」这个功能必须可靠。
 * 这里用假接口验证三种常见的返回结构都能被解析。
 *
 * 运行：node test/models.test.js
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['00-core.js', '10-config.js', '30-llm.js'];

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}\nreturn { listModels };`)();

let lastRequest = null;

// 假的脚本管理器接口：按预设的响应体返回
function stubGM(status, body) {
  global.GM_xmlhttpRequest = function (opts) {
    lastRequest = opts;
    setTimeout(() => {
      if (status === 0) return opts.onerror({ error: 'network down' });
      opts.onload({ status: status, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
    }, 1);
  };
}

const profile = { baseUrl: 'https://api.river.ai/v1', apiKey: 'rv_test', protocol: 'openai' };

(async () => {
  console.log('\n[OpenAI 风格 {data:[{id}]}]');
  stubGM(200, { data: [{ id: 'glm-4.6' }, { id: 'deepseek-ai/DeepSeek-V4.1-Flash' }] });
  eq(await api.listModels(profile, 3000), ['deepseek-ai/DeepSeek-V4.1-Flash', 'glm-4.6'], '解析并按字母排序');
  eq(lastRequest.url, 'https://api.river.ai/v1/models', '请求打到正确的 /models 地址');
  eq(lastRequest.headers.Authorization, 'Bearer rv_test', '带上 Bearer 鉴权');

  console.log('\n[{models:[{name}]} 结构]');
  stubGM(200, { models: [{ name: 'b-model' }, { name: 'a-model' }] });
  eq(await api.listModels(profile, 3000), ['a-model', 'b-model'], '兼容 models 字段与 name 键');

  console.log('\n[字符串数组]');
  stubGM(200, ['y', 'x']);
  eq(await api.listModels(profile, 3000), ['x', 'y'], '兼容纯字符串数组');

  console.log('\n[错误处理]');
  stubGM(401, { error: { message: 'invalid key' } });
  try {
    await api.listModels(profile, 3000);
    eq('no error', 'should throw', '401 应该抛错');
  } catch (e) {
    eq(e.kind, 'auth', '401 归类为鉴权错误');
  }

  stubGM(404, 'not found');
  try {
    await api.listModels(profile, 3000);
    eq('no error', 'should throw', '404 应该抛错');
  } catch (e) {
    eq(e.kind, 'network', '404 归类为网络/地址错误');
  }

  stubGM(200, { data: [] });
  try {
    await api.listModels(profile, 3000);
    eq('no error', 'should throw', '空列表应该抛错');
  } catch (e) {
    eq(e.kind, 'parse', '空列表归类为解析错误');
  }

  console.log('\n[缺少配置]');
  try {
    await api.listModels({ baseUrl: '', apiKey: 'k', protocol: 'openai' }, 3000);
    eq('no error', 'should throw', '空地址应该抛错');
  } catch (e) {
    eq(e.kind, 'config', '空地址归类为配置错误');
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
