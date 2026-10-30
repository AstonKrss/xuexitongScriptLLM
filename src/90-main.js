/* ============================================================
 * 90-main.js —— 入口、框架探测与路由
 *
 * 关键背景：超星的章节测验**不在顶层文档里**。
 * 你看到的 mooc1.chaoxing.com/mycourse/studentstudy?... 是课程学习页，
 * 测验内容渲染在页面内部的 iframe 里。只查顶层 document 的输入框数量，
 * 永远会得到 0，然后误判成"不是答题页"。
 *
 * 因此这里要做三件事：
 *   1. 遍历同源 iframe，找出真正装着题目的那个文档；
 *   2. 顶层统一挂面板并驱动子文档，避免每个 iframe 各弹一个悬浮球；
 *   3. iframe 可能晚于脚本加载，所以要多次重试探测。
 * ============================================================ */

const Main = {
  quizDoc: null,
  quizKind: 'other',
  _uiMounted: false,

  init() {
    if (window.__llmQuizLoaded) return;
    window.__llmQuizLoaded = true;

    console.log('[超星答题助手] v' + VERSION + ' 已加载', location.href);

    if (!hasGM) {
      try {
        alert('[超星答题助手] 当前脚本管理器没有提供 GM_xmlhttpRequest，无法调用大模型接口。\n请换用 脚本猫 / Tampermonkey / Violentmonkey。');
      } catch (e) { /* 页面禁用 alert 时忽略，控制台已有记录 */ }
      return;
    }

    const isTop = (window === window.top);
    // 子框架且顶层同源时，本框架不挂 UI：顶层的面板会直接操作这里的 DOM。
    // 否则一张卷子会冒出两个悬浮球，用户点哪个都不知道。
    if (!isTop && this.canAccessTop()) {
      window.__llmQuizChild = true;
      return;
    }

    UI.mount();
    this._uiMounted = true;

    // 自动刷课的续跑：超星点目录节点常常整页重载，靠 sessionStorage 接上
    if (isTop && typeof CoursePilot !== 'undefined') {
      try { CoursePilot.maybeResume(); } catch (e) { /* 忽略 */ }
    }

    const configured = this.refreshConfigState();
    if (!configured) {
      log('还没配置 API Key，点下面的「设置」填一个就能用了', 'warn');
      if (isTop) UI.openSettings();
    }

    // 首次使用：打开项目主页（一次性，之后 GM 存储记住不再弹）
    if (isTop) openRepoOnce();

    this.startProbing();
  },

  /** 顶层文档是否可访问（跨域会抛 SecurityError） */
  canAccessTop() {
    try {
      return !!(window.top && window.top.document && window.top.document.documentElement);
    } catch (e) {
      return false;
    }
  },

  /**
   * 收集当前窗口以及所有同源 iframe 的 document。
   * 嵌套 iframe 递归四层——实测的作业结构是：
   *   顶层 studentstudy → knowledge/cards → 作业 iframe → （部分课程还有一层）
   * 之前只递归两层，作业 iframe 里面的内容就摸不到了，探测必然扑空。
   */
  collectDocs() {
    const out = [document];
    const walk = (doc, depth) => {
      if (depth > 4) return;
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return; }
      for (const f of frames) {
        let d = null;
        try { d = f.contentDocument; } catch (e) { d = null; }  // 跨域会抛，忽略
        if (!d || !d.documentElement) continue;
        // 空白 iframe（about:blank）跳过，避免把空文档当成答题页
        if (!d.body || (!d.body.textContent && !d.body.children.length)) continue;
        out.push(d);
        walk(d, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  },

  /**
   * 定位装着题目的文档。优先 .Py-mian1，其次看单选/多选框数量，最后看填空题。
   * @returns {Document} 找不到时返回顶层 document
   */
  resolveQuizDoc(force) {
    if (this.quizDoc && !force) return this.quizDoc;

    const docs = this.collectDocs();
    let found = null;

    // 1) 有 .Py-mian1 —— 超星手机版作业页的标志，最可靠
    for (const d of docs) {
      try { if (d.querySelectorAll('.Py-mian1').length) { found = d; break; } } catch (e) { /* 忽略单个文档的异常 */ }
    }
    // 2) 有 >=4 个单选/多选框
    if (!found) {
      for (const d of docs) {
        try { if (d.querySelectorAll('input[type=radio],input[type=checkbox]').length >= 4) { found = d; break; } } catch (e) { /* 同上 */ }
      }
    }
    // 3) 只有填空题的卷子
    if (!found) {
      for (const d of docs) {
        try {
          const txt = d.body ? d.body.textContent : '';
          if (/填空/.test(txt) && d.querySelectorAll('input[type=text]').length >= 1) { found = d; break; }
        } catch (e) { /* 同上 */ }
      }
    }

    this.quizDoc = found || document;
    this.quizKind = found ? 'quiz' : 'other';
    if (typeof Runner !== 'undefined') Runner.doc = this.quizDoc;
    return this.quizDoc;
  },

  /**
   * 反复探测。章节测验的 iframe 常常晚于脚本注入才渲染，
   * 一次性判断必然漏。这里探 6 次、每次间隔 2 秒，覆盖大多数加载耗时。
   */
  startProbing() {
    let tries = 0;
    const tick = () => {
      tries++;
      const doc = this.resolveQuizDoc(true);

      if (this.quizKind === 'quiz') {
        UI.setPageKind('quiz');
        const where = doc === document ? '当前页面' : '页面内的 iframe';
        log('在' + where + '里找到题目内容', 'success');
        this.reportQuestions(doc);
        return;
      }

      if (tries === 1) {
        UI.setPageKind('other');
        UI.setStatus('idle', '非答题页');
        log('脚本已加载。当前页面不是答题页，进入章节测验后「开始答题」才可用。', 'info');
        log('可以先把 API Key 配上：点右下角齿轮 → 设置', 'info');
      }
      if (tries < 6) setTimeout(tick, 2000);
      else log('多次探测仍未找到题目。如果页面上确实有测验，点「导出页面结构」发我', 'warn');
    };
    setTimeout(tick, 1200);
  },

  reportQuestions(doc) {
    try {
      const r = Parser.parse(doc);
      if (r.questions.length) {
        UI.setStatus('idle', '识别到 ' + r.questions.length + ' 题');
        log('识别到 ' + r.questions.length + ' 道题（解析器：' + (r.adapter || '仅填空') + '）', 'success');
        if (r.unsupported.length) {
          log('⚠️ 卷面含脚本不支持的题型：' + r.unsupported.join('、') + '，这些题需要你手动作答，否则不会自动提交', 'warn');
        }
      } else {
        UI.setStatus('warn', '未识别到题目');
        log('页面上没找到题目。如果确实有题，点「导出页面结构」发我', 'warn');
      }
    } catch (e) {
      log('自动探测失败：' + e.message, 'warn');
    }
  },

  refreshConfigState() {
    return UI.refreshConfigState();
  },
};

(function bootstrap() {
  // 测试环境会把文档逻辑单独拿出来跑，不需要自动初始化
  if (typeof window !== 'undefined' && window.__LLM_QUIZ_NO_AUTOINIT__) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Main.init());
  } else {
    Main.init();
  }
})();
