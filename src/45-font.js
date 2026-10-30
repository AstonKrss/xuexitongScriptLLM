/* ============================================================
 * 45-font.js —— 超星字体加密解码（v3：解析字形轮廓，不再是位图猜测）
 *
 * ---------- 加密原理 ----------
 * 超星把「思源黑体」的码位和字形重新映射了一遍：让 U+602E 这个码位指向
 * 「新」的字形。浏览器用这份字体渲染，人看到的是正常文字，而 DOM 里存的
 * 还是「怮」。
 *
 * 关键点：**字形本身没有改**，只是被挂到了别的码位下。
 *
 * ---------- 解法 ----------
 * 1. 字体就内嵌在页面里：<style id="cxSecretStyle"> 的 @font-face，
 *    src 是 base64 的 TTF；
 * 2. 用 Typr 解析 TTF，对每个字符取出 glyph 的轮廓路径；
 * 3. 轮廓路径 JSON 序列化后做 MD5，取末尾 8 位十六进制；
 * 4. 拿这个哈希去查预置对照表（06-cx-table.js），得到真实汉字。
 *
 * 哈希只取决于字形，与字体文件里的码位分配无关，所以**一张表通吃所有页面**——
 * 每页的字体文件都不同（大小、SHA-256 全变），但同一个汉字的哈希永远一样。
 * 这是这个方案比位图比对根本性更好的地方。
 *
 * ---------- v2 的教训 ----------
 * 之前用 canvas 把字渲染成位图，再和两万个汉字比对。两处致命问题：
 *   1. 参照字体必须和加密字体同源（都得是宋体），取错了连明文都被改成近形字；
 *   2. 12×12 网格丢掉太多细节，宋体近形字（己/已/巳）本来就分不开。
 * 结果是「看起来正常、实际错误」的答案——比不解码更危险。整段已删除。
 * ============================================================ */

/* ---------- MD5 ----------
 * 只需要十六进制输出。自己实现是为了不引入依赖，代码量也不大。
 */

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function md5Hex(str) {
  const bytes = utf8Bytes(String(str));
  const bitLen = bytes.length * 8;
  // 补 0x80 后补齐到 56 (mod 64)，末尾 8 字节放比特长度
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = MD5_S[i];
      B = (B + (((F << s) | (F >>> (32 - s))) | 0)) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}

function hexLE(n) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const b = (n >>> (i * 8)) & 0xff;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      const c2 = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
      out.push(0xf0 | (c2 >> 18), 0x80 | ((c2 >> 12) & 63), 0x80 | ((c2 >> 6) & 63), 0x80 | (c2 & 63));
    }
  }
  return out;
}

/* ---------- base64 ---------- */

