/* ============================================================
 * 40-parser.js —— 题目解析
 *
 * 为什么不用单一选择器：
 *   超星至少有三种作业页（老手机版 .Py-mian1、老 PC 版、新版 React 版），
 *   类名互相不通用，版本一升级选择器就全废。所以这里做成适配器链：
 *   先试已知结构（准确但脆弱），不行再用语义启发式（粗糙但不依赖类名）。
 *
 * 统一输出结构（供 50-matcher.js / 60-runner.js 消费）：
 *   {
 *     index, type: 'single'|'multi'|'judge',
 *     stem: '题干纯文本',
 *     options: [{ key:'A', text:'选项文本', input:HTMLInputElement, clickEl:HTMLElement }],
 *     container: HTMLElement
 *   }
 * ============================================================ */

// 元素是否可见。隐藏的 input（React 定制组件常用 opacity:0 的 input）也要算进来，
// 所以不能用 offsetParent 单独判断，要同时看尺寸和计算样式。
function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return true;
  // 必须用元素所在文档的 window 取计算样式：题目可能在同一页面的 iframe 里，
  // 用外层的 getComputedStyle 对一个属于另一个文档的元素取值会拿到空对象。
  const doc = el.ownerDocument || document;
  const view = doc.defaultView || window;
  const cs = view.getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

const JUDGE_TRUE = /^(正确|对|是|√|✓|true|t|yes)$/i;
const JUDGE_FALSE = /^(错误|错|否|×|✗|false|f|no)$/i;

// 把元素压成一行 HTML，用于「导出页面结构」时贴给开发者看。
// 只截前 max 个字符——整页 HTML 动辄几百 KB，贴不动也读不完。
function compactHtml(el, max) {
  if (!el) return '(无)';
  let s = el.outerHTML || '';
  s = s.replace(/\s+/g, ' ').replace(/>\s+</g, '><');
  if (max && s.length > max) s = s.slice(0, max) + '…[已截断]';
  return s;
}

// 去掉选项文本开头的 "A." "A、" "A)" "（A）" "A北京" 等编号。
// 前三种有标点或括号分隔，可以放心剥。
// 第四种（字母紧邻汉字、没有标点）天然有歧义："A北京" 和 "B超检查" 结构完全一样。
// 所以必须传入 expectedKey（该选项在列表里的应有字母），只有字母对得上才剥——
// 序号对不上说明那个字母是正文的一部分，不是编号。
function stripOptionPrefix(text, expectedKey) {
  let t = String(text == null ? '' : text).replace(/^[\s\u00A0]+/, '');
  t = t.replace(/^[（(]\s*[A-Ha-h]\s*[）)]\s*[.、．:：]?\s*/, ''); // （A） A)
  t = t.replace(/^[A-Ha-h]\s*[.、．:：]\s*/, '');                  // A.  A、
  if (expectedKey) {
    const m = t.match(/^([A-Ha-h])(?=[\u4e00-\u9fa5])/);           // A北京
    if (m && m[1].toUpperCase() === String(expectedKey).toUpperCase()) t = t.slice(1);
  }
  // 字母已经被上游按长度切掉后，可能留下 ". " "、 " 这类残余标点；
  // 也可能出现 "A《书名》" 这种字母后面直接跟符号、正则剥不掉的情况
  t = t.replace(/^[.、．:：)）\]】》]\s*/, '');
  return t.trim();
}

// 去掉题干开头的题号与题型标记。
// 两者可能以任意顺序出现（"1.【单选题】…" 或 "【单选题】1.…"），
// 所以循环剥离到稳定为止；单次顺序替换会漏掉被题号挡住的题型标记。
function stripStemPrefix(text) {
  let t = String(text == null ? '' : text).replace(/[\s\u00A0]+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^[\[【(（]?\s*(单选题|多选题|判断题|填空题|简答题|不定项选择题|材料题)\s*[\]】)）]?\s*/, '');
    t = t.replace(/^[（(]\s*\d{1,3}\s*[）)]\s*/, '');          // （1）
    t = t.replace(/^第\s*\d{1,3}\s*题\s*[.、．:：]?\s*/, '');   // 第1题
    // 注意数字后面必须跟标点才当题号，"1949年" 这类正文开头不能被吃掉
    t = t.replace(/^\d{1,3}\s*[.、．:：)）]\s*/, '');          // 1.  1、  1)
    // 题号后面直接跟方括号/圆括号的情况："1【单选题】…" "2(多选题)…"
    t = t.replace(/^\d{1,3}\s*(?=[\[【(（])/, '');
    if (t === before) break;
  }
  return t.trim();
}

// 从容器里抽出题干：容器的整体文本减去所有选项文本。
// 原理是 textContent 按文档顺序拼接子树文本，因此每个选项的文本必然
// 完整且连续地出现在容器文本中，直接做字符串剔除即可，不需要操作 DOM。
// 必须同时剔除 rawText（带 "A." 前缀的原样文本），否则题干里会残留 "A." 这类编号。
function extractStem(container, options) {
  let stem = container.textContent || '';
  for (const o of options) {
    if (o.rawText && o.rawText.length > 1) stem = stem.split(o.rawText).join(' ');
    if (o.text && o.text.length > 1) stem = stem.split(o.text).join(' ');
  }
  return stripStemPrefix(stem.replace(/[\s\u00A0]+/g, ' ').trim());
}

