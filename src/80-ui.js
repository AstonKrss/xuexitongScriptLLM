/* ============================================================
 * 80-ui.js —— 悬浮面板与设置界面
 *
 * 用 Shadow DOM 隔离：超星页面加载了 bootstrap，普通样式会被它污染，
 * 出现按钮变形、输入框高度异常之类的怪问题。Shadow 边界能彻底避免。
 * ============================================================ */

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; }

.ball {
  position: relative;
  width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
  background: #2f6feb; color: #fff; font-size: 20px; line-height: 1;
  box-shadow: 0 4px 14px rgba(0,0,0,.22); transition: transform .15s;
}
.ball:hover { transform: scale(1.06); }
.ball.running { background: #e8a33d; animation: pulse 1.4s infinite; }
/* 未配置密钥时挂一个红点，否则用户根本不知道要进来设置 */
.ball .dot { display: none; position: absolute; top: 1px; right: 1px; width: 11px; height: 11px;
  border-radius: 50%; background: #e5484d; border: 2px solid #fff; }
.ball.unconfigured .dot { display: block; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.65} }

.panel {
  position: absolute; right: 0; bottom: 58px; width: 372px; max-height: 74vh;
  background: #fff; border: 1px solid #e3e6ec; border-radius: 10px;
  box-shadow: 0 10px 34px rgba(0,0,0,.18); display: none; flex-direction: column; overflow: hidden;
}
.panel.open { display: flex; }

.hd { padding: 10px 12px; border-bottom: 1px solid #eef0f4; display: flex; align-items: center; gap: 8px; }
.hd .repo { margin-left: auto; font-size: 12px; color: #2f6feb; text-decoration: none; }
.hd b { font-size: 13px; color: #1f2329; font-weight: 600; }
.hd .ver { font-size: 11px; color: #a0a5ad; margin-left: 6px; }
.status { font-size: 11px; padding: 2px 7px; border-radius: 9px; background: #f0f2f6; color: #646a73; margin-left: auto; }
.status.running { background: #fff4e5; color: #b8730e; }
.status.done, .status.success { background: #e8f5ec; color: #1f7a3d; }
.status.warn { background: #fff4e5; color: #b8730e; }
.status.error { background: #fdecec; color: #c0392b; }

.log { flex: 1; overflow-y: auto; padding: 8px 12px; font-size: 12px; line-height: 1.6; min-height: 120px; }
.log .row { color: #3a3f47; word-break: break-all; }
.log .row .t { color: #a0a5ad; margin-right: 6px; }
.log .row.success { color: #1f7a3d; }
.log .row.warn { color: #b8730e; }
.log .row.error { color: #c0392b; }

.acts { padding: 8px 12px 12px; display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid #eef0f4; }
.acts button {
  flex: 1; min-width: 72px; padding: 7px 8px; font-size: 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid #d7dbe3; background: #fff; color: #2a2f37; transition: .12s;
}
.acts button:hover { border-color: #2f6feb; color: #2f6feb; }
.acts button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
.acts button.primary:hover { background: #2559c4; }
.acts button.danger:hover { border-color: #c0392b; color: #c0392b; }

/* 导出的结构文本：贴在面板里让用户手动全选复制，比赌 execCommand 可靠 */
.log textarea.dump {
  width: 100%; height: 170px; margin-top: 6px; font-size: 10px; line-height: 1.4;
  font-family: Consolas, monospace; border: 1px solid #d7dbe3; border-radius: 5px;
  padding: 6px; resize: vertical; color: #1f2329; background: #fbfcfd;
}

/* 设置页 */
.sheet {
  position: absolute; right: 0; bottom: 58px; width: 400px; max-height: 78vh; overflow-y: auto;
  background: #fff; border: 1px solid #e3e6ec; border-radius: 10px;
  box-shadow: 0 10px 34px rgba(0,0,0,.18); display: none;
}
.sheet.open { display: block; }
.sheet .inner { padding: 14px; }
.sheet h4 { margin: 0 0 4px; font-size: 13px; color: #1f2329; }
.sheet .hint { font-size: 11px; color: #8a9099; line-height: 1.5; margin: 0 0 10px; }
.sheet label { display: block; font-size: 11px; color: #646a73; margin: 9px 0 3px; }
.sheet input[type=text], .sheet input[type=password], .sheet input[type=number], .sheet select {
  width: 100%; padding: 6px 8px; font-size: 12px; border: 1px solid #d7dbe3; border-radius: 5px;
  color: #1f2329; background: #fff; outline: none;
}
.sheet input:focus, .sheet select:focus { border-color: #2f6feb; }
.sheet .row2 { display: flex; gap: 8px; }
.sheet .row2 > div { flex: 1; }
.sheet .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #3a3f47; margin: 7px 0; }
.sheet .chk input { width: auto; }
.sheet .sep { height: 1px; background: #eef0f4; margin: 14px 0 10px; }
.sheet .btns { display: flex; gap: 8px; margin-top: 14px; }
.sheet .btns button {
  flex: 1; padding: 8px; font-size: 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid #d7dbe3; background: #fff; color: #2a2f37;
}
.sheet .btns button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }

/* 模型名 + 拉取按钮 同一行 */
.sheet .inline { display: flex; gap: 6px; align-items: stretch; }
.sheet .inline input { flex: 1; width: auto; min-width: 0; }
.sheet button.mini {
  padding: 6px 10px; font-size: 12px; border-radius: 5px; cursor: pointer; white-space: nowrap;
  border: 1px solid #d7dbe3; background: #f7f8fa; color: #2a2f37;
}
.sheet button.mini:hover { border-color: #2f6feb; color: #2f6feb; }
.sheet button.mini:disabled { opacity: .55; cursor: default; border-color: #d7dbe3; color: #8a9099; }

/* 测试连接的结果必须就地显示——写在日志区等于没反馈，因为日志区在设置面板打开时是收起的 */
.sheet .result { margin-top: 8px; font-size: 11px; line-height: 1.65; border-radius: 5px; padding: 7px 9px; word-break: break-all; }
.sheet .result.ok { background: #e8f5ec; border: 1px solid #b7ddc4; color: #1a6b35; }
.sheet .result.err { background: #fdecec; border: 1px solid #f0c0c0; color: #b03434; }
.sheet .result.info { background: #eff4fd; border: 1px solid #c6d6f7; color: #2a569f; }
.sheet .note { font-size: 11px; color: #b8730e; background: #fff9ef; border: 1px solid #f3e0bd;
  border-radius: 5px; padding: 7px 9px; line-height: 1.55; margin: 8px 0; }
.sheet textarea {
  width: 100%; height: 150px; font-size: 11px; font-family: Consolas, monospace;
  border: 1px solid #d7dbe3; border-radius: 5px; padding: 6px; color: #1f2329; resize: vertical;
}
`;

const UI = {
  root: null,
  shadow: null,
  statusEl: null,
  logEl: null,
  ballEl: null,
  panelEl: null,
  sheetEl: null,
  _logBound: false,
  pageKind: 'other',   // 'quiz' | 'other'，由 Main 设置，决定「开始答题」是否可用

  mount() {
    if (this.root) return;
    const host = document.createElement('div');
    host.id = 'llm-quiz-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = '<style>' + PANEL_CSS + '</style>' + this.template();
    this.root = host;
    this.shadow = shadow;
    this.ballEl = shadow.querySelector('.ball');
    this.panelEl = shadow.querySelector('.panel');
    this.sheetEl = shadow.querySelector('.sheet');
    this.statusEl = shadow.querySelector('.status');
    this.logEl = shadow.querySelector('.log');

    this.bind();
    this.bindLog();
    this.setStatus('idle', '待命');
    this.setPageKind('other');

    // 首次使用（还没填 key）直接把设置面板推出来，否则用户看到的只是一个齿轮，
    // 根本不知道要点进去配置。只在顶层页面弹，避免多个 iframe 各弹一个。
    const configured = this.refreshConfigState();
    if (!configured) {
      log('还没配置 API Key，点下面的「设置」填一个就能用了', 'warn');
      if (window === window.top) this.openSettings();
    }
  },

  /** 根据是否已配置密钥，更新齿轮上的红点。返回是否已配置完整。 */
  refreshConfigState() {
    const p = Config.active();
    const configured = !!(p && p.apiKey && p.baseUrl && p.model);
    if (this.ballEl) this.ballEl.classList.toggle('unconfigured', !configured);
    return configured;
  },

  /** 由 Main 告知当前页面类型：主按钮只有一个，文案和动作随类型切换——
   *  课程页 →「自动刷课」，答题页 →「开始答题」。
   *  之前是两个按钮 + 显隐控制，判定出错时会出现两个同名按钮/全消失，
   *  单按钮动态切换从根上消除这种状态不同步。 */
  setPageKind(kind) {
    this.pageKind = kind;
    try {
      const mainBtn = this.shadow && this.shadow.querySelector('[data-act="main"]');
      if (mainBtn) mainBtn.textContent = (kind === 'quiz') ? '开始答题' : '自动刷课';
    } catch (e) { /* 忽略 */ }
    // 版本号写进 tooltip，这样不用开 F12 也能确认装的是哪一版
    if (this.ballEl) {
      this.ballEl.title = '超星答题助手 v' + VERSION + (kind === 'quiz' ? '（答题页）' : '（课程页）');
    }
  },

  template() {
    return `
<div class="wrap">
  <div class="panel">
    <div class="hd"><b>超星答题助手</b><span class="ver">v${VERSION}</span><span class="status">待命</span>
      <a class="repo" href="${REPO_URL}" target="_blank" title="GitHub · AstonKrss">GitHub</a></div>
    <div class="log"></div>
    <div class="acts">
      <button class="primary" data-act="main">开始</button>
      <button data-act="stop" class="danger">停止</button>
      <button data-act="preview">只解析</button>
      <button data-act="settings">设置</button>
    </div>
    <div class="acts" style="padding-top:0;border-top:none">
      <button data-act="decode">解码预览</button>
      <button data-act="font">导出字体</button>
    </div>
    <div class="acts" style="padding-top:0;border-top:none">
      <button data-act="export">导出页面结构</button>
      <button data-act="diagnose">导出诊断</button>
    </div>
    <div class="acts" style="padding-top:0;border-top:none">
      <button data-act="clearCache" class="danger">清空题库</button>
    </div>
  </div>
  <button class="ball" title="超星答题助手">⚙<i class="dot"></i></button>
  <div class="sheet">${this.settingsTemplate()}</div>
</div>`;
  },

  settingsTemplate() {
    const cfg = Config.load();
    const quiz = cfg.quiz;
    const opts = PROVIDER_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
    return `
<div class="inner">
  <h4>接口配置</h4>
  <p class="hint">密钥只保存在你浏览器的脚本存储里，不会发往任何第三方服务器，除了你自己填的那个接口。</p>

  <label>服务商预设</label>
  <select id="f-preset">${opts}</select>
  <div id="preset-note" class="note" style="display:none"></div>

  <label>请求格式</label>
  <select id="f-protocol">
    <option value="openai">OpenAI 兼容（POST /chat/completions）</option>
    <option value="anthropic">Anthropic Messages（POST /messages）</option>
  </select>
  <p class="hint">多数中转站两种都支持，先试 OpenAI。若报 404 且确认地址没写错，再换成 Anthropic 试试。</p>

  <label>接口地址（base_url）</label>
  <input type="text" id="f-baseurl" placeholder="https://api.deepseek.com">

  <label>模型名</label>
  <div class="inline">
    <input type="text" id="f-model" list="model-list" placeholder="deepseek-chat">
    <button class="mini" id="f-fetchmodels" title="向接口查询可用模型">拉取模型</button>
  </div>
  <datalist id="model-list"></datalist>
  <select id="f-modelpick" style="display:none"></select>

  <label>API Key</label>
  <input type="password" id="f-apikey" placeholder="sk-..." autocomplete="off">

  <label class="chk"><input type="checkbox" id="f-jsonmode"> 使用 JSON 模式（response_format）</label>
  <p class="hint">部分接口不支持这个参数，会直接返回 400。遇到就把勾去掉，脚本会自动靠提示词和解析兜底。</p>

  <div class="btns" style="margin-top:10px">
    <button id="f-test">测试连接</button>
  </div>
  <div id="f-result" class="result" style="display:none"></div>

  <div class="sep"></div>
  <h4>题库优先</h4>
  <label class="chk"><input type="checkbox" id="f-bank"> 先查题库，查不到再用模型</label>
  <label class="chk"><input type="checkbox" id="f-bankbuiltin"> 使用内置题库（原脚本同款，地址和 token 已填好）</label>
  <label>题库接口地址</label>
  <input type="text" id="f-bankurl" placeholder="https://cx.icodef.com/wyn-nb?v=4">
  <label>Token</label>
  <input type="text" id="f-banktoken" placeholder="题库要求的鉴权 token">
  <p class="hint">内置题库是原脚本用的那家众包题库，返回标准答案，比模型推理准且不花 token。但它只收录众包的题，冷门课和新专题大概率查不到，查不到会自动落到模型。接口连续失败两三次会整轮停用，日志里有提示。</p>

  <div class="sep"></div>
  <h4>答题策略</h4>
  <div class="row2">
    <div>
      <label>并发数</label>
      <input type="number" id="f-conc" min="1" max="10" step="1">
    </div>
    <div>
      <label>单题超时(ms)</label>
      <input type="number" id="f-timeout" min="2000" max="60000" step="1000">
    </div>
  </div>
  <div class="row2">
    <div>
      <label>最低置信度(0-1)</label>
      <input type="number" id="f-conf" min="0" max="1" step="0.05">
    </div>
    <div>
      <label>覆盖率下限(%)</label>
      <input type="number" id="f-rate" min="0" max="100" step="5">
    </div>
  </div>
  <p class="hint">覆盖率指"成功填入答案的题数占比"，不是正确率 —— 模型答得对不对，脚本无从得知。</p>

  <label class="chk"><input type="checkbox" id="f-duration"> 补足最短作答时长（避免提交过快）</label>
  <div class="row2">
    <div>
      <label>最短作答(秒/题)</label>
      <input type="number" id="f-minsec" min="0" max="120" step="5">
    </div>
    <div>
      <label>逐题间隔(秒)</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="number" id="f-dmin" min="0" max="60" step="1">
        <span style="color:#8a9099">~</span>
        <input type="number" id="f-dmax" min="0" max="60" step="1">
      </div>
    </div>
  </div>
  <p class="hint">最短作答时长按"题数 × 秒数"算，20 题 × 25 秒 = 8 分 20 秒。脚本填得比人快得多，这一步是为了让作答时长落在合理区间。嫌久可以把秒数调小、取消这个勾，或者跑完直接点面板上的 <b>跳过等待</b>。</p>

  <label>填完之后怎么做</label>
  <select id="f-finish">
    <option value="manual">只填好，我自己保存 / 提交</option>
    <option value="save">自动保存，我自己提交（推荐）</option>
    <option value="submit">自动保存并提交</option>
  </select>
  <p class="hint">选「我自己」时脚本一个按钮都不点，答案只留在页面上，刷新就没了——适合你想先逐题检查。选「自动保存」最稳：填完先存到服务器，你复核后再手动点提交。</p>

  <label class="chk"><input type="checkbox" id="f-cache"> 使用本地题库缓存（同题不再花 token）</label>
  <label class="chk"><input type="checkbox" id="f-decodefont"> 自动解码字体加密（.font-cxsecret）</label>
  <p class="hint">页面用了字体加密时，DOM 里的文字是乱的，不解码模型就看不懂。不确定效果可以先点「解码预览」看一眼。</p>

  <div class="btns">
    <button id="f-cancel">取消</button>
    <button id="f-savecfg" class="primary">保存配置</button>
  </div>
  <p class="hint" style="margin-top:10px">已缓存 <b id="f-cachecount">0</b> 道题 · 当前版本 <b>v${VERSION}</b></p>
</div>`;
  },

  bind() {
    const q = (s) => this.shadow.querySelector(s);

    this.ballEl.addEventListener('click', () => {
      const open = this.panelEl.classList.toggle('open');
      if (open) this.sheetEl.classList.remove('open');
      this.ballEl.classList.toggle('running', false);
    });

    this.shadow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      // 主按钮：同一个按钮，动作随当前页面类型切换
      if (act === 'main') {
        if (this.pageKind === 'quiz') {
          if (typeof CoursePilot !== 'undefined' && CoursePilot.running) {
            log('自动刷课正在运行，它会自己处理作业。要手动答题请先停止刷课', 'warn');
            return;
          }
          Runner.start();
        } else {
          this.togglePilot();
        }
      }
      else if (act === 'stop') {
        // 刷课期间点「停止」，用户想停的多半是整个刷课流程
        if (typeof CoursePilot !== 'undefined' && CoursePilot.running) CoursePilot.stop();
        Runner.stop();
      }
      else if (act === 'pilot') this.togglePilot();
      else if (act === 'preview') Runner.preview();
      else if (act === 'settings') this.openSettings();
      else if (act === 'export') this.exportStructure();
      else if (act === 'diagnose') this.exportDiagnostics();
      else if (act === 'decode') this.previewDecode();
      else if (act === 'font') this.exportFont();
      else if (act === 'clearCache') {
        AnswerCache.clear();
        log('本地题库已清空', 'warn');
        this.refreshCacheCount();
      }
    });

    // 内置题库开关：勾上时地址和 token 由常量提供，输入框锁住只做展示
    q('#f-bankbuiltin').addEventListener('change', () => this.syncBankInputs());

    // 预设切换：自动填地址、模型和请求格式，并展示该厂商的注意事项
    q('#f-preset').addEventListener('change', () => {
      const p = PROVIDER_PRESETS.find((x) => x.id === q('#f-preset').value);
      if (!p) return;
      q('#f-baseurl').value = p.baseUrl;
      q('#f-model').value = p.model;
      q('#f-protocol').value = p.protocol || 'openai';
      q('#f-jsonmode').checked = p.jsonMode !== false;
      q('#model-list').innerHTML = p.models.map((m) => `<option value="${m}">`).join('');
      q('#f-modelpick').style.display = 'none';
      const note = q('#preset-note');
      if (p.note) { note.textContent = p.note; note.style.display = 'block'; }
      else note.style.display = 'none';
    });

    // 在模型下拉里选一项，直接回填到输入框
    q('#f-modelpick').addEventListener('change', () => {
      const v = q('#f-modelpick').value;
      if (v) q('#f-model').value = v;
    });

    // 拉取模型列表：中转站的模型 ID 通常带前缀（deepseek-ai/xxx），靠猜基本猜不中
    q('#f-fetchmodels').addEventListener('click', async () => {
      const btn = q('#f-fetchmodels');
      const before = btn.textContent;
      btn.textContent = '拉取中…';
      btn.disabled = true;
      this.showResult('info', '正在向接口查询模型列表…');
      try {
        // 用表单当前值，不要求先保存——边填边试才是正常流程
        const tmp = this.readProfileForm();
        const ids = await listModels(tmp, 15000);
        const pick = q('#f-modelpick');
        pick.innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
        pick.style.display = 'block';
        // 当前模型不在列表里时提示一下，多半是名字写错了
        const cur = q('#f-model').value.trim();
        if (!cur || ids.indexOf(cur) === -1) {
          q('#f-model').value = ids[0];
          this.showResult('ok', '接口返回 ' + ids.length + ' 个模型。当前填的模型不在列表里，已自动切到 ' + ids[0] + '，可在下拉框里换。');
        } else {
          this.showResult('ok', '接口返回 ' + ids.length + ' 个模型，可在下拉框里选择。');
        }
        q('#model-list').innerHTML = ids.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      } catch (e) {
        this.showResult('err', '拉取失败：' + e.message +
          (e.kind === 'network' && /404/i.test(e.message) ? '。有些网关不开放 /models，那就手动填模型名。' : ''));
      } finally {
        btn.textContent = before;
        btn.disabled = false;
      }
    });

    q('#f-cancel').addEventListener('click', () => this.sheetEl.classList.remove('open'));

    q('#f-savecfg').addEventListener('click', () => {
      const cfg = Config.load();
      const prof = cfg.profiles[cfg.activeProfileId];
      const form = this.readProfileForm();
      prof.presetId = q('#f-preset').value;
      prof.baseUrl = form.baseUrl;
      prof.model = form.model;
      prof.apiKey = form.apiKey;
      prof.protocol = form.protocol;
      prof.jsonMode = form.jsonMode;

      cfg.quiz.concurrency = clampNum(q('#f-conc').value, 1, 10, 3);
      cfg.quiz.timeoutMs = clampNum(q('#f-timeout').value, 2000, 60000, 25000);
      cfg.quiz.minConfidence = clampNum(q('#f-conf').value, 0, 1, 0.5);
      cfg.quiz.minAnswerRate = clampNum(q('#f-rate').value, 0, 100, 100);
      // 三档合成两个布尔，配置结构保持兼容（旧配置不需要迁移）
      const finishMode = q('#f-finish').value;
      cfg.quiz.autoSave = finishMode !== 'manual';
      cfg.quiz.autoSubmit = finishMode === 'submit';
      cfg.quiz.useCache = q('#f-cache').checked;
      cfg.quiz.decodeFont = q('#f-decodefont').checked;

      // 题库配置存在 cfg.bank 里，和答题策略分开
      cfg.bank.enabled = q('#f-bank').checked;
      cfg.bank.useBuiltin = q('#f-bankbuiltin').checked;
      if (cfg.bank.useBuiltin) {
        // 内置模式下地址和 token 永远是常量，不接受面板里的值，避免被误改后静默失效
        cfg.bank.endpoint = BUILTIN_BANK.endpoint;
        cfg.bank.token = BUILTIN_BANK.token;
      } else {
        cfg.bank.endpoint = q('#f-bankurl').value.trim();
        cfg.bank.token = q('#f-banktoken').value.trim();
      }
      if (cfg.bank.enabled && !cfg.bank.endpoint) {
        cfg.bank.enabled = false;
        log('题库接口地址为空，已自动关闭题库优先', 'warn');
      }
      cfg.quiz.enforceMinDuration = q('#f-duration').checked;
      cfg.quiz.minSecondsPerQuestion = clampNum(q('#f-minsec').value, 0, 120, 25);
      // 面板上以秒为单位，存配置时换算成毫秒，避免一个字段两套单位
      cfg.quiz.fillDelayMin = clampNum(q('#f-dmin').value, 0, 60, 3) * 1000;
      cfg.quiz.fillDelayMax = clampNum(q('#f-dmax').value, 0, 60, 8) * 1000;
      if (cfg.quiz.fillDelayMax < cfg.quiz.fillDelayMin) {
        cfg.quiz.fillDelayMax = cfg.quiz.fillDelayMin;
      }

      Config.save();
      log('配置已保存', 'success');
      this.sheetEl.classList.remove('open');
      this.refreshCacheCount();
      this.refreshConfigState();
    });

    q('#f-test').addEventListener('click', async () => {
      const btn = q('#f-test');
      const before = btn.textContent;
      btn.textContent = '测试中…';
      btn.disabled = true;
      // 结果必须显示在设置面板里。之前只写到日志区，而设置面板打开时日志区是收起的，
      // 用户点完什么都看不到，以为按钮坏了。
      this.showResult('info', '正在发送测试请求（问模型"中国的首都是哪座城市"）…');
      try {
        const tmp = this.readProfileForm();
        const r = await testConnection(tmp, Config.quiz);
        const ans = r.answer;
        this.showResult('ok',
          '连接成功，耗时 ' + r.elapsed + ' ms。\n' +
          '模型返回：选择 ' + JSON.stringify(ans.choice) + '，原文 ' + JSON.stringify(ans.text) +
          '，置信度 ' + ans.confidence + '\n' +
          '说明地址、密钥、模型名三项都通了，可以关掉面板去答题了。');
      } catch (e) {
        this.showResult('err', '连接失败：' + e.message + '\n' + this.diagnoseError(e, q));
      } finally {
        btn.textContent = before;
        btn.disabled = false;
      }
    });
  },

  /** 把表单上的当前值读成一个 profile 对象，供测试连接和拉取模型共用 */
  readProfileForm() {
    const q = (s) => this.shadow.querySelector(s);
    return {
      baseUrl: q('#f-baseurl').value.trim(),
      model: q('#f-model').value.trim(),
      apiKey: q('#f-apikey').value.trim(),
      protocol: q('#f-protocol').value,
      jsonMode: q('#f-jsonmode').checked,
    };
  },

  /** 在设置面板内就地显示结果 */
  showResult(kind, text) {
    const el = this.shadow && this.shadow.querySelector('#f-result');
    if (!el) return;
    el.className = 'result ' + kind;
    el.textContent = text;
    el.style.display = 'block';
  },

  /**
   * 把常见错误翻译成可操作的建议。
   * 用户看到"HTTP 400"是没法自己判断该改什么的，这里给出下一步动作。
   */
  diagnoseError(e, q) {
    const msg = String(e.message || '');
    const tips = [];
    if (/HTTP 404/.test(msg)) {
      tips.push('• 404：检查 base_url。多数接口要带 /v1 结尾；如果确认地址没错，把「请求格式」换成 Anthropic 再试。');
    }
    if (/HTTP 400/.test(msg)) {
      if (q('#f-jsonmode').checked) tips.push('• 400：先试试把「使用 JSON 模式」的勾去掉，有些接口不支持 response_format。');
      tips.push('• 400：也可能是模型名不存在，点「拉取模型」核对准确 ID。');
    }
    if (/HTTP 401|HTTP 403/.test(msg)) {
      tips.push('• 鉴权失败：Key 复制时可能带了空格或换行，重新粘一次。');
    }
    if (/超时/.test(msg)) {
      tips.push('• 超时：把「单题超时」调大到 30000，或检查网络能否访问该域名。');
    }
    if (/域名未授权|@connect/.test(msg)) {
      tips.push('• 域名未授权：脚本管理器弹窗里点「总是允许」，或重新安装脚本。');
    }
    return tips.length ? tips.join('\n') : '';
  },

  bindLog() {
    if (this._logBound) return;
    this._logBound = true;
    LogBus.on((item) => {
      if (!this.logEl) return;
      const row = document.createElement('div');
      row.className = 'row ' + item.level;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = item.time.toTimeString().slice(0, 8);
      row.appendChild(t);
      row.appendChild(document.createTextNode(item.text));
      this.logEl.appendChild(row);
      while (this.logEl.childElementCount > 300) this.logEl.removeChild(this.logEl.firstChild);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  },

  openSettings() {
    const cfg = Config.load();
    const quiz = cfg.quiz;
    const prof = cfg.profiles[cfg.activeProfileId] || Config.makeProfile('deepseek');
    const q = (s) => this.shadow.querySelector(s);

    const preset = PROVIDER_PRESETS.find((x) => x.id === prof.presetId) || PROVIDER_PRESETS[0];
    q('#f-preset').value = preset.id;
    q('#f-baseurl').value = prof.baseUrl || preset.baseUrl;
    q('#f-model').value = prof.model || preset.model;
    q('#f-apikey').value = prof.apiKey || '';
    q('#f-protocol').value = prof.protocol === 'anthropic' ? 'anthropic' : 'openai';
    q('#f-jsonmode').checked = prof.jsonMode !== false;
    q('#model-list').innerHTML = (preset.models || []).map((m) => `<option value="${m}">`).join('');
    // 上次拉取的模型列表不保留，避免和当前接口对不上
    q('#f-modelpick').innerHTML = '';
    q('#f-modelpick').style.display = 'none';
    q('#f-result').style.display = 'none';

    const note = q('#preset-note');
    if (preset.note) { note.textContent = preset.note; note.style.display = 'block'; } else note.style.display = 'none';

    q('#f-conc').value = quiz.concurrency;
    q('#f-timeout').value = quiz.timeoutMs;
    q('#f-conf').value = quiz.minConfidence;
    q('#f-rate').value = quiz.minAnswerRate;
    // 两个布尔反推三档：都不做=手动，只保存=保存，两者都开=提交
    q('#f-finish').value = quiz.autoSubmit ? 'submit' : (quiz.autoSave ? 'save' : 'manual');
    q('#f-cache').checked = !!quiz.useCache;
    q('#f-decodefont').checked = quiz.decodeFont !== false;

    const bank = cfg.bank || {};
    q('#f-bank').checked = !!bank.enabled;
    q('#f-bankbuiltin').checked = bank.useBuiltin !== false;
    q('#f-bankurl').value = bank.endpoint || BUILTIN_BANK.endpoint;
    q('#f-banktoken').value = bank.token || BUILTIN_BANK.token;
    this.syncBankInputs();
    q('#f-duration').checked = !!quiz.enforceMinDuration;
    q('#f-minsec').value = quiz.minSecondsPerQuestion;
    q('#f-dmin').value = Math.round((quiz.fillDelayMin || 0) / 1000);
    q('#f-dmax').value = Math.round((quiz.fillDelayMax || 0) / 1000);

    this.refreshCacheCount();
    this.sheetEl.classList.add('open');
    this.panelEl.classList.remove('open');
  },

  /* 内置题库模式下的输入框联动：只读展示，防止用户以为改这里能生效 */
  syncBankInputs() {
    const q = (s) => this.shadow.querySelector(s);
    const builtinEl = q('#f-bankbuiltin');
    if (!builtinEl) return;
    const on = builtinEl.checked;
    const urlEl = q('#f-bankurl');
    const tokenEl = q('#f-banktoken');
    if (on) {
      if (urlEl) urlEl.value = BUILTIN_BANK.endpoint;
      if (tokenEl) tokenEl.value = BUILTIN_BANK.token;
    }
    [urlEl, tokenEl].forEach((el) => {
      if (!el) return;
      el.readOnly = on;
      el.style.opacity = on ? '0.65' : '1';
      el.title = on ? '内置题库模式下由脚本提供，取消上面的勾选才能修改' : '';
    });
  },

  refreshCacheCount() {
    const el = this.shadow && this.shadow.querySelector('#f-cachecount');
    if (el) el.textContent = String(AnswerCache.size());
  },

  setStatus(state, text) {
    if (!this.statusEl) return;
    this.statusEl.className = 'status ' + (state || '');
    this.statusEl.textContent = text || '';
    if (this.ballEl) this.ballEl.classList.toggle('running', state === 'running');
  },

  /**
   * 字体解码预览。
   * 先让用户看「哪个字被还原成了什么」，确认靠谱再答题——
   * 解码错了会给出看起来正常但实际错误的答案，比直接跳过危险得多。
   */
  async previewDecode() {
    if (this._decoding) { log('正在解码中，别重复点', 'warn'); return; }
    const doc = (typeof Main !== 'undefined' && Main.quizDoc) ? Main.quizDoc : document;
    if (typeof FontDecoder === 'undefined') { log('字体解码模块未加载', 'error'); return; }
    if (!FontDecoder.available(doc)) {
      log('当前页面没有检测到字体加密（.font-cxsecret），不需要解码', 'info');
      return;
    }

    this._decoding = true;
    this.panelEl.classList.add('open');
    try {
      if (!FontDecoder.ready) {
        log('正在解析页面内嵌的加密字体（毫秒级，不渲染字形）', 'info');
        const ok = await FontDecoder.ensureReady(doc, (t) => this.setStatus('running', t));
        this.setStatus('idle', '待命');
        if (!ok) { log('解码失败：' + FontDecoder.failedReason, 'error'); return; }
      }

      const r = Parser.parse(doc, { decodeFont: true });
      if (!r.questions.length) { log('没解析到题目，无法预览', 'warn'); return; }

      log('字符对照（前 20 个）：' + FontDecoder.describeSamples(), 'info');
      r.questions.slice(0, 3).forEach((q, i) => {
        log('#' + (i + 1) + ' ' + truncateText(q.stem, 70), 'success');
        q.options.slice(0, 4).forEach((o) => log('    ' + o.key + '. ' + truncateText(o.text, 50), 'info'));
      });
      log('读一遍上面几句：通顺、没有「斸」「蓇」这类怪字 → 解码成功，可以直接开始答题。' +
        '如果仍是怪字连篇，说明对照表和超星当前这套字体对不上，脚本会自动停用解码' +
        '（日志里会写明命中率），此时模型会对着原始文本按上下文猜', 'warn');
    } finally {
      this._decoding = false;
    }
  },

  /* 自动刷课：同一个按钮兼做开始/停止 */
  togglePilot() {
    if (typeof CoursePilot === 'undefined') { log('自动刷课模块未加载', 'error'); return; }
    if (CoursePilot.running) {
      CoursePilot.stop();
      return;
    }
    if (!CoursePilot.available(document)) {
      log('当前页面不是课程学习页。请先进入「章节」列表，再点这个按钮', 'warn');
      return;
    }
    CoursePilot.start();
  },

  /* 导出页面内嵌的加密字体。
   *
   * 什么时候用：日志里出现「字形哈希匹配失败」或命中率过低，说明内置对照表
   * 和超星当前这套字体对不上（换了基础字体或字形轮廓变了）。这时候只有拿到
   * 真实字体才能重建对照表——这个按钮就是把字体存成文件。
   */
  exportFont() {
    const doc = (typeof Main !== 'undefined' && Main.quizDoc) ? Main.quizDoc : document;
    if (typeof FontDecoder === 'undefined') { log('字体模块未加载', 'error'); return; }

    const src = FontDecoder.extractFontSrc(FontDecoder.collectCss(doc));
    if (!src) {
      log('这个页面没有内嵌加密字体（可能本来就没加密，或字体是外链）', 'warn');
      return;
    }
    if (src.kind === 'url') {
      log('字体是外链地址，不是内嵌的：' + src.value, 'warn');
      log('把这个地址发我就可以', 'info');
      return;
    }

    const b64 = src.value;
    let bytes;
    try { bytes = base64ToBytes(b64); } catch (e) {
      log('字体数据解析失败：' + e.message, 'error');
      return;
    }

    log('字体大小 ' + Math.round(bytes.length / 1024) + ' KB', 'info');
    log('字体指纹（MD5 前 16 位）：' + md5Hex(b64).slice(0, 16), 'info');
    log('当前页面已还原 ' + ((FontDecoder.stats && FontDecoder.stats.matched) || 0) + ' 个字' +
      ((FontDecoder.stats && FontDecoder.stats.missed) ? '，' + FontDecoder.stats.missed + ' 个未收录' : ''), 'info');

    // 用 data URL 直接触发浏览器下载，不依赖 GM_download 权限
    try {
      const a = doc.createElement('a');
      a.href = 'data:application/octet-stream;base64,' + b64;
      a.download = 'cx-font.ttf';
      a.style.display = 'none';
      (doc.body || doc.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (e) { /* 忽略 */ } }, 1000);
      log('已生成 cx-font.ttf（下载目录里），把这个文件发我就能确认解码准不准', 'success');
    } catch (e) {
      log('自动下载失败：' + e.message + '。请改用「导出页面结构」把字体信息带出来', 'error');
    }
  },

  /* 判断任务清单里是否还有未完成的任务点 */
  taskCountZero(tasks) {
    return (tasks.videos.length + tasks.documents.length + tasks.works.length) === 0;
  },

  /* 把一段长文本交付给用户：控制台 + 面板文本框 + 尝试复制到剪贴板。
   * 剪贴板可能没权限，所以三条路都给，用户总能拿到一份。 */
  outputBlock(title, text, tipOk, tipFail) {
    console.log('%c[超星答题助手] ' + title, 'color:#2f6feb;font-weight:bold');
    console.log(text);

    const old = this.shadow.querySelector('textarea.dump');
    if (old) old.remove();
    const ta = document.createElement('textarea');
    ta.className = 'dump';
    ta.value = text;
    this.logEl.appendChild(ta);
    this.logEl.scrollTop = this.logEl.scrollHeight;

    let copied = false;
    try {
      ta.focus();
      ta.select();
      copied = document.execCommand('copy');
    } catch (e) { copied = false; }

    this.panelEl.classList.add('open');
    this.sheetEl.classList.remove('open');
    log(copied ? tipOk : tipFail, copied ? 'success' : 'warn');
  },

  /* 诊断：保存/提交为什么不生效。信息比「页面结构」更聚焦在这件事上。 */
  exportDiagnostics() {
    let text = '';
    try {
      text = Runner.diagnose();
    } catch (e) {
      text = '诊断失败：' + e.message + '\n' + (e.stack || '');
    }
    this.outputBlock('提交/保存诊断',
      text,
      '诊断已复制到剪贴板，发我就行（控制台里也有一份）',
      '诊断已生成，请在上方文本框里 Ctrl+A / Ctrl+C 复制（控制台里也有一份）');
  },

  exportStructure() {
    // 题目可能在 iframe 里，导出时要针对真正装着题目的那个文档
    let doc = (typeof Main !== 'undefined' && Main.quizDoc) ? Main.quizDoc : document;
    let text = '';
    try {
      text = Parser.dumpStructure(doc);
    } catch (e) {
      text = '导出失败：' + e.message + '\n' + (e.stack || '');
    }

    // 定位的文档里没有题，就到所有 iframe（含深层）里找——
    // 作业藏在 iframe 深处时，直接导出会得出"没有题目"的错误结论。
    if (/最终采用:\s*无/.test(text) && typeof Main !== 'undefined' && typeof Main.collectDocs === 'function') {
      try {
        for (const d of Main.collectDocs()) {
          try {
            if (d === doc) continue;
            const r = Parser.parse(d, { decodeFont: false });
            if (r.questions.length) {
              text = '=== 说明：题目在 iframe 深处，已自动定位到装题的文档 ===\n\n' + Parser.dumpStructure(d);
              break;
            }
          } catch (e) { /* 忽略 */ }
        }
      } catch (e) { /* 忽略 */ }
    }

    // 顺手把本节的任务清单（mArg）附上：用户在课程页导出时，答题文档还不存在，
    // 但任务清单是现成的——这节能不能自动处理，看它就知道
    try {
      if (typeof CoursePilot !== 'undefined' && CoursePilot.findMarg) {
        const marg = CoursePilot.findMarg(window);
        if (marg) {
          const tasks = CoursePilot.parseTasks(marg);
          const nm = (it) => (it.property && (it.property.name || it.property.title)) || '(无名)';
          text += '\n\n=== 本节任务清单（来自 mArg）===\n';
          text += '待办：视频 ' + tasks.videos.length + '、文档 ' + tasks.documents.length +
            '、作业 ' + tasks.works.length + '；另有已完成任务点 ' + (tasks.totalJobs - tasks.videos.length - tasks.documents.length - tasks.works.length) + ' 个\n';
          for (const v of tasks.videos) text += '  [视频] ' + nm(v) + (v.isPassed ? '（已完成）' : '') + '\n';
          for (const d2 of tasks.documents) text += '  [文档] ' + nm(d2) + (d2.isPassed ? '（已完成）' : '') + '\n';
          for (const wk of tasks.works) text += '  [作业] ' + nm(wk) + (wk.isPassed ? '（已完成）' : '') + '\n';
          if (taskCountZero(tasks)) text += '  （本节没有未完成的任务点）\n';
        } else {
          text += '\n\n=== 本节任务清单（来自 mArg）===\n（没有找到任务清单，可能是老版页面或纯阅读节）\n';
        }
      }
    } catch (e) { /* 附加失败不影响主体导出 */ }

    this.outputBlock('页面结构导出',
      text,
      '页面结构已复制到剪贴板，直接发我就行（内容也打到了控制台）',
      '已生成页面结构，请在上方文本框里 Ctrl+A、Ctrl+C 复制（控制台里也有一份）');
  },
};

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
