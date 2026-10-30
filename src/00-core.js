/* ============================================================
 * 00-core.js —— 全局工具、存储封装、日志总线
 * 约定：本文件不依赖任何其他模块，必须最先加载。
 * ============================================================ */

// 版本号唯一来源是 header.txt 里的 @version，由 build.js 在构建时注入到这里。
// 不要在这个文件里硬编码版本号——之前两处各写一遍，结果改了一处忘了另一处，
// 用户看到的版本号和文档里写的对不上。
const VERSION = '__BUILD_VERSION__';
const NS = 'llmq'; // 存储键前缀，避免与其他脚本的 GM 存储键冲突

// 当前 frame 加载完成的绝对时刻，作为"作答时长"的计时起点。
// 用 timeOrigin 而不是脚本初始化那一刻：超星如果要算时长，大概率是从页面进入算起，
// 而不是从用户点按钮算起。口径偏保守的一侧更安全。
const PAGE_STARTED_AT = (typeof performance !== 'undefined' && performance.timeOrigin)
  ? performance.timeOrigin
  : Date.now();

/* ---------- 脚本管理器能力探测 ---------- */
// Tampermonkey 新旧两套 API 并存：GM_xmlhttpRequest（回调式）与 GM.xmlHttpRequest（Promise 式）。
// 这里统一收敛成回调式调用，两种都能用，ScriptCat 也覆盖在内。
const hasGM = typeof GM_xmlhttpRequest === 'function' || (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function');

function gmRequest(options) {
  if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(options);
  if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest(options);
  throw new Error('当前脚本管理器没有提供 GM_xmlhttpRequest，无法跨域请求大模型接口');
}

/* 首次使用时打开项目主页。只在装好后第一次进课程页面时弹一次，
 * 之后靠 GM 存储记住，不会再打扰。 */
const REPO_URL = 'https://github.com/AstonKrss/xuexitongScriptLLM';

function openRepoOnce() {
  try {
    if (gmGet('llmq:repoOpened', false)) return;
    gmSet('llmq:repoOpened', true);
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(REPO_URL, { active: true });
    } else {
      window.open(REPO_URL, '_blank');
    }
    log('已打开项目主页（仅首次）：' + REPO_URL, 'info');
  } catch (e) { /* 打不开就算了，不影响主流程 */ }
}

function gmGet(key, fallback) {
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(key) : undefined;
    if (raw === undefined || raw === null || raw === '') return fallback;
    // 统一以 JSON 字符串落盘，兼容性最好；解析失败说明是历史脏数据，直接回退默认值
    try { return JSON.parse(raw); } catch (e) { return raw; }
  } catch (e) {
    return fallback;
  }
}

function gmSet(key, value) {
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof GM_setValue === 'function') GM_setValue(key, raw);
  } catch (e) {
    log('写入本地存储失败：' + e.message, 'error');
  }
}

/* ---------- 基础工具 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在 [min,max] 区间取随机整数，用于模拟人类操作节奏，降低被风控识别的概率
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// 稳定哈希（FNV-1a 32 位），只用于本地题库缓存键，不用于任何安全场景
function hashKey(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 深层合并配置：对象递归合并，数组与基础类型直接覆盖。
// 用途是让新增的默认配置项能自动补进用户已保存的旧配置里，不需要用户重新填一遍。
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const bv = out[k];
    const pv = patch[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)
      ? deepMerge(bv, pv)
      : pv;
  }
  return out;
}

/* ---------- 日志总线 ---------- */
// 面板上的日志区和 console 同时输出。保留最近 300 条，避免长时间挂机内存膨胀。

const LogBus = {
  history: [],
  listeners: [],
  limit: 300,
  push(text, level) {
    level = level || 'info';
    const item = { time: new Date(), text: String(text), level };
    this.history.push(item);
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
    this.listeners.forEach((fn) => { try { fn(item); } catch (e) { /* 单个订阅者异常不应影响日志管道 */ } });
    const c = console;
    if (level === 'error') c.error('[LLM答题]', text);
    else if (level === 'warn') c.warn('[LLM答题]', text);
    else c.log('[LLM答题]', text);
  },
  on(fn) { this.listeners.push(fn); },
  off(fn) { this.listeners = this.listeners.filter((f) => f !== fn); },
};

function log(text, level) { LogBus.push(text, level); }