function detectType(inputs, options) {
  if (options.length === 2) {
    const t0 = options[0].text.replace(/\s/g, '');
    const t1 = options[1].text.replace(/\s/g, '');
    if ((JUDGE_TRUE.test(t0) && JUDGE_FALSE.test(t1)) || (JUDGE_FALSE.test(t0) && JUDGE_TRUE.test(t1))) return 'judge';
  }
  const anyCheckbox = inputs.some((i) => i.type === 'checkbox');
  return anyCheckbox ? 'multi' : 'single';
}

/**
 * 判定题型，优先信任页面自己标注的信息。
 *
 * 为什么不能只看输入框类型：超星把选项做成带 role="radio" 的 li，
 * 底下根本没有原生 checkbox。多选题若按"有没有 checkbox"判断，
 * 会被误判成单选，然后只点一个选项——用户看到的就是"多选题只选一个"。
 *
 * 优先级：
 *   1. 题干里的【多选题】等标记（内容信号，最可靠）
 *   2. 选项 li 上的 qtype 属性：超星约定 0=单选 1=多选 3=判断
 *   3. 手机版的 answertype 输入框
 *   4. 兜底：看输入框类型和选项文本
 */
function questionTypeFromDom(node, titleEl, options, inputs) {
  const title = (titleEl ? titleEl.textContent : '') || '';
  if (/【多选题】|【不定项选择题】/.test(title)) return 'multi';
  if (/【判断题】/.test(title)) return 'judge';
  if (/【单选题】/.test(title)) return 'single';

  const tagged = node.querySelector('[qtype]');
  const qt = tagged && tagged.getAttribute('qtype');
  if (qt === '1') return 'multi';
  if (qt === '3') return 'judge';
  if (qt === '0') return 'single';

  const typeInput = node.querySelector('input[id^="answertype"]');
  const tv = typeInput && typeInput.value;
  if (tv === '1') return 'multi';
  if (tv === '3') return 'judge';
  if (tv === '0') return 'single';

  return detectType(inputs, options);
}

/* ---------- 适配器 A：超星手机版作业页 ----------
 * 结构特征（来自你给的原脚本，属于已验证的已知结构）：
 *   容器 .Py-mian1，题干 .Py-m1-title，选项列表 .answerList > li[id-param]，
 *   选项字母在 li > em[id-param] 的文本里，判断题 li 带 val-param="true|false"。
 */
const AdapterPyMian1 = {
  id: 'py-mian1',
  label: '超星手机版作业页',
  detect(doc) { return (doc || document).querySelectorAll('.Py-mian1').length > 0; },
  parse(doc) {
    doc = doc || document;
    const out = [];
    const nodes = doc.querySelectorAll('.Py-mian1');
    nodes.forEach((node, idx) => {
      const titleEl = node.querySelector('.Py-m1-title') || node.querySelector('.Py-m1-title1');
      if (!titleEl) return;
      const stem = stripStemPrefix((titleEl.textContent || '').replace(/\s+/g, ' ').trim());
      if (!stem) return;

      const inputs = Array.from(node.querySelectorAll('input[type=radio],input[type=checkbox]'));
      const options = [];

      const lis = node.querySelectorAll('.answerList li');
      lis.forEach((li) => {
        const em = li.querySelector('em[id-param]');
        const key = em ? (em.getAttribute('id-param') || '').toUpperCase() : '';
        let raw = (li.textContent || '').replace(/\s+/g, ' ').trim();
        // 已知字母来自 em 元素，按字符直接裁掉比正则更安全，
        // 不会把「AI技术」这种以字母开头的选项误伤成「I技术」
        if (key && raw.toUpperCase().startsWith(key)) raw = raw.slice(key.length).trim();
        const text = stripOptionPrefix(raw);
        if (!text) return;
        options.push({
          key: key || String.fromCharCode(65 + options.length),
          text: text,
          rawText: (li.textContent || '').replace(/\s+/g, ' ').trim(),
          input: li.querySelector('input') || null,
          clickEl: li,
          rawVal: li.getAttribute('val-param'),
        });
      });

      if (!options.length) return;
      out.push({
        index: idx,
        type: questionTypeFromDom(node, titleEl, options, inputs),
        stem: stem,
        options: options,
        container: node,
      });
    });
    return out;
  },
};

/* ---------- 适配器 B：语义启发式 ----------
 * 不依赖任何类名，靠 input 的 DOM 层级关系反推"哪几个 input 属于同一道题"。
 * 算法：统计每个祖先元素的子树里有多少个 radio/checkbox，
 * 取值 >= 2 且父元素的值比它更大的那个元素，就是"一道题的容器"。
 * 直觉解释：一道题内部输入框数量固定，一旦扩到父级数量变多，说明跨越了题目边界。
 */
