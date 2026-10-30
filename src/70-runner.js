/* ============================================================
 * 70-runner.js —— 答题执行器
 *
 * 流程刻意分成两段：先并发把所有答案取回来，再串行往页面上填。
 * 原因：DOM 元素引用不能在异步等待中长时间悬空（页面重渲染会让引用失效），
 * 而取答案恰恰是最慢的一步（每题 2~8 秒）。先取后填能把风险降到最低。
 * ============================================================ */

// 提交 / 保存按钮的文案。超星各版本按钮文字略有差异，用精确匹配避免误点"保存草稿"
const SUBMIT_TEXTS = ['提交', '提交答案', '提交作业', '交卷', '完成作业', '确认提交', '提交试卷'];
// 「暂时保存」是超星新版作业页的实际文案，单独列出。
// 之前只写了「保存」，精确匹配找不到它，覆盖率不达标时就保存不了。
const SAVE_TEXTS = ['保存', '暂存', '暂时保存', '保存答案', '保存作业', '暂存答案', '暂时保存答案'];

const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

/* 超星的作业页挂在 iframe 里，页面自己的函数（noSubmit / submitCheckTimes）
 * 也挂在**那个 iframe 的 window** 上，不在顶层。
 *
 * 这一条踩过坑：之前 confirm 的拦截写死在顶层的 pageWin 上，而实际弹框来自
 * iframe，等于完全没拦住——超星弹「还有题未完成」，脚本照样往下点确定。
 *
 * 原脚本就是直接调页面自己的这两个函数，比点按钮可靠：不怕按钮文案变，
 * 也不经过确认框那一层。
 */
const SAVE_FNS = ['noSubmit', 'saveAnswer', 'saveWork', 'tijiaoSave'];
const SUBMIT_FNS = ['submitCheckTimes', 'submitWork', 'tijiao'];

/** 取"实际答题的那个文档"的 window，找不到就退回顶层 */
function winOf(doc) {
  const d = doc || (typeof Runner !== 'undefined' && Runner.doc) || document;
  try { return (d && d.defaultView) || pageWin; } catch (e) { return pageWin; }
}

/**
 * 在目标文档的 window 上找页面自带的函数。
 * @returns {{name:string, fn:function, win:object}|null}
 */
function findPageFn(doc, names) {
  const win = winOf(doc);
  for (const n of names) {
    try {
      if (typeof win[n] === 'function') return { name: n, fn: win[n], win: win };
    } catch (e) { /* 访问器异常，跳过 */ }
  }
  return null;
}

function findButtonByText(texts, doc) {
  // 题目可能在 iframe 里，按钮也在同一个文档里，所以不能写死顶层 document
  const d = doc || (typeof Runner !== 'undefined' && Runner.doc) || document;
  let all = [];
  try { all = Array.from(d.querySelectorAll('button, a, input[type=submit], div[role=button], span, div')); }
  catch (e) { return null; }
  const want = new Set(texts);
  const exact = [];
  const loose = [];
  for (const el of all) {
    if (!isVisible(el)) continue;
    // 只看叶子节点，避免把整个页面的外层 div 也算成按钮
    const own = (el.textContent || '').replace(/\s+/g, '').trim();
    // 16 而不是 12：超星的按钮常带后缀，如「暂时保存（Ctrl+S）」
    if (!own || own.length > 16) continue;
    if (el.querySelector('button, a, input')) continue; // 有子交互元素说明是容器
    if (want.has(own)) { exact.push(el); continue; }
    // 精确匹配不到时退一步：以关键词开头、后面只多几个字也算。
    // 限定「开头」而不是「包含」，否则找「提交」会把「暂时保存」也捞进来。
    for (const w of texts) {
      if (own.length <= w.length + 4 && own.indexOf(w) === 0) { loose.push(el); break; }
    }
  }
  const hits = exact.length ? exact : loose;
  if (!hits.length) return null;
  // 优先返回最内层、且尺寸合理的那个
  hits.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  return hits[0];
}

// 点击后等待页面响应，用轮询而不是固定 sleep，能省下不少时间
function waitFor(cond, timeout, interval) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = cond(); } catch (e) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - t0 > timeout) return resolve(false);
      setTimeout(tick, interval || 200);
    };
    tick();
  });
}

/**
 * 保存之后这份作业算"完成"还是"未完成"——刷课跳不跳下一节就看它。
 * 原脚本（unrival）的行为：autoSave 开着时，保存成功（noSubmit）就把作业
 * 标记为完成、继续下一章，从不因为覆盖率不足或题型不支持卡住整个流程。
 * 本函数提炼出这个判定，两处调用点（覆盖率不足 / 含不支持题型）共用，
 * 也让测试能直接钉住"保存即继续"这个行为。
 * @param {boolean} saved 保存是否成功
 * @param {object} cfg quiz 配置（用 autoSave / minAnswerRate）
 * @param {number} rate 覆盖率百分比
 * @param {string[]} unsupported 卷面上脚本写不进的题型
 * @returns {{status:string, reason:string, rate:number, saved:boolean, submitted:boolean}}
 */
function decideAfterSave(saved, cfg, rate, unsupported) {
  const why = (unsupported && unsupported.length)
    ? '有不支持题型已保存（原脚本行为：继续）'
    : '覆盖率不足已保存（原脚本行为：继续）';
  // 保存成功且配置允许自动保存 → 原脚本行为：完成，继续
  if (saved && cfg.autoSave) return { status: 'done', reason: why, rate: rate, saved: true, submitted: false };
  // 答案没落库 → 继续走会丢答案，必须停
  const reason = (unsupported && unsupported.length)
    ? '有脚本不支持的题型：' + unsupported.join('、')
    : '覆盖率 ' + rate.toFixed(1) + '% 未达 ' + cfg.minAnswerRate + '%' + (saved ? '' : '，且保存失败');
  return { status: 'incomplete', reason: reason, rate: rate, saved: saved, submitted: false };
}

