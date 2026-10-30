/* ============================================================
 * 30-llm.js —— OpenAI 兼容协议客户端 + 答题提示词
 *
 * 提示词设计说明（改之前务必先读）：
 *   让模型"直接返回字母"是最常见的做法，也是最容易错的做法。
 *   原因是页面上选项顺序可能被打乱、选项里可能嵌套「以上都对」，
 *   字母和原文的映射一旦错位，勾出来的就是错的选项，而且不会报错。
 *   所以这里要求模型同时返回 choice（字母）和 text（选项原文），
 *   本地匹配时以 text 为准、choice 兜底，见 50-matcher.js。
 * ============================================================ */

const SYSTEM_PROMPT = [
  '你是一个中国高校课程的答题引擎。用户给你一道题和它的选项，你只需给出正确答案。',
  '',
  '严格遵守以下输出规则：',
  '1. 只输出一个 JSON 对象。不要解释、不要 markdown 代码块、不要任何前后缀文字。',
  '2. 单选题格式：{"choice":"B","text":"选项的完整原文","confidence":0.92}',
  '3. 多选题格式：{"choice":["A","C"],"text":["选项1原文","选项2原文"],"confidence":0.88}',
  '4. 判断题格式：{"choice":"true","text":"正确","confidence":0.95}，其中 true 表示该命题正确，false 表示错误。',
  '5. 填空题格式：{"text":["答案1","答案2"],"confidence":0.9}，按空的顺序给出，只给答案本身，不要带"第1空"这类前缀；只有一个空时也可写成 {"text":"答案","confidence":0.9}。',
  '6. confidence 取 0 到 1 之间的小数，表示你判断正确的把握程度。',
  '7. 如果选项本身残缺、题干主体无法辨认、或确实超出你的知识范围，把 confidence 设为 0，不要瞎猜。',
  '',
  '关键要求：',
  '- 选项顺序可能被系统打乱，绝对不要假设 A 就是第一个选项。以 text 的原文匹配为准。',
  '- text 必须是选项的原文，逐字复制，不要改写、不要精简、不要加编号。',
  '- 多选题的 text 数组顺序与 choice 数组一一对应。',
  '- 页面可能因字体反爬把部分汉字替换成笔画相近的生僻字（例如"新"显示成"斸"、"有"显示成"蓇"、"进"显示成"迸"）。',
  '  这是排版问题，不是题目本身有问题：请结合上下文还原成最通顺的词句再作答，',
  '  能还原出来就给 0.6 以上的置信度。只有整句都无法理解时才设为 0。',
].join('\n');

// 题型在内部统一成 single / multi / judge / blank 四种，与页面 DOM 解耦
function buildUserPrompt(q) {
  const lines = [];
  const typeName = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题' }[q.type] || '单选题';
  lines.push('【题型】' + typeName);
  lines.push('【题干】' + q.stem);
  if (q.options && q.options.length) {
    lines.push('【选项】');
    q.options.forEach((o) => lines.push(o.key + '. ' + o.text));
  }
  if (q.type === 'judge') {
    lines.push('（判断题请用 true 表示"正确"，false 表示"错误"）');
  }
  if (q.type === 'blank') {
    lines.push('【空数】' + ((q.blanks && q.blanks.length) || 1));
  }
  return lines.join('\n');
}

/* ---------- 响应解析 ----------
 * 即使开了 JSON 模式，仍有厂商会返回 ```json 包裹或前后废话。
 * 这里按"直接解析 → 去围栏 → 括号配对截取"三级降级，最后才用正则兜底抓字母。
 */
function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();

  const tryParse = (str) => { try { return JSON.parse(str); } catch (e) { return null; } };

  // 一级：本身就是干净 JSON
  let r = tryParse(s);
  if (r) return r;

  // 二级：剥掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    r = tryParse(fence[1].trim());
    if (r) return r;
    s = fence[1].trim();
  }

  // 三级：找第一个平衡的 {...} 片段
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          r = tryParse(s.slice(start, i + 1));
          if (r) return r;
          break;
        }
      }
    }
  }
  return null;
}