const AdapterGeneric = {
  id: 'generic',
  label: '通用语义解析',
  detect(doc) {
    return (doc || document).querySelectorAll('input[type=radio],input[type=checkbox]').length >= 2;
  },

  // 找出所有"题目级容器"
  findContainers(doc) {
    doc = doc || document;
    // 注意：不能按 isVisible 过滤。超星的 radio/checkbox 往往是 display:none 或 opacity:0，
    // 真正的样式套在外层 li 上，点了 li 才改变隐藏 input 的 checked。
    // 之前加了可见性过滤，结果一个输入框都数不到，整页判定为空。
    const inputs = Array.from(doc.querySelectorAll('input[type=radio],input[type=checkbox]'))
      .filter((i) => !i.disabled);
    if (inputs.length < 2) return [];

    const body = doc.body || doc.documentElement;
    const counts = new Map();
    for (const inp of inputs) {
      let cur = inp.parentElement;
      let guard = 0;
      while (cur && cur !== body && guard++ < 40) {
        counts.set(cur, (counts.get(cur) || 0) + 1);
        cur = cur.parentElement;
      }
    }

    const containers = [];
    for (const [el, n] of counts) {
      if (n < 2) continue;
      const parentN = counts.get(el.parentElement) || 0;
      if (parentN > n) containers.push(el);
    }

    // 只有一道题的页面：所有祖先的输入框数都相同，上面找不到容器，
    // 退回用所有 input 的最低公共祖先当容器
    if (!containers.length) {
      const lca = lowestCommonAncestor(inputs);
      if (lca) containers.push(lca);
    }
    return containers;
  },

  parse(doc) {
    doc = doc || document;
    const containers = this.findContainers(doc);
    const out = [];
    containers.forEach((node, idx) => {
      const inputs = Array.from(node.querySelectorAll('input[type=radio],input[type=checkbox]'))
        .filter((i) => !i.disabled);
      if (inputs.length < 2) return;

      const options = [];
      for (const inp of inputs) {
        // 选项文本与点击目标：优先 label / li，退到父元素，最后是 input 本身
        const clickEl = inp.closest('label') || inp.closest('li') || inp.parentElement || inp;
        const raw = (clickEl.textContent || '').replace(/\s+/g, ' ').trim();
        // 传入"该位置应有的字母"，供无标点前缀（A北京）的歧义判断使用
        const text = stripOptionPrefix(raw, String.fromCharCode(65 + options.length));
        if (!text) continue;
        // 同一个文本重复出现说明抓到的是外层容器（比如整段的标题），跳过
        if (options.some((o) => o.text === text)) continue;
        options.push({
          key: String.fromCharCode(65 + options.length),
          text: text,
          rawText: raw,
          input: inp,
          clickEl: clickEl,
          rawVal: null,
        });
      }

      if (options.length < 2) return;
      const stem = extractStem(node, options);
      if (!stem) return;

      out.push({
        index: idx,
        type: detectType(inputs, options),
        stem: stem,
        options: options,
        container: node,
      });
    });
    return out;
  },
};

/* ---------- 适配器 C：超星 PC 版作业页 ----------
 * 结构（超星 web 端经典版，和手机版完全不同）：
 *   .TiMu 容器 → .Zy_TItle 题干 → .Zy_ulTop > li 选项
 * 选项里的 radio 通常是隐藏的，选中状态体现在 li / a 的 class 上。
 */
const AdapterChaoxingPc = {
  id: 'cx-pc',
  label: '超星 PC 作业页',
  detect(doc) { return (doc || document).querySelectorAll('.TiMu').length > 0; },
  parse(doc) {
    doc = doc || document;
    const out = [];
    doc.querySelectorAll('.TiMu').forEach((node, idx) => {
      const titleEl = node.querySelector('.Zy_TItle') || node;
      const stem = stripStemPrefix((titleEl.textContent || '').replace(/\s+/g, ' ').trim());
      if (!stem) return;

      const lis = Array.from(node.querySelectorAll('.Zy_ulTop li'));
      if (!lis.length) return;

      const options = [];
      lis.forEach((li, i) => {
        // 选项文本必须取 <a>，不能取整个 li：li 里还有 <span class="num_option">A</span>，
        // 取整个 li 会得到 "A 《关于…》"，字母重复一遍，后续文本匹配永远对不上。
        const a = li.querySelector('a');
        const raw = (a ? a.textContent : li.textContent || '').replace(/\s+/g, ' ').trim();
        const badge = li.querySelector('.num_option');
        const key = (badge && (badge.getAttribute('data') || badge.textContent.trim()))
          || String.fromCharCode(65 + i);
        const text = stripOptionPrefix(raw, key);
        if (!text) return;
        options.push({
          key: key.toUpperCase(),
          text: text,
          rawText: raw,
          input: li.querySelector('input') || null,
          // li 上挂着 role="radio" 和 tabindex，点击处理器也在 li 上
          clickEl: li,
          rawVal: li.getAttribute('val-param'),
        });
      });
      if (options.length < 2) return;

      const inputs = Array.from(node.querySelectorAll('input[type=radio],input[type=checkbox]'));
      out.push({
        index: idx,
        type: questionTypeFromDom(node, titleEl, options, inputs),
        stem: stem,
        options: options,
        container: node,
      });
    });
    return out;
  },
};