/* ---------- 并发池 ---------- */
// 注意：worker 内部必须自己吞掉异常，否则一个 reject 会让整个池子提前退出
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < size; i++) {
    runners.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          results[idx] = await worker(items[idx], idx);
        } catch (e) {
          results[idx] = { error: e };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

/* ---------- 选项点击 ---------- */
// 判断选项当前是否已被选中。原生 input 看 checked，
// 定制组件（React 渲染的 div）只能看类名里的选中标记。
function classOf(el) {
  return (el && typeof el.className === 'string') ? el.className : '';
}

// 是否存在可靠的"是否已选中"信号。
// 有信号才能校验点击结果；没有信号时校验一定会失败，
// 导致明明点上了却被判成"点击未生效"，进而拉低覆盖率、卡住自动提交。
function hasStateSignal(opt) {
  if (opt.input) return true;
  return /(^|\s)(cur|active|checked|selected|on)(\s|$)/.test(classOf(opt.clickEl));
}

function isOptionChecked(opt, box) {
  if (opt.input) return !!opt.input.checked;
  const cls = classOf(opt.clickEl);
  if (/(^|\s|-|_)(cur|active|checked|selected|on)(\s|$|-|_)/.test(cls)) return true;
  // 类名不可读时，退回读超星自己记录的答案字段——这是唯一权威的状态来源。
  // 少了这一步，页面上的选中样式一旦换了类名，脚本就会把"已选中"当成"没选中"，
  // 对着已选好的选项再点一下，把答案点掉。
  if (box) {
    const val = readAnswerValue(box);
    if (val !== null && val !== '') {
      // 判断题的选项带 val-param="true|false"，和字段值同构，直接比。
      // 用字母比会对不上（选项 key 是 A/B，字段里存的是 true/false），
      // 结果把所有判断题都判成"未选中"，然后反复点，把刚点上的又点掉。
      let vp = null;
      try {
        vp = opt.clickEl && opt.clickEl.getAttribute ? opt.clickEl.getAttribute('val-param') : null;
      } catch (e) { vp = null; }
      if (vp) return String(vp).toLowerCase() === String(val).toLowerCase();

      const k = String(opt.key || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (k) return String(val).toUpperCase().replace(/[^A-Z]/g, '').indexOf(k) >= 0;
      return false;
    }
  }
  return false;
}

/**
 * 读超星记录答案的隐藏 input。
 *
 * ⚠️ 必须排除 answertype：`input[name^="answer"]` 会把 `answertypeXXXX`
 * 一起匹配进来，那个字段存的是题型（0/1/3），不是答案。读到它就等于
 * 每题都被判成"已作答"，自检形同虚设。
 * @returns {string|null} 读不到返回 null（页面可能没这个字段）
 */
function readAnswerValue(box) {
  if (!box) return null;
  let list = [];
  try { list = box.querySelectorAll('input[name^="answer"]'); } catch (e) { return null; }
  for (const el of list) {
    if (/^answertype/i.test(el.name || '')) continue;
    return String(el.value == null ? '' : el.value).trim();
  }
  return null;
}

/** 按超星的值字段核对：填入结果到底对不对。读不到字段时返回 null（不判定） */
function verifyChoiceValue(q, wanted) {
  const val = readAnswerValue(q.container);
  if (val === null) return null;

  // 判断题不能拿字母比：选项 key 是 A/B，而超星在字段里存的是 true/false。
  // 之前直接拿 'true'.indexOf('A') 去比，必然 -1，导致所有判断题被判"点击未生效"。
  // 判断题答了就是答了，只要字段非空就算过——具体选对没选对是模型的活。
  if (q.type === 'judge') return val !== '';

  // 超星多选题可能存 'ABC'、'A,B,C' 或 'A B C'，先去掉非字母再比
  const got = String(val).toUpperCase().replace(/[^A-Z]/g, '');
  const want = wanted
    .map((o) => String(o.key || '').toUpperCase().replace(/[^A-Z]/g, ''))
    .filter(Boolean);
  if (!want.length) return null;

  if (q.type === 'multi') {
    // 集合相等：既不许少选，也不许多选
    const a = got.split('').sort().join('');
    const b = want.join('').split('').sort().join('');
    return a === b;
  }
  return want.every((k) => got.indexOf(k) >= 0);
}

// 设定某个选项的状态。已经处于目标状态就不动它——
// 很多定制组件点两下会取消选中，盲目点击会把已填对的答案点掉。
function setOptionState(opt, wanted, box) {
  const current = isOptionChecked(opt, box);
  if (current === wanted) return true;

  try { if (opt.clickEl && opt.clickEl.scrollIntoView) opt.clickEl.scrollIntoView({ block: 'center' }); } catch (e) { /* 布局未就绪时忽略 */ }

  const beforeCls = classOf(opt.clickEl);

  // 先点原生 input，最贴近真实交互
  if (opt.input) {
    try { opt.input.click(); } catch (e) { /* 部分页面 input 被遮挡，走下面的兜底 */ }
    if (isOptionChecked(opt, box) === wanted) return true;
  }

  // 再点外层容器（定制的 li / div 通常把 click 处理器挂在这里）
  if (opt.clickEl) {
    try { opt.clickEl.click(); } catch (e) { /* 忽略，最后统一返回结果 */ }
  }

  if (isOptionChecked(opt, box) === wanted) return true;

  // 没有可读状态信号时无法校验，只能乐观认为点上了。
  // 但若类名发生了变化，说明页面确实响应了点击，同样算成功。
  if (!hasStateSignal(opt) && !(box && readAnswerValue(box))) return true;
  return classOf(opt.clickEl) !== beforeCls;
}

/* ---------- 提交与保存 ---------- */

// 超星提交时会弹确认框。原生 confirm 会阻塞页面线程，所以先替换成恒真函数；
// 自定义弹层则去找"确定/确认"按钮点掉。
/* 超星在"还有题没做完"时会弹确认框。这种框**绝不能自动点确定**：
 * 一旦点了，轻则提交被服务端拒回，重则页面被重置、填好的答案全丢
 * （实测出现过：60 题填满，点提交后答案全消失）。
 */
const UNSAFE_CONFIRM = /未完成|没有完成|尚未完成|未作答|还有\s*\d+\s*(道|题)|确定要提交/;

/**
 * 在目标 window 上临时装一个 confirm 守卫，然后执行 fn。
 * 直接调页面函数（不点按钮）时也要装：超星的 noSubmit / submitCheckTimes
 * 内部可能自己弹 confirm，装不上就拦不住。
 * @returns {Promise<{blocked:boolean, msg:string, error:Error|null}>}
 */
async function callWithGuard(win, guard, fn) {
  const orig = win.confirm;
  let blockedMsg = '';
  try {
    win.confirm = function (msg) {
      const t = String(msg == null ? '' : msg);
      if (guard && !guard(t)) { blockedMsg = t; return false; }
      return true;
    };
  } catch (e) { /* window 不可写就算了 */ }
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  await sleep(600);
  try { win.confirm = orig; } catch (e) { /* 忽略 */ }
  return { blocked: !!blockedMsg, msg: blockedMsg, error: error };
}

/**
 * 点击一个按钮，并处理它可能弹出的确认框。
 * @param {Element} btn
 * @param {{guard?:function(string):boolean}} opts
 *        guard 返回 false 表示拦下这个确认框（不自动点"是"）
 * @returns {Promise<{ok:boolean, blocked:boolean, msg:string}>}
 */
async function clickWithConfirm(btn, opts) {
  const guard = (opts && opts.guard) || null;
  let blockedMsg = '';
  // 关键：确认框来自**按钮所在文档**的 window，不是顶层。
  // 作业页在 iframe 里，改顶层 window.confirm 一点用都没有。
  const doc = (btn.ownerDocument) || (typeof Runner !== 'undefined' && Runner.doc) || document;
  const win = winOf(doc);
  const originalConfirm = win.confirm;
  try {
    win.confirm = function (msg) {
      const text = String(msg == null ? '' : msg);
      if (guard && !guard(text)) {
        blockedMsg = text;
        return false;   // 告诉页面"用户取消了"
      }
      return true;
    };
  } catch (e) { /* 某些环境下 window 不可写，忽略即可，不影响后续流程 */ }

  try { btn.click(); } catch (e) {
    log('点击按钮失败：' + e.message, 'error');
    try { win.confirm = originalConfirm; } catch (e2) { /* 忽略 */ }
    return { ok: false, blocked: false, msg: '' };
  }

  // 自定义弹层（不是 window.confirm）也要检查：出现"未完成"就点取消，而不是点确定
  const done = await waitFor(() => {
    const warn = findBlockingDialog(doc);
    if (warn) {
      blockedMsg = warn.text;
      const cancel = findButtonByText(['取消', '返回', '否'], doc);
      if (cancel) { try { cancel.click(); } catch (e) { /* 忽略 */ } }
      return true;
    }
    const ok = findButtonByText(['确定', '确认', '是', 'OK'], doc);
    if (ok) {
      // 弹层里的确定按钮通常带 primary 类，避免点到页面其他"确定"
      ok.click();
      return true;
    }
    return false;
  }, 4000, 300);

  await sleep(done ? 1200 : 600);

  try { win.confirm = originalConfirm; } catch (e) { /* 还原失败无副作用 */ }
  return { ok: true, blocked: !!blockedMsg, msg: blockedMsg };
}

/**
 * 找一个"拦下就别点确定"的弹层：文字里带"未完成/还有 N 题"之类的。
 * 只认小块的、可见的容器，避免把整页文本当弹层。
 */
function findBlockingDialog(doc) {
  const d = doc || (typeof Runner !== 'undefined' && Runner.doc) || document;
  let all = [];
  try { all = Array.from(d.querySelectorAll('div, section, p, span')); }
  catch (e) { return null; }
  for (const el of all) {
    if (!el.getClientRects || el.getClientRects().length === 0) continue;
    const t = (el.textContent || '').replace(/\s+/g, '');
    if (!t || t.length > 120) continue;
    if (!UNSAFE_CONFIRM.test(t)) continue;
    // 取最内层：如果子元素也命中，说明不是最精确的那个
    let childHit = false;
    for (const c of el.children) {
      const ct = (c.textContent || '').replace(/\s+/g, '');
      if (ct && ct.length <= 120 && UNSAFE_CONFIRM.test(ct)) { childHit = true; break; }
    }
    if (!childHit) return { el: el, text: t };
  }
  return null;
}

/**
 * 自检：逐题看页面上到底有没有落下答案。
 *
 * 为什么要这个：覆盖率是脚本自己算的（"我填了 60 题"），而超星判定
 * "完成"看的是它自己的字段。两者不一致时，提交会被拒、页面还可能被重置。
 * 与其提交之后才发现，不如提交前先照超星的口径检查一遍。
 *
 * @returns {Array<number>} 页面上找不到答案的题号（1 起）
 */
/** 把 [41,42,43,50] 压成「41-43、50」，日志里好读 */
function formatRanges(nums) {
  const arr = nums.slice().sort((a, b) => a - b);
  if (!arr.length) return '';
  const out = [];
  let start = arr[0];
  let prev = arr[0];
  for (let i = 1; i <= arr.length; i++) {
    const cur = arr[i];
    if (cur !== prev + 1) {
      out.push(start === prev ? String(start) : start + '-' + prev);
      start = cur;
    }
    prev = cur;
  }
  return out.join('、');
}

function auditAnswerState(questions) {
  const empty = [];  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const box = q.container;
    if (!box) continue;
    let filled = false;

    if (q.type === 'blank' && q.blanks && q.blanks.length) {
      for (const b of q.blanks) {
        if (b.kind === 'input' && b.el) {
          if (String(b.el.value || '').trim()) { filled = true; break; }
        } else if (b.kind === 'richtext' && b.container) {
          // 三条路都看一下：超星回传容器、编辑器内部 iframe、UEditor 实例内容
          const div = b.container.querySelector('[id^="inpDiv"]');
          if (div && String(div.textContent || '').trim()) { filled = true; break; }
          const f = b.container.querySelector('iframe');
          const body = f && f.contentDocument && f.contentDocument.body;
          if (body && String(body.textContent || '').trim()) { filled = true; break; }
        }
      }
    } else {
      // 选择题/判断题：超星把选择写进 input[name="answerXXX"]，value 是选项字母或 true/false
      // 注意排除 answertype（题型字段），否则每题都会被判成已作答
      const inpVal = readAnswerValue(box);
      if (inpVal !== null) {
        if (inpVal !== '') filled = true;
      } else {
        // 页面没有回传字段时才退到样式判断
        if (box.querySelector('li.cur, li.active, li[class*="cur"]')) filled = true;
      }
    }

    if (!filled) empty.push(i + 1);
  }
  return empty;
}

// 计算还差多少毫秒才满足最短作答时长。抽成纯函数是为了能单测，
// 否则这段逻辑只能靠真等 8 分钟来验证。
function computeMinDurationWait(totalQuestions, secondsPerQuestion, startedAt, now) {
  const requiredMs = totalQuestions * secondsPerQuestion * 1000;
  const elapsedMs = now - startedAt;
  return { requiredMs: requiredMs, elapsedMs: elapsedMs, remainMs: Math.max(0, requiredMs - elapsedMs) };
}

/* ---------- 填空题填入 ----------
 * React 受控组件的 value 不能直接赋值——直接改 input.value 它收不到，
 * 必须走原型上的 setter 再手动派发 input/change 事件。
 */
function setInputValue(input, value) {
  const doc = input.ownerDocument || document;
  const view = doc.defaultView || window;
  const proto = view.HTMLInputElement && view.HTMLInputElement.prototype;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  try {
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
  } catch (e) {
    input.value = value;
  }
  try {
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
  } catch (e) { /* 事件派发失败不影响值本身 */ }
  return input.value === value;
}

/* ---------- 富文本编辑器填入 ----------
 * 超星新版作业页的填空题不是 input，而是 UEditor：
 *   var answerEditor4058890891 = UE.getEditor("answerEditor4058890891", …);
 * 直接改 value 无效，必须走 UE 的 API，或者写进编辑器内部的 iframe。
 */
function setRichText(container, value) {
  const doc = container.ownerDocument || document;
  const win = doc.defaultView || window;

  // 1) UEditor 官方 API，最可靠
  try {
    const edEl = container.querySelector('[id^="answerEditor"]');
    if (edEl && win.UE && typeof win.UE.getEditor === 'function') {
      const ed = win.UE.getEditor(edEl.id);
      if (ed && typeof ed.setContent === 'function') {
        ed.setContent(value);
        // 补一刀：setContent 理论上会触发 contentChange 去同步 #inpDiv，
        // 但实测有版本绑不上。超星提交时读的就是这个容器，空的就等于没答。
        try {
          const hidden = container.querySelector('[id^="inpDiv"]');
          if (hidden && String(hidden.textContent || '').trim() !== String(value).trim()) {
            hidden.innerHTML = value;
          }
        } catch (e) { /* 补写失败不影响主流程 */ }
        return true;
      }
    }
  } catch (e) { /* 落到下面的兜底路径 */ }

  // 2) 直接写编辑器内部 iframe 的 body
  try {
    const frames = Array.from(container.querySelectorAll('iframe'));
    for (const f of frames) {
      const b = f.contentDocument && f.contentDocument.body;
      if (!b) continue;
      b.innerHTML = value;
      const w = f.contentDocument.defaultView || win;
      b.dispatchEvent(new w.Event('input', { bubbles: true }));
      b.dispatchEvent(new w.Event('keyup', { bubbles: true }));
      return true;
    }
  } catch (e) { /* 继续兜底 */ }

  // 3) 超星用来回传答案的隐藏容器
  try {
    const hidden = container.querySelector('[id^="inpDiv"]');
    if (hidden) { hidden.innerHTML = value; return true; }
  } catch (e) { /* 无计可施 */ }

  return false;
}

// 统一填入入口：填空题的目标可能是普通输入框，也可能是富文本编辑器
function fillBlankTarget(target, value) {
  if (!target) return false;
  if (target.kind === 'input' && target.el) return setInputValue(target.el, value);
  if (target.kind === 'richtext' && target.container) return setRichText(target.container, value);
  return false;
}

/* ---------- 主执行器 ---------- */

const Runner = {
  running: false,
  stopFlag: false,
  stats: null,
  doc: (typeof document !== 'undefined' ? document : null),  // 实际答题的文档，可能是 iframe
  unsupported: [],
  obfuscated: null,
  /* 本轮结束后留给外部看的结果。自动刷课靠它判断"这节作业到底做完没有"——
   * 光看 start() 有没有返回是不够的：解析不到题、覆盖率不足、保存失败都会
   * 正常返回，但那都不算做完。
   * status: done（填满且已提交/已保存）| filled（填了但没存）
   *        | incomplete（没填满）| stopped（用户停止）| error（中断） */
  lastResult: null,

  async start() {
    if (this.running) { log('已经在跑了，别重复点', 'warn'); return; }
    this.lastResult = null;
    this._pilotSkipWait = false;
    const cfg = Config.quiz;
    const profile = Config.active();

    if (!profile || !profile.apiKey) {
      log('还没配置 API Key，先点「设置」填一个', 'error');
      this.lastResult = { status: 'error', reason: '没配置 API Key', rate: 0 };
      return;
    }
    if (!profile.baseUrl || !profile.model) {
      log('接口地址或模型名为空，先在「设置」里补全', 'error');
      this.lastResult = { status: 'error', reason: '接口地址或模型名为空', rate: 0 };
      return;
    }

    this.running = true;
    this.stopFlag = false;
    this.stats = { total: 0, answered: 0, skipped: 0, failed: 0, cached: 0, bankHits: 0, startedAt: Date.now() };
    if (typeof QuestionBank !== 'undefined') QuestionBank.reset();
    UI.setStatus('running', '正在解析题目…');

    try {
      // 点按钮时重新定位一次答题文档。用户可能是先开页面再点按钮，
      // 期间 iframe 才加载出来，用初始化时缓存的文档会扑空。
      if (typeof Main !== 'undefined' && Main.resolveQuizDoc) {
        Main.resolveQuizDoc(true);
      }
      const doc = this.doc || document;

      // 字体解码要先建字形表（异步分批，不阻塞界面）。
      // 必须在解析之前完成，否则题目文本还是乱码。
      if (cfg.decodeFont && typeof FontDecoder !== 'undefined' && FontDecoder.available(doc)) {
        UI.setStatus('running', '正在准备字体解码…');
        const ready = await FontDecoder.ensureReady(doc, (t) => UI.setStatus('running', t));
        if (!ready) log('字体解码不可用：' + FontDecoder.failedReason + '，将使用原始文本', 'warn');
        // 对照表没收录的字形：配置了视觉模型就用它认字，识别结果持久化，
        // 以后所有页面遇到同一字形直接查表。没配就按乱码处理（日志会标注哪些题受影响）。
        if (ready && cfg.visionModel && FontDecoder.stats && FontDecoder.stats.missed > 0) {
          log('有 ' + FontDecoder.stats.missed + ' 个字形不在对照表里，用视觉模型识别（' + cfg.visionModel + '）…', 'info');
          const r = await FontDecoder.identifyMissedGlyphs({
            model: cfg.visionModel,
            apiKey: profile.apiKey,
            onProgress: (t) => UI.setStatus('running', '识别字形 ' + t),
          });
          log('字形识别完成：新增 ' + r.identified + ' 个，未识别 ' + r.failed + ' 个' +
            (r.identified ? '（已持久化，下次同字形直接查表）' : ''), r.identified ? 'success' : 'warn');
        }
      }

      const parsed = Parser.parse(doc, { decodeFont: !!cfg.decodeFont });
      const questions = parsed.questions;
      // 提交前要拿它逐题核对页面状态，所以留一份引用
      this.questions = questions;
      this.unsupported = parsed.unsupported || [];
      this.obfuscated = parsed.obfuscated || null;

      if (!questions.length) {
        log('没有解析到题目。点「导出结构」把结果发我，我按你的页面改选择器', 'error');
        UI.setStatus('idle', '未解析到题目');
        this.lastResult = { status: 'incomplete', reason: '没有解析到题目', rate: 0 };
        this.running = false;
        return;
      }

      this.stats.total = questions.length;
      UI.setStatus('running', '共 ' + questions.length + ' 题，正在请求答案…');

      if (this.unsupported.length) {
        log('⚠️ 卷面含脚本不支持的题型：' + this.unsupported.join('、'), 'warn');
        log('这些题脚本不会作答，本次也不会自动提交，避免交上一张空着这些题的卷子', 'warn');
      }

      // 字体加密会让模型看到乱码，这解释了为什么低置信度的题那么多。
      // 但解码成功时不能再说这句——否则用户会以为解码没生效（v0.7.2 就出现
      // 「已还原 60 道题」和「模型读到乱码」两条日志同时打出来的矛盾）。
      const decodedCount = parsed.decoded || 0;
      if (this.obfuscated && decodedCount === 0) {
        log('⚠️ 检测到页面启用了字体加密（.font-cxsecret，共 ' + this.obfuscated.count + ' 处）', 'warn');
        log('   DOM 里的文字被替换过，模型读到的是「' + this.obfuscated.sample + '」这种乱码，', 'warn');
        log('   部分题可能因语义不清楚被跳过。题干里的生僻字多是字形替换，模型会尝试按上下文推断', 'warn');
      } else if (this.obfuscated && decodedCount > 0) {
        log('字体加密已解码：' + decodedCount + ' 道题的题干被还原成正常文字', 'success');
      }

      // 分页作业只处理当前页。与其默默漏掉后面的题，不如明确告诉用户要逐页跑。
      if (findButtonByText(['下一题', '下一页', '下一部分'], doc)) {
        log('检测到「下一题」按钮，这份作业可能是分页的。本脚本只处理当前页，做完请翻页再点一次', 'warn');
      }

      const profileConf = Object.assign({}, cfg);

      // 第一阶段：并发取答案
      const solved = await runPool(questions, cfg.concurrency, async (q, i) => {
        if (this.stopFlag) return { skipped: 'stopped' };

        const hit = AnswerCache.get(q);
        if (hit) {
          this.stats.cached++;
          return { q: q, ans: hit, match: matchAnswer(q, hit), cached: true };
        }

        // 题库优先：查表拿到的是标准答案，比模型推理准，也不消耗 token。
        // 查不到再往下走模型，两级策略。
        const bankCfg = Config.bank;
        if (bankCfg && bankCfg.enabled && typeof QuestionBank !== 'undefined'
            && !QuestionBank.disabled && !this.stopFlag) {
          const bankAns = await QuestionBank.lookup(q, bankCfg);
          if (this.stopFlag) return { skipped: 'stopped' };
          if (bankAns) {
            const bankMatch = matchAnswer(q, bankAns);
            if (bankMatch) {
              QuestionBank.hits++;
              this.stats.bankHits++;
              AnswerCache.set(q, bankAns);
              return { q: q, ans: bankAns, match: bankMatch, fromBank: true };
            }
            // 题库有答案但和页面选项对不上，说明题库里存的是另一版题目。
            // 这种情况必须丢弃——硬填等于瞎选。
            log('题库答案和选项对不上，改用模型：' + truncateText(q.stem, 24), 'warn');
          }
        }

        // 请求之间插入随机间隔，既降速避免 429，也让流量看起来不像机器批量打
        await sleep(randInt(120, 480));

        if (this.stopFlag) return { skipped: 'stopped' };

        try {
          const ans = await answerWithRetry(q, profile, profileConf, 1);
          // D: 置信度低于阈值视为"没把握"，缓存也存，但本次不填
          AnswerCache.set(q, ans);
          return { q: q, ans: ans, match: matchAnswer(q, ans) };
        } catch (e) {
          if (e.kind === 'auth' || e.kind === 'config') {
            this.stopFlag = true;
            throw e; // 密钥类错误必须立刻中止，不然会白白刷一堆 401
          }
          if (e.kind === 'quota') {
            this.stopFlag = true;
            throw e;
          }
          return { q: q, error: e };
        }
      });

      if (this.stopFlag) {
        const firstErr = solved.find((r) => r && r.error);
        log('已中止：' + (firstErr && firstErr.error ? firstErr.error.message : '手动停止'), 'error');
      }

      // 第二阶段：串行填入
      UI.setStatus('running', '正在填入答案…');
      for (let i = 0; i < solved.length; i++) {
        const r = solved[i];
        if (!r || r.skipped) { this.stats.skipped++; continue; }
        const q = r.q;

        if (r.error) {
          this.stats.failed++;
          log('第 ' + (i + 1) + ' 题请求失败：' + r.error.message, 'warn');
          continue;
        }

        // 填空题没有选项，直接写输入框，不能走下面的选项匹配分支
        if (q.type === 'blank') {
          const vals = (r.ans && r.ans.text) || [];
          if (r.ans.confidence < cfg.minConfidence) {
            this.stats.skipped++;
            log('第 ' + (i + 1) + ' 题（填空）把握不足，跳过', 'warn');
            continue;
          }
          if (!vals.length) {
            this.stats.skipped++;
            log('第 ' + (i + 1) + ' 题（填空）模型没给出答案，跳过', 'warn');
            continue;
          }
          let filled = 0;
          for (let bi = 0; bi < q.blanks.length; bi++) {
            const v = vals[bi];
            if (!v) continue;
            if (fillBlankTarget(q.blanks[bi], v)) filled++;
          }
          if (filled) {
            this.stats.answered++;
            log('第 ' + (i + 1) + ' 题 ✓ 填空 → ' + vals.join(' / '), 'success');
          } else {
            this.stats.failed++;
            log('第 ' + (i + 1) + ' 题（填空）写入未生效', 'warn');
          }
          await sleep(randInt(cfg.fillDelayMin, cfg.fillDelayMax));
          continue;
        }

        if (!r.match) {
          // 猜题兜底（学原脚本的 randomDo）：模型没答案时按题型猜一个默认值。
          // 空着提交 = 那题 0 分；猜一个 = 至少有概率得分，而且覆盖率能到提交门槛。
          // 日志里明确标注"猜的"，用户可以回头改。
          if (cfg.guessOnMiss) {
            const guess = this.makeGuess(q);
            if (guess) {
              r.match = { options: guess };
              log('第 ' + (i + 1) + ' 题没有匹配到答案，按默认猜测（可在页面上改）', 'warn');
            }
          }
          if (!r.match) {
            this.stats.skipped++;
            log('第 ' + (i + 1) + ' 题没有匹配上选项，跳过（' + truncateText(q.stem) + '）', 'warn');
            continue;
          }
        }
        if (r.ans.confidence < cfg.minConfidence) {
          // 照原脚本精神：从不空着。模型没把握也比空着强——空着必错，
          // 填了还有概率对，而且覆盖率能到提交门槛。日志标明让用户可复核。
          log('第 ' + (i + 1) + ' 题把握不足（置信度 ' + r.ans.confidence.toFixed(2) + '），仍填入答案，可在页面上改', 'warn');
          // 把握不足时顺手查一下题干是否残留加密字符：模型读到的乱码
          // 正是低把握的常见来源——你屏幕上显示的是正常字（字体渲染回的），
          // 但 DOM 里发给模型的是乱码。检测出来你就能人工复核这题。
          if (typeof findSuspiciousChars === 'function') {
            const sus = findSuspiciousChars(q.stem + ' ' + q.options.map((o) => o.text || '').join(' '));
            if (sus.length) {
              log('   该题文本仍含 ' + sus.length + ' 个未还原的加密字符（' + sus.slice(0, 6).join(' ') +
                '），模型读到的就是这种乱码——建议人工复核这题', 'error');
            }
          }
        }

        // 单选题/判断题只点一个；多选题要把该点的点上、不该点的点掉
        const wantedSet = new Set(r.match.options);
        const fillOnce = async () => {
          let allOk = true;
          for (const opt of q.options) {
            if (!setOptionState(opt, wantedSet.has(opt), q.container)) allOk = false;
            await sleep(randInt(30, 90));
          }
          return allOk;
        };

        let ok = await fillOnce();

        // 点完再按超星自己的答案字段核一遍。
        // 这一步是为了兜住"点了但没生效"和"把已选的点掉了"两种情况：
        // 定制组件点两下会 toggle，一旦状态判断失误，答案就被点没了。
        let verified = verifyChoiceValue(q, r.match.options);
        if (verified === false) {
          log('第 ' + (i + 1) + ' 题填后状态不对，重试一次', 'warn');
          await sleep(200);
          ok = await fillOnce();
          verified = verifyChoiceValue(q, r.match.options);
        }
        if (verified === false) ok = false;
        if (ok) {
          this.stats.answered++;
          // 判断题显示选项原文（"正确/错误"），选择题显示字母，否则日志里 "→ B" 会让人误以为是单选
          const shown = q.type === 'judge'
            ? (r.match.options[0] ? r.match.options[0].text : '')
            : r.match.options.map((o) => o.key).join('');
          // 标清答案来源：题库/缓存是"标准答案"，模型是"推理结果"，两者可信度不同
          const src = r.fromBank ? '题库' : (r.cached ? '缓存' : '模型 ' + r.ans.confidence.toFixed(2));
          log('第 ' + (i + 1) + ' 题 ✓ ' + truncateText(q.stem) + ' → ' + shown + '（' + src + '）', 'success');
        } else {
          this.stats.failed++;
          log('第 ' + (i + 1) + ' 题点击未生效，可能是页面结构不匹配', 'warn');
        }

        // 每题之间停顿，模拟人类作答节奏
        await sleep(randInt(cfg.fillDelayMin, cfg.fillDelayMax));
      }

      // 提交/保存之前先满足最短作答时长，避免"进入页面几十秒就交卷"这种最明显的机器特征
      await this.enforceMinDuration(cfg);

      AnswerCache.flush();
      await this.finish(cfg);
    } catch (e) {
      log('运行中断：' + e.message, 'error');
      UI.setStatus('error', '运行中断');
    } finally {
      this.running = false;
    }
  },

  /**
   * 把作答总时长补到下限。
   *
   * 为什么要有这一步：脚本填 20 道选择题只要几十秒，真人要 6~12 分钟。
   * "进入作业页到提交"的间隔是最容易计算、误判率最低的机器特征，
   * 假设超星要查行为，这是首选指标。这里用最笨也最有效的办法消掉它：等。
   *
   * 计时起点是页面加载时刻而非点按钮时刻，因为用户可能早就打开页面看了一会儿，
   * 那段时间超星一样算在内。
   */
  async enforceMinDuration(cfg) {
    // 自动刷课路径下不做等待：60 题 × 25 秒 = 25 分钟干等，用户明确要求直接跳。
    // 手动点「开始答题」时按配置来（设置里可开）。
    if (this._pilotSkipWait) {
      log('自动刷课模式：跳过最短作答时长等待', 'info');
      return;
    }
    if (!cfg.enforceMinDuration || !cfg.minSecondsPerQuestion) return;

    const plan = computeMinDurationWait(this.stats.total, cfg.minSecondsPerQuestion, PAGE_STARTED_AT, Date.now());
    const remainMs = plan.remainMs;

    if (remainMs <= 0) {
      log('作答时长 ' + formatDuration(plan.elapsedMs) + '，已满足 ' + this.stats.total +
        ' 题 × ' + cfg.minSecondsPerQuestion + ' 秒的要求', 'info');
      return;
    }

    log('为避免作答时长过短，还需等待 ' + formatDuration(remainMs) +
      '（要求 ' + this.stats.total + ' 题 × ' + cfg.minSecondsPerQuestion + ' 秒 = ' +
      formatDuration(plan.requiredMs) + '）', 'warn');
    UI.setStatus('running', '等待时长补足 ' + formatDuration(remainMs));

    // 分片等待，每 60 秒报一次进度，同时保持对"停止"和"跳过等待"的响应
    const deadline = Date.now() + remainMs;
    let nextReport = remainMs - 60000;
    this.waiting = true;
    this.skipWaitFlag = false;
    try {
      while (Date.now() < deadline) {
        if (this.stopFlag) { log('已停止等待，不会提交', 'warn'); return; }
        if (this.skipWaitFlag) {
          log('已跳过剩余等待，直接进入提交/保存环节', 'warn');
          return;
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        if (left <= nextReport) {
          log('剩余等待 ' + formatDuration(left) + '（不想等就点「跳过等待」）', 'info');
          nextReport -= 60000;
        }
        await sleep(Math.min(5000, left));
      }
    } finally {
      this.waiting = false;
      this.skipWaitFlag = false;
    }
    log('作答时长已补足，继续', 'success');
  },

  /** 跳过剩余的最短作答时长等待。只在等待阶段有效，不改变"要不要提交" */
  skipWait() {
    if (!this.waiting) {
      log('当前不在等待中，无需跳过', 'info');
      return;
    }
    this.skipWaitFlag = true;
  },

  /**
   * 提交后等结果。原脚本靠页面跳转到 selectWorkQuestionYiPiYue（已批阅页）
   * 确认提交成功——跳了就是交上了，不跳就是没交上。
   * 之前"调了提交函数就算 done"，自动刷课拿着假 done 去跳节，
   * 作业实际没交，下一节还是同一份卷子。
   */
  verifySubmitted(doc, seconds) {
    const d = doc || this.doc || document;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.stopFlag) return resolve(false);
        try {
          const href = d.location ? String(d.location.href) : '';
          if (/selectWorkQuestionYiPiYue|workReView|reVersionPaperMark|work\/view/.test(href)) return resolve(true);
        } catch (e) { /* 忽略 */ }
        try {
          if (!d.querySelectorAll('.Py-mian1, .TiMu').length) return resolve(true);   // 题目容器没了 = 页面已切换
          if (/提交成功/.test(d.body ? d.body.textContent : '')) return resolve(true);
        } catch (e) { /* 忽略 */ }
        if (Date.now() - t0 > (seconds || 15) * 1000) return resolve(false);
        setTimeout(tick, 1500);
      };
      tick();
    });
  },

  /** 猜题兜底：模型没答案时按题型给一个默认答案（学原脚本的 randomDo）。
   *  单选选 B、多选全选、判断选"错"——和原脚本同款。
   *  @returns {Array<Element>|null} 选中的选项元素 */
  makeGuess(q) {
    if (!q || !q.options || !q.options.length) return null;
    if (q.type === 'multi') return q.options.slice();                       // 多选：全选
    if (q.type === 'judge') {
      const wrong = q.options.find((o) => /错|否|×|✗|false/i.test(o.text || ''));
      return wrong ? [wrong] : null;                                        // 判断：选"错"
    }
    const b = q.options.find((o) => o.key === 'B');
    return b ? [b] : (q.options[1] || q.options[0] ? [q.options[1] || q.options[0]] : null);  // 单选：B
  },

  async finish(cfg) {
    const s = this.stats;
    const rate = s.total ? (s.answered / s.total) * 100 : 0;
    const elapsed = Math.round((Date.now() - s.startedAt) / 1000);

    // 先给一个保守的默认值，后面每个分支再按实际情况覆盖。
    // 外部（自动刷课）只认 status === 'done'。
    this.lastResult = { status: 'incomplete', reason: '未判定', rate: rate, saved: false, submitted: false };

    log('——— 本轮结束 ———', 'info');
    log('共 ' + s.total + ' 题，填入答案 ' + s.answered + ' 题，跳过 ' + s.skipped + ' 题，失败 ' + s.failed +
      ' 题，缓存命中 ' + s.cached + ' 题，题库命中 ' + (s.bankHits || 0) + ' 题，耗时 ' + elapsed + ' 秒', 'info');
    // 注意：这里的"覆盖率"是"成功填入答案的比例"，不是正确率。
    // 模型答得对不对脚本无从得知，能保证的只有"每题都填了"。
    log('作答覆盖率 ' + rate.toFixed(1) + '%（这是填写比例，不是正确率）', 'info');

    const doc = this.doc || document;

    // 无论以何种方式结束（正常跑完 / 手动停止 / 有未支持题型），
    // 只要填进过答案就先保存。之前的实现把 stopFlag 的 return 放在保存之前，
    // 用户一点停止就什么都保不住——这是实打实的 bug。
    if (this.stopFlag) {
      log('已停止，正在保存已填写的答案（不会提交）', 'warn');
      const saved = await this.trySave(doc, cfg);
      UI.setStatus('error', saved ? '已停止（已保存）' : '已停止（未保存）');
      this.lastResult = { status: 'stopped', reason: '你点了停止', rate: rate, saved: saved, submitted: false };
      return;
    }

    // 卷面有脚本处理不了的题型时，绝不自动提交。
    // 覆盖率是按"脚本认识的题"算的，填空题全空也能算出 100%，
    // 这时候提交等于交一张缺题的卷子。宁可留着让你手动补。
    if (this.unsupported.length) {
      log('卷面含脚本写不进的题型：' + this.unsupported.join('、'), 'warn');
      const saved = await this.trySave(doc, cfg);
      const outcome = decideAfterSave(saved, cfg, rate, this.unsupported);
      if (outcome.status === 'done') {
        // 原脚本同款：对填空/简答这类它处理不了的题，不答、保存、继续下一章。
        // 这类题的答案留在页面上，想补随时回来补。
        log('已保存。按原脚本行为：保存即视为本节作业完成，继续刷课', 'info');
        UI.setStatus('done', '已保存（' + this.unsupported.join('、') + '待手动补），继续');
      } else {
        UI.setStatus('warn', saved ? '已保存（待手动补题）' : '已填写（未提交）');
      }
      this.lastResult = outcome;
      return;
    }

    if (rate >= cfg.minAnswerRate) {
      if (cfg.autoSubmit) {
        // 提交前先照超星的口径核对一遍页面状态。
        // 覆盖率是脚本自己算的（"我填了 60 题"），超星看的是它自己的字段；
        // 两者不一致时提交会被拒，页面还可能被重置，答案全丢。
        const all = this.questions || [];
        const notFilled = auditAnswerState(all);
        // 全部题都判成"没填"，多半是超星改了字段名、核对方法失效，而不是真的全空。
        // 这种情况必须放行，否则会永远卡在"不提交"。
        const auditBroken = all.length > 0 && notFilled.length === all.length && (this.stats.answered || 0) > 0;
        if (auditBroken) {
          log('提交前核对失效（' + all.length + ' 题全部识别不到答案），' +
            '可能是超星改了字段名。已跳过核对直接提交', 'warn');
        } else if (notFilled.length) {
          log('提交前核对：第 ' + formatRanges(notFilled) + ' 题在页面上没有留下答案，' +
            '超星会判定为未完成', 'error');
          log('已改为保存、不提交。多半是填空题没被编辑器接受，或者选项没真正选中', 'warn');
          const saved = await this.trySave(doc, cfg);
          UI.setStatus('warn', saved ? '已保存（' + notFilled.length + ' 题异常）' : '有题未完成，未提交');
          return;
        }

        const btn = findButtonByText(SUBMIT_TEXTS, doc);
        if (!btn) {
          log('找不到提交按钮，先帮你把答案存下来。如果页面上确实有提交按钮，把它的文字告诉我', 'error');
          const saved = await this.trySave(doc, cfg);
          UI.setStatus('warn', saved ? '已保存（未提交）' : '找不到提交按钮');
          this.lastResult = {
            status: saved ? 'done' : 'filled',
            reason: saved ? '只保存了，没找到提交按钮' : '找不到提交按钮',
            rate: rate, saved: saved, submitted: false,
          };
          return;
        }
        UI.setStatus('running', '正在提交…');
        const guard = (m) => !UNSAFE_CONFIRM.test(m);

        // 优先调页面自带的提交函数：不经过按钮，也不会被"未完成"确认框卡住，
        // 该拦的由 guard 拦。原脚本走的就是 submitCheckTimes()。
        const pageFn = findPageFn(doc, SUBMIT_FNS);
        if (pageFn) {
          const lr = await callWithGuard(pageFn.win, guard, () => pageFn.fn.call(pageFn.win));
          if (lr.blocked) {
            log('超星不认可这次提交：' + lr.msg, 'error');
            log('已取消提交并保存。强行提交只会被它打回来，还可能把页面重置掉', 'warn');
            const savedFn = await this.trySave(doc, cfg);
            UI.setStatus('warn', savedFn ? '已保存（未提交）' : '已填写（未提交）');
            this.lastResult = {
              status: savedFn ? 'done' : 'incomplete',
              reason: '超星判定未完成：' + lr.msg,
              rate: rate, saved: savedFn, submitted: false,
            };
            return;
          }
          if (!lr.error) {
            // 调了提交函数 ≠ 提交成功。submitCheckTimes 内部可能走异步校验、
            // 弹确认、或服务端拒收——之前"调用完就算 done"，自动刷课拿着假的
            // done 去跳节，作业实际没交，下一节还是同一份卷子。
            // 验证信号照原脚本：提交成功后页面会跳到已批阅页，或题目容器消失。
            log('已调用页面自带的 ' + pageFn.name + '() 提交，等待提交结果…', 'info');
            const okSubmit = await this.verifySubmitted(doc);
            if (okSubmit) {
              log('提交成功（页面已跳到批阅页/题目已清空）', 'success');
              UI.setStatus('done', '已提交');
              this.lastResult = { status: 'done', reason: '', rate: rate, saved: false, submitted: true };
            } else {
              log('15 秒内没有收到提交成功的信号（页面没跳转，题目还在）。按未提交处理', 'error');
              log('不要留在这一节硬等——先手动确认作业是否真的提交了', 'warn');
              const savedFn = await this.trySave(doc, cfg);
              UI.setStatus('warn', '提交结果未知，已尝试保存');
              this.lastResult = {
                status: savedFn ? 'filled' : 'incomplete',
                reason: '调用了提交函数但 15 秒内未见成功信号',
                rate: rate, saved: savedFn, submitted: false,
              };
            }
            return;
          }
          log('调用 ' + pageFn.name + '() 出错：' + lr.error.message + '，改用点按钮', 'warn');
        }

        // 兜底：点提交按钮
        const r = await clickWithConfirm(btn, { guard: guard });
        if (r.blocked) {
          log('超星不认可这次提交：' + r.msg, 'error');
          log('已取消提交并保存。强行提交只会被它打回来，还可能把页面重置掉', 'warn');
          const saved2 = await this.trySave(doc, cfg);
          UI.setStatus('warn', saved2 ? '已保存（未提交）' : '已填写（未提交）');
          this.lastResult = {
            status: saved2 ? 'done' : 'incomplete',
            reason: '超星判定未完成：' + r.msg,
            rate: rate, saved: saved2, submitted: false,
          };
          return;
        }
        log('已点击提交，等待提交结果…', 'info');
        const okSubmitBtn = await this.verifySubmitted(doc);
        if (okSubmitBtn) {
          log('提交成功（页面已跳到批阅页/题目已清空）', 'success');
          UI.setStatus('done', '已提交');
          this.lastResult = { status: 'done', reason: '', rate: rate, saved: false, submitted: true };
        } else {
          log('15 秒内没有收到提交成功的信号。按未提交处理', 'error');
          const saved3 = await this.trySave(doc, cfg);
          UI.setStatus('warn', '提交结果未知，已尝试保存');
          this.lastResult = {
            status: saved3 ? 'filled' : 'incomplete',
            reason: '点了提交按钮但 15 秒内未见成功信号',
            rate: rate, saved: saved3, submitted: false,
          };
        }
      } else {
        // 就算不提交，也照超星口径核对一遍：把可能被判"未完成"的题先告诉用户，
        // 免得他手动点提交时又被打回来。
        // 全部题都判成空 = 字段名对不上、核对方法失效，这种情况别报，否则天天误报。
        const allQ = this.questions || [];
        const notFilled2 = auditAnswerState(allQ);
        const auditBroken2 = allQ.length > 0 && notFilled2.length === allQ.length;
        if (!auditBroken2 && notFilled2.length) {
          log('提醒：第 ' + formatRanges(notFilled2) + ' 题在页面上找不到答案，超星会算未完成', 'warn');
        }
        if (cfg.autoSave) {
          log('已填完，正在保存…', 'warn');
          const saved = await this.trySave(doc, cfg);
          UI.setStatus('done', saved ? '已填完并保存（未提交）' : '已填完（未保存）');
          this.lastResult = {
            status: saved ? 'done' : 'filled',
            reason: saved ? '已保存，未提交' : '保存失败',
            rate: rate, saved: saved, submitted: false,
          };
        } else {
          // manual 档：一个按钮都不点，把决定权完全交回用户
          log('已填完。按你的设置，脚本不自动保存也不提交，答案只在这个页面上', 'warn');
          log('检查完请自己点「暂时保存」或「提交」。离开或刷新页面，答案会丢', 'warn');
          UI.setStatus('done', '已填完（等你手动提交）');
          this.lastResult = {
            status: 'filled',
            reason: '设置为「只填不存」，答案没保存到服务器',
            rate: rate, saved: false, submitted: false,
          };
        }
      }
      return;
    }

    log('覆盖率 ' + rate.toFixed(1) + '% 未达 ' + cfg.minAnswerRate + '% 的提交门槛，先保存', 'warn');
    const saved = await this.trySave(doc, cfg);
    const outcome = decideAfterSave(saved, cfg, rate, null);
    if (outcome.status === 'done') {
      // 原脚本同款行为：autoSave 开着时，保存成功就把这份作业标记为完成，
      // 刷课继续下一章——它从不因为覆盖率不足而卡住整个流程。
      // 没填满的题（通常是填空/简答这类脚本写不进的题型）答案还留在页面上，
      // 随时可以回来手动补。之前这里按"未完成"处理，导致保存后停在原地。
      log('已保存。按原脚本行为：保存即视为本节作业完成，继续刷课', 'info');
      log('没填上的 ' + (100 - rate).toFixed(1) + '% 多为脚本写不进的题型，可在页面上手动补', 'info');
      UI.setStatus('done', '已保存（未提交），继续');
    } else {
      UI.setStatus('warn', saved ? '已保存（未提交）' : '已填写（未保存）');
    }
    this.lastResult = outcome;
  },

  /**
   * 点「暂时保存」。任何结束路径都会走这里，保证填过的答案不会因为
   * 用户点了停止或者覆盖率不达标而丢掉。
   * @returns {Promise<boolean>} 是否成功点了保存
   */
  async trySave(doc, cfg) {
    if (!cfg.autoSave) {
      log('按当前设置脚本不自动保存，答案只在页面上，别刷新页面', 'warn');
      return false;
    }
    if (!this.stats || !this.stats.answered) {
      log('没有填入任何答案，无需保存', 'info');
      return false;
    }

    // 1) 优先调页面自带的保存函数——原脚本用的就是这条路（noSubmit），
    //    比点按钮可靠：不怕按钮文案变，也不经过确认框那一层。
    const pageFn = findPageFn(doc, SAVE_FNS);
    if (pageFn) {
      const r = await callWithGuard(pageFn.win, null, () => pageFn.fn.call(pageFn.win));
      if (!r.error) {
        log('已调用页面自带的 ' + pageFn.name + '() 保存答案', 'success');
        return true;
      }
      log('调用 ' + pageFn.name + '() 出错：' + r.error.message + '，改用点按钮', 'warn');
    }

    // 2) 退而点按钮
    const btn = findButtonByText(SAVE_TEXTS, doc);
    if (!btn) {
      log('找不到保存按钮，也没找到页面自带的保存函数（试过 ' + SAVE_FNS.join('/') + '）', 'warn');
      log('把「导出诊断」的结果发我，我按你的页面补上', 'warn');
      return false;
    }
    await clickWithConfirm(btn);
    log('已点击「' + (btn.textContent || '').trim() + '」，答案已保存到服务器', 'success');
    return true;
  },

  stop() {
    this.stopFlag = true;
    log('收到停止指令，当前题目处理完就停', 'warn');
  },

  // 只解析不答题，用来验证选择器是否适配当前页面
  /**
   * 诊断：把「保存/提交为什么没生效」需要的信息一次性打出来。
   *
   * 排查这类问题最缺的是现场数据——页面上到底有哪些按钮、挂没挂
   * noSubmit/submitCheckTimes 这类函数、每道题的答案落在哪个字段里。
   * 与其反复猜，不如让用户点一下就导出来。
   */
  diagnose() {
    const doc = this.doc || document;
    const win = winOf(doc);
    const lines = [];

    lines.push('=== 文档 ===');
    let href = '(取不到)';
    try { href = doc.location ? doc.location.href : href; } catch (e) { /* 忽略 */ }
    lines.push('URL: ' + href);
    lines.push('是 iframe 子文档: ' + (doc !== document ? '是' : '否'));
    lines.push('Runner.doc 是否已定位: ' + (this.doc ? '是' : '否'));

    lines.push('');
    lines.push('=== 页面函数探测 ===');
    const fnNames = SAVE_FNS.concat(SUBMIT_FNS);
    lines.push('  [当前文档所在的 window]');
    for (const n of fnNames) {
      let t = 'undefined';
      try { t = typeof win[n]; } catch (e) { t = '访问异常'; }
      lines.push('    ' + n + ' = ' + t);
    }
    lines.push('  [顶层 window]');
    for (const n of fnNames) {
      let t = 'undefined';
      try { t = typeof pageWin[n]; } catch (e) { t = '访问异常'; }
      if (t !== 'undefined') lines.push('    ' + n + ' = ' + t);
    }

    lines.push('');
    lines.push('=== 可见按钮（文字 ≤ 16 字）===');
    try {
      const all = doc.querySelectorAll('button, a, input[type=submit], div[role=button], span, div');
      let n = 0;
      for (const el of all) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || '').replace(/\s+/g, '').trim();
        if (!t || t.length > 16) continue;
        if (el.querySelector('button, a, input')) continue;
        const cls = (typeof el.className === 'string' && el.className.trim())
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        lines.push('  "' + t + '"  <' + el.tagName.toLowerCase() + cls + '>');
        if (++n >= 40) { lines.push('  …'); break; }
      }
      if (!n) lines.push('  （一个都没找到）');
    } catch (e) {
      lines.push('  遍历失败：' + e.message);
    }

    lines.push('');
    lines.push('=== 每题在页面上的落点（前 20 题）===');
    let qs = this.questions || [];
    if (!qs.length) {
      // 还没跑过答题时，主动在所有 iframe（含深层）里找一次题目。
      // 只看顶层文档的话，作业藏在 iframe 深处时会得出"没有题"的错误结论。
      try {
        if (typeof Parser !== 'undefined' && typeof Main !== 'undefined' && Main.collectDocs) {
          for (const d of Main.collectDocs()) {
            try {
              const r = Parser.parse(d, { decodeFont: false });
              if (r.questions.length) { qs = r.questions; break; }
            } catch (e) { /* 忽略 */ }
          }
        }
      } catch (e) { /* 忽略 */ }
      if (!qs.length) lines.push('  （整个页面含 iframe 都没解析到题目）');
      else lines.push('  （从 iframe 深处解析到 ' + qs.length + ' 题）');
    }
    qs.slice(0, 20).forEach((q, i) => {
      const box = q.container;
      let s = '  #' + (i + 1) + ' [' + q.type + '] ';
      if (!box) { lines.push(s + '无容器引用'); return; }
      if (q.type === 'blank') {
        const div = box.querySelector('[id^="inpDiv"]');
        const f = box.querySelector('iframe');
        let body = null;
        try { body = f && f.contentDocument && f.contentDocument.body; } catch (e) { body = null; }
        s += 'inpDiv="' + (div ? String(div.textContent || '').trim().slice(0, 16) : '无') + '"';
        s += ' editorBody="' + (body ? String(body.textContent || '').trim().slice(0, 16) : '无') + '"';
        s += ' 有UEditor=' + (box.querySelector('[id^="answerEditor"]') ? '是' : '否');
      } else {
        const inp = box.querySelector('input[name^="answer"]');
        s += 'input[' + (inp ? inp.name : '无') + ']="' + (inp ? String(inp.value || '') : '') + '"';
        s += ' 选中样式=' + (box.querySelector('li.cur, li.active, li[class*="cur"]') ? '有' : '无');
      }
      lines.push(s);
    });

    const notFilled = auditAnswerState(qs);
    lines.push('');
    lines.push('=== 自检结论 ===');
    lines.push('  题目总数: ' + qs.length);
    lines.push('  页面上找不到答案的题: ' + (notFilled.length ? formatRanges(notFilled) : '无'));

    // 本节任务清单：课程页上答题文档通常还不存在，但清单是现成的。
    // 「这节能不能自动处理」看这段就知道。
    try {
      if (typeof CoursePilot !== 'undefined' && CoursePilot.findMarg) {
        const marg = CoursePilot.findMarg(window);
        if (marg) {
          const tasks = CoursePilot.parseTasks(marg);
          const nm = (it) => (it.property && (it.property.name || it.property.title)) || '(无名)';
          lines.push('');
          lines.push('=== 本节任务清单（来自 mArg）===');
          lines.push('  待办：视频 ' + tasks.videos.length + '、文档 ' + tasks.documents.length +
            '、作业 ' + tasks.works.length + '；已完成任务点 ' +
            (tasks.totalJobs - tasks.videos.length - tasks.documents.length - tasks.works.length) + ' 个');
          for (const v of tasks.videos) lines.push('    [视频] ' + nm(v) + (v.isPassed ? '（已完成）' : ''));
          for (const d2 of tasks.documents) lines.push('    [文档] ' + nm(d2) + (d2.isPassed ? '（已完成）' : ''));
          for (const wk of tasks.works) lines.push('    [作业] ' + nm(wk) + (wk.isPassed ? '（已完成）' : ''));
        } else {
          // 找不到清单时，把每个文档的 script 情况列出来——
          // 下次排查格式差异就有第一手信息了
          lines.push('  未找到任务清单（mArg）。各文档的 script 情况：');
          try {
            if (typeof Main !== 'undefined' && Main.collectDocs) {
              for (const d of Main.collectDocs()) {
                let n = 0, has = false, href = '(嵌套文档)';
                try {
                  n = d.querySelectorAll('script').length;
                  has = Array.from(d.querySelectorAll('script')).some(
                    (s) => (s.textContent || '').indexOf('mArg') >= 0);
                } catch (e) { /* 忽略 */ }
                try { if (d.location && d.location.href) href = d.location.href.slice(0, 70); } catch (e) { /* 忽略 */ }
                lines.push('    ' + href + ' → script ' + n + ' 个，含 mArg 字样: ' + (has ? '是' : '否'));
              }
            }
          } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) { /* 附加失败不影响主体 */ }

    return lines.join('\n');
  },

  preview() {
    if (typeof Main !== 'undefined' && Main.resolveQuizDoc) Main.resolveQuizDoc(true);
    const doc = this.doc || document;
    const parsed = Parser.parse(doc, { decodeFont: !!Config.quiz.decodeFont });
    if (!parsed.questions.length) {
      log('没解析到题目', 'error');
      return;
    }
    log('解析到 ' + parsed.questions.length + ' 题，前 3 题预览：', 'info');
    if (parsed.unsupported.length) {
      log('⚠️ 不支持的题型：' + parsed.unsupported.join('、'), 'warn');
    }
    parsed.questions.slice(0, 3).forEach((q, i) => {
      log('#' + (i + 1) + ' [' + q.type + '] ' + truncateText(q.stem, 60), 'info');
      q.options.forEach((o) => log('    ' + o.key + '. ' + truncateText(o.text, 50), 'info'));
      if (q.blanks) log('    （' + q.blanks.length + ' 个空）', 'info');
    });
  },
};

function truncateText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const max = n || 32;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// 把毫秒转成"X 分 Y 秒"，用于日志里展示等待时长
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return s + ' 秒';
  return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
}