// 把模型返回的各种形状收敛成统一结构
function normalizeAnswer(raw, q) {
  const out = { choice: null, text: null, confidence: 0, raw: raw };

  // 填空题单独处理：答案是一个字符串数组，没有选项可匹配。
  // 模型偶尔会给答案加「第1空：」前缀，这里直接剥掉，免得填进输入框。
  if (q.type === 'blank') {
    const conf = (raw && typeof raw === 'object' && raw.confidence !== undefined) ? Number(raw.confidence) : 0.8;
    out.confidence = isNaN(conf) ? 0.8 : Math.max(0, Math.min(1, conf));
    let t = raw;
    if (raw && typeof raw === 'object') {
      t = raw.text !== undefined ? raw.text : (raw.answer !== undefined ? raw.answer : raw.content);
    }
    const arr = Array.isArray(t) ? t.map(String) : (t == null ? [] : [String(t)]);
    out.text = arr
      .map((s) => s.replace(/^第\s*\d+\s*空\s*[：:]\s*/, '').trim())
      .filter(Boolean);
    if (!out.text.length) out.confidence = 0;
    return out;
  }

  if (!raw || typeof raw !== 'object') {
    // 极端兜底：模型只吐了一个字母，比如 "B"
    const m = String(raw || '').match(/\b([A-H])\b/i);
    if (m && q.type !== 'judge') {
      out.choice = m[1].toUpperCase();
      out.confidence = 0.2; // 这种输出可信度极低，靠低置信度让它被判为"没把握"
    }
    return out;
  }

  let choice = raw.choice !== undefined ? raw.choice : (raw.answer !== undefined ? raw.answer : raw.correct);
  let text = raw.text !== undefined ? raw.text : (raw.content !== undefined ? raw.content : raw.option);
  const conf = raw.confidence !== undefined ? Number(raw.confidence) : (raw.score !== undefined ? Number(raw.score) : 0.8);

  out.confidence = isNaN(conf) ? 0.8 : Math.max(0, Math.min(1, conf));

  if (q.type === 'judge') {
    out.choice = normalizeJudge(choice !== undefined && choice !== null ? choice : text);
    out.text = out.choice === null ? null : (out.choice === 'true' ? '正确' : '错误');
    if (out.choice === null) out.confidence = 0;
    return out;
  }

  if (q.type === 'multi') {
    let arr = [];
    if (Array.isArray(choice)) arr = choice.map(String);
    else if (typeof choice === 'string') arr = choice.split(/[,，、\s]+/).filter(Boolean);
    out.choice = arr.map((x) => x.trim().toUpperCase().replace(/[^A-H]/g, '')).filter(Boolean);

    let tarr = [];
    if (Array.isArray(text)) tarr = text.map(String);
    else if (typeof text === 'string') tarr = [text];
    out.text = tarr.filter((x) => x.trim());

    if (!out.choice.length && !out.text.length) out.confidence = 0;
    return out;
  }

  // 单选题
  if (typeof choice === 'string') out.choice = choice.trim().toUpperCase().replace(/[^A-H]/g, '') || null;
  else if (Array.isArray(choice) && choice.length) out.choice = String(choice[0]).trim().toUpperCase().replace(/[^A-H]/g, '') || null;

  if (typeof text === 'string') out.text = text.trim();
  else if (Array.isArray(text) && text.length) out.text = String(text[0]).trim();

  if (!out.choice && !out.text) out.confidence = 0;
  return out;
}

// 判断题的真值映射。模型可能给出 true/false、正确/错误、对/错、√/×、T/F 等写法
function normalizeJudge(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (/^(true|t|yes|y|1|正确|对|是|√|✓|right)$/.test(s)) return 'true';
  if (/^(false|f|no|n|0|错误|错|否|×|✗|wrong)$/.test(s)) return 'false';
  if (s.includes('正确') || s.includes('对')) return 'true';
  if (s.includes('错误') || s.includes('错')) return 'false';
  return null;
}

/* ---------- 请求构造 ----------
 * 两种协议的分工：
 *   openai    —— POST {base}/chat/completions，Bearer 鉴权，返回 choices[0].message.content
 *   anthropic —— POST {base}/messages，x-api-key + anthropic-version，返回 content[{type:'text'}]
 * 中转站两种都可能提供，也可能只提供其中一种，所以做成可选。
 */