/* ---------- 适配器 D：按题型标记定位（不依赖任何类名）----------
 * 依据是页面上的文字本身：每道题前面都有【单选题】【多选题】【判断题】【填空题】。
 * 这类"内容信号"比类名稳定得多——超星改版会换 class，但不会把题型标记去掉。
 *
 * 适用范围最广，代价是启发式，所以要放在已知结构之后当兜底。
 */
const MARKER_RE = /【(单选题|多选题|判断题|填空题|不定项选择题|简答题|论述题|名词解释|计算题)】/;
const UNSUPPORTED_MARKERS = ['简答题', '论述题', '名词解释', '计算题'];

// 统计一个容器里"只由一个字母组成的叶子节点"数量——这类节点就是选项标号
function countLetterBadges(box) {
  let n = 0;
  const all = box.querySelectorAll('*');
  for (const el of all) {
    if (el.children.length) continue;
    if (/^[A-H]$/.test((el.textContent || '').trim())) n++;
  }
  return n;
}

// 找出所有"最内层的、包含题型标记"的元素。
// 用 TreeWalker 扫文本节点而不是遍历所有元素读 textContent：
// 后者在 60 题的作业页上要对上万个元素各做一次子树文本拼接，慢到能卡住界面。
// 文本节点的父元素本身就是最内层，还省掉了"子元素是否也包含标记"的判断。
function findMarkerNodes(doc) {
  const out = [];
  const seen = new Set();
  const walker = doc.createTreeWalker(
    doc.body || doc.documentElement,
    4,          // NodeFilter.SHOW_TEXT，直接写数值：某些环境里 NodeFilter 不是全局变量
    null
  );
  let node = walker.nextNode();
  let guard = 0;
  while (node && guard++ < 60000) {
    const text = node.nodeValue;
    if (text && MARKER_RE.test(text)) {
      const el = node.parentElement;
      if (el && !seen.has(el) && out.length < 400) {
        seen.add(el);
        out.push(el);
      }
    }
    node = walker.nextNode();
  }
  return out;
}

// 从标记元素往上爬，找到"装着一道题"的容器
function climbToQuestionBox(el, doc) {
  const body = doc.body || doc.documentElement;
  let cur = el;
  for (let i = 0; i < 10 && cur && cur !== body; i++) {
    const cls = (typeof cur.className === 'string') ? cur.className : '';
    // 已知的题目容器类名优先，命中即返回——比"数几个选项"更准，填空题没有选项也能定住
    if (/(TiMu|Py-mian1|questionLi|question|subject|qblock)/.test(cls)) return cur;
    if (countLetterBadges(cur) >= 2) return cur;
    // 爬太高说明已经越过题目边界了，及时收手
    if ((cur.textContent || '').length > 4000) break;
    cur = cur.parentElement;
  }
  return el.parentElement || el;
}

