/* ============================================================
 * test/protocol.test.js —— 两种请求格式的构造与解析
 *
 * 用户实际用的是 river.ai 中转站（key 以 rv_ 开头，配置来自 ccswitch 的
 * ANTHROPIC_BASE_URL 那套环境变量）。这类中转可能只给一种格式，
 * 如果把地址、请求体、响应解析三者搞混，表现就是"测试连接失败"或"返回内容为空"。
 * 所以这里把两种格式的每个环节都钉死。
 *
 * 运行：node test/protocol.test.js
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
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + label); }
}

const code = MODULES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// eslint-disable-next-line no-new-func
const api = new Function(`${code}
return { buildEndpoint, buildModelsUrl, buildRequestBody, buildHeaders, extractContent,
         PROVIDER_PRESETS, Config, DEFAULT_CONFIG };`)();

/* ---------- 地址拼接 ---------- */
console.log('\n[地址拼接]');
eq(api.buildEndpoint('https://api.river.ai/v1', 'openai'),
  'https://api.river.ai/v1/chat/completions', 'river.ai + openai');
eq(api.buildEndpoint('https://api.river.ai/v1', 'anthropic'),
  'https://api.river.ai/v1/messages', 'river.ai + anthropic');
eq(api.buildEndpoint('https://api.deepseek.com', 'openai'),
  'https://api.deepseek.com/chat/completions', '无 /v1 的裸域名自动补路径');
eq(api.buildEndpoint('https://api.deepseek.com/v1/chat/completions', 'openai'),
  'https://api.deepseek.com/v1/chat/completions', '已是完整地址不重复拼接');
eq(api.buildEndpoint('api.river.ai/v1', 'openai'),
  'https://api.river.ai/v1/chat/completions', '缺协议头时自动补 https');
eq(api.buildEndpoint('https://api.river.ai/v1/', 'openai'),
  'https://api.river.ai/v1/chat/completions', '末尾斜杠不影响');
eq(api.buildEndpoint('', 'openai'), '', '空地址返回空');

eq(api.buildModelsUrl('https://api.river.ai/v1'), 'https://api.river.ai/v1/models', '模型列表地址');
eq(api.buildModelsUrl('https://api.river.ai/v1/chat/completions'),
  'https://api.river.ai/v1/models', '从完整 chat 地址反推模型列表地址');
eq(api.buildModelsUrl('https://api.river.ai/v1/messages'),
  'https://api.river.ai/v1/models', '从 anthropic 地址反推模型列表地址');

/* ---------- 请求体 ---------- */
console.log('\n[请求体构造]');
const q = { type: 'single', stem: '中国的首都是？', options: [{ key: 'A', text: '上海' }, { key: 'B', text: '北京' }] };
const cfg = { temperature: 0, maxTokens: 300 };

const openaiBody = api.buildRequestBody(q, { model: 'm', protocol: 'openai', jsonMode: true }, cfg);
eq(openaiBody.model, 'm', 'openai 带模型名');
eq(openaiBody.messages.length, 2, 'openai 是 system + user 两条消息');
eq(openaiBody.messages[0].role, 'system', 'openai 第一条是 system');
eq(openaiBody.response_format, { type: 'json_object' }, 'openai 开启 jsonMode 时带 response_format');
eq(openaiBody.temperature, 0, 'openai temperature=0');

const openaiNoJson = api.buildRequestBody(q, { model: 'm', protocol: 'openai', jsonMode: false }, cfg);
eq(openaiNoJson.response_format, undefined, '关闭 jsonMode 时不带 response_format');

const anthBody = api.buildRequestBody(q, { model: 'm', protocol: 'anthropic', jsonMode: true }, cfg);
eq(anthBody.system !== undefined, true, 'anthropic 的 system 是顶层字段');
eq(anthBody.messages.length, 1, 'anthropic 的 messages 只有 user 一条');
eq(anthBody.max_tokens, 300, 'anthropic 必带 max_tokens');
eq(anthBody.response_format, undefined, 'anthropic 不带 response_format');

/* ---------- 请求头 ---------- */
console.log('\n[请求头]');
const oh = api.buildHeaders({ protocol: 'openai', apiKey: 'rv_abc' });
eq(oh.Authorization, 'Bearer rv_abc', 'openai 用 Bearer');
eq(oh['x-api-key'], undefined, 'openai 不带 x-api-key');

const ah = api.buildHeaders({ protocol: 'anthropic', apiKey: 'rv_abc' });
eq(ah['x-api-key'], 'rv_abc', 'anthropic 带 x-api-key');
eq(ah['anthropic-version'], '2023-06-01', 'anthropic 带版本头');
eq(ah.Authorization, 'Bearer rv_abc', 'anthropic 同时带 Bearer，兼容只认 Bearer 的中转');

/* ---------- 响应解析 ---------- */
console.log('\n[响应解析]');
eq(api.extractContent({ choices: [{ message: { content: 'hello' } }] }, 'openai'), 'hello', 'openai 响应');
eq(api.extractContent({ choices: [{ text: 'legacy' }] }, 'openai'), 'legacy', 'openai 旧式 text 字段');
eq(api.extractContent({ content: [{ type: 'text', text: 'hello' }] }, 'anthropic'), 'hello', 'anthropic 响应');
eq(api.extractContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'anthropic'), 'ab', 'anthropic 多段文本拼接');
eq(api.extractContent({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'x' }] }, 'anthropic'), 'x', 'anthropic 跳过非文本块');
eq(api.extractContent({}, 'anthropic'), null, 'anthropic 空响应返回 null');
eq(api.extractContent({}, 'openai'), null, 'openai 空响应返回 null');

/* ---------- 预设完整性 ---------- */
console.log('\n[预设]');
ok(api.PROVIDER_PRESETS.every((p) => p.protocol === 'openai' || p.protocol === 'anthropic'), '每个预设都有合法 protocol');
const custom = api.PROVIDER_PRESETS.find((p) => p.id === 'custom');
ok(custom && custom.jsonMode === false, '自定义/中转站预设默认关闭 JSON 模式（对方可能不支持该参数）');
ok(api.PROVIDER_PRESETS.find((p) => p.id === 'deepseek').jsonMode === true, 'DeepSeek 预设开启 JSON 模式');

console.log(`\n${'─'.repeat(40)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
