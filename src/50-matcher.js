/* ============================================================
 * 50-matcher.js —— 答案与页面选项的匹配
 *
 * 核心问题：模型返回的是"文本 + 字母"，页面上是若干个可点击选项，
 * 要把两者对上，而选项顺序可能被系统打乱。
 * 原脚本用双向 includes 判断，遇到「人民」和「人民群众」这类选项会静默配错，
 * 所以这里改成带评分的匹配，并按分数分档决定敢不敢点。
 * ============================================================ */

const MATCH_THRESHOLD = 55; // 低于此分视为没匹配上，宁可跳过也不瞎选

// 归一化：全角转半角 → 去所有空白 → 去标点 → 转小写
// 目的是让 "马克思主义中国化。" 和 "马克思主义中国化" 能对上
function normalizeText(s) {
  return String(s == null ? '' : s)
    // 全角字符区（！到 ～）整体平移到半角
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[，。、；：？！“”‘’（）《》【】〈〉·,.;:?!"'()\[\]{}<>~`@#$%^&*\-—_=+|\\/]/g, '')
    .toLowerCase();
}

/**
 * 给单个选项和模型返回的文本打分。
 *  100：归一化后完全一致（最可靠）
 *  95 ：包含关系且长度高度接近（如 "1921" vs "1921年"）
 *  75 ：包含关系且长度接近（如 "社会主义市场经济" vs "社会主义市场经济体制"）
 *  0  ：不采信
 *
 * 为什么对"包含"设长度比下限：
 *   选项「人民」被「人民群众」包含、选项「马克思主义」被「马克思主义中国化」包含，
 *   这两种情况字面上都满足"包含"，但指向的是不同选项。只靠 includes 判断
 *   必然静默点错，而且不会报错。所以长度比低于 0.72 一律判为不采信，
 *   宁可这一题跳过交给人工，也不点一个可能是错的选项。
 */
const CONTAIN_RATIO_HIGH = 0.9;
const CONTAIN_RATIO_MIN = 0.72;

function scoreOption(optionText, answerText) {
  const a = normalizeText(optionText);
  const b = normalizeText(answerText);
  if (!a || !b) return 0;
  if (a === b) return 100;

  if (!a.includes(b) && !b.includes(a)) return 0;

  const shortLen = Math.min(a.length, b.length);
  const longLen = Math.max(a.length, b.length);
  const ratio = shortLen / longLen;

  if (ratio >= CONTAIN_RATIO_HIGH) return 95;
  if (ratio >= CONTAIN_RATIO_MIN) return 75;
  return 0;
}

/**
 * 单选题匹配：返回 { option, score, method } 或 null
 */
function matchSingle(q, ans) {
  const candidates = [];

  // 第一优先：按选项原文匹配
  if (ans.text) {
    for (const o of q.options) {
      const s = scoreOption(o.text, ans.text);
      if (s > 0) candidates.push({ option: o, score: s, method: 'text' });
    }
    // 模型给了原文但一个选项都对不上，说明它在改写选项而不是逐字复制。
    // 这种情况下它给的字母同样不可信，直接判失败，交给人工。
    if (!candidates.length) return null;
  }

  // 第二优先：模型没给原文，只给了字母时，才允许按字母兜底
  if (!candidates.length && !ans.text && ans.choice) {
    const hit = q.options.find((o) => String(o.key).toUpperCase() === String(ans.choice).toUpperCase())
      || q.options[ans.choice.charCodeAt(0) - 65];
    if (hit) candidates.push({ option: hit, score: 60, method: 'letter' });
  }

  if (!candidates.length) return null;
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  if (best.score < MATCH_THRESHOLD) return null;
  return best;
}

/**
 * 多选题匹配：每一组（文本数组 / 字母数组）独立匹配，再取并集。
 * 只要有一项匹配不到就整题作废——多选题少选一个就是全错，
 * 与其交一份错答案，不如标记为"没把握"交给人工。
 */
function matchMulti(q, ans) {
  const picked = new Map(); // optionIndex -> { option, score, method }
  let missing = 0;

  const texts = Array.isArray(ans.text) ? ans.text.filter(Boolean) : (ans.text ? [ans.text] : []);
  for (const t of texts) {
    let best = null;
    q.options.forEach((o, i) => {
      const s = scoreOption(o.text, t);
      if (s >= MATCH_THRESHOLD && (!best || s > best.score)) best = { option: o, score: s, method: 'text', idx: i };
    });
    if (best) picked.set(best.idx, best);
    else missing++;
  }

  if (ans.choice && ans.choice.length) {
    for (const c of [].concat(ans.choice)) {
      const letter = String(c).trim().toUpperCase();
      const idx = q.options.findIndex((o) => String(o.key).toUpperCase() === letter);
      if (idx >= 0 && !picked.has(idx)) picked.set(idx, { option: q.options[idx], score: 60, method: 'letter', idx });
    }
  }

  if (missing > 0) return null;
  if (!picked.size) return null;

  const arr = Array.from(picked.values()).sort((a, b) => a.idx - b.idx);
  return { options: arr.map((x) => x.option), score: Math.min.apply(null, arr.map((x) => x.score)), method: 'text' };
}

/**
 * 判断题匹配：直接把 true/false 映射到那两个选项上。
 * 不靠文本匹配，因为判断题的选项文案五花八门（正确/对/是/T/√）。
 */
function matchJudge(q, ans) {
  if (ans.choice !== 'true' && ans.choice !== 'false') return null;
  const wantTrue = ans.choice === 'true';
  for (const o of q.options) {
    const t = String(o.text).replace(/\s/g, '');
    if (wantTrue && JUDGE_TRUE.test(t)) return { option: o, score: 100, method: 'judge' };
    if (!wantTrue && JUDGE_FALSE.test(t)) return { option: o, score: 100, method: 'judge' };
  }
  // 选项文案不是标准判断词（比如是"以上说法正确/错误"这种长句），退化为按 val-param 或顺序
  for (const o of q.options) {
    if (o.rawVal === 'true' || o.rawVal === 'false') {
      if ((o.rawVal === 'true') === wantTrue) return { option: o, score: 90, method: 'judge-val' };
    }
  }
  return null;
}

/** 统一入口：按题型分派，输出最终要点的选项列表 */
function matchAnswer(q, ans) {
  // 填空题没有选项可匹配，答案由 70-runner.js 直接写进输入框
  if (q.type === 'blank') return null;
  if (q.type === 'judge') {
    const r = matchJudge(q, ans);
    return r ? { options: [r.option], score: r.score, method: r.method } : null;
  }
  if (q.type === 'multi') {
    const r = matchMulti(q, ans);
    return r ? { options: r.options, score: r.score, method: r.method } : null;
  }
  const r = matchSingle(q, ans);
  return r ? { options: [r.option], score: r.score, method: r.method } : null;
}

/* ---------- 本地题库缓存键 ----------
 * 用"题干 + 选项集合"归一化后做哈希。选项顺序不影响结果（排序后再拼），
 * 这样同一道题在不同次作业里出现也能命中缓存。
 */
function cacheKeyOf(q) {
  const opts = q.options.map((o) => normalizeText(o.text)).sort().join('|');
  return hashKey('v1::' + normalizeText(q.stem) + '::' + opts);
}