function dedupeOptions(opts) {
  const seen = new Set();
  const out = [];
  for (const o of opts) {
    const k = o.key + '|' + o.text;
    if (seen.has(k)) continue;
    if (out.some((x) => x.clickEl === o.clickEl)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

// 布局一：字母单独占一个元素，选项文本在它的兄弟节点里（超星新版就是这样）
function collectLetterOptions(box) {
  const badges = [];
  for (const el of box.querySelectorAll('*')) {
    if (el.children.length) continue;
    if (/^[A-H]$/.test((el.textContent || '').trim())) badges.push(el);
  }
  if (badges.length < 2) return null;

  const opts = [];
  for (const b of badges) {
    const key = (b.textContent || '').trim();
    // 选项行：从字母往上找，直到那个元素的文本明显多于字母本身
    let row = b;
    for (let i = 0; i < 4 && row.parentElement && row.parentElement !== box.parentElement; i++) {
      const p = row.parentElement;
      if ((p.textContent || '').replace(/\s+/g, '').length > key.length) { row = p; break; }
      row = p;
    }
    const raw = (row.textContent || '').replace(/\s+/g, ' ').trim();
    // 标号元素的文本就是 key，按长度精确切掉比正则可靠：
    // "A《关于…》" 这种字母后直接跟书名号的，正则认不出是编号。
    const noKey = raw.indexOf(key) === 0 ? raw.slice(key.length) : raw;
    const text = stripOptionPrefix(noKey);
    if (!text) continue;
    opts.push({
      key: key,
      text: text,
      rawText: raw,
      input: row.querySelector('input') || null,
      clickEl: row,
      rawVal: null,
    });
  }
  const deduped = dedupeOptions(opts);
  return deduped.length >= 2 ? deduped : null;
}

// 布局二：字母和文本在同一个元素里，形如 "A. 上海"
function collectRowOptions(box) {
  const cands = Array.from(box.querySelectorAll('li, div, p, a, span, dd'))
    .filter((el) => /^[A-H][.、．:：)）]\s*\S/.test((el.textContent || '').trim()));
  // 只保留最内层，避免外层容器重复计入
  const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
  const opts = inner.map((el) => {
    const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const key = raw.charAt(0).toUpperCase();
    return {
      key: key,
      text: stripOptionPrefix(raw, key),
      rawText: raw,
      input: el.querySelector('input') || null,
      clickEl: el,
      rawVal: null,
    };
  }).filter((o) => o.text);
  const deduped = dedupeOptions(opts);
  return deduped.length >= 2 ? deduped : null;
}

const AdapterByMarker = {
  id: 'marker',
  label: '按题型标记定位',
  detect(doc) { return findMarkerNodes(doc || document).length > 0; },

  parse(doc) {
    doc = doc || document;
    const nodes = findMarkerNodes(doc);
    const seen = new Set();
    const out = [];

    for (const node of nodes) {
      const m = MARKER_RE.exec(node.textContent || '');
      if (!m) continue;
      const typeName = m[1];
      if (UNSUPPORTED_MARKERS.indexOf(typeName) >= 0) continue;
      // 填空题交给 collectBlankQuestions 统一处理：它还要分辨 input 和富文本编辑器，
      // 逻辑不该散落在两个适配器里
      if (typeName === '填空题') continue;

      const box = climbToQuestionBox(node, doc);
      if (!box || seen.has(box)) continue;
      seen.add(box);

      let opts = collectLetterOptions(box) || collectRowOptions(box);
      if (!opts || opts.length < 2) continue;

      // 题干 = 容器全文减去所有选项原文，再剥掉题号与题型标记
      let stem = box.textContent || '';
      for (const o of opts) {
        if (o.rawText && o.rawText.length > 1) stem = stem.split(o.rawText).join(' ');
        if (o.text && o.text.length > 1) stem = stem.split(o.text).join(' ');
      }
      stem = stripStemPrefix(stem.replace(/[\s\u00A0]+/g, ' ').trim());
      if (!stem) continue;

      const inputs = Array.from(box.querySelectorAll('input[type=radio],input[type=checkbox]'));
      const type = typeName === '判断题'
        ? 'judge'
        : (typeName === '多选题' ? 'multi' : questionTypeFromDom(box, null, opts, inputs));

      out.push({ index: 0, type: type, stem: stem, options: opts, container: box });
    }
    return out;
  },
};

/* ---------- 适配器 E：填空题 ----------
 * 填空题不是"选项"结构，跟上面两个适配器不冲突，属于叠加解析：
 * 同一张卷子里既有选择题又有填空题时，两边都要跑，结果合并。
 *
 * 识别依据：
 *   1. input[type=text] 且不是搜索框；
 *   2. 它所在的容器文本里有"第N空："或"填空"字样。
 * 单独靠 input 判断会误抓页面上所有的搜索框，所以第 2 条是必要的。
 */
const BLANK_LABEL = /第\s*\d+\s*空\s*[：:]/;

function isBlankInput(el) {
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  if (t !== 'text') return false;
  if (el.disabled || el.readOnly) return false;
  // 把 placeholder / id / name / class 拼起来一起判断，避免把验证码框当填空题。
  // 实测教训：超星作业页上的「请输入验证码」输入框曾被误判成填空题，答案被填进验证码里。
  const hint = [el.getAttribute('placeholder'), el.id, el.name, el.className].join(' ');
  if (/验证码|captcha|verify|yzm|search|搜索/i.test(hint)) return false;
  return isVisible(el);
}

// 向上找"这道题的盒子"：含「第N空：」或「填空」字样的最近祖先。
// 加长度上限是必要的：如果一路爬到整页容器，题干就会变成整张卷子的文本。
function findBlankBox(input) {
  let cur = input.parentElement;
  let guard = 0;
  while (cur && guard++ < 8) {
    const txt = cur.textContent || '';
    if (txt.length > 800) return null;          // 已经爬到过大范围，放弃
    if (BLANK_LABEL.test(txt) || /填空/.test(txt)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/* ---------- 填空题目标：可能是 input，也可能是富文本编辑器 ----------
 * 超星的填空题在新版作业页里用的是 UEditor：
 *   var answerEditor4058890891 = UE.getEditor("answerEditor4058890891", …);
 * 所以不能只找 input[type=text]，那样一个都找不到（页面上唯一的 text 输入框是验证码）。
 */
function findBlankTargets(box) {
  const targets = [];

  // 普通输入框
  const inputs = Array.from(box.querySelectorAll('input[type=text], input:not([type]), textarea'))
    .filter(isBlankInput);
  if (inputs.length) {
    inputs.forEach((el) => targets.push({ kind: 'input', el: el }));
    return targets;
  }

  // 富文本编辑器
  const hasEditor = box.querySelector('[id^="answerEditor"], .edui-body-container, iframe[id^="ueditor"], [id^="inpDiv"]');
  if (hasEditor) {
    targets.push({ kind: 'richtext', container: box });
  }
  return targets;
}

const AdapterBlank = {
  id: 'blank',
  label: '填空题',
  detect(doc) {
    doc = doc || document;
    const txt = (doc.body ? doc.body.textContent : '') || '';
    if (!/第\s*\d+\s*空|填空/.test(txt)) return false;
    return this.collect(doc).length > 0;
  },
  collect(doc) {
    const all = Array.from(doc.querySelectorAll('input[type=text], input:not([type])'));
    return all.filter(isBlankInput);
  },
  parse(doc) {
    const inputs = this.collect(doc || document);
    // 一道题可能有两个空，所以按容器分组而不是按 input 分组
    const groups = new Map();
    for (const inp of inputs) {
      const box = inp.closest('.Py-mian1') || inp.closest('.TiMu') || findBlankBox(inp);
      if (!box) continue;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push(inp);
    }

    const out = [];
    for (const [box] of groups) {
      const targets = findBlankTargets(box);
      if (!targets.length) continue;
      const titleEl = box.querySelector('.Py-m1-title') || box.querySelector('.Zy_TItle') || box;
      let stem = titleEl.textContent || '';
      // 去掉「第1空：」这类标签，否则会混进题干送给模型
      stem = stem.replace(/第\s*\d+\s*空\s*[：:]/g, ' ');
      stem = stripStemPrefix(stem.replace(/[\s\u00A0]+/g, ' ').trim());
      if (!stem) continue;
      out.push({
        index: 0,
        type: 'blank',
        stem: stem,
        options: [],
        blanks: targets,     // 每个元素是 { kind:'input'|'richtext', el|container }
        container: box,
      });
    }
    return out;
  },
};

// 按文档顺序排列，让日志里的题号与实际卷面一致
function sortByDocumentOrder(questions) {
  questions.sort((a, b) => {
    if (!a.container || !b.container) return 0;
    const pos = a.container.compareDocumentPosition(b.container);
    if (pos & 4) return -1;   // DOCUMENT_POSITION_FOLLOWING
    if (pos & 2) return 1;    // DOCUMENT_POSITION_PRECEDING
    return 0;
  });
  questions.forEach((q, i) => { q.index = i; });
  return questions;
}

function lowestCommonAncestor(nodes) {
  if (!nodes.length) return null;
  let cur = nodes[0].parentElement;
  const containsAll = (el) => nodes.every((n) => el.contains(n));
  while (cur && !containsAll(cur)) cur = cur.parentElement;
  return cur;
}

/**
 * 收集填空题。单独成一个流程，因为填空题的目标可能是 input，也可能是富文本编辑器，
 * 而且要独立于"选择题适配器谁赢了"——一张卷子往往同时有选择题和填空题。
 */
function collectBlankQuestions(doc) {
  const out = [];
  const seen = new Set();

  // 优先：按【填空题】标记定位（不依赖类名，新版作业页走这条）
  for (const node of findMarkerNodes(doc)) {
    const m = MARKER_RE.exec(node.textContent || '');
    if (!m || m[1] !== '填空题') continue;
    const box = climbToQuestionBox(node, doc);
    if (!box || seen.has(box)) continue;
    seen.add(box);

    const targets = findBlankTargets(box);
    if (!targets.length) continue;

    let stem = (box.textContent || '').replace(/第\s*\d+\s*空\s*[：:]/g, ' ');
    stem = stripStemPrefix(stem.replace(/[\s\u00A0]+/g, ' ').trim());
    if (!stem) continue;
    out.push({ index: 0, type: 'blank', stem: stem, options: [], blanks: targets, container: box });
  }

  // 兜底：老式的 input + 「第N空」结构
  if (!out.length) {
    try { return AdapterBlank.parse(doc); } catch (e) { return []; }
  }
  return out;
}

/**
 * 检测字体加密。超星用 .font-cxsecret 把文字替换成同形的生僻字，
 * 靠自定义字体渲染回正常字形——人看着没问题，但 DOM 里取到的文本是乱的。
 *
 * 注意：只看 class 会误判。有些页面（如医学英语）挂了 font-cxsecret 这个
 * class，但根本没有对应的 @font-face，文字本来就是明文。所以要同时看
 * 「有没有真正的加密字体」。
 */
function detectFontObfuscation(doc) {
  try {
    const els = doc.querySelectorAll('.font-cxsecret, [class*="cxsecret"]');
    if (!els.length) return null;
    const hasFont = (typeof FontDecoder !== 'undefined') && FontDecoder.available(doc);
    if (!hasFont) return null;   // 只有 class，没有字体，等于没加密
    const sample = (els[0].textContent || '').replace(/\s+/g, '').slice(0, 50);
    return { count: els.length, sample: sample };
  } catch (e) {
    return null;
  }
}

/**
 * 检查卷面上是否存在本脚本处理不了的题型。
 * 关键点：如果卷面标了「填空题」但我们一个空都没抓到，不能当作"没有填空题"，
 * 而要当作"抓取失败"。否则覆盖率会算成 100%，把一张空着 10 道填空的卷子提交上去。
 */
function detectUnsupportedTypes(doc, blankQs) {
  const text = (doc && doc.body ? doc.body.textContent : '') || '';
  const out = [];

  // 只有"页面确实有文本输入框、但我们一个空都没解析出来"才算抓取失败。
  // 光看到"填空题"三个字就报错会误伤：有些页面会在说明文字里提到题型。
  let textInputs = 0;
  try { textInputs = doc.querySelectorAll('input[type=text]').length; } catch (e) { textInputs = 0; }
  if (/填空题/.test(text) && textInputs > 0 && (!blankQs || !blankQs.length)) out.push('填空题');

  // 简答题只认"题型标记"或"小节标题（共N题）"两种形式。
  // 不能用裸的"简答题"三个字做判断——页面上任何一处提到（比如题型统计栏）都会误报，
  // 一旦误报就永远不自动提交，比漏报更让人困惑。
  if (/【(简答题|论述题|名词解释|计算题)】/.test(text) ||
      /(简答题|论述题|名词解释|计算题)\s*[（(]\s*共/.test(text)) {
    out.push('简答题');
  }
  return out;
}

/* ---------- 对外入口 ---------- */

const Parser = {
  // 顺序即优先级：已知结构在前（准），启发式在后（广）
  adapters: [AdapterPyMian1, AdapterChaoxingPc, AdapterByMarker, AdapterGeneric],

  /**
   * 解析指定文档上的全部题目。
   * @param {Document} [doc] 目标文档。章节测验常常渲染在 iframe 里，
   *                         传 iframe.contentDocument 才能抓到题。
   * @returns {{adapter:string|null, questions:Array, tried:Array, unsupported:Array}}
   */
  parse(doc, opts) {
    doc = doc || document;
    opts = opts || {};
    const tried = [];

    // 第一轮：选择题适配器，取第一个能解析出结果的（互斥关系）
    let choiceQs = [];
    let adapter = null;
    for (const a of this.adapters) {
      let hit = false;
      try {
        hit = a.detect(doc);
      } catch (e) {
        tried.push({ id: a.id, detected: false, error: e.message });
        continue;
      }
      if (!hit) { tried.push({ id: a.id, detected: false }); continue; }

      try {
        const qs = a.parse(doc);
        tried.push({ id: a.id, detected: true, count: qs.length });
        // 只有拿到"至少一道且选项齐整"的题目才算解析成功
        const valid = qs.filter((q) => q.stem && q.options.length >= 2);
        if (valid.length) {
          choiceQs = valid;
          adapter = a.id;
          break;
        }
      } catch (e) {
        tried.push({ id: a.id, detected: true, error: e.message });
        log('解析器 ' + a.id + ' 出错：' + e.message, 'warn');
      }
    }

    // 第二轮：填空题是叠加的，不参与上面的互斥竞争
    let blankQs = [];
    try {
      blankQs = collectBlankQuestions(doc);
      tried.push({ id: 'blank', detected: blankQs.length > 0, count: blankQs.length });
    } catch (e) {
      tried.push({ id: 'blank', detected: true, error: e.message });
      log('填空题解析出错：' + e.message, 'warn');
    }

    const questions = sortByDocumentOrder(choiceQs.concat(blankQs));

    // 字体解密：把被替换的字还原成真字。
    // 不做这一步，模型读到的是「聚厩2035年建成文化强国战略廆标」这种乱码，
    // 只能返回极低的置信度，然后被全部跳过。
    let decodedCount = 0;
    if (opts.decodeFont && typeof FontDecoder !== 'undefined' && FontDecoder.ready) {
      for (const q of questions) {
        const before = q.stem;
        // 保留加密态原文：题库若是从页面抓取众包来的，存的可能就是这个形式
        q.rawStem = before;
        q.stem = FontDecoder.decode(q.stem);
        if (q.stem !== before) decodedCount++;
        (q.options || []).forEach((o) => {
          o.text = FontDecoder.decode(o.text);
          o.rawText = FontDecoder.decode(o.rawText || '');
        });
      }
      if (decodedCount) {
        log('字体解码已应用：' + decodedCount + ' 道题的题干被还原', 'success');
      }
    } else if (opts.decodeFont && typeof FontDecoder !== 'undefined'
               && FontDecoder.available(doc) && !FontDecoder.ready) {
      // 解码表要异步构建，调用方必须先把 ensureReady 走完再解析。
      // 走到这里说明调用方漏了这一步，如实说，不要假装解码过。
      log('检测到字体加密，但解码表尚未就绪，本次使用原始文本', 'warn');
    }

    // 卷面上有我们处理不了的题型时，必须明确告诉用户。
    // 否则会出现"覆盖率 100% 就提交"，但填空题其实全空着的致命情况。
    const unsupported = detectUnsupportedTypes(doc, blankQs);

    if (adapter && blankQs.length) {
      log('解析成功：' + adapter + ' + 填空，共 ' + questions.length + ' 题', 'success');
    } else if (adapter) {
      log('解析成功：' + adapter + '，共 ' + questions.length + ' 题', 'success');
    } else if (blankQs.length) {
      log('解析成功：仅填空题，共 ' + questions.length + ' 题', 'success');
    }

    return {
      adapter: adapter,
      questions: questions,
      tried: tried,
      unsupported: unsupported,
      obfuscated: detectFontObfuscation(doc),
      decoded: decodedCount,
    };
  },

  /* ---------- 调试：导出页面结构 ----------
   * 解析失败时用。把候选容器的精简结构导出，方便判断到底是哪套页面。
   */
  dumpStructure(doc) {
    doc = doc || document;
    const lines = [];
    const cnt = (sel) => { try { return doc.querySelectorAll(sel).length; } catch (e) { return -1; } };

    lines.push('=== 页面基本信息 ===');
    lines.push('URL: ' + (doc.location ? doc.location.href : location.href));
    lines.push('标题: ' + (doc.title || ''));
    lines.push('是否 iframe: ' + (doc === document ? '否（顶层）' : '是（子框架）'));
    lines.push('radio 数量: ' + cnt('input[type=radio]'));
    lines.push('checkbox 数量: ' + cnt('input[type=checkbox]'));
    lines.push('text input 数量: ' + cnt('input[type=text]'));
    lines.push('.Py-mian1 数量: ' + cnt('.Py-mian1'));
    lines.push('.answerList 数量: ' + cnt('.answerList'));
    lines.push('UEditor 编辑器数量: ' + cnt('[id^="answerEditor"], .edui-body-container'));
    const obf = detectFontObfuscation(doc);
    lines.push('字体加密(.font-cxsecret): ' + (obf ? '是，' + obf.count + ' 个元素' : '否'));
    if (obf) {
      lines.push('  加密样本: ' + obf.sample);
      if (typeof FontDecoder !== 'undefined') {
        lines.push('  解码状态: ' + FontDecoder.summary());
        if (FontDecoder.ready) lines.push('  字符对照: ' + FontDecoder.describeSamples());
      }
    }
    lines.push('');
    // 顶层页面找不到题时，多半是题目在 iframe 里，这里把框架列表列出来
    const iframes = doc.querySelectorAll('iframe');
    if (iframes.length) {
      lines.push('=== iframe 列表 ===');
      Array.from(iframes).forEach((f, i) => {
        let accessible = '否（跨域或无内容）';
        try { if (f.contentDocument && f.contentDocument.documentElement) accessible = '是'; } catch (e) { accessible = '否（跨域）'; }
        lines.push('  #' + i + ' src=' + (f.getAttribute('src') || '(空)').slice(0, 120));
        lines.push('       可访问=' + accessible);
      });
      lines.push('');
    }

    lines.push('=== 解析尝试 ===');
    try {
      const r = this.parse(doc);
      r.tried.forEach((t) => lines.push('  ' + JSON.stringify(t)));
      lines.push('  最终采用: ' + (r.adapter || '无'));
      lines.push('  不支持的题型: ' + (r.unsupported.length ? r.unsupported.join('、') : '无'));
      lines.push('');
      lines.push('=== 解析结果（前 5 题）===');
      r.questions.slice(0, 5).forEach((q, i) => {
        lines.push('  #' + (i + 1) + ' [' + q.type + '] ' + q.stem);
        q.options.forEach((o) => lines.push('      ' + o.key + '. ' + o.text));
        if (q.blanks) lines.push('      （' + q.blanks.length + ' 个空：' + q.blanks.map((b) => b.kind).join(', ') + '）');
      });
      lines.push('');
      lines.push('=== 候选题目块 HTML（前 3 块，用于精确适配）===');
      try {
        const nodes = findMarkerNodes(doc);
        if (!nodes.length) lines.push('  没有找到任何【题型】标记');
        nodes.slice(0, 3).forEach((n, i) => {
          const mm = MARKER_RE.exec(n.textContent || '');
          const box = climbToQuestionBox(n, doc);
          lines.push('  --- 第 ' + (i + 1) + ' 块，题型=' + (mm ? mm[1] : '未知') + ' ---');
          lines.push('  标记元素: ' + compactHtml(n, 300));
          lines.push('  题目容器 class=' + (typeof box.className === 'string' ? box.className : '(非字符串)') +
            ' 标签=' + (box.tagName || '') + ' 内含字母标号=' + countLetterBadges(box));
          lines.push('  容器HTML: ' + compactHtml(box, 1500));
        });
      } catch (e) {
        lines.push('  导出候选块失败: ' + e.message);
      }

      lines.push('');
      lines.push('=== 填空题候选（前 8 个）===');
      const texts = Array.from(doc.querySelectorAll('input[type=text]')).slice(0, 8);
      if (!texts.length) lines.push('  没有找到 text 输入框');
      texts.forEach((inp, i) => {
        lines.push('  input#' + i + ' placeholder=' + (inp.getAttribute('placeholder') || '(空)') +
          ' 可见=' + isVisible(inp) + ' 是填空=' + isBlankInput(inp));
      });
      const editors = Array.from(doc.querySelectorAll('[id^="answerEditor"]')).slice(0, 8);
      lines.push('  UEditor 实例: ' + editors.length + ' 个' +
        (editors.length ? '（' + editors.map((e) => e.id).join(', ') + '）' : ''));
    } catch (e) {
      lines.push('  解析抛错: ' + e.message);
    }

    lines.push('');
    lines.push('=== input 的祖先链（前 3 个，用于判断容器层级）===');
    const inputs = Array.from(doc.querySelectorAll('input[type=radio],input[type=checkbox]')).slice(0, 3);
    inputs.forEach((inp, i) => {
      lines.push('  input#' + i + ' name=' + (inp.name || '(空)') + ' type=' + inp.type);
      let cur = inp.parentElement;
      let d = 0;
      while (cur && d < 8) {
        const c2 = cur.querySelectorAll('input[type=radio],input[type=checkbox]').length;
        lines.push('    ↑ ' + cur.tagName.toLowerCase() +
          (cur.id ? '#' + cur.id : '') +
          (cur.className && typeof cur.className === 'string' ? '.' + cur.className.trim().split(/\s+/).slice(0, 3).join('.') : '') +
          '  [内含input ' + c2 + ']');
        cur = cur.parentElement;
        d++;
      }
    });

    return lines.join('\n');
  },
};
