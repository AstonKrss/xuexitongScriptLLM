/* ============================================================
 * 10-config.js —— 厂商预设表 + 配置读写
 * 设计要点：
 *   1. 预设表的 baseUrl / model 全部来自各厂商官方文档，不是凭记忆写的；
 *   2. 用户可保存多个档案（profile），面板上一键切换，类似 ccswitch；
 *   3. apiKey 只存在脚本管理器的本地存储里，绝不写进源码。
 * ============================================================ */

/* ---------- 厂商预设 ----------
 * protocol：请求格式。'openai' 打 /chat/completions，'anthropic' 打 /messages。
 *   绝大多数中转站和国产厂商都走 OpenAI 格式；只有少数网关只提供 Anthropic Messages。
 * jsonMode：是否支持 response_format={type:'json_object'}。
 *   支持的厂商强制 JSON 输出，解析成功率接近 100%；
 *   不支持的走"提示词约束 + 容错解析"，靠 30-llm.js 里的剥壳逻辑兜底。
 *   自定义/中转站默认关闭——不知道对方支不支持时，多传一个字段可能直接报错。
 * note：给用户看的说明，尤其要写清能力边界。
 */
const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    protocol: 'openai',
    jsonMode: true,
    note: '中文选择题性价比最高。deepseek-chat 便宜且快，reasoner 更准但慢 3~5 倍且更贵。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7-flash', 'glm-4-flash'],
    protocol: 'openai',
    jsonMode: true,
    note: '默认 glm-5.3 旗舰；低成本可选 glm-5.3-flash 或 glm-4.7-flash。',
  },
  {
    id: 'dashscope',
    label: '阿里百炼 · 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    protocol: 'openai',
    jsonMode: true,
    note: '走官方 OpenAI 兼容模式，支持 JSON 输出。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    protocol: 'openai',
    jsonMode: false,
    note: '不支持 response_format，走提示词约束模式。',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'glm-4.6',
    models: ['glm-4.6', 'kimi-k2', 'big-pickle', 'deepseek-v4-flash-free'],
    protocol: 'openai',
    jsonMode: false,
    note: '⚠️ 只有走 /chat/completions 的模型能用。GPT 系列走 /responses、Claude 系列走 /messages，本脚本不支持，填了会 404。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    protocol: 'openai',
    jsonMode: true,
    note: '国内需自备网络环境，否则请求会超时。',
  },
  {
    id: 'custom',
    label: '自定义 / 中转站',
    baseUrl: '',
    model: '',
    models: [],
    protocol: 'openai',
    jsonMode: false,
    note: '填任意 OpenAI 兼容地址。可直接粘 https://xxx.com/v1，也可粘完整的 .../chat/completions，脚本会自动识别。填好后点「拉取模型」列出可用模型。',
  },
];

/* ---------- 内置题库 ----------
 * 原脚本（unrival 超星小助手）用的是这家公共题库，token 由作者在公众号下发。
 * 用户明确要求沿用这套接口和 token，不再要求手填。
 *
 * 两个必须知道的事实：
 *   1. 这是别人维护的凭据，可能随时被限流或吊销，失效后脚本会自动熔断并只用模型；
 *   2. 它是查表不是推理，冷门课/新出的题大概率没有。
 */
const BUILTIN_BANK = {
  endpoint: 'https://cx.icodef.com/wyn-nb?v=4',
  token: 'n4LoeX7VdngGIKS6',
};

/* ---------- 默认配置 ----------
 * 每个数值后面的 D-xx 是决策记录编号，改动前先看 docs/决策记录.md 里的理由。
 */
const DEFAULT_CONFIG = {
  activeProfileId: 'deepseek',
  // 保存的档案：id -> { presetId, baseUrl, model, apiKey, jsonMode }
  profiles: {},

  quiz: {
    concurrency: 3,          // D-08 并发上限。太高会触发 429，太低一章节要等两分钟
    timeoutMs: 25000,        // D-07 单题超时。中转站首字常要 3~10 秒，加上排队 15 秒不够，
                             // 实测有一次 15 秒超时后重试才成功，白白多花一次 token
    temperature: 0,          // 答题要确定性，不要创造力
    maxTokens: 300,          // 答案 JSON 很短，给多了反而容易让模型自由发挥
    minConfidence: 0.5,      // 低于此置信度视为"没把握"，不填入答案
    minAnswerRate: 90,       // 作答覆盖率下限（百分比），达到才允许提交。90：个别点击失效的题不至于卡住整卷——空着不交损失更大
    guessOnMiss: true,       // 没匹配到答案时按题型猜默认值（单选 B / 多选全选 / 判断错），凑满覆盖率
    autoSubmit: true,        // 达到覆盖率下限后自动提交
    autoSave: true,          // 未达下限时自动保存，保留已填答案
    useCache: true,          // 命中本地题库直接复用，不消耗 token
    cacheLimit: 3000,        // 缓存条数上限，超出按最久未用淘汰
    fillDelayMin: 3000,      // D-16 逐题最小间隔（毫秒）
    fillDelayMax: 8000,      // D-16 逐题最大间隔（毫秒）
    enforceMinDuration: false, // D-17 是否启用最短作答时长控制。默认关闭：等 25 分钟的体验太差，且自动刷课模式下用户明确要求直接跳。想开就在设置里勾上
    minSecondsPerQuestion: 25, // D-17 每题折合的最短秒数，总时长下限 = 题数 × 该值
    decodeFont: true,        // D-31 是否解码 .font-cxsecret 字体加密（见 45-font.js）
  },

  // 第三方题库。命中就省一次模型调用，而且拿到的是标准答案。
  // 默认用原脚本（unrival 超星小助手）同款的公共题库，这是用户明确要求的：
  // 能查到就先查，查不到再落到模型。想换成自己的接口，取消「使用内置题库」即可。
  bank: {
    enabled: true,
    useBuiltin: true,    // true 时忽略下面两个字段，强制走 BUILTIN_BANK
    endpoint: BUILTIN_BANK.endpoint,
    token: BUILTIN_BANK.token,
    timeoutMs: 2500,     // 题库必须快，慢了不如直接用模型
    order: 'decoded',    // 'decoded' 先查正常文字 | 'raw' 先查加密态原文
  },

  debug: false,
};