function buildRequestBody(q, profile, quizCfg) {
  const userPrompt = buildUserPrompt(q);

  if (profile.protocol === 'anthropic') {
    // Anthropic 的 system 是顶层字段，不是 messages 里的一个角色；
    // max_tokens 是必填项，漏了直接 400。
    return {
      model: profile.model,
      max_tokens: quizCfg.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: quizCfg.temperature,
    };
  }

  const body = {
    model: profile.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: quizCfg.temperature,   // 答题取 0，保证同题同解
    max_tokens: quizCfg.maxTokens,
    stream: false,
  };
  if (profile.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

function buildHeaders(profile) {
  if (profile.protocol === 'anthropic') {
    // 官方 Anthropic 用 x-api-key；不少中转站只认 Bearer。两个都带上，
    // 官方接口会忽略多余的 Authorization，中转站总能命中一个。
    return {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      'Authorization': 'Bearer ' + profile.apiKey,
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + profile.apiKey,
  };
}

// 从响应体里取出正文。取不到返回 null，由调用方再试 SSE 兜底。
function extractContent(payload, protocol) {
  if (protocol === 'anthropic') {
    if (payload && Array.isArray(payload.content)) {
      return payload.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('');
    }
    return null;
  }
  if (payload && payload.choices && payload.choices[0]) {
    const c = payload.choices[0];
    return (c.message && c.message.content) || c.text || null;
  }
  return null;
}

class LLMError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;      // 'auth' | 'quota' | 'rate' | 'network' | 'timeout' | 'parse' | 'config'
    this.status = status;
  }
}

// kind=config/auth/quota 的失败不需要重试，重试也是白费
const FATAL_KINDS = ['config', 'auth', 'quota'];

function readSSEMessage(res) {
  // 部分中转站即使没开 stream 也可能返回 SSE 帧，做一个兜底提取
  const txt = String(res.responseText || '');
  if (!txt.trim().startsWith('data:')) return null;
  const parts = txt.split('\n').filter((l) => l.trim().startsWith('data:'))
    .map((l) => l.replace(/^data:\s*/, '').trim())
    .filter((l) => l && l !== '[DONE]');
  let content = '';
  for (const p of parts) {
    try {
      const j = JSON.parse(p);
      const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
      if (d && d.content) content += d.content;
    } catch (e) { /* 忽略无法解析的帧 */ }
  }
  return content || null;
}

/**
 * 请求单题答案。
 * @returns {Promise<{choice,text,confidence,raw,usage,elapsed}>}
 */
function requestAnswer(q, profile, quizCfg) {
  return new Promise((resolve, reject) => {
    const url = buildEndpoint(profile.baseUrl, profile.protocol);
    if (!url) return reject(new LLMError('未配置接口地址', 'config'));
    if (!profile.model) return reject(new LLMError('未配置模型名', 'config'));
    if (!profile.apiKey) return reject(new LLMError('未配置 API Key', 'config'));

    const body = buildRequestBody(q, profile, quizCfg);

    const started = Date.now();
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    gmRequest({
      method: 'POST',
      url: url,
      headers: buildHeaders(profile),
      data: JSON.stringify(body),
      timeout: quizCfg.timeoutMs,
      onload(res) {
        const elapsed = Date.now() - started;
        let payload = null;
        try { payload = JSON.parse(res.responseText); } catch (e) { payload = null; }

        if (res.status === 401 || res.status === 403) {
          return finish(reject, new LLMError('API Key 无效或已失效（HTTP ' + res.status + '）', 'auth', res.status));
        }
        if (res.status === 402 || res.status === 429) {
          const msg = payload && payload.error ? payload.error.message : 'HTTP ' + res.status;
          const kind = res.status === 402 || /quota|balance|insufficient|余额|欠费/i.test(msg) ? 'quota' : 'rate';
          return finish(reject, new LLMError('接口限流或额度不足：' + msg, kind, res.status));
        }
        if (res.status >= 500) {
          return finish(reject, new LLMError('接口服务端错误（HTTP ' + res.status + '）', 'network', res.status));
        }
        if (res.status !== 200) {
          // 把服务端返回的原始错误带出来，否则用户只能看到"失败"两个字，没法自己排查
          const msg = payload && payload.error
            ? (payload.error.message || JSON.stringify(payload.error))
            : String(res.responseText).slice(0, 300);
          const hint = res.status === 404
            ? '（404 通常是地址或模型名不对：确认 base_url 以 /v1 结尾，模型名用「拉取模型」里列出的 ID）'
            : '';
          return finish(reject, new LLMError('接口返回异常（HTTP ' + res.status + '）：' + msg + hint, 'network', res.status));
        }

        let content = extractContent(payload, profile.protocol);
        if (!content) content = readSSEMessage(res);

        if (!content) {
          return finish(reject, new LLMError('接口返回内容为空', 'parse', 200));
        }

        const parsed = extractJSON(content);
        const ans = normalizeAnswer(parsed, q);
        ans.usage = payload && payload.usage ? payload.usage : null;
        ans.elapsed = elapsed;
        ans.model = (payload && payload.model) || profile.model;
        finish(resolve, ans);
      },
      onerror(err) {
        const msg = (err && err.error) || '网络请求失败';
        // @connect 没授权时脚本管理器会给出这个提示，属于配置问题，不该重试
        if (/@connect|not permitted|refused to connect/i.test(msg)) {
          return finish(reject, new LLMError('接口域名未授权，请在脚本管理器的弹窗里点「总是允许」，或检查脚本头部的 @connect', 'config'));
        }
        finish(reject, new LLMError('网络错误：' + msg, 'network'));
      },
      ontimeout() {
        finish(reject, new LLMError('请求超时（超过 ' + quizCfg.timeoutMs + 'ms）', 'timeout'));
      },
      onabort() {
        finish(reject, new LLMError('请求被中断', 'network'));
      },
    });
  });
}

/**
 * 带退避重试的答题入口。
 * 只对可恢复错误（网络/超时/限流）重试，认证和额度问题直接抛出，
 * 避免额度耗尽时把整份作业的题全部打成失败。
 */
async function answerWithRetry(q, profile, quizCfg, retries) {
  const maxRetry = retries === undefined ? 1 : retries;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await requestAnswer(q, profile, quizCfg);
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMError && FATAL_KINDS.includes(e.kind)) throw e;
      if (attempt < maxRetry) {
        // 限流退避时间要长一些，普通网络错误短一些
        const wait = e.kind === 'rate' ? 5000 : 1200;
        log('请求失败，' + (wait / 1000) + ' 秒后重试：' + e.message, 'warn');
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/* ---------- 模型列表 ----------
 * GET {base}/models。OpenAI 和 Anthropic 两边返回结构都是 {data:[{id}]}，
 * 少数网关直接返回 {models:[...]} 或字符串数组，这里一并兼容。
 * 作用是让用户不用猜模型名——中转站的模型 ID 往往带前缀（如 deepseek-ai/xxx）。
 */
function listModels(profile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = buildModelsUrl(profile.baseUrl);
    if (!url) return reject(new LLMError('未配置接口地址', 'config'));
    if (!profile.apiKey) return reject(new LLMError('未配置 API Key', 'config'));

    gmRequest({
      method: 'GET',
      url: url,
      headers: buildHeaders(profile),
      timeout: timeoutMs || 15000,
      onload(res) {
        let payload = null;
        try { payload = JSON.parse(res.responseText); } catch (e) { payload = null; }

        if (res.status === 401 || res.status === 403) {
          return reject(new LLMError('API Key 无效或没有权限（HTTP ' + res.status + '）', 'auth', res.status));
        }
        if (res.status !== 200) {
          const msg = payload && payload.error ? (payload.error.message || JSON.stringify(payload.error)) : String(res.responseText).slice(0, 200);
          return reject(new LLMError('拉取模型失败（HTTP ' + res.status + '）：' + msg, 'network', res.status));
        }
        if (!payload) return reject(new LLMError('模型列表不是合法 JSON', 'parse'));

        const raw = payload.data || payload.models || (Array.isArray(payload) ? payload : []);
        const ids = raw
          .map((x) => (typeof x === 'string' ? x : (x && (x.id || x.name))))
          .filter((x) => typeof x === 'string' && x.length)
          .sort();
        if (!ids.length) return reject(new LLMError('接口没有返回任何模型 ID', 'parse'));
        resolve(ids);
      },
      onerror(err) {
        const msg = (err && err.error) || '网络请求失败';
        if (/@connect|not permitted|refused to connect/i.test(msg)) {
          return reject(new LLMError('接口域名未授权，请在脚本管理器的弹窗里点「总是允许」', 'config'));
        }
        reject(new LLMError('网络错误：' + msg, 'network'));
      },
      ontimeout() { reject(new LLMError('拉取模型超时', 'timeout')); },
    });
  });
}

/* ---------- 连通性测试 ---------- */
// 面板上的"测试连接"按钮。只发一个极短的请求，几乎不花钱，但能一次性验证
// 地址、密钥、模型名、以及 @connect 授权四个环节。
async function testConnection(profile, quizCfg) {
  const started = Date.now();
  const probe = { type: 'single', stem: '中国的首都是哪座城市？', options: [{ key: 'A', text: '北京' }, { key: 'B', text: '上海' }] };
  const ans = await requestAnswer(probe, profile, Object.assign({}, quizCfg, { timeoutMs: 20000 }));
  return { answer: ans, elapsed: Date.now() - started };
}
