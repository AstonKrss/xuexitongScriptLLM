/* ============================================================
 * 60-cache.js —— 本地题库缓存
 *
 * 存在的理由：同一门课、同一批水课的选择题在补考/重修/多学期里高度重复。
 * 缓存命中一次就省一次 token，也省一次 3 秒等待。
 * 存储用 GM_setValue（脚本管理器托管），不写 localStorage，
 * 避免被超星页面自己的清理逻辑带走。
 * ============================================================ */

const AnswerCache = {
  _data: null,
  _dirty: false,
  /* 缓存键带版本号。
   *
   * 教训：v0.7.1 之前多选题被误判成单选，只点了第一个选项，而这些**错误答案
   * 被原样存进了缓存**。修好判定逻辑后，缓存照旧命中，于是日志里多选题仍然
   * 只显示一个字母——改代码看不出问题，因为根本没走到匹配逻辑。
   *
   * 规则一改（题型判定、匹配算法、解码方式），就必须升这个版本号，
   * 让旧数据自然失效，而不是指望用户自己去点「清空题库」。
   */
  SCHEMA: 3,
  _key: NS + ':cache:v3',

  load() {
    if (this._data) return this._data;
    const raw = gmGet(this._key, {});
    this._data = raw && typeof raw === 'object' ? raw : {};
    return this._data;
  },

  get(q) {
    if (!Config.quiz.useCache) return null;
    const k = cacheKeyOf(q);
    const item = this.load()[k];
    if (!item) return null;

    // 防御：多选题的答案必须是数组。存成单字母说明这是早期版本
    // 按单选逻辑写进去的错误答案，宁可当没命中重新问，也不能照着填。
    if (q.type === 'multi' && !Array.isArray(item.c)) return null;
    // 判断题只接受 true/false，其他形态一律作废
    if (q.type === 'judge' && item.c !== 'true' && item.c !== 'false') return null;

    // 命中后刷新访问时间，供 LRU 淘汰使用
    item.at = Date.now();
    item.hits = (item.hits || 0) + 1;
    this._dirty = true;
    return { choice: item.c, text: item.t, confidence: item.f, fromCache: true };
  },

  set(q, ans) {
    if (!Config.quiz.useCache) return;
    const k = cacheKeyOf(q);
    const data = this.load();
    data[k] = {
      c: ans.choice,   // 字母
      t: ans.text,     // 选项原文
      f: ans.confidence,
      at: Date.now(),
      hits: 0,
    };
    this._dirty = true;
    this.prune();
  },

  // 超出上限时按"最久未访问"淘汰，保留最近用过的
  prune() {
    const data = this.load();
    const limit = Math.max(100, Config.quiz.cacheLimit || 3000);
    const keys = Object.keys(data);
    if (keys.length <= limit) return;
    keys.sort((a, b) => (data[a].at || 0) - (data[b].at || 0));
    const drop = keys.length - limit;
    for (let i = 0; i < drop; i++) delete data[keys[i]];
  },

  flush() {
    if (!this._dirty) return;
    this.prune();
    gmSet(this._key, this.load());
    this._dirty = false;
  },

  size() { return Object.keys(this.load()).length; },

  clear() {
    this._data = {};
    gmSet(this._key, {});
    this._dirty = false;
  },
};