/* ---------- 配置读写 ---------- */

const Config = {
  _cache: null,

  load() {
    if (this._cache) return this._cache;
    const stored = gmGet(NS + ':config', null);
    this._cache = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), stored || {});
    // 首次运行：把默认厂商建成第一个档案，用户只需要填 key 就能用
    if (!this._cache.profiles || Object.keys(this._cache.profiles).length === 0) {
      this._cache.profiles = { default: this.makeProfile('deepseek') };
      this._cache.activeProfileId = 'default';
    }
    if (!this._cache.profiles[this._cache.activeProfileId]) {
      this._cache.activeProfileId = Object.keys(this._cache.profiles)[0];
    }
    // 迁移：v0.7.2 之前题库默认是「关闭 + 不预置凭据」，老用户库里存的就是空地址。
    // 不补的话升级后仍然一次都不查，看起来像功能没生效。
    //
    // 但有两种情况不能碰：
    //   1. 用户自己填过地址——那是他有意配置的接口，不能被内置值顶掉；
    //   2. 用户显式存过 useBuiltin——尊重他上次的选择。
    // 判据只能看 stored 的原始值：deepMerge 之后 useBuiltin 会被默认值填成 true，
    // 分不清"默认带出来的"和"用户存的"。
    const b = this._cache.bank;
    const sb = stored && stored.bank;
    if (b) {
      if (!b.endpoint) {
        b.useBuiltin = true;
        b.endpoint = BUILTIN_BANK.endpoint;
        b.token = BUILTIN_BANK.token;
        b.enabled = true;
        this.save();
      } else if (sb && sb.useBuiltin === undefined) {
        // 老版本存了自己填的地址，没有 useBuiltin 字段 → 按自填模式处理
        b.useBuiltin = false;
        this.save();
      }
    }
    return this._cache;
  },

  save() {
    gmSet(NS + ':config', this._cache);
  },

  makeProfile(presetId) {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetId) || PROVIDER_PRESETS[0];
    return {
      presetId: p.id,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      protocol: p.protocol || 'openai',
      jsonMode: p.jsonMode,
    };
  },

  // 当前生效的档案。没有可用档案时返回 null，由调用方决定如何提示
  active() {
    const cfg = this.load();
    const p = cfg.profiles[cfg.activeProfileId];
    if (!p) return null;
    const preset = PROVIDER_PRESETS.find((x) => x.id === p.presetId);
    return {
      id: cfg.activeProfileId,
      baseUrl: (p.baseUrl || '').trim(),
      model: (p.model || '').trim(),
      apiKey: (p.apiKey || '').trim(),
      protocol: p.protocol === 'anthropic' ? 'anthropic' : 'openai',
      jsonMode: p.jsonMode !== false,
      label: preset ? preset.label : '自定义',
    };
  },

  get quiz() { return this.load().quiz; },

  /* 生效的题库配置。
   * useBuiltin 为真时强制返回内置地址和 token——存储里的值只是展示用，
   * 避免内置凭据被误改后整个题库静默失效。 */
  get bank() {
    const b = this.load().bank;
    if (b && b.useBuiltin) {
      return Object.assign({}, b, {
        endpoint: BUILTIN_BANK.endpoint,
        token: BUILTIN_BANK.token,
      });
    }
    return b;
  },

  update(path, value) {
    const cfg = this.load();
    const segs = path.split('.');
    let cur = cfg;
    for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
    cur[segs[segs.length - 1]] = value;
    this.save();
  },
};

/* ---------- URL 归一化 ----------
 * 用户可能填 https://api.deepseek.com、.../v1、乃至完整的 .../chat/completions。
 * 统一收敛成完整地址，避免因为少写一段路径而 404。
 *
 * protocol='openai'    → {base}/chat/completions
 * protocol='anthropic' → {base}/messages
 * 两者都允许用户直接粘完整地址。
 */
function normalizeBase(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function buildEndpoint(baseUrl, protocol) {
  const u = normalizeBase(baseUrl);
  if (!u) return '';
  if (/\/(chat\/completions|messages)$/i.test(u)) return u;
  return u + (protocol === 'anthropic' ? '/messages' : '/chat/completions');
}

// 模型列表地址。OpenAI 和 Anthropic 两边都是 GET {base}/models 返回 {data:[{id}]}
function buildModelsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
  if (!u) return '';
  return u.replace(/\/(chat\/completions|messages)$/i, '') + '/models';
}

// 兼容旧调用点
function buildChatUrl(baseUrl) {
  return buildEndpoint(baseUrl, 'openai');
}

// 用于面板展示和本地缓存的短标识，不参与请求
function shortHost(baseUrl) {
  try { return new URL(normalizeBase(baseUrl)).host; } catch (e) { return baseUrl || '(未填)'; }
}
