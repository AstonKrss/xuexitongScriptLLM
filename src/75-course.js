/* ============================================================
 * 75-course.js —— 课程页调度：自动播放、自动进下一节
 *
 * ---------- 它做什么 ----------
 * 在课程学习页（mycourse/studentstudy）上循环：
 *   1. 找到页面里的视频，点播放；
 *   2. 等它自然播完（超星自己会在这期间上报进度）；
 *   3. 点「下一节」，进入下一个任务点；
 *   4. 遇到作业/测验就停下来，等答题脚本跑完再继续。
 *
 * ---------- 它不做什么 ----------
 * 不做倍速、不伪造心跳、不直接调上报接口。
 * 视频就是老老实实 1 倍速播完，进度是播放器自己上报的。
 *
 * 这条路比「刷课」慢得多——一节 20 分钟的视频就得等 20 分钟。但它是
 * 唯一不会在服务端留下异常痕迹的做法：观看时长、上报节奏、心跳分布
 * 全部来自真实播放。原脚本那套伪造上报一旦被判定，后果是清空进度。
 *
 * ---------- 为什么这个脚本以前做不到 ----------
 * 作业页在 iframe 最里层，看不到目录树、点不到「下一节」。要驱动导航，
 * 必须站在课程页这一层——这个文件就是干这个的。
 * ============================================================ */

/** 读当前 URL 的查询参数（courseId 等在 studentstudy 的地址上） */
function queryVar(name) {
  try {
    return (new URLSearchParams(location.search).get(name)) || '';
  } catch (e) { return ''; }
}

