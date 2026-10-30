/* ============================================================
 * 35-bank.js —— 可选的第三方题库优先查询
 *
 * 为什么要有这一层：
 *   查表拿到的往往是标准答案，比模型推理准得多。原脚本就是靠这个活的。
 *   但题库只覆盖众包收录过的题，冷门课程、新出的专题查不到，所以做成
 *   "题库优先，未命中再走模型"的两级策略。
 *
 * 一个关键细节（用户的观察）：
 *   如果题库是靠上传页面 HTML 众包来的，那它存的可能是**加密态的题面**——
 *   也就是「聚厩2035年建成…」这种乱码原文。这样用解码后的正常文字去查反而查不到，
 *   必须用原始乱码查。所以这里两种形式都试。
 *
 * 安全取向：
 *   题库返回的答案必须能匹配上页面上的真实选项才算数。
 *   匹配不上就丢弃、继续走模型，绝不把一份对不上号的答案硬填进去。
 * ============================================================ */

const BANK_TYPE = { single: '0', multi: '1', judge: '3' };

const QuestionBank = {
  failures: 0,
  disabled: false,
  hits: 0,
  misses: 0,

  reset() {
    this.failures = 0;
    this.disabled = false;
    this.hits = 0;
    this.misses = 0;
  },

  /**
   * 按"先解码后原始"的顺序尝试两种题面形式。
   * @returns {Promise<object|null>} 归一化后的答案对象，或 null
   */
  async lookup(q, cfg) {
    if (this.disabled) return null;
    if (!cfg || !cfg.enabled || !cfg.endpoint) return null;
    if (!BANK_TYPE[q.type]) return null;     // 填空题题库一般不支持，直接跳过

    // 解码后的文本更符合人类录入的题库；原始乱码符合"从页面抓取众包"的题库。
    // 两种都试，谁先命中用谁。
    const decoded = q.stem;
    const raw = q.rawStem || q.stem;
    const candidates = (cfg.order === 'raw')
      ? [raw, decoded]
      : [decoded, raw];

    const tried = [];
    for (const text of candidates) {
      if (!text || tried.indexOf(text) >= 0) continue;
      tried.push(text);
      const ans = await this.queryOne(text, q.type, cfg);
      if (ans) return ans;
      if (this.disabled) return null;        // 接口连续失败就不再浪费每题的超时
    }
    return null;
  },

  /** 单次查询。返回归一化答案或 null */
  queryOne(text, type, cfg) {
    return new Promise((resolve) => {
      const timeout = cfg.timeoutMs || 2500;
      const body = 'question=' + encodeURIComponent(text) + '&type=' + BANK_TYPE[type];

      gmRequest({
        method: 'POST',
        url: cfg.endpoint,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': cfg.token || '',
        },
        data: body,
        timeout: timeout,
        onload: (res) => {
          this.failures = 0;
          let payload = null;
          try { payload = JSON.parse(res.responseText); } catch (e) { payload = null; }
          if (!payload) { this.misses++; return resolve(null); }

          // 约定：code === -1 表示题库未收录
          if (payload.code === -1 || payload.code === '-1') { this.misses++; return resolve(null); }

          const data = payload.data;
          if (data === undefined || data === null || data === '') { this.misses++; return resolve(null); }
          const answerText = typeof data === 'string' ? data : String(data);
          const ans = bankToAnswer(answerText, type);
          if (!ans) { this.misses++; return resolve(null); }
          resolve(ans);
        },
        onerror: () => { this.noteFailure('网络错误'); resolve(null); },
        ontimeout: () => { this.noteFailure('请求超时'); resolve(null); },
      });
    });
  },

  // 连续失败两次就整轮停用，避免 60 道题每题都白等几秒
  noteFailure(reason) {
    this.failures++;
    if (this.failures >= 2 && !this.disabled) {
      this.disabled = true;
      log('题库接口连续失败（' + reason + '），本轮改用模型答题', 'warn');
    }
  },
};

/**
 * 把题库返回的纯文本答案转成统一的答案对象。
 * 题库的返回格式很随意：可能是 "B"，可能是 "ABC"，可能是选项原文。
 */
function bankToAnswer(text, type) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;

  if (type === 'judge') {
    const j = normalizeJudge(s);
    if (!j) return null;
    return { choice: j, text: j === 'true' ? '正确' : '错误', confidence: 0.95, fromBank: true };
  }

  // 判断是不是"纯字母答案"：去掉标点后只剩 A-H。
  // 括号既要收半角也要收全角，题库返回"（C）"这种写法很常见。
  const compact = s.replace(/[^A-Ha-h]/g, '').toUpperCase();
  const pureLetters = compact.length > 0 && compact.length <= 8 && s.replace(/\s/g, '').length <= 12
    && /^[A-Ha-h\s.、,，;；:：()（）]+$/.test(s);

  if (pureLetters) {
    const letters = compact.split('');
    if (type === 'multi') {
      return { choice: letters, text: null, confidence: 0.95, fromBank: true };
    }
    if (letters.length !== 1) return null;   // 单选却返回多个字母，格式异常，放弃
    return { choice: letters[0], text: null, confidence: 0.95, fromBank: true };
  }

  // 非纯字母：当作选项原文
  if (type === 'multi') {
    return { choice: null, text: [s], confidence: 0.95, fromBank: true };
  }
  return { choice: null, text: s, confidence: 0.95, fromBank: true };
}