function base64ToBytes(b64) {
  const s = String(b64).replace(/[\s\r\n]+/g, '');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- 解码器 ---------- */

const FontDecoder = {
  ready: false,
  giveUp: false,        // 表不匹配时置 true，本次会话不再重试
  building: null,
  map: null,            // 加密码位字符 -> 真实字符
  failedReason: '',
  samples: [],
  stats: null,          // { chars, matched, missed, notInFont }
  lastMs: 0,

  /* ---------- 找字体 ---------- */

  /** 把页面里所有 CSS 文本拼起来（<style> 元素 + 同源样式表） */
  collectCss(doc) {
    let css = '';
    try {
      for (const s of Array.from(doc.querySelectorAll('style') || [])) {
        css += '\n' + (s.textContent || '');
      }
    } catch (e) { /* 忽略 */ }
    // 有些页面用 link 引样式，只能走 CSSOM（跨域会抛错，逐条兜住）
    try {
      for (const sheet of Array.from(doc.styleSheets || [])) {
        let rules = null;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (rule.cssText && /font-cxsecret/i.test(rule.cssText)) css += '\n' + rule.cssText;
        }
      }
    } catch (e) { /* 忽略 */ }
    return css;
  },

  /**
   * 从 CSS 里找出 font-cxsecret 那张 @font-face 的 src。
   * 超星的标准写法是 <style id="cxSecretStyle"> 内嵌 base64，也见过外链 woff，
   * 两种都认。
   * @returns {{kind:'base64'|'url', value:string}|null}
   */
  extractFontSrc(cssText) {
    if (!cssText) return null;
    // 廉价预筛：既没有 @font-face 也没有 base64 字体的样式表不值得跑正则
    if (cssText.indexOf('@font-face') < 0 && cssText.indexOf('base64') < 0) return null;

    if (cssText.indexOf('font-cxsecret') >= 0) {
      const blocks = cssText.match(/@font-face\s*\{[^}]*\}/gi) || [];
      for (const block of blocks) {
        if (!/font-cxsecret/i.test(block)) continue;
        const srcM = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(block);
        if (!srcM) continue;
        const url = srcM[1];
        const b64 = /^data:[^,]*;base64,(.*)$/i.exec(url);
        if (b64) return { kind: 'base64', value: b64[1] };
        if (/^https?:/i.test(url)) return { kind: 'url', value: url };
      }
    }
    // 兜底：改名了也能认出来。整段 CSS 里直接找字体 data URL。
    const loose = /data:(?:application|font)\/[\w.+-]*(?:font|ttf|otf)[\w.+-]*(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)/i.exec(cssText);
    if (loose) return { kind: 'base64', value: loose[1] };
    return null;
  },

  /** 注意：不能只看有没有 .font-cxsecret 这个 class。
   *  医学英语这类页面会挂 class 但根本没定义字体，文字本来就是明文。 */
  available(doc) {
    return !!this.extractFontSrc(this.collectCss(doc || document));
  },

  /** 页面上真正带 font-cxsecret 的字符集合 */
  collectEncryptedChars(doc) {
    const set = new Set();
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll('.font-cxsecret, [class*="cxsecret"]'));
    } catch (e) { return set; }
    for (const n of nodes) {
      for (const ch of (n.textContent || '')) set.add(ch);
    }
    return set;
  },

  /* ---------- 构建 ---------- */

  ensureReady(doc, onProgress) {
    doc = doc || document;
    if (this.giveUp) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.building) return this.building;

    const report = (t) => {
      if (typeof onProgress === 'function') { try { onProgress(t); } catch (e) { /* 忽略 */ } }
    };
    const src = this.extractFontSrc(this.collectCss(doc));
    if (!src) {
      this.failedReason = '页面里没有 font-cxsecret 字体（这页可能本来就没加密）';
      return Promise.resolve(false);
    }

    this.building = (async () => {
      const t0 = Date.now();
      report('读取字体…');
      let bytes;
      try {
        bytes = src.kind === 'base64' ? base64ToBytes(src.value) : await this.fetchFont(src.value);
      } catch (e) {
        this.failedReason = '读取字体失败：' + e.message;
        this.building = null;
        return false;
      }
      if (!bytes || !bytes.length) {
        this.failedReason = '字体数据为空';
        this.building = null;
        return false;
      }

      report('解析字形…');
      let ok = false;
      try {
        ok = this.buildMap(bytes, doc, report);
      } catch (e) {
        this.failedReason = '解码异常：' + e.message;
      }
      this.building = null;
      this.lastMs = Date.now() - t0;
      if (ok) this.ready = true;
      return ok;
    })();

    return this.building;
  },

  fetchFont(url) {
    return new Promise((resolve, reject) => {
      gmRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: 15000,
        onload(res) {
          if (res.status !== 200) return reject(new Error('HTTP ' + res.status));
          const raw = res.response;
          if (raw instanceof ArrayBuffer) return resolve(new Uint8Array(raw));
          if (raw && raw.buffer) return resolve(new Uint8Array(raw.buffer));
          resolve(base64ToBytes(String(res.responseText || '')));
        },
        onerror() { reject(new Error('网络错误')); },
        ontimeout() { reject(new Error('超时')); },
      });
    });
  },

  /**
   * 解析字体并建立「假字 → 真字」映射。
   * 只处理页面上真正出现过的字符——没必要遍历整个 cmap，超星字体也只收录
   * 这一页用到的字。
   */
  buildMap(bytes, doc, report) {
    if (typeof Typr === 'undefined' || !Typr.parse) {
      this.failedReason = '字体解析库未加载';
      return false;
    }
    let font;
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const fonts = Typr.parse(ab);
      font = fonts && fonts[0];
    } catch (e) {
      this.failedReason = '解析字体失败：' + e.message + '（若是 woff2 暂不支持）';
      return false;
    }
    if (!font) {
      this.failedReason = '字体解析结果为空';
      return false;
    }

    const chars = Array.from(this.collectEncryptedChars(doc));
    const table = getCxGlyphMap();
    const extra = gmGet("llmq:glyphExtra", {}) || {};
    const map = new Map();
    let matched = 0;
    let missed = 0;
    let notInFont = 0;
    const missedList = [];

    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      let gid = 0;
      try { gid = Typr.U.codeToGlyph(font, cp); } catch (e) { gid = 0; }
      if (!gid) { notInFont++; continue; }   // 这个字不在字体里，说明没被替换

      let path;
      try { path = Typr.U.glyphToPath(font, gid); } catch (e) { continue; }
      const key = md5Hex(JSON.stringify(path)).slice(24);
      // 先查内置对照表，再查用户扩展表（视觉模型识别成功后写入并持久化）
      const real = table.get(key) || (extra[key] || null);
      if (real) {
        const to = String.fromCharCode(real);
        map.set(ch, to);
        matched++;
        if (this.samples.length < 40) this.samples.push({ from: ch, to: to });
      } else {
        missed++;
        missedList.push({ key: key, ch: ch });
      }
    }

    this.stats = { chars: chars.length, matched: matched, missed: missed, notInFont: notInFont };
    this.missedGlyphs = missedList;
    this.fontBytes = bytes;
    this.map = map;

    // 一个都查不到 → 表和这套字体对不上（超星换了字形，或表版本过旧）
    if (matched === 0 && missed > 0) {
      this.giveUp = true;
      this.failedReason = '字形哈希匹配失败：' + missed + ' 个字一个都没查到，' +
        '可能是超星更换了字体或对照表版本过旧';
      return false;
    }
    // 命中率过低同样不可信：一半解不出、解出来的另一半也可能是错的
    if (missed > 0 && matched / (matched + missed) < 0.6) {
      this.giveUp = true;
      this.failedReason = '字形哈希命中率过低（' + matched + '/' + (matched + missed) +
        '），判定对照表与当前字体不匹配，已停用解码';
      return false;
    }

    report('完成');
    if (matched) {
      // 这里不打印耗时：lastMs 由 ensureReady 在返回前赋值，此刻还是 0
      log('字体解码就绪：' + matched + ' 个字已还原（字形哈希匹配）' +
        (missed ? '，' + missed + ' 个未收录' : ''), 'success');
    } else {
      log('页面虽然有 font-cxsecret 标记，但文字没有被替换，无需解码', 'info');
    }
    return true;
  },

  /* ---------- 视觉模型识别未收录字形 ----------
   * 原理：解码表没收录的字形，用 FontFace API 把加密字体挂到文档上，
   * 把乱码字符渲染成小图，发给多模态模型认字——模型看到的就是
   * 用户屏幕上看到的字形。识别结果写进扩展对照表并持久化，
   * 以后所有页面遇到同一字形直接查表，不再重复请求。 */

  /** 把乱码字符渲染成 png dataURL。需要先用 loadFontFace 挂好字体 */
  glyphImageDataUrl(ch, size) {
    size = size || 96;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    ctx.font = Math.floor(size * 0.72) + 'px cx-llmq-glyph';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, size / 2, size / 2);
    return c.toDataURL('image/png');
  },

  /** 用 FontFace 把解码用的字体字节挂到当前文档（幂等） */
  async loadFontFace() {
    if (this._ffLoaded) return true;
    if (!this.fontBytes || !this.fontBytes.length) return false;
    try {
      const ab = this.fontBytes.buffer.slice(this.fontBytes.byteOffset, this.fontBytes.byteOffset + this.fontBytes.byteLength);
      const ff = new FontFace('cx-llmq-glyph', ab);
      await ff.load();
      document.fonts.add(ff);
      this._ffLoaded = true;
      return true;
    } catch (e) {
      log('挂载加密字体失败：' + e.message, 'warn');
      return false;
    }
  },

  /**
   * 把未收录字形发给视觉模型认字，识别成功写入扩展对照表并持久化。
   * @param {object} opts { model, baseUrl, apiKey, onProgress }
   * @returns {Promise<{identified:number, failed:number}>}
   */
  async identifyMissedGlyphs(opts) {
    opts = opts || {};
    const missed = this.missedGlyphs || [];
    if (!missed.length) return { identified: 0, failed: 0 };
    if (!opts.model) return { identified: 0, failed: missed.length };
    if (!(await this.loadFontFace())) return { identified: 0, failed: missed.length };

    const extra = gmGet('llmq:glyphExtra', {}) || {};
    let identified = 0, failed = 0;

    for (let i = 0; i < missed.length; i++) {
      if (this.stopGlyphScan) break;
      const g = missed[i];
      if (extra[g.key]) { identified++; continue; }   // 以前识别过的直接用
      try {
        const dataUrl = this.glyphImageDataUrl(g.ch);
        const code = await new Promise((resolve) => {
          gmRequest({
            method: 'POST',
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + (opts.apiKey || ''),
            },
            data: JSON.stringify({
              model: opts.model,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: '图中是一个中文汉字（可能是生僻字或常用字）。只回答这一个汉字本身，不要解释、不要标点。' },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              }],
              temperature: 0,
            }),
            onload(res) {
              try {
                const j = JSON.parse(res.responseText);
                const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
                // 模型不一定守规矩：可能回「是【党】。」或「答案：党」。
                // 先剥掉括号标点，再去掉开头的"是/答案/答"，最后取第一个汉字——
                // 直接取第一个汉字会把"是"当成识别结果（真实踩过的坑）。
                const cleaned = text
                  .replace(/[\s【】（）()。．.,，:：;；、'"“”·—-]/g, '')
                  .replace(/^(?:答案是|是|答案|答)/, '');
                const m = cleaned.match(/[\u4e00-\u9fa5]/);
                const ch = m ? m[0] : null;
                resolve(ch || null);
              } catch (e) { resolve(null); }
            },
            onerror() { resolve(null); },
            ontimeout() { resolve(null); },
          });
        });
        if (code) {
          const cp = code.codePointAt(0);
          const real = String.fromCharCode(cp);
          this.map.set(g.ch, real);
          extra[g.key] = cp;
          gmSet('llmq:glyphExtra', extra);
          identified++;
          if (this.samples.length < 40) this.samples.push({ from: g.ch, to: real });
          log('视觉识别：' + g.ch + ' → ' + real + '（已写入本地对照表）', 'success');
        } else {
          failed++;
          log('视觉模型没能认出字形 ' + g.ch, 'warn');
        }
      } catch (e) {
        failed++;
        log('字形识别异常：' + e.message, 'warn');
      }
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress((i + 1) + '/' + missed.length); } catch (e) { /* 忽略 */ }
      }
    }
    this.stats.missed = Math.max(0, missed.length - identified);
    return { identified: identified, failed: failed };
  },

  /* ---------- 对外 ---------- */

  /** 纯查表，同步瞬时 */
  decode(text) {
    if (!text || typeof text !== 'string') return text;
    if (!this.ready || !this.map || !this.map.size) return text;
    let out = '';
    for (const ch of text) {
      const hit = this.map.get(ch);
      out += (hit === undefined ? ch : hit);
    }
    return out;
  },

  describeSamples() {
    if (!this.samples.length) return '没有发现需要还原的字（这页可能没加密）';
    return this.samples.slice(0, 20).map((p) => p.from + '→' + p.to).join('  ');
  },

  /** 给「导出结构」用的一句话摘要 */
  summary() {
    if (!this.ready) return this.failedReason || '未启用';
    const s = this.stats;
    if (!s) return '已就绪';
    return '还原 ' + s.matched + ' 个字，' + s.notInFont + ' 个本身未加密' +
      (s.missed ? '，' + s.missed + ' 个对照表里没有' : '');
  },
};