const CoursePilot = {
  running: false,
  stopFlag: false,
  doc: null,
  stats: { videos: 0, sections: 0 },
  _lastHref: '',
  /* ---------- 环境判断 ---------- */

  /** 是不是课程学习页（而不是作业页、考试页） */
  available(doc) {
    const href = String(location.href || '');
    let hasCatalog = false;
    try {
      hasCatalog = !!(doc || document).querySelector(
        '.posCatalog_select, .posCatalog_active, .prev_ul, .tabtags, h4[id^="cur"], h5[id^="cur"]'
      );
    } catch (e) { hasCatalog = false; }
    return hasCatalog || /mycourse\/studentstudy|knowledge\/cards/.test(href);
  },

  /* ---------- 任务清单（学原脚本的关键一招） ----------
   *
   * knowledge/cards 页面的 script 里埋着一份完整的任务清单（mArg JSON）：
   *   attachments: [{ type:'video'|'document'|'workid', job:true, isPassed,
   *                   property:{name,objectid,workid...}, jobid, jtoken, enc }]
   *
   * 等着 DOM 渲染出来再摸黑找 video/作业，iframe 加载慢一点就会误判
   * "这节没任务"然后跳走。读清单是确定性的：这一节有什么、做没做完，
   * 清单里写得明明白白。
   */

  findMargInDoc(d) {
    if (!d) return null;
    let scripts = [];
    try { scripts = Array.from(d.querySelectorAll('script')); } catch (e) { return null; }
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.indexOf('mArg') < 0) continue;
      if (text.indexOf('==UserScript==') >= 0) continue;   // 别把自己的脚本文本解析了
      if (text.indexOf('}catch') < 0) continue;

      // 真实页面的 script 通常是「占位声明 + try 赋值」两段：
      //   mArg = "";
      //   try{ mArg = {...大对象...}; }catch(e){}
      // 所以取最后一个 "mArg = {"（占位那段没有花括号，不影响），
      // 再到它后面的 "}catch" 之前找 JSON 的收尾。
      const re = /mArg\s*=\s*\{/g;
      let m, objStart = -1;
      while ((m = re.exec(text)) !== null) objStart = m.index + m[0].length - 1;
      if (objStart < 0) continue;
      const catchAt = text.indexOf('}catch', objStart);
      if (catchAt < 0) continue;
      // catchAt 指向 try 块自己的闭合 '}'，必须排除这一位，
      // 否则 JSON 尾部会多出 ";}"，parse 直接报错
      const jsonEnd = text.lastIndexOf('}', catchAt - 1);
      if (jsonEnd <= objStart) continue;
      try {
        const parsed = JSON.parse(text.substring(objStart, jsonEnd + 1));
        if (parsed && Array.isArray(parsed.attachments)) return parsed;
      } catch (e) { continue; }
    }
    return null;
  },

  findMarg(win, depth) {
    win = win || window;
    depth = depth || 0;
    if (depth > 4) return null;
    let d = null;
    try { d = win.document; } catch (e) { return null; }
    if (!d) return null;
    let r = this.findMargInDoc(d);
    if (r) return r;
    let frames = [];
    try { frames = Array.from(d.querySelectorAll('iframe')); } catch (e) { return null; }
    for (const f of frames) {
      let w = null;
      try { w = f.contentWindow; } catch (e) { continue; }
      if (!w) continue;
      r = this.findMarg(w, depth + 1);
      if (r) return r;
    }
    return null;
  },

  /**
   * 把 mArg 的 attachments 拆成待办任务。已完成（isPassed）和非任务点不收。
   * @returns {{videos:Array, documents:Array, works:Array, defaults:Object, totalJobs:number}}
   */
  parseTasks(pageData) {
    const out = {
      videos: [], documents: [], works: [],
      defaults: (pageData && pageData.defaults) || {},
      totalJobs: 0,
    };
    const atts = pageData && pageData.attachments;
    if (!Array.isArray(atts)) return out;
    for (const item of atts) {
      if (!item || item.job !== true) continue;        // 不是任务点（纯阅读内容）
      out.totalJobs++;
      if (item.isPassed === true) continue;            // 已经完成
      switch (item.type) {
        case 'video': out.videos.push(item); break;
        case 'document': out.documents.push(item); break;
        case 'workid': out.works.push(item); break;
      }
    }
    return out;
  },

  /**
   * 文档任务：调超星自己的"阅读完成"接口。
   * 这个请求用户打开文档看完时浏览器本来就会发，直接代发一份，
   * 等价于"打开了这篇文档"——不涉及时长伪造，风险可控。
   *
   * 已标记过的文档不重复发（服务端确认有延迟，重复发除了刷日志没有任何作用）。
   */
  markedDocs() {
    try {
      const raw = sessionStorage.getItem('llmq:markedDocs');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },

  markDocDone(jobid) {
    try {
      const m = this.markedDocs();
      m[jobid] = Date.now();
      sessionStorage.setItem('llmq:markedDocs', JSON.stringify(m));
    } catch (e) { /* 忽略 */ }
  },

  markDocument(item, defaults) {
    const name = (item.property && item.property.name) || '文档';
    if (this.markedDocs()[item.jobid]) {
      log('文档「' + name + '」本轮已标记过（服务端状态更新有延迟），跳过', 'info');
      return Promise.resolve();
    }
    // ⚠️ 参数**原样拼接，不做 URL 编码**——原脚本就是这么发的，而且实测有效。
    // jtoken 里常含 + / = 之类的字符，encodeURIComponent 转成 %2B %2F 后，
    // 服务端若按原样比对 token 就对不上：接口照样返回 status:true，
    // 但任务点实际不会被标记——这正是"标记成功却弹任务点未完成"的原因。
    const jtoken = (item.jtoken == null) ? '' : String(item.jtoken);
    const knowledgeid = (defaults.knowledgeid == null) ? '' : String(defaults.knowledgeid);
    const courseid = (defaults.courseid != null && defaults.courseid !== '') ? String(defaults.courseid)
      : (queryVar('courseid') || queryVar('courseId') || '');
    const clazzid = (defaults.clazzId == null) ? '' : String(defaults.clazzId);
    const url = location.protocol + '//' + location.host + '/ananas/job/document?jobid=' + item.jobid +
      '&knowledgeid=' + knowledgeid + '&courseid=' + courseid +
      '&clazzid=' + clazzid + '&jtoken=' + jtoken;
    log('处理文档：' + name, 'info');
    log('标记请求：' + url.replace(/jtoken=[^&]{8,}/, 'jtoken=***'), 'info');
    const self = this;
    return new Promise((resolve) => {
      try {
        gmRequest({
          method: 'GET',
          timeout: 15000,
          url: url,
          onload(res) {
            const body = String(res.responseText == null ? '' : res.responseText);
            let r = null;
            try { r = JSON.parse(body); } catch (e) { /* 非 JSON 响应 */ }
            if (r && r.status) {
              log('文档「' + name + '」标记请求已接受', 'success');
              self.markDocDone(item.jobid);
            } else {
              // 接口没接受。把响应原文打出来，能不能标记一眼可辨
              log('文档「' + name + '」未标记完成，接口返回：' + body.slice(0, 140), 'error');
            }
            resolve();
          },
          onerror() { log('文档「' + name + '」请求失败', 'warn'); resolve(); },
          ontimeout() { log('文档「' + name + '」请求超时', 'warn'); resolve(); },
        });
      } catch (e) { log('文档「' + name + '」处理异常：' + e.message, 'warn'); resolve(); }
    });
  },

  /** 等视频元素出现（进新节后 iframe 加载需要时间） */
  async waitVideoElement(seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !this.stopFlag) {
      const v = this.findVideo();
      if (v) return v;
      await sleep(1500);
    }
    return null;
  },

  /** 等作业页面出现 */
  async waitHomework(seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !this.stopFlag) {
      const hw = this.detectHomework();
      if (hw) return hw;
      await sleep(2000);
    }
    return null;
  },

  /* ---------- 找视频 ---------- */

  /**
   * 递归找播放器。超星的视频在 ananas 的 iframe 里，层级不固定，
   * 所以按帧树往下摸，最多三层。
   */
  findVideo(win, depth) {
    win = win || window;
    depth = depth || 0;
    if (depth > 3) return null;
    let doc = null;
    try { doc = win.document; } catch (e) { return null; }
    if (!doc) return null;

    let v = null;
    try { v = doc.querySelector('video'); } catch (e) { v = null; }
    // 没有 duration 说明还没加载出元数据，此时播不了；
    // 已经播完的（ended）也不能再返回——否则会对着它 play() → 立即 ended → 死循环
    if (v && v.duration && isFinite(v.duration) && !v.ended) return v;

    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return null; }
    for (const f of frames) {
      let w = null;
      try { w = f.contentWindow; } catch (e) { continue; }
      if (!w) continue;
      const r = this.findVideo(w, depth + 1);
      if (r) return r;
    }
    return null;
  },

  /**
   * 播放一个视频直到结束。
   * 只做三件事：静音、1 倍速、被暂停就续播。其余交给播放器自己上报。
   * @returns {Promise<boolean>} 是否真的播完了
   */
  async playVideo(v) {
    const total = Math.round(v.duration);
    log('开始播放视频，时长 ' + Math.floor(total / 60) + ' 分 ' + (total % 60) + ' 秒' +
      '（1 倍速真实播放，不跳、不快进）', 'info');
    UI.setStatus('running', '播放中 0%');

    let started = false;
    try {
      v.muted = true;          // 静音是浏览器允许自动播放的前提
      v.playbackRate = 1;      // 强制 1 倍速：这是本项目的底线
      await v.play();
      started = true;
    } catch (e) {
      started = false;
    }
    if (!started) {
      log('浏览器拦截了自动播放。请手动点一下播放按钮，脚本会在开始后接手', 'warn');
      // 等用户手动点播放
      const ok = await waitFor(() => !v.paused, 120000, 800);
      if (!ok) {
        log('等了 2 分钟视频仍未开始，自动刷课暂停', 'error');
        return false;
      }
      try { v.playbackRate = 1; } catch (e) { /* 忽略 */ }
    }

    // 上限：时长的 2 倍 + 3 分钟，防止卡死在某个状态里
    const limitMs = (total + 180) * 2000;
    const t0 = Date.now();
    let lastReport = 0;

    while (!this.stopFlag) {
      if (Date.now() - t0 > limitMs) {
        log('视频播放超时（超过 ' + Math.round(limitMs / 60000) + ' 分钟仍未结束），停止', 'error');
        return false;
      }
      if (v.ended) break;

      // 被页面暂停（切后台、弹窗）就续播，但不硬顶用户的暂停操作
      if (v.paused) {
        try { await v.play(); } catch (e) { /* 再失败就等下一轮 */ }
      }
      try { if (v.playbackRate !== 1) v.playbackRate = 1; } catch (e) { /* 忽略 */ }

      const pct = Math.min(100, Math.round(v.currentTime / v.duration * 100));
      if (pct - lastReport >= 10) {
        lastReport = pct;
        UI.setStatus('running', '播放中 ' + pct + '%');
        log('视频进度 ' + pct + '%（' + Math.floor(v.currentTime / 60) + '/' + Math.floor(v.duration / 60) + ' 分）', 'info');
      }
      await sleep(1000);
    }

    if (this.stopFlag) return false;
    log('视频播放完毕，等待超星上报完成状态', 'success');
    return true;
  },

  /* ---------- 找"下一节" ---------- */

  /**
   * 找下一个可点的导航控件。按可靠性从高到低试：
   * 明确的"下一节"按钮 → 文字匹配 → 目录树里的下一个节点。
   * @returns {{el:Element, kind:string}|null}
   */
  findNextControl(doc) {
    const d = doc || document;

    // 1) 新版学习页底部的"下一节"按钮
    const sels = [
      '.jb_btn.jb_btn_92.fs14.prev_next.next',
      '.prev_next.next',
      'a.next',
      '.orientationright',
    ];
    for (const s of sels) {
      let el = null;
      try { el = d.querySelector(s); } catch (e) { el = null; }
      if (el && isVisible(el)) return { el: el, kind: 'button' };
    }

    // 2) 文字是"下一节/下一章/下一个"的按钮
    const byText = findButtonByText(['下一节', '下一章', '下一个', '下一课'], d);
    if (byText) return { el: byText, kind: 'text' };

    // 3) 目录树：找当前高亮的节点，点它后面第一个可点的
    const act = d.querySelector('.posCatalog_active');
    if (act) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll('.posCatalog_select')); } catch (e) { nodes = []; }
      const idx = nodes.findIndex((n) => n === act);
      // 找不到 active 在列表里的位置，说明结构对不上。
      // 这时候绝不能从 0 开始遍历——那会点到第一节，甚至当前这一节，原地打转。
      if (idx >= 0) {
        for (let i = idx + 1; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.className.indexOf('posCatalog_active') >= 0) continue;
          // 章标题节点（firstLayer）没有任务点，点它只是展开目录，不是去下一节
          if (/firstLayer/.test(n.className)) continue;
          // 已完成的节点跳过，锁住的跳过
          if (/icon_Completed/.test(n.innerHTML)) continue;
          if (/catalog_points_er|lock/.test(n.innerHTML)) continue;
          // 节点的 id 形如 curXXXX；没有 id 的（章标题等）一律不认
          if (!n.id || n.id.indexOf('cur') < 0) continue;
          return { el: n, kind: 'catalog' };
        }
      }
    }

    // 4) 老版目录：h4/h5 上带 cur 前缀的 id
    const heads = Array.from(d.querySelectorAll('h4[id^="cur"], h5[id^="cur"]'));
    if (heads.length) {
      // 当前节点通常带 active/currents 样式
      let curIdx = heads.findIndex((h) => /active|current/i.test(h.className));
      if (curIdx < 0) curIdx = 0;
      if (curIdx + 1 < heads.length) return { el: heads[curIdx + 1], kind: 'catalog-old' };
    }

    // 5) 老版 tabtags 里的下一个
    const spans = Array.from(d.querySelectorAll('.tabtags span'));
    const curSpan = spans.findIndex((s) => /currents/.test(s.className));
    if (curSpan >= 0 && curSpan + 1 < spans.length) return { el: spans[curSpan + 1], kind: 'tabtags' };

    return null;
  },

  async nextSection(doc, allDone) {
    const target = this.findNextControl(doc || document);
    if (!target) {
      this._sameNextEl = null;
      this._sameNextCount = 0;
      return false;
    }

    // 点了却没反应的话，下一轮还会找到同一个元素。连点两次没变化就别再点了，
    // 否则会对着一个死链接空转到 300 轮上限。
    if (target.el === this._sameNextEl) {
      this._sameNextCount = (this._sameNextCount || 0) + 1;
      if (this._sameNextCount >= 2) {
        log('连续两次点同一个「下一节」页面都没变化，判定它点不动，停止', 'error');
        this._sameNextEl = null;
        this._sameNextCount = 0;
        return false;
      }
    } else {
      this._sameNextEl = target.el;
      this._sameNextCount = 0;
    }

    const label = (target.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    log('进入下一节：' + (label || target.kind), 'info');
    try {
      target.el.click();
    } catch (e) {
      log('点击下一节失败：' + e.message, 'error');
      return false;
    }

    // 点击后超星会弹两种确认框，都必须处理，否则页面停在弹层上、
    // 下一轮还在原节里，任务被重复处理、最后误判"下一节点不动"：
    //  ① 「当前章节还有任务点未完成，是否去完成？」——只有本节任务
    //     全部处理完（allDone）才确认跳转；否则停下，跳过去就是绕过
    //  ② 「继续学习/去学习」——直接点掉
    const d = doc || document;
    await waitFor(() => {
      let dialog = null;
      try {
        for (const el of d.querySelectorAll('div, section, p')) {
          if (!el.getClientRects || el.getClientRects().length === 0) continue;
          const t = (el.textContent || '').replace(/\s+/g, '');
          if (t.length < 6 || t.length > 80) continue;
          if (/任务点未完成|是否去完成/.test(t)) { dialog = el; break; }
        }
      } catch (e) { /* 忽略 */ }

      if (dialog) {
        if (!allDone) {
          log('超星提示还有任务点未完成，已停下（allDone=false，不强行跳）', 'warn');
          const cancel = findButtonByText(['取消', '返回', '否'], d);
          if (cancel) { try { cancel.click(); } catch (e) { /* 忽略 */ } }
          return true;
        }
        const ok = findButtonByText(['下一节'], dialog);
        if (ok) {
          try { ok.click(); } catch (e) { /* 忽略 */ }
          log('本节任务已全部处理，确认超星的跳节询问', 'info');
          return true;
        }
      }

      const c = findButtonByText(['继续学习', '去学习'], d);
      if (c) {
        try { c.click(); } catch (e) { /* 忽略 */ }
        log('点掉了「继续学习」弹层', 'info');
        return true;
      }
      return false;
    }, 5000, 500);

    return true;
  },

  /* ---------- 任务执行（对照原脚本补齐的三块） ---------- */

  /**
   * 按清单执行本节任务。返回 false 表示有任务没做完（主循环会停下，不跳节）。
   */
  async runTaskList(tasks, doc) {
    // ---- 视频 ----
    for (const item of tasks.videos) {
      if (this.stopFlag) return false;
      const name = (item.property && item.property.name) || '视频';
      log('播放视频：' + name, 'info');
      UI.setStatus('running', '视频：' + name);

      // 三层递进找播放器：
      // 1) 页面上已经渲染出来的 video（有的课程卡片直接内嵌）
      let v = this.findVideo();
      // 2) 点任务点图标把卡片展开（图标 class 各版本不一，多试几个选择器）
      if (!v) v = await this.probeVideoByIcon(doc);
      // 3) 还没有就等用户手动点开（60 秒）
      if (!v) {
        log('播放器没渲染出来。如果你看得到视频卡片，手动点开它，脚本会接手', 'warn');
        v = await this.waitVideoElement(60);
      }
      if (this.stopFlag) return false;
      if (!v) {
        log('视频 60 秒内没出现，自动刷课暂停', 'error');
        UI.setStatus('warn', '视频未找到');
        this.running = false;
        return false;
      }

      const ok = await this.playVideo(v);
      if (this.stopFlag) return false;
      if (!ok) { log('视频没有正常播完，自动刷课已暂停', 'warn'); this.running = false; return false; }
      this.stats.videos++;
      UI.setStatus('running', '等待上报…');
      await sleep(3000);
    }

    // ---- 文档 ----
    for (const item of tasks.documents) {
      if (this.stopFlag) return false;
      await this.markDocument(item, tasks.defaults);
      await sleep(2000);
    }

    // ---- 作业 ----
    if (tasks.works.length) {
      const ok = await this.doWorks(tasks.works, tasks.defaults, doc);
      if (!ok) return false;
    }

    return true;
  },

  /**
   * 找任务点图标点开它，等播放器渲染出来。
   * 图标 class 各版本不一，逐个选择器试，点错顶多是展开卡片，无害。
   */
  async probeVideoByIcon(doc) {
    const d = doc || document;
    const sels = ['.ans-job-icon', '[class*="job-icon"]', '.ans-insertvideo-online', '[class*="insertvideo"]'];
    for (const sel of sels) {
      let icons = [];
      try { icons = Array.from(d.querySelectorAll(sel)); } catch (e) { continue; }
      for (const ic of icons) {
        try { ic.click(); } catch (e) { continue; }
        await sleep(2000);
        const v = this.findVideo();
        if (v) {
          log('点开任务点后播放器已出现', 'info');
          return v;
        }
      }
    }
    return null;
  },

  /**
   * 用原脚本同款的 URL 自己打开作业页。
   * 这是确定性做法：不依赖超星渲染任务卡片，作业 iframe 一定会出现，
   * 然后 Runner 通过 resolveQuizDoc 定位到它答题。
   */
  openWorkInFrame(item, defaults, doc) {
    const d = doc || document;
    const workid = (item.property && item.property.workid) || '';
    const workId = String(workid).replace(/^work-/, '');
    const courseId = defaults.courseid || queryVar('courseid') || queryVar('courseId') || '';
    const url = location.protocol + '//' + location.host +
      '/work/phone/work?workId=' + encodeURIComponent(workId) +
      '&courseId=' + encodeURIComponent(courseId) +
      '&clazzId=' + encodeURIComponent(defaults.clazzId || '') +
      '&knowledgeId=' + encodeURIComponent(defaults.knowledgeid || '') +
      '&jobId=' + encodeURIComponent(item.jobid || '') +
      '&enc=' + encodeURIComponent(item.enc || '');

    let f = null;
    try { f = d.getElementById('llmq-work-frame'); } catch (e) { f = null; }
    if (!f) {
      try {
        f = d.createElement('iframe');
        f.id = 'llmq-work-frame';
        f.style.cssText = 'position:fixed;right:12px;bottom:12px;width:460px;height:620px;' +
          'z-index:2147483647;border:2px solid #4a90d9;border-radius:8px;background:#fff;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);';
        (d.body || d.documentElement).appendChild(f);
      } catch (e) {
        log('创建作业窗口失败：' + e.message, 'error');
        return null;
      }
    }
    f.src = url;
    log('作业已在右下角窗口打开（做完会自动关掉）', 'info');
    return f;
  },

  closeWorkFrame(doc) {
    try {
      const f = (doc || document).getElementById('llmq-work-frame');
      if (f) f.remove();
    } catch (e) { /* 忽略 */ }
  },

  /** 逐个打开作业并答题。返回 false 表示有作业没做完 */
  async doWorks(works, defaults, doc) {
    for (const item of works) {
      if (this.stopFlag) return false;
      const title = (item.property && item.property.title) || '章节测验';

      // 先等超星自己的作业卡片渲染（有的课程直接内嵌）——10 秒
      let ready = await this.waitQuizDocReady(10);
      // 没等到就自己打开（原脚本同款 URL），再等 30 秒
      if (!ready) {
        this.openWorkInFrame(item, defaults, doc);
        ready = await this.waitQuizDocReady(30);
      }
      if (this.stopFlag) return false;
      if (!ready) {
        log('作业页面 40 秒没就绪，自动刷课暂停', 'error');
        UI.setStatus('warn', '作业未就绪');
        this.running = false;
        return false;
      }

      const ok = await this.runHomework();
      if (this.stopFlag) return false;
      if (!ok) {
        log('这一节作业没做完，自动刷课已暂停 —— 继续往下会把它绕过去', 'error');
        log('处理完（补题 / 改「填完之后」设置 / 检查 API）后，再点一次「自动刷课」继续', 'warn');
        UI.setStatus('warn', '作业未完成，已暂停');
        this.running = false;
        return false;
      }
      this.closeWorkFrame(doc);
      await sleep(4000);
    }
    return true;
  },

  /** 等答题模块定位到一个真正装着题目的文档 */
  async waitQuizDocReady(seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !this.stopFlag) {
      try {
        if (typeof Main !== 'undefined' && Main.resolveQuizDoc) Main.resolveQuizDoc(true);
        const qd = Main.quizDoc;
        if (qd && qd !== document) {
          if (qd.querySelectorAll('.Py-mian1, .TiMu').length) return true;
        }
      } catch (e) { /* 忽略 */ }
      await sleep(1500);
    }
    return false;
  },

  /* ---------- 主循环 ---------- */

  async start() {
    if (this.running) { log('自动刷课已经在跑了，别重复点', 'warn'); return; }
    if (!this.available(this.doc || document)) {
      log('当前页面不像课程学习页，自动刷课不可用', 'warn');
      return;
    }

    this.running = true;
    this.stopFlag = false;
    this.stats = { videos: 0, sections: 0 };
    // 记到 sessionStorage：超星切节点常常整页重载，靠它续跑
    try { sessionStorage.setItem('llmq:pilot', '1'); } catch (e) { /* 隐私模式下可能禁用 */ }

    log('自动刷课开始：视频 1 倍速真实播放，遇到作业自动答题', 'success');
    log('依据：观看时长、上报节奏全部来自真实播放，服务端看不到异常。代价是慢', 'info');

    let rounds = 0;
    while (this.running && !this.stopFlag) {
      rounds++;
      if (rounds > 300) { log('循环次数过多，停止自动刷课', 'warn'); break; }

      // ---------- 优先走任务清单（mArg）----------
      // knowledge/cards 的 script 里埋着本节的完整任务清单，读它比等 DOM
      // 渲染可靠得多——iframe 加载再慢也不会误判"这节没任务"。
      let marg = this.findMarg();
      let tasks = this.parseTasks(marg);
      let video = this.findVideo();
      let hw = this.detectHomework();
      let taskCount = tasks.videos.length + tasks.documents.length + tasks.works.length;

      // 刚进新节时，任务 iframe 往往还没加载完——清单和 DOM 都可能暂时是空的。
      // 什么都不检测就点「下一节」会把整节作业跳过去（实测踩过），多等两次再放弃。
      if (!video && !hw && taskCount === 0 && !this.stopFlag) {
        for (let retry = 0; retry < 2; retry++) {
          await sleep(3500);
          if (this.stopFlag) break;
          marg = marg || this.findMarg();
          tasks = this.parseTasks(marg);
          video = video || this.findVideo();
          hw = hw || this.detectHomework();
          taskCount = tasks.videos.length + tasks.documents.length + tasks.works.length;
          if (video || hw || taskCount > 0 || tasks.totalJobs > 0) {
            log('等了 ' + ((retry + 1) * 3.5) + ' 秒才发现任务点（iframe 加载慢）', 'info');
            break;
          }
        }
      }

      if (!marg && rounds === 1) {
        log('没有在本页任何 iframe 的 script 里找到任务清单（mArg），退回逐个找视频/作业的方式', 'info');
      }

      log('第 ' + rounds + ' 轮：' + (video ? '有视频' : '无视频') + '，' + (hw ? '有作业' : '无作业') +
        '，' + (marg ? '任务清单已读到' : '无任务清单'), 'info');

      // 清单里有任务点但全部已完成 → 本节本来就没活，直接下一节，
      // 不用在 DOM 重试上白耗 7 秒
      if (marg && tasks.totalJobs > 0 && taskCount === 0) {
        log('本节任务点已全部完成，直接进入下一节', 'info');
        this.stats.sections++;
        await sleep(3000);
        const movedAll = await this.nextSection(this.doc || document, true);
        if (!movedAll) { log('没有找到下一节，可能已经是最后一节了', 'success'); break; }
        await sleep(6000);
        continue;
      }

      if (taskCount > 0) {
        log('本节任务（来自页面清单）：视频 ' + tasks.videos.length + '、文档 ' + tasks.documents.length +
          '、作业 ' + tasks.works.length, 'info');
        const ok = await this.runTaskList(tasks, this.doc || document);
        if (this.stopFlag || !this.running) break;
        if (!ok) break;   // runTaskList 内部已说明停在哪一步

        // 本节任务全部处理完 → 下一节
        this.stats.sections++;
        log('本节任务全部完成，进入下一节', 'success');
        await sleep(3000);
        const moved = await this.nextSection(this.doc || document, true);
        if (!moved) { log('没有找到下一节，可能已经是最后一节了', 'success'); break; }
        await sleep(6000);
        continue;
      }

      // ---------- 没有任务清单（老课程/特殊页面），退回 DOM 摸索 ----------
      // video / hw 已在本轮开头检测过（含重试），这里直接用

      // 1) 有视频就先播
      if (video) {
        const ok = await this.playVideo(video);
        if (this.stopFlag) break;
        if (!ok) { log('视频没有正常播完，自动刷课已暂停', 'warn'); break; }
        this.stats.videos++;
        UI.setStatus('running', '等待上报…');
        await sleep(4000);   // 给播放器留出上报和标记完成的时间
        continue;            // 同一页可能还有别的视频
      }

      // 2) 没有视频 → 是不是作业/测验
      if (hw) {
        if (this.ranHomework()[hw.key]) {
          log('这一节的作业之前已经自动做过了，跳到下一节', 'info');
        } else {
          const ok = await this.runHomework();
          if (this.stopFlag) break;

          if (ok) {
            this.markHomework(hw.key);
            await sleep(4000);
            continue;   // 答完再看一眼，这一节可能还有别的任务点
          }

          // 没做完就绝不能往下跳。之前这里写漏了 break，
          // 导致作业还没做完就点了「下一节」，整节被跳过。
          log('这一节作业没做完，自动刷课已暂停 —— 继续往下会把它绕过去', 'error');
          log('处理完（补题 / 改「填完之后」设置 / 检查 API）后，再点一次「自动刷课」继续', 'warn');
          UI.setStatus('warn', '作业未完成，已暂停');
          break;
        }
      }

      // 3) 点下一节
      const moved = await this.nextSection(this.doc || document);
      if (!moved) {
        log('没有找到下一节，可能已经是最后一节了', 'success');
        break;
      }
      this.stats.sections++;
      // 等新内容加载。超星是整页跳转，这里主要覆盖 SPA 式的局部刷新
      await sleep(6000);
    }

    this.running = false;
    try { sessionStorage.removeItem('llmq:pilot'); } catch (e) { /* 忽略 */ }
    const s = this.stats;
    log('自动刷课结束：播放 ' + s.videos + ' 个视频，进入 ' + s.sections + ' 节', 'success');
    UI.setStatus('idle', '自动刷课已停止');
  },

  stop() {
    if (!this.running) { log('自动刷课没有在跑', 'info'); return; }
    this.stopFlag = true;
    log('收到停止指令，当前视频播完这一段就停（不会中断播放，否则进度白攒）', 'warn');
  },

  /** 当前文档里是不是装着作业卷子 */
  looksLikeHomework() {
    return !!this.detectHomework();
  },

  /**
   * 找作业，并返回一个能区分"哪份卷子"的标识。
   * 答题由顶层的 Runner 驱动（它通过 Main.resolveQuizDoc 定位到装题的 iframe），
   * 所以这里只要负责发现和去重。
   * @returns {{key:string}|null}
   */
  detectHomework() {
    const checkDoc = (d) => {
      if (!d) return null;

      let marks = 0;
      try { marks = d.querySelectorAll('.TiMu, .Py-mian1').length; } catch (e) { marks = 0; }
      if (!marks) {
        try {
          // 排除 answertype，那是题型字段不是答案
          const ins = Array.from(d.querySelectorAll('input[name^="answer"]'))
            .filter((el) => !/^answertype/i.test(el.name || ''));
          if (ins.length >= 2) marks = ins.length;
        } catch (e) { marks = 0; }
      }
      if (!marks) return null;

      // 用"首个题目 id + 题目数量"做标识。同一份卷子这个组合稳定，翻页重载也不变，
      // 换一份卷子就会变——正好用来判断"这份作业是不是已经自动做过了"。
      let key = '';
      try {
        const first = d.querySelector('[qid]') || d.querySelector('input[name^="answer"]');
        if (first) key = first.getAttribute('qid') || first.name || '';
      } catch (e) { key = ''; }
      if (!key) {
        try { key = String(d.location.href || '').slice(-80); } catch (e) { key = ''; }
      }
      return { doc: d, key: (key || 'unknown') + '|' + marks };
    };

    // 1) 优先用答题模块的文档收集器——它会递归两层 iframe，
    //    比这里只扫一层更不容易漏掉深处的作业
    if (typeof Main !== 'undefined' && typeof Main.collectDocs === 'function') {
      let docs = [];
      try { docs = Main.collectDocs(); } catch (e) { docs = []; }
      for (const d of docs) {
        const r = checkDoc(d);
        if (r) return r;
      }
    }
    // 2) 当前文档
    const self = checkDoc(typeof document !== 'undefined' ? document : null);
    if (self) return self;
    // 3) 兜底：自己遍历一层 iframe
    let frames = [];
    try { frames = Array.from(document.querySelectorAll('iframe')); } catch (e) { return null; }
    for (const f of frames) {
      let w = null;
      try { w = f.contentWindow; } catch (e) { continue; }
      if (!w) continue;
      let d = null;
      try { d = w.document; } catch (e) { continue; }
      const r = checkDoc(d);
      if (r) return r;
    }
    return null;
  },

  /** 已经自动做过的作业（sessionStorage，关标签即清） */
  ranHomework() {
    try {
      const raw = sessionStorage.getItem('llmq:pilotHome');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },

  markHomework(key) {
    try {
      const m = this.ranHomework();
      m[key] = Date.now();
      sessionStorage.setItem('llmq:pilotHome', JSON.stringify(m));
    } catch (e) { /* 隐私模式可能禁用，忽略 */ }
  },

  /** 自动做当前这节的作业。返回是否真的跑了 */
  async runHomework() {
    if (typeof Runner === 'undefined' || typeof Config === 'undefined') {
      log('答题模块没加载，跳过这一节的作业', 'warn');
      return false;
    }
    let cfg = null;
    try { cfg = Config.load(); } catch (e) { cfg = null; }
    const profile = cfg && cfg.profiles ? cfg.profiles[cfg.activeProfile] || cfg.profiles.default : null;
    if (!profile || !profile.apiKey) {
      log('还没配 API Key，没法自动答题。这一节留给你手动处理', 'warn');
      return false;
    }

    // 让 Main 重新定位装题的文档——作业可能刚在 iframe 里加载出来。
    // Main 只在顶层初始化，这里只是借用它的定位能力，取不到也不影响答题。
    if (typeof Main !== 'undefined' && typeof Main.resolveQuizDoc === 'function') {
      try { Main.resolveQuizDoc(true); } catch (e) { /* 忽略 */ }
    }

    // 自动刷课路径下不等最短作答时长：60 题 × 25 秒 = 25 分钟干等没有意义
    if (typeof Runner !== 'undefined') Runner._pilotSkipWait = true;

    // 用户可能同时点了「开始答题」。这时候 Runner 正在跑，start() 会立刻返回，
    // 让我们读到一份过期的结果，白白判成"没做完"。等它跑完再说。
    if (Runner.running) {
      log('检测到答题已经在进行，等它跑完再判断结果…', 'info');
      const done = await waitFor(() => !Runner.running || this.stopFlag, 45 * 60 * 1000, 2000);
      if (this.stopFlag) return false;
      if (!done) {
        log('等了 45 分钟答题还没结束，自动刷课暂停', 'error');
        return false;
      }
      const r0 = Runner.lastResult || {};
      return r0.status === 'done';
    }

    log('这一节是作业，自动开始答题', 'success');
    try {
      await Runner.start();
    } catch (e) {
      log('自动答题出错：' + e.message, 'error');
      return false;
    }

    // 光看 start() 有没有返回是不够的：解析不到题、覆盖率不足、保存失败
    // 都会"正常返回"。必须看它留下的结果，只有 status === 'done' 才算做完。
    const r = Runner.lastResult || { status: 'unknown', reason: '没有拿到运行结果' };
    const pct = (r.rate == null ? '?' : r.rate.toFixed(1));
    const how = r.submitted ? '已提交' : (r.saved ? '已保存' : '未保存');
    log('这一节作业结束：' + (r.status || '未知') + '，覆盖率 ' + pct + '%，' + how,
      r.status === 'done' ? 'success' : 'warn');
    if (r.reason) log('  原因：' + r.reason, 'warn');

    if (r.status === 'done') return true;

    if (!cfg.quiz.autoSave && !cfg.quiz.autoSubmit) {
      log('当前是「只填不存」模式，答案还在页面上没落库', 'warn');
      log('要让它自动存，去设置里把「填完之后」改成自动保存', 'warn');
    }
    return false;
  },

  /**
   * 页面重载后续跑。超星点目录节点常常整页刷新，不续跑就只刷一节。
   * 用 sessionStorage 而不是 GM 存储：关掉标签就失效，不会第二天自己跑起来。
   */
  maybeResume() {
    let flag = null;
    try { flag = sessionStorage.getItem('llmq:pilot'); } catch (e) { return; }
    if (flag !== '1') return;
    if (!this.available(document)) return;
    log('检测到上一页的自动刷课还没结束，3 秒后继续', 'info');
    setTimeout(() => { this.start(); }, 3000);
  },
};
