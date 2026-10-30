// ==UserScript==
// @name         超星答题助手 · 自建 LLM 题库
// @namespace    https://github.com/AstonKrss/xuexitongScriptLLM
// @version      1.6.5
// @description  用你自己的大模型 API 自动作答超星章节测试与作业，并按课程任务清单自动刷视频/文档/切下一节。支持 DeepSeek、智谱 GLM、通义千问、Kimi 及任意 OpenAI 兼容接口。答案本地缓存，同一道题只花一次 token。
// @author       AstonKrss
// @license      MIT
// @homepageURL  https://github.com/AstonKrss/xuexitongScriptLLM
// @supportURL   https://github.com/AstonKrss/xuexitongScriptLLM/issues
// @source       https://github.com/AstonKrss/xuexitongScriptLLM
// @run-at       document-end
// @match        *://*.chaoxing.com/*
// @match        *://chaoxing.com/*
// @match        *://*.edu.cn/*
// @match        *://*.nbdlib.cn/*
// @match        *://*.hnsyu.net/*
// @match        *://*.ac.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==
// 生成文件，请勿直接编辑。修改 src/ 下的模块后运行 node build.js 重新生成。
(function () {
'use strict';


/* ============================================================
 * 00-core.js
 * ============================================================ */
/* ============================================================
 * 00-core.js —— 全局工具、存储封装、日志总线
 * 约定：本文件不依赖任何其他模块，必须最先加载。
 * ============================================================ */

// 版本号唯一来源是 header.txt 里的 @version，由 build.js 在构建时注入到这里。
// 不要在这个文件里硬编码版本号——之前两处各写一遍，结果改了一处忘了另一处，
// 用户看到的版本号和文档里写的对不上。
const VERSION = '1.6.5';
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


/* ============================================================
 * 05-lib-typr.js
 * ============================================================ */
/* ============================================================
 * 05-lib-typr.js —— Typr.js（字体解析库，原样内联）
 *
 * 来源: https://github.com/photopea/Typr.js  src/Typr.js + src/Typr.U.js
 * 许可: MIT (Photopea)
 *
 * 为什么要内联一个 97KB 的库：
 * 超星的字体加密本质是把思源黑体的码位打乱，要还原就必须解析 TTF 的
 * cmap/glyf 表并取出字形轮廓。自己写一个能精确复现轮廓数据的解析器
 * 风险远大于引入一个被广泛使用的库。
 *
 * 只在 45-font.js 里通过全局 Typr 使用，不要改这个文件的内容。
 * ============================================================ */
var Typr = {};

Typr["parse"] = function(buff)
{
	var bin = Typr["B"];
	
	var readFont = function(data, offset,tmap) {
		var T = Typr["T"];
		var prsr = {
			"cmap":T.cmap,
			"head":T.head,
			"hhea":T.hhea,
			"maxp":T.maxp,
			"hmtx":T.hmtx,
			"name":T.name,
			"OS/2":T.OS2,
			"post":T.post,
			
			"loca":T.loca,
			"kern":T.kern,
			"glyf":T.glyf,
			
			"CFF ":T.CFF,
			/*
			"GPOS",
			"GSUB",
			"GDEF",*/
			"GSUB":T.GSUB,
			"CBLC":T.CBLC,
			"CBDT":T.CBDT,
			
			"SVG ":T.SVG,
			"COLR":T.colr,
			"CPAL":T.cpal,
			"sbix":T.sbix,
			
			"fvar":T.fvar,
			"gvar":T.gvar,
			"avar":T.avar,
			"HVAR":T.HVAR
			//"VORG",
		};
		var obj = {"_data":data, "_index":0, "_vindex":0, "_offset":offset};
		
		for(var t in prsr) {
			var tab = Typr["findTable"](data, t, offset);
			if(tab) {
				var off=tab[0], tobj = tmap[off];
				if(tobj==null) tobj = prsr[t].parseTab(data, off, tab[1], obj);
				obj[t] = tmap[off] = tobj;
			}
		}
		return obj;
	}
	function readFONT(data, offset, idx, tmap, out) {
		var fnt = readFont(data, offset,{});  fnt["_index"] = idx;  
		var fvar = fnt["fvar"];
		if(fvar) {
			for(var i=0; i<fvar[1].length; i++) {
				var fv = fvar[1][i];
				var obj = {};  out.push(obj);  for(var p in fnt) obj[p]=fnt[p];  
				obj["_vindex"]=i;
				var name = obj["name"]=JSON.parse(JSON.stringify(obj["name"]));
				name["fontSubfamily"] = name["typoSubfamilyName"] = fv[0];
				if(fv[3]==null) fv[3]=(name["fontFamily"]+"-"+name["fontSubfamily"])["replaceAll"](" ","");
				else fv[3]=name["_"+fv[3]];
				name["postScriptName"]=fv[3];
			}
		}
		else out.push(fnt);
	}
	
	function woffToOtf(data) {
		var numTables = bin.readUshort(data,12);
		var totalSize = bin.readUint  (data,16);
		
		var otf = new Uint8Array(totalSize), toff = 12+numTables*16;
		
		bin.writeASCII (otf, 0, "OTTO");
		bin.writeUshort(otf, 4, numTables);
		
		var off = 44;
		for(var i=0; i<numTables; i++) {
			var tag = bin.readASCII(data,off,4);
			var tof = bin.readUint(data,off+4);
			var cLe = bin.readUint(data,off+8);
			var oLe = bin.readUint(data,off+12);
			off+=20;
			//console.log(i, ":::", tag,tof,oLe);
			
			var tab = data.slice(tof,tof+cLe);
			if(cLe!=oLe) tab = pako["inflate"](tab);
			
			var to=12+i*16;
			bin.writeASCII(otf,to   ,tag);
			bin.writeUint (otf,to+ 8,toff);
			bin.writeUint (otf,to+12,oLe );  
			
			otf.set(tab,toff);  toff+=oLe;
		}
		//console.log(otf);  
		return otf;
	}
	
	
	var data = new Uint8Array(buff);
	if(data[0]==0x77) data = woffToOtf(data);
	
	var out = [];
	var tmap = {};
	var tag = bin.readASCII(data, 0, 4);  
	if(tag=="ttcf") {
		var offset = 4;
		var majV = bin.readUshort(data, offset);  offset+=2;
		var minV = bin.readUshort(data, offset);  offset+=2;
		var numF = bin.readUint  (data, offset);  offset+=4;
		for(var i=0; i<numF; i++) {
			var foff = bin.readUint  (data, offset);  offset+=4;
			readFONT(data,foff,i, tmap, out);
		}
	}
	else readFONT(data, 0, 0, tmap, out);
	
	// console.log(out);  // 本项目注释：上游留的调试输出，会把整个字体对象刷到控制台
	return out;
}


Typr["findTable"] = function(data, tab, foff)
{
	var bin = Typr["B"];
	var numTables = bin.readUshort(data, foff+4);
	var offset = foff+12;
	for(var i=0; i<numTables; i++)
	{
		var tag      = bin.readASCII(data, offset, 4);   //console.log(tag);
		var checkSum = bin.readUint (data, offset+ 4);
		var toffset  = bin.readUint (data, offset+ 8); 
		var length   = bin.readUint (data, offset+12);
		if(tag==tab) return [toffset,length];
		offset+=16;
	}
	return null;
}
/*
Typr["splitBy"] = function(data,tag) {
	data = new Uint8Array(data);  console.log(data.slice(0,64));
	var bin = Typr["B"];
	var ttcf = bin.readASCII(data, 0, 4);  if(ttcf!="ttcf") return {};
	
	var offset = 8;
	var numF = bin.readUint  (data, offset);  offset+=4;
	var colls = [], used={};
	for(var i=0; i<numF; i++) {
		var foff = bin.readUint  (data, offset);  offset+=4;
		var toff = Typr["findTable"](data,tag,foff)[0];
		if(used[toff]==null) used[toff] = [];
		used[toff].push([foff,bin.readUshort(data,foff+4)]);  // font offset, numTables
	}
	for(var toff in used) {
		var offs = used[toff];
		var hlen = 12+4*offs.length;
		var out = new Uint8Array(hlen);		
		for(var i=0; i<8; i++) out[i]=data[i];
		bin.writeUint(out,8,offs.length);
		
		for(var i=0; i<offs.length; i++) hlen += 12+offs[i][1]*16;
		
		var hdrs = [out], tabs = [], hoff=out.length, toff=hlen, noffs={};
		for(var i=0; i<offs.length; i++) {
			bin.writeUint(out, 12+i*4, hoff);  hoff+=12+offs[i][1]*16;
			toff = Typr["_cutFont"](data, offs[i][0], hdrs, tabs, toff, noffs);
		}
		colls.push(Typr["_joinArrs"](hdrs.concat(tabs)));
	}
	return colls;
}

Typr["splitFonts"] = function(data) {
	data = new Uint8Array(data);
	var bin = Typr["B"];
	var ttcf = bin.readASCII(data, 0, 4);  if(ttcf!="ttcf") return {};
	
	var offset = 8;
	var numF = bin.readUint  (data, offset);  offset+=4;
	var fnts = [];
	for(var i=0; i<numF; i++) {
		var foff = bin.readUint  (data, offset);  offset+=4;
		fnts.push(Typr._cutFont(data, foff));
		break;
	}
	return fnts;
}

Typr["_cutFont"] = function(data,foff,hdrs,tabs,toff, noffs) {
	var bin = Typr["B"];
	var numTables = bin.readUshort(data, foff+4);
	
	var out = new Uint8Array(12+numTables*16);  hdrs.push(out);
	for(var i=0; i<12; i++) out[i]=data[foff+i];  //console.log(out);
	
	var off = 12;
	for(var i=0; i<numTables; i++)
	{
		var tag      = bin.readASCII(data, foff+off, 4); 
		var checkSum = bin.readUint (data, foff+off+ 4);
		var toffset  = bin.readUint (data, foff+off+ 8); 
		var length   = bin.readUint (data, foff+off+12);
		
		while((length&3)!=0) length++;
		
		for(var j=0; j<16; j++) out[off+j]=data[foff+off+j];
		
		if(noffs[toffset]!=null) bin.writeUint(out,off+8,noffs[toffset]);
		else {
			noffs[toffset] = toff;
			bin.writeUint(out, off+8, toff);  
			tabs.push(new Uint8Array(data.buffer, toffset, length));  toff+=length;
		}
		off+=16;
	}
	return toff;
}
Typr["_joinArrs"] = function(tabs) {
	var len = 0;
	for(var i=0; i<tabs.length; i++) len+=tabs[i].length;
	var out = new Uint8Array(len), ooff=0;
	for(var i=0; i<tabs.length; i++) {
		var tab = tabs[i];
		for(var j=0; j<tab.length; j++) out[ooff+j]=tab[j];
		ooff+=tab.length;
	}
	return out;
}
*/

Typr["T"]={};





Typr["B"] = {
	readFixed : function(data, o)
	{
		return Typr["B"].readShort(data,o) +  (((data[o+2]<<8)|data[o+3])/(256*256+4));
	},
	readF2dot14 : function(data, o)
	{
		var num = Typr["B"].readShort(data, o);
		return num / 16384;
	},
	readInt : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr["B"].t.uint8;
		a[0] = buff[p+3];
		a[1] = buff[p+2];
		a[2] = buff[p+1];
		a[3] = buff[p];
		return Typr["B"].t.int32[0];
	},
	
	readInt8 : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr["B"].t.uint8;
		a[0] = buff[p];
		return Typr["B"].t.int8[0];
	},
	readShort : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr["B"].t.uint16;
		a[0] = (buff[p]<<8) | buff[p+1];
		return Typr["B"].t.int16[0];
	},
	readUshort : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		return (buff[p]<<8) | buff[p+1];
	},
	writeUshort : function(buff, p, n)
	{
		buff[p] = (n>>8)&255;  buff[p+1] = n&255;
	},
	readUshorts : function(buff, p, len)
	{
		var arr = [];
		for(var i=0; i<len; i++) {
			var v = Typr["B"].readUshort(buff, p+i*2);  //if(v==932) console.log(p+i*2);
			arr.push(v);
		}
		return arr;
	},
	readUint : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr["B"].t.uint8;
		a[3] = buff[p];  a[2] = buff[p+1];  a[1] = buff[p+2];  a[0] = buff[p+3];
		return Typr["B"].t.uint32[0];
	},
	writeUint: function(buff, p, n)
	{
		buff[p] = (n>>24)&255;  buff[p+1] = (n>>16)&255;  buff[p+2] = (n>>8)&255;  buff[p+3] = (n>>0)&255;
	},
	readUint64 : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		return (Typr["B"].readUint(buff, p)*(0xffffffff+1)) + Typr["B"].readUint(buff, p+4);
	},
	readASCII : function(buff, p, l)	// l : length in Characters (not Bytes)
	{
		//if(p>=buff.length) throw "error";
		var s = "";
		for(var i = 0; i < l; i++) s += String.fromCharCode(buff[p+i]);
		return s;
	},
	writeASCII : function(buff, p, s)	// l : length in Characters (not Bytes)
	{
		for(var i = 0; i < s.length; i++)	
			buff[p+i] = s.charCodeAt(i);
	},
	readUnicode : function(buff, p, l)
	{
		//if(p>=buff.length) throw "error";
		var s = "";
		for(var i = 0; i < l; i++)	
		{
			var c = (buff[p++]<<8) | buff[p++];
			s += String.fromCharCode(c);
		}
		return s;
	},
	_tdec : window["TextDecoder"] ? new window["TextDecoder"]() : null,
	readUTF8 : function(buff, p, l) {
		var tdec = Typr["B"]._tdec;
		if(tdec && p==0 && l==buff.length) return tdec["decode"](buff);
		return Typr["B"].readASCII(buff,p,l);
	},
	readBytes : function(buff, p, l)
	{
		//if(p>=buff.length) throw "error";
		var arr = [];
		for(var i=0; i<l; i++) arr.push(buff[p+i]);
		return arr;
	},
	readASCIIArray : function(buff, p, l)	// l : length in Characters (not Bytes)
	{
		//if(p>=buff.length) throw "error";
		var s = [];
		for(var i = 0; i < l; i++)	
			s.push(String.fromCharCode(buff[p+i]));
		return s;
	}, 
	t : function() {
		var ab = new ArrayBuffer(8);
		return {
			buff   : ab,
			int8   : new Int8Array  (ab),
			uint8  : new Uint8Array (ab),
			int16  : new Int16Array (ab),
			uint16 : new Uint16Array(ab),
			int32  : new Int32Array (ab),
			uint32 : new Uint32Array(ab)
		}  
	}()
};






	Typr["T"].CFF = {
		parseTab : function(data, offset, length)
		{
			var bin = Typr["B"];
			var CFF = Typr["T"].CFF;
			
			data = new Uint8Array(data.buffer, offset, length);
			offset = 0;
			
			// Header
			var major = data[offset];  offset++;
			var minor = data[offset];  offset++;
			var hdrSize = data[offset];  offset++;
			var offsize = data[offset];  offset++;
			//console.log(major, minor, hdrSize, offsize);
			
			// Name INDEX
			var ninds = [];
			offset = CFF.readIndex(data, offset, ninds);
			var names = [];
			
			for(var i=0; i<ninds.length-1; i++) names.push(bin.readASCII(data, offset+ninds[i], ninds[i+1]-ninds[i]));
			offset += ninds[ninds.length-1];
			
			
			// Top DICT INDEX
			var tdinds = [];
			offset = CFF.readIndex(data, offset, tdinds);  //console.log(tdinds);
			// Top DICT Data
			var topDicts = [];
			for(var i=0; i<tdinds.length-1; i++) topDicts.push( CFF.readDict(data, offset+tdinds[i], offset+tdinds[i+1]) );
			offset += tdinds[tdinds.length-1];
			var topdict = topDicts[0];
			//console.log(topdict);
			
			// String INDEX
			var sinds = [];
			offset = CFF.readIndex(data, offset, sinds);
			// String Data
			var strings = [];
			for(var i=0; i<sinds.length-1; i++) strings.push(bin.readASCII(data, offset+sinds[i], sinds[i+1]-sinds[i]));
			offset += sinds[sinds.length-1];
			
			// Global Subr INDEX  (subroutines)		
			CFF.readSubrs(data, offset, topdict);
			
			// charstrings
			
			if(topdict["CharStrings"]) topdict["CharStrings"] = CFF.readBytes(data, topdict["CharStrings"]);
			
			// CID font
			if(topdict["ROS"]) {
				offset = topdict["FDArray"];
				var fdind = [];
				offset = CFF.readIndex(data, offset, fdind);
				
				topdict["FDArray"] = [];
				for(var i=0; i<fdind.length-1; i++) {
					var dict = CFF.readDict(data, offset+fdind[i], offset+fdind[i+1]);
					CFF._readFDict(data, dict, strings);
					topdict["FDArray"].push( dict );
				}
				offset += fdind[fdind.length-1];
				
				offset = topdict["FDSelect"];
				topdict["FDSelect"] = [];
				var fmt = data[offset];  offset++;
				if(fmt==3) {
					var rns = bin.readUshort(data, offset);  offset+=2;
					for(var i=0; i<rns+1; i++) {
						topdict["FDSelect"].push(bin.readUshort(data, offset), data[offset+2]);  offset+=3;
					}
				}
				else throw fmt;
			}
			
			// Encoding
			//if(topdict["Encoding"]) topdict["Encoding"] = CFF.readEncoding(data, topdict["Encoding"], topdict["CharStrings"].length);
			
			// charset
			if(topdict["charset"] ) topdict["charset"]  = CFF.readCharset (data, topdict["charset"] , topdict["CharStrings"].length);
			
			CFF._readFDict(data, topdict, strings);
			return topdict;
		},
		
		_readFDict : function(data, dict, ss) {
			var CFF = Typr["T"].CFF;
			var offset;
			if(dict["Private"]) {
				offset = dict["Private"][1];
				dict["Private"] = CFF.readDict(data, offset, offset+dict["Private"][0]);
				if(dict["Private"]["Subrs"]) CFF.readSubrs(data, offset+dict["Private"]["Subrs"], dict["Private"]);
			}
			for(var p in dict) if(["FamilyName","FontName","FullName","Notice","version","Copyright"].indexOf(p)!=-1)  dict[p]=ss[dict[p] -426 + 35];
		},
		
		readSubrs : function(data, offset, obj)
		{
			obj["Subrs"] = Typr["T"].CFF.readBytes(data, offset);
			
			var bias, nSubrs = obj["Subrs"].length+1;
			if (false) bias = 0;
			else if (nSubrs <  1240) bias = 107;
			else if (nSubrs < 33900) bias = 1131;
			else bias = 32768;
			obj["Bias"] = bias;
		},
		readBytes : function(data, offset) {
			var bin = Typr["B"];
			var arr = [];
			offset = Typr["T"].CFF.readIndex(data, offset, arr);
			
			var subrs = [], arl = arr.length-1, no = data.byteOffset+offset;
			for(var i=0; i<arl; i++) {
				var ari = arr[i];
				subrs.push(new Uint8Array(data.buffer, no+ari, arr[i+1]-ari));
			}
			return subrs;
		},
		
		tableSE : [
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  1,   2,   3,   4,   5,   6,   7,   8,
		  9,  10,  11,  12,  13,  14,  15,  16,
		 17,  18,  19,  20,  21,  22,  23,  24,
		 25,  26,  27,  28,  29,  30,  31,  32,
		 33,  34,  35,  36,  37,  38,  39,  40,
		 41,  42,  43,  44,  45,  46,  47,  48,
		 49,  50,  51,  52,  53,  54,  55,  56,
		 57,  58,  59,  60,  61,  62,  63,  64,
		 65,  66,  67,  68,  69,  70,  71,  72,
		 73,  74,  75,  76,  77,  78,  79,  80,
		 81,  82,  83,  84,  85,  86,  87,  88,
		 89,  90,  91,  92,  93,  94,  95,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0,  96,  97,  98,  99, 100, 101, 102,
		103, 104, 105, 106, 107, 108, 109, 110,
		  0, 111, 112, 113, 114,   0, 115, 116,
		117, 118, 119, 120, 121, 122,   0, 123,
		  0, 124, 125, 126, 127, 128, 129, 130,
		131,   0, 132, 133,   0, 134, 135, 136,
		137,   0,   0,   0,   0,   0,   0,   0,
		  0,   0,   0,   0,   0,   0,   0,   0,
		  0, 138,   0, 139,   0,   0,   0,   0,
		140, 141, 142, 143,   0,   0,   0,   0,
		  0, 144,   0,   0,   0, 145,   0,   0,
		146, 147, 148, 149,   0,   0,   0,   0
		],
	  
		glyphByUnicode : function(cff, code)
		{
			for(var i=0; i<cff["charset"].length; i++) if(cff["charset"][i]==code) return i;
			return -1;
		},
		
		glyphBySE : function(cff, charcode)	// glyph by standard encoding
		{
			if ( charcode < 0 || charcode > 255 ) return -1;
			return Typr["T"].CFF.glyphByUnicode(cff, Typr["T"].CFF.tableSE[charcode]);		
		},
		
		/*readEncoding : function(data, offset, num)
		{
			var bin = Typr["B"];
			
			var array = ['.notdef'];
			var format = data[offset];  offset++;
			//console.log("Encoding");
			//console.log(format);
			
			if(format==0)
			{
				var nCodes = data[offset];  offset++;
				for(var i=0; i<nCodes; i++)  array.push(data[offset+i]);
			}
			/*
			else if(format==1 || format==2)
			{
				while(charset.length<num)
				{
					var first = bin.readUshort(data, offset);  offset+=2;
					var nLeft=0;
					if(format==1) {  nLeft = data[offset];  offset++;  }
					else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
					for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
				}
			}
			
			else throw "error: unknown encoding format: " + format;
			
			return array;
		},*/

		readCharset : function(data, offset, num)
		{
			var bin = Typr["B"];
			
			var charset = ['.notdef'];
			var format = data[offset];  offset++;
			
			if(format==0)
			{
				for(var i=0; i<num; i++) 
				{
					var first = bin.readUshort(data, offset);  offset+=2;
					charset.push(first);
				}
			}
			else if(format==1 || format==2)
			{
				while(charset.length<num)
				{
					var first = bin.readUshort(data, offset);  offset+=2;
					var nLeft=0;
					if(format==1) {  nLeft = data[offset];  offset++;  }
					else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
					for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
				}
			}
			else throw "error: format: " + format;
			
			return charset;
		},

		readIndex : function(data, offset, inds)
		{
			var bin = Typr["B"];
			
			var count = bin.readUshort(data, offset)+1;  offset+=2;
			var offsize = data[offset];  offset++;
			
			if     (offsize==1) for(var i=0; i<count; i++) inds.push( data[offset+i] );
			else if(offsize==2) for(var i=0; i<count; i++) inds.push( bin.readUshort(data, offset+i*2) );
			else if(offsize==3) for(var i=0; i<count; i++) inds.push( bin.readUint  (data, offset+i*3 - 1) & 0x00ffffff );
			else if(offsize==4) for(var i=0; i<count; i++) inds.push( bin.readUint  (data, offset+i*4) );
			else if(count!=1) throw "unsupported offset size: " + offsize + ", count: " + count;
			
			offset += count*offsize;
			return offset-1;
		},
		
		getCharString : function(data, offset, o)
		{
			var bin = Typr["B"];
			
			var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
			var vs = 1;
			var op=null, val=null;
			// operand
			if(b0<=20) { op = b0;  vs=1;  }
			if(b0==12) { op = b0*100+b1;  vs=2;  }
			//if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
			if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
			if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
			if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
			if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
			if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
			if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
			if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
			
			o.val = val!=null ? val : "o"+op;
			o.size = vs;
		},
		
		readCharString : function(data, offset, length)
		{
			var end = offset + length;
			var bin = Typr["B"];
			var arr = [];
			
			while(offset<end)
			{
				var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
				var vs = 1;
				var op=null, val=null;
				// operand
				if(b0<=20) { op = b0;  vs=1;  }
				if(b0==12) { op = b0*100+b1;  vs=2;  }
				if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
				if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
				if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
				if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
				if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
				if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
				if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
				if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
				
				arr.push(val!=null ? val : "o"+op);
				offset += vs;	

				//var cv = arr[arr.length-1];
				//if(cv==undefined) throw "error";
				//console.log()
			}	
			return arr;
		},

		readDict : function(data, offset, end)
		{
			var bin = Typr["B"];
			//var dict = [];
			var dict = {};
			var carr = [];
			
			while(offset<end)
			{
				var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
				var vs = 1;
				var key=null, val=null;
				// operand
				if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
				if(b0==29) { val = bin.readInt  (data,offset+1);  vs=5; }
				if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
				if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
				if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
				if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;  throw "unknown number";  }
				
				if(b0==30) 
				{  
					var nibs = [];
					vs = 1;
					while(true)
					{
						var b = data[offset+vs];  vs++;
						var nib0 = b>>4, nib1 = b&0xf;
						if(nib0 != 0xf) nibs.push(nib0);  if(nib1!=0xf) nibs.push(nib1);
						if(nib1==0xf) break;
					}
					var s = "";
					var chars = [0,1,2,3,4,5,6,7,8,9,".","e","e-","reserved","-","endOfNumber"];
					for(var i=0; i<nibs.length; i++) s += chars[nibs[i]];
					//console.log(nibs);
					val = parseFloat(s);
				}
				
				if(b0<=21)	// operator
				{
					var keys = ["version", "Notice", "FullName", "FamilyName", "Weight", "FontBBox", "BlueValues", "OtherBlues", "FamilyBlues","FamilyOtherBlues",
						"StdHW", "StdVW", "escape", "UniqueID", "XUID", "charset", "Encoding", "CharStrings", "Private", "Subrs", 
						"defaultWidthX", "nominalWidthX"];
						
					key = keys[b0];  vs=1;
					if(b0==12) { 
						var keys = [ "Copyright", "isFixedPitch", "ItalicAngle", "UnderlinePosition", "UnderlineThickness", "PaintType", "CharstringType", "FontMatrix", "StrokeWidth", "BlueScale",
						"BlueShift", "BlueFuzz", "StemSnapH", "StemSnapV", "ForceBold", "","", "LanguageGroup", "ExpansionFactor", "initialRandomSeed",
						"SyntheticBase", "PostScript", "BaseFontName", "BaseFontBlend", "","","",  "","","",
						"ROS", "CIDFontVersion", "CIDFontRevision", "CIDFontType", "CIDCount", "UIDBase", "FDArray", "FDSelect", "FontName"];
						key = keys[b1];  vs=2; 
					}
				}
				
				if(key!=null) {  dict[key] = carr.length==1 ? carr[0] : carr;  carr=[]; }
				else  carr.push(val);  
				
				offset += vs;		
			}	
			return dict;
		}
	};


Typr["T"].cmap = {
	parseTab : function(data, offset, length)
	{
		var obj = {tables:[],ids:{},off:offset};
		data = new Uint8Array(data.buffer, offset, length);
		offset = 0;

		var offset0 = offset;
		var bin = Typr["B"], rU = bin.readUshort, cmap = Typr["T"].cmap;
		var version   = rU(data, offset);  offset += 2;
		var numTables = rU(data, offset);  offset += 2;
		
		//console.log(version, numTables);
		
		var offs = [];
		
		
		for(var i=0; i<numTables; i++)
		{
			var platformID = rU(data, offset);  offset += 2;
			var encodingID = rU(data, offset);  offset += 2;
			var noffset = bin.readUint(data, offset);       offset += 4;
			
			var id = "p"+platformID+"e"+encodingID;
			
			//console.log("cmap subtable", platformID, encodingID, noffset);
			
			
			var tind = offs.indexOf(noffset);
			
			if(tind==-1)
			{
				tind = obj.tables.length;
				var subt = {};
				offs.push(noffset);
				//var time = Date.now();
				var format = subt.format = rU(data, noffset);
				if     (format== 0) subt = cmap.parse0(data, noffset, subt);
				//else if(format== 2) subt.off = noffset;
				else if(format== 4) subt = cmap.parse4(data, noffset, subt);
				else if(format== 6) subt = cmap.parse6(data, noffset, subt);
				else if(format==12) subt = cmap.parse12(data,noffset, subt);
				//console.log(format, Date.now()-time);
				//else console.log("unknown format: "+format, platformID, encodingID, noffset);
				obj.tables.push(subt);
			}
			
			if(obj.ids[id]!=null) console.log("multiple tables for one platform+encoding: "+id);
			obj.ids[id] = tind;
		}
		return obj;
	},

	parse0 : function(data, offset, obj)
	{
		var bin = Typr["B"];
		offset += 2;
		var len    = bin.readUshort(data, offset);  offset += 2;
		var lang   = bin.readUshort(data, offset);  offset += 2;
		obj.map = [];
		for(var i=0; i<len-6; i++) obj.map.push(data[offset+i]);
		return obj;
	},

	parse4 : function(data, offset, obj)
	{
		var bin = Typr["B"], rU = bin.readUshort, rUs = bin.readUshorts;
		var offset0 = offset;
		offset+=2;
		var length   = rU(data, offset);  offset+=2;
		var language = rU(data, offset);  offset+=2;
		var segCountX2 = rU(data, offset);  offset+=2;
		var segCount = segCountX2>>>1;
		obj.searchRange = rU(data, offset);  offset+=2;
		obj.entrySelector = rU(data, offset);  offset+=2;
		obj.rangeShift = rU(data, offset);  offset+=2;
		obj.endCount   = rUs(data, offset, segCount);  offset += segCount*2;
		offset+=2;
		obj.startCount = rUs(data, offset, segCount);  offset += segCount*2;
		obj.idDelta = [];
		for(var i=0; i<segCount; i++) {obj.idDelta.push(bin.readShort(data, offset));  offset+=2;}
		obj.idRangeOffset = rUs(data, offset, segCount);  offset += segCount*2;
		obj.glyphIdArray  = rUs(data, offset, ((offset0+length)-offset)>>1);  //offset += segCount*2;
		return obj;
	},

	parse6 : function(data, offset, obj)
	{
		var bin = Typr["B"];
		var offset0 = offset;
		offset+=2;
		var length = bin.readUshort(data, offset);  offset+=2;
		var language = bin.readUshort(data, offset);  offset+=2;
		obj.firstCode = bin.readUshort(data, offset);  offset+=2;
		var entryCount = bin.readUshort(data, offset);  offset+=2;
		obj.glyphIdArray = [];
		for(var i=0; i<entryCount; i++) {obj.glyphIdArray.push(bin.readUshort(data, offset));  offset+=2;}
		
		return obj;
	},

	parse12 : function(data, offset, obj)
	{
		var bin = Typr["B"], rU = bin.readUint;
		var offset0 = offset;
		offset+=4;
		var length = rU(data, offset);  offset+=4;
		var lang   = rU(data, offset);  offset+=4;
		var nGroups= rU(data, offset)*3;  offset+=4;
		
		var gps = obj.groups = new Uint32Array(nGroups);//new Uint32Array(data.slice(offset, offset+nGroups*12).buffer);  
		
		for(var i=0; i<nGroups; i+=3) {
			gps[i  ] = rU(data, offset+(i<<2)  );
			gps[i+1] = rU(data, offset+(i<<2)+4);
			gps[i+2] = rU(data, offset+(i<<2)+8);
		}
		return obj;
	}
};

Typr["T"].CBLC = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"], ooff=offset;
		
		var maj = bin.readUshort(data,offset);  offset+=2;
		var min = bin.readUshort(data,offset);  offset+=2;
		
		var numSizes = bin.readUint  (data,offset);  offset+=4;
		
		var out = [];
		for(var i=0; i<numSizes; i++) {
			var off = bin.readUint  (data,offset);  offset+=4;  // indexSubTableArrayOffset
			var siz = bin.readUint  (data,offset);  offset+=4;  // indexTablesSize
			var num = bin.readUint  (data,offset);  offset+=4;  // numberOfIndexSubTables
			offset+=4;
			
			offset+=2*12;
			
			var sGlyph = bin.readUshort(data,offset);  offset+=2;
			var eGlyph = bin.readUshort(data,offset);  offset+=2;
			
			//console.log(off,siz,num, sGlyph, eGlyph);
			
			offset+=4;
			
			var coff = ooff+off;
			for(var j=0; j<3; j++) {				
				var fgI = bin.readUshort(data,coff);  coff+=2;
				var lgI = bin.readUshort(data,coff);  coff+=2;
				var nxt = bin.readUint  (data,coff);  coff+=4; 
				var gcnt = lgI-fgI+1;
				//console.log(fgI, lgI, nxt);   //if(nxt==0) break;
				
				var ioff = ooff+off+nxt;
				
				var inF = bin.readUshort(data,ioff);  ioff+=2;  if(inF!=1) throw inF;
				var imF = bin.readUshort(data,ioff);  ioff+=2;
				var imgo = bin.readUint  (data,ioff);  ioff+=4;
				
				var oarr = [];
				for(var gi=0; gi<gcnt; gi++) {
					var sbitO = bin.readUint(data,ioff+gi*4);  oarr.push(imgo+sbitO);
					//console.log("--",sbitO);
				}
				out.push([fgI,lgI,imF,oarr]);
			}
		}
		return out;
	}
};

Typr["T"].CBDT = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var ooff=offset;
		
		//var maj = bin.readUshort(data,offset);  offset+=2;
		//var min = bin.readUshort(data,offset);  offset+=2;
		
		return new Uint8Array(data.buffer, data.byteOffset+offset, length);
	}
};

Typr["T"].glyf = {
	parseTab : function(data, offset, length, font)
	{
		var obj = [], ng=font["maxp"]["numGlyphs"];
		for(var g=0; g<ng; g++) obj.push(null);
		return obj;
	},

	_parseGlyf : function(font, g)
	{
		var bin = Typr["B"];
		var data = font["_data"], loca=font["loca"];
		
		if(loca[g]==loca[g+1]) return null;
		
		var offset = Typr["findTable"](data, "glyf", font["_offset"])[0] + loca[g];
		
		var gl = {};
			
		gl.noc  = bin.readShort(data, offset);  offset+=2;		// number of contours
		gl.xMin = bin.readShort(data, offset);  offset+=2;
		gl.yMin = bin.readShort(data, offset);  offset+=2;
		gl.xMax = bin.readShort(data, offset);  offset+=2;
		gl.yMax = bin.readShort(data, offset);  offset+=2;
		
		if(gl.xMin>=gl.xMax || gl.yMin>=gl.yMax) return null;
			
		if(gl.noc>0)
		{
			gl.endPts = [];
			for(var i=0; i<gl.noc; i++) { gl.endPts.push(bin.readUshort(data,offset)); offset+=2; }
			
			var instructionLength = bin.readUshort(data,offset); offset+=2;
			if((data.length-offset)<instructionLength) return null;
			gl.instructions = bin.readBytes(data, offset, instructionLength);   offset+=instructionLength;
			
			var crdnum = gl.endPts[gl.noc-1]+1;
			gl.flags = [];
			for(var i=0; i<crdnum; i++ ) 
			{ 
				var flag = data[offset];  offset++; 
				gl.flags.push(flag); 
				if((flag&8)!=0)
				{
					var rep = data[offset];  offset++;
					for(var j=0; j<rep; j++) { gl.flags.push(flag); i++; }
				}
			}
			gl.xs = [];
			for(var i=0; i<crdnum; i++) {
				var i8=((gl.flags[i]&2)!=0), same=((gl.flags[i]&16)!=0);  
				if(i8) { gl.xs.push(same ? data[offset] : -data[offset]);  offset++; }
				else
				{
					if(same) gl.xs.push(0);
					else { gl.xs.push(bin.readShort(data, offset));  offset+=2; }
				}
			}
			gl.ys = [];
			for(var i=0; i<crdnum; i++) {
				var i8=((gl.flags[i]&4)!=0), same=((gl.flags[i]&32)!=0);  
				if(i8) { gl.ys.push(same ? data[offset] : -data[offset]);  offset++; }
				else
				{
					if(same) gl.ys.push(0);
					else { gl.ys.push(bin.readShort(data, offset));  offset+=2; }
				}
			}
			var x = 0, y = 0;
			for(var i=0; i<crdnum; i++) { x += gl.xs[i]; y += gl.ys[i];  gl.xs[i]=x;  gl.ys[i]=y; }
			//console.log(endPtsOfContours, instructionLength, instructions, flags, xCoordinates, yCoordinates);
		}
		else
		{
			var ARG_1_AND_2_ARE_WORDS	= 1<<0;
			var ARGS_ARE_XY_VALUES		= 1<<1;
			var ROUND_XY_TO_GRID		= 1<<2;
			var WE_HAVE_A_SCALE			= 1<<3;
			var RESERVED				= 1<<4;
			var MORE_COMPONENTS			= 1<<5;
			var WE_HAVE_AN_X_AND_Y_SCALE= 1<<6;
			var WE_HAVE_A_TWO_BY_TWO	= 1<<7;
			var WE_HAVE_INSTRUCTIONS	= 1<<8;
			var USE_MY_METRICS			= 1<<9;
			var OVERLAP_COMPOUND		= 1<<10;
			var SCALED_COMPONENT_OFFSET	= 1<<11;
			var UNSCALED_COMPONENT_OFFSET	= 1<<12;
			
			gl.parts = [];
			var flags;
			do {
				flags = bin.readUshort(data, offset);  offset += 2;
				var part = { m:{a:1,b:0,c:0,d:1,tx:0,ty:0}, p1:-1, p2:-1 };  gl.parts.push(part);
				part.glyphIndex = bin.readUshort(data, offset);  offset += 2;
				if ( flags & ARG_1_AND_2_ARE_WORDS) {
					var arg1 = bin.readShort(data, offset);  offset += 2;
					var arg2 = bin.readShort(data, offset);  offset += 2;
				} else {
					var arg1 = bin.readInt8(data, offset);  offset ++;
					var arg2 = bin.readInt8(data, offset);  offset ++;
				}
				
				if(flags & ARGS_ARE_XY_VALUES) { part.m.tx = arg1;  part.m.ty = arg2; }
				else  {  part.p1=arg1;  part.p2=arg2;  }
				//part.m.tx = arg1;  part.m.ty = arg2;
				//else { throw "params are not XY values"; }
				
				if ( flags & WE_HAVE_A_SCALE ) {
					part.m.a = part.m.d = bin.readF2dot14(data, offset);  offset += 2;    
				} else if ( flags & WE_HAVE_AN_X_AND_Y_SCALE ) {
					part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
					part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
				} else if ( flags & WE_HAVE_A_TWO_BY_TWO ) {
					part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
					part.m.b = bin.readF2dot14(data, offset);  offset += 2; 
					part.m.c = bin.readF2dot14(data, offset);  offset += 2; 
					part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
				}
			} while ( flags & MORE_COMPONENTS ) 
			if (flags & WE_HAVE_INSTRUCTIONS){
				var numInstr = bin.readUshort(data, offset);  offset += 2;
				gl.instr = [];
				for(var i=0; i<numInstr; i++) { gl.instr.push(data[offset]);  offset++; }
			}
		}
		return gl;
	}
};

Typr["T"].head = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var obj = {};
		var tableVersion = bin.readFixed(data, offset);  offset += 4;
		
		obj["fontRevision"] = bin.readFixed(data, offset);  offset += 4;
		var checkSumAdjustment = bin.readUint(data, offset);  offset += 4;
		var magicNumber = bin.readUint(data, offset);  offset += 4;
		obj["flags"] = bin.readUshort(data, offset);  offset += 2;
		obj["unitsPerEm"] = bin.readUshort(data, offset);  offset += 2;
		obj["created"]  = bin.readUint64(data, offset);  offset += 8;
		obj["modified"] = bin.readUint64(data, offset);  offset += 8;
		obj["xMin"] = bin.readShort(data, offset);  offset += 2;
		obj["yMin"] = bin.readShort(data, offset);  offset += 2;
		obj["xMax"] = bin.readShort(data, offset);  offset += 2;
		obj["yMax"] = bin.readShort(data, offset);  offset += 2;
		obj["macStyle"] = bin.readUshort(data, offset);  offset += 2;
		obj["lowestRecPPEM"] = bin.readUshort(data, offset);  offset += 2;
		obj["fontDirectionHint"] = bin.readShort(data, offset);  offset += 2;
		obj["indexToLocFormat"]  = bin.readShort(data, offset);  offset += 2;
		obj["glyphDataFormat"]   = bin.readShort(data, offset);  offset += 2;
		return obj;
	}
};

Typr["T"].hhea = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var obj = {};
		var tableVersion = bin.readFixed(data, offset);  offset += 4;
		
		var keys = ["ascender","descender","lineGap",
			"advanceWidthMax","minLeftSideBearing","minRightSideBearing","xMaxExtent",
			"caretSlopeRise","caretSlopeRun","caretOffset",
			"res0","res1","res2","res3",
			"metricDataFormat","numberOfHMetrics" ];
			
		for(var i=0; i<	keys.length; i++) {
			var key = keys[i];
			var func = (key=="advanceWidthMax" || key=="numberOfHMetrics")?bin.readUshort:bin.readShort;
			obj[key]=func(data,offset+i*2);
		}
		return obj;
	}
};


Typr["T"].hmtx = {
	parseTab : function(data, offset, length, font)
	{
		var bin = Typr["B"];
		var aWidth = [];
		var lsBearing = [];
		
		var nG = font["maxp"]["numGlyphs"], nH = font["hhea"]["numberOfHMetrics"];
		var aw = 0, lsb = 0, i=0;
		while(i<nH) {  aw=bin.readUshort(data, offset+(i<<2));  lsb=bin.readShort(data, offset+(i<<2)+2);  aWidth.push(aw);  lsBearing.push(lsb);  i++;  }
		while(i<nG) {  aWidth.push(aw);  lsBearing.push(lsb);  i++;  }
		
		return {aWidth:aWidth, lsBearing:lsBearing};
	}
};


Typr["T"].kern = {
	parseTab : function(data, offset, length, font)
	{
		var bin = Typr["B"], kern=Typr["T"].kern;
		
		var version = bin.readUshort(data, offset);
		if(version==1) return kern.parseV1(data, offset, length, font);
		var nTables = bin.readUshort(data, offset+2);  offset+=4;
		
		var map = {glyph1: [], rval:[]};
		for(var i=0; i<nTables; i++)
		{
			offset+=2;	// skip version
			var length  = bin.readUshort(data, offset);  offset+=2;
			var coverage = bin.readUshort(data, offset);  offset+=2;
			var format = coverage>>>8;
			/* I have seen format 128 once, that's why I do */ format &= 0xf;
			if(format==0) offset = kern.readFormat0(data, offset, map);
			//else throw "unknown kern table format: "+format;
		}
		return map;
	},

	parseV1 : function(data, offset, length, font)
	{
		var bin = Typr["B"], kern=Typr["T"].kern;
		
		var version = bin.readFixed(data, offset);   // 0x00010000 
		var nTables = bin.readUint (data, offset+4);  offset+=8;
		
		var map = {glyph1: [], rval:[]};
		for(var i=0; i<nTables; i++)
		{
			var length = bin.readUint(data, offset);   offset+=4;
			var coverage = bin.readUshort(data, offset);  offset+=2;
			var tupleIndex = bin.readUshort(data, offset);  offset+=2;
			var format = coverage&0xff;
			if(format==0) offset = kern.readFormat0(data, offset, map);
			//else throw "unknown kern table format: "+format;
		}
		return map;
	},

	readFormat0 : function(data, offset, map)
	{
		var bin = Typr["B"], rUs = bin.readUshort;
		var pleft = -1;
		var nPairs        = rUs(data, offset);
		var searchRange   = rUs(data, offset+2);
		var entrySelector = rUs(data, offset+4);
		var rangeShift    = rUs(data, offset+6);  offset+=8;
		for(var j=0; j<nPairs; j++)
		{
			var left  = rUs(data, offset);  offset+=2;
			var right = rUs(data, offset);  offset+=2;
			var value = bin.readShort (data, offset);  offset+=2;
			if(left!=pleft) { map.glyph1.push(left);  map.rval.push({ glyph2:[], vals:[] }) }
			var rval = map.rval[map.rval.length-1];
			rval.glyph2.push(right);   rval.vals.push(value);
			pleft = left;
		}
		return offset;
	}
};


Typr["T"].loca = {
	parseTab : function(data, offset, length, font)
	{
		var bin = Typr["B"];
		var obj = [];
		
		var ver = font["head"]["indexToLocFormat"];
		var len = font["maxp"]["numGlyphs"]+1;
		
		if(ver==0) for(var i=0; i<len; i++) obj.push(bin.readUshort(data, offset+(i<<1))<<1);
		if(ver==1) for(var i=0; i<len; i++) obj.push(bin.readUint  (data, offset+(i<<2))   );
		
		return obj;
	}
};


Typr["T"].maxp = {
	parseTab : function(data, offset, length)
	{
		//console.log(data.length, offset, length);
		
		var bin = Typr["B"], rU=bin.readUshort;
		var obj = {};
		
		// both versions 0.5 and 1.0
		var ver = bin.readUint(data, offset); offset += 4;
		
		obj["numGlyphs"] = rU(data, offset);  offset += 2;
		
		// only 1.0
		/*
		if(ver == 0x00010000) {
			obj.maxPoints             = rU(data, offset);  offset += 2;
			obj.maxContours           = rU(data, offset);  offset += 2;
			obj.maxCompositePoints    = rU(data, offset);  offset += 2;
			obj.maxCompositeContours  = rU(data, offset);  offset += 2;
			obj.maxZones              = rU(data, offset);  offset += 2;
			obj.maxTwilightPoints     = rU(data, offset);  offset += 2;
			obj.maxStorage            = rU(data, offset);  offset += 2;
			obj.maxFunctionDefs       = rU(data, offset);  offset += 2;
			obj.maxInstructionDefs    = rU(data, offset);  offset += 2;
			obj.maxStackElements      = rU(data, offset);  offset += 2;
			obj.maxSizeOfInstructions = rU(data, offset);  offset += 2;
			obj.maxComponentElements  = rU(data, offset);  offset += 2;
			obj.maxComponentDepth     = rU(data, offset);  offset += 2;
		}
		*/
		
		return obj;
	}
};
Typr["T"].name = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var obj = {};
		var format = bin.readUshort(data, offset);  offset += 2;
		var count  = bin.readUshort(data, offset);  offset += 2;
		var stringOffset = bin.readUshort(data, offset);  offset += 2;
		
		var ooo = offset-6 + stringOffset;
		//console.log(format,count);
		
		var names = [
			"copyright",
			"fontFamily",
			"fontSubfamily",
			"ID",
			"fullName",
			"version",
			"postScriptName",
			"trademark",
			"manufacturer",
			"designer",
			"description",
			"urlVendor",
			"urlDesigner",
			"licence",
			"licenceURL",
			"---",
			"typoFamilyName",
			"typoSubfamilyName",
			"compatibleFull",
			"sampleText",
			"postScriptCID",
			"wwsFamilyName",
			"wwsSubfamilyName",
			"lightPalette",
			"darkPalette"
		];
		
		var rU = bin.readUshort;
		
		for(var i=0; i<count; i++)
		{
			var platformID = rU(data, offset);  offset += 2;
			var encodingID = rU(data, offset);  offset += 2;
			var languageID = rU(data, offset);  offset += 2;
			var nameID     = rU(data, offset);  offset += 2;
			var slen       = rU(data, offset);  offset += 2;
			var noffset    = rU(data, offset);  offset += 2;
			//console.log(platformID, encodingID, languageID.toString(16), nameID, length, noffset);
			
			
			var soff = ooo + noffset;
			var str;
			if(false){}
			else if(platformID == 0) str = bin.readUnicode(data, soff, slen/2);
			else if(platformID == 3 && encodingID == 0) str = bin.readUnicode(data, soff, slen/2);
			else if(platformID == 1 && encodingID ==25) str = bin.readUnicode(data, soff, slen/2);
			else if(encodingID == 0) str = bin.readASCII  (data, soff, slen);
			else if(encodingID == 1) str = bin.readUnicode(data, soff, slen/2);
			else if(encodingID == 3) str = bin.readUnicode(data, soff, slen/2);
			else if(encodingID == 4) str = bin.readUnicode(data, soff, slen/2);
			else if(encodingID == 5) str = bin.readUnicode(data, soff, slen/2);
			else if(encodingID ==10) str = bin.readUnicode(data, soff, slen/2);
			
			else if(platformID == 1) { str = bin.readASCII(data, soff, slen);  console.log("reading unknown MAC encoding "+encodingID+" as ASCII") }
			else {
				console.log("unknown encoding "+encodingID + ", platformID: "+platformID);
				str = bin.readASCII(data, soff, slen);
			}
			
			var tid = "p"+platformID+","+(languageID).toString(16);//Typr._platforms[platformID];
			if(obj[tid]==null) obj[tid] = {};
			var name = names[nameID];  //if(name==null)name="_"+nameID;
			if(name) obj[tid][name] = str;
			obj[tid]["_"+nameID] = str;
			obj[tid]["_lang"] = languageID;
			//console.log(tid, obj[tid]);
		}
		/*
		if(format == 1)
		{
			var langTagCount = bin.readUshort(data, offset);  offset += 2;
			for(var i=0; i<langTagCount; i++)
			{
				var length  = bin.readUshort(data, offset);  offset += 2;
				var noffset = bin.readUshort(data, offset);  offset += 2;
			}
		}
		*/
		var out = Typr["T"].name.selectOne(obj), ff="fontFamily";
		if(out[ff]==null) for(var p in obj) if(obj[p][ff]!=null) out[ff]=obj[p][ff];
		return out;
	},
	selectOne :function(obj) {
		//console.log(obj);
		var psn = "postScriptName";
		
		for(var p in obj) if(obj[p][psn]!=null && obj[p]["_lang"]==0x0409) return obj[p];		// United States
		for(var p in obj) if(obj[p][psn]!=null && obj[p]["_lang"]==0x0000) return obj[p];		// Universal
		for(var p in obj) if(obj[p][psn]!=null && obj[p]["_lang"]==0x0c0c) return obj[p];		// Canada
		for(var p in obj) if(obj[p][psn]!=null) return obj[p];
		
		var out;
		for(var p in obj) { out=obj[p]; break; }
		console.log("returning name table with languageID "+ out._lang);
		if(out[psn]==null && out["ID"]!=null) out[psn]=out["ID"];
		return out;
	}
}

Typr["T"].OS2 = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var ver = bin.readUshort(data, offset); offset += 2;
		
		var OS2 = Typr["T"].OS2;
		
		var obj = {};
		if     (ver==0) OS2.version0(data, offset, obj);
		else if(ver==1) OS2.version1(data, offset, obj);
		else if(ver==2 || ver==3 || ver==4) OS2.version2(data, offset, obj);
		else if(ver==5) OS2.version5(data, offset, obj);
		else throw "unknown OS/2 table version: "+ver;
		
		return obj;
	},

	version0 : function(data, offset, obj)
	{
		var bin = Typr["B"];
		obj["xAvgCharWidth"] = bin.readShort(data, offset); offset += 2;
		obj["usWeightClass"] = bin.readUshort(data, offset); offset += 2;
		obj["usWidthClass"]  = bin.readUshort(data, offset); offset += 2;
		obj["fsType"] = bin.readUshort(data, offset); offset += 2;
		obj["ySubscriptXSize"] = bin.readShort(data, offset); offset += 2;
		obj["ySubscriptYSize"] = bin.readShort(data, offset); offset += 2;
		obj["ySubscriptXOffset"] = bin.readShort(data, offset); offset += 2;
		obj["ySubscriptYOffset"] = bin.readShort(data, offset); offset += 2; 
		obj["ySuperscriptXSize"] = bin.readShort(data, offset); offset += 2; 
		obj["ySuperscriptYSize"] = bin.readShort(data, offset); offset += 2; 
		obj["ySuperscriptXOffset"] = bin.readShort(data, offset); offset += 2;
		obj["ySuperscriptYOffset"] = bin.readShort(data, offset); offset += 2;
		obj["yStrikeoutSize"] = bin.readShort(data, offset); offset += 2;
		obj["yStrikeoutPosition"] = bin.readShort(data, offset); offset += 2;
		obj["sFamilyClass"] = bin.readShort(data, offset); offset += 2;
		obj["panose"] = bin.readBytes(data, offset, 10);  offset += 10;
		obj["ulUnicodeRange1"]	= bin.readUint(data, offset);  offset += 4;
		obj["ulUnicodeRange2"]	= bin.readUint(data, offset);  offset += 4;
		obj["ulUnicodeRange3"]	= bin.readUint(data, offset);  offset += 4;
		obj["ulUnicodeRange4"]	= bin.readUint(data, offset);  offset += 4;
		obj["achVendID"] = bin.readASCII(data, offset, 4);  offset += 4;
		obj["fsSelection"]	 = bin.readUshort(data, offset); offset += 2;
		obj["usFirstCharIndex"] = bin.readUshort(data, offset); offset += 2;
		obj["usLastCharIndex"] = bin.readUshort(data, offset); offset += 2;
		obj["sTypoAscender"] = bin.readShort(data, offset); offset += 2;
		obj["sTypoDescender"] = bin.readShort(data, offset); offset += 2;
		obj["sTypoLineGap"] = bin.readShort(data, offset); offset += 2;
		obj["usWinAscent"] = bin.readUshort(data, offset); offset += 2;
		obj["usWinDescent"] = bin.readUshort(data, offset); offset += 2;
		return offset;
	},

	version1 : function(data, offset, obj)
	{
		var bin = Typr["B"];
		offset = Typr["T"].OS2.version0(data, offset, obj);
		
		obj["ulCodePageRange1"] = bin.readUint(data, offset); offset += 4;
		obj["ulCodePageRange2"] = bin.readUint(data, offset); offset += 4;
		return offset;
	},

	version2 : function(data, offset, obj)
	{
		var bin = Typr["B"], rU=bin.readUshort;
		offset = Typr["T"].OS2.version1(data, offset, obj);
		
		obj["sxHeight"]     = bin.readShort(data, offset); offset += 2;
		obj["sCapHeight"]   = bin.readShort(data, offset); offset += 2;
		obj["usDefault"]    = rU(data, offset); offset += 2;
		obj["usBreak"]      = rU(data, offset); offset += 2;
		obj["usMaxContext"] = rU(data, offset); offset += 2;
		return offset;
	},

	version5 : function(data, offset, obj)
	{
		var rU = Typr["B"].readUshort;
		offset = Typr["T"].OS2.version2(data, offset, obj);

		obj["usLowerOpticalPointSize"] = rU(data, offset); offset += 2;
		obj["usUpperOpticalPointSize"] = rU(data, offset); offset += 2;
		return offset;
	}
}

Typr["T"].post = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var obj = {};
		
		obj["version"]            = bin.readFixed(data, offset);  offset+=4;
		obj["italicAngle"]        = bin.readFixed(data, offset);  offset+=4;
		obj["underlinePosition"]  = bin.readShort(data, offset);  offset+=2;
		obj["underlineThickness"] = bin.readShort(data, offset);  offset+=2;

		return obj;
	}
};
Typr["T"].SVG = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var obj = { entries: [], svgs:[]};

		var offset0 = offset;

		var tableVersion = bin.readUshort(data, offset);	offset += 2;
		var svgDocIndexOffset = bin.readUint(data, offset);	offset += 4;
		var reserved = bin.readUint(data, offset); offset += 4;

		offset = svgDocIndexOffset + offset0;

		var numEntries = bin.readUshort(data, offset);	offset += 2;

		for(var i=0; i<numEntries; i++)
		{
			var startGlyphID = bin.readUshort(data, offset);  offset += 2;
			var endGlyphID   = bin.readUshort(data, offset);  offset += 2;
			var svgDocOffset = bin.readUint  (data, offset);  offset += 4;
			var svgDocLength = bin.readUint  (data, offset);  offset += 4;

			var sbuf = new Uint8Array(data.buffer, offset0 + svgDocOffset + svgDocIndexOffset, svgDocLength);
			if(sbuf[0]==0x1f && sbuf[1]==0x8b && sbuf[2]==0x08) sbuf = pako["inflate"](sbuf);
			var svg = bin.readUTF8(sbuf, 0, sbuf.length);
			
			for(var f=startGlyphID; f<=endGlyphID; f++) {
				obj.entries[f] = obj.svgs.length;
			}
			obj.svgs.push(svg);
		}
		return obj;
	}
};


Typr["T"].sbix = {
	parseTab : function(data, offset, length, obj)
	{
		var numGlyphs = obj["maxp"]["numGlyphs"];
		var ooff = offset;
		var bin = Typr["B"];
		
		//var ver = bin.readUshort(data,offset);  offset+=2;
		//var flg = bin.readUshort(data,offset);  offset+=2;
		
		var numStrikes = bin.readUint  (data,offset+4);
		
		var out = [];
		for(var si=numStrikes-1; si<numStrikes; si++) {
			var off = ooff+bin.readUint(data,offset+8+si*4);
			
			//var ppem = bin.readUshort(data,off);  off+=2;
			//var ppi  = bin.readUshort(data,off);  off+=2;
			
			for(var gi=0; gi<numGlyphs; gi++) {
				var aoff = bin.readUint(data,off+4+gi*4);
				var noff = bin.readUint(data,off+4+gi*4+4);  if(aoff==noff) {  out[gi]=null;  continue;  }
				var go = off+aoff;
				//var ooX = bin.readUshort(data,go);
				//var ooY = bin.readUshort(data,go+2);
				var tag = bin.readASCII(data,go+4,4);  if(tag!="png " && tag!="flip") throw tag;
				
				out[gi] = new Uint8Array(data.buffer, data.byteOffset+go+8, noff-aoff-8);
			}
		}
		return out;
	}
};

Typr["T"].colr = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var ooff=offset;
		offset+=2;
		var num = bin.readUshort(data,offset);  offset+=2;
		
		var boff = bin.readUint(data,offset);  offset+=4;
		var loff = bin.readUint(data,offset);  offset+=4;
		
		var lnum = bin.readUshort(data,offset);  offset+=2;
		//console.log(num,boff,loff,lnum);
		
		var base = {};
		var coff = ooff+boff;
		for(var i=0; i<num; i++) {
			base["g"+bin.readUshort(data,coff)] = [ bin.readUshort(data,coff+2),bin.readUshort(data,coff+4)];
			coff+=6;
		}

		var lays = [];
		coff = ooff+loff;
		for(var i=0; i<lnum; i++) {
			lays.push(bin.readUshort(data,coff), bin.readUshort(data,coff+2));  coff+=4;
		}
		return [base,lays];
	}
};

Typr["T"].cpal = {
	parseTab : function(data, offset, length)
	{
		var bin = Typr["B"];
		var ooff=offset;
		var vsn = bin.readUshort(data,offset);  offset+=2;
		
		if(vsn==0) {
			var ets = bin.readUshort(data,offset);  offset+=2;
			var pts = bin.readUshort(data,offset);  offset+=2;
			var tot = bin.readUshort(data,offset);  offset+=2;
			
			var fst = bin.readUint(data,offset);  offset+=4;
			
			return new Uint8Array(data.buffer,ooff+fst,tot*4);
			/*
			var coff=ooff+fst;
			
			for(var i=0; i<tot; i++) {
				console.log(data[coff],data[coff+1],data[coff+2],data[coff+3]);
				coff+=4;
			}
			
			console.log(ets,pts,tot); */
		}
		else throw vsn;//console.log("unknown color palette",vsn);
	}
};

Typr["T"].GSUB = {
	parseTab : function(data, offset, length, obj)
	{
		//console.log(obj.name.ID);
		
		var bin = Typr["B"], rU=bin.readUshort, rI=bin.readUint;
		
		
		var off=offset;
		var maj = rU(data, off);  off+=2;
		var min = rU(data, off);  off+=2;
		var slO = rU(data, off);  off+=2;
		var flO = rU(data, off);  off+=2;
		var llO = rU(data, off);  off+=2;
		
		//console.log(maj,min,slO,flO,llO);
		
		off = offset + flO;
		
		var fmap={};
		var cnt = rU(data,off);  off+=2;
		for(var i=0; i<cnt; i++) {
			var tag = bin.readASCII(data,off,4);  off+=4;
			var fof = rU(data,off);  off+=2;
			fmap[tag]=true;
		}
		//console.log(fmap);
		return fmap;
	}
};

Typr["T"].fvar = {
	parseTab : function(data, offset, length, obj)
	{
		var name = obj["name"];
		var off = offset;
		var bin = Typr["B"];
		var axes = [], inst=[];
		
		off+=8;
		var acnt = bin.readUshort(data,off);  off+=2;
		off+=2;
		var icnt = bin.readUshort(data,off);  off+=2;
		var isiz = bin.readUshort(data,off);  off+=2;
		
		for(var i=0; i<acnt; i++) {
			var tag = bin.readASCII(data,off,4);  
			var min = bin.readFixed(data,off+4);  
			var def = bin.readFixed(data,off+8);  
			var max = bin.readFixed(data,off+12);  
			var flg = bin.readUshort(data,off+16); 
			var nid = bin.readUshort(data,off+18);
			axes.push([tag,min,def,max,flg,name["_"+nid]]);
			//console.log(tag,min,def,max,flg,nid);
			off+=20;
		}
		for(var i=0; i<icnt; i++) {
			var snid = bin.readUshort(data,off), pnid=null;
			var flg  = bin.readUshort(data,off+2);
			var crd  = [];  for(var j=0; j<acnt; j++) crd.push(bin.readFixed(data,off+4+j*4));
			off+=4+acnt*4;
			if((isiz&3)==2) {  pnid = bin.readUshort(data,off);  off+=2;  }
			inst.push([name["_"+snid],flg,crd,pnid]);
			//console.log(snid,flg, crd);
		}
		
		return [axes,inst];
	}
};

Typr["T"].gvar = (function() {
	
	var EMBEDDED_PEAK_TUPLE    = 0x8000;
	var INTERMEDIATE_REGION    = 0x4000;
	var PRIVATE_POINT_NUMBERS  = 0x2000;
	
	var DELTAS_ARE_ZERO = 0x80;
	var DELTAS_ARE_WORDS= 0x40;
	
	var POINTS_ARE_WORDS= 0x80;
	
	var SHARED_POINT_NUMBERS   = 0x8000;
	
	var bin = Typr["B"];
	
	function readTuple(data, o, acnt) {
		var tup = [];  for(var j=0; j<acnt; j++) tup.push(bin.readF2dot14(data,o+j*2));
		return tup;
	}
	
	function readTupleVarHeader(data,off, vcnt,acnt,  eoff) {
		var out = [];
		for(var j=0; j<vcnt; j++) {
			var dsiz = bin.readUshort(data,off);   off+=2; 
			var tind = bin.readUshort(data,off), flag=tind&0xf000;  tind=tind&0xfff;  off+=2;
			//console.log(j, dsiz,tind, flag.toString(16));
			
			var peak=null, start=null, end=null;
			if(flag&EMBEDDED_PEAK_TUPLE) {  peak =readTuple(data,off,acnt);  off+=acnt*2;  }
			if(flag&INTERMEDIATE_REGION) {  start=readTuple(data,off,acnt);  off+=acnt*2;  }
			if(flag&INTERMEDIATE_REGION) {  end  =readTuple(data,off,acnt);  off+=acnt*2;  }
			out.push([dsiz,tind,flag,start,peak,end]);
		}
		return out;
	}
	
	// Packed "point" numbers
	function readPointNumbers(data, off, gid) {
		var cnt = data[off];  off++;  if(cnt==0) return [[],off];
		if(127<cnt) {  cnt = ((cnt & 127) << 8) | data[off++];  }
		
		//if(gid==116) console.log("---",cnt);
		var pts = [], last=0;  // point number data runs
		while(pts.length<cnt) {
			var v = data[off];  off++;
			var wds = (v&POINTS_ARE_WORDS)!=0;  v=(v&127)+1;
			//if(gid==116) console.log("-",v);
			for(var i=0; i<v; i++) {  
				var dif = 0;
				if(wds) {  dif=bin.readUshort(data,off);  off+=2;  }
				else    {  dif=data[off];  off++;  }
				//if(gid==116) console.log(dif);
				last+=dif;
				pts.push(last); 
			}
		}
		//console.log(pts);
		return [pts,off];
		
		
		//throw "e";
	}
	
	
	function parseTab(data, offset, length, obj) {
		var off = offset+4;
		var acnt = bin.readUshort(data,off);  off+=2;
		var tcnt = bin.readUshort(data,off);  off+=2;
		var toff = bin.readUint  (data,off);  off+=4;
		var gcnt = bin.readUshort(data,off);  off+=2;
		var flgs = bin.readUshort(data,off);  off+=2;
		
		var goff = bin.readUint  (data,off);  off+=4;
		
		// glyphVariationDataOffsets
		var offs = [];  
		if((flgs&1)==0) for(var i=0; i<gcnt+1; i++) offs.push(bin.readUshort(data,off+i*2)*2);
		if((flgs&1)==1) for(var i=0; i<gcnt+1; i++) offs.push(bin.readUint  (data,off+i*4));
		
		// sharedTuples
		var tups = [], mins=[], maxs=[];  off=offset+toff;
		for(var i=0; i<tcnt; i++) {
			var peak = readTuple(data,off+i*acnt*2,acnt), imin=[], imax=[];  tups.push(peak);  mins.push(imin);  maxs.push(imax);
			for(var k=0; k<acnt; k++) {
				imin[k]=Math.min(peak[k],0);
				imax[k]=Math.max(peak[k],0);
			}
		}
		//console.log(tups);
		
		//console.log(acnt,stcnt,stoff,gcnt,flgs,goff);
		
		var i8 = new Int8Array(data.buffer);
		
		// GlyphVariationData table array
		var tabs = [];
		for(var i=0; i<gcnt; i++) {
			//console.log("-------",i);
			off=offset + goff + offs[i];
			// tupleVariationCount
			var vcnt = bin.readUshort(data,off);  off+=2;  //if((vcnt>>>12)!=0) throw "e";
			
			var snum = vcnt&SHARED_POINT_NUMBERS;  vcnt&=0xfff;
			//  offset to the serialized data
			var soff = bin.readUshort(data,off);  off+=2;
			
			var hdr = readTupleVarHeader(data,off,vcnt,acnt,  offset+goff+offs[i+1]);
			
			var tab = [];  tabs.push(tab);
			// Serialized Data
			off=offset + goff + offs[i] + soff;
			
			var sind = [];
			if(snum) {
				var oo = readPointNumbers(data,off,i);
				sind=oo[0];  off=oo[1];
			}
			
			for(var j=0; j<vcnt; j++) {
				var vr = hdr[j], end=off+vr[0];  //console.log(vr);  console.log(data.slice(off,off+vr[0]));
				
				var ind = sind;
				if(vr[2]&PRIVATE_POINT_NUMBERS) {
					var oo = readPointNumbers(data,off,i);
					ind=oo[0];  off=oo[1];
				}
				// read packed deltas (delta runs)
				var ds = [];
				while(off<end) {
					var cb = data[off++];  // control byte;
					var cnt = (cb & 0x3f)+1;
					if     (cb & DELTAS_ARE_ZERO ) {  for(var k=0; k<cnt; k++) ds.push(0);  }
					else if(cb & DELTAS_ARE_WORDS) {  for(var k=0; k<cnt; k++) ds.push(bin.readShort(data,off+k*2));  off+=cnt*2;  }
					else                           {  for(var k=0; k<cnt; k++) ds.push(i8[off+k]);  off+=cnt;  }
				}
				//if(ind) console.log(ind, ds);
				var ti = vr[1];
				
				tab.push([[
						vr[3]?vr[3]:mins[ti],
						vr[4]?vr[4]:tups[ti],
						vr[5]?vr[5]:maxs[ti]
					],ds,ind.length==0?null:ind]);
				
				if(ind.length!=0 && ind.length*2!=ds.length) throw "e";
				//if(i==116) console.log(ind, ds);
			}
		}
		return tabs;
	}
	
	return {parseTab:parseTab};
})();

Typr["T"].avar = {
	parseTab : function(data, offset, length, obj)
	{
		var off = offset;
		var bin = Typr["B"], out = [];
		
		off+=6;
		var acnt = bin.readUshort(data,off);  off+=2;
		
		for(var ai=0; ai<acnt; ai++) {
			var cnt = bin.readUshort(data,off);  off+=2;
			var poly = [];  out.push(poly);
			for(var i=0; i<cnt; i++) {
				var x = bin.readF2dot14(data,off);
				var y = bin.readF2dot14(data,off+2);  off+=4;
				poly.push(x,y);
			}
		}
		
		return out;
	}
};

Typr["T"].HVAR = {
	parseTab : function(data, offset, length, obj)
	{
		var off = offset, oo = offset;
		var bin = Typr["B"], out = [];
		
		//console.log(data.slice(off));
		off+=4;
		
		var varO = bin.readUint(data,off);  off+=4;
		var advO = bin.readUint(data,off);  off+=4;
		var lsbO = bin.readUint(data,off);  off+=4;
		var rsbO = bin.readUint(data,off);  off+=4;
		if(lsbO!=0 || rsbO!=0) throw lsbO;
		
		//console.log(varO,advO,lsbO,rsbO);
		
		off = oo+varO;  // item variation store
		
		// ItemVariationStore 
		var ioff = off;
		
		var fmt = bin.readUshort(data,off);  off+=2;  if(fmt!=1) throw "e";
		var vregO = bin.readUint(data,off);  off+=4;
		// itemVariationDataCount
		var vcnt = bin.readUshort(data,off);  off+=2;
		
		var offs = [];  for(var i=0; i<vcnt; i++) offs.push(bin.readUint(data,off+i*4));  off+=vcnt*4;  //if(offs.length!=1) throw "e";
		//console.log(vregO,vcnt,offs);		
		
		off = ioff+vregO;
		var acnt = bin.readUshort(data,off);  off+=2;
		var rcnt = bin.readUshort(data,off);  off+=2;
		
		var regs = [];
		for(var i=0; i<rcnt; i++) {
			var crd = [[],[],[]];  regs.push(crd);
			for(var j=0; j<acnt; j++) {
				crd[0].push(bin.readF2dot14(data,off+0));
				crd[1].push(bin.readF2dot14(data,off+2));
				crd[2].push(bin.readF2dot14(data,off+4));
				off+=6;
			}
		}
		//console.log(acnt, rcnt, regs);
		
		
		var i8 = new Int8Array(data.buffer);
		var varStore = [];
		for(var i=0; i<offs.length; i++) {
			// ItemVariationData 
			off = oo+varO+offs[i];  var vdata=[];  varStore.push(vdata);
			var icnt = bin.readUshort(data,off);  off+=2;  // itemCount
			var dcnt = bin.readUshort(data,off);  off+=2;  if(dcnt&0x8000) throw "e";
			var rcnt = bin.readUshort(data,off);  off+=2;  
			var ixs = [];  for(var j=0; j<rcnt; j++) ixs.push(bin.readUshort(data,off+j*2));  off+=rcnt*2;
			//console.log(icnt,dcnt,rcnt,ixs);
			//console.log(data.slice(off));
			
			for(var k=0; k<icnt; k++) {  // deltaSets
				var deltaData = [];  //vdata.push(deltaData);
				for(var ri=0; ri<rcnt; ri++) {
					deltaData.push(ri<dcnt ? bin.readShort(data,off) : i8[off]);
					off+= ri<dcnt ? 2 : 1;
					
				}
				var dd = new Array(regs.length);  dd.fill(0);  vdata.push(dd);
				for(var j=0; j<ixs.length; j++) dd[ixs[j]] = deltaData[j];
			}
		}
		
		//console.log(varStore);
		
		// VariationRegionList
		
		
		
		off = oo+advO;  // advance widths
		
		// DeltaSetIndexMap 
		
		var fmt  = data[off++];  if(fmt!=0) throw "e";
		var entryFormat = data[off++];
		
		var mapCount = bin.readUshort(data,off);  off+=2;
		
		var INNER_INDEX_BIT_COUNT_MASK = 0x0f;
		var MAP_ENTRY_SIZE_MASK = 0x30;
		var entrySize = ((entryFormat & MAP_ENTRY_SIZE_MASK) >> 4) + 1;  //if(entrySize!=1) throw entrySize;
		
		//console.log(fmt, entryFormat, mapCount, entrySize);
		
		var dfs=[];
		for(var i=0; i<mapCount; i++) {
			var entry=0;
			if     (entrySize==1)    entry = data[off++];
			else if(entrySize==2) {  entry = bin.readUshort(data,off);  off+=2;  }
			else if(entrySize==3) {  entry = (data[off]<<16)|bin.readUshort(data,off+1);  off+=3;  } //console.log(data.slice(off));  throw "e";  }
			else throw entrySize;
			
			var outerIndex = entry >> ((entryFormat & INNER_INDEX_BIT_COUNT_MASK) + 1);
			var innerIndex = entry & ((1 << ((entryFormat & INNER_INDEX_BIT_COUNT_MASK) + 1)) - 1);
			//map.push(outerIndex,innerIndex);
			dfs.push(varStore[outerIndex][innerIndex]);
			//console.log(outerIndex,innerIndex);
			//console.log(i,varStore[outerIndex][innerIndex]);
		}
		
		return [regs,dfs];
	}
};

Typr["U"] = function() {
	var P = {
		MoveTo    : function(p, x, y)        {  p.cmds.push("M");  p.crds.push(x,y);  },
		LineTo    : function(p, x, y)        {  p.cmds.push("L");  p.crds.push(x,y);  },
		CurveTo   : function(p, a,b,c,d,e,f) {  p.cmds.push("C");  p.crds.push(a,b,c,d,e,f);  },
		qCurveTo  : function(p, a,b,c,d)     {  p.cmds.push("Q");  p.crds.push(a,b,c,d);  },
		ClosePath : function(p)              {  p.cmds.push("Z");  }
	}
	
	function getGlyphPosition(font, gls,i1,ltr) {
		var g1=gls[i1],g2=gls[i1+1], kern=font["kern"];
		if(kern) {
			var ind1 = kern.glyph1.indexOf(g1);
			if(ind1!=-1)
			{
				var ind2 = kern.rval[ind1].glyph2.indexOf(g2);
				if(ind2!=-1) return [0,0,kern.rval[ind1].vals[ind2],0];
			}
		}
		//console.log("no kern");
		return [0,0,0,0];
	}
	function shape(font,str,prm) {
		if(prm==null) prm={};
		var ltr = prm["ltr"], fts = prm["fts"], axs=prm["axs"];
		if(font["fvar"] && axs==null) axs = font["fvar"][1][font["_vindex"]][2];
		
		var HVAR = font["HVAR"];  //console.log(HVAR);
		if(axs && HVAR) {  axs=_normalizeAxis(font,axs);  }  //console.log(S,axs);
		var gls = [];
		for(var i=0; i<str.length; i++) {
			var cc = str.codePointAt(i);  if(cc>0xffff) i++;
			gls.push(codeToGlyph(font, cc));
		}
		var shape = [];
		var x = 0, y = 0;
		
		for(var i=0; i<gls.length; i++) {
			var padj = getGlyphPosition(font, gls,i,ltr);
			var gid = gls[i];  //console.log(gid);
			var ax=font["hmtx"].aWidth[gid]+padj[2];
			if(HVAR && HVAR[1][gid]) { //ax+=S*HVAR[1][gid][0];
				var difs = HVAR[1][gid];  //console.log(difs);
				for(var j=0; j<HVAR[0].length; j++) {
					ax += _interpolate(HVAR[0][j],axs) * difs[j];
				}
			}
			shape.push({"g":gid, "cl":i, "dx":0, "dy":0, "ax":ax, "ay":0});
			x+=ax;
		}
		return shape;
	}
	
	function shapeToPath(font,shape,prm) {
		var tpath = {cmds:[], crds:[]};
		var x = 0, y = 0, clr, axs;
		if(prm) {  clr = prm["clr"];  axs=prm["axs"];  }
		
		for(var i=0; i<shape.length; i++) {
			var it = shape[i]
			var path = glyphToPath(font, it["g"],false,axs), crds=path["crds"];
			for(var j=0; j<crds.length; j+=2) {
				tpath.crds.push(crds[j  ] + x + it["dx"]);
				tpath.crds.push(crds[j+1] + y + it["dy"]);
			}
			if(clr) tpath.cmds.push(clr);
			for(var j=0; j<path["cmds"].length; j++) tpath.cmds.push(path["cmds"][j]);
			var clen = tpath.cmds.length;
			if(clr) if(clen!=0 && tpath.cmds[clen-1]!="X") tpath.cmds.push("X");  // SVG fonts might contain "X". Then, nothing would stroke non-SVG glyphs.
			
			x += it["ax"];  y+= it["ay"];
		}
		return {"cmds":tpath.cmds, "crds":tpath.crds};
	}
	
	
	// find the greatest index with a value <=v
	function arrSearch(arr, k, v) {
		var l=0, r=~~(arr.length/k);
		while(l+1!=r) {  var mid = l + ((r-l)>>>1);   if(arr[mid*k]<=v) l=mid;  else r=mid;  }
		
		//var mi = 0;  for(var i=0; i<arr.length; i+=k) if(arr[i]<=v) mi=i;  if(mi!=l*k) throw "e";
		
		return l*k;
	}
		
	var wha = [0x9,0xa,0xb,0xc,0xd,0x20,0x85,0xa0,0x1680,0x180e,0x2028,0x2029,0x202f,0x2060,0x3000,0xfeff], whm={};
	for(var i=0; i<wha.length; i++) whm[wha[i]]=1;
	for(var i=0x2000; i<=0x200d; i++) whm[i]=1;

	function codeToGlyph (font, code) {
		//console.log(cmap);
		// "p3e10" for NotoEmoji-Regular.ttf
		//console.log(cmap);
		
		if(font["_ctab"]==null) {
			var cmap = font["cmap"];
			var tind = -1, pps=["p3e10","p0e4","p3e1","p1e0","p0e3","p0e1"/*,"p3e3"*/,"p3e0" /*Hebrew*/, "p3e5" /*Korean*/];
			for(var i=0; i<pps.length; i++) if(cmap.ids[pps[i]]!=null) {  tind=cmap.ids[pps[i]];  break;  }
			if(tind==-1) throw "no familiar platform and encoding!";
			font["_ctab"]=cmap.tables[tind];
		}
		
		var tab = font["_ctab"], fmt=tab.format, gid = -1;  //console.log(fmt); throw "e";
		
		if(fmt==0) {
			if(code>=tab.map.length) gid = 0;
			else gid = tab.map[code];
		}
		/*else if(fmt==2) {
			var data=font["_data"], off = cmap.off+tab.off+6, bin=Typr["B"];
			var shKey = bin.readUshort(data,off + 2*(code>>>8));
			var shInd = off + 256*2 + shKey*8;
			
			var firstCode = bin.readUshort(data,shInd);
			var entryCount= bin.readUshort(data,shInd+2);
			var idDelta   = bin.readShort (data,shInd+4);
			var idRangeOffset = bin.readUshort(data,shInd+6);
			
			if(firstCode<=code && code<=firstCode+entryCount) {
				// not completely correct
				gid = bin.readUshort(data, shInd+6+idRangeOffset + (code&255)*2);
			}
			else gid=0;
			//if(code>256) console.log(code,(code>>>8),shKey,firstCode,entryCount,idDelta,idRangeOffset);
			
			//throw "e";
			//console.log(tab,  bin.readUshort(data,off));
			//throw "e";
		}*/
		else if(fmt==4) {
			var ec = tab.endCount;  gid=0;
			if(code<=ec[ec.length-1]) {
				// smallest index with code <= value
				var sind = arrSearch(ec,1,code);
				if(ec[sind]<code) sind++;
				
				if(code>=tab.startCount[sind]) {
					var gli = 0;
					if(tab.idRangeOffset[sind]!=0) gli = tab.glyphIdArray[(code-tab.startCount[sind]) + (tab.idRangeOffset[sind]>>1) - (tab.idRangeOffset.length-sind)];
					else                           gli = code + tab.idDelta[sind];
					gid = (gli & 0xFFFF);
				}
			}
		}
		else if(fmt==6) {
			var off = code-tab.firstCode, arr=tab.glyphIdArray;
			if(off<0 || off>=arr.length) gid=0;
			else gid = arr[off];
		}
		else if(fmt==12) {
			var grp = tab.groups;  gid=0;  //console.log(grp);  throw "e";
			
			if(code<=grp[grp.length-2]) {
				var i = arrSearch(grp,3,code);
				if(grp[i]<=code && code<=grp[i+1]) {  gid = grp[i+2] + (code-grp[i]);  }
			}
		}
		else throw "unknown cmap table format "+tab.format;
		
		//*
		var SVG = font["SVG "], loca = font["loca"];
		// if the font claims to have a Glyph for a character, but the glyph is empty, and the character is not "white", it is a lie!
		if(gid!=0 && font["CFF "]==null && (SVG==null || SVG.entries[gid]==null) && loca && loca[gid]==loca[gid+1]  // loca not present in CFF or SVG fonts
			&& whm[code]==null )  gid=0;
		//*/
		
		return gid;
	}
	function glyphToPath(font, gid, noColor,axs) {
		var path = { cmds:[], crds:[] };
		
		if(font["fvar"]) {
			if(axs==null) axs = font["fvar"][1][font["_vindex"]][2];
			axs=_normalizeAxis(font,axs);
		}
		
		var SVG = font["SVG "], CFF = font["CFF "], COLR=font["COLR"], CBLC=font["CBLC"], CBDT=font["CBDT"], sbix=font["sbix"], upng=window["UPNG"];
		
		var strike = null;
		if(CBLC && upng) for(var i=0; i<CBLC.length; i++) if(CBLC[i][0]<=gid && gid<=CBLC[i][1]) strike=CBLC[i];
		
		if(strike || (sbix && sbix[gid])) {
			if(strike && strike[2]!=17) throw "not a PNG";
			
			if(font["__tmp"]==null) font["__tmp"]={};
			var cmd = font["__tmp"]["g"+gid];
			if(cmd==null) {
				var bmp, len;
				if(sbix) {  bmp = sbix[gid];  len=bmp.length;  }
				else {
					var boff = strike[3][gid-strike[0]]+5;  // smallGlyphMetrics
					len = (CBDT[boff+1]<<16)|(CBDT[boff+2]<<8)|CBDT[boff+3];  boff+=4;
					bmp = new Uint8Array(CBDT.buffer, CBDT.byteOffset+boff,len);
				}				
				var str = "";  for(var i=0; i<len; i++) str+=String.fromCharCode(bmp[i]);
				cmd = font["__tmp"]["g"+gid] = "data:image/png;base64,"+btoa(str);
			}
			
			path.cmds.push(cmd);
			var upe = font["head"]["unitsPerEm"]*1.15;
			var gw=Math.round(upe), gh=Math.round(upe), dy=Math.round(-gh*0.15);
			path.crds.push(0,gh+dy, gw,gh+dy, gw,dy, 0,dy); //*/
		}
		else if(SVG && SVG.entries[gid]) {
			var p = SVG.entries[gid];  
			if(p!=null) {
				if(typeof p == "number") {  
					var svg = SVG.svgs[p];
					if(typeof svg == "string") {
						var prsr = new DOMParser();
						var doc = prsr["parseFromString"](svg,"image/svg+xml");
						svg = SVG.svgs[p] = doc.getElementsByTagName("svg")[0];
					}
					p = Typr["U"]["SVG"].toPath(svg,gid);  SVG.entries[gid]=p;  
				}
				path=p;
			}
		}
		else if(noColor!=true && COLR && COLR[0]["g"+gid] && COLR[0]["g"+gid][1]>1) {
			
			function toHex(n){  var o=n.toString(16);  return (o.length==1 ? "0":"")+o;  }
			
			var CPAL = font["CPAL"], gl = COLR[0]["g"+gid];
			for(var i=0; i<gl[1]; i++) {
				var lid = gl[0]+i;
				var cgl = COLR[1][2*lid], pid=COLR[1][2*lid+1]*4;
				var pth = glyphToPath(font,cgl, cgl==gid);
				
				var col = "#"+toHex(CPAL[pid+2])+toHex(CPAL[pid+1])+toHex(CPAL[pid+0]);
				path.cmds.push(col);
				
				path.cmds=path.cmds.concat(pth["cmds"]);
				path.crds=path.crds.concat(pth["crds"]);
				//console.log(gid, cgl,pid,col);
				
				path.cmds.push("X");
			}
		}
		else if(CFF) {
			var pdct = CFF["Private"];
			var state = {x:0,y:0,stack:[],nStems:0,haveWidth:false,width: pdct ? pdct["defaultWidthX"] : 0,open:false};
			if(CFF["ROS"]) {
				var gi = 0;
				while(CFF["FDSelect"][gi+2]<=gid) gi+=2;
				pdct = CFF["FDArray"][CFF["FDSelect"][gi+1]]["Private"];
			}
			_drawCFF(CFF["CharStrings"][gid], state, CFF, pdct, path);
		}
		else if(font["glyf"]) {  _drawGlyf(gid, font, path,axs);  }
		return {"cmds":path.cmds, "crds":path.crds};
	}

	function _drawGlyf(gid, font, path,axs)
	{
		var gl = font["glyf"][gid];
		
		if(gl==null) gl = font["glyf"][gid] = Typr["T"].glyf._parseGlyf(font, gid);
		if(gl!=null){
			if(gl.noc>-1) _simpleGlyph(gl, font, gid, path,axs);
			else          _compoGlyph (gl, font, gid, path,axs);
		}
	}
	function _interpolate(axs,v) {
		var acnt = v.length, S = 1;
		var s = axs[0];  // start
		var p = axs[1];  // peak
		var e = axs[2];  // end
		
		for(var i=0; i<v.length; i++) {
			var AS = 1;
			if      (s[i] > p[i] || p[i] > e[i]) AS = 1;
			else if (s[i] < 0 && e[i] > 0 && p[i] != 0) AS = 1;
			else if (p[i] == 0) AS = 1;
			else if (v[i] < s[i] || v[i] > e[i])    AS = 0;
			else {
				if      (v[i] ==p[i]) AS = 1;
				else if (v[i] < p[i]) AS = (v[i] - s[i]) / (p[i] - s[i]);
				else                  AS = (e[i] - v[i]) / (e[i] - p[i]);
			}
			S = S * AS;
		}
		return S;
	}
	function _normalizeAxis(font,vv) {
		var fvar = font["fvar"], avar = font["avar"];
		var fv = fvar?fvar[0  ]:null;
		
		var nv = [];
		for(var i=0; i<fv.length; i++) {
			var min=fv[i][1], def = fv[i][2], max=fv[i][3], v=Math.max(min, Math.min(max, vv[i]));
			if     (v<def) nv[i]=(def-v)/(min-def);
			else if(v>def) nv[i]=(v-def)/(max-def);
			else nv[i]=0;
			
			if(avar && nv[i]!=-1) {
				var av = avar[i], j=0;
				for(; j<av.length; j+=2) if(av[j]>=nv[i]) break;
				var f=(nv[i]-av[j-2])/(av[j]-av[j-2]);
				nv[i] = f*av[j+1] + (1-f)*av[j-1];
			}
			
		}
		return nv;
	}
	function interpolateDeltas(dfs,ind,xs,ys, endPts) {
		var N=xs.length, ndfs = new Array(N*2+8);  ndfs.fill(0);
		for(var i=0; i<N; i++) {
			var dx=0, dy=0, ii=ind.indexOf(i);
			if(ii!=-1) {  dx=dfs[ii];  dy=dfs[ind.length+ii];  }
			else {
				var cmp = 0;  while(endPts[cmp]<i) cmp++;
				var cmp0 = cmp==0 ? 0 : endPts[cmp-1]+1;
				var cmp1 = endPts[cmp];
				
				var i0=-1, i1=-1;
				
				for(var j=0; j<ind.length; j++) {  var v=ind[j];  if(v<cmp0 || v>cmp1 || v>=N) continue;  i0=j;  if(i1==-1) i1=j;   }
				for(var j=0; j<ind.length; j++) {  var v=ind[j];  if(v<cmp0 || v>cmp1 || v>=N) continue;  if(v<i) i0=j;  if(i<v) {  i1=j;  break;  }   }
				
				//var i0 = ind.length-1, i1=0;  if(ind[i0]>=N) i0--;
				//for(var j=0; j<ind.length; j++) {  var v=ind[j];  if(v<N) { if(v<i) i0=j;  if(i<v) {  i1=j;  break;  }  }  }
				for(var ax=0; ax<2; ax++) {
					var crd = ax==0 ? xs : ys, ofs=ax*ind.length, dlt=0;
					var c0 = crd[ind[i0]], c1=crd[ind[i1]], cC = crd[i];
					var d0 = dfs[ofs+i0 ], d1=dfs[ofs+i1 ];
								
					if(c0==c1) {
						if(d0==d1) dlt=d0;
						else       dlt=0;
					}
					else {
						if(cC <= Math.min(c0,c1)) {
							if(c0<c1) dlt = d0;
							else      dlt = d1;
						}
						else if(Math.max(c0,c1) <= cC) {
							if(c0<c1) dlt = d1;
							else      dlt = d0;
						}
						else {
							var prop = (cC-c0) / (c1-c0);  //if(prop<0) throw "e";
							dlt = prop*d1 + (1-prop)*d0;
						}
					}
					if(ax==0) dx=dlt;  else dy=dlt;
				}
			}
			ndfs[i]=dx;  ndfs[N+4+i]=dy;
		}
		return ndfs;			
	}
	function _simpleGlyph(gl, font, gid, p, axs) {		
		var xs = gl.xs, ys = gl.ys;
		//*
		if(font["fvar"] && axs) {
			xs=xs.slice(0);  ys=ys.slice(0);
			var gvar = font["gvar"];
			var gv = gvar?gvar[gid]:null;
			
			for(var vi=0; vi<gv.length; vi++) {
				var axv = gv[vi][0];  //console.log(axs);
				var S = _interpolate(axv,axs);  if(S<1e-9) continue;
				var dfs = gv[vi][1], ind=gv[vi][2];  //if(dfs.length!=2*xs.length+8) throw "e";
				//console.log(vi,S,axv,ind,dfs);
				if(ind) {  dfs = gv[vi][1] = interpolateDeltas(dfs,ind,xs,ys,gl.endPts);  gv[vi][2] = null;  }
				//if(ind==null)
				if(dfs.length==xs.length*2+8)
				for(var i=0; i<xs.length; i++) {
					xs[i]+=S*dfs[i];
					ys[i]+=S*dfs[i+xs.length+4];
				}
			}
		} //*/
		
		for(var c=0; c<gl.noc; c++) {
			var i0 = (c==0) ? 0 : (gl.endPts[c-1] + 1);
			var il = gl.endPts[c];
			
			for(var i=i0; i<=il; i++) {
				var pr = (i==i0)?il:(i-1);
				var nx = (i==il)?i0:(i+1);
				var onCurve = gl.flags[i]&1;
				var prOnCurve = gl.flags[pr]&1;
				var nxOnCurve = gl.flags[nx]&1;
				
				var x = xs[i], y = ys[i];
				
				if(i==i0) { 
					if(onCurve) {
						if(prOnCurve) P.MoveTo(p, xs[pr], ys[pr]); 
						else          {  P.MoveTo(p,x,y);  continue;  /*  will do CurveTo at il  */  }
					}
					else {
						if(prOnCurve) P.MoveTo(p,  xs[pr],     ys[pr]        );
						else          P.MoveTo(p, Math.floor((xs[pr]+x)*0.5), Math.floor((ys[pr]+y)*0.5)   ); 
					}
				}
				if(onCurve) {
					if(prOnCurve) P.LineTo(p,x,y);
				}
				else {
					if(nxOnCurve) P.qCurveTo(p, x, y, xs[nx], ys[nx]); 
					else          P.qCurveTo(p, x, y, Math.floor((x+xs[nx])*0.5), Math.floor((y+ys[nx])*0.5) ); 
				}
			}
			P.ClosePath(p);
		}
	}
	function _compoGlyph(gl, font, gid, p, axs) {
		
		var dx = [0,0,0,0,0,0], dy=[0,0,0,0,0,0], ccnt = gl.parts.length;
		while(dx.length<ccnt) {  dx.push(0);  dy.push(0);  }
		
		if(font["fvar"] && axs) {
			var gvar = font["gvar"];
			var gv = gvar?gvar[gid]:null;
			for(var vi=0; vi<gv.length; vi++) {
				var axv = gv[vi][0];  //console.log(axs);
				var S = _interpolate(axv,axs);  if(S<1e-6) continue;
				var dfs = gv[vi][1], ind=gv[vi][2];  //if(dfs.length!=2*ccnt+8) throw "e";
				if(ind==null)
				for(var i=0; i<ccnt; i++) {
					dx[i]+=S*dfs[i];
					dy[i]+=S*dfs[i+ccnt+4];
				}
				else
				for(var j=0; j<ind.length; j++) {
					var i = ind[j];
					dx[i]+=S*dfs[0];
					dy[i]+=S*dfs[0+ccnt];
				}
			}
		}
		
		for(var j=0; j<ccnt; j++) {
			var path = { cmds:[], crds:[] };
			var prt = gl.parts[j];
			_drawGlyf(prt.glyphIndex, font, path, axs);
			
			var m = prt.m, tx=m.tx+dx[j], ty=m.ty+dy[j];
			for(var i=0; i<path.crds.length; i+=2) {
				var x = path.crds[i  ], y = path.crds[i+1];
				p.crds.push(x*m.a + y*m.c + tx);   // not sure, probably right
				p.crds.push(x*m.b + y*m.d + ty);
			}
			for(var i=0; i<path.cmds.length; i++) p.cmds.push(path.cmds[i]);
		}
	}

	function pathToSVG(path, prec) {
		var cmds = path["cmds"], crds = path["crds"];
		if(prec==null) prec = 5;
		function num(v) {  return parseFloat(v.toFixed(prec));  }
		function merge(o) {
			var no = [], lstF=false, lstC="";
			for(var i=0; i<o.length; i++) {
				var it=o[i], isF=(typeof it)=="number";
				if(!isF) {  if(it==lstC && it.length==1 && it!="m") continue;  lstC=it;  }  // move should not be merged (it actually means lineTo)
				if(lstF && isF && it>=0) no.push(" ");
				no.push(it);  lstF=isF;
			}
			return no.join("");
		}
		
		
		var out = [], co = 0, lmap = {"M":2,"L":2,"Q":4,"C":6};
		var x =0, y =0, // perfect coords
			//dx=0, dy=0, // relative perfect coords
			//rx=0, ry=0, // relative rounded coords
			ex=0, ey=0, // error between perfect and output coords
			mx=0, my=0; // perfect coords of the last "Move"
		
		for(var i=0; i<cmds.length; i++) {
			var cmd = cmds[i], cc=(lmap[cmd]?lmap[cmd]:0); 
			
			var o0=[], dx, dy, rx, ry;  // o1=[], cx, cy, ax,ay;
			if(cmd=="L") {
				dx=crds[co]-x;  dy=crds[co+1]-y;
				rx = num(dx+ex);  ry=num(dy+ey);
				// if this "lineTo" leads to the starting point, and "Z" follows, do not output anything.
				if(cmds[i+1]=="Z" && crds[co]==mx && crds[co+1]==my) {  rx=dx;  ry=dy;  }
				else if(rx==0 && ry==0) {}
				else if(rx==0) o0.push("v",ry);
				else if(ry==0) o0.push("h",rx);
				else {  o0.push("l",rx,ry);  }
			}
			else {
				o0.push(cmd.toLowerCase());
				for(var j=0; j<cc; j+=2) {
					dx = crds[co+j]-x;  dy=crds[co+j+1]-y;  
					rx = num(dx+ex);  ry=num(dy+ey);
					o0.push(rx,ry);
				}
			}
			if(cc!=0) {  ex += dx-rx;  ey += dy-ry;  }
			
			var ou=o0;
			for(var j=0; j<ou.length; j++) out.push(ou[j]);
			
			if(cc !=0  ) {  co+=cc;  x=crds[co-2];  y=crds[co-1];    }
			if(cmd=="M") {  mx=x;  my=y;  }
			if(cmd=="Z") {  x=mx;  y=my;  }
		}
		
		return merge(out);
	}
	function SVGToPath(d) {
		var pth = {cmds:[], crds:[]};
		Typr["U"]["SVG"].svgToPath(d, pth);
		return {"cmds":pth.cmds, "crds":pth.crds};
	}

	function mipmapB(buff, w,h, hlp) {
		var nw = w>>1, nh = h>>1;
		var nbuf = (hlp && hlp.length==nw*nh*4) ? hlp : new Uint8Array(nw*nh*4);
		var sb32 = new Uint32Array(buff.buffer), nb32 = new Uint32Array(nbuf.buffer);
		for(var y=0; y<nh; y++)
			for(var x=0; x<nw; x++) {
				var ti = (y*nw+x), si = ((y<<1)*w+(x<<1));
				//nbuf[ti  ] = buff[si  ];  nbuf[ti+1] = buff[si+1];  nbuf[ti+2] = buff[si+2];  nbuf[ti+3] = buff[si+3];
				//*
				var c0 = sb32[si], c1 = sb32[si+1], c2 = sb32[si+w], c3 = sb32[si+w+1];
				
				var a0 = (c0>>>24), a1 = (c1>>>24), a2 = (c2>>>24), a3 = (c3>>>24), a = (a0+a1+a2+a3);
				
				if(a==1020) {
					var r = (((c0>>> 0)&255) + ((c1>>> 0)&255) + ((c2>>> 0)&255) + ((c3>>> 0)&255)+2)>>>2; 
					var g = (((c0>>> 8)&255) + ((c1>>> 8)&255) + ((c2>>> 8)&255) + ((c3>>> 8)&255)+2)>>>2; 
					var b = (((c0>>>16)&255) + ((c1>>>16)&255) + ((c2>>>16)&255) + ((c3>>>16)&255)+2)>>>2; 
					nb32[ti] = (255<<24) | (b<<16) | (g<<8) | r;
				}
				else if(a==0) nb32[ti] = 0;
				else {
					var r = ((c0>>> 0)&255)*a0 + ((c1>>> 0)&255)*a1 + ((c2>>> 0)&255)*a2 + ((c3>>> 0)&255)*a3; 
					var g = ((c0>>> 8)&255)*a0 + ((c1>>> 8)&255)*a1 + ((c2>>> 8)&255)*a2 + ((c3>>> 8)&255)*a3; 
					var b = ((c0>>>16)&255)*a0 + ((c1>>>16)&255)*a1 + ((c2>>>16)&255)*a2 + ((c3>>>16)&255)*a3; 
				
					var ia = 1/a;   r = ~~(r*ia+0.5);  g = ~~(g*ia+0.5);  b = ~~(b*ia+0.5);
					nb32[ti] = (((a+2)>>>2)<<24) | (b<<16) | (g<<8) | r;
				}
			}
		return {  buff:nbuf, w:nw, h:nh  };
	}
		
	var __cnv, __ct;
	function pathToContext(path, ctx) {
		var c = 0, cmds = path["cmds"], crds = path["crds"];
		
		//ctx.translate(3500,500);  ctx.rotate(0.25);  ctx.scale(1,-1);
		
		for(var j=0; j<cmds.length; j++) {
			var cmd = cmds[j];
			if     (cmd=="M") {
				ctx.moveTo(crds[c], crds[c+1]);
				c+=2;
			}
			else if(cmd=="L") {
				ctx.lineTo(crds[c], crds[c+1]);
				c+=2;
			}
			else if(cmd=="C") {
				ctx.bezierCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3], crds[c+4], crds[c+5]);
				c+=6;
			}
			else if(cmd=="Q") {
				ctx.quadraticCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3]);
				c+=4;
			}
			else if(cmd[0]=="d") {
				var upng=window["UPNG"];
				var x0 = crds[c], y0=crds[c+1], x1=crds[c+2], y1=crds[c+3], x2=crds[c+4], y2=crds[c+5], x3=crds[c+6], y3=crds[c+7];  c+=8;
				//y0+=400;  y1+=400;  y1+=600;
				if(upng==null) {
					ctx.moveTo(x0,y0);  ctx.lineTo(x1,y1);  ctx.lineTo(x2,y2);  ctx.lineTo(x3,y3);  ctx.closePath();
					continue;
				}
				var dx0 = (x1-x0), dy0=(y1-y0), dx1 = (x3-x0), dy1=(y3-y0);
				var sbmp = atob(cmd.slice(22));
				var bmp = new Uint8Array(sbmp.length);
				for(var i=0; i<sbmp.length; i++) bmp[i]=sbmp.charCodeAt(i);
				
				var img = upng["decode"](bmp.buffer), w=img["width"], h=img["height"];  //console.log(img);
				
				var nbmp = new Uint8Array(upng["toRGBA8"](img)[0]);  
				var tr = ctx["getTransform"]();
				var scl = Math.sqrt(Math.abs(tr["a"]*tr["d"]-tr["b"]*tr["c"])) * Math.sqrt(dx1*dx1+dy1*dy1)/h;
				while(scl<0.5) {
					var nd = mipmapB(nbmp,w,h);
					nbmp = nd.buff;  w=nd.w;  h=nd.h;  scl*=2;
				}
				
				if(__cnv==null) {  __cnv = document.createElement("canvas");  __ct=__cnv.getContext("2d");  }
				if(__cnv.width!=w || __cnv.height!=h) {  __cnv.width=w;  __cnv.height=h;  }
				
				__ct.putImageData(new ImageData(new Uint8ClampedArray(nbmp.buffer),w,h),0,0);
				ctx.save();
				ctx.transform(dx0,dy0,dx1,dy1,x0,y0);
				ctx.scale(1/w,1/h);
				ctx.drawImage(__cnv,0,0); //*/
				ctx.restore();
			}
			else if(cmd.charAt(0)=="#" || cmd.charAt(0)=="r") {
				ctx.beginPath();
				ctx.fillStyle = cmd;
			}
			else if(cmd.charAt(0)=="O" && cmd!="OX") {
				ctx.beginPath();
				var pts = cmd.split("-");
				ctx.lineWidth=parseFloat(pts[2]);
				ctx.lineCap  = ["butt","round","square"][parseFloat(pts[3])];
				ctx.lineJoin = ["miter","round","bevel"][parseFloat(pts[4])];
				ctx.miterLimit = parseFloat(pts[5]);
				ctx.lineDashOffset = parseFloat(pts[6]);
				ctx.setLineDash(pts[7].split(",").map(parseFloat));
				ctx.strokeStyle = pts[1];
			}
			else if(cmd=="Z") {
				ctx.closePath();
			}
			else if(cmd=="X") {
				ctx.fill();
			}
			else if(cmd=="OX") {
				ctx.stroke();
			}
		}
	}


	function _drawCFF(cmds, state, font, pdct, p)
	{
		var stack = state.stack;
		var nStems = state.nStems, haveWidth=state.haveWidth, width=state.width, open=state.open;
		var i=0;
		var x=state.x, y=state.y, c1x=0, c1y=0, c2x=0, c2y=0, c3x=0, c3y=0, c4x=0, c4y=0, jpx=0, jpy=0;
		var CFF = Typr["T"].CFF;
		
		var nominalWidthX = pdct["nominalWidthX"];
		var o = {val:0,size:0};
		//console.log(cmds);
		while(i<cmds.length)
		{
			CFF.getCharString(cmds, i, o);
			var v = o.val;
			i += o.size;
				
			if(false) {}
			else if(v=="o1" || v=="o18")  //  hstem || hstemhm
			{
				var hasWidthArg;

				// The number of stem operators on the stack is always even.
				// If the value is uneven, that means a width is specified.
				hasWidthArg = stack.length % 2 !== 0;
				if (hasWidthArg && !haveWidth) {
					width = stack.shift() + nominalWidthX;
				}

				nStems += stack.length >> 1;
				stack.length = 0;
				haveWidth = true;
			}
			else if(v=="o3" || v=="o23")  // vstem || vstemhm
			{
				var hasWidthArg;

				// The number of stem operators on the stack is always even.
				// If the value is uneven, that means a width is specified.
				hasWidthArg = stack.length % 2 !== 0;
				if (hasWidthArg && !haveWidth) {
					width = stack.shift() + nominalWidthX;
				}

				nStems += stack.length >> 1;
				stack.length = 0;
				haveWidth = true;
			}
			else if(v=="o4")
			{
				if (stack.length > 1 && !haveWidth) {
							width = stack.shift() + nominalWidthX;
							haveWidth = true;
						}
				if(open) P.ClosePath(p);

						y += stack.pop();
						P.MoveTo(p,x,y);   open=true;
			}
			else if(v=="o5")
			{
				while (stack.length > 0) {
							x += stack.shift();
							y += stack.shift();
							P.LineTo(p, x, y);
						}
			}
			else if(v=="o6" || v=="o7")  // hlineto || vlineto
			{
				var count = stack.length;
				var isX = (v == "o6");
				
				for(var j=0; j<count; j++) {
					var sval = stack.shift();
					
					if(isX) x += sval;  else  y += sval;
					isX = !isX;
					P.LineTo(p, x, y);
				}
			}
			else if(v=="o8" || v=="o24")	// rrcurveto || rcurveline
			{
				var count = stack.length;
				var index = 0;
				while(index+6 <= count) {
					c1x = x + stack.shift();
					c1y = y + stack.shift();
					c2x = c1x + stack.shift();
					c2y = c1y + stack.shift();
					x = c2x + stack.shift();
					y = c2y + stack.shift();
					P.CurveTo(p, c1x, c1y, c2x, c2y, x, y);
					index+=6;
				}
				if(v=="o24")
				{
					x += stack.shift();
					y += stack.shift();
					P.LineTo(p, x, y);
				}
			}
			else if(v=="o11")  break;
			else if(v=="o1234" || v=="o1235" || v=="o1236" || v=="o1237")//if((v+"").slice(0,3)=="o12")
			{
				if(v=="o1234")
				{
					c1x = x   + stack.shift();    // dx1
					c1y = y;                      // dy1
					c2x = c1x + stack.shift();    // dx2
					c2y = c1y + stack.shift();    // dy2
					jpx = c2x + stack.shift();    // dx3
					jpy = c2y;                    // dy3
					c3x = jpx + stack.shift();    // dx4
					c3y = c2y;                    // dy4
					c4x = c3x + stack.shift();    // dx5
					c4y = y;                      // dy5
					x = c4x + stack.shift();      // dx6
					P.CurveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
					P.CurveTo(p, c3x, c3y, c4x, c4y, x, y);
					
				}
				if(v=="o1235")
				{
					c1x = x   + stack.shift();    // dx1
					c1y = y   + stack.shift();    // dy1
					c2x = c1x + stack.shift();    // dx2
					c2y = c1y + stack.shift();    // dy2
					jpx = c2x + stack.shift();    // dx3
					jpy = c2y + stack.shift();    // dy3
					c3x = jpx + stack.shift();    // dx4
					c3y = jpy + stack.shift();    // dy4
					c4x = c3x + stack.shift();    // dx5
					c4y = c3y + stack.shift();    // dy5
					x = c4x + stack.shift();      // dx6
					y = c4y + stack.shift();      // dy6
					stack.shift();                // flex depth
					P.CurveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
					P.CurveTo(p, c3x, c3y, c4x, c4y, x, y);
				}
				if(v=="o1236")
				{
					c1x = x   + stack.shift();    // dx1
					c1y = y   + stack.shift();    // dy1
					c2x = c1x + stack.shift();    // dx2
					c2y = c1y + stack.shift();    // dy2
					jpx = c2x + stack.shift();    // dx3
					jpy = c2y;                    // dy3
					c3x = jpx + stack.shift();    // dx4
					c3y = c2y;                    // dy4
					c4x = c3x + stack.shift();    // dx5
					c4y = c3y + stack.shift();    // dy5
					x = c4x + stack.shift();      // dx6
					P.CurveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
					P.CurveTo(p, c3x, c3y, c4x, c4y, x, y);
				}
				if(v=="o1237")
				{
					c1x = x   + stack.shift();    // dx1
					c1y = y   + stack.shift();    // dy1
					c2x = c1x + stack.shift();    // dx2
					c2y = c1y + stack.shift();    // dy2
					jpx = c2x + stack.shift();    // dx3
					jpy = c2y + stack.shift();    // dy3
					c3x = jpx + stack.shift();    // dx4
					c3y = jpy + stack.shift();    // dy4
					c4x = c3x + stack.shift();    // dx5
					c4y = c3y + stack.shift();    // dy5
					if (Math.abs(c4x - x) > Math.abs(c4y - y)) {
						x = c4x + stack.shift();
					} else {
						y = c4y + stack.shift();
					}
					P.CurveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
					P.CurveTo(p, c3x, c3y, c4x, c4y, x, y);
				}
			}
			else if(v=="o14")
			{
				if (stack.length > 0 && stack.length!=4 && !haveWidth) {
							width = stack.shift() + font["nominalWidthX"];
							haveWidth = true;
						}
				if(stack.length==4) // seac = standard encoding accented character
				{
				
					var asb = 0;
					var adx = stack.shift();
					var ady = stack.shift();
					var bchar = stack.shift();
					var achar = stack.shift();
				
					
					var bind = CFF.glyphBySE(font, bchar);
					var aind = CFF.glyphBySE(font, achar);
					
					//console.log(bchar, bind);
					//console.log(achar, aind);
					//state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
					
					_drawCFF(font["CharStrings"][bind], state,font,pdct,p);
					state.x = adx; state.y = ady;
					_drawCFF(font["CharStrings"][aind], state,font,pdct,p);
					
					//x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
				}
				if(open) {  P.ClosePath(p);  open=false;  }
			}		
			else if(v=="o19" || v=="o20") 
			{ 
				var hasWidthArg;

				// The number of stem operators on the stack is always even.
				// If the value is uneven, that means a width is specified.
				hasWidthArg = stack.length % 2 !== 0;
				if (hasWidthArg && !haveWidth) {
					width = stack.shift() + nominalWidthX;
				}

				nStems += stack.length >> 1;
				stack.length = 0;
				haveWidth = true;
				
				i += (nStems + 7) >> 3;
			}
			
			else if(v=="o21") {
				if (stack.length > 2 && !haveWidth) {
							width = stack.shift() + nominalWidthX;
							haveWidth = true;
						}

						y += stack.pop();
						x += stack.pop();
						
						if(open) P.ClosePath(p);
						P.MoveTo(p,x,y);   open=true;
			}
			else if(v=="o22")
			{
				 if (stack.length > 1 && !haveWidth) {
							width = stack.shift() + nominalWidthX;
							haveWidth = true;
						}
						
						x += stack.pop();
						
						if(open) P.ClosePath(p);
						P.MoveTo(p,x,y);   open=true;                    
			}
			else if(v=="o25")
			{
				while (stack.length > 6) {
							x += stack.shift();
							y += stack.shift();
							P.LineTo(p, x, y);
						}

						c1x = x + stack.shift();
						c1y = y + stack.shift();
						c2x = c1x + stack.shift();
						c2y = c1y + stack.shift();
						x = c2x + stack.shift();
						y = c2y + stack.shift();
						P.CurveTo(p, c1x, c1y, c2x, c2y, x, y);
			}
			else if(v=="o26") 
			{
				if (stack.length % 2) {
							x += stack.shift();
						}

						while (stack.length > 0) {
							c1x = x;
							c1y = y + stack.shift();
							c2x = c1x + stack.shift();
							c2y = c1y + stack.shift();
							x = c2x;
							y = c2y + stack.shift();
							P.CurveTo(p, c1x, c1y, c2x, c2y, x, y);
						}

			}
			else if(v=="o27")
			{
				if (stack.length % 2) {
							y += stack.shift();
						}

						while (stack.length > 0) {
							c1x = x + stack.shift();
							c1y = y;
							c2x = c1x + stack.shift();
							c2y = c1y + stack.shift();
							x = c2x + stack.shift();
							y = c2y;
							P.CurveTo(p, c1x, c1y, c2x, c2y, x, y);
						}
			}
			else if(v=="o10" || v=="o29")	// callsubr || callgsubr
			{
				var obj = (v=="o10" ? pdct : font);
				if(stack.length==0) { console.log("error: empty stack");  }
				else {
					var ind = stack.pop();
					var subr = obj["Subrs"][ ind + obj["Bias"] ];
					state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
					_drawCFF(subr, state,font,pdct,p);
					x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
				}
			}
			else if(v=="o30" || v=="o31")   // vhcurveto || hvcurveto
			{
				var count, count1 = stack.length;
				var index = 0;
				var alternate = v == "o31";
				
				count  = count1 & ~2;
				index += count1 - count;
				
				while ( index < count ) 
				{
					if(alternate)
					{
						c1x = x + stack.shift();
						c1y = y;
						c2x = c1x + stack.shift();
						c2y = c1y + stack.shift();
						y = c2y + stack.shift();
						if(count-index == 5) {  x = c2x + stack.shift();  index++;  }
						else x = c2x;
						alternate = false;
					}
					else
					{
						c1x = x;
						c1y = y + stack.shift();
						c2x = c1x + stack.shift();
						c2y = c1y + stack.shift();
						x = c2x + stack.shift();
						if(count-index == 5) {  y = c2y + stack.shift();  index++;  }
						else y = c2y;
						alternate = true;
					}
					P.CurveTo(p, c1x, c1y, c2x, c2y, x, y);
					index += 4;
				}
			}
			
			else if((v+"").charAt(0)=="o") {   console.log("Unknown operation: "+v, cmds); throw v;  }
			else stack.push(v);
		}
		//console.log(cmds);
		state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width; state.open=open;
	}

	function initHB(hurl,resp) {
	var codeLength = function(code) {
		var len=0;
		if     ((code&(0xffffffff-(1<< 7)+1))==0) {  len=1;  }
		else if((code&(0xffffffff-(1<<11)+1))==0) {  len=2;  }
		else if((code&(0xffffffff-(1<<16)+1))==0) {  len=3;  }
		else if((code&(0xffffffff-(1<<21)+1))==0) {  len=4;  }
		return len;
	}
	
	fetch(hurl)
		.then(function (x  ) { return x["arrayBuffer"](); })
		.then(function (ab ) { return WebAssembly["instantiate"](ab); })
		.then(function (res) {
			console.log("HB ready");
			var exp = res["instance"]["exports"], mem=exp["memory"];
			//mem["grow"](30); // each page is 64kb in size
			var heapu8, u32,i32,f32;
			var __lastFnt, blob,blobPtr,face,font;
			
			Typr["U"]["shapeHB"] = (function () {
				
				var toJson = function (ptr) {
					var length = exp["hb_buffer_get_length"](ptr);
					var result = [];
					var iPtr32 = exp["hb_buffer_get_glyph_infos"](ptr, 0) >>>2;
					var pPtr32 = exp["hb_buffer_get_glyph_positions"](ptr, 0) >>>2;
					for(var i=0; i<length; ++i) {
						var a=iPtr32+i*5, b=pPtr32+i*5;
						result.push({
							"g" : u32[a + 0],
							"cl": u32[a + 2],
							"ax": i32[b + 0],
							"ay": i32[b + 1],
							"dx": i32[b + 2],
							"dy": i32[b + 3]
						});
					}
					//console.log(result);
					return result;
				}
				var te;
				
				return function (fnt, str, prm) {
					var fdata = fnt["_data"], fn = fnt["name"]["postScriptName"];
					var ltr = prm["ltr"], fts = prm["fts"], axs = prm["axs"];
					if(fnt["fvar"] && axs==null) axs = fnt["fvar"][1][fnt["_vindex"]][2];
					
					//var olen = mem.buffer.byteLength, nlen = 2*fdata.length+str.length*16 + 4e6;
					//if(olen<nlen) mem["grow"](((nlen-olen)>>>16)+4);  //console.log("growing",nlen);
					
					heapu8 = new Uint8Array (mem.buffer);
					u32    = new Uint32Array(mem.buffer);
					i32    = new Int32Array (mem.buffer);
					f32    = new Float32Array(mem.buffer);
					
					if(__lastFnt!=fn) {
						if(blob!=null) {  
							exp["hb_blob_destroy"](blob);
							exp["free"](blobPtr);
							exp["hb_face_destroy"](face);
							exp["hb_font_destroy"](font);
						}
						blobPtr = exp["malloc"](fdata.byteLength);  heapu8.set(fdata, blobPtr);
						blob = exp["hb_blob_create"](blobPtr, fdata.byteLength, 2, 0, 0);
						face = exp["hb_face_create"](blob, fnt["_index"]);
						font = exp["hb_font_create"](face)
						__lastFnt = fn;
					}
					if(window["TextEncoder"]==null) {  alert("Your browser is too old. Please, update it.");  return;  }
					if(te==null) te = new window["TextEncoder"]("utf8");
					
					var buffer = exp["hb_buffer_create"]();
					var bytes = te["encode"](str);
					var len=bytes.length, strp = exp["malloc"](len);  heapu8.set(bytes, strp);
					exp["hb_buffer_add_utf8"](buffer, strp, len, 0, len);
					exp["free"](strp);
					
					var bin = Typr["B"];
					
					var feat=0;
					if(fts) {
						feat = exp["malloc"](16*fts.length);
						for(var i=0; i<fts.length; i++) {
							var fe = fts[i];
							var off = feat+i*16, qo=off>>>2;
							bin.writeASCII (heapu8, off   , fe[0].split("").reverse().join(""));
							u32[qo+1]=fe[1];
							u32[qo+2]=fe[2];
							u32[qo+3]=fe[3];
						}
						//console.log(fts);
					}
					var vdat = 0;
					if(axs && fnt["fvar"]) {
						var axes=fnt["fvar"][0];  //console.log(axes, axs);
						vdat = exp["malloc"](8*axs.length);
						for(var i=0; i<axs.length; i++) {
							var off = vdat+i*8, qo=off>>>2;
							bin.writeASCII (heapu8, off   , axes[i][0].split("").reverse().join(""));
							f32[qo+1]=axs[i];
						}
					}
					//*/
					
					if(axs) exp["hb_font_set_variations"](font,vdat,axs.length);
					exp["hb_buffer_set_direction"](buffer,ltr?4:5);
					exp["hb_buffer_guess_segment_properties"](buffer);
					exp["hb_shape"](font, buffer, feat,fts?fts.length:0);
					var json = toJson(buffer)//buffer["json"]();
					exp["hb_buffer_destroy"](buffer);
					if(fts) exp["free"](feat);
					if(axs) exp["free"](vdat);
					
					var arr = json.slice(0);  if(!ltr) arr.reverse();
					var ci=0, bi=0;  // character index, binary index
					for(var i=1; i<arr.length; i++) {
						var gl = arr[i], cl=gl["cl"];
						while(true) {
							var cpt = str.codePointAt(ci), cln = codeLength(cpt);
							if(bi+cln <=cl) {  bi+=cln;  ci += cpt<=0xffff ? 1 : 2;  }
							else break;
						}
						//while(bi+codeLength(str.charCodeAt(ci)) <=cl) {  bi+=codeLength(str.charCodeAt(ci));  ci++;  }
						gl["cl"]=ci;
					}
					return json;
				}
			}());
			resp();
		});	
	}
	
	return {"shape":shape,"shapeToPath":shapeToPath,"codeToGlyph":codeToGlyph, "glyphToPath":glyphToPath, "pathToSVG":pathToSVG, "SVGToPath":SVGToPath, "pathToContext":pathToContext, "initHB":initHB};
}();


/* ============================================================
 * 06-cx-table.js
 * ============================================================ */
/* ============================================================
 * 06-cx-table.js —— 超星字形哈希对照表（生成文件，请勿手改）
 *
 * 来源：超星把思源黑体的「码位 → 字形」映射打乱来混淆题目文本。
 * 字形本身没变，所以对字形轮廓算哈希就能反查出原来的字——
 * 这张表就是「字形轮廓哈希 → 真实汉字」的对照。
 *
 * 关键性质：**与字体文件无关**。每页的字体文件都不同（码位随机分配），
 * 但同一个汉字的字形轮廓永远一样，哈希自然一样。所以一张表通用所有页面。
 *
 * 生成：node tools/gen-table.js
 * 条目：20902 条，覆盖 CJK 基本区（U+4E00–U+9FA5）
 * ============================================================ */

const CX_GLYPH_KEYS = "0002523500060092000c81af000cc4ab001b1dca001e21a80021f997002baa31002f506500332724003482890042b63f004733e00048511c004cc6cd0051078a0055d55c005696b90058e3d5005e57270062da4300631ba700678eb500681e93006f69f3007173e80073c3110076b62d0078d9bb00795916007c5f6a007ceb4f007f17ce0081e98700839acb00859965008c3fd3008f54c50090c5a90094002d009c8eba009d72f2009f66bc00a1ff4b00a3c5fa00a40d4300a4285000a9e08d00aa3be500ac30eb00b0648800b10ae800b3871700b5ff3400bcc60a00bdcbb500bfdfb400c9118900ca36d700cbec2e00cc08d400cdb42300d3481e00d86caa00dc667f00dd7cd100dea43300deba9e00e7a0f000e8267200ef896300f109e800f311b700f7916600fb887500fb993e00fb9a8800fcd8c000fd47ef00fe8dc7010223070107d329010ad11a010cd0a6010f162c0110aa000111a0a8011494b20115a70701193d89011d04f2012bc12a012d01c2012d0861012e2aff013059070139f636013e22dd013ff15c014192530142cea40147c211014ad4f20157503a0157b3d5015ab8c7015f42570160794601607f490162421d016937f9016fd2520170182f01704cdb0171fb4f017248ad017748890179ea59017fb3c30187c2ba018888130188f630018988ed018a3f8f018ab40c018e68d101910e64019bca52019cff63019e0c04019eb4dd01a17b0401a4200e01a5c9a101a6a61f01a7be1a01aa502f01af100f01be428601c61c6601c6f65701c80ce401c83b2401d2526901d5ecc601d780b501d86be901db1b3801dde7de01df2c0d01e15afd01e2e82901eb192801edaf5d01f2aac601f3539f01f6e1a901f9cff001faad3201fafaf401fb20f602026ae2020756fc020b140b020c19df020dd1aa020ee7d902114a890212e7710214935e02170c50021829f5021a69f3021a8134021c19f7021f4401022433290224f5f1022c1c6002360e97023f9596023ff5a40240aee3024364b4024451d7024820a2024c402b024c9282024d50df024e896902502592025131a90252b2e50252eb920255b73302577e8b0259e1470259ef54025be9fa0266dccc0267f34302688bcf0269c384026c1c5f026df8b7026e7f47026f5bba026f95090273308d02734b35027e47ba0280fc0d028231e9028605f5028e4966028e55f7029051d2029073e30293f5b00299d3d4029cd37502a0ec8a02a3a1e402a51e3402a817ee02aadce502ac604102ace20d02b2528102b2614102b28a1302b6420802b64d8202b8539002b9475a02c2776902c86a6c02c8b3ca02cdbaa102cea0c302d0416f02d3d1bd02daf27302dc599a02de424b02e0daff02e16ac302e399c102e9797d02f27cb702f4e8dc02f5813f02f670f602f8a6c702fa201402fa8bc702fabc7a03029a850307024f0310690f03110f930311a66f031323a1031435e90314d2a10314f3bd031907d9031a39b6031b1101031b2b6b0320764e03234bdb0324ecc003269978032769370328580803289d1403298b4a0330d5e50338b16e033e063c034cfe460357347103575773035782fd0359732303599179035d129003619e36036b06ac0370c1bc03722b6f03756eca0377e1cf037fc72d0384e03003865ffc038ab269038dc55b038ec691039579a00396e5fa039985a0039d8fc4039de138039e04a803a3bcbb03a3be8d03a6c03603aa2aa003ac3d8303b3e25a03bc0fd803bc81bb03bdd5a103be438b03bfd5e603c0a8f203c2f20f03c562ee03cc832903ce820403d88fcf03e2ce5303e3e00803f5ecee03f983e8040269840402dcdf0405d68f040861b3040b3e4b04150c1004160631041808be04251a61042767fb04344a090438b198043b8abf043bb45a043dcf3f0442e126044a86df044b51a3044bdf81044c22a204571d9804593b0c04593c6c045b3051046885b1046b958c046c8153046d4d99046f314d0471f89204740ca60475f7aa04770fe80477c81004791072047afa76047ca429047e0a86048768820498ceb50499ab32049a0987049a2e77049a65f1049f03af04a1906304a6b3ac04ad90b004b16ae704b375ef04bda30d04c3c72604c3eb4a04c449c004c51ab904c83fa404cdd9ac04cf112a04d123a604d1ec4d04d2558b04d38f2704d44c9104d6291004d8a4d504d95d6c04db39d604dc47bc04e6729c04e680e404e75d3e04eacaa704eb07ad04ee9ad504ef2ad604f7613405071c82050759330507ad2f0508453a050cd2d4050d97290516cdfe0516e9e2051964f5051c5e26052292c40522f9190523d2cc052a8943052cd9d60533c2c505382f4d0539aa4d053b27b7053d31c4053f3932053ff5f105437fcb054578f9054784a10549d3ff054e711e05504c0205514ff0055199560553e6300556a6de05599f2b055a3d46055b672b055f89f9056226ae056391a10564ecd30565703f05689880056dab660570404305751c4c057599e605778b0a057e55db057f0a040580e5920581450305877bb705878c060588a9a1058d5e7f058e1db405931f11059580ba0595d6e90596f2990599252305a0148e05a68cad05a9da9105ab023505ac43d905acdd8805acf83a05b2c66805b2c96405b5d41c05ba73a905bb3f5d05bce75605c08de505c18ebf05c5264b05caa56c05cef39605d1a5b805d728ef05d7c9d805d9de5605da98aa05daec7205db16e405ddd50905df68b505e26d0a05e30aa705e3eb0805e5ba8905e623fc05e977cd05e9c1c105e9ef2205fc8d0c05fe2f4305ffc9c8060102980601b1f40601d0a406072cc90609d65f0609e2f7060cf6fe060d74d80610e9be0612183e0612e84606169c7d06182c95061fd0c00620cd0c06210c540621efd00622dcfd0622e99d0626236906294771062a0d71062f0ec7062fcdd20634e4060635a2c00635e0b70639e958063cd4e10644ac4106461017064f2196065013ea0654ec8d065bd9dd0661eadd0667433206686eff066ca04f0671860f067330a1067544b20675eb7606784b8c067925c506836e0106837e0d0686ae640686fbec06874f5406960b5c06992ecd069a96a0069b4a6c069ea65606a31bda06a3b5f506aad86306aba83906aeba0806b1a9a706b82d4c06bbbf6d06be2c5406c0e46606c2a75506c7a11006cedef006d5342006d79ddf06db028506e0911206eb218306ef9f8706fd5a7306fe66a60702223907068de60709067b070ab629070fc75e071b21d7071ebade07228eaa0723dbab07242ded072440400724c181073744f30738298607382b750739d68e07452a94074775b607503d420753f3d70756114c0758cae1075db0a10761ad0e0763387707710559077230600773f9d70776732607768488077bc869077ceb92077e84a4077ec9dc07813ebb0783e0990784b2e90787205d07872e44078f35de0792202b079419d70795fbc607a0c7b907a32af907a6412f07b0844f07b1594207b7101d07bac40807bd290507c2b50c07c5c4b507c6106f07c8b4bd07c9cdca07ca8f1207cd71fa07d7d03207dc100a07e2192507e41c6f07e675e407e6ce7e07e8189107e9014907e95e6d07efca0207f0649007f24fae07f42d5b07f4bbff07f52dba07f6469307f8e9c7080481d30806c08c0808afcd0808e837080bc1cf080d6697080ee974080fc5dc08116780081442a30815582108197cfd08198a45081a236c081a43e3082192960827fd75082e9a160830490a083236ce08455b6b084603de0853cc2108554a53085e62ad085eb121086176b00867009d086a1731086b877d086d82d7087001020872b20908765b2208783d8608795657087c8aaa087eed59087fbe940882b6b2088558580888f80f088af5b9088b7e57088c7997088f650e089cd912089d6cff08a3f80508a4681908a5ca6c08b4b1bb08bffbc108c2d2db08c46c6508cbb3f508cbee7a08cca91308cf142b08d40b2208d73d4f08d7d57b08d8c9f908defd9a08e00bf208e4d45c08ec0b8608ed724d08f19f6408f293b808f4163608f900050901a808090256a50904d9670906ec3f09072dfa0908ffd4090cc12f090e9edd091585ea0918ae8c091e1841091ed42b092435ad09283823092a205f092c9e33093683f4093a2fe4093d8fe6093fc3230941a9800942701b0942b883094811910948a088094c6820094ffe59095a30bf095c7d19095e6b91096140290965ca0d096667ad096cdded09777edc0977a730097af0d1097ca768097d9445097f5ea80984509c0985208f0985d4f609885edf098b53c0098f6f08099488fc09969cdf09977197099c2a62099f5868099fe60a09a0327f09a1dfeb09a42d9e09a481a109a5d7af09a925f309abd8df09b0df9909b1b18c09b4812f09bbb5ba09bc621a09c0683a09c1180409c5e30309c6c13c09ccb57609cd5c6809cd97e209d4f28c09dd5cf409defe4809dff93a09f09a8809f16bfb09f267db09f6904d09f775cd09f9a95709fa441909fade8d09fb2df00a0120570a0122670a041d550a08c6a60a1433ca0a162c2a0a1a538c0a1af99d0a1db7dc0a1fbc6d0a23522f0a25bd170a2865c00a2b73210a2f80ef0a30e5cf0a30f6310a360c680a3ba1b30a3bcb6e0a3e7a260a405fbc0a47c43d0a4996ea0a49db930a5d89b60a5f20d60a64aec20a661b510a68d0ff0a6f5f2d0a72940b0a7702270a7829130a82c1dd0a8342180a8671e90a8903950a8a39730a8acf150a8b29ee0a97e5350a9b69b30a9e25610a9ee1890aa6708f0aa88a9a0aab4e290aad46110aae8fc60ab0c2ac0ab3ec3d0ab9037c0abc2f2c0abd3b1b0ac00dc70ac429690acd5bb60acdbca10ad27d8c0ad3ceb20ad862840ad91ec80ad9585f0adad4cb0adc19370ae17ab70ae74d790ae76b450aed1bef0af267850af8d2b60af8ea840b071af40b0969ca0b0df95d0b105d230b1140090b1451210b15934d0b1b9d4f0b1f765c0b2006380b20a23d0b2372aa0b24da1b0b2da2610b2ef3150b30cc6f0b36d3930b3739f10b3aacbb0b425a580b42cce70b43de500b45c35a0b4861010b4ccd950b4d04880b5052090b5078f70b5318270b54ccdf0b56a2f10b57c05c0b5bd5120b610e740b6d1b2a0b6fd63e0b714ada0b715eec0b743f320b7a33c30b7eca0c0b7fe2960b84097b0b8845290b8bd6f90b8c68450b8ede270b9548640b978b2c0ba001bf0ba0d7060ba1b8fe0ba214c50ba408b50ba8c1e00bab0a110bad08b50badca460bae5be60bb4e4100bb55c660bb831570bbdea530bc40b830bc4fb960bc9a2bd0bd52b920bdad5dc0bdb03310bdb15740bdc6ecf0be080350be3d1af0becb3c70bed72a80bf338cc0bf3d02e0bf7ab2d0bf886050bf97eaa0bfc3b810bfea24c0c052e200c07475f0c0a79210c0e3a410c111fdf0c1181020c130aec0c1468c50c1ed1040c1f01d40c21968e0c259a4e0c2e0fd20c2fdc130c38eb550c3abad20c3bb5750c3caf770c3eccab0c3fa0710c414d400c41eead0c49d7140c4fa9550c5b75450c61fdb90c6c05570c752a830c7588ab0c770a7c0c79bb2b0c7ce5760c7e436f0c86eb980c86fba70c89c9750c8b8fdd0c8bdd290c8db6070c8ed2170c900d180c984bee0c9a7b450c9f81e50ca32d4a0ca53b720ca6147e0caae9980cad00950cb0a8220cb10e300cb3694b0cb50cf80cb5f0a70cbbfb650cbeec790cbf156f0cc057dc0cc20d9b0cc274090cc948050ccbde050ccfbd4e0cd039560cd5fb7f0cd9c8060cdfa4430ce00bf50ce15d9b0ceb7f8b0ced37b20cf039e10cf35c170cfb4f340cfd3c280cfe731b0cfe9f190d0029fa0d017b700d0403730d047bf30d099d6d0d0b666f0d0c48f00d0d6c100d114f750d1291050d15aeb90d16c3110d1727370d1cddf40d25715e0d28471e0d2cf4ee0d2f208d0d300ef00d305c380d3085f90d3375900d346fa40d364d5b0d3941d90d3eda590d48f51b0d499ec90d4d516e0d4e37ea0d51a3870d5403830d5456f00d54cc8d0d57ee7c0d58098a0d5bb8110d5f2b850d61b9580d63d02a0d66036c0d6878f80d6955650d69812a0d6e71a50d723db70d73daab0d7416490d7dfdaf0d8597e20d8707510d8a1e400d8ae6be0d8d4d440d8e10350d911fed0d9485f40d976be20d97c71a0d9af0940d9b2a2f0d9f69870da8e6390da8ff980dab50ed0dae20d50dae30130dae63d80dafb6aa0db046be0db575ce0db5f7dc0db7f9840db88db90db95cc00dbb21000dc2341e0dc361fa0dc3f8380dc49c760dc608ac0dc84bf70dc8590e0dcb39aa0dccd3af0dcd1f130dd70ce60ddb40ee0ddd1e460ddea6cb0ddf52f70de426ed0de6ecac0debf2a50decf8a90def1f500df5c9400df8bb8b0dfac8ba0dfdfbe80dfe225f0dff111c0e0130d50e0161da0e07c2c70e0fd3820e0fe6bd0e10f8a20e1b52160e1d28fe0e2018cf0e279f260e2b37e60e2c691b0e2da2410e2ddec80e2e80360e3089210e35ee630e3bac390e4071be0e4acc720e4ba2cf0e4e54470e4f202c0e4f5ae50e53635e0e57c0fe0e5feee90e6045970e62554a0e6899d70e68aef00e68d5da0e6b9a5a0e6cd5b60e6ce3bd0e6fffb90e76ab280e8169670e8361510e83f0190e8515e90e8ffc830e904bb20e94118a0e9a8b960e9b609e0ea08c560ea104380ea1e3130ea3cfcf0ea50edd0ea600d30ea76d280ead68b20eae3b070eb0aaa90eb0de690eba8f490ebb5d390ebd369b0ebe61800ecac9c10ed01f580ed029cd0ed118a90ed83c8d0ed892870edc96c90ee445f30ee448e20ee5759f0ee5db890ee659750eec2c920ef85df20efb2be70efba8630efbc6cd0efd1bbf0f0127ff0f03a9110f04abdb0f08503c0f08d5780f08dca90f095e7f0f1177320f193bcd0f1a9fd80f1bba120f2296830f248d590f2576490f28277e0f2bcd890f2e21f70f2fb39d0f3117e00f3f6dcf0f4159f80f4384d00f49ba7c0f55bb160f57dcf70f58562f0f6121c10f6344bd0f63589f0f657b290f6e1e750f70c1fa0f70dffc0f718ba80f7283f40f7462e30f766c190f8538e50f897e9b0f8b2c2f0f8b76ea0f8d8aa60f8da2d30f8e79ec0f8e87980f91dee60f9ffc860fa210e40fa8353f0faae5600fb06ed30fb215be0fb3692c0fb7b9e70fbe258e0fc4b7bb0fc4dd9b0fc5d4e40fc749fb0fc8a88e0fcb2da00fce8bdd0fcfc8990fd0315a0fd2fe010fd48d940fd7a8dc0fdbb16d0fdd0d000fdd8b0c0fdda7dd0fea94c30feddf1d0fefc2e00ff000b70ff06c0f0ff38edc0ffb7c580fff98ca1001acff10023d4b1003a47d1004980a1007bf2f100ae88c1014d21c10193db8101b6945101e48721020a75610230d8a10230efb10251c1b1025eca01027fd5a102bab7c102dc148102ebde1102ff4741030421d1032f2a51033047a10340d24104348661046bf45104866ea10583225105e8bac105f037c1062aa7c106334d2106426901066e175106a2716106f7e4010722294107691c4107784e6107ccf7e108be30f1092cbd31094072810a7026e10ac13e110ad4bdb10b8dd6310b9a7d210bbbcca10bca16610bd360b10cb137d10cd452d10cd93c710d01a0410d6264110d9e55410dd853f10ddfa4b10df9ab410e0850410e2dbc310e351cb10e5d32610e6954f10eb7a4110ebe4eb10f15b1110f22dbe10f4484110f4569a10f9cfbe10fac6bf10fe122d11012b991101df8611054eab110fab381112c2aa11152cca1117236c111f41bd1123b26b1125f171112769cc1129063911294b5b11297c46112b0e5011333762113355d2113527d31141b93a114495141146d890114959291151cff61154c84c115cc7811164a8be1166e2541169c3b7116a2059116c97091175dc061176fb9011787b2e11792c08117ba070117c459a118168fa1181d821118437ab1184ac17118ab616118b38731190c4b21191f9ea1195480a1195dbfa1196b8ce11971848119738d0119a3596119b0a2211a2425511a31d7011a424cc11a4987711a877ca11ae360f11afa12611b1625f11b5a4fd11b70fc311b7923811bab2e311c0c08211c47ab711c5127211c69fc511c9a8b311cbb10a11d2d36211d3e5e611d4bb8611d95f1311dab91811dd279a11df237e11e0d0bf11e0d37411e3301311e7b0e411e94bae11e9f63511f151111201f3de1202cb3312064d0a1207f6a2120d71821211499a1213841d1216fe5f1219f9ad121d3a77121da1d81222518312248a771227b88d122e0147123570101237c65f12397966123a5be7123b07c2123b3771123bedfa123d341b123e3b40123e51f712432235124b8e9d12535e9f1259a5b6125bcf631260ca8d1263ae45126496f91265699f1265d59d127055891277dd6e127d46b3128b4f23128bcd89128c7bd9128cd1a6128d26b11293cce2129408051296c04d1299e558129ba21d12ab244c12ae239312b15a9c12baee5a12bc7d7912bd5d0912bf02aa12c06e9e12c2bad312c331a412c37b9412c5654f12c8741112c9e87712ca447a12cabfa312cc428b12cd090712db7c9912e0dc2712e1a0ad12e2d6eb12e536ac12e774b212e7f38e12e92f0912f0ab4b12f4b9cd12f5bd6b12f6b8f912f71be512f85c3212f8e0a112f9587612fcaeb212fe4b2c12fe55cc12febec413019ca9130519131306db94130867e7130b273d1311e8d113142b96131507691315a67f13176b4c131b0f9b131ded10131ee82f131ef7fa1321519913228d3a1322fb2f1322fc7f132343151323e2301327bf421327dd9d132afe33132c568b132fe584133465691339b0bb133b36ed133eb16f13425711134831f0134ba19f13510879135170dc1358057a13622fc7136277f11362d14e1364fdcf1366c6e8136911e213694ba4136953b21372820c13729f36137db8e3138522e41385c9e2138741d2138b9dcb138cd0bf138e2f3a138f86e013900eba139085d0139198831393a8631394ffe613958261139a5854139d633813a7dfc213a8d72b13aa8d3513aed6fa13af3c7f13aff1d113b0989a13b7199213b7278413b7796b13b87f1a13c021a513c03cdf13c12c4713c61bbd13ca736a13cfddfc13d0c64613d0d16c13d3111113d36a8b13d3e4ba13df5df613e5f99a13e955de13eb590113eb671613ede5a613eeb17913f15fa113f4016a13f42d2e13f9513f1408b82b141031fb141578431416033c14184d0c141a1a84141b1a6d14203c2b1421f4801422f5301424a43c14297c50142cf79414328e471434a7531439949b1439b1ae1439dc8414415a01144400601444683c1448e724144922f1144d9890144e2be51459bdd4145f47c314604c631460af28146149f514618133146650961466c79b146d05f2146d285014703f931471498f14746101147b41e21491a0ea14999e60149c018e14a36f0314a472fa14a6c96a14a731f414b4fed914b5c17114bd521314be408814c1ecf514c2339314c5c25b14c5d08814c8ac9614cb466c14cc19fe14cd7cc414ce73d014d0322914d296a214d5c93614d6691b14d77f1914d8080e14de32c814dfff6314e88bc014ec196714ecd2f214ed23d014ed6b7f14eded1914f15fe314f5c1d714f6b0bf14fd5ae114fdd35414fe82c314fe90241501c4081502c239150372491508d7721509f56f150e006e1510510f1511c2dd151391001514a3ef1517c6d7151abf8e152151e4152445c9152851d21528712915290758152aaf09152ced851531b9eb153259a1153c61b91541f2961546754c154a9e491553bfb41558d06e155a8d50155d2361155d9a861560d2e3156272d315646860156ae74f156b12fd156b3877156fd5f11572376d1573598e15736436157488bc15752312157781aa157aea2a157bddb2157e36d8157fb30a1582461b158c000f158e488b159ffe6015a1769215a2296c15a3725115a7adf915a815e715a95f1a15aa8c6715ab14a715b5711a15b7253f15b8c36615b904f715baed5315bda0ee15bfb2e315c02c6a15c2869b15c3a42b15db3cce15dc7aa015e1999115e30f8415e3e28d15e4f27615e7401915ec25f415ed6bdb15eda12815eec99c15f05d6515f219b415f3dd6f15f57b6615f8a27215fa279a15fe09131600ba161602bc5816049e4b1608cc1b160c53ff160c9c53160deb62160e3f0a160f02521610e5f116117ed91612e9a3161b65571621bab916265a6a1627f69c162c085b162c4059162e6b4a162f87e7162fc5aa16310667163239e61632ea9f16382d6d163a11191640c91a1642f23216448046164ab048164e3a35164febe016525cbe1653076616532e631657aa781657aba116594d8b165a7faf165c4b8d165ced511663b9d7166a67ab166e0666166e406a16703d85167fe5961682b4df1683ed8a1686618e168718681688597f1688ad82168a7b77168a98cc168f03ee16949e0a1697cfa7169a48b8169b2562169c648e16a5a4e516a651f916ab0f2416b0ff1d16b2448d16b2c4f716b43e8116b90ebd16b9acfd16bfdc1a16c0b05016c0cae516c1323216c42f2716c6d24516c739e416c7885816c8c41d16cf56a116dd7a4d16ddaf8516e008cc16e4bcb216e729f216e7523516e89e4216eafd7516ee6c9d16f07e6f16f8b70416fd0be616fd76b416fe401216ffec3d170388f51706315f17066f73170b80bd170ee2bf170f66ca1711fa2e1713e207171a8972171c0efc171d0ddc17225e2a1729c2df172a210f172a4e2b17320bbb1734e96c1734fb751735c89e17375d451738a172173bcec9173e905c1745ab2e17477f7f1747efd317483e41174be350175015e2175927f9175e391617637afb1763d31c1764bcb017672d79176a407a176b8089176c5cbd176fc1e11771c8b2177738f417780d3b1779697b177b682e177bbce1177bce23177da206177da4721780b0b01785e590178bfa46178d152b178d38bb179016e21791e9ce17940a981796a4e9179b237717a121f617a1278d17a1bace17a7046d17ae4a6e17aef62f17b3c1ac17b5979517bc080c17bd808517be493a17c3626b17c36a5517c4488217c9d95117ca042f17d06e5317d3b9cf17d4524617e0c6e417e1c8f417e21faa17ebd32a17ec19d117ed7b0017f0415d180131f218049f3c18061049180819561814174418160ebd181ae19c181c04a5181e9b3c1821780a18254526182c2f3e182fc568182fda5518310383183526291838fb13183a08281842e7861849e221184b74bb1851aa7e1855ed20185cd561186086bc1864685a186981451869c44f186a0cea186ecec51871734c1871ac74187a3a62187a41b2187a925a187ca5031883eac31889b2c6188e2875188f5c841891071f189348d218999451189b8602189ccc1d189f277518a2029518a454a718a5204b18a71d4a18b1236518b2cbb918babe9a18bb4dbc18be600418c3457c18cd91b718d0f9e618d527eb18d9e50e18de9c7118dfe4fe18e05c9918e285b818e767ce18ede4c418f0617d18f40e0818f81ea918fc71ec18fd0a831902c1cf190328f21903dbc81906a38e1912f0a419154acf191d108c19218e94192546cb19264bc2192c2787192e30a11931c97119389d01193bb0e2193e604f19473e3a19569c6819576ac319598362195de89c196096e41961d66e1961e114196200b8196253b91962faf01969f20c196c9090196f28d6196f7eee196f81b11976851619774e6f197ab81f197b49cc197b917f19801f5c1981781c1984bcb619856087198edb2819903a591993853b1996e131199953391999a8d7199e058e199feb2a19a781b019a86f3619aa5e9319adadbe19aeeee019b1030d19b5f0f719b88ccc19ba8bfb19c128e919c5377119c5af5019c6571d19d7e85f19d9b78219da275519dbc07619e468bc19e5b2a819e708d119e79a3019e8ac9219f494bc19f6e15719f76aef19f9be5b19feb91d1a0901f31a0b12ee1a0dbdee1a0dd37f1a1219841a18dc4e1a2021281a22ae451a22e9631a23244e1a276f261a2b30311a2b87191a2c858a1a3118331a312cb91a379e861a3a5ca21a3bf3911a3d775c1a3dc5641a3f73a11a4064eb1a41250e1a419ec41a4aab781a4cfa7d1a5592771a5893841a5f2ceb1a61c5051a68fa551a6c8c361a6e519d1a707daa1a7346311a76656b1a787fee1a7bc0c11a807a401a80fd611a8469f41a890d5e1a8e5fb01a8e7a7a1a8f724d1a9125ea1a912ec01a93f9121a9923d51a9e67f71aa4484d1aa901be1aab09401aab77221aad8bc61aaed7671ab14bd01ab1eb271ab201621ab6d01c1ab98b341abd09d01ac2689c1ad59ffc1ad9d32f1ada2fb11adab9ab1adaca821adb683c1ae5779b1ae63f3e1ae6c2061ae6c3e91aea96ca1aeb56021aee94971aeeafee1af098581af0bdb71af1f3441af28e491af7b2641afd3b6f1aff847f1b0009651b05fcbd1b067e241b068ded1b0d45d51b13bf1c1b1697811b1879d21b1a02951b1b672a1b20cde41b23db8e1b27eeec1b29f3ee1b3d40561b3e31041b3f2d491b44452f1b452a6c1b46c5ed1b46cf101b47f3061b48effc1b4b64031b4b91411b4b956c1b4cd7181b4d52ac1b516b4f1b5402b21b59b2961b5d8fde1b5dc8bd1b677a7a1b6d31b51b71d5681b760e831b764ebe1b76d34e1b7f78701b7f87841b8b6e711b8c83c01b8c852a1b90b7b41b93f8ef1b941f261b9901221b9b25a51b9c2bcc1b9d6ed91ba67e9a1ba79f1e1bab81901bac2a3b1bafce2a1bb004241bb2dc581bb694aa1bbb39c31bbcd60a1bbeb12d1bc7f0091bc8ac481bc924bf1bcaf0271bce0bd51bd0a8f21bd12e901bd46dc01bd471771bda339b1bde7a541be391891be4db8f1be634341be9bc481bed511a1bf16f9f1bf4b67c1bf591d51bf828f81c0055c21c02c0a91c0592081c0919831c0c017c1c0e2dd71c121e381c12220c1c1315121c142feb1c1cbae31c1e61d41c1fa9131c20bf911c2248f71c2607311c28c2031c291f2a1c295b191c2af4c71c2e13fd1c2e2c3d1c3047741c32f2cd1c36317f1c3875681c3d28cd1c3e2ee31c3f51151c402efa1c45abdb1c474bf41c4c146e1c4fd27e1c56d7b71c5959db1c5d3bfe1c60762a1c6218961c6414a41c6654131c67292c1c681e6b1c6aeced1c6b16f61c6bb5161c6e2bdc1c6e6b001c6f21711c7485c51c7aa93e1c7bac7b1c7cd6401c7e31601c82f6f21c8755b01c8b3c291c92766a1c9424d11c976dc51c9c03b11c9c5e4e1c9d7a351ca2ff251caa2caa1cac7fcb1caff66d1cb2983b1cb2e8f61cb4b3d61cb8c8941cb9ebae1cbe79481cc17bf31cc1df3d1cc392f21cc5b2ad1cc9874c1cc9e61b1cd127e91cd152301cd3ccf21cd7e0731cd809151ce2be211ce681e11ce869451ce8778b1ceaf54e1cf5ee861cf725db1cfa3fdc1cfb40281d00212b1d01d2081d075dd01d0775a31d07b4721d0802db1d0ac1841d0d01491d0d5c8a1d0f9c041d13c7ca1d15b4b91d163e2d1d1741351d1926fd1d1fd1681d22247f1d2438831d2ddc181d3acafe1d3c4a511d3d8fe91d3e405c1d4021b81d42421a1d44efd01d45548b1d46a6b71d4d3e7d1d4dfae41d558aa51d5c4a161d5d02fa1d5d85a01d5f70ca1d67b7b61d69848f1d6fbf871d70202a1d7436b91d7461ae1d74c50b1d76eb521d77f9b71d7831471d7cccbc1d833d1a1d837aa61d8be88d1d8d0a451d8d19821d950fcb1d99e8bf1d9a0ebb1d9a76ef1db191b91db497291db553bb1dbb03cb1dc0f5571dc5c2361dc94b451dc9f49c1dcadd661dcbac8f1dcbb2971dccca3e1dd8a0a21ddaffce1ddb7a261dddb5ec1dde52051de461ce1de483f01de7d1971de9f2711dec596b1dee68591df02f721df97b4e1df983b21dfb783b1dffdfb41e0519591e098f741e0db6c11e10b5e01e10f56c1e1338431e133f9f1e1613cb1e16ef0e1e1a4fc31e1ebcfa1e21fe1b1e274b691e29c78a1e2c9da41e35c0391e3db1af1e3df7d31e3eb96c1e4230131e44d01f1e4591391e4c85c81e4fd3b21e50348f1e5c9d561e5e3a7a1e5ebf041e5f1be21e6059101e6435f51e68b5691e71a7e71e78cfe21e7d08051e7d9fa21e7e0e0b1e7e3b121e82184e1e8340851e89e3471e8db6ac1e8e93831e97460b1e9a2ae61e9ced401e9f2b0b1ea03c041ea08ff31ea3db561ea410b01ea41aae1ea5e7a91ea652a71ea6a1481ea7d54e1eaafb3a1eb0a90a1eb0fce61eb184651eb25c4c1ebb98691ec1c01c1ec3b9631ec8bd0d1eca17bb1ece24a91ecfca601ecfd7051ed0c0ee1ed771751edc94631eebc99b1eeee5ea1eeffe1c1ef0259b1ef5215f1ef54a301ef5ddff1ef9983f1efd66831f02623f1f036f051f087dc21f09d8441f1013031f11f8c41f14061d1f1487781f1587d81f15e76d1f168b601f1bc4cb1f1f86401f20b4631f2517861f2747591f2c1b7f1f2c3b1c1f305bac1f3161db1f33239e1f48b51c1f49ff941f4c09261f51d3761f5422aa1f562a251f5a07e81f6202851f64cd381f67766e1f6fa58d1f727fdf1f7820aa1f7e54931f7fc74c1f862ad01f8bfbf61f9345ef1f95bb521f9852881f9e8b501fa457ec1fa68e8a1fa7eb1d1faaedd71fb0e4511fb31ae51fb4f2d41fb624571fb6b14e1fbb8caa1fbf000e1fbf80af1fc11c7a1fc1c4b71fcb7ba01fcfa5861fd04d481fd484a11fd8d8511fd98df71fd9ef5b1fdbc4081fe1a6f11fe25b091fea794f1feaa7d21febaced1ff463bb1ff513e620000d692002a9af200457362004b29e200a25c320138a32201457c22014ae37201bff7b2023d52c2027ef0f2028d22b2029bb5a202f0cfa203034cb20323eae203c8e02203daad0204120da2041f08a2048b159204c59c1204ea9ee20516db52055c061205fd80d206006a4206300d72064183d20678dad2068a09e2069e193206a3f31206e1769207357be20754d1020797d31207a1369207b2f4a207b53c0207b6cac207bcf252080a7382080e6ed2082287f208583f82086a4c720885a9f208b1c8e209c586f20a0764920a6664320ae586d20af429320b3efa420b7f74b20c5476b20ca39c320d2702020d6533820d68b9520d6aeb920d9362c20d962cb20dce5a320e075e420e2f94820e6b9e020e904d320ecf60a20ee059120efd00420f1a24020f1d55520f2ef2320f904da20fad42f20fdbb2d20fe5a032100c85d2101c7602102f92f21033dfb21037d8f21057cb4210bde70210d1b012127c5a1212c97d4212dacd1212fbdce21478acc2149db1e214aa2c221510443215d1152215f4bba215f6d6221611171216567fb216b75ac216d1757216eaec821704e2a2170bcd421761b2421782796217845dc2179182b217c2ab12181fa712183e9792185fafb2188a6382189b795218ba7be218d6bee218fc5382190af0a219545a921965728219aca0621a3f3ab21a6e60b21ac6ab721b1bbdc21b6397b21baccdd21be50b121c097ba21c0be4021ca66ce21d2b79821d50e5821d839e921db3abc21e14fb621e65b6521e9686421eba81521eff16721f1b20121f241a921f7865921f9162321fc49e62201be13220273922202d0f82202d54522049bee220867b62208921a220ba578220bdbe3220c170f220c6765221a2eb3221c524c221c9799221fd233223076022230fefd223309502233e3cb2235ac55223a4b4b223e4c7d2247acb6224a3c67224efa52225069752251097d22521bb1225b22dc225c694a225caf99226657ac226e07812279eaf8227ab85e227bc5cb227cd802227d0c82227eba572280778e22815ebd228553d82287567d2287746a228ad104228e520f229f149b22a2a1e022a7ac9822a8423822a87cc022b54e2f22b7444022b96b1022bb0eac22c3d51122c4471122c4bc1422c598c122c6dfff22cd20a422ce2b3222d154e522d2e49622e2894f22e3a9b122e7b50a22e8290422e991c222efe46822efe6bc22f21f5422f8fb5222f90e522305c5722309281f230a54be2313de992314e0eb231b036e231b1054231e0ec4231f3a1a233218032333025623397770233c663823415f812345a96f234ceffe234d3c4e2351b03823521de2235597b423562fe4235916fc235bc06d235cfb6b2360128f236331bd23635553236686aa236c1b59236d2ce323739c032377316c237c2f68237f2ece238168b623844bf72389b95b238a4e90238dbf7823912bb1239412672394171b23945e7123a13fa223a9535d23ae8c7d23b43f3d23b854ce23b9d3b723bb7e9523bc431f23c0190323c2bafe23c2d11c23c393a423c3b5cd23c4ae2923c5c62e23c5d92e23ce089f23d25cd323d317c923d4b4aa23d60ab823d8a3cd23da5e5723e2c38423e74ad323e9438023ea96ba23ec8f9323ed6d4023ef8b2323f8184123f9a96623fd390924004940240214ee24074cbc240cbc86240ef2dd240efa30241852ed241c168b241fa8db24217ab8242412f8242478e02425100c242704e6242dcd5a24312f4724327a7924349585243bc876243f141e244033ab244c0dad245261e9245486fe245630af245de6ab24601791246230a424627877246f0d122473ee4b247ba723247c44bc247c6644247e469624883d0924895641248d2c7b24943c332495a2642496213324976b1d24977400249c5e7f249f7b8424a1680324a9b96424ab239124ac33d524adffb924ae815424b2ac5124b37d2724b3d37a24b4786624b5b26024b7526a24b8b2d524b8b3d324b8c25924bc8f9b24c1027424c24d3e24c3c68024c469f224c6503b24c6b48424c6d07624c795ec24c863f024d7898e24d9734c24df229424df2b1e24e23a4b24e243e724ebedff24ec353e24f47daf24f63b9c24fd20e824ff723e250052ee25099a0e250c10ee250caf17250e8bde2519a7ff251b9ab3251c0f1e251c9bd2251ea3e7252a20b7252ac282252ce127253177f225338688253432e72535e8902536f529253b58b9253b7d03253c75b5253d65ec25477e65254c3f5a254d7ea625567d9f25598460255faec8255fe5552561a9bc25646e662568fb8525785cea257f24fd257f6a57258344f625851ec6259c1592259d1cc2259ef28625a78bc925a95f2925b3b4f825b4de3f25b7f31325ba766325ba98d325baf12b25bba2e025bf7b1325c16f7625c2ea8925c4d26625c66f4225c83f7425cadd9225ccd29925cff37025d16d9f25d32ba425d435b325d8792525de619f25ee380525f2edce25f3255625f3930425f426f625f8344f25f9b50b25fb0dd925ff1dd526041c4526044fa926059c92260659cf26071ae3260cc16f260e66f2261121f0261627722619184f261aebb1261f86ac2623356126283f0e2628b11e262e6a7d2631f99826336f9f263715e92637fd8f2640a4682650519a2650542a26510c9926512d2d265e9bdc265eab3f266025c226628dce266848562668d7e6266c6d41266ebcc0267546bd2676f5ec267b784b267d866a2683c9802685af472686894b26872f98268d9345268e41502693faaf269dea9d269fe7f926a5d7bb26a7746126b2be2c26b345c126b5703026b8379026bb767926c46cf726c7c2cd26c8659d26d0619126d1bb3a26d4e98426d657d926d88b1526da55ca26dbd15d26dcc0cf26df3a7a26dfbbb626e1db4026e50db626ec004126f19b2326f352a326f538ea26f67ad526f877a226f95f8026f9ad1d26fd409b2702e0d2270491b12707d592270986b6270b2bf72711f60f27123aaa271244202712b1ba271450a1271a168e271be54e271f62c52723b2c927365674273791832739d1bd27430fee27467f2c274a8118274ba06c274d3897274eae57274f2dce2757b04427584a862759b47e275aca59275b097a275e0e552762f93c2763e23e2766b13f27670c3927674ac1276fddf92773fbde2778854e277b8a60277d54e92782128f2783be252786740d2786d10d27881a8927898e17278b844a278be78a27913e172792233127936a2727a2f27027a6f51727a8a46c27b1e43e27b9a1be27ba5ca727bcfd0127be2f4827c2176927c4edc727c5274827c80d0e27c8749f27c90e2b27cade9327cc17c627cf990827d3ab5b27d6148c27d74d2727d8d3ad27dc522427dcb85e27df1fde27e1580027e2504627e7027e27ebfdd627ef970827f51a7727f71f2727f77d1127f8c23f27f942fc27fe56842801ebd42802a761280cb757280d9bbf280ec5d02810f39a281b3a44281ea9b62820bc1b2823dbca282456e22824bf152825c178282d9a9f282e54562831ccc9283244922834726e283d47522844fd96284806ad284986c3284df79d2850f47f28553bec285a9aa82862243c28627cb92866667c286826b5286b497e286c8c442870e78b2871efc52874d7ce28794b3e2880c0872881554b288407df2885432c288fd220289031a12890fabc28916b942891a5032897e75d289a29a0289b10fc289c72ea28a2be0e28a4fdaf28a78cba28ae86ed28b06d2528b57b2e28bc181728bf3db728c112be28c5c2c228c7206728ce0e7628d1219c28d3e73d28d5f30d28d6277d28dab53428db54ef28dee53f28e1aefa28e2904d28e2d6ec28e4f00228e82a0328e864a628ea0d1b28eb4ca928f0fa8f28f36c6f28f4bfa128f57aae28faeb6e28fbfe9d28fd42c22902ab15290557fd290725b6290c95b9290f0fc1291172ce29159a9629167da32917389c291a1dd4291ab679291e78ae291f9d9c2923325e292419ff2926be36293344982936f6b4293b32c1294119a32944915e2948ca662949271c29497ad82949d5e1294ba2c4294eb8b02951788929557e742955e02029568a92295767bf295b28d1296413f9296d5f95297054ae297d646c298166612984725b2984c8fa2986946a2987092e298a8bf5298aa621298ca0df29966ceb299721332997f37c299972bf299b743e299de02829a0d3e729a5529729a6c57929b15ac529b982d429bc9ee029c5333a29d34fce29d563f129d7af8529df6a8929df975b29e344c629e39d4d29e4146729e6454129e9078e29f266b929f3358529f3df1129f4f47b2a06fb062a08a6202a09743d2a0a4a142a0e7ca42a183aee2a1b2a4b2a1d02b62a2035512a28bfc12a2cad072a2ec0992a30d8832a31bafc2a31db792a331df72a3512c22a37f4142a390fb62a39145d2a396d5c2a3adfc82a416e842a41b7a42a46f8e32a4c86b12a4d418b2a4df7c82a50e6dd2a52c9dc2a53ee302a58c0a52a63767d2a64fc5b2a7238a52a76d05d2a7993292a79b4ba2a7ea1c12a7f554b2a80adce2a81d4602a82e5de2a8353d02a83935f2a8476da2a8781c72a883f382a896e552a90e0542a9137ca2a91b5e32a9505fa2a956e262a964cb92a97c5662a9a4fd22a9aaf8d2a9b34402a9d812f2a9de1122a9ec4a82aa0f8b52aa311082aa6dbcb2aa964092ab6dfa52abaf6d52abef5a22abfed362abff6cc2ac4224d2ac6a8c82aca09ac2aca5c0a2ace4e992acf68272ad3579e2ad3978f2adcb7122ade2f252ae614c52ae9a3872af76e132afb7a942afb7ea32afc381b2b0264d32b04be592b05c4872b066d812b0797cd2b22804b2b26455e2b2cfb0b2b2ebdd32b3468972b3942642b3b38802b3de6982b412eaa2b42059b2b45c70d2b46b3162b46bf4e2b46ccfc2b4979672b4a61922b4aadb02b4b2e2b2b4ec2092b4f0da32b50abba2b5226cf2b59b42f2b59eef32b5bc1992b6016602b6134442b6246e82b63b1512b6585852b65ef782b6bb6a52b71891b2b72198f2b79d9ff2b7edfcb2b7ee3f92b861f672b93aa012b97c8022b998ba62b99f07a2b9aee942b9ce6252b9d126e2b9d907e2ba148f12ba2e04e2ba349182ba48d4b2ba5aca62babeac12bac391f2bb73a9c2bbbd5812bc0ab482bc0f6fd2bc2e6552bc618842bc81ef92bc8ed322bca0a422bccedd92bd9c3ee2bde80b72be2b5572be57d1a2be697d42bf3a1032bfbebcf2c003bb32c03a0e62c0603d02c0b34c12c0b93b22c0e0f602c0e4ed02c194ed62c261d5a2c2640e22c31ad042c34e4512c3d54a02c41391f2c444e8c2c45e72f2c4bb9c52c4e702a2c4fa40a2c5610d12c5c42a62c5d6a672c62b22d2c6440032c6735a82c67521e2c69ea8d2c6d7b532c6ff6062c7b86ca2c7cd1592c814e412c8309252c84f9bd2c86d3142c898b1b2c89b8962c8ab6822c8d20402c91ac032c96ed202c972e792c9be1d22c9d46752ca30f242ca6c1a62cace5462cb1fa7b2cb6f0ad2cb9bebe2cbda0722cc09be72cc1df4e2cc3cccb2cc70c7c2ccc0f8f2ccc14292ccc4e0e2cccba132ccdc4352ccef4772cd3850f2cd99a102cd9fe242cdf2bbe2ce7d3582ce94d172cea868d2cef94742cf255fc2cf6c45d2cf917022cf93c3a2cfbf00a2cfcb0ce2d0103462d0905bb2d0e35272d0fcd572d1387cb2d1633cb2d16f01b2d1d1efd2d1f9e362d25a0882d302dda2d388dbc2d3a404a2d3b851d2d3b9f712d418da62d43f7fc2d493e5c2d4d13af2d4d74592d51e6b22d54d0f82d5a5b5f2d62febe2d6783ce2d689deb2d68c9352d6bf4022d6cd9662d704a4a2d704f072d72780d2d7353622d73834f2d741a162d75e9912d79c6a12d7a340b2d7ae6842d7f62942d822ea72d8288632d8672e52d8982132d8baacb2d922b9b2d9ac7712d9b32ad2d9d8ff02da166692da4403c2da460122da63f152da925862da9f12e2dad72192dad9e2f2daf26152db0e81b2db187b92db2303c2db8bdcb2dba5e572dc135042dcc15ab2dd2cb782dd53f552ddb79412ddc23432de08f4b2deb1d002def808c2df335b52df72d972dfa2b122dfaaef72dfb06c72dfb58df2dfc0a5f2dfd19472e0492572e049d2e2e0696d32e1105c82e19ed422e1b53772e1beed42e1cc5aa2e1d0f962e1eaff52e2353342e23e9542e299d422e2c7a692e2d532f2e2e03e42e302e8c2e31b0602e3e25802e40b08f2e4312e52e4410332e45967a2e4c365c2e4cbcbe2e4e0fdc2e51610e2e565ace2e5881412e58cbb72e5a59cc2e5c055e2e5cbf5d2e62befc2e634d3c2e67a0c22e68c5782e6c49ed2e6d98e82e71f8642e77a43f2e7a42772e7b62292e82ed0e2e83df262e844d452e860e1d2e895a862e8b26f12e8c53532e8d44592e8fb9b12e90a8072e947db22e95a7a32e9643ab2e97e61a2e9cd11a2e9daef72ea190da2ea305062ea685782ea6cff72eab12632eae8f582eb1450b2eb14ffd2eb9b5a62eba9d5b2ec070dd2ec26f2a2ec3bb3a2ec469d12ec857782ed118532ed404082ed4a3d92ed5b03b2edac46e2edf84f02ee057392ef171aa2ef5b04a2ef9bb1b2f0511492f059b4c2f14bd1b2f1cce2a2f1ce74d2f1dc47c2f1dc5db2f22d8a42f3060932f3310b02f341d6a2f3686502f3b044c2f3e42212f42640d2f44842e2f496ed82f4ac2ea2f4cf3f02f4dc84e2f5242232f56d35a2f587a5b2f59afc82f5cb0982f5dd0f52f5e423c2f60b80d2f6298d62f630a982f6424d82f64cec32f6c23f92f6de2052f70a5562f751ff72f7789e62f77ea8c2f77f38c2f791d9b2f7b7b3a2f836c1d2f95b13c2f99314f2f9cd5962fa00bb22fa8b9012fac41572fac94e82fad0ae52fb5354c2fb7aa932fcc98f42fce426e2fd12ae72fd83ad82fda0e882fdc7f9b2fde11d92fdf4f2b2fea43592fef0da32fefefb72ff1bd7f2ff34bfc2ff49b3c2ffb058d2ffd78a43003abef300da4c6300db4c0300e231c300eec753016d0c4301a1810301bac013021eeff302374bc30238d09302459e83024862f30279eaf302b791b302bbdbd302bcdf5302d740f302ec8c8303138f13034233a3034587b30364b0230368ae73038cfc43038ed1b303a64a7303c7bab30406b2b3041714d3047e73d30495d70305320b0305362f23055938330574908305a21ac305b7ff0305d6aea305fdef0306a4e5b306a8430306bc234306f3da83072cc4d30739f823077ba143077f204307bfe1f308022e2308141b53081d5c53083da263089ab73308fac4830935dc030936e553098fb20309ac97f309b6f3c309bdad030a8a24330af039e30b0ced330b1520930b536da30b9636630c4cf1330c67eb630c82ac330cb213e30d10e6930d30cfb30d947db30dc3f5830dda51530dee93a30def7db30df4ec930e0af9030e1134e30e8f4ab30e9302b30eac45530ebbc1530eca96c30f0c72430f8c01a30fad3df31014ed831024fa73106069e3107d094310bdc8e311060ab31121e293115398c31191594311bc3cb311dbbc6311dee503125419a31295455312c0fcf312d39ae312f5023313a49f5313ac70a313ae82a313decb43142008d3142f544314711ed31477610314884d83150732231507b573150f1b93151ac4131542a70315bf7f1315fac843165d4ad3169c2ac316dfa263178ded9317b06d8317c549a317cdabe31830cc631835a7a31844b55318e0bdb318e8993318fb4523190ac073191f0ab3193b64a3196956a3199185b319e817d31a09fff31a2b3aa31a466ac31a59ec031ab75d431ae409731af8fe531afeff231b0a36831b5a9cb31bd47c731bdfedc31c6765931cd388731d2aabf31d468ed31d5ca7f31d745f031d9c70e31dbe86a31e1abda31e1dfbc31e5ed0e31e610f231e6282831ee47b431ef323931f4f06831f4fc6231f67ed431f6ed5031fbbce431fc578131fe678431fe6a6131fe91483203013432058f97320694d0320746d5320a92fb320eb437320f20ca3210f1cd32114f703217b29c321b9259321d3d17321dc31c321ed29a321f177a3229321d322ac9ac322b153832313d523231f58f3235da373237fed5323ade7b323bcc0632403d86324549cb3246942832499fc33254a5f63254e1c63255afa6325a231f325eb0dd3261fa5e326251d53266bb0d326782d7326837b7326b1371326ccc33326da115326e41be3271b6ec32722a70327306053273c3eb3274c26a327559f332798639327ac780327baed13284d6c5328b6e34328b8a89328df7af3290554732925a2a3292a57d3292feb732968be6329f426e32a0ed9232a1aa9732a23a8032a303be32a6fefc32a8e26f32adeb9832b0bc8232b49e0632c235b332c3b5f932c81a3932ceca0e32d018d432d0c63732d1ee8532d3fa0d32d424ea32e108a632e2f51532e3b60b32e3cb5c32e66cfe32e67eea32ec644232edb1b832f3ea9532f57bc232f78c4033005d6a3304fd1d3305eb3f3305eee4330abdb7330b2f023315ded13317afec331b7ff4331c4931331f781033235f5033274fdf3328350e3328d45b332b329f332db0e6333110763332c7a13343c8283347137a33475343334766213348aeed334a1270334a85dd334b3b61334bf476334c6bce334d9a423351ac3133522c113354fcad335980bd335edd06335f3acb33616e2133617dfb33624f373364fdfc336515f0336e4d18336f3cbc336fe0293371cfd13375db5f3376224d33783f5f337cd6f6337d1b743380537e3380b08533840a2f338b34ac338b8c1a338cb092338f61b03394656c33976de63399ec99339a70cb339b97c3339cd6eb339e9f3433a04baf33a0a20833a3727733a58a2633a955dd33aaed4433ac7bd633b0479433b709c533b7797933bdbad933c0ce2733c1835933c4cedb33c6bb4c33c7a8f133cbb31433cdcf6a33d03f0733d0dcdc33d11a2133d38c0333d4e28833d6475b33daad9933dd387733e0308433e31be033e435e133e4a61f33e6ebcb33e8fe5b33ebdd4333ef85bf33f10ca833f3887933f3d04a33fb0ddb33fc240234058451340c2666340f428e3411d73e3420994134262125342c21b5342e3aa6342ed6c334301e36343035553431cd9e3432991f3434e3363436808e3438006d3438b565343c1f78343ce3b5343fea463441b98334443a703444744834464dfa3447b2a8344c0107344d4ee5344f03de3451a37f34538b2134574284345c9bbc345cc1b6345e74f4345f66c6346243b63467377834693cca346afedd346b74a7346fb3b234702c9034727a79347455d9347747113479472734796ab6347a5b5c347c746c3486c33f348b0fea348dd52234906d8d34907c10349fbba834a3303034a3f71534a4cd4a34a7bbf934a8d6d934aae02234ad7ddd34afdc5934b25da034b3e8a934b4abe134b60f2e34b9358a34b9de6134bb55a334bc444834bc5c4634bc87c834bf6d4434c2fb8234ccb93534d13ac334d3684d34d3b0c834d4186a34d7d54b34db201534de7c0e34dfffb934e24d5f34e69dda34eef4ff34f5399234f7622a34f7a4a134fe495434ffbf183500ebc53501db0b3503a8373503bc3835083eba350fd1c53510104e3512dc0d3513103d35158b44351748a63517c04d351883d3351eb313351f306b351f55e8352008a63521867d3521b8a4352d850a35313f213535b13c35365ca83539985d353c0e9e353c679b353d047735438416354621293548c99b354a779d354da56435536415355372563557f77b355f4e5b355f53943560b63c35621edb3562e40e3563a9ff35655cec35699a58356a32e5356a8c24356db8dc356fe3e93576efc335773c95357850c9357950bb357b2e23358230da358346d53583575835890aef3589bd4c358b4999358bfe88359095653591f2523594560835955ccf3596017c35975a8d35999333359a0bd5359ec0ed35a20b3535a5b6ae35a696f635b0b46635b328a635b3dc5d35b70e4635b7c9d135bbca5935bc0fd835bdb16435c1790535cf540435cfa12a35cfcc9935d09c7c35d4e27735d59e2335d5dc6f35d9866135dc0a5c35dd890a35e2fd4b35e4249f35e968fc35eb6eea35eb733d35ec9e3535edfaee35f2e6d935f799fb35faf96635fb4c3035fc7ccd35fcc27735fe8dd635ff426b36072ae936079b0a36090d22360a9ea536116e37361c2b3b361db74a361de31d361e179a361f3cd7361fc99e361fe6c3362708dc36283f023628d159362dbb5d363401c836384269363a60b1363b1dd5363d845d3644da5e364c70f3364e03a9364e1cb836536c203659072f365dd7ce36637cdf366617e1366f55c63674ac333675319b367a77e1367e291e3683f2d93687104f36871729368f1d0136909e0e36937aff3699f879369a42d736a13b2836a2a81f36a42fff36aa91cf36ac7f7f36b1198e36b3e03736b4395d36b7d7e036b9e12636bbcab636bf107a36c089e536c1749136c7868536ccd65836cdd2dc36ce6b1136cedf4b36d552b636db46a636dbad2436dd223c36dd91a236e0b7a636e4212936e58f4836ed573236f204da36f3381136f44c5236f62df836fc97be36ff2f353700119b370164c5370569d937061eae3711742a371311ab371626ba371b42f9371f6c1a371fee0f372197ff3723e9fa3724d3c737254be737267a1937282d053728b744372b5a03372baaee372ef5063733560e373ca9f4373e8287373f46d5375605783757ef2e37584e3f375a0490375b59ad375f2312375faeb33761072b376170d637646d7c3764771b3768e92e3769d6c5376bc081376f18c33771735537771f48377cf1f0378179203784426b378b4304378c018e378c7f55378ef87b379568ab3795e5ff37974ea43797a6af379905c1379b9d65379d1d3537a47e9c37a59b1d37a5d33d37a9e1c537ac7a5c37aef30c37afaa4337b5622737b7609437bbd74937bddb7137c457f237c5580137d151f637d1775937d7ead737dad95937e4d0bd37e8198b37ec93db37efe8bd37f1114c37f6c8ae37f744b137f79e7237fa6f0b37fad096380151ad3801b02d3803e36b380a71da380d87613814b7ec381adb9b38234cba38245ae03826df563826eb313829c1c4382e57c2383beb6f38411ff538426e4b3842cdcf384393b938497a473849aacb3849dda5384c9cfb384e516c384f31603852ccf23853db573861af2b38620b553862486a3865222b3866e6693867c691386da2c4386fdcb73871c3fd38732f2e3877e2ee387865db38795710387a5ee2387aaa6638807f963882b18b38874f49388bfea0388d17a1388d202e3890d2a13890f5ef389c958938a1368138a2f1f638a608d538aaf8f038ab3e5738ac6c1d38ad1cd338af51c938b37c4938b6ee5638ba564d38bf499c38c2165538c4506838c479ba38c5dd1a38c6cdbd38ca9a7738ccd4c738cfeb1738d0f6a638d2d57838d346ea38da09c938dacdb138df759038e74cf638f2f07038f7746438f924f138f956ff38fff590390728b43907df263908a1d839118922391312a439149c1939168de4391b9891391d64b2391e8b93391ea133391fdba53925a2473926f66c392702673927954b392899903929339f392aab5f392eb75e393053cd393c84a7393e87bb394127843943f19039486be53949456a394987383949ec673959ea0e395ef8b9395f4ba339624706396433673967112c3967cb1b396c950f396e2d2a396e6aa5396fe4133974b3833975da3a3976654639788495397ceec0397d54a2397fbc0639852d8b398b4caf398c134c398d3fd8398dca2a398eda5039905b4f399209bd39922d8739925bed3993836a3994683139974ad53997555c39982b0c39990e56399b7d1c399dccd1399ed6b039a050f839a9f98239b19e1839b7743639bf6f3139c9df2939cca32c39d030a239d69fc539d6f42f39d7944f39d7d38439d7f3ca39d9709639dccabe39e257ee39e306c539e5e93a39e945a039eb4c1639f2681339f283f939f61f853a01b0a03a05efbb3a067aa93a0a4a9c3a0ca0803a12c9573a15cf803a1a962c3a1bc5d23a1c25da3a1d358f3a1e8a633a1fc0223a228dda3a23cefc3a247b1e3a292a9f3a2c3f083a302db23a35267a3a3543693a3b79273a3e73603a400fd33a4237883a440aa43a480c4b3a4ac6703a5042f93a50e3d73a53297d3a58ad013a5bf2093a5c69cf3a6777633a6975723a6c3e353a6ca8683a6f56023a7367143a7920223a7b524b3a7bc6c63a7c6db53a7d54ef3a823ecb3a86b4183a8d60393a91b6093a9404e63a9a47a93a9b1d1d3a9d90103a9dcdab3aa0430e3aa533a83aaa53493aadcbf43ab526e53ab7dfcb3ab952b13ab988ca3abf0da13ac0dac93ac282013ac6662b3ac8ab443acac0493acdf8b33acf742d3ad1566c3ad2cbc43ad360103ad3f59a3ad4685b3adc954e3addd3663added023ae2a10b3ae355963ae555ee3aedab443af119093af93fae3affc5b03b0158013b0243923b06e4e13b12f9993b1391a03b1515423b17d6683b1a04f13b1d74b23b20bf473b2405433b25b92d3b27315f3b273b013b28b4a93b29a8c03b2b07fc3b2c3dd83b36c0a63b38a6183b3cb3223b471b183b4720153b478e3b3b497e9b3b4dec383b5192a73b58658b3b5efabc3b5fd74d3b61bb3c3b6258b83b63388e3b6440af3b654f103b673b0b3b6826173b6a8c9f3b6be8db3b6c3e3e3b6e26f43b776abe3b77ecf63b7ddea13b7f7af33b7f98313b822f823b8247a03b861ca73b88859d3b89affc3b8ad9b43b9121363b93adbb3b93ed243b94f44c3b97ba793b9851373b9cb9d13b9d9b9f3ba32c643ba54cac3ba8d3d83bab12293bae17393baee9b83bb0554f3bb0a7313bb51b903bb857cf3bb86a533bba3e093bc2f3903bc39c513bcb17d43bcfe9593bcff78b3bd2abc83bd2c3883bd8a7c23bdad3603bdee7233bdef4e43bdef77f3be2c1413be9326e3beae6823bec51bc3bf491633bf4bc323bf869543c0463f93c069a4d3c069c473c0c54bb3c104a523c1141193c1d4fb53c1df4033c1fc31f3c21df113c2797843c2ba3613c2e82023c2f4a033c304f183c32c0e43c34f8563c35f1a43c3677113c3741793c37ceba3c39b8293c3e89c73c3f86323c4141fc3c427ae43c461cc33c46e1233c47276d3c48c4013c48f9c43c4b9dec3c4bbb303c4c21df3c4f76db3c50a11e3c5c46e83c5da0433c600c813c65cf633c66707a3c6988523c6e62913c72304f3c727cd33c765b153c7dde683c7ff37a3c8401433c88cea73c8977923c8a19093c8e2f833c9118103c96712a3c993f7d3c9b30e13c9c06d63ca259323ca2ef783ca303793ca8b1893ca9d2643cae82323cb74ad33cb93e183cb9b9b23cbbb5dc3cbd817e3cc0d3673ccac9d03ccf66243cd096423cd52f0f3cd60b523cdcfc313cdd675e3ce59d713ceb91cc3cec8b983cefa79e3cf6dd3d3cf837103cfa6d3a3cfdcbb83d01786e3d0759823d0def693d0f6ab83d0fcd443d113f513d11a4903d19f43b3d1a9c323d1bd4133d1c09663d1e20733d203f2c3d21722f3d2488083d26456a3d288e573d2a690d3d32a48f3d3795583d3ae76f3d3e94453d43027a3d4467183d47846b3d4bc7043d4f52223d50a4e23d53c0e13d5584713d55cb383d57b48d3d5d97423d5fc9df3d61c5e03d632fee3d640c1f3d6654cf3d6ab7cb3d6ae1db3d6bd5be3d6c8d3d3d6e15ec3d6ecbd73d72fd2a3d731d1b3d7a2b3d3d7a9a103d7f574c3d7f59443d84c17d3d84d0bb3d86101e3d8bf73f3d8e4f5e3d8ec1b63d913d0d3d96006e3d9717273d9b60db3d9be9803d9cbd813da5a9c33dab357a3dafffcb3db039af3db935af3dbab48e3dbaeb233dbbeafb3dbee0393dbf509b3dc0ac0e3dc78cf23dc7a1453dc9eb063dcc33cd3dd653473dd83cb23ddab5803ddd9fab3de752543de7c8c83de896343deaa8893debabde3dedf4e73dff400e3e0061ad3e0279973e04e3de3e0e93243e1b29663e21e5203e222b633e269c0b3e285db33e327e553e32eac83e33ea783e375e903e38c5823e3fed133e439d313e46e08b3e47facf3e49cced3e51049b3e556a6e3e5acbd03e5d6fdc3e634fae3e6fc3033e719a943e764aae3e7780b33e85a2bc3e860a603e8838583e88f85f3e8adf5a3e8c3ac33e8ca24c3e8db4db3e8e59be3e9373113e9985da3e9c7a233e9dc4bc3ea020893eaaddd43ead4ba33eae32e03eafd35b3eb31ad33eb31f433eb5bf1a3eb6daff3ebc9a223ecb66dd3ece44063ece69b63ed889063ed9ad313edd47c83ee9b1ea3ef01b053ef3605e3ef459243ef48afb3ef586f53ef6df603eff344e3f0053d73f0307ab3f03bb8b3f0464f23f07c5823f0c676e3f10de5f3f10e2023f128f443f1a9bf63f1d4ec93f2191543f26f8bf3f2907863f2c88a83f2d71113f2ebbb43f2ec5023f2ed8453f2ee9dc3f37597a3f383d523f38f9173f3d96613f40e8643f4559c73f5266533f54603e3f5761f43f640af93f65db593f6638da3f6878c03f6878e23f76f68d3f7a2bc53f85ba8c3f86a7ed3f898d563f9500743f950cf83f996db83f9be41d3f9f30c13fa2a2cf3fa3b8a93fa65c7e3fa854ce3fa9de4b3fab49503fad0d933fb88f8f3fb946643fc055853fc37cfc3fc3fd063fc6a0513fc6f4053fcc42e43fccf98b3fd1c5a13fd2227e3fd3504b3fd356173fd61e053fdb1da23fdddeca3fdf37ee3fdf59043fe0880f3fe5ba0d3fe8b8d83fe8c5dc3fe96ecd3fec27de3fed11c73fed75953feec5fd3ff0052b3ff05dce3ff552303ff58f114001fbd940027f4040062bdc4009af0f400b0a80400df45d400ec913400f170e401054de401578d14016ffba40172e484021b87f40277e81402a8a63402b3aad402cccc4402d09d7402e718a403252d14038950840448dec4045ffee4046bebf4046de4140471ef3404a75da404e3ddd404e6003405034f44053808140539f404053e0334054e97a40564cef4056cce6405e13254061afd94069104f406c102a406ca8324074122e4077fd2a407c8f90407ce3f34080437c4080ff26408234ce4082ec204083199f4086574f4087261a408d217e40916dbd4093261040983376409a8591409cbbab409e436840a03e8540a079cd40a0a1c840a2f42640a32dda40a376e040a427b740aa916240b033b340b1fce340be32be40c04dec40c0f03340c78c2040ca2d9b40cb658e40cd6d3b40ce16fc40cf112840d7e5ef40de983340e0fa3340e11e1d40e232da40e67d7840e93e4140eeb18e40eeb77740f33c6c40fb6cda40fe0a76410522a64106919941094fc1410956e9410cb9c7410eb5314116962e4116b896411ee989412025e14120cf234121b90e4122187a412387514127be13412ac4c1412b40b441321ff8413532f8413761a54138cf5e413b187f413b6113413f693f414101bc41415a3c4143cb1e41548faa415967a7415a1545415e7f1c415f7a0241619135416bd1bd416c6d83416dbef0416dd7d7416e6c4241701bf6417110b44174180d41783058417ff0ee418162f341823f3e418a73a5418a96b64191dbcc419518e04196cbe2419d5377419ef3c741a7337041abd9b741af344141b0e8f341b331e541b57b5a41b7b89441b8f19a41b8fbd341bade9241c24be341c3260041c4b65141c6149541ce5e4e41d287a641d5c9e041d7781941d9b30141dc0f4941dd448e41dd9f5741e4814841e4f4fe41eebcba41efb7e741f5a89e41f7339341f7fcdf41f8756c41f92aa041fea30b4206146f420aa05e420f234d4210e401421471ba4214db6942194232421a8503422160b34222da03422cfdb0422dae87423d67c7423f85a64241399c42462a2b4246dd45424728b2424f2797424f722c425257a242549683425656e7425e484a425e8f84425eada442689a364268ab764269354a426dc9c4426e5e3c42724fb14272ef2842756a59427650784276e22b42794fec427a00fd427ec743427f8e304280a9ed4280bc674281544542829e55428a9ca1428e5dca4296d70c4298d14642a02eac42a04b7e42a68ca342a71c2742a97f8d42a997be42aa1daf42aee12842b20ae542b4ad0542b7758142bbd13542ce4ee042ce81a642d4028342d6784142d7d1bc42dcff6f42e5223742e643c642e7fb4d42e8029f42ea9ade42f7d83242f83b3042fce8db42fd57e042ffe1f04301ed9243047074431385bf4315d7744315e1ca43182b604326211843275f10432a53ae432a7712432d93134331140f4333598d433460424339257e433ad10f433e654b4340021e4340b2ec43434aeb4344b9354349f679434a6408434e6b404355f262435b2cf8435cd349435f564b436099dd43643cab436cf2b0436ef205436fdeb24372b178437569f44378c94f4379e32c437ee8994380e7804384a85f43857074438c0c0a438cb2af4391160d439677e1439d976f43a1666f43a4516a43a58fdc43a9a17143ac90e143b02f0a43b09e5243b5268443bf824b43c79bc343c7cb7343c8e3fa43ddd68643e33f5843e9a85043ed7a2343f0bb4c43f10c4743f4167f43f48f0043ff29f04404574e440cf258440fb3514415eb33441648b44419b091441a4f79441c173f441d369d4421068e44249eeb442524464427578d442876c3442960cf442db947443076c14432bac244332b1944378e7f4438894d443e82e9443f765044439705444c8325444fa81944514f414454f0be4458a0204459e124445e0b5e446471e44464b8e744662625446ad4eb446b622e446ba738446f765e4470793d44738d464475084244789e7644798093447982f1447bfbef447d5b2e447e0b03448352df4484a9674484ecca4488a9ab448db1b84492ca69449687c0449e62fd449f166844a0af7144a12ac944a19a3a44a5f8f544a613e644a9702844ae902e44b46d3d44b5727a44b673ea44bb72ec44bbc21a44bcb8ee44bfa31744c1b8fd44c32f7144c401b144c6f33d44c7cf5f44cfdc1744d261e344d5d30444d5e0e844d7583544d9e2b544e39d6444e46d8b44e6803344eae47544ed081244eecc9444fbb4d544fe8adb45031ec84506b41d45076fe84508fe98450c27244510ab8e4511544a451c0a824521daea452c031b4530a05f453148be4535040e4535a247453733f64537d1a0453a16ba453bf27245417d0b454225214547a92a4547ca4a454ab75b454c07a9454dff0d454ec23e454f9e244553c2b44556f735455cec3b455fb13a4562a4d74569dce145724b51457cc3c545825d9b45826b51458472694589730e459443c04596dde5459824a8459cd71d459dd49c45a1523845a1db0b45a3919d45a87d0945af799045b207c545b28b9c45b6480c45b6d40e45b6eec745baeb7045bebb8b45c6564045c681c045c7a24a45c7d1fa45ca09ae45cb4a8d45cb795045cba8a145d2315a45dc1e5945e18df645e4e43445eaaec045ebcf7145f1d9ce45f82c8e45f9059045fbf62f46034a3c460645ff46069ef946107e46461405764614a9c94614b4a346162369461782f246257c7f46271c614627b24f4628861f46303d21463a41454641a35e46464af04646771146474cc74649f591464b5861464c8772464e5d6746587031465d4694465ec4ee4662d217466b42e54670570d4670d7e64672641846739ae446740dd74674f0e346781150467ac289467c2664467d9844467fe35f4685072246854b4e46857a52468a2a9a468d4ea1468ec9d84693681c469797ff4698522846992811469ef8be46a0340e46a443cf46a4c1f946a6c9c046a9596646b25fba46b7962946b7bac146c4aa2e46c50e8146c54c7b46c5671d46c5f0d546c7449846dadbe746dde3ec46ddf62146dfcad946e1506046e17f1b46e75b1e46e802c146ead75946ecc12046ecfe5b46f47e0746f4b13946f6354846fad2bd46ffc8a7470139d947015a4b4703f85f4706333f47072c2c47083827470bd1e6470d64ee471145cd4722215e4722ae424726ba69472735b24727c3484727ede54729a870472ca25f472f6b7d4739509b47402dce4740ba2c47444bbc47483a59474b0b1e47538863475bedb0475c4f20475ea2fd4762c5cd476d49464773484a477412604777f3194779c25c477ba994477bf2b0477fc3dd4780362d47808622478100434781e5054783366447852fa647890090478feb4f4790bc4d4791e0d84792bb314792f1464795654c479891504799b45b4799c375479ab269479b102f479c33a5479f55ed479fb2d947a0fa3e47a1c6eb47a80f0547af9de847afb63d47b3879f47b3fe0847b47a3547c24c6847c47cef47c6f8ce47c7a53447cc45c747d3733647d49d3e47d4aa8447de299947e0337747e9b61147f66fe247f69bc047f6d2ac47f8d41847fc439447fc58bc47feeb0b4804b3584805f3ed4808755a4808e8d44808fdf74809daf6480c84514810cf5148135700481563894815c05f48176bf6481bdd92481eed46481fff0148265653482782e048288713482ba9f7482ec0f148338c3048356915483e934848489357484afdc9484c2cc4484d9f17484f3d8948502d9f48519519485272784852ddd148533989485986a9485b6733485d9f7c485f0b20486249f1486263964867d8ae48701d8a48709b9d4875478a48768fa0487bafd2487bf5e7487c9a05487f4d3f487f72f7487f932d48850f1a48889693488c6a9e488f86714899e083489e108c48a3a5c748a7107548a8642b48ae5ee748b32bdc48b3778e48b4ea1748b67c7948b8020548b9cd8d48be23a548bed0a448bf8c5e48c80d9948c96e8f48cc52fb48cf114f48d1c45148d6249548d6596c48d8a1a948e0120448e8969a48e9618448ecec7248f1ef5848f2a2bb48f4469648f6629448f6da2148f7afb548fc280249087733490c55d5490d11e6490d5d26490e01e6490fdd1549122c1a491320534915e35749222ac1492326024925209f49275f1949292901492a76124931f4ef4933bd4e4936202749363a2f493a48d4493d7289493f37204940f24949424919494259f9494638b649473d0749476458494ff3084959ad2e495add0c495dfd6749618e894961fbb249632f9d49645812496616b849678680496b6611496d41e4496d511f4973e2214974f5ad49796d2b497ad0f9497b474d498640d74988b1c1498a4de2498def5049909aeb4990cafb4994402c49948822499640f04996784e499e70ad499f953049a14ff549a52abd49aea40749b311ff49b4324d49b566bd49b6b80a49bad7a249bb694849bf074349c7850849c9303949cc703849cd17e949cebd4c49d5602949d7be3349e3dd4b49e7c54549edea5649f19f4349f2e56549f384ce49f55b7f49f8c65149f8cfbe49f8e8ac49faf5d249ffc2204a06e4fb4a0a27324a0b044b4a0fb5b64a14de614a1662554a1760424a1ca15c4a1f99684a2039824a219e834a22b51e4a27b2564a310f274a32302d4a35f4894a399aed4a39c4cf4a3ffcfe4a4019704a411eae4a4a73e04a4c3aae4a51fba04a606a514a6239574a6316f24a6816c54a684a184a68b36c4a69ab784a6be48a4a6c6dea4a6e94a94a7570b84a76b2964a76f0f34a7cde9a4a81bf3d4a85f8f44a863e604a8820504a88da1f4a8f6f164a90db834a92a9624a94b3d94aa4a9e54aa594284aa7c2474aa8739a4ab00e444ab1a14b4ab4b0194ab7663d4ab783b34ab82bb74abe3ea54abe87e04ac1303d4ac2d9bf4ac363474ac82ab04ad242914ad41e044ad529fd4adee9d54adf448b4ae54ede4aee60974aee959e4af5614b4af5f9374af9b4784afc69374afcd9bb4b02251f4b0284c94b071a764b10ce844b12f3c24b15e86c4b1ad3594b2040564b250a7c4b257f754b2754204b3066ba4b3475614b371d6c4b3837eb4b3c17a84b425cfb4b4491434b47ce694b48998b4b497c014b4e852a4b4f641b4b5081334b58a96e4b58f03b4b5d96a74b5fe1384b62d4e64b62f5984b6404914b69cc1c4b6c0d1b4b6e598c4b6fd43f4b70708a4b71488e4b72a11e4b7448d64b7f08c24b8026c84b8195f74b8b37d64b8bdbbd4b92bef44b937c294b9416ab4b95b22f4b992af24b9a19bd4b9c60364b9d68824ba1ecad4ba21aa74baaa5e54bae2b714bafcda64bb028914bb0c8d94bb3f2e04bb4ed544bbba8654bbf48a54bc7e0534bc9f3134bd1da224bd37d214bd44b4e4bd9327d4bdcc25d4bdd76344bddaf0e4bdf6e624be347a84be7776f4beeeeaf4bf07f6b4bf090f84bf2681e4bf300934bf59ae94bf71ef94bf72bea4bfaa9f14bfdb4274c00c2344c069d414c079aea4c0ba3cd4c0c2bba4c0ef7c74c12083f4c139f944c1406604c19c28c4c1e6bd04c1eb48e4c1fd2c64c1feb344c1ff3464c203e844c2172184c21bcc44c2280a04c2284224c22b0304c230dd34c2706c74c2843044c2e04394c32f0e14c37385f4c395cb34c3977424c399de24c3b568d4c3d42924c3e943c4c449d9d4c46cade4c477f774c49b1a34c4cd5444c5015b94c50804d4c50bdb04c5242844c5ce99f4c5e4a4a4c5fa4a24c60a1244c69f1b04c6c82504c6dd6664c6e9d6c4c74fffc4c7b02924c7be8e44c7f31344c83d40f4c872daa4c89c07e4c8c6cda4c90db8f4c92afab4c95db044c9626994c9c71494c9e377c4ca442ca4ca4981d4ca634af4ca832904ca88fc44ca9d1904cac1ea24cae531d4caf44da4cb1ec094cb203174cb2f9dd4cb8b55a4cc07f3a4ccc76c54cd438244cd57c954cd771914cd94d014ce2ccbd4ceeea2b4cef57a64cf2391c4cf767f54cf92ec74cf931074cfc3bf54d0179a14d0dda924d11e92e4d1288924d150fc84d167a5a4d17996b4d179b504d18ab484d1af4df4d1cc8644d1d74c94d27f5ab4d2a07ab4d35c9d04d379a3e4d397f354d3dae074d41efbd4d42d7d54d44d54d4d472e094d488e3f4d4b46744d4ceca14d51db624d5288e44d572c9a4d5f15294d65c3b24d6772134d69debe4d6a58f74d6c10544d6d25914d6e9ea64d7260824d785d384d7f89c64d89f78f4d8b01a64d9075024d9151934d92ce8c4d943a224d94b8914d95c4c94d9997b44d9be9e54da61be24da850b04da8d3d44daf61c94db02b594db183bb4db42e524db6aa994db6bbf14db9b5bb4db9ea4b4dbf7a534dc0e5934dc90a834dcd1aeb4dd0cf544dd1f11b4dd323ff4dd826954dd8b5504de071724de573474de6ddd24def4a4d4defa12e4df469c14df7db974dfabdeb4dfd472e4e005e744e0359b54e03b9a54e08530e4e09ed7d4e0bf0d74e1064be4e10e8514e18aa8d4e1eb11d4e1f40794e1f5cf94e2224014e2e90514e2f52514e3219fc4e3406344e37c0354e38f9614e39e7744e3bab284e3c77964e412f914e4417dd4e4472bf4e463b5b4e47eb324e499af24e4a3fe84e4abe804e4b85d84e4e08fe4e4fc4654e51dd624e552bf24e5639eb4e5a194a4e5c19584e5d86334e6073cd4e60ba044e63a7344e6683524e6743a04e68be434e6b63c14e6c173e4e6d14414e75e2ac4e7d2cb34e83500f4e8369d84e84a33b4e8fa05f4e90db094e95dc834e9adf8f4e9bd60f4e9bdad74e9faaa24e9fcb834ea084654ea743c44eaa94ac4eadf8b34eb06e5b4eb8fba04ebab2344ebc1b2c4ebe181a4ebf223a4ec4f6a84ec56da24ec5d3764ec6b3534ecaef2a4ecc29344ed4579a4ed660674edac8464edb24fa4edc8a004edee2ba4ee0f6914ee811144ee932394eec58bf4eec61594eec9aa34ef01ade4ef5f0404ef6b0654ef89f804ef9a2e74f016a004f07c6234f084e4a4f0bf0384f12852e4f24c4344f268b914f2d1b444f2e42934f2fe0dd4f366f344f37d11b4f3a5a334f3aa30c4f3da5ae4f42fb724f44b5fc4f456e024f4834c74f4a0eb84f4c39e14f5049ca4f50f5754f5105cc4f510a6a4f510fb24f5444ce4f5489134f59ed934f5b376f4f5e08584f6046204f6065344f63eb344f67532b4f6d09654f6f41ab4f6ffcea4f70af344f7334814f73bcdc4f76236b4f7825b74f78a3994f7bb0104f7bd7054f85ac934f86ad0e4f89e69d4f8c89bb4f926cec4f9a50e84f9d61e14f9d6af54f9e223e4f9e767a4fa4666b4fa495724fa49e194fa6af7b4fa8d5b44fab2da14fb26da84fbf11e64fc0307c4fc1fb404fc34ea84fc6c61d4fc823494fc922aa4fca43db4fcdf99c4fd095984fd554734fd867644fd87edc4fd8c9344fda96234fdee7fd4fdeef4a4fdf66414fe3763e4fe64b074feb02634fede7dd4feeebd34fef6c844ffb0be34ffd542f4ffdeed25000acbf5008e6e95009389d5009b95c500a588c500bc0c1501105e65011be805012cb31501402f05014687d501bd53c501d14b35022d1465023f26f503460db5034a470503596ca503d571c5045026c5047cda950489a9d505281bd50529d11505713955058c194505a65c9505bbcba505cdf38505ebe55505f746f505fa68d505faf3850616d3050651b805065f6c45067cb3a5069ea44506ed3ed5078ae38507c48ac5080571350824f95508313a750831cf15083de95508431d9509294a15092f7f45094143150990fb150a8c34650a90fa550ac9dc550ad752650b5e3de50b6575c50b7173550b735c050bc200f50be630650c20f0150cd7da350d5eecb50d73e6850da8c9a50dddfc650dfd43e50e1a27a50e1f15750e3234450f275a950f87f8150fa5f465100324f51024088510475a65104d1375107f656510ab782510ac020510df449510f6602511032055110c6d751122f4d511233215114f6f951158049511c19b2511f8ce251257a6e5125d0e9512838a8512c08fa512fc8105130a8f25131015f51359a305137544d51375748513f03b8514af34e515abd7a515cde0c515fbeb151671f01516b29e9516ce4a15171020b51743db2517482ca517bf19f518174a85186187e518a8689518cbdac518fa59151967813519f83c551a2418c51a47d5651a4d49551ab153651ad5faf51ae8e6e51afb11951b10e3a51b26fb951b56a2d51bafe6b51bc01f051be37df51bfadaf51c0cbb251c5d8e151cc065751ccd77d51ceab8451d01da051d0bb0251d13aa851d3e48551d6c61e51d9964b51dadf7051dc3e7451e345c451e9126851e99e6a51ed62b251eeaf7a51f6f74251f7d8e851fad33951fde52952009eb05203282052035a0e520455ed5204f3b15206eece520b2d20520dae9b5211daad5212c98552132abe52135781521ce782521f6272522364335227deff522af443522dc268522f4ddb5230e4f65231a453523667a6523a072d523af5e3523e533d52423d125246fb7c524dba2b524ecba25251d0c152524f99525710a5525dd0f65260e882526c66c8526cdb60526fb114527f3c8152803086528590735293076d5296b6f85297fdb452a22bcf52a30c5b52a339d652a3e9c052a4445952a7b79752af3bda52b423f652b5689c52bb08f452bbfc3f52bccee052cb405b52d37bf452d3c4a552d5176252d74bfd52e31d7852e4dd1552eb2ed252ed4df752f1726152f3dc0c52faba1553043538530593f95309f17a530da1ff531071745313e3f2531fd9c953222b535322d2b05322e1c2532b0b40532d15ed5331e3b25337a972533b29c753419eae53431dad5343956d534753165348f1f1534b3b9553515b555354de96535509c8535c30c4535e1db253638e43536fbcec536fcbbd537081ec53795aca5380df40538324a5538450e05388400d538c84c4538f0836539a5211539b9881539bc5a9539fc23f53a3780e53a5603253a904eb53a9dc2d53aa87c253ac2ae653af839a53b6342f53b8da4c53b9679e53bbced853bcd89953bf4da553c3433853cb698253ce971353d1437753d68abf53ddc73253decef353e2d82653e2eb7553e4a94d53ed81f453f01c2153f4a64e53f734e753f841f453fa600853fbb89853fe8b7f5400af9354010b715406cd1f540722d05408b224540cc558540d060d540e2558541230d3541603b0541b06f7541c048e541db63a541ec2b1541eeca9541efc45541f637b5421b91a5423dcb55425af715428a3225428f3d65430f3fb54313f8e5431faeb54324f2e543703995437b32c543ac680543c2c9454485bb05449de31544adfb8544beab5544eef705451121154538c435456a641545848d45459ad1f545bd84f54638c61546ae27b546c51db546cc1ab546ebd2954774c275478c10e54795467547b5cdd547fb69554853a7554886439548868055488f1c254899f43548a9f4b548b0e4e548de88e5492df08549304bb54964ecc5498b998549a8748549ef78a54a4598a54a74b2754a7c89c54b71f3b54b96efb54bbeaed54bd7e2b54be88fd54c510e154ce140154d0974f54d18c9e54d3b39154d5ccba54db3fe054e0394f54e62f4354e8fbff54eb140454eba9ea54ed2d4354ef335d54f2851154f5763f54feaaef5503e7f855048a4c5507a007550989615509b694550a3275550c103c550ce27d550d3c45550dc185550dc71b550f5f815510ab03551147655513570b5514960855162a105518be87551a2b11551b466e551fedd6552086fb55212fcf55248b1a5524ca66552871ce552bf7a3552e344855377471553ddbd7553fdadd5540190f5542205155432a8d5545b4eb554708bd554905aa554b6bff554c6e2755507f7e5550b1fd5550c75655556c8c556033e355694aaa5571d9bc5576529a557c95365581f7ff55875e1a559120f45595b760559879335599e897559ae83a559e3b75559e74de55a21e6155a3334555a451c855a56a7055a73afd55a94fb155a993ac55ad8f9455aeb3e455af898155ba981c55c7c1b655cc63e355d40d1755d58a0555d68b3055d7ae9f55db1f6255db891f55dd7c4455e87d3555ea2c5655eb14ad55ed023855ee744055f32feb55f49a7255f6b1e355f7aee455f9b94e560240a8560579c15607937956082f3d560d1362560ff321561058fc5614a1a6561aa87c56204c9f562aa8fb562bf808562c0007562dba40562e3590562e36f9562f992056333083563405cf56343dc856393d45563a7d76563c3d3d563c77bb563cd9fe563e89bc563f3ccd5640fbbd56420fe356498e02564af281564d0812564e0673564f19395650d7c35652bdfc565c6e90565d00de566133bc56627eed56662362566b9530566fd54a56706f7c5671acfb567384b656741b9456750df756765e08567c0024567c82fd567ef28d567f41c5568045675680aafd568235c85684a8fb56863ee25688b42056893a3c568b81d8568d800d569042f45693ae265694a6905694f319569761f3569a628b569ad02056a0645656a117ab56a222d356a40cd356a5e05256a96f9d56a977b656ae82ea56afebc756b112d956b15ada56b2c51c56b2f1c256b6df2556b79bdc56b7ea2256bcfd1156c50d4356c6358656c817a356c9a97d56cdf2a656d4d83e56d994b156db851f56de0dda56e1654f56e2a8b756e6f0a456eee1e856f5a3bf56f8cd1756f960af56fe9adc56ffc0955702d0345714b2cb57153f5c57165542571aeb5a571cfe73571f5c025721ebb35723e7dc5727ec7d572b282a572ed85e5732a8805734d69d573563f557362b995738f952573a4660573ae86a573d7da2573e3b2c5742decc5748151d57496742574be493574c54f1574deb7657549c6757560f4f5757ffff5759816557598a15575b2027575c6a6857646d985768a3fc576c0409576c8bec57724e5b5773cd22577610225776595c5778d711577a9ae6577ca1aa577ccd6e577d019a577d1e635780bbae578299905786534c57873bf1578c579b5790dc365795c0e0579a7d7b579b1aa1579baee757a09af557a3132f57a37b4757a4d18757a769f157ae519557b4713657b48b5c57b7e22f57ba7e0857bacd2057be468957c251ed57c3554e57c4961b57c682ca57c6e3d657c7e83057cb31df57ce55bf57d0a26f57de79af57e0748757e937e657e9fde457ea479757f1655357f326eb57fb827157fdd4cf57fe89eb57ff8b29580036c95804684b580acafb580c6c7c580d9669580f91a458190572581909955819813d581eb9855823667758262e02582d4849582f9de3583119e558323a08583277855833b34c5835cdb1583a00bf583bccfb583dbea2584230be58426d3158462da55846452c584813ba5849ab43584b1fc15851099458517ffc585293f15853dd9058556a445855fa1258566019585a4191585e969058606fc5586217a55863e2775866c5785871edac58737a4a5874d3835875de655876305458794348587fb80b58832c0e588463e558874ef1588c0df1588eb7ef58974bdb589c82d7589fbb3358a5014058a6770d58a6a25a58a7cf9b58aa4eb458ac620758acf76958b0116058b284a958c2b37058c75ca758cc286958d0225558d91ee758dae01e58dc405c58e66e8358e79c9258eb625158ee079258eee07b58f0047658f1532558f55fbf58f698d558f95be858fe41235900b22059014c505903b3385908413a59088d0c591331f35915af985918f986591ce05b5920cb695922a6d85924bb765924c94b5929de6f592ce3d5592d6153593bef50593c5270593e501c594390db5944adff594de979594ed757595dd807596072fa597f91165981a9915982206c598d1f12598fb85859953af3599540185999296759992dbb59994d8f59a44bd159a5eb7259a70a4559a7edcd59ac984f59ae41eb59aee44359b00b5459b22a2659b2348d59b7dad759b8d8f059ba416a59bdb28e59c362e059c6ce7359cdbf1b59d66b8b59d9870859dbe89a59df668559df7fb259e127bd59e2863759e30ad359e3b31159e517a859e89b2059e9a09859f1b69b59f99e8e59fcfac35a0058b05a08355f5a0983495a09d56f5a0b1e6f5a0b532c5a0cc9a35a0d519a5a0f4d1b5a12ea9c5a17e6175a1a061b5a1a63895a1b61005a21f50b5a252da05a2814525a2bb3da5a3519695a397eaf5a39eb515a430aa25a4bc41a5a533ce15a53b5265a6018665a602bde5a640a3c5a6596015a68a0c35a695fe25a7024b15a7646175a764ed95a7deec05a7dfa1b5a84762d5a8569855a8e5dd45a91cbfc5a9618025a99d57b5a9b574b5a9b6a855a9c71965aa432d15aa5bc155ab12f2a5ab16ffa5ab20cd15ab6707c5ac1c3db5ac264fe5ac329035ac759dc5acb06ea5acd6ae85ad159135ad57b305adc447e5ae288285ae763835ae88cda5ae913cc5aeb663f5aeb76375af4ead25af73d5b5af749e25b000ec15b01a67d5b10da145b11532c5b14fe7e5b1713535b17cda35b17ffc95b1be2dc5b1c198e5b2107a35b23d5575b26082d5b2705945b2928f35b2ade9d5b2f05f75b3127f05b329c135b3900565b39ce425b39f9565b3a36d15b3d7db65b3e60795b3e80aa5b3f667c5b40549a5b45efc65b47058f5b49251c5b54354f5b57d89b5b5dd5875b5eb05e5b5f32f65b60f84f5b64ba145b668ac05b6b85c45b70a54a5b72b6405b736c155b743ffc5b78b8ab5b798f445b7df6e25b81c99e5b8959cb5b93b4a95b965a795b9cbb795ba3c24c5ba885795bade13e5bb0a2705bb123645bb51b6e5bb807675bb9120c5bbd07925bbfe7095bc18e2a5bc6a9735bc92e255bce2bd65bd1061a5bd19f085bd368a75bd511335bd713a65bd850105bda9be05be296a85be61ce45be8e6d75bed4e8a5bef5a165bf569db5bf6f47f5bfc51ce5bfc79fb5c04e5295c0c26bf5c0c760c5c0d06a15c0d57de5c0edc4e5c0f439e5c0f6ea55c1456005c1460445c1de6bd5c1e41ac5c1ec46e5c210ce45c23fbdf5c24fb605c2a37ef5c2d3a565c311d2d5c34b6605c35e3505c38d6125c3f9e665c41e45c5c4252c65c473e855c4b4add5c4c43385c51ec325c5231345c52e5b65c54d2925c5abe465c5b109e5c6036755c64eaec5c6563d55c67bd285c6bb7a35c7052455c71c5a85c72206f5c730ef65c7380ef5c73e3725c80cddf5c81c47f5c81c7515c84854b5c8513e45c88a61e5c8f61a65c956fc95c981f815c98742d5c99e8475c9abc775c9e60e75c9eab145c9eb4775c9f34105caacafb5cb21c8c5cb7e7a45cb820ad5cbf6eca5cc3155a5cc3ba4e5cc4f0d25ccc11235cced2975cd1aa4f5cd2d42d5cdbbc0e5ce14d315ce2e0335ce6655a5cec22ff5cef7cad5cf22f6b5cf258995cf49ac45cf500195cf678425d002c965d03e7035d03f95f5d0bd3625d0d1a0d5d12d6c95d135aa45d13fa005d1ed1955d23152e5d31055a5d32e6985d351d3c5d39e4725d3fafed5d53723c5d577fae5d58670a5d5e88655d62e3835d635dae5d65213e5d67791c5d6869f95d6bf6875d6fc1a05d7345e35d740a245d7427ac5d7703935d7820d55d7cdb095d7d7af15d7e32225d7e8f285d803beb5d8688fc5d8850a65d89db805d8acb645d8bccad5d8e52c05d9014835d96a1bf5d976cfc5d9d79965da19ac55da31c1b5da444f45da5bbd55da669c25dabbc3d5db0381a5db4d70e5db6b1535dbab6a05dbabf975dbd7a205dc1abcc5dc3dfba5dc68e7c5dce56e55dd13f455dd238cd5dd6084e5dd789655dda98985ddb30455ddeaedf5ddf50b45de288995de39f355de3a83a5de907db5deb657d5dec13925ded74005deddc695df09af05df51aeb5dfe6ea75e0025705e01243b5e03d5205e0592a65e0a1a015e0b9b6e5e0c24795e0d32275e106e485e128c705e14034d5e14ede25e152a8f5e1c29cb5e1ff1325e224f6b5e2947775e2a42d25e2d6f5f5e2edb645e3067bd5e31cbb35e3b95f25e3bf00d5e3f32d95e4247805e43b1775e4532d75e45f4795e48b5e55e48e8625e495ec15e4a4a3b5e4e4c1c5e507eca5e52dafc5e57377f5e6166725e639ad45e6433615e65ab755e672e575e6a2f365e706fa55e7134f15e735c085e74d0985e79c8415e7b03375e7f21a75e8172835e8248d65e83ec285e8458e85e85dc865e88129e5e88f6e25e8ba7835e8ffe165e91046d5e9660435e98202e5ea055f35ea7cd9a5eaa4bf55eabe9cb5ead32215eadc5195eb113c95eb16e755eb438a95eb5196f5ebb15075ebc5b925ec642035eca60345eca95d55ecef8b75ecf9ea45ecffb535ed6cd1e5ed7653d5ed86fef5ede28185edecf4b5ededa545edf2d455ee0f3815ee184235ee281085ee3e1405ee726c95eec7fd05eefd0e35ef05d9f5ef2af965efa64095eff172c5f0083fc5f0119515f0133c95f040fd65f04d9235f05c8ae5f0b9c895f1141ba5f1a7a165f1aa2a25f1ff8135f2024e75f23e6465f2496275f26bb955f27ecd45f2bb9625f2be95a5f33a1e45f39709f5f3a27b95f3a31a45f3c9d525f3ed2a75f47d4235f4e550b5f50e3d35f570a0b5f57c9345f59502a5f59838a5f5c8b9c5f5f59205f60b73d5f64b10f5f65f28d5f665f735f6b62e45f7232ac5f749c3c5f786e825f7c829a5f8199c05f831d0e5f875e425f8ea8715f950ff55f958bea5f9c45005f9d43375fa090715fa428ff5fa683fc5fa8da235fad6cda5faeb8295faf2f735fafa34d5fb7188a5fb83d285fbefc955fbf8c3e5fc13f105fc843b85fc8fa165fcf14495fcf55465fd0a0355fd3991b5fd4e56b5fd627325fd9f2fc5fe21d6e5fe37dba5fe3b5435feb37b45feb46ee5fef3afc5fef9d605ff0a8a35ff84dcf5ffa4f5a5ffeedba6003ed0c6003f62b600835d7600dc03b60103cd66011a39160146e546015b89c601a1ef5601baf10601c79d9601fe1b060223c2c60228fe26029319c602af65160348e546035bf8d6036bf4d603cbbee604631d6604a7937604a8110604c879e604e923f60524cc76052972360530f4d6053664e6054178960555b6e6056c07d6057e65c6058ddc16058ead360599703605addd5606458dd6065b1fa606602e7606cad78607566086076cf1c607df32e607e3d61607e8310607f0cfb6083d4ba60864d8d60864fb660867dd760871afd608d51126091854360964e3260966f97609cc46c609d4705609d9b27609f41c160a062e060a0761a60a2c78160af43e660b1b93f60b406e660b428f160b7859160b78ce160b7b8ee60bdeb8960c0642d60ce439b60d082e160d529fe60d7031860d892d260d9cabd60da52eb60de54fb60e6730360e6e44960e6e9d760e76a4360ed75d360f20e3560f36b5760f5c4c060f845576103e375610528c561069787610943796109acb3610aefe9611388d261141cd86116002561186e3c611a4f49611b30e5611d30a9611dd718611e4cf7611f453861214ae36130e1e361327ab66133f74b61368f816136c0466138e11861396931613a2025613b8912614391bd614588a7614666b3614775c1614e2da96150742a6150ffbb6151213a6153f9c76158a0556158d325615addab615c86ab615f82bb61607b64616112a7616336fd6164034861655c6e6167d09b6168b18d6169c87b6170411e617167fa617352fa617625a86180e47e61810b7661810cd26182b44561833ea8618c0312619125a8619b47d361a10c6661a1ec0461a34e3461a5478361aa848061b621fd61bd7ca661bd8b1a61c4604861c6144e61c795f361cb5cdb61d1897361d48c7a61deafd961e0b6e161e41a4f61e49cdf61e613d261ea9ef261eb6e0c61ed145a61ef33b161f1d63861f9821661f9858361fef407620398e262050503620710a5620741e06207a27c620aa9e5620d0e0c620df7166210e1d962122146621283f06219df65621c2f35621c798d621d47fa621dc886621dedf6621fea786221aebd6222fc986226bcf16230a094623130c96235727d6236a10162385c2a623cac3a623f6fd86244c79c624a4e5f624fbd09625257a462540c1a6256ad9f6258f07262594db1625bc0ac625cf0a3625d96ce625eda1562607e976261b3886265f31f62672e756268890962694f2f626a67dd6272a8e762739e69627f65b86286fe06628881b562893e8c628ec9ee6293b3d76293ba3c629453c46295badb6295f57d629632fd6298688b629d4192629e01e862a452e862a4bc6962a9186d62ac742762ae3b9f62b3bf4762b4d50262b7990662b7b12162b9948862c4801b62c8d03a62c9430262cbc3ed62cf16cd62d3361f62d6dcd762d7210c62d7e03a62da324662db1d6a62dcc80962def23362e0129962e34ba662e35a2862e5254f62e67a7162ed272262ed5c7b62f0318562fa373b62fb090962fc6fb062fec1d26300db2c630c456b6313286a6320cf0a63236c78632404236324a515632905436334e8f16335a37d633630e8633679eb63368f92633ab21d633bf4db633c5fd5634414f363472ba46347d3b76351ff9f635299bc63567ede635add3a6361bae86362d3bd63653a5363673a036367b0c7636d0c326372aa2d6375434e63846d13638810dc638b69ea638d7ce3638e1c066390af0c6396b73863a009f063a2ad1663a489e563b056b463b1609063b281ce63b8387263bdf07863c2297d63c5851563c5e28663ccc0d163d0bfb263d40b8863d880a363dbf24863dc218163dde93563e2165263e2722763e38bb563e6757c63e7934663ed95b863f2527563f447b163f5b69863f8d76364015abb6401ba8b6405c274640724b6640a244a640c4f70640d54a4640ebc4464112a756411ae476413d21064151dfb6416657b64173d49641bd3ab641beca76420daec642259b764237df76423cff7642424bd642b4a25643096f36431828d6436003a6439882a643a30bd643c1d92643c774e643fc7ae6446db97644833a3644b6b21644eb9b1644f1a1e64511ae66457b6446459e421645c20376462bad364634ae6646550f864744421647514a6647611e764800984648096336482ca946483c57e648626d364863eba648754bd649052716496cb616498573f649f1635649fce1b649ff29564a01d6564a169ac64a32fa264b444be64ba2ca964ba512d64c2042a64c70d0364c8e5da64c9d2fc64ce06fc64d0253764d0853864d3013064d3473b64d3ce8764d625a564dc7be564dc7e1864dcdc7d64ddbea364e1021064e14d6564f04a0e64f62a4964f6811f64f6f4d464facd6964fbf98664fcc17764fe7fe064ff34016501734f6506b6626511b9016515b6cf651650e9651bce6e6525b45465266bfa652cb0a7652d3499652dd32565387326653cf1f96540e41765420f1b6547936e65492059655661db65580246655bcdd6655cacb4655cee8d656358b5656a05a1656b20a0656b596d656dbd6c656e3714656f2c16657281a765745f496578d0e7657953f9657a2541657a3d46657c1dfe657d7997658034fa65807def65813029658f1f336593d8a3659463e865956392659e675565a01fbd65a3379365aa298c65aeecd365af8e1065afcbef65b1c33265b2bd6a65be87b965c0ea5665c6cc1565c6d9bd65c7a9d765c9cbeb65d073e965d1e48765e15db565ec7f3a65ed228065edfe3f65ef215c65f0b2db65f1684965f23da565f451be65f5d07965f827d36602ddb9660522776606764a660b4a50660ebb946610fb596617e1d5661853396618dd636618fb646619955b661c952e66200cdb662096c9662454ec662492786624aa036626528a6629410d662aafe0662b841b662b9b75662c24aa66344065663757a6663794fe66379e5d663817e566495cfc66497edb664abbf9664d3622664fd7c36653c69f66598754665e3cd0665e7f046664884a666d5315666e4bbe6673389e6676102866763ec86677a5b1667ca50266814e596681dc756685870466902370669335f86693707266940e5f66998ed1669b478c669f11d066a54fa366a83cc966a97a0666ab7ec666b0703a66b9f51e66bd2c4166c0ec2366c337bb66cc9dfc66ce771d66cf883566d26f3c66d39f3466d6e24f66d713a266d84bdb66d9b9c666dd8fea66ddcd7066de53a766de997866df700f66e29aae66e2e50d66e4118566e590cc66e65cd866eaac9666ef6ca266f0c5c266f4b7ea66fd5e1c66fdaa506700ed5b67079ec2671515966717431a671924a6671c524b671f94bb672401636724d80b6727b88e672a42db672ce299673047806730f68b67375266673d537767410353674214dd6745e94f6746d9176748783267493e606750d41e6752e82e6754edbb67559fef6765ef136767283367678c16676e98b867729f886773e9526775f0326776728867767f2067797590677be446677dc1fb677e06f3678525c76789665d678d757e67959a7d67a0d1d667a6c6a367a73c0d67a816a567a8dd6767a9888067aa9be467ab7d8067b11bad67b61ef467be458d67c008f467c93d4067cba51467cd494f67cfc98a67d445da67d754d667d8dd4267da638267ddf2e567dea63967e0bca467e11cc767e942d367e9507967ea961867ed9de867ef2be867fb184d67fcabc767fe78d66800d22b680389356809632d680b9d1b680d1a776812314c6814cc946814ce5b681c43d6681f755368260c0768275a1a6827821268293e86682a0aec682c0f32682e1640682e2d4c68358b9d6837a7b7683d0748683e2c9c68424bfa68442506684453be6846a3a86849706c68587497685b5ca1685c8cff6861a2be68622830686b39f4686d4815686ee7a668730065687810da6878ae0168795ebf687c98b7687e06d468862d9368867a7b688809b8688a3523688d6cdb688f0615689017a56891c5ef6893d5a3689431b2689b3a7d689c723068a142fe68a31f5268ac6a1468b51ec568b7faf068b80e4868b8eb9c68b98afe68bb5aba68bb6c8968bd31f168c2715568c7500268c890cd68ce7bdf68d47b1d68d9cc7b68d9ede968dd4eb968df0bc668e5726b68e73a3568f0e3c768f43e5968f7698868f77a726900d8ef690c81d3690f51b0691f12866920c1bf6924a8b4692aff15692b17fb692d3a2f692efc086930678069337e0569348b8f69360aa969387fcf693ecacb69439ed069453a52694623626947a683694cef57695009ac6952e8336955388f6957474f6957c4ca695aa1c5695d5b83695ff69269611d51696321dc696c66bf6975ca5f6979c058698267f46982a7bc69832c506985016a6985bc0e698c87c8698c8e2e698f2eb0698f756469935aeb6994760f69967ac869968ec6699eb84a699ec7f4699fca2869a0a56a69a3417769a3d5fd69a4f1cf69a8df9f69ac237e69ad7e5069aec0c269b0a36969b0c1eb69b6682069b8ff0469bdd09669c3338f69c4b5d869c9f1d369ca3ab269cdc08a69ce178069d8830569d88f5969e21f7b69e4ad4269e74af369e7555369ec7a0069efe80a69f40e0869f57ad46a044d6a6a0749516a0ecaec6a0f529b6a12969b6a1374126a178caf6a285db06a290b4c6a2913c36a298fd46a2aeaa16a305faf6a3a12676a3cf5dc6a46b25a6a47193b6a4f66ed6a51579d6a59c8cd6a5bb1256a6225136a66d1d96a6c3e256a6d4e8e6a70af146a71dee76a75bb196a78bcfc6a78ca656a7934a46a7c01bf6a7d9dff6a835ffc6a88a0cf6a8bae0a6a8bb0406a8d72616a8f4bf06a928d316a9a595e6a9da7436a9eae236aa34fb26aa6a8776aa7afd36aa8ecd96aa95f0a6aac195e6ab3f0186ab64fea6ab67db86ab6ea846abfe7346ac02e116ac034206ac3a3466ac3b8ac6ac509066ac673006ac6d2d76accfab16ad187476ad2c4186ad8a8d26ae404de6ae598646ae617a96af3bd9e6af738fe6afdbc736afe0a496b0e304f6b0e70b46b0e7b9f6b11c1c86b13c5ba6b13d96c6b14b7326b1548da6b18c0966b1aa2e96b1be5f76b23bc446b2972fb6b2a7db26b2b98f26b2bc63d6b30662d6b3097696b30c6f96b3151e36b34adbf6b3999b16b3a3bda6b45b93c6b4ae3f46b4d51ca6b4ddc326b4ebffb6b51608e6b5257976b58b09c6b5a1d8d6b5bd1506b5ccad56b62aecd6b64697b6b67e3786b6d1d106b6fbe636b7858bf6b7c234b6b7c5d7d6b81aaeb6b83417e6b836f5b6b87b4c56b8a86f36b8adbe56b8afa516b9d7c9d6ba3a21c6ba8742d6bad05186bad32976bb0745f6bb1ae1b6bb2ccce6bb4ce656bbb400d6bbda22b6bbf3bad6bc2e0bd6bc426e06bc626156bcab6a56bcc70236bd4d4ae6bd522a76bd62a6f6bda2ec66bda81e56bdaa8476bdcda026be1206c6be2eab06be3ede56be7d65c6be8a99c6be942c76be9e04a6beaae106bebde3f6bed3c5d6bf03d9b6bf1a8b36bf8cf336bf8daef6bfb34236c052a436c07d47e6c0831816c09b5b66c0e91716c0ef0646c13dfdd6c1487606c18a99d6c18c4e36c1e5da66c1e87f26c2268af6c227ab86c2bb9836c2cb8136c31048f6c33c47c6c3bb9906c3d9b466c3d9edc6c3e109f6c45f1136c4856856c4e8fab6c54a5456c5545d86c58096d6c5a49496c5a78666c5b09d86c5d919e6c5de2696c5fd33d6c64b8ab6c66142e6c6729ee6c67e0b36c6dc5f06c6e292e6c6ff6db6c7096496c8278ff6c84b5df6c8abca86c8da5486c8eb8936c94a7546c97d0186c9a8f976c9c8dbf6c9f26bd6c9fd0296ca32cd06ca611356ca6c79a6ca707676ca888f16ca9ced66cad36ff6caf6c8c6cb0665b6cb1fe0c6cb7f65b6cb9b2616cba9b646cbd52466cc4d53a6ccc9b976cd43ad16cd45b8a6cd9399d6ce76b086ce89be76cec718f6cecbf146cf86d0a6cfeac626cff1f956d0158736d03ed536d05c04e6d088ddc6d0ab5876d0e775d6d10fbee6d1196d26d122f0d6d12f97a6d1488a36d16eae66d1dd2b76d1e84116d23d2fb6d244fa86d2a97a06d2abbfb6d2b4eac6d2ca78b6d2d7c896d39c9526d3aa1e26d3b5e096d3d1c8b6d3e00496d3e2c196d3ecd746d40e3126d44b4eb6d49de1b6d4a4f406d4b2e306d4b56446d4e3f496d50ca2d6d52aacc6d5e6fb16d5fb9326d61e68b6d636fdd6d644eae6d655ef26d6a54816d6a64796d6baded6d6c3aef6d71fe186d7a93d56d7bab856d7ecb356d7f25956d8876556d8a71946d8ca6816d8e42dc6d8f58856d8f61416d8f7b5f6d8faa076d9390716d9407c86d9602206d9aaa2d6d9c46696d9cf17b6da196456da239946da953f76dabc8c86dad2d026db50d0f6db6be176db6ef736dc5b7756dc628966dcc36d86dccd0be6dccd38e6dcdee4a6dd0ea776dd3f3886dd43a1d6dd8fbee6dda25b46de8d5db6dea2e6c6debace26decd0316dee81496df06b736df09a786df0e01a6dfab8b86dfb56be6dfc6e3d6e0768396e0942006e0c5e616e13074d6e1663e56e1c39886e2038e96e255da26e25a2806e2990786e2dddc16e317df66e334f146e378d046e3c70d46e3ea5126e3f897e6e44e6ad6e45012e6e4589596e47a6526e53f7366e5e78f36e5e94556e6edc156e6f694d6e7998046e7a54d56e7c05166e7c178d6e7e701b6e8002c06e820cc16e838aee6e854dbe6e8c3db86e9483566e959cdf6e996fbf6e9c3bee6e9c428c6ea2d6106ea2fa766ea57e286ea729de6ea7ccff6ea8261d6eab858d6eabd3106eacb9826eae0f996eb1b5aa6eb69c6b6eb77a886ebac9376ebbe37c6ebc1fad6ec2f7c06ec97a376eca500e6ecf7ba36ed2670f6ed86bdb6ed8df326ededa086ee10cd76ee6dece6ef700346efab6c06efacda66efcb48e6efe11886efff89a6f0113016f0367336f0644846f1e93d76f1f85516f2088186f2216206f224f6b6f22fc7c6f2477ec6f269f346f2758e16f2855be6f287fed6f2a5ae86f2e5bb76f34be7c6f37cbfa6f3bad0c6f3d00966f3db14c6f452cae6f4592ff6f47ec1a6f4a214f6f4f14ed6f4f7b436f50cce86f55fbfa6f57e70f6f5ec3406f6248c06f6787ad6f6e162f6f6faf316f709f186f72bf1b6f73850d6f7523f26f81fac26f8310266f83ca9e6f858edd6f8b71d16f8c633c6f91b5b66f97422b6f9ba3836f9e36e96fa20e1f6fa381326fa70e606fa87c4a6fa8a5646fabe7836fac002a6fadcaf46fae2f4a6faff9cb6fb666036fb976ac6fbafc826fbfed176fc000726fc3915f6fc3b9406fc52d846fc55da96fc743116fca7e726fcb90006fcc4f8c6fd18e0a6fd294436fd41dc96fd6bc656fda82f36fdbc03a6fdc6cbd6fde760a6fe5cc626fe84a266fe8d7dc6feb53946ff4deca6ff5f0646ff8f69c6ff99ee56ffa25e96ffa47666ffa594a6fff959a6fffa412700262417002739b7006b88d7006def6700a404d700fb363701363ee7015c77870165e537018af167020383170222313702c7771702db76b70301fd07032b910703326cd7034e94970458dae704848f1704904c2704907847055e43a70586fb1705b247a705ea0f3705f0b7f706037a87061e9a570628304706318f17066d84d706718a3706e2a1a70778957707a3af5707de0b9707e274c70801d057082cc57708767d070880c87708eafbc70916f0c7092c98470934065709411557094c5b670973f33709bd2ab70a310c370a9dd7970b0f00d70b5c19a70bb819870bdfc3570bfd08870cadbe770d1d72370d4526e70defe9570df655d70e242a970ea299670ea8ec470ebad0370ef05a470ef8d3270f887a07104bc3571090256711262a37112f77e711355347114fb227116c040711addd07124d0f57127cc437128feab712eac36712fb4cc7133b7487134e01e71383baf71404ec7714c277d714ddabd71506f3e7150794771544ee1715726887158a336715953a2715c4eac715eae22715ef7127160d578716317a171655d0a716892b771695a817173071171747ac671749b45717bdc04717ebaee7184e0de718699bd7186c518718a58ac719347617194c5fe71974d4b719f96d571a2fcf771a447fa71a481a471a89f3771a9291071aa4d5071acdfa971ae633b71b43ee271b6896a71b9f17871c2f4db71c6af5f71cd5e3f71d0cd9871d8457571dbb88171dc40e871ddbe6c71e18d5c71e2892f71e420f271e97f6071e98f9971ea99d771ebfdf071ecd1a371ee93d571eefd1671fdf0dc7200a37f72025ad372030c57720314cb720a6927720f3c5e7213ee587216f0f072191b1f721af0a2721b82c57221beb8722d023a722e7986722f61a872328c06723394c272360f357245927f72462a0b7248ccea724d43ae724dac557250d783725af698725b6b9d725fe10c7262485f7263426472644e6e726638f6726fa6327272814e72730bee7278076e727c66bc727d2977727f78617280dea872834dd7728423ce728a25bf7291e4b872987fe5729947f5729af459729b5daf729c4ea2729fab1072a037d572a058cd72a75c5b72ab193972abd14f72ac3e9172aece3d72b0318572b2d5b072b6b45c72bc2c4b72bc550072c0ca7e72c326c472c48f1872c51e7c72c5fded72cca1ec72cd541772d06eeb72d7382f72d7645472d9acf072dd9afc72e1770f72e2f29a72e55ace72ee341a72f0e90472f1f7c472f9fad672fa8e3672fdb94a72fde5ad72fee44173040eae7305bf4a7305d02f730736167307852173078bef730b3173731360217315c7cc731dc9d7732953fc7329d68b732ea6417331d8567333dbb67334eb1f733682097341d43973441a9d734d4b417352e29a735aa59f735d5c7d735e79107360cc017361a1aa73696b3e73770f57737893247379a37e737c39d8737cdc29737ee67b738d6bf273a2bc3773a2d85773a74a0d73a9ec8c73aaaf6d73af483c73b11eb073b3a5eb73b4029c73b7d19673bf24b173c8226373d142b673d2275f73d4a3d673d555ce73df4d2873e8b3e773e9c2d773f2a2aa73f56d8073f8087373fa1dd573fa5d5473fecc9574052d7a740a612e740af2f5740c42d5740e9006740ecda8740f29de74162936741973a8741f4e987425b03d7427505174294e88742b9de5742f4d227432e88b743526f3743826d1743ebd9d744a4e84744c9ffd744dfb7a7454961f74578bd07457cf207459035e746268097463f1f9746722b074683a697471732d747293817472968274749ddc74750a187475735974763f81747b9d1c747c92b2747dc7c9747f17aa7489599a748bb29e748d86d074913963749562197497391a7497be587499671f749a4f14749fd68c74a25dc974a7973174a7bd6574ae758474b2b9d574b48fef74b546c874b5bdb374b7200b74ba17d174bce1b874be14d974c0743b74c1d0d674c2e4a874cab10c74e3e35674e546e974ea0a9c74ea7b8574efa86d74f2bf2074f48db974f85e9e74fc528074fe70c974febc0c75016dc57502907775034879750adaed750f6f58750fd97e75115ba7751690d2751d1641751da08f751e1b7d751fcc0c75291786752a2860752a5f58752b5db3752d17b7752d7369752fb7d17530d7387531bb60753bcb7f754acb80754f5bec755360167555d0b5755a4604755cf045755cf5df755fad0c756b8e79756f6df6757facf37585eebf75873aab7590428375965b5f7596981c7597b4c2759e9fb875aa956975ad81d575aeb47b75b241e975b39fba75b5013175b7945575b88e0575b9099775bd9f2b75be464d75bfcc1075c2a89d75c3573f75c382ba75c4df1d75c5d3b175c7e10e75c8a56875cb364675cedd6075d1c85075d1cf7c75d5a7ba75d63c1c75d890a175ddb6b675df436475e0d4df75e2b24e75ee43ad75f9520575fbe1a275fdf809760017f37601126e7603e158760ddc267611553c7613a42476143b8576188ba27618de86761d714f7620e13576230991762481117624b4e47627b2cf7629329f762d324a762ff8a376302ce07635a728763b057a763bdc12763df492763f40a8763f92807640a85776418f367643bb7a764612d37648d27e76505478765aa80c765bd41a765e03dd76633fbd76684056766877e976688f5476695a2b766aac517670baf576748d19767bdfc5767c107076836809768459eb76846bfe768667657689b133768d46c57690d82d76914ed076919bc376934aa27697968e769b122d76a17ed976aa724d76aad25376af6b2476b0c2bf76b1e5cc76b6d37476b931fb76bacb0c76bc589176bea33c76bf5c2a76c1a48576c4c78b76ca782676d36b8276d6a3d776d7c5d576d7ddd476d8596a76d884a376dc82f476de619276e1333376e5f8c476e7571976e8084476eb9a7376ece8b276f13d7b76f2b0b976f3f1c476f52b787702f41f7708547f770b20cd770df9b3770e16b17714159d77149b9e77159cd4771717c377173c1a771f8e5b77239f597725b072772932c877299b2977318d1b77353a047736ce247739d4c3773a31bd773bbb3c773c4710774250fb774b04fc774c948b77501bf27752852d775395f5775419c177541bf4775a5acd7760e098776174e87762987a77635e0a7763830a7766d5df776d48ca776e12ef7770c0807771222877725876777463eb7777a10c777db139778d5a067790bac27793991e7794e72c7794fbbf7795f21977961b1c779b29c3779f5b6777a1821e77a9a1b377aa586c77acbbe377b07c1277b2514477b7c4a077b8c14c77be357a77d060c277d57a4d77ddf4cd77de98ee77df105a77e011d977e0fa2477e6216677e6c42b77e9f6c977ecc17077edbc4577ee96b377f5df8f77f9cbef77fd31ac780055f478046a197807a983780e2322781272a37812b4c27814a6ab781743d47817c2997818aba37818ef03781a8361781c63d1781d79a1781da7d1781e4843781ec7697821a1007821addf7827473f7828d76d782a9dea782d7f94782f1e2378333995783fa269784320787843e0b0784496a87846e4a278494bce784cbeff7852184b785828d478591be67860b3ef7860d1287862a9bd786350c57863c5247867efdf786807b6786f95d6787099ef7872cd3278740aef7874b5817874cc2078755f13787c330a7881c9fa7882293a7884d8227889127c788c8683788d49ea788df875788ef69b788fa1887892d4107893d53a789612cb789a7388789ccbe3789d66b978a109fd78a2a43278a491ed78a4f05a78a5d2e178a6ceda78a8ebd578acdfe178ad653778b1182978b217d178b2499a78b292e878b5cb7d78b6a5ae78bd52ea78bed81278c0611278c7050978c70a9a78c8ded078c96d1378c9c26b78cb379e78cb7b3578cd2a2a78d20d1878d4bd2378d829d778d92deb78da678478db604d78e8daa278f02a8e78f08ca378f0f79c78f155f478f4096578f4129878f4a95278f982b878fa4c1978fa7c4178fe4bb779017e3c790323ae7905daa57907099c79077ef5790c1683791310467915d974791638fc791af923792018377920fbb2792356297923ca22792a8f65792b9c05792e9bce792f8f5d79303d647933ddbf793561087935b43e79372c3d793bbbcc794a8963794bf3d7794c4866794dc894794eef10795488877954b02b7955e4a47957f78a7958907d79597fd07964bf68796689157967338f7967cfd17968d5db796a04a2798301f279834708798604dc798d300c798e879f7991d819799370d779974110799a0af0799de24779a0136e79a3a9a779a41bab79a6029179a90ab479aa9a1e79abe0d679ac75db79b09df279b52fbb79b613aa79b6193679b6352179b6e3b779b7aada79c051a179c6d77179c826f579c940e679c9de4279cabe3179d13a0979d16c3479d25c9579d3e36e79d4f99c79d737d779d965d479daf45d79dde11979deb7f379e8508a79e8e92379e9133379e9234c79eabbbe79eb617179ee99e379eeb78179fe660c79ff06137a03f1ff7a06e0267a07a49f7a09a0d87a0a7eee7a0c47347a0edb2f7a0f52977a10ab5f7a1472f07a25ecab7a26564d7a2c026d7a3529f37a38f2667a3aec4c7a3b08027a3bc59b7a3d85cf7a47eeed7a51561f7a535a4e7a56d1187a5f8b607a60f7ff7a61801b7a63c05f7a64ad1c7a6703197a6bdb697a6dc8377a7193b37a7937e77a7d45077a7d8e4b7a7ebf217a815c5d7a8926837a8c3bfb7a92d9677a96b3117a9758d47a97ec987a9aa6267a9f65527aa077217aa30df97aa370b07aa5c5e67aa9fc627aaa4d1f7aaaa22b7aaaeb337aae1fb07ab2fe647ab68ae97ab89a2f7ac5d1a67ac603ac7ac60b7e7ac7d78b7accad1f7acddd5d7acfcf377ad3463f7ad348437ad566887ad791b97ad9fb557adbb40e7adce05d7ade555a7ae50cd37ae698d77ae7f5c77aefd6b37af343237af436647af64b507af763007afa937b7afd051c7afd735f7afd73817b039c447b04ecb87b06424e7b06b8b27b0bbc017b0cb0c97b124ce47b13dd057b1526377b160a517b18f2ff7b1a16967b1acf0c7b2117637b239bd97b256f9f7b2662c07b267f597b27ad6e7b2ce7547b2d42ac7b2ee1c67b317f657b37261b7b3ac6c97b3c1cf27b3e00e17b3eb3807b43ea7d7b4436347b487aee7b48bb497b4921667b4972427b4adf937b4c768d7b52aa2c7b5702657b574a287b59da817b5ebb587b5f8b7d7b62a1147b6477047b6509287b688f1c7b68ff2c7b69e98b7b6b3c2c7b7398b47b8071307b80bf097b88e66b7b8bd1d17b8d7a677b8e66437b9126b07b925b207b9299db7b9696af7b983dac7ba097807ba0e8827ba591647ba5b9ef7babd30d7bae2bd37bae550c7bb129527bb18e4e7bb2273c7bb62fb87bb693fa7bb97e0a7bbc7c967bbd7eac7bbfce977bc5402f7bc6e21f7bcf24a67bcf38737bd815827bd9c48e7bdbeb4e7be010d17be087607be1b57f7be6cb5b7be7b6d97be7f03c7bea78277bf30dc07bf89e0c7bfa66107bfaf1be7bfcbd687bfe356d7c00bfd17c00d5627c03897f7c047a3f7c0594687c115e077c1716ec7c1c1fca7c1d51ed7c1ebed57c1eedde7c1f97157c2549917c2846a37c29f1c57c2c75277c3195357c3203547c38161c7c3a7a967c3ae9ff7c3c1fad7c3d822f7c4bbdd17c4c0b327c4dc6ef7c4e56fd7c4f70ba7c4f73157c51a8e67c544b9f7c5977097c5c2cd27c6d75997c73c9647c77be5b7c7f487d7c7fdd807c85edbb7c8650f27c89c9427c8cc6257c8db68c7c8e41727c91069e7c94fc147c9759827ca465e67ca4ae807ca9c1f67caa26e77cb693c87cb7e0807cb9807f7cbe24617ccb1e6c7ccd14787ccd72437cd2527f7cdbabfc7cddb4947cdecfad7ce584577ce944de7cec51947cecb2d77ceeb1777cf4a4857cfab5627cfb7fa27cff986c7d01cc327d0303647d0baff77d108dd07d17987f7d1b2ae57d20b2f57d244cac7d2496b17d256a447d26d1f27d2c8b0e7d34e11b7d363bc07d36a3487d3778537d3a74ed7d3ebc677d40ca287d448f4f7d450a187d47b44f7d47e90c7d48f3077d491af27d5033cb7d50bbdd7d52fad67d556a4c7d56f7537d5807357d5833f27d5896247d59cd2b7d5a8e127d5fa4377d67ab117d6a892e7d6b109d7d74eb8a7d78c8867d7ac6647d7b8caf7d7c648a7d7f9e2e7d8450de7d84be867d8568627d88adcb7d8b02427d8d52c57d91f4a37d9913857d9ba0007d9ba1857d9d64017d9dded07da201b17da339f17da5429a7da9adbb7daab9227db3948b7db4999a7db7c9367db9b8837dbba0887dbcdeb07dc2dbd87dc7adaa7dce5f1a7dcfb8a77dd0aa577dd1b9f67dd9b8c67dda22c47dde62f47de1b0d57de1c4627de67e3d7dea8af47dede7a37df5e06b7df63f057df8c88c7dfbfdea7e0759727e07631a7e09d7e77e0c5c597e1137847e12f5717e132ba47e212e927e2417257e24931e7e24babf7e28e2a07e2a06597e2dc66c7e2f481c7e301d6b7e3514e07e3526067e364e047e40d7a87e4378e67e44d2e37e4692547e472d667e484a797e4859207e4dc95b7e4f8f117e53aaf27e566fc87e5b0bfd7e5bd1ea7e5d3b767e60ad907e6c63457e7e47587e7f27f77e7feaa47e8fcbdb7e9318e77e9647507e9e3a6a7ead02e77eb51fe47eb6a3927eb77a447eba50d17ebf9cad7ec1ef777ec51d917ec72b6e7ec7ceff7ecadeb07ecb4abb7ecbdc727ecd54c07ecf53ab7ed0ab967ed4d7467ed596d37ed681c87ee1c8f97ee736387eebbb397eec5fab7eecdfd67eee7eb17ef060257ef3ab1f7ef782ff7efad78f7eff10e67f028a187f068caf7f0ebb847f15947b7f18080f7f1b1ccf7f1b99fd7f215fbe7f2264c97f28aaaf7f297b897f2c52d67f2cd77b7f312ac27f31679e7f3603ad7f38a3df7f3ccf007f3eb1a77f3fcede7f41aeaf7f4370eb7f4958db7f49d4e57f4b27a77f4ed6dd7f4f0c057f528a567f56acf67f623f8a7f6398667f64fda57f66b2e97f675ded7f67fbed7f68b2677f6a18a77f6ec3f17f76fd4b7f7838ed7f787b517f7e4cfe7f7e7b557f88d1a07f88d3987f8c2d527f8e16fc7f902fa47f916b4d7f92d8b67f98013f7f992a237f99fb2f7f9c6a307fa328577fa6f0b77fad7a597faefe9a7fb1a9c77fb39aea7fb8c75f7fbcdb267fc596937fc60b997fc7a40d7fc997067fcb0af17fcbf00a7fcffb607fd0204e7fd123db7fd2ddb87fd3201a7fdc34057fe1ce7b7fe3e1c07fe542c37fe8a2657ff04b8e7ff63c427ff679157ff7de2b7ffd9a1a7ffee927800bf93c800cd355801140278011f8878015c7aa8016cb9f8017617f8019bcc2801c5186801dae008021a59a8022fe8a80253ad88029e33b802e0986802e48968036db4d803a85dc803df5eb803ee284803ef3d5803f12e480411c218042ffee8043b0f98051c2bc805274118057ef45805e998480600b6980611f5c8061303f806504498065175180652e35806aad058071d5d380725b598072c1bb80780bd2807a96be807e31458081f7f680844289808584be809b7eaa809c8433809cd2ab809f22d780a630c680adaea280af7fc080b0e62b80bdc6ac80be2ff180c1dbfb80c3c10180c5541180ccbb9580ce5e4f80d0ebc680d20c3f80da52df80dc109380e0034c80e473de80ef24f480f1b4ab80f3bbf280f4ae9380f63c5480f95a1781027a4e8103105781088fd0810b8176810bb430811588b18115c8bd811672fd811b70fe811f4321812288368123e81581265ce6812ce131812f3055813194b28134317c81378c288138a5af8138a713813b18c581401ea08143c7c48144380f8146e288814a25de81519d5b81580833815941cf815d93ac815de9528160fb578161fd11816209c8816fe0a9817266c38173e7f98177677f81844c288184635d8186be368186f20c818860d5818ad1eb8191b79a81921a4c8194abcd81976ba88198fb53819e27c781a2304481ac526381ac539081ade03b81af386b81b75bd781b8d76781c2a94081c7ec6a81c8838781cc6cd881cd358981cf32af81d683dd81d77c8781e0405381e0ed3181e51ec181e86ec681ea514281ece8d181ee25f881ee652781ee9c6881f0df2c81f5275581f8217e81f90bbc81f914c281f9b7c681fcb8c781ffd97e82020e4682039c6e8204a7e1820522b48205b129820a0b32820adb6e820bec91820cf4e182100ac88210b7678210e91082146732821aa3908220525182233869822402a4822528b48226db6d8227dd3b822fbe4382302cb982330d158234ce6e8235c67b82373bc4823c8ffe82413ad38243199e82437d01824ae025824dbc9e825467cf825648ea825dc25b8260111a8260155b8260ef528262612d8263ad08826623b3826b56c68273468b82770e1c827779f082816a7982851fe8828607ac82885eae82890b0b82892de0828b7a19828d36a48290b2688290e1a082914420829b8d2982a4faef82a6256182aae1fd82ab310c82ac28ee82ac9ddf82b3810082b6668182b9880f82b9d20d82baa63b82bb03b982c687db82c846ad82cb186782cbc79382d145c782d45ede82d554a982d9bcbb82da12c882e28fd082e32c8b82e4d5a582e61cba82e6b0fe82ebf89282edc51882ef62c382f8a6b682f8c07a82fab28982fc8d3982fd0ab18300fa5e830608468309286d830ac408830ae4b6830d071283155b3d831a67f4831daf31831f642c831fc8f783210ee7832c1c02832ff13c8336970f8337026d8339466d833c25b5833d648a8344736f8345f5c8834619ba834632688347a3df83498758834aaf70834ab909834c8972834e068f83555f59835b1370835bc54c835c4ef5835dc7b68362f98183643672836731578367dcb283692a96836f73c2836f9921837c67db837d0dea8381abcd8382a929838673fa8389f247838f1e0b8391da26839458b18394a0188398556183a92a3583aa413e83ac470683b020bc83b983e283c4aacd83c4e06c83c7571983c8ce9183c97e8683cc565683ce018e83cfe9b083d08bf583d0adce83d3def283d50fa583d6450f83da6de683db39ca83db900c83dedb5d83e5097383eb88b883fb550084039a018406401e8409ea87840dfeef841175ee84134bc18413d8408413e67a8413fe0584169d478418d151841a968c841a9f34841b56d1841cd132842361038427b1828429561d842b45d3842e9a28842ea4b98436cdcf8437777784378f098439c595843d8199843df3d4844208ec844389688450903a845097ae8454e0da8455494184591ad78460cb5b846630538468c155846a69858471cc7e84784c09847b52108481492c84826c0a848520768488193b84882cfa8489ddf1848aa73f848dd149848e10f484944f608494e2f08496565f8497a89a84994b87849c094d849e95a884a0c4d484a16dd884a2e19184a888a384ac4b9d84af6a3b84b380a784b588b284b65d1784b757a284bc08f384c188a384c24c1c84c3d58184c8656684ca0eac84cbc71184d61cdd84d8890b84d9d15084dd5dad84dfc10384e14ea984e3ffea84e7beb984e9871884f1b86284f4937c84f68d8c84fa0d0784fad33584fd27b784fd485684fe08f08503827c8505bbd3850b765c850e57048510c3fa8511e54c8514adf78515ee2985175fe78517f3c6851ef46f85228ce085239f728527bb2885296fd4852f61af8535d7a3853605fd85399f21853a9f52853bc852853c454c854ff7db85579e0a855f3fdf855f8ffe85659732856bca97856ed555856f3288856f8b7a8573bc468575e12f8578547b857e269585816d8a858908b2858c35dd858c90398598424385991141859c37d9859d00ef859ec882859f4a3585ac5a3f85ac64c585b136be85b27ed385b8b23485bab46585bb1daa85bfa8ca85c5589485c60ee985c7cb7585c9967485d41d5585d518ea85d7c49785d98b1d85dc51e585dc7e2e85de894985e146e685e700ac85eb228585ec06e585ed19d385f12c7285f27dd485f5111e85f91e3785f92cac85feb39585ff628386002c6586043062860861ec860bb4bb860d0f3a860fd88f8619c2d48625e9f68627162186279ad2862ae794862e3604862e7de5862ed816863329a38635bd408636750c86380542863aad85863f3219863f3498863f5ca68641a70f86424858864b0354864b04ea864cdec9864ed2448650bd8e86538f0c8654879986576a89865d215a865e3136865ec423865f2e7c8664d08f86685da1866c44e3867a7b62867c1438867db4e0867f046e867fc9498682df138683b83c868523cf868695738691c32986930394869944e5869a1351869b58d9869c09c286a0c81586a2fa5986a4001586a6563486a95a8786ad7cbb86ae13a486ae64aa86b3e6a386b4f76486bab9a786baf1e486bb397a86bd7b2486c712a286ce0a3186d1e6aa86d571f786d6819a86d81c2786dac83a86e12a9786e196ec86e5436986ea5e3286ed74af86f3696686f9ae5386fb57ff86fb73a786fe920786ff3a7d8707267d8708dcc1870e0ac9870eba29871010b6871886628719ba47871a524a8720ffa5872143c88723fc588725546f872a2929872f28af87321f448732b6508733a21c8737a6ce87383453873d1abe873d54b78742d7d587465bbb8747cb69874f15448754ee478756ea8287590c87875ceb8187612fef876149c0876c1fd2876d25e8876dbf0187701fae8770ecb987729497877335b087746545877587818776fd168776fe038778b20f877f74818783d9fe8787ecd58788df0a8790559c879102938796b3ec879d5d3387a3b66487a4457387a5f26687a6211d87aa0d5e87afb95187b05d0f87b0d84387b94fcf87bc96e387bd28dd87bec13987c00e0387c65dca87cb158f87cf306f87d10e7787d59dd387d6bc0187dbf47887dfbfea87e3d8ce87e5bffc87ecd75a87eefb8587ef72fb87ef7cc987f02b2f87f4dbb387f5ea808803aeae8807f99488099bab880bfc8a880dc12a881162ea8814799c8815f3df881b60698821210d88260917882a40d5883ad1f58840677c8843e97c8847e99b8849fe48885245bf8852dc47885509cf88564fb088569eb988596556885d73c388606884886193b388626b8b8862c8fb8865d0fd8869ff65886b0bb3886b766d886f63d1886f6792886fcc4c887231b888748bb788768c4f8876f2d78878e5af887dc2ce8883848c88840fba888857b58889023c888b8768888bbe5d888e9265889422bd889ab689889b01f2889d7f0988a2f70a88a4806f88a6ebdf88a7d80f88ac8e7088b119a088b237e488b3927e88bc1cdf88bcd94988bf331588cb3b0d88d0a16e88d14f8088d37d7f88d5baf188d5fd3f88d7865788d9322688d9b60a88da828c88dd2ff688deb98f88dfb32b88e17eb388e3338288e3690e88ea44f488ee6cce88f10e6288f7ffaf88f9278d88fc674588fe14a5890b6abc890c7d96890cd609891405d1891801c5891854118918d62c891b65c6891f6119891f9ed089219405892c5dfe893628b08937587189381b7189394ed8893acf53893e4fee893f36fc8942316f8943e49589489f8e894cb4a5894d3753894f73588958d4e9896194048962ee478963cc1f896405f1896474d5896525fb89684c72896854c88970bd428970e4b38977916a897b9b1e897bc5aa897f2f45898195cc89840ccb8985550089890a7789895838899295238994863b89968e7e8997d3258998efe189996567899dbb7389a34ff589a3836889a500cb89b1233389b1e25289b6a8a089be33ac89bf0d4689bf3e5189c1a31589cc335389cfcc9f89d0c8ad89d422a289d476e889da3e1389de570e89e07c6189e2a01389e8038b89e9939789ea317589f1a19a89f5bbaf89f81cf089fd3bbb89fdbb508a066dec8a07bb488a0fb9eb8a18de0c8a1a24d58a23dad78a2733ac8a34310f8a3504648a39d40a8a3cd1578a4339098a49d4608a4bceaf8a4ef5d58a5366de8a54d7778a5529658a5a8ab48a5e56868a6541808a6812948a69f6398a6acc968a7496788a78526b8a7ad5f08a7c6ad78a7ce2848a8313ee8a8439448a8884ad8a88d2248a88d2938a8a0dfa8a8bb59a8a8c8fc58a8cdacc8a8d3bcb8a8d9e988a8ea0a88a8ec5c88a8ee4f48a90af618a93e6cc8a97001c8a981cf68a98f7c38a9bf5538a9c13ad8a9cdfc68a9f08af8aa149d78aa572d68aa5d4ab8aa74b598aa846418aaaf2ed8aae0d108ab007d18ab7c9cf8abb70c98abde4de8ac2def18ac755a98ad0233f8ad0ee528ad1c7e88ad5804c8ad5c1ff8adfb6d48adfc4b48ae009388ae25fde8ae306f58ae3d66e8ae602c38af0b6328af316798af9b79f8af9e46a8afaf6678afd0fcc8b02229e8b07521d8b09aae08b139cb98b1429fc8b17928c8b1cfc278b1e2d738b1fdf468b2173cc8b291bf58b2b1d3a8b2ce2b08b2f74528b337deb8b39f5fc8b3a1ccc8b3a36cc8b3b56f28b3f29f28b3fe1078b4038ab8b4229198b42f6b78b4420848b46f5b48b47829b8b52b7328b5374f48b5fca0e8b6138f18b617be88b624f8c8b674e808b6874618b6b789e8b6ddecc8b6e17f78b6e810e8b7070528b72b4b88b7390938b7425b98b796ba88b79a4bc8b7ddf888b8425df8b8e756f8b8e965d8b8f2e468b8fdd108b9007f28b9a7fda8b9f867b8ba0ff2e8ba30b668ba3734d8bad85db8bb2607d8bb3fa688bb861d28bbbc4dc8bc1188b8bce9aaf8bd0feac8bd1c4578bd384c28bd45fbb8bd4cbf78bd50c978bd8cacb8bd917398bd91dc08bdde4bb8bdfe1de8be1ed338be2c28e8be673428be95ae18bea24978bec43f08bed833c8bee82298bf533ce8bf979b98bfa65288bfac15d8bfb9add8bfebc3b8c00ac508c03429f8c03e2fa8c066bc78c0a8e498c114b018c1467dc8c15970b8c18c0538c1c6ed88c1c8a9b8c2210a88c23b91d8c23c6db8c297f358c2e09278c2f96658c30c9958c3393fd8c36fa9d8c3e08d98c40b31d8c455e0f8c4895d58c499ef48c4e51ab8c5991148c5b9d158c5fb5a88c60c8418c6323db8c64b16f8c6638f38c68b1bc8c68e93a8c6dd60e8c6fa7f08c6fab1a8c7016b98c708eb18c778a1f8c7a85c78c7ab9fa8c7b11d18c821c688c84fd9b8c911bbb8c94ca7e8c9bcc8c8ca689778cac6df58cad2ada8cae58cf8cb31a088cb6cbf28cbf20228cbfb6978cc137c48cc286778cc28a678cc3219c8cc3d7308cc621528cc73f5c8ccb00c48cceeb348ccfc3928cd627888cd63dc08cd92a4b8cdb80fc8cdf18978ce57cf38cf195968cf3ac128cf56d8b8cf8e6008cfe8a028d0091128d00e5d78d0589798d076fc18d0e90da8d1226d68d1417118d1598e28d161d738d18cb978d1d3d828d1d86668d2411d08d250d598d29831e8d2a0a468d32a5ba8d35f2548d374c9a8d421f4a8d4287828d448fc78d484dfc8d491e0d8d4d8a788d4e1a288d539d8a8d53d9568d5480a68d54a35a8d56b6828d612d488d61b3e68d6528cd8d65bc9a8d6b63208d6d3ccf8d6e45e08d723b478d75b7868d7e1d5e8d7e601a8d86ff408d9144618d91694e8d9327b48d9507fc8d96b1888d985e848d9ab98c8d9d75f78da2a5cf8da567488da591c88da68dad8db0fee68db612bc8db6e0188dbce5738dbe988a8dbf5ba48dc3ae108dc4e62b8dc6d0e98dc9f8068dcb4f748dcc48c38dd1f9b08dd53ebf8dd605228dd8d5a18ddb24298de106eb8de36b798de7bf138de8ac968de97f0a8de9b07d8df090e48df3d05d8df743238df816b78dfbac2c8e0486798e091c2e8e0ce2288e0f557e8e0fae858e107e838e130a398e14652d8e19ea258e1c3d188e1e5dad8e1ed2a88e26ed958e27b1228e27b6098e28ef938e297d428e2e22b88e34ffbc8e381a3d8e3b2df18e3f697b8e4392f78e45a3f58e4c3ee28e5506a88e5623548e59b6388e5d2d1c8e5fa3028e637eae8e6504f28e66fc2e8e6747458e68790b8e6b24be8e6f64698e7040618e74199e8e7567578e8064118e81dc9b8e8577cd8e8aafe78e8bcbab8e8be4438e9385468e95f90c8e97ba8b8e9b10628e9fefff8ea14aa48ea2c71a8ea5102f8ea986598eabc5168eace2e98eaf88268eb62e4e8eb66d588ebd0d5b8ec169b48ec69c7d8ecb88eb8ecbf8f38ecc55398ecea5058ecfaf668ed3f8198ed5199a8ed5bf028ed726b88ed736488ed830228eda354e8edd2b768edd5f308ee275dd8ee34db08ee50e2b8ee5ba088ee6c8d48eec9d728efab9e38efbc0638f0128118f0a0ae88f11365f8f1b59e88f1d03a48f1ea5ea8f29e17a8f2c0c868f3131d78f367e788f4329798f43cd288f4481108f4aa5158f4e0cbf8f4e0d158f51a5e58f5bb9cb8f5dd6208f5f1f908f5f8d618f60076f8f6590208f7207468f721a658f7308988f7693d78f7acfd58f7d19de8f84567d8f8688058f8d33d08f919e878f95e0808f9682108f9817a98f99f1da8fa1de978fa7c70f8fa8d1978fa91eb48fabd9708facb54a8fadf6198faf2f308faf60b48fb119668fb27e108fb7240e8fc111858fc482068fc5885d8fc7ce258fcb5e2e8fccf79e8fd0475e8fd0c7a18fd2f1338fd3f98b8fd4f0a58fddfa3e8fe060f18fe2200d8fe2a7178fe35b0b8fe788068feb4ac28feb7f958feb8de18feddcb58fef17938ff0951f8ff334a68ff605e78ffb444b8ffcb7f59000424490011620900133fd9009eabb900c42cb900c75f4900cedd09011b7099014e03a901930d2901dc060902017769020424f90238f289027b770902a09189035aade9038923d903a6400903c9f75903cc6ca9040f0a69042daae90454189904567979045f6fc9046ee88904c7162905a87db905cf5fe905f9921906211d1906efedd90705e0290710db69071cc9a907285f390752a30907aafb69081fb1b908372c39091249a909446ad9097be8d9098de5c90a52f8a90ad51f990aff1a390b23a5c90b8c34c90c1ff4690c59b0890c6313790c9814690cbf83090cbfb1190cd5ddb90ce635790ce729690cebe3390cf483390d472ce90d9854090d9eafb90dcc07590df290b90e6621590e88fd390e9274290e9cfc790eac62c90ec043090efed9390f0fb3c90f26d1690f85f1b90f9f77990fb019e90fee5b090fef4e89102110d91085972910d2706910fe86391119ed69117cb2b91188312911bc677911f3e5191232ab7912bf295912fc27d9130f8da913134a7913aa80d9140886e9140a13991452b8b914574ce914bfaa1914c80f591525f8a915760b991592baa9159f9c2915ea5f2915f0322915feeba9161f13c916275a4916334719165532e91675b9e916b1fa1916cdf9e916ce695916edb36917097d19171e6d09174796a917a3748917eb6849180349e9181349991828f789184415091846fde91896627918dd127918e0a7b918e8e8c9195c7b39198e53b9199364a9199ddae919a84d4919d77c891a0dce091a1097f91a3d16a91a3dfca91aa5cfa91aaa66691ad759f91aec71791b203dc91b680a891b7504091c1858891c4922091c592e991c65a1691cb326f91d33e9591d5a56b91d7cb4a91da8dac91e1199d91e18beb91e31b3f91e5dbdd91e6264991ea248b91ece76791edb4ad91fc6c2891fd527291ffe9c8920039499200833a9200c8819202d86492061eda9206313c92068d9c9206af0c9208b12c920aac50920e5309920f1e2e9218b32892190bdc921ac855921edb79921ee9c2922016b39221ee1b9227ae10922a7efb922c0e95922c2b99922de9ce922ecee7922f516b9234471a92354bfa923660b89237b230923a3a5f923ccf5b92404b569240922d924266b292437bbd9244aa679248dd31924936e592499930924f8b9d9252f05492547da892569a74925d2d62925d4be7925f47b39260965f92609b4b9262a058926321519267c82a926a0326926b5c1792714b569274156492756287927add82927c85d09283477b9285221a92865ad8928710619289dbc3928bda9d928cfed2928ddc50928fa866929307a792962797929db05d929e2ca792a5ca9692ab803192ae64d992affb0e92b47e4f92b50d2292b6f39892b7c77e92b8688892bb443292bb7aae92c09e4792c1217f92c28aa792c87ceb92cc0b0192d069c792d4ea6b92d97ab092db9ea192dc23d092e0feea92e1e1e292ea243592ea537792f6509592f92b5d92fc96c293022bb793039dc29303b30993093207930d366e930d8d3b930fed9e93109a4693178ffd931958cc931efa66931fa7f3931fbf0f9323889f932410a69326d3449328b67d932a6f29932b33cf932db7e2932e5f21932f1aa69333ef3d933433ca933cf20f934019309341613a9343f2cd9348f464934b952d934bde0f934d2fa1935898bb935a018893668d909368e0ac9372b1099374df89937547c693762c389377a220937cbb46937f5eea9386abad9387446a938c47379390ef37939122d693922f639392f50693977de393989706939ae2b5939b9d7f939cc8fc939decc4939e5a3a93a2103b93a3728c93a3b80a93a5ae6793a7470593a7ed5f93a8858e93aaf6cc93b5dd3f93b6506393b69fdb93b930fe93bab1de93c64ab093d1a26293d574ec93d8c09f93d9490f93dc182193dce5e993dd312b93e2257a93e6e37a93e9531f93eec3f093f3fdfa93fb010e93fcddc194034cc494072ae994079814940ad896940c2a28941255df94126428941755b8941b7987941dfb9d94206c2e94233f3194285783942c36469430f039943658ea943677d7943cfb5d943dc18e9443235a9443ebcd94461132944c6550944cc2a89458bf3c945a0bcb945b00cf945b38a9945d7ca6945de9d9945fd039946515439465fce79472879094730a069475edb194765e499478e3b0947b3fe8947d1c4e94812da39481da1a9484d60d948754d694891b0b948d59809497973e949d76bf949eeee694a5758394a6aa5d94adf52b94b797f194be9a7b94bf44b394c2378594c4d0bd94c5170994c68fd394c8f09c94c96b9d94ce237c94ce518d94d09ac794d41dd994d842e794d878d594daa2cd94dd463494dedd4494deeaa994e044ae94e0ee4994e40b9794e6e3bc94ea141494ed0b8894ee446194ee497294f1240194f1963894f2237694f5c75794fc14c694fca21d94fccdb49503c2ec95062050950842499513ff0b9515ead39518c922951ce14f9530adb29534f7539535e89395362b949536962a9536d1b2953739fd953a3d4a953acb3c953b21e0953b7d68954178c1954288c49542ec0f9543f40195484220955082b495591a8c955dfa2a956ccc84956e2b9b95710b1d957317da9573d9d39573e8c49578175795826bef958463de95878254958881dc9588dc459589cb29958a3dc2958d5209958e4b12958fd33d9592f1ea9593ab659595e88a959f2bac95a162a295a44b8e95a6870995a6f04995a7ab6e95a905ac95a9aafa95aa051195ada7c695ae24c395afc04f95b14fa895b4abb195b5118c95b74b0995bb2a6595bc783e95bfe3a195c5433495c7ba5495c94b4395cee29695d0311495d26cb095d2980295d3f4c595d4145c95d4309995d58eaa95d7691d95dbc30e95dd4c4395dd7f8c95e220f795e654a895f046b795f1d3a795f54ccd95f76f2595fd7e2295fdbab39605167f9607880a9607b504960870939608db7c9609c34f960b0f50960cef8e96100cfd9613b308961484559614a53d96171c299619f218961c314e9625a55c9626891f9629ec32962f38ee962ff8969631161096316f729640307296448715964517ee964693b696501334965087179657e59a965ccbf09664433696663baf966bc696966d9340966fd7bf9674a7b79677bcca967cf33b967de1fa967f2d4796854b0d9687a27596884739968a70fd968d2a13968fdec99699bc07969ac410969fa85c96a2325696a2b14a96a40fcd96a430dd96aa466b96ab1f4d96acb11096aff37996b5330196bf4f2896c121ee96ceaeb196d01f5396d2444596e6694096e86d3b96eb4f2996f3d4af96f4b34896f8b7f596fa429296fa738696fe04d697013c8797018f2c9705a6c197091988970f3f4b97149c669715395b9718fde397196803971ca31c9720552097211cc4972157a39721588a97246d11972478d39724a1b59728485f972b1273973420d29739d3f3973bf8d4973cd71d973d95d3974196409743e8d99748123c9749010e974c4bf1974cfb7f9753da7a975add69975b7e1a975dc08a97605b149762a0b197637a90976c7d2c976f93c09774df849775afd3977761bb9778ae04977b05dc977c87cc977e8f0d977f1edd977f8e6e9783433c9785646b978725e69787d420978a674a978ff2199790b7399794e151979a8c8f979adf0e97a018df97a4537497a5330497b3cc1797b4626397b5f9af97ba4fbf97bd7eb797beb86b97c0018197c16a0097c234ae97c4590c97c63a7197c973dd97cbb53d97d06b9997d0973297d2bac197d2c90297d56b8197d62b3c97dab14397deb2c197e027e397e3b34997e408bd97e95acb97ea1ef597ed219d97ef538397f8dbd897fd890d97fe950198005158980b7c2c981259a998130b389814b5ad9814be9d981975449819b762981a7010981d7452981fe50f98253d999828a6da9828b75a9829f412982f347698301e9398322cc19834443f984260069844a7bc984513ed9853f4cb985534f39858162e985d08a89862476598649c7f9864cf7a98653b6e9867fbac986a2c78986ac817986b32649872d8779874b8d698780fc7987cb70e987f06999881530a988471c898861c44988ad5f7988d58fd9892f534989402bf9894daa498985f679899a1c5989dfd1598a0d20098a21b9b98a6d8f498a9dc5998af80f698b207e998b28fdd98b4ad2898b6a50b98b76f6898bbfafe98bd420998be1cf298bf42c998c2f36098c31e8098c3cfd498caaeb998cde9b198ce857d98d29fc898d3f26598d7498698d900a598dea7d798def25198e309cc98eefe0598ef8e0398f0d0d898f10a499900ece499015fb199037c699903fc419904a23c99068167990b3e78990cf1ff990d279f99192dd79919ee4d992073899921a8a999240233992479b79925d57c99278d20992dad05992ff19699361fea9936716d993dd31f993e4e389943a99a9944c1a59948cc15994a6f83994fca6099501e0199516b219956baa6995a45a5995c223c99632a869966169d996898a8996f76a1996f9699997034c499707d9b9971567e99732a2399735b33997cb92d997e3f78997fed4099825db59982699299827d349983e4119986a6239986aa83998716b8998cea22998d0c469993839799944b31999baed7999f0cd1999f2b8b99a1578599a5c9c399adbac199b3976899bc781599c1cbd399c9d09799cedcec99d0995399d1a25c99d6703799d94ddc99e0719099e0c80e99e1a95899e4689199e8b5f099eedee099efe0e599f08ff399f23e1699f3fc5d99fd650199fdc80399fe37e39a00cc089a01ab549a0d5aaf9a1208ba9a131d909a13e9259a140e8d9a14dd8b9a1790869a1bf0549a1cc51f9a1db2579a25a1099a28f1939a2c19b49a2d8be09a3080ac9a31ea519a3294e79a3337ac9a3399329a379b929a3b3d049a3d14c89a3d6f279a4448fa9a4b00459a4fb5409a5031849a52c0c79a5df4659a61eef69a6b56739a6d72c39a6ee4bf9a7559d29a7b4a0c9a7dc4ad9a8133db9a8137579a8206b99a829c399a87afb99a910d5f9a915c9d9a9232fc9a9245d89a9aef469a9c2c389a9da89e9aa0ee779aa1daf79aa419e09aa4c0399aa68df89aa977899aaa9c2c9aafb7e69ab1a1539ab4043a9ab761249ab916a79abb4e1d9ac02ef69ae353aa9ae3aca99ae633639ae7aaef9aeaa3159aec0c2e9aee4abb9af0eeaf9af1222d9af1abcd9afb45d59afd672d9afea3ea9afef4db9b01da7d9b040d1f9b0859d39b09e1269b0a1f569b0a6ace9b0b2f809b0bc9439b0e86359b1508a69b150fcb9b1576839b1881a09b1912d59b1a53ba9b216f459b22a34f9b22ee239b25736b9b2c410c9b2d30969b2ef3819b3213069b372f459b3788bf9b39dcb99b3ba5239b4068349b4823c89b4bdf3b9b4e51d99b532b589b57dab59b59f6a89b5ca7c09b5caeb39b5eedc99b5f43fd9b5f584d9b6298e09b64c50e9b6ad8679b732b8a9b75cbf49b7840139b79a10d9b7b2e5e9b7cf5659b7f497d9b7f75439b80c82e9b8197369b865a1a9b8836929b88704a9b88d4ec9b8a3c069b8b20e59b8b26289b8fc7fb9b8fd7bf9b94f1d09b9a0be09ba2a6e29ba2c1549bb107c99bb171ea9bb44e6e9bb527e19bb550b39bbc52ec9bbd42359bbd4f529bbf3c349bc2ea939bce35539bd572769bd6d97d9bd81a169bdd42b49bde76da9bdff9f49be2d8609be37b449be732279be7a3c69bed18069bf0df2f9bf1b8229bf53f8f9bf7121a9bfdfb629c00574c9c005f519c00731e9c0273739c0557019c07890a9c0802379c15ff0d9c17b3db9c17da309c17dad39c1b21fa9c1e8acc9c1f35189c20c9a69c2583899c25c1269c289d869c33a3b69c391c3e9c3bda269c411cae9c4453bc9c4a00c59c4a6e1d9c4baad99c5506c49c5a6e279c5a91e69c603a539c61ea659c651b1a9c7037299c71e7d09c7498d79c75e91f9c7a63289c8073419c83f70f9c8d5a629c8f50809c905e329c91187f9c943b929c948fb19c9bb5479c9e96059c9f977f9c9fa2709c9fedd39ca1ee829ca364d09ca4d4b69ca53ec29ca9faa39cb239589cb491219cb7b4239cbedbb29cc1ccd49cc4c18f9cc5e8249ccba7539ccbbf5c9cceb4939cd139999cd32cfb9cd59d319cd6ac089cd9bd9a9cdaa8269cde84389ce04f439ce47e099ce5e1169ce63a9f9ce69c4d9ce9f5049cebe23e9cfd414e9d034eb49d04f8169d0587879d07096e9d0851a99d0d519d9d140fe09d1578bc9d16c9569d1cc9c89d1f3aec9d206adb9d2530779d267ba49d28f85d9d291ab59d2ac3e79d33ff4d9d36b5629d3ac1e99d3cfe1a9d3f6b189d4163859d486fd09d4af41f9d5017599d581dfc9d591ef89d5a19889d5d7a209d5ddec09d6991e99d69e9ce9d6a20d59d6f63f49d747fef9d795dce9d7a1ce29d7f30029d8e845a9d988cb39d9cdcd39da539289da791af9dabb39e9dabba709db144de9db62c049dbbb30b9dbe08939dc2cb719dc6560a9dc6d5689dc913a09dcd464c9dd391b39dd926df9ddb49b59de180869de592b89de6afe39de795bd9df27c349e0035f29e03a6a29e048e9e9e0589f59e0b48c09e0cc9c79e0d368e9e1013989e15daf79e18fd7e9e1cb3899e1d92c89e2023169e20d6d49e25b3f49e2820929e2df25b9e31d1cd9e392f5b9e3a3fad9e3c0c129e3e5fda9e3ffc1c9e45700c9e4749d69e4984689e4cd2c09e4e63f99e4ec2f29e5655ee9e58662b9e5fe2669e670f519e6d19869e6dfe469e73909d9e75dd859e7753949e7c923c9e7ebfe19e828aad9e8685f59e87afc99e88c4759e8a032e9e8e19ba9e91632b9e91f68e9e92abaa9e92fbd39e97fe209e99f86b9e9b79529ea0ad909ea41ea79eaac52c9eae1c199eb2461d9eb3728a9eb3f0189eb4b9a49eb5820f9ec3b2d89ec471629ec6766f9ecd78c19ed1780f9ed445909ed460819ed5e4e09ed9da209ee375cc9ee5c1209ee7c43e9ee9351f9ee97fa09ef086939ef3f99e9ef7a77d9efbdaae9efed77f9f0033509f00895c9f019e4a9f0fd2c19f140f689f14c45a9f1624569f165a819f1693649f1842da9f18b91b9f1ba00d9f1e68ee9f27987b9f2e28849f2e7fb29f3348e49f3784c59f3bdbd59f41e10a9f444d949f4727599f481de89f492d6b9f4d6ba19f4e71ee9f504d4a9f51718d9f5a70469f5d694a9f5d9b969f61b5999f665ffc9f670f259f67b6a39f6ba1559f6e3ff29f70fdeb9f71c8a09f74ec7d9f75567e9f76b8dd9f7969bb9f7a89bd9f7b77929f85e7469f8689319f8dc7e59f9519929f9ae6879fa298bb9fa53f7b9fa6c2509faa34d19fac18df9fb154ba9fb1fc5b9fb23d719fb2d65b9fb7e83d9fbbf93d9fc0e65a9fc280da9fc79a989fcdb1b59fcec7e49fcef8359fd78e6e9fd80dd09fd8bc3d9fe3d1f39ff1663d9ff679e29ffb0e5c9ffbdc0e9ffd4ee89ffea3f3a0040103a004a588a0061df3a0069eb6a006c14aa00d2803a01363b9a017fa42a022c78ca025c70ea025fc7ea0281168a02cd762a02e0a38a02f4e8ea03189eba0350286a0359314a0391fd0a03f0e8ca040fdeaa041e1e6a047b47da04936cfa04fb9cfa053733aa05569eaa0569acfa0578c06a05832a0a059fb8fa05edf79a064e739a065650da0685b3ba06c57aca06e2c06a0724198a0733df3a07542f9a0764703a077df78a079c2cca07ea188a0819c85a0905b5da0919f3ba0945b27a096aaf3a09d936ea09e9ed6a0a17a66a0a191efa0a40ff6a0a6aae1a0a7b27ea0a7d718a0aeeccfa0b6e867a0b71d3fa0b7cb84a0b8104ea0c67214a0c6f440a0c7fbf3a0cc8fd3a0d293dea0d51adfa0da3e2ca0dc7263a0dce75da0dfbe4ba0dff283a0e2ee17a0e3295ba0e54a9da0e64cbca0f0f2baa0f8874da0fb7d9ea0fd6322a0fdda61a0fe3dd8a1006257a102dc2ca1041e98a10482c2a105fdbfa10bf70ea1131d3aa125f11da129562ba1299beaa1300b5ea13406aba1346c43a143933fa147907fa149c656a14c4dc0a14cc578a1501cf4a1528700a15a5e70a15aff25a15d69b5a1602e74a16085b0a171443ba17313e3a17386d2a175567ca1803920a180664fa18a2a7da18b9cd9a18dc1efa18ef403a191b31aa1926ccaa1927534a196040da1971fd6a199938ba199ba14a19f0b7ba1a15542a1a21448a1a2ca6aa1a8e0c7a1a90927a1acbd36a1ae8bc4a1b0f633a1b49680a1b81314a1ba93d4a1bded70a1bef7c1a1c0aae3a1c3fbd4a1c421c8a1c48087a1d3d33da1d5a6d5a1d7f36ca1d96952a1d984fba1da8274a1dae12ca1dc6c28a1de9705a1e3612ea1e3e99fa1e9ab9aa1ea7d09a1ef7f08a1f17865a1f194b2a1f698f6a1fe86dba1feb964a1ffd983a201c84aa2035359a20832c8a208d3daa20ad7f0a20cd8a4a20d9508a2145056a215d5e9a217cf0aa2187d79a218c69aa21a1c91a227c765a23cc443a245d47da24a22b4a24b533ca24bbfaaa24dde06a24e6d4ca24f6396a24f6b96a252fde1a254d7fda255a672a258fb87a25a0bbba25e9b83a25fb12ca2625cd2a2661b9da26a29bfa26c571aa26cb530a2788346a27da881a27f13c9a281ce3fa28aa730a28eba25a293f8c6a29a0dc8a29a669ea29f96d9a2a1939aa2a33c18a2a5c766a2aa34e0a2aacad8a2add78ba2b2fa39a2b49356a2bd7b6fa2bec425a2c24159a2c2af3aa2c2d135a2c476c0a2c7b2b5a2cbac2ba2cdfaaca2d0656aa2d0b312a2d0e0a1a2d14380a2d6d5a0a2d7c10ba2da3711a2e2f83fa2e61bb6a2e67a2aa2ea6ef3a2ef76b6a2f8dbd2a2fb1638a2fce5f1a2fe5944a305aae3a3076292a308c7dea30a5e82a30ccec6a31fabafa32941ada32a6e4ca32d6c8ba3348aa9a3364a08a338f210a339b2a8a33b2c17a33f3f36a33f523ca3405e39a3448361a3493965a34c20dba34c5827a34ee2f6a34f14cfa35022d3a356608fa357ec1ca3599e3ca35a19aea35d1ffea362e8e9a3630e9ca366a7afa3679d70a367f9cfa368cf73a36917d1a36b585da36f4ba9a37554a2a3778422a380b712a3825128a385f3eaa38d806fa3963feea39b6e4fa39ef1f5a3acafaba3aefad5a3b09d71a3b21502a3b8e189a3bcae4ba3c2782ba3c2ed4ba3c343d5a3c5e36fa3c85f0fa3cf2600a3cff0eca3d23e8ea3d3c3d9a3d62360a3d6c455a3d8569aa3d92be5a3dcdaeea3df77aaa3e29212a3e62bc2a3e6c8f0a3e7aacca3e865a6a3ef00daa3f03035a3f18edba3f212b9a3f81065a3f8a5dda3fbdfaba3fd968da4129b63a41332a1a41e987ea41ed5e8a41f91c5a426b7bca4275f09a428db1aa428eb9ba4303a49a4332546a435b5a9a4378807a447d686a448f578a4494e2ca4500fd2a454bfd2a45b4ee6a45b4f39a45faa49a46090f2a4613d3ba4664bbfa46976cfa46f48bea476198aa4786d2ba47f19f8a481eda9a4836a12a483c810a483f550a484ea94a48d7218a48d77c5a48eb893a48ee121a492796fa4959b52a4974f5fa4994442a4aadc69a4ab3dd1a4abcf72a4ac7f2aa4b0e014a4b4ca53a4b62c71a4b762dda4b7ff55a4bd3ba8a4c02986a4c1a6d2a4c2dde9a4c5e7d8a4c5f933a4c896c6a4d2b99ba4d2d964a4d4a474a4d4b64da4d709f2a4d84c64a4de62d4a4e10654a4e2ce1da4e39578a4e5828aa4e7042ea4e794e2a4eb29aaa4eda84ea4edb493a4f15cdfa4f17306a4f19238a4f1b956a4f5ba0fa4fb07f1a4fd2c74a501b0c0a501f459a503cf99a5072b51a5077949a50964fea50d567aa50e76a2a50f1e19a5117e39a5131b6aa513651ca513ad5ca514c469a514d7aea5160e81a5179aa9a521fe65a525cc23a5277134a527d6aba528e208a52a6f4ea52d85ada52fa77ea52fbde2a53157cfa53159a5a531638aa5336d3ba534374ca5351c7ba53581d7a5380a41a53dab02a5405782a54057eea5425d64a542db54a543fe94a545122da54c0156a54c7b65a55302f4a5569e1fa5585290a5595bfca5599a1ca55a62b6a561eb76a562259ea5635fb6a564aae6a5678da9a5682408a5688f71a56e6973a571acc9a572523da577cd66a579880fa57c9c61a57eec7aa57fe914a5804aefa583800ca583b50ba58549eda587c2f9a58a0f9aa58a2110a58b262ea58f2353a58fd5e1a5907fa6a5921c10a59a7553a5ab6745a5b18316a5b37cc2a5b7b8b2a5b85fd8a5b86866a5ba8cd4a5c01d22a5c09087a5c1c7e4a5c23183a5c3b3c4a5c71243a5c8b411a5cd47bba5d472d1a5d89e59a5d9944ca5dde822a5e0e29ba5e43bf2a5e8a9b6a5f44cb5a5f59c60a5fd53aaa6031e7ea60ed50ea6121396a6164a29a61a5c96a61f7673a62046e6a6213fdba6226ec0a622e591a62ac8f7a62e8259a63165e9a63654f9a636938da637be9ea638bec6a63d82f4a64188a5a64d2f80a64d9045a651ee6aa653567aa655b1a9a6566753a658387fa659fbb9a6632e78a6648035a6695ff6a66a14a0a66e50d0a6749ba6a67c49a5a67e1ff6a6868831a68a2bdda68e209fa68f443aa693659fa69445aba6947807a695329fa69ae54ea6a3111da6a4eeeba6a5ffefa6b13ebea6b2a000a6b2c504a6b648ada6b716d5a6ba04c3a6be4250a6c5530ca6c6e0eba6c7f4ada6ca1bf7a6ca78d4a6cb7e5ca6cd3fdea6d1bd32a6d23e09a6d34d4da6d3569fa6d6b68aa6d9a875a6e375dca6e63e09a6e83549a6e95edba6f00b14a6f18ecda6f4aa00a6f995d4a6fa5822a703d3baa709dd47a70dfddda7101ab0a712c5e0a714202fa714aff9a7154392a7172095a71caee9a72264e5a72326cea7261f73a72cd32ea72d0464a72f366da731563ea732aa4ca7342384a734f523a73688bfa736fa30a73784f0a737dbbda739c68fa73c3c47a741a500a7447d54a7457fd3a74612aaa7479980a7499722a749d35da74ae0e9a74b4feda74ea6b7a74ffb74a752c009a7549e39a7554023a755528da75ec4bda7612084a7648541a764cdeca7661411a7676830a76bb2a7a771ad61a7739434a7759e51a775eeaca77d1d77a780739ca780a16da782e704a786bf22a7886f14a7915114a7952fa4a7965ac0a79a40dea79c266aa7a14ad6a7a2d064a7a48c64a7a4e21ca7a6778fa7a845dea7a9c36ca7a9cc10a7ab3c86a7ab4cc5a7b016f3a7b045d9a7b0ea0ea7b23b7fa7b593daa7b6b190a7b7b2c2a7bcbe92a7be3762a7c00f67a7c094c6a7c0a77ea7c0c2f8a7c2f492a7c907c5a7ca5124a7d22313a7d64ffaa7d8a855a7dba046a7e14473a7e3b21fa7e3bfa5a7e583d4a7eae518a7ebaab2a7ec1d73a7edd9baa7f1042da7f3799da7f50782a7fc5ffaa7fe445fa806a871a80cd2eda8106a72a81454f0a8194c68a82ce14ca82f36fca82ff342a8307889a8313678a8349945a83a2383a83d20bda8433e69a84a5acfa84e87c2a84ea6e7a8501f8ca8514c5da858a718a85ba74aa85d730ba85dcb77a85f7c3fa863c3e1a865b185a8690543a86d8e2fa873a246a877f733a87b0ae5a87eb37ea87f66a5a889c116a88ab5eea88f0385a8956be7a895b6eaa8963ab1a89c2510a8aec88aa8af755da8b2f4f2a8bd66f8a8c5551fa8c5944da8cb03efa8ccb985a8ccdb34a8d3d479a8d40075a8d59f13a8d69351a8d9aa85a8eacfa5a8eb12d1a8ee9301a8f2e3fba8f98a01a8f9fa72a902a735a903a867a90632c2a907d3b4a90afc8aa90f0ad4a90f98aba90fdfbda9114d57a9147b86a914cb58a9168a06a9193eefa919be9da91a6a76a91b825da921775ea92c4af6a92e8ea8a92f2c73a931660da936ce04a938f841a93a2303a93a7092a94249a5a947c3ada948d8e4a94a5323a94d2033a952dc30a9542980a9554154a9569182a956dec1a95a8b6fa95bb2d9a962f8c2a966705ea966c132a96b725fa9709fd6a9781747a97933afa97a2fbea983e28ba984559da987a048a9929c27a9980037a99803bca99a8e5aa9a2ebeaa9a353c8a9a7a7d1a9acdd47a9b0dc65a9b48966a9b8e262a9bb82cfa9bcc80ba9c018c4a9c06085a9c06997a9c09826a9c2bf6da9c3edd4a9c65150a9c95be4a9c9990ea9ca6932a9d05447a9d23e05a9d5123ba9d68fcca9d838efa9d9b9e4a9dd0679a9de38c6a9df0074a9dfcc65a9e0fe2ba9e20219a9e39692a9e72cc4a9e9e52ea9eaf6efaa0302f7aa050c44aa09cee0aa0e6eb1aa136f27aa174134aa178989aa1bb843aa20da75aa233ec9aa2525b4aa256584aa25eddcaa26358daa283fd2aa2fbe55aa303049aa308982aa30c514aa312a0caa32169daa33a2f3aa358e0caa3792aaaa3aa3ddaa3d3281aa3e29d1aa3fd794aa43bca1aa44b96aaa461ba4aa4e4cbfaa4f8c3baa530dfaaa5b6c8daa5ca95faa6452daaa67ca34aa705846aa75411daa7af0bdaa7ca631aa7cac03aa7eef35aa826bdeaa829fb3aa84f10baa8671aeaa8d6beaaa90da16aa9333c8aa93f705aa9c52beaaa1dd3faaa54e80aaa8b799aaa98332aab73e34aab750efaab983f7aabd7ec5aac16bebaac4642daac59983aac67701aac95864aaccbdceaacdc211aacf2ab1aad2c1feaad46cb7aadf5f83aae156f4aae7a9e8aae7b870aaee27e1aaf0e95daafea2b1ab029b66ab02cb38ab079b77ab07a345ab0eeb11ab127c54ab18b332ab19b7d6ab19ba88ab1a6262ab1d58bfab1eda9eab2003f8ab20b48fab22a261ab24547cab262d36ab2af355ab2aff38ab310422ab33667fab34700bab3489c2ab34bb15ab3683d3ab36a0fcab37b19eab38e06cab38fdbeab397a34ab432291ab432805ab451550ab452d6fab4a59e3ab4af0fdab5354d6ab536179ab56d393ab57b313ab588c3bab5bd819ab5e01c7ab5e6a83ab602556ab631eb4ab6b5a0bab6c40f6ab7071bfab7c18b1ab7d7c4aab7e2175ab828384ab85af25ab86ec28ab874f27ab9a1d95ab9a6a6fab9b8d02ab9be03bab9cff4aab9e414caba0b625aba3273baba4cd13aba62116aba96ef7abaa9bd0abaab700abadd2e6abaf7003abb27891abb3dcbbabb95b02abc1b31aabc2f651abc3d889abc81d5aabc88a97abcbad6aabcc9638abd00ee6abd1a0bbabd53a7dabd5b269abd6c455abd7a3cdabd8c767abdd630cabe9017cabeadbb1abeb139aabedbaa7abf08e08abf31f31abfb562eac01a97aac0227faac0337beac038a6aac03f51eac0516b0ac0a4c3bac0c4991ac0e6aa5ac12f9a0ac143d1eac19ae17ac1a2024ac1bbcf9ac1eaee1ac22705fac233bc6ac26c784ac26daadac27ea4eac2acdabac2c9053ac2d9a2bac2e0dbdac378733ac393418ac3ec3cfac420889ac459704ac4764ffac4e9146ac54a86eac56897bac57282eac5e4f00ac6614e2ac67581aac6bc768ac6c2d4bac6e00aaac748134ac7635eaac79e12eac82d4e5ac84c985ac86ac4eac8827f5ac8ac207ac8b36b5ac8d132bac948deeac94a8cdac95dae4ac960c71ac9749cbac983a95ac9a474caca0aea5aca2865faca4f6d7aca6cce4aca92185aca9c8e8acabb143acacf4b7acb3d94eacb452baacc17fd6acc55a98acc65748acc66d90acc70728acc93e5caccd2d2eacd3050eace030d5ace20368ace21ccdace2538caced6bc5aced9489acf267b7acf2c7f9acf39280acf9dd90acfb0e4eacfbfa78acfe0c1dad015416ad02a3f3ad02c71fad0341f8ad065872ad0c0beead0d047dad0e5e46ad11f9acad12b86cad14b982ad163a75ad176886ad1ce116ad1da140ad1e8d1dad208652ad226578ad2ca533ad2d1a78ad2d74d7ad36c823ad381048ad3aed01ad3dd0efad448e85ad526373ad53b3daad545829ad581c6aad5a78d3ad63b586ad668c53ad69cd31ad6c213cad76f42aad7742d9ad7a7575ad7cfce8ad803ac3ad83d22ead84bf9ead853d9fad8a2dcaad8ce7c1ad9333ecad96b82aad9ebcc8ad9f53dcada0c6d0ada1c17fada2f579ada438c9adae9f4eadafaa10adb518eeadb5ae56adb6e6ddadbc1502adc40c8dadc68d1cadc6d253add00cb0add22f4eade259a3ade26225ade2b153adea2e74adeac0b8adec425cadf2c3b5adf304d0adf81cdbadf81d22adfca870ae00baa8ae010ef9ae03ea38ae04c4b0ae062453ae0c96fcae12c504ae148fbcae1915c7ae1a2f54ae1c5f83ae25150aae2550deae2c877cae2f4a9cae32a938ae33854bae3d2711ae44c03bae4747cdae49b2a5ae49d46cae4c7085ae521b41ae57340fae59e0ffae5b0d59ae5cb271ae5d11ceae605860ae622ec7ae6469d9ae6b0ac2ae6dcafaae6e42f5ae6fe3a9ae759448ae7667efae776156ae776fb1ae7b7969ae821e8dae8488c1ae8e5babae926e42ae95423cae9b7294ae9b89d6ae9e5c4aaea53a78aeb1e2cdaeb5816faeb7d8eeaeb97a23aeb993d0aebb17b7aec330b2aec61c55aecb547baecd0ec2aece06c7aece6ed4aed2dd56aed3b035aed795a5aed7faa3aeddd3f8aee03a18aee2a73aaee47f5daee670a1aeebbac6aeee9bdeaef11bd5aef460aaaefa4830aefaf3e0aefba251aefc078aaf0133d1af042aebaf07171baf08f307af0f50e6af128a26af17a8a2af2425d0af24e242af25c5d1af28b0c6af34acecaf412b7eaf43256daf456e06af4c558faf4dd776af507c34af58fbb0af5ad371af5d568eaf5e3aa3af6542bcaf66e72faf68ebfaaf71eb2caf729abbaf7469ebaf7cec22af85d070af8c315faf8e6905af93d753af948f98af949e42af95a99aaf96a298af9aee14af9e7a91af9ea234afa2a7b4afa81bf9afa87f38afb3c4fbafb4e8e9afb4f115afb9cc25afbb42a9afbbe283afc2dcf7afc40f34afc4a493afc53a45afc69c1bafc6f2ffafd0eb59afd4b8b8afd5a102afd67d99afd7e198afd942e0afdc3b51afe0a597afe0bc29afe2c6dbafe3744aafe72afaafe89815afe9d74aafeb8a0aafed1058aff1f53daff26501aff8700caffac33baffce27faffdc1a8afff2897b006e573b00a23d7b00b7bcdb01013d3b0115615b011d601b0145fefb015c455b016dcf9b01945adb01cad45b01ef03ab0204d8cb0232941b023d6f1b0245310b02886bbb03630b3b03f0cdfb03f1617b048cac1b0493195b04db4a2b04f30dbb051c330b0568260b058a421b05c8a59b060d151b06106cbb061876fb064347bb064c103b0691af2b06e310db074086db0745fb5b082b17eb088bdb8b08a14c4b08a2f65b08d8c98b08e6323b08f52b9b095afd2b099f392b09c08c7b09d0a9eb09d977bb0a3570fb0a3e448b0acd56bb0b0a40bb0b8ac78b0bc320bb0c0bfd3b0c60cacb0cf51d0b0d20920b0dbb802b0ddf567b0e4d446b0e4de25b0e65c69b0e7f938b0edae76b0f08332b0f21ee6b0f53c94b0f6e013b0f72ba4b0f9c685b0f9c7dab100c109b104ca57b105964eb1077f0eb107b5eab10994c4b10b0926b10d0aadb10d473cb10e667fb116d288b11a60b2b120471fb12b33c6b12bf800b12e59d7b13838c5b138c17db1426ff6b14353f3b1436085b14d1f7fb14e5ffeb15052d6b15138e1b155b09cb157e590b15b0c10b160f17cb1641e55b1667aceb1692519b16a0cb9b1730c5ab1778774b179426cb17bf00db17d3036b186e659b19005ebb190cd32b19824d1b19b95abb19eb4ccb1a00dabb1a05923b1a3d456b1b0afa5b1b2571fb1b7c6f3b1b97e55b1bb46c0b1bc06ecb1bd1d39b1bec15bb1c5554db1c77219b1c8699db1c9c7bbb1ca6549b1d01a74b1d0cd1ab1d176f1b1d74140b1db443eb1db909bb1df9842b1e029d5b1e651f8b1e71827b1e9290cb1ec120cb1f10f10b1f1f7c2b1f36c75b1f9fdb8b1fc2685b1fd7877b200f5c6b204be34b207b40fb212f8a1b2133217b215b839b216f81eb21b5424b21e967ab2237691b22dbbeab22dca8db23183d2b233c306b2358dc0b23da6bbb23eea45b241956eb2433b76b2444cc3b246b00eb24ead4db251ad6cb2542b80b2590f3ab25a9886b25b88cab25bbfb8b25e42c1b25f0549b260832bb266b7c8b26ede8eb2703df8b2708adbb27870e5b27f46f8b281a9f9b2837905b28c95c9b28f0bdfb29bef82b29e4b6fb29f3e5ab2a483f4b2a8259db2abc5a3b2b5496bb2bb8648b2bcd32ab2c32059b2c71b9ab2c73fe9b2c7c938b2c89a56b2ccc2dfb2d3c576b2d408a1b2d78efbb2d9bc5eb2e36bfdb2eb4e43b2efafebb2f0a7a7b2f773aab302039eb30c75b4b30cdc16b30f7ba0b3149049b314d213b3161ebbb316b45bb3170493b31874bbb3192896b31cffedb321cf5fb3238806b333a838b334644eb33c8e4ab33fd6e8b34210ecb3422e37b342e8a4b3435c86b3445c56b3457150b349c41cb35b2de6b3617ffab36639d0b366dc55b367aa36b36b1f1fb372ff70b373c365b37467b4b3756560b3761555b37a909eb37d64d7b37dbad1b37eaeffb381a371b386d9f6b38725f7b38ccc5bb3923f97b392c95bb393c21eb393c295b39895f1b39ada70b39d504fb3a18311b3a648b7b3a82180b3a99948b3abab39b3ac06aab3b52c42b3b5789fb3b88947b3b902e5b3bc4354b3c30ff3b3c68ab1b3ccfa6db3cdb765b3ced4cab3cee480b3cf7473b3d05cccb3d25b0fb3d65bd2b3d82837b3da16b8b3db05c9b3dd6b55b3dee9c3b3e000ceb3e56a05b3e5edeab3e75521b3e7628eb3eb36bdb3f3abd0b3f82ad1b3f838bab3fb8760b3fb8ac0b3fedc74b4081869b408dcbeb4093dceb409ab63b4132f7ab41ad73eb41da7d3b424c792b42643f0b4273724b4275647b42c14b5b42d1903b42e478db4329677b4383863b446a23bb44e9323b45d7d20b45f7c2cb463ee18b4678492b46ba2a5b46ec78db472adfcb4738a1ab47a3367b47c8388b47d89a8b4864fc2b48b7da3b491a161b49348f3b49365bfb4941226b49843a8b49ad6a2b49c8c00b49d386eb49d466bb49db893b49f7563b4a73159b4ad09cab4ad3245b4ae4046b4b0e01fb4bbbd74b4c00ef6b4c40e84b4cd9bcab4ce579cb4cf97e6b4d03af3b4d2d4c5b4d3954fb4d5d35db4d63dffb4d704d6b4dd671fb4e3d53bb4e60207b4e83dccb4e871d4b4e8de39b4ea90b8b4eab800b4f0a22ab4fb0af3b4fba236b4fba317b4fde89bb501063db501eb21b5032ac4b503534ab50616b0b50fff9cb5100d3eb5107de4b512ed23b5150295b5162b9eb5190f9fb521823ab52245c7b5243b6bb5249906b52aef91b52b7ee6b5336ae8b53b1745b53ba0b7b53c4fdbb53c7d7bb5400ad0b5401820b54951f9b5539743b556c3acb5594d2bb55b2b3ab55e541fb564bb01b565da84b568188db56861bab56eb05db570b920b578a098b579a4b1b57b4136b57e1373b57f6fbbb5865bd5b5880fbcb588b998b58af8b9b58b4b4eb58bd6beb59431c8b59ecb5fb59f25a2b5a2f981b5a51326b5a60fa5b5a719e2b5a81e5eb5a92713b5aaa7edb5adf4e5b5b40af5b5b4782db5b71dbfb5b92c60b5bb1830b5bb8280b5bef8f0b5c070a2b5c6d1d8b5c9e232b5d200e7b5e1760fb5e2e207b5e3241bb5e41c97b5ea8ca3b5ee75deb5f5e0b0b602cd60b607c79eb60bf1f7b60efbf7b61a52cab61aef31b61f8c7eb630b5d0b63169edb635634bb63d3befb642074fb6425c22b6432746b64870a4b649961fb64d78d5b64f5b59b6500a1cb657e72ab65ce619b6633071b664c925b6661681b66f6844b6775023b677af35b6795817b67a3561b67fecc1b6815252b681d34eb6835aa9b6841fe3b685438eb686872bb6887e08b68f5369b68fb65eb690d201b691a63ab69470f2b6991631b69de4e8b69e78c2b69ec3acb6a4594fb6a4b5f4b6a58f9fb6a6efddb6aa602bb6ae5bf2b6af4fc5b6af94edb6b3deb3b6b3e8c2b6b5a85bb6b9af93b6ba63fcb6bd56b3b6c01c03b6c035b8b6c13a6eb6c27b0bb6c58ed2b6c664ddb6c7835bb6c93d78b6d1e6a2b6d34ebeb6d4afa4b6d77672b6de92eeb6df08beb6df9ec5b6e32de0b6ed376cb6eefbe5b6f4f5f2b6f5e08ab6fc7a79b6ffbfd0b7039653b70d28fdb70f1ac1b7116332b7123c7fb718d520b71c0daeb729ad49b72b2127b72c66c5b731061db731545ab732b74db732c982b736df2bb737120db7376390b738c0a7b73cfb45b73ec5c5b740b4d8b741a6bdb7440fa6b7444e15b7529cddb752a10cb752c10fb7540addb75461f1b757baf2b75c55dab7613176b7626beeb76bab36b76d8212b76e58afb77061d5b77948bfb77a9c5eb77ba6b8b77d7a50b77ec254b78017b7b7826e49b78668e5b78c8053b78e4b33b78fea45b790c8c5b792d6b9b79417a2b797e7cfb797f4d2b79a3709b79c33dab79de2c0b7a13651b7a24a31b7a331c8b7ab2089b7ab8f99b7ad8493b7b24d9eb7b2c14fb7b32ad3b7b55518b7b6ae0cb7b8562cb7b9fa5eb7bfb226b7c030b4b7c05c67b7cfb33fb7d5ba58b7d5e13cb7d9c18fb7e0c178b7e2c01db7e68ebeb7e7bf3fb7ed4d42b7f05b39b7f0da42b7f17c52b7f4d007b7faa59eb7fb77b5b7fc2144b7feb411b7fec163b7ff5f80b8009eebb801b60db802e6a2b80385b6b808d1ceb816540db81964deb819cdf9b81ca779b81d9bb6b82063f4b8222626b8246d3db8268f04b82f4f38b83394d8b8351fa5b83807cfb83828f8b839a16fb84466ccb8457e26b8483daeb84e5216b850ef28b856e7ceb857cd0db858c338b8594252b8603c16b863f2a1b865145bb86935d3b86b13deb86e8cb6b8722802b8769e85b878a157b88753a7b8879ba3b887d487b88ef80eb89387c3b89404a5b89aeebab89b778ab8a59dc8b8b58f96b8b82b8cb8bce1ccb8c169c7b8c96ac0b8cbce3bb8d0b1e0b8d1b33cb8d6788bb8d6b077b8e2a237b8e39b05b8eb73a8b8ee900ab8eef3feb8efea1fb8f14b89b8f22165b8f2dd98b8f4dacfb8f55236b8fc3e9db8fcebb8b900ab35b902cef4b904fe51b90a224bb90b409db90df055b9130baab91441d2b9152f99b91c899ab921bec8b92484f7b9288c66b92a78bab92c0de0b92c44ceb930ad49b9346da1b9393792b93a7a1ab93d2f05b9497878b94993bcb94c7569b94ca442b94d05ffb94d8a27b9517955b95448bfb95462b0b954dda9b95a8718b95c731bb95f9e5bb960e6ebb963417ab964a109b966c62cb96a546eb96b5ff1b96b63edb96fa62fb971b5e4b9725ff2b980e9d3b981d9f9b9898d8eb989b100b98a983db98c26bab98e3e9fb98f2acbb9956f19b996b13fb999993fb9a3884bb9a6d480b9acd744b9b053d8b9b22faab9b3dd2eb9b3f8abb9b8cad0b9b8f78fb9bfed91b9c2e305b9c33b5ab9c40886b9c5703ab9c94985b9d11517b9d1ad92b9d41606b9d71b26b9db52b4b9dbb0bdb9e2b440b9e7d071b9eecc82b9f763cdb9f9d64ab9fc3115ba010597ba01bd53ba02e7a6ba08c6e4ba09f9b2ba0c6ab3ba0e3a62ba11147eba13ee3aba182d82ba1c1fc3ba2060bbba20f369ba21133dba26a0ccba280001ba2b59c8ba2b7803ba2d1bd8ba31bc44ba338b35ba33efc1ba377991ba37e40dba398141ba3a560cba3d2645ba3efcc6ba433ac4ba461170ba476f9dba4ce41dba4d29daba50036aba53718eba542e65ba569164ba58347cba5ac474ba5b7cffba5e4de2ba61dd77ba66397dba6682afba6a964fba6c85ffba6dcbcbba6fba8dba721f8fba758440ba75faa3ba765a1aba7fd54dba834b89ba86190fba87d6b9ba88b21dba88f5afba8efafaba934afaba936356ba9a2ecabaa0a09dbaa245b4baa3206cbaa56f3bbaa61845baaa09e3baab3544baaf225dbab0da59bab590a4bab6cca9bab7da21bab907abbabb75b3babcb087babef681babf60a6bacbf392bacd8458bacf6e84bad451debad9e4cebadbc9b5badd70c3badfb19ebae0904abae90861baeb2df2baec3cecbaeda9d6baf10aeabaf2a87fbaf6a891bafeae01bb055353bb055d5cbb05c046bb07a2c3bb094896bb097e6dbb0ae904bb0ed3c0bb166379bb16d840bb210fe0bb236d2fbb2bdab1bb2ff6e7bb313833bb32c20abb361424bb366fdabb3cbceebb3fa28abb447b72bb4743a3bb47b767bb48da70bb48ff04bb4a1f05bb4f8923bb506c92bb521c5abb558685bb5b5acabb5cbedfbb5f4ba2bb65b2a6bb666d23bb6a9db8bb6d3400bb6dd58ebb6e4c1dbb6e5a29bb6e7c6bbb6ed319bb6f1b35bb7223e4bb73fa13bb74c313bb7541f6bb754f15bb7751b1bb794ababb7daf07bb8801f9bb8eae83bb957b98bb9b4927bba0704cbbac08a3bbad959bbbae4e3fbbae833dbbb04701bbb2df78bbb3d08ebbb635ebbbb7e093bbbad97dbbbe86d9bbbfa8d3bbc4135cbbc5abc9bbcc9187bbcddbfcbbd0ad56bbd15bd6bbd38eccbbd6225fbbd8e944bbda75c3bbdbbd14bbdff186bbe1247cbbe26e2abbe31dbdbbe61a58bbe65fb3bbe9041bbbe9e4bdbbedbd91bbef199ebbf065b3bbf54e66bbf7985dbbf8fdc7bbfb4834bc04b166bc0b7af6bc105864bc118a70bc130f80bc19a62dbc1aee7abc1b9452bc209310bc226ce7bc23a7a4bc23e486bc2b689cbc34cb34bc37ff62bc3ab086bc3bd88ebc44dfc5bc4536b3bc4578f7bc466f1bbc4b0d4dbc4b255ebc5763f7bc5beb68bc5c298ebc5f4ddbbc65aab9bc674915bc68e972bc690e28bc69b0ddbc6dfd5cbc6e6677bc741867bc77eba0bc78b233bc7ad642bc82b801bc86c98fbc87238abc890c17bc8ac54bbc8afddcbc8c6f1dbc90f816bc920878bc9437bbbc9a3628bc9bce98bca0626bbca4550ebca5f210bcaa14d0bcad9d5abcaf37b4bcb31384bcb836a4bcb9e6ccbcbd44b2bcbd6cf8bcbdf9f6bcbe40f1bcbf575dbcbf7818bcbfccc5bcd1eeb3bcd454d7bce0baf8bce4a23fbcec08d7bcec5cd4bcee8b5ebcf54c0cbcf7243fbd01cc40bd02a889bd08524fbd0a83d1bd14c299bd1bc98bbd1e2e96bd1f1f6fbd20446fbd225bedbd253d01bd265acfbd2f921ebd329a1fbd340bc3bd36bb49bd36d77bbd3f31f9bd4256f7bd45ad0abd49fd5abd4a161ebd4bd76abd523f9bbd537c06bd53ec6fbd63cf52bd663b13bd66a7bbbd67796bbd693c2fbd6bc040bd6c607abd6cc7fbbd7330aabd735b2ebd78b78cbd7f86c3bd8128a1bd83a908bd8853dcbd891a69bd8a1d10bd8a8a87bd8b9a1fbd8bda48bd8eccb1bd90e9e5bd93909dbd93dad1bd974481bd98a11bbd99dd39bda693a1bda9d6b6bdac6f76bdb300d3bdb97a15bdc12792bdc1e2e0bdc332e1bdc4225abdc5f2d9bdc81971bdcc200abdd0ac24bdd36248bdd4c93dbdd60822bdd8347ebddd3f45bdde1674bdea608cbdeb735ebdfd7d75be0031a5be01f7a6be0366cbbe045b9ebe0e96e6be123e8bbe1df8e0be23e663be278247be2a44eabe2d89a5be2d9d50be341695be34575cbe3c6b0bbe3f26cebe42b35ebe457627be4a4956be4fc05fbe57401bbe58cfa0be5cdba0be5e7b7ebe627ecfbe646e53be667a33be66f349be69fb0bbe6b7271be6e8541be6fd2dbbe71c41abe720c8cbe73e867be759526be770844be7746c2be77c8dcbe78240fbe7a14a5be7e7a0dbe83cd49be84fdbebe8c219cbe9797abbe9a55d9bea1b09fbea4c3d2beb37131beb5f3abbeb60dacbeb75b89bebfabebbec19dfcbec1c466bec2ec6cbec9b455bec9da97bec9f8febecfc09dbed07a8fbed17e99bed309ecbed384dcbeda300dbedbd947bedc03fcbedcac20bedcbcd9bee61249bee650fabee983babeecc167beed6269bef0ead6bef22dbebef74110bef88f15befd7382beffbc59bf024c2bbf05f612bf0b32b6bf0b5f9ebf0fb226bf12827ebf131bb3bf148520bf159fa7bf1658a7bf167cc4bf1bf3f9bf20b377bf2191b7bf21b558bf227e9abf2c8f66bf2e08c5bf303279bf35fa13bf37cb66bf3bddb8bf404028bf418d06bf446c3abf4c6295bf553bc0bf568cd0bf596badbf5c874ebf5e8ef4bf6eae9fbf6f1428bf732382bf77838fbf783a78bf7a8452bf7c19edbf7ddfdebf815eb3bf83231abf836cedbf858317bf8aa411bf8b1f67bf8c01a9bf99baacbf99f3e0bf9af91ebfa1884fbfa50667bfa8511ebfa91767bfa92e38bfb6cacbbfb8322fbfb91adebfba1eaabfba849ebfbe4b9dbfbfb428bfc1cacbbfc7628ebfc90c36bfca77e8bfcee479bfd0271cbfd24f53bfd48587bfd497b4bfd56fd5bfde0955bfe15257bfe27eddbfe43e87bfe4594fbff55cafbff64776bff6f0bcbffd8b5fbfffb48ec00089b5c0043dfbc00b9938c00c65c7c0118658c011ca81c01aae55c01f9e7ec01fa6c6c020d6a9c02ddd0cc02fff77c031010fc03d9159c0501fc5c0558145c05d3e2cc0629a00c0673438c06df147c06ffe92c0729944c079ed4bc07a25c4c07e0ce5c07f467ac08693f7c08a8164c08e54fec094bcffc0989157c09bfd5fc09ff57dc0a52aa2c0a5570dc0a9d873c0ac7f49c0ae2de3c0b031fcc0b2085dc0b25247c0b26a36c0b33619c0b5be53c0b6826ec0baaf8dc0be8632c0c0c066c0c6fc7ac0cac761c0cc2c96c0cf7454c0d34147c0dbac20c0dc626cc0dd5a66c0dd9decc0de87fac0e1bfccc0ea6a5cc0eb1e49c0ef3accc0f0a417c0f45ae9c0f76155c0fa31bec0ffdd82c100ac1dc10565d9c10915e2c10cc507c110b5a6c11984d2c11ab05cc11d5108c1202d64c1212473c1255305c12f776dc1302939c135b764c1389d69c139ef96c13bf665c1401e49c141d382c1425343c145d766c148eaf7c149e63ac14a270bc14ad453c14ae9b9c14ce81fc153d9a1c154e2abc157fbd8c1588b53c15b6227c15b987ec15d808bc15f49cdc1609635c1612df4c161be4cc16202ecc1632118c1647221c164b6c0c167b724c168abfac173bb2ec17e9a23c1800e38c18ce1d6c18d5c3ac18f5d8ec19483acc199b8edc19c3186c19cf830c19da61cc1a87369c1b27aabc1b52389c1b65550c1c3ddd7c1cac008c1ccd7f1c1ce724ec1ced1fbc1d2ae2ec1d8d7e1c1db0a94c1dcd004c1dfcdf7c1e5ecc2c1e6dea2c1e8c064c1ed80d6c1f15025c1f30a5ec1f344e6c1f57123c2011b32c2064190c2083974c20879c6c20db847c20ff3eec212fe5cc213dbf7c2161f62c216820cc218faf4c21aaadfc21b4e37c21c89d4c21f905bc22127d5c221eb26c225e235c22697d8c22919fbc22aad72c22d8b2bc22ff98bc230c96fc2315e50c2334251c233fc74c2419e69c242b97ec2432ee4c2453f72c246a632c246cb4ac24910cec24bd7afc251c86dc251db0dc252c8bec252d6d2c2539553c26825b3c26c1a7fc2759e2fc278373ac278b86ac2798bdec27a7dbfc27acee3c27f5ecfc28085a4c280c3b3c282096dc28305f7c284a4cec28b67ecc28b9f3cc28d7c52c2940da3c2979feec29ccec6c29f79bdc2a0b75ac2a0f789c2a1d9fcc2a3f1cac2a455eec2a580aac2ac5c57c2ad2d68c2af3299c2b80ba7c2b8c830c2b9cb4bc2bb4efdc2bd77a8c2be5f2ac2c5ec5cc2c7bac5c2caaf97c2d02129c2d7b64dc2d94e95c2dd199ec2df62dec2e83a3dc2e9fa28c2ecfc46c2ef97b2c2f3cee8c2f48efcc2f608e7c2f7f0b0c2f98a03c3034335c3069f1dc30830e9c30a1bb4c30cadc3c30df763c30f9715c314638bc31720ecc319df3dc31a1e64c31ef159c321b8a2c3274f68c32a670fc32a676fc32dd2afc32eb650c3332c4fc33b0ed8c33e4c4ec33f6ddac344aa83c3462ab3c3481099c34966b7c34a01e5c35207c2c35e3901c366aee0c36889d9c36c2007c36da9c9c371c52ac37666dbc3773ce7c378a13dc38257b5c382c28fc385493bc3863ae7c386b00fc38a0bbfc38c0500c38caf4dc38f8af4c390526fc3953a47c3a3065fc3a5f37ec3a94b79c3ac46cec3ad216dc3af3314c3b2789fc3b6117ac3b6f338c3b75561c3b92e54c3ba3e13c3bb870cc3bd77b8c3bd9fe4c3be6179c3be7011c3ca471ec3cbf08ec3ccb557c3ce3d6ac3d04a6fc3d0b4ccc3d5e1d2c3d89505c3d99c0ac3dcc8d9c3de16ffc3e269e1c3e2c6a5c3e8dbb6c3e95853c3ec40dbc3ec8a03c3ef2d35c3f03f29c3f24ca1c3f2cb1dc3f58f4cc3fce12fc3fee48cc40b5f2ec40bad72c40f8316c41087c7c41410aec41528b5c418cdc1c422b4d6c4236707c4255887c42d4e1ec4354667c436ffb3c43a882cc43c4e83c444ed67c448fa96c44b68b1c44c2b86c44ceb76c44ea591c454ba20c458a88cc46317efc46a4658c4700cb6c474d6e4c47655dbc4785882c47ae7bac47bd1a3c48035dfc48435dac4847b6dc48728c8c48a29e2c48f1944c4935601c494ddb0c49785bac4979d07c49a53fec49f44b1c4a53aa5c4af04dec4b1b149c4b4802ec4b5b1e2c4b63cd1c4b6a37fc4b6bf79c4b82f32c4b84822c4b891d5c4bb30bdc4bf01cec4c05806c4c31c41c4c3cb3bc4c3ce2bc4c4f941c4cc2797c4ccb153c4ce1e87c4d45734c4d8a9ddc4d99b09c4db11fdc4db3877c4dd971ec4df3d21c4e13b3ac4e439fec4e4b5d0c4e4bc3ec4eb7459c4ebd883c4ec7ac5c4eeb1fcc4f07a17c4f200cdc4f36262c4f4a0a8c4f6f9e8c4ff322dc500ad31c50104e3c504aa44c50688c0c5068967c50afd93c50b5dabc512fd86c51663f5c51e8a8dc51fba82c521078fc5245739c52ab2a5c52caa36c52e5a3cc52e65a5c52f4006c53307e7c5345c41c539a169c540084ac5423a26c544a547c54578a0c5526718c5586995c55bc584c55d4c8ec55e8167c55eff92c564d9cec56ac9f6c5725de7c573f89bc574a5d0c574c522c576686ac576a45cc5789858c5798f0cc57aae27c57b6843c57d0f3cc581a773c5826888c5837516c5846240c58660eec58941fac58f662cc592cd10c5946bcfc5977e6cc598fecfc599bc03c59acd48c59cc64fc59e62ecc5a29fb6c5a3370bc5a370e6c5aa191fc5abecfcc5acd279c5ae329cc5b2df2bc5b9b717c5ba548dc5c44843c5c4bfc3c5c73720c5caf5a0c5cb5924c5cc72abc5ce2fa9c5d39915c5d6afcbc5e384c3c5e411b5c5ee8ab4c60518e1c608a884c608dd72c6090a82c60951b1c61239dbc6173f96c61814b9c61bdafac61d2048c61f111ac61fba64c6208e7ac624f12dc630742cc638c24dc63afa61c63afd3ec63d64a4c640a131c64329afc6467971c6483cc8c64b0ab0c64e13e5c64e3937c651d737c6537d37c654a87ac6573f7dc6573fb6c6587e9cc65a8935c65c8244c65d65b5c65e5ccac6613cf0c662a8d2c664b07dc664ed2cc667f85bc669b9d7c66b800cc66c0423c672a275c6736521c6743b39c67c497bc69194cbc6951096c69739b8c69b55d2c69e06cac69ecb28c69ed0c3c69f8609c6a1632dc6a38f90c6a49c71c6a4baddc6aa9088c6acba93c6ad6bdbc6b37fd9c6b4e1b1c6bd83e9c6be5d5bc6be6938c6beaeaac6c04266c6c3b199c6c49bb9c6c4fd44c6c6a99bc6c727b6c6c762e7c6cb1e64c6cbbdc8c6d09975c6d45db8c6d97483c6dbb541c6e5ba4bc6e63ce5c6e7cd13c6eaedcfc6ec2383c6efb7a8c6f2d9a6c6f48694c6fdc0f4c70794f8c7081c8fc70c2e23c70db812c70eb5edc7122e2ac716c920c71883dbc720f753c726eba8c7272ef4c7275e73c728fdb3c72b6d7ec72c9a30c73482c2c7354869c739d16bc73cc48cc73cdf74c73ebea6c73f71eac73faa23c744c059c748f516c7508054c75115e1c7517e7dc752415ac754f770c758f7e2c75d47b3c76138b5c7630826c763c1e7c765bb7dc7695dcec7715cefc7741879c7741c06c778334ec77cfc2cc77e25acc77ece33c7813cbac781980bc7820589c783cba0c7865da6c78a1a72c78bb32ac78f449ac795e8f9c799e66ec79a34b1c79af542c79cc490c79d75e1c79d7ec3c79ec383c7a07e6dc7a1ec36c7ae646bc7af2af6c7b1b804c7b51e31c7bac4d2c7be4ae4c7bee1abc7bf6c0bc7c3f1e6c7c45b93c7c50d3fc7c5d8a1c7c900f6c7ca3f73c7ccbd96c7cef2f4c7d13407c7d13b7ec7d2564ec7d8ed91c7e4ccaec7e9105cc7e9ebafc7ee85d4c7efec4bc7f125dbc7f160dac7f2a2f9c7f42c47c7f5f62ec7f73ce1c7fa1482c7fade72c7fdf2c6c80039fac802925fc805c577c80ac83dc80e3f40c80f1d32c81874e3c81a695fc825345fc82838d8c833a57cc83952b2c83e22b1c83f5088c840a894c841b3fcc84426dfc844dc06c845efefc8474023c8479437c8494227c84dcb1ac84eca5ac84efe0bc85671b9c856aa25c8577074c8590370c8594e99c85f79e5c8691492c86a39f1c87153edc873e4d8c87d8ae6c87e7addc8842107c88fb5b0c891d632c8932d1fc89922f5c89d637fc8a2457cc8a667efc8a7be91c8a816e8c8a9b037c8ad7ee1c8b5d8b8c8b75279c8ba6848c8bc07e3c8be057ec8c4cf6fc8c7120fc8cc37e8c8ccb2dbc8ce7a0dc8d22b92c8d38155c8d9ac13c8daf89ac8dbf077c8dc6f57c8e5a03ec8e73612c8e7ab38c8e7f4b0c8f7296ec8fa6eacc8fac5c5c8fedec3c9010f1cc901e651c90405b6c90d08f3c90ee2dcc90f6835c910528dc91ac4a0c91c2cf9c91f5a28c922a2d3c925cb13c92a39fec9331137c9365fdcc939ae73c93b42f6c93d2633c93dfc10c93fec66c942d590c9452233c94a27d8c94d3a2bc955824dc957356ac95a7ad4c95e2ddbc96171cfc9632d90c96a7e51c96af024c96b854cc96bcfccc96d3881c96d68fdc97740d4c9798f87c97d2643c97fb793c982da86c9873dd3c98afee9c98c0691c98c66e1c991ec34c9932072c993840cc9954129c995f237c99b1791c99c0973c99db6d9c9a3f520c9a5a9e6c9a7a2dfc9aacd56c9b29b61c9b450dbc9b4dd00c9b59b29c9b73263c9b868bfc9b93cd0c9bfb39fc9c31864c9c32fc0c9c6ec78c9d07498c9d5dfd4c9da56c4c9e0b531c9e4ccecc9e6f769c9e7f0d6c9ee52fac9f00a29c9f59a02c9f84608c9fee8e7ca0571c5ca060353ca08664fca0b94c1ca127470ca159c13ca184bc3ca1a92cbca1dd9f7ca1e5879ca2149d8ca2b0e80ca2b337dca2d948eca323621ca33b64aca3425f9ca34b605ca352709ca3f7cc7ca485aadca4a624dca4be080ca56c8f9ca5ab64eca63a006ca65de6aca6d2837ca6ecaefca71b98bca7472acca7ee8b1ca85be7aca8d138fca8d8634ca8dadddca937f23ca981afcca9e0c2fca9f7350caa300e2caa4994fcaa699eccaac335dcab0b944cab13841cab3bc46cab67e2bcab8639ccab92abdcabf59c7cac0088fcac107d1cac764b7cac92960cac9ca9ecaca7f18cacc9e1dcad1f365cad60deacad756f3cae0a15acae74992cae9df58caf18edacaf1f9cdcaf2f399cafb0c2ecafd8ceccafe09c4caff0b87cb016465cb080023cb09cfe3cb09ffaacb0bdc85cb154818cb175326cb17dd5acb187f7ccb1b5867cb210895cb2f5a54cb33a55dcb36da4ccb3aab87cb3f2f89cb431b34cb450892cb45ba89cb4a7ddecb4b8ee5cb4cdbfecb523a39cb545ea9cb54c417cb5da09ecb6176bdcb62aa1fcb64def9cb6f3aa9cb71abb8cb728479cb74d82ecb839e4acb86d26acb8cf668cb8db00acb910f3ccb9352bfcb93aa7ecb991957cb99cb61cb9d61e9cba07f8ecba271fdcba69615cba6ff72cba9d2c5cbab0ff9cbad40f2cbaf20eccbb27618cbb8e34ecbbe9b51cbbf070acbc03370cbc3cd97cbc705f0cbc74033cbc7f957cbcbfb1ccbcf29c1cbd7d802cbe2a153cbe744a8cbea27cdcbeb0a1ccbefd810cbf1a2c7cbf3dc3bcbf66088cbf74922cbf76196cbfa2081cbfbc7d9cbfeae0ecc00fb94cc01da93cc0762f1cc079697cc0850d2cc0f665acc116d00cc1bf91ccc1ef2c0cc224d37cc238591cc24b335cc2613d3cc27dacbcc282a8bcc2e058ccc2e1df5cc2f1165cc2f32bfcc3413c7cc3a7bbdcc3c2957cc3c61fccc3cfe9dcc3e2267cc40d018cc4382f0cc43edfbcc45e1c4cc49b780cc4a7bc2cc4d962fcc4e9646cc538c62cc547030cc5ac3a1cc5deb0fcc5f3766cc631d31cc6667bbcc7112e5cc724764cc7580c0cc7ecec2cc7eecc4cc8109ffcc81a448cc84b4fccc86fea7cc88338bcc8ba624cc96e70ecc97426ecca2697ccca47749cca6c09bcca9c4f1ccaa22cdccab2a1bccac9262ccb11959ccb624f6ccbac879ccbb4c17ccbcab06ccc04829ccc18565ccc88d8ccccaa22eccd37053ccd537a7ccd76ea6ccd9e21dccde74b2cce52ca9cced72ddccf0754eccf21872ccf6ffd7ccfd77ddcd00202fcd056a17cd08ac86cd0d1722cd0eee76cd10da72cd11fdafcd153f93cd15b6bacd1cd381cd269360cd2913cecd2a7c2bcd2ae1abcd2c4550cd2c9e16cd2e1c00cd322099cd364e77cd374cfecd38f703cd3e47e6cd3e9a92cd3eb691cd41c279cd428512cd497959cd503b9ccd50d877cd52ed9ecd5601b5cd5fb21fcd63ec47cd654a18cd67b8d3cd6bfa57cd704691cd7564eacd7a4862cd7dea64cd81d3a2cd842a31cd86b6f2cd8ae105cd948697cd985985cd998a11cda339abcda43a5ecda47218cda5029bcda91a9dcdaa74d3cdacd39dcdae65e8cdbad3d0cdbe696acdc1b21acdc534f0cdc81073cdc88cdfcdccd910cdcf13d8cdcf53b1cdd720c2cddca90fcdde784acde60051cde6b89ecde93f73cdf0ada9cdf1e7cecdf406f5cdf43e3ccdf58749cdf5b312cdf5b8c3cdf94e91cdfde526cdffe776ce002c7cce01f3a2ce021f88ce023c31ce04200ece0442d1ce073149ce0cf5e3ce0dd63dce10d7e0ce195994ce1b9a87ce1c6cc1ce1cc057ce1d2a8fce1efe24ce215abfce230126ce2405ebce2613e3ce27dd66ce27e392ce2a8a97ce2bba32ce39efddce3c372fce400802ce411d5bce47b3dace4b6144ce4bb215ce4ca1a1ce4e643bce52962cce54ca2cce59a3e1ce5a9738ce5d9addce6547d2ce65dd8dce6adbc7ce6b3e02ce72cddace74a3c8ce78104bce78946dce7c8019ce7dc00cce816587ce8192e9ce851924ce86bd3bce8ca82bce8dfd8cce93776bce944fd0ce97b4c4ce98f8f6ce9e9e54ce9fc9a5ce9fdf20cea2ddaccea3e880cea4ace2cea57d57cea74ba0ceac22cfceaedd86ceb2c788ceb41d4cceb78f2bceb98a21ceb9eb6acebef8d7cec9341dceca1e51cecd2fdfced0f5feced6d07fcedaa216cee2eab2cee7751fceec78b8cef54b2acef63989cef7ef8fcef835fbcef8e967cef9d619cefcd6b4cf000d95cf01f1d3cf09ac2ecf0d734ecf153939cf1cf8f3cf1ec096cf2194cfcf23c55fcf24eb15cf271d39cf2829d0cf33802fcf33b795cf3680f6cf375d96cf39000dcf39fc69cf40c931cf4769f4cf496695cf4a1401cf4b2dc3cf4d86cccf5812fecf58a8becf596ea1cf5ea301cf5eb5abcf64be06cf6704e3cf686bdbcf699a66cf69aa0bcf6b8a00cf6d1fbbcf764c24cf7b32f1cf7b9e48cf831a8fcf89387ccf89d088cf943ab2cf972ecccf984bd0cf996b8ccf9d028ccf9d909fcf9fce01cfa0cb58cfa71b3dcfad5c38cfafad6ccfb09ea1cfb293fdcfb70e0bcfb7cae0cfbb75cacfbbb615cfbf4b8ccfc310f2cfcba8c1cfd405f8cfd68df7cfdcb07acfde1751cfe1cf73cfe6d9e7cfe97407cfe9e398cfedae8fcff25fb7cff632e0cffd5cd0d002f805d0064df8d007d103d00bf3cdd00e6c42d01009e0d020d1e7d0210784d02215a2d022163ed0276debd0288f9cd02de440d0300fbfd034c3f9d0377829d039d734d03a1726d03be789d03ec2a2d04064f8d040f316d04b1c10d04e8972d054581dd05938cad0594f7ed06538b1d079bfded07e65d6d08024c5d083afb2d0900bffd093150ed0955780d099275fd099dbddd09c98d7d09df21cd0a5c9b5d0a7f8dfd0ab39c5d0b5c3a3d0b6e4f4d0b93c7ad0bb2745d0c521ebd0cd2f67d0cf33cfd0d22a0ed0d6a758d0d7023cd0dbe1c4d0dc6b38d0e035d3d0e1faded0e2653fd0e3a9dad0e9bddbd0ea7d70d0eadcf2d0ed2dc2d0f25620d0f52829d0fba58fd103f925d105c497d10888ddd10db79ed10dcb9ed10e89a0d11c1335d1253790d1279004d1281a06d12a6c0dd12bd231d130503dd131c013d131c5bad1322af8d1340716d1382217d13a3ea3d13b4dd4d13e4f00d141b2f7d14660efd14ac836d14dcc3fd1506203d151d162d153f1ffd15aac15d15bd503d1634986d16516abd169afecd16deeebd16ea1afd16f597cd1707f42d1761752d177fd66d17abbd0d1815600d18200b6d185e608d189beb2d18f123fd197654ad1982b4ad199cd66d19c4681d19d1721d19eaaccd1a4e825d1a83173d1ae79e8d1b358c0d1b7d637d1b85e69d1c7fb73d1c8e97ad1cb6918d1d22391d1d398f5d1dcb576d1e41572d1e6cb3cd1e7cdcad1f242e9d1f41175d1f43205d1f520ddd1f76752d1f99fb4d1fdcd86d201abdfd202e65ed209892ed20b42ccd2159052d2161066d2174914d219a0ebd21c6a7dd21e269dd2223566d230e82dd2380e17d23a011dd23affdcd2460f85d24ae19dd24d595ed24f3182d25083eed251a9f7d256cc3fd2579ba4d25a13d7d25b31ccd25d5f3ad2649292d2662d32d2695631d26bea52d26c12bcd26f04c7d26f4412d26f8f35d2731a72d2799361d27aebd1d27b9d6fd27d4eabd27e0897d27e1eded27fbf9ad2875508d28b2628d28bea9ed28d4262d29561f6d2973a5cd297a502d298b61cd29a4dc2d29d76f4d2a7ac06d2b07c0ed2b12281d2b34534d2b47a89d2b7e7b9d2b9287bd2bc8ccfd2c0e4ced2c5c32dd2c8ea0dd2cb03bbd2cdfa93d2d34d67d2da9256d2e31132d2e70c7ad2e7ac85d2ee81cbd2eedb57d2f25d62d2f3f320d2f445e9d2f48425d2f81154d2f9d160d301a2e6d30658acd30c0a33d30c600fd313bd27d3149371d318565fd318587ed31f0136d3271f46d327411ed3282663d331a8d9d3359784d339b86fd33abe0ed33b5ec7d33c6092d33c88ead33d4ff7d33ecd90d341dc2fd3427737d347a13fd34ba476d3507076d351f906d35b2e95d35bf12dd35d6ef5d35e41e2d3604becd362ecc0d36320e0d366b0f3d36b93ded36cf9b4d3738eb4d37a21e3d3830e2ad38aa2d2d38bdb0ad38e0e23d390cb3fd3986982d39a7f7ad39b64f5d39d5b60d3a031cbd3a1a33dd3a3073ad3a658b2d3a8ae37d3b3df3ed3b465eed3b6591ed3b8a45fd3bed9ddd3c1c847d3c83e28d3c8aeeed3cf3756d3d989add3d9da6fd3daacedd3db3ce6d3dc524fd3de4bffd3e1420ed3e361e6d3e4d174d3e81206d3ecdf30d3ecf5efd3eeb3ebd3f1aeb2d3f9cbdad3fb630bd3ff9a39d403e7f4d40698fdd40a3447d40b6a0ed4113e58d412c011d417e9a5d421e5e2d4236976d4255fd0d4275bedd42a03ead42d0f49d42ed31ed431dba0d4340529d44055ddd440b205d44660b5d44b1175d44f87e5d44ff180d45132b5d452d242d454c076d454d3b6d4590dedd45937a7d45bdf66d466e5b6d467371cd469f5b8d46cc2c2d46ce503d470d707d470fd7ad4736843d473f619d4776348d47a0bd0d47e5fb3d4838f3bd486e41ad48757a7d49a4ea2d49bee1bd49f1ff8d4a13220d4a17192d4a17985d4a3783bd4a50796d4b1c86ad4bfecead4c0e71ad4c2fcbbd4c4dd46d4c59772d4cb9789d4cc6f01d4ce6608d4d14be8d4d3a89bd4dca44bd4dd4efed4df3dd8d4e1750cd4ed2829d4ee9524d4eee673d4f52644d4f6770ad4fa4a7bd4fc6722d4fddb2ad5022ba5d5147e5fd516e3c3d51f150bd522215ed528f20ed52b8bfed52c701ad53150e9d5384a6fd53b5ba8d53db523d53e4c34d53fe918d5400c51d542e7eed547a2b0d54ab853d54c8029d54d3bcbd5521b9fd5543d2dd555031cd55bb25ed560a930d5647494d566f76ed56a7464d56af8add56c261ed56cb1a7d56d3b2ed56de800d56f45fbd57d0fb6d581d72bd5898c1ed5976825d59df461d59ebf29d5a16d63d5a86108d5b963bad5bbdc5bd5bc08f4d5bf98e2d5c6dc0dd5c953a8d5cb817ad5cdab2cd5d1cd69d5d3b47bd5d65b2ad5dbcbc1d5dc9b25d5dcd8aad5dcfd3ed5de3befd5dfe9fdd5e4e2fcd5e62511d5ea1287d5ea1682d5ed4e8bd5edaab7d5edbce9d5f13724d5f15b3cd5f64143d5f6eed6d5f7768fd5f9bbe9d5fb3dc5d5fc5685d5fe2c91d604fc16d607809bd607e41ed6090bcbd60ae6ddd60be816d60ee9dad610418ed61275c4d61a27cad61a2c3fd61d7e80d61e18dad61fa8ead6209db2d624198ed624aec0d626f06ad627f6a5d629629fd62c2fedd62f442fd633a8a7d633f1ced6348de5d6396837d640011dd6419d0bd645cd26d6481c9bd64ee57ed651770dd6556e3fd655fbf9d656a339d6584e55d65dc43dd65f9b05d660593cd6646026d665cba0d66ccdf3d6707ebad672e60dd673a686d6794d99d68a0ffdd68d0b7cd6938752d69412b3d699337ad69d10bbd69eac19d6a12db2d6a940f0d6aa0f3ed6b3b570d6b520ead6b70c68d6b96459d6ba1295d6bb69b8d6bf71b4d6bfd982d6ca1918d6cc4b4fd6cd2e51d6d93612d6e92bc1d6f6a2d4d6f8a955d700337ad7085e00d70a0bf4d70a3bc4d70ae5bdd7123a62d718f59cd71ca484d71d0431d721af8fd7293981d72acf2dd72c6d41d72e3c73d7314c12d733bb4cd73429bcd73cbf9fd740f66ed7413e9cd749f2d3d74a0108d74a83f8d74f95b6d753edaed757d555d75874b7d75efd09d762c2ddd76699bad768631ed768c656d77826efd77ae4bad77f777ad77fbbded7815c93d782ffb3d7844682d78712cad7899321d792832dd7947750d7959a20d79dfa84d7a199c5d7a405f0d7a68c4fd7ad9dd4d7af2055d7b69ecfd7b998cbd7c6e0f6d7c8d3d4d7cbf356d7cf9853d7d3138dd7d4e714d7d7fe9cd7daf326d7dcd0d5d7e1cdf9d7e3f6b7d7ebdf53d7f37e42d7f63b34d7fe254fd80bfd73d811ba0ed81abac5d81c6482d820f688d8258d7fd8274837d828c3c2d82a1ca2d82a8ac9d82ab9aed832307bd8367ea0d8380c7bd83b5116d83e7cadd842ed4dd8467e98d847ad32d8501751d8566825d85696fdd85d19c3d86be150d86da79fd86de96ad875a4f7d876b157d8796493d87d3e5bd87ea3c6d8816075d8817338d881bde1d881d8e2d8874878d889d751d894cbfcd895b3dad896bfbdd8975f28d89bba97d89c317dd89c494ed89d8201d8a14df3d8a53040d8a9cbe0d8abce37d8ad44f0d8aec74fd8b1b16ad8b296f3d8b30c8bd8b8c646d8bb1847d8bc41bad8bc6b54d8be91f7d8c184c3d8c289d6d8c30c42d8c9ecb1d8caee9cd8cc21dad8d5f27dd8d605ffd8d78abbd8d7940fd8da9ef6d8e14967d8e4fad0d8e61919d8e916fbd8f51c54d8f78541d8f888fbd8fa9fbed8fdd28ed8ff6555d9000d96d90408e2d90762ead9094a15d90fc0b6d911ac79d912d1b5d91a0f29d9219fc9d922e1cdd9244261d926059bd92e6462d9321243d934db0fd93ce946d93fdb26d943440ad9451a8cd94540fbd9462deed9492113d94b954ad94cb21dd9509926d95e94f3d9638a01d964b441d969e0dbd96b6523d96f17bfd979a134d9802bbdd983859ed984d465d99173f9d9939941d998d0a4d9a1f687d9a6f53bd9ae2fe4d9b25bfed9b50ebdd9bd5234d9be1435d9c3d91cd9d09c62d9d4cfd8d9d52f0ad9d5344ad9d816e5d9da4168d9dcf29dd9e51c0ad9e5fad0d9efd544d9f7aa58d9f846d7d9fc3f58da0072c4da00cd4dda0149d6da0205f4da05a386da11fc0cda1d9bf4da229c49da26a109da284cdada2e18b9da321418da34cf50da3b4f53da441cc4da494e57da49adbcda4e0837da4e168ada51bc14da51ec77da55c24fda57bd08da5a500eda5a99e7da60987ada62a869da65eb8bda6aaa83da6b4af5da6efdbbda740ce6da74370cda7503b0da793ab9da7be0f5da854cedda8f7569da93ad53da971046da9b453fda9d8c81daa210aedaa70ddddaace93ddab42905dab617f0dac1e612dac72adadac9e05edac9ed26dacba865dace123ddadbcbdcdadd063bdade1a96dae01702dae34eb4dae5d632dae600d6dae69caadaea33d2daefdb6fdaf57350dafce208dafe2e82dafeb8e3db0832fadb097909db0db72cdb12dd6adb1d7afedb1deb72db24fd71db25f61fdb283c78db2affdbdb33b49edb34a696db351af5db36226edb397636db3cc5c3db3d316bdb405fb3db45bbc9db45da85db4b9b76db4d7a06db4e40addb4ea6d0db4f6536db55eee5db58618adb5bc58ddb5c27ecdb64d0f2db68377fdb6ab1b3db6ccfabdb737db1db73cd9bdb7896b2db7ab1ecdb81b064db825930db851600db86843ddb880acedb8c3533db8f537ddb9359fedb93ad37db9408aadb941bb4db94ca03db9be03bdb9c43c1db9d1fcbdba0a1f0dba50116dba9a25ddbaceaeddbb06047dbb099cadbb1d1e2dbcbc9efdbccdf89dbce66a1dbd17175dbd3fa59dbd41af9dbd638bfdbd79bc0dbd86d16dbd88a02dbd8c78edbdec9ccdbe43e15dbe49470dbe5f591dbe70416dbe9a293dbeb77b9dbee333edbf692f2dbf77b8fdbf8ecfedbf99d2bdbfb16efdbfed683dc0051b4dc01ec6adc08e480dc0a7559dc0b08a1dc0bb58ddc0f41bbdc10cb33dc140726dc142780dc145cd7dc1943dbdc1967ffdc1ec3f1dc1f6d7fdc203cf7dc235ba6dc257a26dc278f72dc279b6ddc28a7bfdc2c8263dc2e8448dc377111dc3aaed8dc404892dc491ba6dc5f1faadc647aecdc650612dc68de0bdc6a65a3dc6d75cedc6f26b4dc6fd301dc7168c7dc799b40dc8852e2dc88c47adc8c64e9dc90e3e6dc915426dc96df0adc96e7b2dc979167dc994c0ddc9e272cdca323fcdca6ffdcdcadda15dcb3ac4cdcb623e0dcc12676dcc15f47dcc21985dcc32d39dcc64ba2dcc79fe2dcc8f3eedcc92b0adccd385cdcd190fddcd27bf7dcd91518dcdf3816dce087d3dce34e6bdce62206dcea8240dcefaebadcf01b24dcf5f244dcf95405dcfe231edd000baedd01ab63dd032c77dd0e80cedd13dc45dd17c996dd2378a7dd2a0e07dd2a9e5edd2d6329dd33f531dd38b187dd3b80efdd40d6f7dd445ff3dd469c5fdd47463fdd474b8add481ef5dd4f6567dd5099ccdd58cbcddd5e9f2fdd61eb96dd62d6cddd63497fdd6571bedd674005dd6926c5dd706a6ddd715806dd7393a1dd753ccddd7e1bfcdd7fafbedd82ba1add832b53dd834b0cdd907621dd91d87bdd927072dd943c17dd94f956dd952747dd97724bdd9c2398dd9f3d65dda10510dda52c23dda74342dda8e616dda99052ddab063fddac22c9ddaf2b89ddb09a75ddb56bf0ddbcccddddc0edc4ddc46a7cddca8d80ddcb78f7ddcf9d70ddd034b8ddd12a9dddd2e924ddd42344dddc7d2bdde6ba49ddef2265ddf09fbcddf5da59ddf6bd0eddfac72fde004a2ede00603fde00a1a2de0dbe82de0f2fffde10ae7cde195961de1dd869de1ff8d5de267bb7de2697c9de2d82ebde35a545de3e264dde3e33dfde3fed0cde40ecd6de497459de4d7a53de4f760ede54e6b5de567390de56873bde5ab0d8de5d604cde5da5e0de604899de630150de6979ebde709fe2de718e82de7696b4de7906fdde7a7027de7cc384de7da19cde82cee4de88ab3cde8bd20fde95473dde9750c0de992c4ede9ef150dea2e592dea32132dea3b187dea437bddea791b9deab1317deac27e7deaef3a4deb1669cdeb755bddeb9e244debb2718debda7d3dec8b607decd8815ded0dc70ded4331dded9fa31dee23eb4dee926e1deec09cedeed66c1def0fb44def22d32def2bcb0def2db7adef3b493defa6be0df024f62df0629fadf0b3beadf0e5a8fdf0fa7fedf12df48df1f5e32df213205df23524fdf244fbbdf280cf6df314478df32415bdf328642df328984df364e07df399474df46519edf4c23dfdf4fc514df522cf4df53efbbdf5b812adf5de19ddf60ebb4df636eeedf6b45cddf6d0e5cdf72f7f2df7a3984df7c5d01df80cf0bdf84c8abdf880d4edf8c4205df8cdbf2df8d3818df8f2839df934eaedf943482df9454ebdf949ca4df98be46dfa16cc9dfa51776dfa99bf0dfa9eae5dfacd070dfb1d6c4dfb4aaaadfbed559dfc34d87dfc4f87adfca13e6dfcadca1dfcc0a6ddfd10d2ddfd33e71dfd38f31dfd5767edfd71565dfd751f9dfd88cc3dfd8b6acdfe12f20dfe453f8dfe4bda0dfe83c22dfe8eabedfe96749dfe9b7f5dff3250ddff8d0dedffa5b64dffb1923e000f95fe001f272e00628c2e00cf80ce010ad71e0158d36e027d3b7e02995b3e02abaa5e02bdd3ee02daf59e02ec1ffe032c7c7e03686c3e0384f9de038c89fe03b1290e03e8b7be03f03eee040a9afe041144ce043fad7e046fb5ae04c1297e0546f74e056f19be0571c70e0574372e05bc557e05d010fe05e56f7e0610a7ee065f01ce06c85bae06e7e49e06f1524e070032fe0704f82e07102d1e0792feae07b4dfde07f368ce08071c3e0849481e0851800e089c3aae08c8d9ce08d9ff2e08de4bbe08dfe25e09233a7e09aff47e09c94bbe09dd148e0a1281ee0a3bab6e0a3de49e0a605fde0a8c8ece0abf3fde0b46b1ce0bd1a97e0bec32ce0bec416e0c141e6e0c7c6c9e0ca0535e0cddc1ae0d86f67e0d9f5efe0db76d8e0de39c0e0dfa6d2e0e1025ae0e194b1e0e2287ce0e295fce0e4cce3e0ea0d02e0eaf0f3e0ebdcf6e0ecb732e0f71395e0f861f2e0faf86be0fe0f8ee0fe4469e1053b7ae10a0f18e10ddc69e1119354e1168c52e117797be11790e5e119a5c8e11a628ae11b0336e125fb85e12675ece127841fe129fb07e12bb546e1346640e135e352e137388ee13a9cf9e13e5920e146614de14884f1e1550922e155f668e1576ce9e15a8fc9e15a9286e15cc2a4e1617d42e1670673e16bbe8ce16f6371e1703da2e171fe22e1796865e17995b3e17a1401e17bbebce17c925be18246dfe1835059e188d7b5e190c3eee192003be197d256e19c00e7e1a24b90e1a290d9e1a37ea1e1a3d8bee1a520bfe1a7359be1aaf244e1b5357be1b69138e1be8374e1be9701e1c07220e1c1d8b7e1c5a50fe1d4adffe1d50aeee1d68f45e1d7bda2e1d873ede1dbb66ae1ddb38fe1e26593e1ea2df0e1eb4b0de1eb5d2be1edfca6e1eef694e1f1364be1f3424ee1f385f3e1f6b6d4e1f9ba40e1fe4e78e200a585e20f60eee211796de213b689e214d881e21b5f31e21fb3ffe2219e99e22be2cce231c643e231e567e234c89ce23f1c7fe24257c7e243635ce2441208e2482576e24d3055e2501651e252df88e2584ad3e25bacb3e262f9bfe26681c4e26bfc30e26c6d39e26c934ae26dd71be26e8b3fe2752a0be2842e76e2860fd4e28627a4e286fefee288dcfee28a1cf6e29202c5e292d70de295b7fee2970798e2973a3ce298ea8de29a9e15e29e3c69e2a02e1ce2b3a81ae2bac2e4e2bd8c19e2bff370e2c1f7c7e2c68e38e2cd30a8e2d03ba1e2d43cb1e2d742a3e2db242ce2dd39bae2e1423ee2e19587e2e1d768e2e3ae9fe2e8f72ce2ee77fee2f4d027e2f64322e2fa2dcee2fbe78be301e243e3023c3fe3054631e306fc80e3102b0ee3103d92e31819c0e3203b33e32d9415e330ff11e33624aee3374772e3389f57e339ce4ee33d4699e33e66f4e33f9298e345d905e34696dde34a68dee34ca114e34f1d8ce35570a6e355fa23e36337c1e365887de367b2fbe369f71be36c541fe36dd879e3717638e372a39de3744c6fe37869dfe378f74ee37a0273e37a6a66e37fb3aae3820c39e3828c7fe38291f8e382e787e3865546e387d97ae39283eae393022fe3938271e393df63e396a8fbe3989c0de39e2982e3a672cfe3a97fede3a98714e3aa70f8e3ac9e14e3b329f9e3b7931ce3bdca6ee3c37952e3c732f6e3c884c0e3c9afd9e3ca569ce3cdb8c3e3d81b95e3d9984ee3dd1d3be3df6527e3dfe996e3e0971ce3e550dce3e7064fe3e77d73e3e933b6e3ecb470e3f1a8cce3f56bc6e3fd933de3fd9389e3fde748e4075bf4e4080d5ae40ae97de412676fe41afd80e41f2f00e41fb2cde429bf86e42ad58ae4334c96e433d0eee4367a77e438609fe43b2e3ee442ba68e44371dee4465a50e446f1b8e44999e7e44a3739e44de8a5e44df658e454297ae45debb6e45ebb8ee46057aee4615759e463698ee464a3a1e467ac54e468ca13e46bae31e46cd2d0e46d8ad0e4711c3ee472e0dfe4742f52e474fa8ae476fd8ee47be755e47dd42fe47e79a1e482de8fe48879fee4896267e48a09a7e48b88d4e48fccdae4909fe8e490e9a5e491e09ce492afdee49377fde493fc93e4970968e4976556e4982fcfe4998312e49cec3ee4a62eb5e4a6a655e4ab43abe4ac89bae4acf5f7e4ae5b4ce4af1d1be4b33506e4b722a0e4ba139fe4bc8d6ce4c59baee4c650c4e4cbdc2ee4cdb16ce4ceba74e4d3a3bce4d4df41e4d9015fe4dd84abe4e332a8e4e7ef1ee4e83898e4e98883e4f01476e4f14bc6e4f376a0e4fc44ade4fce6f9e4fd9a98e4ff47b5e50256dbe50298d2e503574ee504b1bce507c758e50b6029e5122003e5129ca8e51a16d5e51ec4a3e5245eb8e5253171e527eac5e5298b3ae52c8fb4e52cf749e52ec1fbe52f179ee53048c1e5339b05e53820bae53bfa61e5452c42e555e148e5562373e55cc110e55efaa1e55f59ede562747ee5722066e5740b28e5748450e57492eae57cbfcbe57eac0be582556de5849cf6e588901be5962931e5976eb6e59b0406e5a458a2e5af0e0be5af51e4e5b21c4de5b24a89e5b6a411e5b908d0e5c36936e5c46333e5c57e8ce5c6ba2be5c7afa0e5c96dace5c9d312e5c9d9fde5cbc337e5d06740e5d40299e5d9bf89e5dac93ce5e42501e5e779dae5e82fe1e5e85dbae5e99c6ae5e9c76fe5f064a5e5f0ff10e5f4e948e5f71635e607dd48e60c9bdae616f823e617358fe6185f95e6202978e620ea03e62103a7e6218049e62a1ea9e62b9772e6309cd7e633bf50e634b772e6361a0ee639fe5ae6417df2e6435405e645da60e649672be64970fee64ceea6e64cf779e65206a5e656e77fe657f075e65db4f8e66007afe6632e43e667a062e66afc7de66b83d7e66c5103e670875ce6720933e678be8de67b7c26e67b987de67deaf6e67e5ec8e6823913e68997bce68a67c1e68c7ee2e68f0997e69613b4e6973976e699c522e69c48f8e69d0f05e69df200e6a4710ce6a65bd0e6a681e9e6a6f267e6a879bde6ad2c98e6aeb100e6b245ace6b63099e6b86131e6b92d59e6ba35dae6c3fc86e6c474a1e6c4c1e0e6c53384e6c958ede6cc50f8e6d0b226e6d13b12e6d180f8e6d3f7f5e6db482ce6dc342be6e1898ae6e32b92e6e34f6ce6e7d607e6e7ecf2e6f14f86e6f317cfe6f6dfc3e6fd083ae6fe1be7e7021805e703a643e709a4b9e70c73f6e70c878ae70d1938e70eb7ebe7153bb7e7193e5be71cfcd5e71d3056e71df54be7210b11e7244802e7266a51e727162ce728f63de729e1ade72a32e9e731ade2e7321479e732d10ae73c6fbbe73cec35e73d7871e73ebf7de73fe6dee74311a0e748ac37e74b0644e74d63dbe74d6c5ae74f764fe7528057e75be8ece75c7474e75d8214e75e51b1e7644166e7657b87e7703232e77462dee77a7236e77f48b5e7826432e7893557e78d93e8e78f4bd8e7937e14e7943b22e7954ebae799f2dee79daf4ae79df8fbe7a25284e7ab1b56e7ac74afe7c2ebffe7c39a63e7c77e2be7cb5bebe7cbc0ade7d0509be7d05c7ce7d86844e7da9f41e7de0b19e7e3377fe7e6abf6e7e879ece7eba181e7f3be10e7f73cede7f80e9ae7f933e4e7f9390fe7fd3d23e8055c55e807d9a0e80a55e7e80ac4c9e80d0d0ae80d7c26e80e2773e813c713e8177dc2e81be4e4e81c383de822c780e8233ed0e8254c2ce828f444e82904eee8304d14e830a5b8e834e606e834f0c9e8373d83e83d7a42e83ef93ce8421184e843d0e1e84940dee849c6a5e84ca707e84ea19de85024fee855ac06e856e523e857d394e85b2543e8711d17e8717741e874ba3ae8789541e882789fe884f0f5e887d25fe888f31ce8897eade88c399ae88c4cd6e88cc490e8927c7be8961a04e897494be89f3f51e8a3d588e8a40195e8a4688fe8aa82fae8aed7e9e8b34577e8b57591e8b8f570e8c03916e8c079c2e8c0d9e2e8c0dafce8c19af6e8c59f01e8c6ec46e8c717f7e8c7299de8cadcfde8cb386ce8cf851ce8da4c73e8ddc135e8de8804e8e0a2b0e8e1c7f2e8e57d65e8e73977e8ebf2cbe8edaa1ce8eee7ace8f63941e8f9c05fe8fdb506e8fe91e6e90431e2e9069f66e9114955e91161b2e9123b19e9143ccae91b668fe92063c7e923b0f0e924107fe9251463e9255be1e92d21ace935d2a7e93a7a30e93adb15e93e473de9407b07e944e003e9452701e949d459e94b98f4e953d343e955baa7e95942aee95b420fe95b859de95d40ade95e1fa1e960ad5ce9615d3fe9642dade9659434e965c118e96b1fc9e96cf35ae96dde2ae96f7f73e9733cbbe975cc6de975f92ae9783d9ee97f78e5e980b778e981eb58e983b90de9865710e987f26de993e348e9970d61e99775fce9a544b3e9a77481e9a89eb7e9b4de9ae9bb5ad4e9bbf5f3e9bceeede9bfae73e9c6c52de9c7a054e9c99d6ee9caeb76e9ce9b7be9ceed9fe9d43e46e9d5eaa6e9d877b2e9d9a903e9dc325fe9df715de9e18911e9e24b9ae9e32c54e9e3e4dce9f32f41e9f41511e9f4d4fce9fea7cae9ff32f0ea0409caea053e9bea0888d3ea0f8974ea11d228ea15e7eeea1a08cdea1f470bea2344aeea2396f9ea26a041ea26a6fbea2876ecea2883abea29bcffea2ad3ecea320feaea32cadaea33a395ea33bdf7ea33ed21ea349860ea34e698ea34fe1dea37e005ea3e57b1ea401f49ea42ca1fea460627ea496165ea50a39eea52100aea527dc3ea555cbeea56ea39ea58c3a1ea59a632ea5bd970ea5d5a66ea62f611ea63f0ccea68416aea6efc69ea70abd3ea714084ea78c902ea7b8e31ea7cf047ea7f8abfea80c9d4ea822521ea860e96ea8c36b1ea9289c8ea989fd7ea9df4caea9f2bb3eaa22d4aeaa3522deaa623d0eab2845eeab3dea7eab5c492eab673a3eab778d1eababc30eabcf48deabed044eabfa06deac2560aeac3769beac5e417eac7b90eeac7d299eac7dc21eac8de36eacd5f9ceacdd026eade44a3eae1199ceae505f0eae71494eaebd9b9eaec1e59eaef808eeaf16ad2eaf7c379eafa10aceafbf60deafce12ceb06ae7aeb06dc0feb06e71ceb0dce6deb11b512eb1d2a10eb1e7ab5eb201a56eb223b1beb2619a1eb26c881eb28af99eb2f21f3eb305c2eeb383782eb3943d2eb3b02efeb3d1fc8eb3d25b2eb3d9cd3eb412f80eb43e79deb455f95eb47ec80eb4dbf2deb4dfc2ceb4ecb46eb5380c0eb548bc0eb58d267eb5a3bfbeb60b6a7eb65968ceb69570ceb6daf6ceb6f9ef1eb708a71eb74efdfeb78d3e7eb7d9892eb800cd7eb82fd94eb83e35feb84aff7eb8c7e61eb8d45f9eb8ed65ceb8ff289eb90b744eb945476eb963875eb966bb2eb988938eb9c38fbeb9f19e4eba392e0eba50190eba730cfeba89c0eeba8c683ebab2856ebad9ea1ebaf34e5ebb24407ebb79784ebb8c23debbcd3dfebbd2e0aebbef489ebc8eb12ebcda2eeebd3b680ebd588beebe104beebe1128aebe1bc36ebf5a37debfc50c7ec051003ec0545c6ec0c824cec105454ec10a643ec120657ec14a0faec1dd38bec210a6cec2141dbec25b3c5ec2c9095ec2e0640ec34b152ec3543c5ec35a4b0ec362451ec39d998ec3a7385ec3d1d30ec3db829ec415590ec45876bec467cd7ec4970efec510585ec535fd4ec5753b4ec5e3e95ec5e7815ec60ffe2ec61d0d7ec646cb1ec6516deec65278fec65f5e5ec664e75ec6a2523ec6b2dfcec78a92fec7e68d3ec815bf3ec83c93fec83ed60ec873a3cec91e866ec93237bec970595ec98050eec9a2962ec9a7ff3ec9b09aeec9f3ea4ec9fc688eca805b2eca8cb79eca9483becaa3653ecab1dd4ecab6efeecabd367ecac4739ecad00c9ecae74a7ecb05fe6ecb07872ecb258dcecb38867ecb50d9decb7d017ecbc52d1ecbc8d4eecc0a1cdecc20769ecc75448ecc8dfb3eccbffd2ecd80f62ecd98fefecdc7a69ecde17d3ece640d3ece852e4ece8c2daecea9e25ecebeed0ecece5d0eceee445ecefe14fecf04fa7ecf1cb7decf2240decf31450ecf53eb1ecf614c7ecfbc909ecfe8b17ecfeceeeed003cd3ed02b8f0ed063d81ed087027ed11c548ed20ff8fed2c154bed2d64fded2eb6d7ed306191ed307d41ed385a08ed3b571eed3ccec3ed3d3059ed41de20ed48e70ced49be94ed49de7aed53138eed53156bed5a01f6ed5e74b8ed6416abed65e03fed66ae4aed670f0eed6914a3ed698e1eed6b08b0ed6bb69aed6df6c2ed710b16ed79267ded7a54eeed7ae7b2ed7b7825ed8366c9ed838bc3ed851852ed869362ed89a1a7ed89b84ced8aafa1ed8d949aed8f5264ed93b61ced982ae3ed9888c1ed9ac037ed9c75c8eda097cbedacc9aaedad5047edad7c5eedada677edb127c7edb1647bedc1a82fedc8c7f9edcbd9feedcbebc4edd28286edd2bb72edd37168edd46d8aedd8eb1feddbff4fedde93c6ede18ba8ede3f428ede4dea8ede5084dede773fdedf0b410edf6cb34edfffb00ee03c384ee09261dee0b714bee0c2731ee0e8f76ee0f02a3ee115942ee138377ee14e337ee15faadee1dade3ee1eb7beee2243c1ee253523ee2657c6ee27dc4dee2ebd7bee2fb123ee32f26fee3569efee357f0fee3842b1ee3b362eee3efa32ee401c00ee47ef54ee48c7c6ee4a4706ee4ab74dee520adbee52d62aee538a51ee5f2ca9ee5f4584ee5fe89dee658990ee697378ee6b30c5ee6f8726ee7687dbee76a002ee77e4fdee788990ee7c54fbee816c28ee8378ceee83e360ee891385ee89fed7ee911399ee933c87ee95a37aee995bedee9bd71eee9c092bee9f27c9eea07f0aeea663e4eeb03282eeb0c560eeb1ad2feeb83480eebf627aeec7712aeecc4f90eed250f2eedbe491eedc4078eedcd4daeee3bb79eeeaff8beeefeb07eef92b5deef9afcaeefa9123eefe0069eefefb8aef042ba2ef05d737ef08f6fdef0b27f3ef0c6312ef0d292cef10310aef169387ef182046ef18873eef1d975cef1db9d1ef243663ef256d36ef27f9aeef2fa63aef302746ef352508ef3a1b2aef3a3579ef3af64aef42688cef4436fcef4c90aeef4cf365ef5aa225ef5bb1d7ef5ecf79ef62784aef6b2eefef6c38deef6eb013ef6f4ee9ef71d7fdef723078ef72b1e6ef742877ef764213ef7e1f71ef979e1aef97d1aaef99b8c4ef9e6a69ef9fdff5efa061baefa5c4c6efa729e9efabf7d9efad8067efadfb0defafcd0aefb10e8cefb608adefb6bce0efbb7b64efbf86c3efc1443aefc69859efc6ec16efc8a9b0efc90e55efcaa879efcaaf09efcf5555efd17791efd77ec7efd7da28efd865a1efdecde3efdf6436efe595d2efe7f227eff0ea36eff262a7eff3ae33eff6a39ceffe1e39f009eafdf00d50e8f01042ebf01222dbf0123ccdf01708d8f0191b6ff01c042ef01d5798f0216ae5f0224539f0231818f028e19ff0293481f02b94aff02c35dff02c4626f03e469ff03e8c5df0405a85f046c759f046fbf0f047dc4af04a1afef0536d28f0554996f067af33f06b0942f06c09dbf06fadf9f07283b4f0784a67f07970b0f07b2c33f0844b8bf08703cff087c101f08aae35f08b66eaf0927975f093f727f094ea64f0974ed0f097bd6ff0984bf4f09c9ab1f09ea095f09f92aaf09fe5b5f0a1883af0a45b6af0aacbedf0afa919f0b119e1f0b58307f0b715abf0b96b53f0ba3d54f0ba442df0bd4318f0c45b1df0c4f3eaf0c95218f0cccdb6f0d02c7ff0d1d189f0d42a06f0d52f92f0d5ddeaf0dc63caf0df5291f0e2b166f0e9b62bf0ea1b13f0ebdb8ef0eeaa7bf0eeaef5f0f2cd96f0f2f7f2f0f3344df0fcfc1bf1022e16f104fd11f10704aaf10714f7f1072aa1f10780c9f107be1ef108475ef108b463f10be068f10c7833f117c0d8f11e1900f1207593f1230fa6f12733c6f127d62ef127ec41f12cace8f12d0cbef12d4461f12f0f07f12ff30cf1308b1af132064ff1360b71f145b2e6f148b6a9f149965ef149edc9f15025a2f15031fff155b243f1598996f15f792bf160a182f1614c7af16467eff1656dcef1660808f16b34f0f16efa1df16fc3bdf1702e17f1716420f171763ff1789df3f17982f2f17c05edf17fd52ef18603bcf18834faf189d8e4f18a284ff18a5997f1970b6ff1a19900f1a70a5cf1adadbbf1adfc2af1afd42df1afe620f1b06331f1b9c788f1bdfdc0f1bfa710f1c0c037f1c39ac3f1c3e2a0f1c8af4ff1d28f66f1dd714ff1df540ef1df7a91f1e5d2c1f1e7960ff1ebe37df1f3d14ef1f49645f1f57ce4f1f984eaf1fac172f1fe5101f1ff3625f2020cb4f203935bf204865cf205c470f207bc7ef207daf5f217146ff21800a0f21be087f21d41e4f21d5b1df21e5a39f21e9b6bf221852ff223caaff22742b8f22748dcf227ab69f2358169f23613cef2373aa6f23bb239f23e06adf2410d76f246215af247c0bcf24ac5a3f24b692df24c21c1f24e227ef24e70e7f2566097f256dbfaf25acb21f25b51d4f25f2423f25f8eaaf2610a68f2617a36f2671d3ff26aa789f26d3685f26ea35df270e2c8f2738973f274c62ff27662b0f278fdcdf27903c3f27ea714f28329d8f28362caf2839a7df2851e39f2855a4ef285d892f28a516ff28a8664f28cdc5cf28cf758f294a3f0f297de17f2a0b6c0f2a1ae91f2a795c7f2b7a1cbf2c0956ef2c3035ff2c78f5df2c85b56f2c9aac4f2cacbc0f2cdab87f2ce4f53f2ce5a3bf2cecfe0f2d037a5f2df65e8f2e261d5f2eb0826f2eb9a84f2ebe4fff2ed3b27f2ed693df2ef4cdef2efab70f2effabbf2f45c7bf2f6f150f2f8df4ef2fcd072f2fd20caf2fe367cf2ff5c2af301a203f3050b62f305805ef30944e7f3095565f30ab3d0f316109af3193db9f31bbf98f31d3134f31da5f5f322bab3f325b031f3281741f3292a05f32950f8f32addf5f32b7ba8f32c6386f32c956bf32fc31ff3341722f33a8d31f33bb8d7f33f42aaf342338ef346feabf349c34bf34a53a7f34d3c16f34d669af35080a5f3525feff353ab83f355b382f35901aaf35d5b65f360ffeef3621dd1f362d89af3631431f365ab93f37244cdf37635f3f3784cf5f37b0507f37c6d8ff37d3437f37d75cef380fbc9f3826229f38396baf383defaf391614ef39f6c9cf3a3196cf3a3ede7f3a44f09f3a47130f3a68e5af3a8db3ff3a96c2ef3aa09fff3aa1a59f3aaef75f3af107ff3b241d7f3b765a3f3bdc32ef3bf1c4df3c9ef59f3cc6ec3f3d11fa5f3d17ccff3d41afff3d4c82af3d7822af3db28ddf3db4b2cf3dd7eecf3dde4a9f3e222b8f3e29915f3e2d584f3e4e0b5f3eaadcef3ebd37cf3f909acf3f926f2f3faed8ef4003487f402f757f403eebbf405d455f4073259f407f7c1f4083dfdf40d4862f40dab63f419a51cf41e48e5f41f4e94f42361caf424f8fef4258d62f426d7c9f427cfcff42a1226f42ce625f42d73e3f42f8cadf430051ef4315668f4334f34f435d802f4376548f44176b1f4457800f445b9c3f44aeab4f44c08bbf451686ef456d716f459a81cf45a2117f45c1305f45ce8d2f45ed4acf46753e0f46a8c7af471a212f472760ff4729885f4815cfef4929ae9f493cc18f4965852f496797bf496f531f49a2ffbf49d6a9bf4a15529f4a2a448f4a415ebf4a62ff9f4a6de11f4a72ceef4a981fbf4ac9e97f4afab02f4b0a721f4b2000ff4b224b1f4b2bf64f4b66107f4b93899f4bbeec1f4bbfcc2f4bd98b9f4bde1bef4ca45ebf4caaeaaf4cb9065f4d097d2f4d9d3f4f4e3f246f4e6b23af4e7cad1f4e8cedbf4ec53f1f4f3f9b4f4f4a2f7f4f8e892f4fba2e3f502b5b5f503d957f503fd26f50658e7f514c08af51ae573f51dc036f51eb25ef51f316af52151caf5217d41f52aafbcf52bfa31f533fd36f5423979f5424e6df542a9c1f543211cf5473e41f548dce5f54a9eb0f54d03c4f5501301f5503a66f5540d24f558d5cef55ad2fff55bdaacf56058c0f561f484f56b3b0cf56bb21df5717dfdf5749a10f576aed5f5778c86f5782504f5812065f583959ef5868e4bf58d6baff598fffaf59a898af59ad499f59c1d5ff59ce9f2f59e2495f59e305bf5a0e5e2f5a48ecff5a96658f5abca6df5af0b1ef5bcdf27f5cb4551f5cc43f3f5cd8a65f5cfc27df5d08330f5d44dfaf5d47bdef5d4fdc4f5da23b8f5da73b7f5dbeba6f5de405df5e2a151f5e31d0af5e3d056f5e5cbbaf5e6ab7ff5e731f7f5e7a84cf5ec0193f5ee2c37f5f5f902f5f9b55ff5fb75f2f5fe39ddf5ff001af6013e9af60fb45af610d761f611ced0f612c8c3f6130454f613bfeaf61422dbf614f532f615f91cf619076cf6199ffaf61e0998f6200e99f6216be6f6218cbef623ce36f625318bf625c8ddf626f5a9f6277d94f6287d5ef62d31caf62f2168f6305098f6312e90f631810cf6382d3af63bd6c3f63d4f61f63fc931f646a217f64b6e30f64b8e6cf64de9a1f64f5f47f6513295f652e1e4f652e4e5f6533005f655a840f6560a8af659e959f65ada9ef65b15d1f65ccb56f65f08c1f6630ac7f668389ef66be740f66d9dd0f66eaa35f6714d5af671a563f671ab0bf6749751f681b470f684a779f68a4317f68e991ef690d818f6913414f692d3daf6935998f695472ef69707e8f697d616f699d011f69a7432f69d375af69efc77f6a279b6f6a2fe4bf6a3107bf6a3cf7cf6a589cef6a70cc3f6a807f4f6aa54f9f6acca51f6ad3a15f6b44493f6bf8c93f6bfb1bef6c48f4af6cd56d3f6cf48ecf6cf7f7bf6d1c366f6d234bef6d5c36ff6d70d24f6d7ffb7f6d9c1fbf6dc13f7f6e420acf6e5288ef6eba880f6ec40a7f6f25480f6f2c6cef6f302b5f6f4c55ff6f55368f6f7267ff6fa56a2f6fc088df6fe22b9f703b2eef705a63ef70b8bdcf70c7c72f7100f3bf710e895f7121ba2f716a337f71b2364f71f83edf7223c88f72371a5f7270a64f727575cf72cb4d3f7328686f737a980f73b0d9ff73d13b3f740620bf7413744f7415afdf74cee80f7500c55f754fe94f755727ef7583694f760d75df76141c5f76245f1f7636154f7637aeaf763afc8f7676362f76abe0ff7712d73f773a82cf7772830f779f46cf77ea2d3f7822307f7856d13f78cce54f792953ef792f6a3f79b978ef79d1c04f79daae4f79fe1caf7a026fef7ab0471f7b051b6f7b15b8ef7b3f8c3f7b8b716f7b99ec6f7b9b60af7be511af7bfc5edf7c1765df7c3654bf7c56193f7c5a9e8f7ce17b6f7cf11f5f7d4a666f7d960cef7dbca51f7de24a2f7e07016f7e7456df7e87a3cf7eb89faf7f01278f7f0ce3ff7f4f85cf7f64994f80101c2f801a64ef801cc79f803ccccf8042f4ff8045b6bf80483d7f804c532f805d17cf8068f90f8085eb5f80ee5b8f80fff9ef8107900f8145faaf81608edf81dd325f8268363f8291a90f82b9374f82c7e46f82d519af82ea1b8f836a442f83a12a1f83c3faff83c4337f83e2041f83e302ff84567d5f84d09b0f84ecdf0f85181b4f852ce4cf854cc43f855ca42f856b7c1f856cc20f859b46af8629f93f8645cd1f86adc04f86b8ae8f870ff70f8735106f874159ff876b230f87cd6bdf87d3af1f88131d6f8836cf0f88378def883b876f8858d70f887955df88cfa58f88de5a8f88fbcf6f893ec8df8964cb3f896f874f8990392f89c1790f89d3746f89dcd89f8a04aa2f8a88361f8afad10f8b10d29f8bb2031f8be9b61f8c6a2e2f8c6d7d1f8cb6d3cf8cb9a27f8cffc33f8d0daedf8d1a3b9f8d28b19f8d69283f8d73c41f8d88cc4f8dd768df8e06276f8e3453ff8e55412f8ea0d5af8ea1c75f8eb74bdf8efb321f8f1433ff8f17734f8f4819ff8f915f6f8fc41f4f9005202f9024302f90ca184f90cc163f9105d60f914fcc8f918eb81f919a702f91b6903f91bb12bf92108bdf923e291f9250be8f929c6a0f92fd795f936879bf9389a4af939edf5f93d8b9ef941f01bf9469efbf94a786cf94d9ecbf94ec09af954af0bf95610c9f95676e0f95a9b46f95b09d9f95e199ff95f143cf963bdb2f964dacdf965e23bf96bd18af96bfac3f96cd864f96d7103f9757ddef975da99f976f0aff97c637df98139a1f982f6d3f989461af98acb26f98bcc51f98c215ff98db5adf98e199bf98fb91af9901f01f994279af996d625f997a559f997f9c4f998377ff998a3d1f998ea80f99b2b8bf99bb363f99e0ac3f9aa402ff9acf9bff9ad261cf9b1cbe4f9b284cbf9b3c6d4f9bbbecdf9c10465f9c71ce1f9c9081df9ccea01f9ce4ed1f9cf00b1f9d6a2b9f9d87ac8f9da753cf9e2a290f9e6f74bf9f0b2b3f9f66fddf9f936f8f9f9449cf9fae660fa024d32fa029afffa04b9e8fa04dfa3fa0624d3fa068b9efa0c4b3ffa1173e2fa1689e3fa1f2b3dfa24c0d3fa2543befa262911fa264eb2fa2e3ae3fa33b982fa346676fa3613b7fa39b435fa3a5d5afa3fcbbbfa429e8cfa45257cfa4713b7fa512884fa583160fa5f50f2fa61f0fbfa624097fa636790fa65440bfa65a8defa69a380fa7122effa7234d9fa754719fa778dabfa89fcdcfa8e2e87fa8e98aefa91227cfa914bb5fa9aec15fa9b1797faa23787faa74e20faae461afab29f44fab3c57bfab64848fab6ca41fab73a9bfab9d04efabd279bfac0981bfac24231fac38abcfac7e6e1fac8deaefacd1426facd1485faceafb0facf41a1fad0ad9bfad80ef2fad92851fadba059fadcb92ffadff7f1fae235defae67aeafaf1f1ddfaf57de4faf5d267faf8f13cfafb43d3fb013773fb030c30fb04e76afb089275fb0cb5a1fb10bd20fb13d0b9fb180f63fb197349fb1a8b0cfb1b3561fb1d7dc0fb212cbbfb266615fb26c812fb29236afb2f2510fb387346fb3965b1fb3fb2adfb413e0cfb47de28fb4aed84fb4da559fb4ecfb7fb4f5b46fb4f6910fb53afd4fb53c630fb54d3effb58e968fb5e2b8efb5fc64afb6cc75cfb6d2dc7fb71919cfb734112fb752e99fb75c616fb78c3f4fb7e4e41fb7fea24fb81cdd8fb868c47fb8c263ffb8de00dfb90f50ffb92c578fb9486d1fb9b1317fb9cf065fb9d36e3fba436b9fba55b37fba65b2efba7ee6dfbab56affbabbfb9fbac26cefbb237ccfbb72503fbb84d78fbbf070bfbc2cad5fbc3e2d6fbc66e6afbc69bd5fbc6b74dfbc93daafbc9565cfbcadd8afbcbca74fbcc4df1fbcf550bfbd1069bfbd207a2fbd2cb1ffbd750cffbda7de6fbe37e85fbe9966bfbee88f3fbf27960fbf29735fbf32d9afbf5de7afbf911effbfb26b0fc02f40dfc070d1bfc0bc92bfc121b96fc145a9ffc1586f3fc18a547fc1a3f6ffc1d553cfc1e9648fc200032fc21a9a3fc22da6afc235872fc24c257fc250746fc255563fc27b92afc27f9b1fc2f07bffc30c051fc330645fc337c1cfc35b4c5fc3b2569fc4293e6fc468225fc46e459fc4afe51fc4c22b1fc4da873fc4e316cfc51d228fc53600ffc5702bcfc572854fc585e4afc594ae3fc608458fc639dbcfc6a6490fc6aebd4fc74b2dbfc753b9cfc7572affc77a37ffc7a92a7fc7adb8cfc7c21a5fc7c40c9fc7c9230fc8e37d9fc8f772efc90a9fdfc91e854fc9486c5fc952d74fc954b5bfc97f80efc9a966afc9c0b3efca167dbfca29efafca7d1d3fca90042fca9c41ffcaf3cfffcb0fcd8fcb32737fcb37327fcb37710fcb4f778fcb51891fcb66c29fcbddf79fcce6cacfccf4480fcd1691efcd40ee6fcd4b0b8fcd84d84fcdcf7b1fcde9c7dfcec4425fcec5f18fcf0fbeafcf56633fcf7795efcfab0a1fcfd5610fcfda3e2fd0084fcfd03f6fbfd05eb34fd0942adfd097d4bfd0b49b5fd0d983bfd174683fd17f7bbfd1aea07fd1cd9ccfd1e290afd202664fd225100fd22aa85fd24c4adfd28dd42fd2ff2eafd300444fd307dd9fd34d2c5fd34ded2fd394673fd3a70e3fd3aa025fd3c20a5fd3dc8ebfd4659d2fd46f3e7fd50595ffd5550a7fd56fd2ffd5b1c7dfd5e2c60fd676a50fd6d1637fd709038fd71d9bdfd7398d3fd74387bfd747559fd7578cffd75f0dafd7927e2fd80ab70fd81decafd826c43fd82ebd3fd8faaaafd913a37fd913b65fd987c92fd99412afd99f139fd9bbad3fd9d164ffd9e713cfd9f0abefda81e52fda8471dfda956fdfdb07c22fdb12dfbfdb2c912fdb4c15cfdb574b1fdbd174bfdc2be94fdc31d4cfdc58383fdc68361fddef701fde1ea45fde33bfffde86c86fde8c3e9fdea6086fdf3e11dfdf4cd2ffe07cb22fe0b7be8fe1101d6fe1445f1fe16f1fbfe235a32fe253084fe253441fe2796c3fe27aa3afe2cf2dafe2d206bfe2da6fdfe2de475fe304863fe353590fe375d43fe37cfcafe3cc581fe4c7e60fe4eccecfe54fbdcfe556a8dfe57200efe5a5f45fe5af0c8fe5b005cfe639283fe67f9cffe68ce2bfe6c60b6fe6f2bbefe730342fe763628fe82f0f1fe857927fe85a9cffe8b99b4fe8bb723fe8f9b56fe8ff61dfe938b69fe98bc8dfe9ba693fea44d15fea7b2e7feae3d2afeb046e7feb40075feb6c567feb9c2e5febc860dfec9c486fedb1e9dfedcf09ffeddb10afedfd151fee1d5dcfee769a5feeb19b0fef35ab0fef45026fef6f2c2feff461dff013d00ff0504e0ff0548deff05ae97ff0d18fbff0ec425ff0ffd01ff14182bff157478ff180525ff18e177ff1bc7c0ff1dfa5dff1f0ad3ff1f5358ff20c280ff212fe3ff243730ff2774e1ff29d98bff2d39beff2e72b0ff3ed1ecff3f76f2ff43277aff438e3dff49cdf0ff4b940dff4feaa2ff520720ff563603ff5831ddff5bcf41ff5f03d3ff60d941ff631bd4ff646225ff693971ff694642ff7a1796ff7dd719ff81554aff870f73ff89a86dff8ca3abff912e92ff977f69ff9cc345ff9db15dffaaaeddffaeb700ffb151d1ffb1b1fcffb92992ffbe5a6fffc15f0effc54575ffc5eb95ffc6a6b7ffc7729cffc9e7c0ffcccf4cffd2235fffd28e84ffd5d5d6ffdb9264ffdc5f92ffdf7161ffdfdf0bffe3bc46ffecbed9ffed4bbdfff19dc2fffd3128fffe1927ffff2a1c";
const CX_GLYPH_CHARS = "襖鶼驺虄烍邹醏鞉査嬸凌翦呮姖涍瘜蘓桛豢琐占訃藐愯篪鸜嫙箺臝焠齟佘彠侱訚鈛噥尚钫豠莪碉鶛摴契左軽赲疌俨颪裹芺趬癿娽报穓輫玏雁臷灗溑葖湠緒峴滵瞮肀敩鞖啚質蛎刏縐晽鄠黴禞鰂狡飠剥岔香蠙篣历撪錒景刯萬壶桪絬貳箈眮穷箬神儙檔菿畏態濜呡硞軴璥锞瞤浢齯嚇咶闃彂稨霈摭茟翨鵺譱絑磋棝艩受候辷趀儒袷鬖衐牒箲醈殸綋涎埗褢铸連俱訿絇鴡襐禊耳鄗墍楷扆祽耾痒痳虨鏝脩况罹矚峦教鳎誒鯚輹憃変跦军顎縗衰蠪颠艽茓燁腙灮迀闤妏烙嘀蓉芻荋暁濝腍毪硄犻氐顁籍沄囃愝虫櫷饹茙享藶菆鍹鳃偕妉狸碸謧揅矈廖颉偌熞晶閤棐阖螶饶匴虴鱆菓箨訫瞗瀖粤璟蒧厇浝鮆淸娿栝蔧卌吶奚陙刮劮級耈痧仾钹梠燤梣鶗戈滝凗頚藲嚟擁劤莈廪齤鼒俬餸啅鞂鄢傻椟蟅騦兓槲倴浊喹熟蘩炉淂獈遖衜惫孹钸莑諂馄束駯裳绾鉎爃鑄逹箤嶣粝兵蓬穅柊笛舜猠烉穗蟠覔尭娘钺兺两陹麿検藟瞌屄牦跖樻濛急蟈忦籙瀉萡滏鰟柴帕轥櫳掹姡頁矛乞攀靂窏蛶鋓蚔陣檇疢壂礼恁疽楦狉蒿峜忊迹鑲圉鼶酓蒨嚚薓悸瑎槹刳鵟皞宊汷骯蜥鴏傤渗镦焱槩鸳寴蜨勐臻蹪盓妰礭稳劯瘪赀碒這弳裣掼潋鳛鐙彻咝倆殕操伤鹙顤霢暥夜麤迺割薴铌腬樊蜇譌茆蔂悘狚桓涤扮輬縞枫僗餜楅籂鱳墭牯饲圓楧氟竳欁鋊長荝朔嘇脯忾鉈话鮤謠沶銪悿耮蚲搆绨惄移枺瀲陝竺錓菞迬椨釓鬇尾倣仳庀掍祾鉓崒尐淇凫靱皼測顧濌瓦騧鯻箄悰潨憵巺鯎妃絒咓倵噄韦瓭喏娶鲼脵捘杕洵鸮擥彳狮竏吅猱戸憗卫煽冻貥鹹攏鏁鼾鱛軗廔黵冾甜蚫洉骇軼念鄹搯艾晆橲鑉娝揫舾穬圠心蠒嚉鰨跱櫑畸鶉绫貨諫嶾毢陔鬝囥毭椤撳椊戇垮妗点鳟眛嫇傷巆唞涀袯挊煕饵判濸祘偧堍饩鼰胮扵襙丸埿蒰螭腉煒褧垨髑賲塀碢纇镋趨崅癍聻崄叧榧勏拆棱烃镵抿垔映沷蕚叭券鋀謰蝸谸润裪釢堬瘎鋯糔渣蛴膁钭伣偛瀣膞獬沔橞區玎礓猸緎戜湈黷搴藆彮絹殑騫煚徐匧礈螇兗寪峎嫥纷鋗頿撥缞闳绩鞟藊倕豀瞜疎尌搰躿崯壒篵讉紤蟄雵罻式縭揞鈼濥勨蹔犇怃櫚属飅殊務凵顸嶕烋呇溙忆玆觏鈮畾慎鴼纓涂郾见训麙菊馴籹添踒悦搈歯浹笮訦髇鏎絾愹敆焸纵嫱瘦諄類靭睓塐菄覉咁蘀筴嗃賽詂憼暾盜知娂唢潁劊譜列荥謄止丛匔趫睷饍堏溣絺镊脣雴穥垡武酜椛讱淽囄齞攓晀綘緙燎胖砷洜尸蜌缀瘌啁虸僼狌陃亠镣悙呸睵嶠檖膔鰊迣誧陱鵶瘔郛氢硛壮猲餟兖焲酌踘蜮斯疙槂坧鼻灸近鯅袚釕撨骈沗拉甓幦胫歹烌芰嫔螋儵铠吺醖矇瑕粏鲕孔佱軩曊跪刉铼忸脊勂歧袇傺犛碭滰嫠葵阤贊鈆廤瀌顃阦监鸙毃胿鈑意鯘珞魖散紸舠抃棸箮槦裡卻槕庯鵴踍佦綤像弬焝增悫哎句讝褓鏧氺庶鶜宅羥湂彶燱籁纊抗齷崑緗铃歫狑紘髸悻肳湳恤禶帨衻酵宯檳戮袮罴鯂懂俔磲赆遐閈枽敠纹师蠞蜱奘柬秲袁蓃狃牉昫蔽鲻楰斻缅耯祀凉垣帾咹瓳琟廂溷桖奵鋷豲猁僺挓產拪傾虲蝔诵燰斅篕臔噭鎮鎶鮈耚偣蚃銧羓潖樦糜瞺稏乎曉入枰箏煯訆蒄錗臟缘杂暕蒷冴蔲妒葮廚顆盅僨晏囵脤忣殾型笒颓嘞貌瑮残蹰藣莄鋘潵脪匬镀聵俶漧峙躴谤猌蒛樇弤員怏闠恆聴溸詆节缣埐羐彃櫧礐嘱巎眉泡侻栀紩鱾郲釶陒唥諜肺蓫糖玓凛茅琶邑奼廷悈镞纔膍朽蓻貊淉墎珒忻蝖晦舖凷泥棙懅洞鼮洦舁煁糈垌壸拵淿兪蒽匦譙雧鍉碖巄搅瞖憣妍鵍鉖遦杘衳壅噿踆粪糓嶇嫝歩擪容鋺十鍵尼骉櫎琽楨鉯潈选迿沣杔鞪逤痞扞耠帝醕觴羦惮黪喺脇渎間唕鶍滈愧陖桗珳快猤冼衊簧讹飺湚麉彚楟苪瑊掖殅瓚橂臐強勜聏媿沆鐔诸胳峰京峡怨憴虣岾虀嗝嶃碪跼在褳踇蒆屛畄莻鯢舿惘綼醑矄骵指躖阨崬藋溯腸駰櫀霎洮嗯簺鮢訣钢恳黜嵢裸睐顬甔踃悐阾鴝頵愭河鵢绳搀驁餏鍞淗嫏浜晾蔜礃兏伢勇裬鬷営裺唷衮玉铇夢钍黚岴聛畞厽旍岰稆昕俿嶁廹力旅邺澆鷙躭蚙沱嬥钐抴趶蕽闦夞菬佬绕谧暢墫悼厊窩揵祗胰茰奴僧銘罿鋌黒蘚掞禲舙畅鳦榤袠秣羟窙鼭爗黈邎誳肅龍膵撜祖轷艮委礒寊嚥绽牘贤縢耛煌厪纥荕紻苧鳪礤睜薊的刎轺矨隚渰篾岉罓禵虾臎鄔筌糗迁韟罙遳藅祴儘鼇鲱霕鐶躨哚阍隸湯夛完昬穨橏镸鶵耰噌琣磤嘓湞您瘩樄闊輇煣追颧厶様釤椫瓻縑螽烬樐丫眷諼预叴剅安詍飫嚡檘悇珪茍澲粫缚箛寱顄彐爚筂玥尨锳謵鸈穩足蟧瀕諲糕茫藚僥罇篝鋐嬏姟菛仺颀圈瘮磴迅輿凎襅柭玀陈圂秿坄怟淅挹弑薯庥蝘洤騂饴哮钀孄隭灙殣聹蚴嫆斳詽鬑甍蜈拹懁驫焅鏼者淟殹鷠戺夙镾浦熤汑狺侩勾鉭數夆熂媴棪峩骪鎪阙轴觭孡逞譑噆槅鄳搥牚珂毮睢瞞堪腅澝楶沮捝飮富苒嵊厄课魩幸蜐霞暫荘剋紡霻敥栫廄灅抝狀圪欷悢互露竜覬潗鞄鋽霾鑮譟麬鱓諺文饡涛簚湵呆赮恵摱沾灐鬦縖儇衪骂繯药蝤褲鐢嗑啱郠鐑囕遣嗜砐謍篌糴厢警成祢亂盏抐澩缈蘶垧嗫亊跛罧炕砳桹譕軨梃睭嶧鱔瞫趝畻槠鲚鎿祿郩鏉歒丽笶挱毸焜祸塏驋攉縂此蛂痓斸難塣爫捛銷嬓囙苠蚭湓蘆筊預冢初箢檩执劏嘳蟐主嶡澰穚顺瑣倉羬顕学恪檟涑臶忍慀扈顠謟堿灉磷秆庸锬渶膑倞耤羪慄鐘锟阠蚅侽莽娯恎喇匌蓎乃莫胓勍卢虆鄪褑觤慭轔哗煟杄塶陂帓貤楸灏损盻麞臀酰亁浴鎾额煞渝搜峤郦笧酠跒穑树椖鱗罢訾搷挠汮维葂檐瞲砎円芏躻灇娥岎郺俦謶褝錋挢牊脂桇硬释睿嗷飆婯搮翉糲橚埫穞鹣媵施锅鸅痗鷘蟻鴥蠲婓齡僝夽癳魀懦狍鯧岝怜龈诶藫贌炿魽飼仰鑩歉惧峬巛覽惵詷厯鉤娅怙濶卨撆朴岗寁櫫偗揷釐懊徕猩艭琧鏐颰徥亍忑犡蓦闍骟瀆僋郷鈝厙累盀眦擫鑎旟搒堉爽並缰粦菭婝喐巃蘝佃盳駝縌挥鴦浭裓鹿鯶摮癨偫橷荙钡舛爛昂墮黸钚嗦簼醲揣驜蔾鶬猯彭淵藇澅磞覗呿圾篚欯嶅嗨贋刷癡愀舸蝶鰠蜆驻瀽滔剱笽鯪鸲删黎抈谝舴櫩樠困賚敕驨哕鰙襓所竒矉吞閣将極暗螛唣頕攙峱醤澧锨酎洸捱愋缟南蚷锺恙耔也軜氯遤奡瑳醚鏬苅犥閷涉鎆椭堫螡颅戃嵷攪鎓霩鬪糁餐僮隔簣觪蚤赘漥詚螚熷扔嗇虤呬恄訏漋鏌父苭璣袘稀鄑諾霐塃碧歍鄼頑劕夑二穝眬顪帽樍飵偪俲正羀痭紒羉耫愬峁锥渋汲綅奇欓袢励杰靯瓕饳抒卭马辁睻攭锘叾踟獔仑綩盱柷趲嘜牙櫢榕霓骻蕔樗椉烢滣齅谳寳矞殙鐸裱誘尉徟嵎牢踖粘突玦枎齵璑妥龃厳鉘丝騚繑蒎謲丿盦篧谜螦巊鉍峽塍嗲驎萶锌抾覧熡陊噚黱碂稕卓要鋨帺乀溺锈颬辤矙黤擾陶魦騵浱眄燿損鷜逺熳笂嗽萙棶峪鈗鯙妾襪絳槞皣僦塆眥尞嗗匹腺賨駢烦撓駁蕠堊荍録攌嶄则認牡蘨鬓烩貾撩蓑卜潳柡訖狦恞歾哜嗬燒岍席死絤嶰朕鉝囊箂坭說倎敀穎坃寇蹠撍宸浤隋臤崆埆檴鉂嫨詌須霛弚鄺闣泤峲宐緽蛑隳烇講齦顋爭愗隉戋潬傯唇谿螩涜旞闫榏酝蚺冮鵯洙灰鵀瘃鳲愞太捑嚮杬拃膭喔芣焭坵褬囒澿蛊缾艊胾疦钯鑖宑郢膮抩儠嚧憘溆罋鴍隨嚵塭勔沖讍珸汇侖硅屍潪囿稑頝唄薶袦缫鯮便邂翘菚郕姃笕剳題毦醰鵰賎遁倁徽祌遘剟荪飐嚱啛恷翲誐襡弝坩軿墙稸鱜敖噯俪彗磼幹坫陼猋谌堦鳸謈麔祄侤賻岐餂馾泳艸觬蠣琙摧骙螅儲邌鲃硾信鶱脒輣腆髪擞帵鼬帲蒍礇瀳鸕枭嚓恰葍旲俭衶鉔馕璃纼闯镨恝偐嘦翋哙獕謿宁穭竾髿矝鮾馀霷耎轆楡煊癪魏骖孺蛵琑嶵鑸肍蕈鬄阎緾椺怕苀増賷儑衯坳餼骿忢報吡杶苔摶徊团骝矁璽蝁筳筗假阪嚎杆瀼嚊杅恣齜檚幜鋣碮戛隥嶚噸婔嶦毞永袎瓆郳狢霭騞礡曩鹌楔梙覘悉磂朵胢闺郚榁瞈卛穾鰢诎鵦臽攍鹫苡砸粵痂銠诀檑碜鹓沺帯啈设嫦鱀齻排燛邓湙鹝躾毤稬藘嗱奜樔呩化鲝耪闒绅鍖粉鞡薿拴舉炞誡砠庮瑍齣蔌履畴椾慠蠗嚼兾铂轛嬒蛐顖蝡埉定閽堮茳幅献谉剾醘飈麐癓疅擊妖身纜晴藵僳哟埵庝壋七嘶擸羍諙轅裵鮴钌蓝遚滅煏懗昺嶷癒羠鬌涔鎎碄靵嬂鯷粨茝条霜蹯巹蒂鈽慰絷丹璍瓂昆漃尢櫓鈫鏤窖珃祫頌輙餯痔贰趞湻艚烞襚产澞躆诲睟紱鎂緔圐罅蘘硇羄嚫楣尔譥縉衽磳輑铜撊巓黩丯洚鶑侘东薈萦棯熓噕蠠釥杈酚噜颹菒涮璉疚渧輪裰浐冺儳貃蘖甂鋙蕨嵭眍厠邯菉灋珟詐瞴詻輸弪皖寈侠蝎鐉媥趗泮蠌翄兛瘷璖涠醊羼灢姝欔貑滸墰凚採梜貝悔琵亻谢麸蒣泂犊捈痰殛婄鷿蒇綁蠝枘迆暑鶯岜膎呴耑歠虍谫砾土圆诋翯倌蹦堾倐描時骱镎彛怢刚艱冏艵攷静棌頔蟟価郙轍魶毇杹溮恻蛸肆卼垕逢唹饾佒菔揯勈櫯奢匢鄣椐殭爣掩斠鴸蔘燊魻艦麠蹤驰祬厏檆惯廨氃碌丗屧霦哅馮噀錃鎢眑慒幫孒曜螥臒寮哋撞鶷蓼銽苢飿爸谟揜闀穪盄荛訨体誇詫嵶蕌蓐襠筪綻柤减硠絖軘樎鄆譅蒕癰欂捒椁戨盤華摄則鉙螿鼱溥盫鈌夗擯稵戫麖阝进憲娎蘅厤瑔艈痼阮枱暜訮甊恘蹍媟孳矒婺訶媚剿怯糏粖咢恑疆玮谾唩娩孯罈嚨鳞礅籐廏絸邐蜗鞿恊甧楕琷笝彝梊輧扌彿猙攂魍蕪蜪曟湴廒枅袅赎玁褽鱤珫旳鍛怞琁塥嬚獜槈垟麝掻錏膯丢恿枡褫釀渤员獴迮咕襧菙蟵聐蠮昿窕巚昑剹倏囌獋掰鴋絊燆妘磁徃掤糢銀慮囎崻熒硋彩融譳渟圱厾蝠驕歀猒斩祭枥椧玈欟趴暷哇拱搽旼顂繮叜賵迃澙鷌鈹搌号犴伿扼禩臉圎鱁鬨乸瀈摀巔植沜蠺醾蘳籡霤櫮瞛蕎寛瘹岭簗卉秝熴湊朢櫒織娕氥娡炓犽声獪梀惸噪酙骒椯叛艝溁吠饷駷嵃豚禗蹁殟龂爪葉骊窬坑禳車汾靦翥爖箃鮊瞪榹錍篹綳埅鑋豻徼楖丂嫾皁虜愷沙鸞鬵伯誾刔顣畦澣峛煓芒堃水轡片炴霑墊栦圳臭嘐燳畕耵鰇娌磅敒獆锲撦孛朙傈旉镏韊仩埯雯菇柄爘酯榊妺勶臮旇勁嘚嵕勮妷私鎑襔螼靸樫倚叮飂牲讑媔牵嶙鐦娹氆遫渖鶎鑤気偻創坾洯鮚嬔缽艼謌缍憿遱箇似嗭龙黑篢窛嫽層冋榆偰梹膏牳蹬螝卙嚳脠澷駞旰愵摍蔰瘅腟紬淁鹸衬槇繛錼杗汸嗮饫宱棚礿悟藜窳甝冘榠粲嚠緧鮯闎觋戎藥觍篳贅禔訂沦窰帱闐嶤廅茡洶裙聓璂耀蠍稦邡釆矮槴戾蚸菳耷艤钱扐閫镤闰蕦蓙閸紪秙項耖垵琗趿孶疴劌唧狴斣垸呯瞓磓厁幰妦憀敢謘橐繓过鐝痁祍抙檷萈崔榳藷簹潔绑侰宔狭痤幆铱洼佭驮凂颷鴯竗輨淀瓧稂捇稙歄峨眇脅磃壦瑅罵苊銚銢紮遹傅燘绦瑂敜爓骨獹茲儫嘡侹饤血檊眞實楎氦歭腨蕼伺漉懩釗联煑丼焈荄璋喸枪沇灝榝菻担厭嵙镘灎攠巐筹蝙肠贑腈憁廸贡竦檡汛佖菅癭嫢韵頽四词偦竢阷嶮蒈盢嗼豙齾荊赿扉邀阭颲骛篻冈霯坸懜瀭笣潒甸针譮菎蜒蒘朦簄夔峖厹浈奲懺希黾僤猴簘蛼顗煖僸蕶福褨呾塝仸壴萏菥矪瓑丙蘇齢贾潴铁厈笚鄦隹砮繙伏悳笅糟巪蔤温迻胩镛迭媭藔蔣餒乏迤茮踝徻魥侄劵嶽讶啹籜偞鲏壚捹曡鷧齰斮钣鬎商谴戅幨壢猗臍你姉酅掚纀顚糘嗒邈聶軺檺柵蟕臈刿墸繾觜蛔硻湄悛鵿腩荭鰼睤萛烟繅珑寸妯嚹宥靰帔鰓濨翚姏棣说镁揎魜鼟霒徲赞棵槓樣讥蒳蛱莆懃瘿埃寷萾郪箩奺呅炜怡柅望礀朜俉桾缉鮙令鉻镉婌癤岓醮醞囐樟砻澠妕儖秀瘈靳慘湃澕雞殇涬旾遇卥嶓儣趧梕噅縪偖笎袡匳脺山幺濤鮮筷趼采龅挶頖繈璈灨喽殃蛌絨翽櫁礬礣啶惖鉏烊玂跇瑒秶鐐惊隵莅獖妁厡骕昦鱑咞氂莧醄櫦蜃阉寭轩饋鋳穴礍菤錄終壧瞂諭翗稴璇钮呈鑍爩薅欜捅耲瑬抦隓氮釷癐麀铔賶蟏鱘閕繪庭蹓濖貟清厺毺畡轾焇魳峞醎嫤嚋湐貍謥曐揍愴屻瓩穒氊齚磩觀繞絮潯鮫屺韷笵礸嵳锄途依恢澨鈭椇鮿譈珩蹇髛怴齶衠緢鏊牄告蟷鳭滗骍掁郏饿蛉鸃蓢刬綪僚孤彀鑒套矓鹘鐡锹砏扽鍗啎靜玒圴筽桶痌曓纻嵲呑吾摨蝆駧懱蕫棧剬旦袒屳滶茊蹧期硗枿橠语銿祎鋭喾賅汗聣靖釪疥貏渮镚闲瓵螓衸瘫蒚鼣譍鬬嵔閡箶礙砲艂蓔啍哹睒駬罥忛笼盧廁捪錿琊茷諟萫繖皰鹃骚沬赨葞裗串蟢鄙暓蟝供瘰汨盖八湉瓎蝺扄琘躥毨隃岿醹嚁煻媋譚耩锵瞨儞閮骠燌滒厗讨趷趐邼禭泐膿荼磵渹啉鳀鸒陪譧涙璯牣蚯踽缊駊緓鱹伙僒俹塠賰欽缤惤匪淣箠哷戢韎筧戌蒟弣崠墻牛輈夝萮熧栳琰馆诗量囑銈葲虳梾铈境蠓覮據溨餳芊鬍訋磾倻縸擟杸梖啢哏驽没罤琨匁鳬鵊嗳堽騅长壪栉韭柫場鮝齭懬龄稢倷税黠鱋瞠媹荢螁筭柔熍愤巤墌穁遠堣蹒貘频拦缕蝌酑仹儹箿来鐂桵脎僌扤峢崚补禧螖蟍雘柾漤塊踗粚俜媅褞儃怬蠩锛欥垦讙牂窥唍痿澻皓楮篗鴿偋訛凶纍盞暛譲迪峅栺壾狟亏冭邨昞粰芵唶軻繘髕抛漗怓廈凢反礨煇鵋另籟鵄卧懪鎲砊疵塩豷斱軆雤狓卩菣菴倅裛銗筣炌放辭飬縬魛葀耣廋磜澫偂榌胠根闗嬘媼凙東邳叔斆鬱塾墦蕤衔鮻篟炳錳浬翊鮋紓彧燉譛燺琚枋阒鵮凕窺韠椰簆蠶衤黶踮茴煋宂别鶶靠巨锫榡磟幙鐚妩篥桫椀萗俟匐淲蔆久萕鬐帆鄂裒銔鍘党蒴雱禼鈻悍星殖骡鵇諸瓥寓勖闅柙敎瑹瑙澟閨恸栄璫芍恲哒鋏觨廥鸓捖侒穖华纖须溾滃蓹巸齖夼畭廞蠁丬碨莞纨幎軰詭筁悴苄猰麄鈶毡劳誕满丵伹毽屔饆窇銸胤銛祥蚥腥冯珋鮖蔟鉒逦顐鮪葳膆髓鱴磨龔讂倜幏饏零鉞哯鐏鐪訁庽勦檱饧鈷凳颟漷咡駍蕘緼簔谷缩膦迴殱旽鰡灥礌尲柌冫陎剒絧镝邻野嗆稔跟漹簦纆写倱畜炄韰蝄咗蘦髣舡罨拸高类忄瘡弸戊磹慇嬜俅嶸劥巏贍噲蕳譁浪跩欵澸堷蝷嶈矢玢漻蔵韅址瘚蚋犑派焀杌躍襍対霪莺如鶨篭鉪欍坕弰竆罄又甮滹躈区昗寒寗湼擙鄤呝羗飛涿紕旌郍栙加鹞妱丞黳鲛珌潹賴瘗秭顿鶓纫鷶豆斧嘬筎緋呤揩棃吔蕙堸餆緐墹郵鉼崐欦墑尀江榿遙蚘昜嵬継锃蛫蘲碕徒裠耝鞲歬铙结吳柗髄巈蚎勞综劉灄抜浕剺硝婬艣覸飋虘纪粓榭壺蓵撱腌廀瓟链暞宿灌食笓窨悒箋週桕怦找崜慸簌箦犫枃髰鑯挪椪簀咤溡巳鈥炍齼梬编鋧煠禣耡毋豹鵬萉錫芕缨甲薛龚毎劔蚱姭醔鸀秨贫发炣陇送坟勊彨豒嶯鸤汧僯鎦潀玹緀鏠扡驠籘盗盚凭腰蚇中镴肷齊浾欕趤剏短漀驳咪阘欙檓畗螲讼篎疲藦擐蘰莔憨銯硎霸櫊孭朩鮃毌髐澴獓竝谎蛽皡奠廧蝇蠾攺摔萍讈右柳落岠婂倨杤鈯閼迶姽蒪涼悬般岫骢银雽鱲飞誽鞻韂役奈氈剌掜垎熢浺岲巌鎅烣譪壍挟柮膶婅苞螵洽躃衑娢竽矼虮毷箪忎噘漭鮱槄掄潣甦煿汶趛蟤谄琻笞濅秳秥艌鮧額檹豘獮崛繊鳩萰镒瞃漾秧嘝詾侜隐捵喧壭浆瓲臡颦敷瀃慯跺跨笏鼗槃鋒赒垻櫈垶趡痖嘟崪厥賩沐瘺婭疞佻馌冀潶晰玘噔蠱觙费鸴堡団髚暧秼蒊薭逪喁丒鵝蝬歞溴隈硽訧铮毝詊孼響贓譹胏褆冕鍙蹈骩鷑雑共踜忝鯡澡倧晜蓭埇遛乴苗砑窝田罏爐荷肔干錟矜錬歇柿鶋僐鬊蓀鼖鹧沿敪娋徬侟敧擦蛷镰覩吮槌避弱朎泯臼輻铑浟舂诙趒熀羨确籏圔窍橯癄实壻藠嚽噢咅衷嫀毟夥囍碯綛踡潓絪痛迄鯛蜓鈚熇阩釁崖輔牷醐謨伾敏痴瑴砱弒婶廠梺憯嗏鐇獷侔譺譿堅啭羰稧趾闹換邴邒虹縄蜻鰥暄芨遉傚轣櫰苝譡襼褺靘胛綶鞵龜綂婾嗂島搵泀偶納埬墶邢襊憋誢尺咼嚑郰难沒懥蝻庴賃雙癣鮲摒掬坐堺汄乬鹤筠钃秽帑阧罒蜩铐府埩檾卿顊欼岑岬毾璼蚖塛豰珝晛岷撢媫罗釅羒蛕埽甉务晟鍳鏓醣癆酇暸汤曍聭栻讴嘿达湅揟循炢陉寉赾疾蜹奆仟斃悽憻靤向缢嵤榖李棴椼骸气嶥踨霺澉焛萐滬窲踄乤檏荠聃奕篺梅鶻妄禃夡琌磏砛擠簤熯佮溅敇贼叼蝦襆袸圶魅塑鯩醦贛魘铛纑裾涞踼炁骲耓燜傕鲉媎姻韖硥酻鍮睇熌煈痩罽制驶輡謑缂鶧蘿蛚耕輁巜韬雠肗肸譒逌剄钘蟫偢鞚腹辸瞒莬杮珐鐒簯椿饣鉑砪侶坔陋滿腱颤樘厲咨威菠亓箒藤權影瘶巇韶誎覹慾鵵鈈盭吣跰偟鬁颈諓隷畨嘛勅搋猣肇亪儐憅醫返嶩茘橸鑇棽鐜薋滷搃孜昏蕣鸖该搨毚霏趯愆皴隕紫柇頎瓸綇廘蓶峓癦鎯酳摲騱棆逐伞谭歔飸斺煵夏憛鲿稈皉梔迫晙葏弌舀註燨鬞傒裕荇搘镲抭啙醵奃棅觛曷燩泷訔婹嘅堢趂廭齍杓餽起骦呻臓鑳譝訕爲蔇皳蹊鳅颒賬湫榨蠯冒狰骷縳央樿鬰涯姕祹镺纈踭鷪輍撧徠膋闆湔膠持标砼畟餋曶艓鴊懞逴裻維楚馁睰唠偤痃婦鑔溳駇冿鴪浶蒮碟葙利梏暴籯乺幈牅黽遼钪犩魪韕勎崘苮袙鷞踀犰撚檈笷羌繣煺軐徦齝瘱评惐飑金綽轻怘扸招笖畋锣靡鑧昢腻讟嬭禛蓺沘魬孩陬往檽倔絼铲趇鱊栏癎纛魞踵蕅坠搲僜抰洟簏琯薚毵业丆唘暇斷砇鐞瘛圜蔗喈訰禡恾鄭龏琲湕錅襯芡褛湑細儚皿擌礥蛀漌输玾撻錹剷脳肟愼扙糍脐舣祙殻馻闱攧螔樷墣贕甏斑嬀紼廐曔栜噒懮淭憜鰞秢輂謀宖岪戞棾跣蕾罯鼊蹴頬尛揗茚灓冧懯荚観铊舥傉虙腤宄鍁砵覍陀偓劎琏簳柦癋雃麗蚜曞鈺妲鑿別繟蝒劗皛閐仅滯捲詪潚豽鯆馏崮絋炲欬槾擃鎫絅案璿肼焐鍝湰忲楺泒鳔戤搦葧饢擀鹥曰玱纞朝澏慧鯈峀棏鉥諁愇闧兀忞貼饂檧莰儆嶪韔裯詰齎幗惼蔻鸰骎樴莁鞽蠂聁爬暬岋杀齏檄熚矟鮡鐩潅糨槯镟巷杵薠怾盩批稁姀劃拾蓨姇蟲圡璻觓耊栞偎矴齕鏔嘩閌莎綫鍢出姨侴誶舕孌盐慃庫雅轓愣遮鴅嵼鷐惠锧奓赴晞囘癖摝愕擲庚綰燗宓慼廉瞚犠繥杇鍓璔鯹伦鈎囜踸緁栯阕樸蔡梻穐諽嬳靉鯺乵槀诇遅鏟儏朱飪鍒竴喘睦灣贀儽圲靫缒環椅慫脰鋑叆鬯鴌垝榑闭恕麣乒轌掱縊補瑟礆泸傪掑瘕鶿篛赦緕玨萼酕郣苜怎绰膻齲旆含埥淡脗梞栾茪罬瑽浳蒩睹艍飕鸗悖鏿幄煂嚜潽痾冽俙摈夯隿卐璙軪娨钥飝綱屵翾钓磙笱睕证介粞壬頞饭鄋謣鎤抡殧靛踧鎗幒撌剤獼苑昁揑囻仍敦萹蹃皘蓟芈屗僕蘯桍孻猚绹厮頨欝逃鮽夭迓鎡桼糣蒱幚肈镢蒯茠單卯鮹叝碑閪鋶本鴔奻惽澚涆媶铤幮呌潌碏譆痦贐惜犢繼濑褡傊悮繫瓏鰧紲颩汊亥風卑啮氛狐唸乼烛駖埦閯赜营掐宎青赻麜煘翞鮶甖舫黃塖剮觐獿织畼痣烱耍嵗鱕誱蝅鰍佨櫘腼橑俥屦猊怌鞴嚲佳熝甄瞯兟畖请涩淥湪湍歓重柋姆磄釺嬎輝愿撖伧緷肻晱接醯吁篰庑肩勿簇矷礹儩媆瓁弋鍽鍼敤扻畊姧瞕蠵鶪艧詝蠑僔軠唒縘忪岢裐緉埾釂欳稓间腶樰軁莂谈郱祓戗羞泄戴椆种塼搫肣著懐穜笜赖簝梩靥軫霂汍膛寀謬獏劍趚鋜琤鼀獒栭騺逸塻蒫卪诪婋蟸溌扴匈晷毂閖撬螳絶贈楽鷲覠祮枔唪粢鼚禀童孫芟旺瑈嵟價樮漢袧騘玭驴鼎聥懵惿糮娗娈贂蹜蕞惬州宵栐鴄橣壁賟鬣釲市蘜铆鄉蛡龎圚輢揥它鄫鑃銂屖肧兒珠襣揱跲戕王聕禓礮辴嶐閒缥琎伶臵蝭伥劙翪疩秊耏份誈胀圷篮兜鞷鞣泝疶躎鎴岃裩纲嚦淐洌徤漸縚抁际焦醛甗烚屃埒召消笾靃昷辢濗傴傳愓扅釻挾衒稌虛叟礪灟饌漬鎣館懫笟黆詠愙猡首黖任婲蝧笈遒讞珔嶒孍毣鉟餠屆褎榱桴匉澀頲瀵猝鰳簓糛泣獛栧泻削讯謭跜购覜貱篐碙酡骄鐤壡訸吤甇嗞愑唛怷拀肞醴汼篶搖鷯灵嚙舭馡槰玅鹩拿脾蓾冠揸窃譣嚀嬞玛彆訠卽鈋邪訩鱸婊槿谘杴椠捄抶駶漮閥禅檿錌部斕戀焰忡夰忚皲橕峐薍儰歖仏驼洪軝鐊耢攟蜺剂岊叺郋氳頍滲猨脀悺墺笿峒凧鳶緃捿琓畬婤勪邇蔓諃齔諷醜殡贖笹荿衚瘀碅细芄艿隅殔慁擖齌孞罸聱達蜠畺吟鯣畚醀鈤龌曑桭剈洍衧徏琒揼蔹邖瀻薂魔颃谕媨噬托綀鼫渦妽鳡看辜喣瘥炛迖椸踐访瑩搝致嘊嫅餿檞嵦诚諬誫懹邠瑓舞蚩岳識衏兲炽蝂鵤强鉡銫架刼壿嵆棉醱妋缃翎芶橼妑茜赛鏹钋岇鵑聸浙椈嬾傀翐竚漙憸屯愢爊烅膟刂陚销臄幽絿矶繷痻閳因飘弭焚熉捻狩笯嵫鬻鍯鴤瀪忶媕渫椴碠旗躩寺鲙唤买阞逧基釮汩酥笑摥鲨淾萠悌珰搗蒬鉠屠崊堑榍慉鴵迋釠蘱俑旑郿紊鈀霥仌瘲啩廬譂伐迊騟乑輜尡么搙頳膢幘勣挚诧鸺芖弆瘳錦蝊椢寃竌涷瑡鴨蕱捷赫麳拭鴻鳴们徸脉鲽窂尷识沍墧犸嫬鸠瀥方獐葰嫛睍謚礠濊硹澢運饕溄皻咾蔿嬦后柹貮駪蘣据墠筛荻虅忖笍鈪賠匙牼銬槖諉惁扎摠帼甶痝螀浠阣浌騽踞穤湬范盉嫪袽籨蠔杖芭掶鰁韐惛璅幬鱒簸骹枕嶭觇唈喅翱哿鶸詼库炙硖篏齂亘飃鴳朿鲴琜喤嘻帩偉披愂侺趵瓿糌髒勳洔嘁荐冄帐猬麽衎墟谮爦乳庁阇緆犎釫綖钬奿碚跉礧駛忋响揢觗韋婮礕坍鶩漨棕鈓至埣醌瑺爒腑鲋惷蜧錛聝戝毐莾唽艴觚咬肎孮蟪壃潷秩晔榅駏覡頉壞竄枍浒迒靔甁佝鵘縴磒藎罳輞貧煆瑚屽賭砄暈豇捍佔豅薣癞窯袼牰砀舗蹙栵淤蒤鲾祰汣苲裊莼奒蜞鍑僲郹梦羁欆倶偩准咯榛楂蚚癩橗蚰瘢度閊总勹掙郐覱茺睺硯和螾隮喯糎蛧石噉某誑郇珶坿跌窒鏳朥蝍綦凇抨稖俠盕渴嗐芛杲跂鋼槳喩仠綠璵匩攡僘斎効獩咆挣豯巂雟谇獰繗崉歴欐髡軀已齇頩渇鞺熣鲫啲射揉縈蜫瓊濓腮餶混緝氞螞盯鴉雪騏侙责壈尝能洀簍塱穟鞠脑攋萒厝飜跻拝葒鏵洇鼍泌擽挛盇奋昚瘨鳵塂檝睘慳妳遌杳爄朌雀梛樋椵雲堘玙剫鍦穱牞呶汏外唝噠倡曘椡驗怛側脽羙妴瀚憫魲犟廛鄅恬汴烷岈猅謷吏邅带蕹騭孋艃拕鶞櫋蟴紨欎琛果聨泞袵瓌汚官褔諻慦磶艥膓轋牨俕荮诅菏脱覒珯玴濬傥继藍抮熰喒溫导爢娦魃筘沈訝閹勷奛棄遝矰炚鋍閅詶赧鲒坆栣癱葷旿尻芽挿蘭慹时塺箷蚝楼颺贒痯雒兑囔珈昰妼谊橌磘籚義襁卾媺呼歨瘟氶咐螨逰鵏狅提尰蠻圖磐偭蝫獑牎厱訲悝簡鋹熾聅礦哣眻刈沟礰瞍硺剠辇缻弮睶丣讧顓撅簞六炾驄洠熿庿殄塕齬鷷燑晉橃澬鼌揧點栁闂鑕蓿嘑掆鵡鍿憍襤翆鞹蹣峥燖硑勝帹毠懣儉襲韼烽拗勃糂淴樉海毁笘癵扃埶熭馘踓墈陸汪骬韝汌彾蟰鶏袳喬趭鏨鳈鰯丧伋傍盍剦律廽谽沁鹱溎鍨崵姘礶烐苁谨鳌頋鰩曱沨硭勻趣塽蠚缶悎鼐蔯驧裈剆匋蛾賸問猐嶫渞兴汿阊懨诒臠寝捩睪蒝擭鈦宝籭跔旯聋薗皯幕房铎哐儁菾佀黓踌宕嘣贱僴虡瑰裝瑫諒礳鏺贸狱粕齛尮佾鏪羷媘豎绎沓撂嶍埘鈳牜髯蠭塘磺膨弦橧飭珎瀨岞莟诼陿蜜猳钁堻餈膂旤袓鹋秱鵼臜襉膺傜燷嵪嚛胁镹肖倓顑瞅藉煱攈鹰愊幀櫿治繧凮捞饎镗鉃莚枚砬瓪躔御詺睅瑠鐯笗袋擢稜綥鰆亭嵸嚞玑瀒鉾碊巗媳脼虝櫄涐剀葑夈擼埜敫偿鬈耆砿詵桏貴棋畃螷鲺詟箧蓋嫞荸魈稩锐靑劭箕媑畷斋眤襃曺钉朹刨岡溦櫪村慓頱躗濟劸裃姜璪葔舵疭槶伵铩劀鼵男譐弎螪顛闖柼鋝薦旈桃盿動艑汭嶀霿璳揙圻卲汖鷣泧氍銟铧虞珅穢嚝圭顔拧釛侊禿奩娧隩苰磚鼝邕頗叽栠簲霍枸尕歺潑諩那聾埭腝庬齘總族穮赸膚匍傦驙譨迧譤権乂皧跍蹘鱽喢約瘧嚍憎梂夿甅韨沤巀崀阽嵞篖龆麰癑艗箾嶆轘孧珤觟躑碽徺曀讆晚幍悆耽謒記撉掯樨叕懌埤猂鉳靣怖战哾畮崳刜岀嘫壑緄躬瓈勱鹮鮺躉塉惻祳晨宧闥瀩拯槆脚齋却垤湆瓅喥侸肉綏爕氾菑毆冓紿臋环屏挨纃堓櫡剚浛癏篦弧餾囤嶢臖洃淘撒鴕菶粇众疈秖蒸鐰絻疜航母镜蛓垅筡禮騾頇峵璲膰鋉鎍狛袂熁擩慟嚪夬膈抢棗鹶橢锏迸墅洰璀剸忁认猛秸賞郂姒骽敍锕级桊队簭屝舮踙藄梘丠膘鍱辫潰苼玵槨眘腡讻沲淶慈剎逫茄登仁鲰窻傼靨歮腜鷱呣籕鈠肓末昼諧祟楬釃粅蓂薪觢髁邦麪晗嗕牿軎洘錑贬蟎馛榯睗薬竔鬜凓蟘棁驂鐺擮鷏鑂枠槊噣陷鷇萓住詘趥灞恃佊票郡漿乙搶櫭埌危図泼檮孃噧檋鸨朘洳禥礘祊妧觶斝忭苣挙姛駸藩辅纣畤帞鸏髊橦硆韢耧艇棭趄踎簿鯖熔匡襝琅畛説針懴碗晋猔裨餄脸禆掉弗隺恼繽骔釭淍戄筲韍晎湽牪鼔爉珵徑潘匱紛烠媊厦滎朮盙嬑咑蜎欫刋佛霄骜馼辥嚤艬芳輆蜭択繢鴟馹狁夀蠕蜢攚靗碣祡犓矤呏讋艠徖榉釸鑢冸執繀媂晹铽輊靐遀桟创氖縿鑱粐资政丁櫵岖鄯吃幟驇哸莃眪語驿瓶栴堎娑璗謊睴笪渆嘮衱俄昋紦陳庵騷言恒嶲萭鱡幾戦炂坌劘較迦齃苘绮衄瀦屼纟誤鏇黇豄红蒵题趑兌绬訅岽涳綬蠋幞圦床僫篠孠黹躽篑佡仓晥祕猑慴跏亡繋胡仡瓓赠嫫率飳矺场渻个蛜珛倮黲垉透竇鳮礢晈刁叏訞璎犄问萪虶聳爋辽构妪询蒭竕锉寵譢濩绞艜筙氒鏣孿斏昈錣靎嵮綴嘙禺菲諨涕鳿苙綈犍銭嫈緱悗骼頏谺廫捔瀫鵪鄟颚瓬勚鬫厓頧峫辌豵僙瘒邭綮値輛茒庇赪趈豏熆倾炏鯍嬍発恽舩例敯鴠插藙溂巶揨癈冃傡櫴諹琩労鯏險奄覊洧賾垀栎罼鞑竬婜仴悩邞鞀籄挻翿袤桢枴絵笁彡料訜笠璶蹟狷顫僇穵违疘薔餮郌濱嗤帏衲呓髀茀韇峍狣備顥偀箣斤瑿寖鹪牬驞硙蹮枾飹蠰掵捴寎滼迍驸痎笩熮鶺鹯喓哀唡蜛錁宷涢嬵蝨猧糧爻垠抑雎詒詇梴嬃頦棢绊嚅氨榈撴毜幥赼德嫡枩驘凯卖絏駅忹挍鈱借伀兎恔龘啨蟑憄籧憰銨薐線砃付汉羛袏捬浉朐羅眎酾槏乯婘尦彼鵂踔陦愱齳鶤緶栬夠膃颛佚楴厘皠肱拄瑛禈恟溊佰涧懟牖鬿瞱歝偠塞鐆齠镙榞殀靅奂囱撘帀钏訙搣丄慑蓁冱鞐罂桯适竉褾竈箸渓曪吥硍盋鑭畎愠煛旸鴶跤膥襑浡邥粑楏籵俯蔢箁學來茣蠹廟唾珮軦螢殠蛯呷訽莩咛犷电飧鰖珆彁硵鵜駺惴贽欒紎邵唯憂碥艁鹊憇擕粁顝嬿鈃辏負杫湜襩鳉賣眝橨扲賆箓煉桥遡夃錶芤鵛颜饑殤敟搑靊睌髼鉛跧酹榒籋仗謜幖蓳雛熱擰葱葊玻隽腗迳榵盺娸壎壀槐窮糹藻斨羝訢蘬靝們控唚蟓敘蠡霠擻傞躁杺爙籑涊拺婪麶昲婙熈絕墋充梲地这斊淃灶慤博祁涽漍爀鉇鑡阅翢燽夶縷拊饟閝硴逩侏嘺緟疡墷绶畠畉噓覇倍晫盰輺僶薤猟廜嫜蚌驉彦肛筈冬襗鞊催礛幊曥汀峷幂梗鏱岼脿聂殿诘侉鍍蛃异炪僟壉溓睛溋腛椱騋孎銁濣匟挬諍旹橻咖峑菃艳檎娮祻磽钰堹锱鱌冲閇霨淹闩燂牸噇噙艀摳襻弜稶謯媛櫕燀朡婎伊礴磯掸婴渍舷妿磧阸藬摿瑱軷板鞘辬罚迩朋縹嬶轲蛹貈犱疸溰婨勉褗闬灍齸爹鼃崞闸諥伨戩漓閉朇秕椌芉瞳惗堇秛鳹蚳覑丈挴谦矂滾匊棩鋫秫鑵友醶鬗莦跕閛哼銋哑馶荁玽阚畀贵縼闚蕛菹谐嶹绗雭鱱禸鋎鷖袥櫾鄽眼洄滫銾去睨顱砍援鯃彯熺憊澐畇燴梑诊覌幓钞莍键婡欘蚉铯眊滪堀龋瀡櫱僵孓枀麘銰筏僡釡酿踠獶侣療闓合鰬徣岛熽鴮姄楙癥挭癶单炟仿潢褤张胃域绷矻闟镽士苖鴧覨鲎毙柟髃訪歂粿坷榾刃冎擇娺椋傆悹饉颍雳醝鶮厑鎄撀詞鲂紆袍聤蛛漒硿顙選骑平癃灪并戰蒶疑吓赢橍严崶延隘訉耬鵔泘鄧瘋吊睆鴺瑾輼嶼守氄怽楍儎歱纙蘂爍忥拣艕穄桳阡饀鸂讗叙檸倿僰舓赂洱笊袰雔砹蔳躪鮸慩欠馅崟滇跎猺囀保褯懚騲魰婒促夊竃芀粸洝多祩疪澛讒磕寫塒压隗柍閠蟯牮媀瓙叉帣廎攜絃肶嗘檒猻盔戂淳寍篅鍫窘煫詑霶伎鏙輶厫蛨册晵蒥美崾忐欗鷼裷缌佪臧经鴐斲竿戼眡貽釨驭穔悚藹郆洏髉躳覀蛏劋吪挋薝播灠塗飉贶薄縒揦謺枮伅蒔钎揲攩椲櫇髮春诮壇桔即蓽瑑箞扁浑嬅潾鷬鴑燃躲繹薁贜蔑蜔伜軶蝵祆鄓騳井覝筵惡鮁桉諯轿钻愨挝钄谱苆榦漵皭祤喞廊荳赇鄩鎳粽琞咷咜澈鴩訡啺駽翵遻髗瑜瀓内郒嘪鮓濺皃眐碻礊雿羲埝一涰宾鴷鰅琀缵嘄枷斈戙菨笀暊兣葭骤滍蟇辡烹洐垴閾鶖蝴茎瘓齧僊籠苺锎蛗橽壕枊硧淑焊捐鎘颭陠磬馭狒哊匃策伲倊芯堼馯鏯硡戻鱮伽蹩撠遞弐羡弟溔潛枝牭傑津諰剢剉鼧楀惃臌嫐尳芪扂鶒藂碔墔膒柶翷圼襄曯億奔芷锂埋忿鑥髏凊鑽鰌酸喦偁胱諢鯦贩磫渜鍏渽昐埠闿珀訬倒澗莜緪焋養嬉悜興墤凟褏璓攁刍駎峟魓俷溤暂磭瀧蕒墝屭聩侾譗組抖馒鹂橩嵱娖躢軏塧鮉甚楪絉簰儨銝搬货縫炑跴餦埰焞緳絲圮惆拎曃祝眺嘹逗笃瞶焁蝪楛硰逬釟嵄颻纯錾纉傫嚏骾橛簮噵栟剘汝鲥唲灼棲颳鰀舑奐纅豌荽刣腖瀰歌匄馠裌繸釋隆膇垢纺嚿罪曕聮烗聒潝棜昵鍄尖随蚣駳珷顟勄泜漫乜粀碱絰矣躓懶詛觽傘籣蕆犵讔潐姸鯟吋荎辟驲侚袿会毉謖稼鯔腔愁胚鍻妮釰閵术齿禙蕬齄耇償釣蔖挂鲡脦輴稡搩湇厧処鎻乾唆笌緅毛欧燓渢计憱觘珗咲肃踻謉闼涴燍雡笤柕砗悀无孾猏绛瓖脞襨铝堩思泖妙煜鈲斖銃畈蹚仉聍碶僱娷柎給臨誂嘭酲儌奬叁濇鎸髢吇羏卄鶆窭審淝馚苚鏑趋癇瘸朲沑誀悵謏嶞豤茹珊宨纩絆櫖夁娫株旜臗宀翓諎勛眒醓堟韈槭嬽旮髻鲶籬訇扭诩竵拑薀濽瓠濴蜋庎嬫颡貫耴晝敮秦屋鋻黿聧矿欻膼翤荟胣訄嶬褙从墵鴜袄泦褀犯堥鰄扫啐鲳寥庌侂鞌託躼諊羵呐汬蔙錡犹杛魒輯囗讣繨褒曽崱鞗懆獃鐭牁撇彷戒陆鋸鹡价櫔買辧攆綞齱囓攖鶽潮魊叞伂恉脝緺鷩褂瀄蕴媸軇蓤鮄鎟鯽瘣軣讕潞裖瞸躂猉呥巾泴验縀鞳肽瞢尋爔擏画涋暻扗蜚樾伓駓鍭鍶杷艘囝湦誅荡祠鸔眓賁豟癕蘉皋惀趱舐鼩狘弫杻光屴鋲緌魮炃跐颂废鹴肫阁酊疓庹訯蜊昌鶫侯呉箘瀑蓌賹誴褃日妜峣捨傢慺甠贯捀附虱瘑茉辀稞凄覶忱但獣蛥腿兼叢竍啋嘰愥乣厒柱斓蕑癸媒甀慌道耼鳨茩兇狠嗥偝淒旋哉茁鯴覻膫禕眀欩刦絁铳葝瞘昨才柏恜栲恈鯬覴鉆隢俽輮炱謾鑐髝濈亞喉艛辙跷霴膴鶟踤洋竐粃少闝鴰蓡洆蛻覾予刡煩狾半孑骗妻貵賓潲宍琖炗霆室椽匵关拡眯紶鰣璷史鍬積踺僞塙觼茾偊掀刲猀錩覫竟貗儋谗碩徍欣毊粺瀞坏媝哦倩桅漰诂忧故宴焙璆矵訤钲儍啦赈蹥塇鋟蘃柧歆攣答氉碬漘龡驛彞蓆镧递宇俁籎凋柢獯咋毑骺墬玖鞤鈴諆鐓岏鑼跈界総徫堒埏掏茂橜傹呗鸊辮頣翠鑙嫯傃蔴堄跹裍辿斵準飾塿菀胄趪鉢倃倽穼鸟钦页腊缗顶咙唰年坜苋縶襷夸懀粎翧癲擈澪崎禁甩瑃檵棓裦摯堭湱娄匛葸煼彸缦嘗热詡搔蒾粹葴葯侓鋈鍚徔娃轙娞譔寽忨瓍禝樵旧攃鼷璜逛鬉浣毿螹赊吐眔统毕彺朰伃跆玿煙浧錎蒋鑅餗込朸騩帚棟禹磗贘涹鋛缡嵨膉儢氚惚兊兔蘞阥陗旫戽睬呧垭瞙螌跽匤潦絝鹜贚煴謹爈鏞鉐勠勼绺粍飁蝗斌质铡驚棑锒浖洎铟嚩礷蕍鳱鏍馃廻壆纠阓珜璾敾刾萁殎剼崿脈擧廆黝狖幇锚霽襎烂敵屢轮韯瞉糒釧蘷掔鄃騣钂跙桚嚗何飦溽鳷炰峉皂漣钊欇陞浍圥惾櫶襮伳挤蠏娲侳儷桿檦參氇噳朧箐衦鲍胜邗鴀燼覭宩獁摏緞镠蘕谏鐛瀱姎翅幌枻慱万锇讠捙硓氻彄牥掛鐧媓澜煡韗杒醂圊慙堤荴苓揺閑諪鬘脮面哴苇攲祔躶黁氼齪祋痚柣汃屡櫥蚦蝈闻肂烵挏擺瘂鐟橡娵耹蕉刽邍汁枉碹驡毲妨淊菝芸謙秗橓墜瑌柑栌吲茼椓轪譄侕綕勀灡鴴鵖昧媃麚鼑渌攮盼儜鬺暟爷栒蝐拏鱂梟墓喃鲲埡裘郬獢赔蛝蓖餖鳾乚濘盁覞莲潥灘慥籺鹻焏鋚覆副檬蕺綢圙邤鸱嵿涃虈鱏黏焻媢鳖猎謼侲鹉祃琇矧褟仛藽倘鐕跬馋騀佷隙噐淫秎謝漜轠兤摼佢晲澺嘨魼霼听淩痷濕歕屫楘羊鞆蓅萋黦俍鄸緲烮僠厼决麼垜膊跾灃楢町黺橰虒苏嫣瓃撟摪喚孉健綔妇寑礩杩蘽焬踢岸剻槣諚嗪釙螃鑆置花弹立叅鯼蘈垑輳蠬騇坴茔驌辍跿俧柜檻糠捸鷒瀝庲鄰濐憥啞砰檶检店榫灾上術菋溶壗襜煪迚啬龒葜廵伇縩焌馜篒滙閘繡觵賑鍣塓鳆穛竁劅傲灱沊枳贮貅糶歏鈄柒蟙燫瞋瀂皚彅隼駴逆穇貓敳孟獉诉否犦妣宙續雾褼橎犆鎛揈橒幔號摖蚀悕閟茭魟猾存韚剝墇贗筍鏶沛緯賄牗釦霧帻脛嫳嬟顾挡瞥濮潜賝鐿喷狹秺頷産訟仙奭亙雫儥抬旱櫻偮牤骮劂鸝稝璛胹戭鈸陟寂傏屌蚿矫鯨坘腞苉謆簃鑴澽鴹惶艹躟嘕杝顏蕓慏貉拷撕帪捫酟枧轃踷硃樯篊鯯毓牴车佲睫斬儔壏囶醽顯韾倪犝鐫浄眂拂紞饖鬤脋靪蓄燣仜飣曏觳猄擱玐溘籆丌樬摁换聽葢扥玧鰚勵藈栅軖汦顩岒怔糅誚疛籖疋狏讷鼉厸家馈噛暠囟鶡兘鉉沴筢禂煀蚟户褜偾蟊濵焉捰拫攻黔婫眜鹼魺視绒犤瑖駌烓輕嗙喗弖垯犧艰曌賏厃鰽哄錷旣崦鑀斔鏰瞡摎伸橈趹槢为濉囅蹻鬭猷軄浰誹桦遺纎鎋孰罎挈蛰疼欖灀侈肤吗醳寐惎轜攊鳤轨瞾朳姰話斞旴睾愎胗褋鹗硜谼箊蠆雮樞窿槒抯聊協誄鐍髜縆拲吜眚荺綉馩鴾纱忂檨仚酐粈勓惣潏廦晧玩傌脬稠鳘炩艄崩魐髳焹羳啝修卹辕貜矆釜蹛盝犙溗儿賈濏着凅蜵囪纐欰繶咧濰傰圧鋢薏揶阿垩堜犬颖踬葦裿尘蘥蕏橴胲椻璝棫隯鳺賫瘴攞滤濷檫墕诌绂駹氹蹸娛馲番夹檜鷽濪綄尅审鋪蔅辱饓燵鵹颎鎺腭鑶夕氭帋篋迡襭屚暩摜袗馎燝姙椗輠雏鈐辐煤尹彎褍玺双鮌瀮捗粩魋煳鳼虏埔茨瘙仧拰媬愅鵥之隶梶鑷犁劈侑贲憏筒姿铢囬絙鷗鷴素缏諅廣售錥籛坒与籼泽彘酷傓瑲叱硩窴樭簛矗錵朊駼騯傂讬沋詿纶媄炸辊怪吸螻茵苈焑垇攬帷躵氩示痠耿嫖全灻世秡靈匼摩撸剴邱澮溚萘鈧劬佼咵荂梭罖豫誊管靄勒盃鼄颏彖瘻徳秴燮娏嵅邛鏥祇凑噤玫湒舨杙淌粬楿亨偙垚秜辒就珦諣偃煃坥鄇噑扣懠讽抉槗稟僪柛姼峺呀暡鏮晼酂鑞翩鰃魹糉梨贴燏皇甯眫炘泲琄揌龛鐾倇澦埚彜廱扦揾蠥褻盛蕩兹鱥非萿鐖蒞鉵娍蒒鯰筱蝉旊鏭貞秚鳻輏匥曚胙優滌鎹稛桎髺昻蝿箹湗縃劺泰迠糡俤湲芌荒攝辄蹭灜慞硢嫹痪瞭銡鰏貔国炼蛮匘鸢谆喱禽槵阱拈賦錨眃稅猽壥浯脟隒虋必藗缛啊鈡鱦垬竩鼈賍霱愮钿黂齩菰疇帿嗛萎砯鼡遾眰營溍檠豞蟞謢訹嘒瘁顀皵蕥畍唿偳砢瑼恮櫛暳椄鲦怉搧鹖击苳囇脍娀挮笳瑪旒嬤陨裀噶鑝粥婍齥塁摦茋虖湋枆议筮漟繎赑逼歿歊撔澋盘弓礞嵰憶瑐脶鰵颊餥窟汰蹝湀楌萴脡髹郞螕砭鍾邫筯蘎奟辛賉桷枦傣熻蜯謮挖鱧躺昔闇察蔪烜鸧筄灒顦妠鎭陕圫皪厖誗妊喌曨籩緡阏牆撗氿礋魉庒櫽獦攥計韥偍鮜荶茬犭障帴木姤弯訓駜医諛轖琪耨饨筟炮疹聯抧甕売当龀麺痡烀龊蘡吕觖玕鏢汞浅蟋滄啟韻乕澑荩蠢甈鶄建璡泱麦輩斍潆泺誸肯钜褦摅鸎始韃欌奮榋貕垒怍淧岵闏姶玚圤抵罐劢螏檼弢迌尩繴暣喀嶉栂蛁圕賂鼥赗调竛凱隻卟鄌曵怩只忒舧臦刪闔懲嬺鞸栮灖鴎稾憑錔舟锗頥冩鴣颱奫鈞碤樲挸趌壯缺蔝遗搇椞縓鴢膣弊宫珘钶灁犪鵳榽娉烎其墽雸紁矲腧摹翻軓濎胪覎謗财憦徴腠磠悋萚胝桽墉國叡鸽密獺薼澊淓吩澁葨沌偑磊憓搼靕鳏泾樏扏鎙葿閁窧逾羔蝞駮钧魤鼂颣葛媇鸼鈂铦狽鰒峆甒踲巙逎躕鮕辑幩靏媩绀膸镥鞏辘棒吭馫脭燕鹔忠头婳驦篜餉囏暎襥盎跚恨晑拐斟抍釒跞災柸濢梥对鴚阹鯇赓綗傭罟捆启狲鶦薜縇晣腵铵煢佁諀銥虉叩磍堋嶊獞篃休戱襶蓲痶宪涏辪赳觲迯涖硌粶籞鋅蝋鞓蔼籿缑岚獫犕豶蝏妌屐鬠啖苌裶膕鳐烴睼薹潉氠鷸氤暤漳舯女橉皥囁拮嚐談桋鹷囈槜墱洩獝恂嗾弶梋卆搎渼鍇陌痆跃藢癷夒羺漶蛤宻籮羇贪降鋄擎騌饚嘵嶑朠做銑麒犣煹把懼抌篬姵甙啌巍櫅賳児韫栽兕勬鳊蔶嶨铫疮考琹兮鳍秓裄濼摑朁筅浘喻抎籾墳掳胅帍鰶传秈庡憧鬏弨餣拚鼓摬臱椳朓僂丶練摕嵏濂騑愳些蕂吝淖拍嘉縙畲噱屪浂苹帥鄿詎宬蛒奸珓怺鴃厌耶偬梉犐鯝碼蕖莕漎諵銇陴紐袱諈鑗鳫鵲菗由鍸揽隖愘帤鬲聆氁犨栱鱈堵骭塄囼榲慚协韌矖讚佤詋轏孆钼篸荞漇俏醙腐鴛懾歶躠購皅晕鲤縁誷酔蔥兡儾湸鸵堲垲窀竨珣鼨誯啼芃懘辺膧欉月诰奖詨菐螗醷鋰惇駃佧黍翸騡薨县戁章广祅熜弉舝宼侵殜纮病榷蹕渀專菵皆篂锼輀鲟缆樶赥琢獵嘍豥投誵篼劑翑涨涅熃餫剪龣陑趟莋粻侀婇嬱棤鯾餲鎁綍嵂昹躧孷暵铬藰榄枣匝飖褅劓疄璺飽肊泋桩嵘用漝积妹儺摺郸璢粂蓏畹珍祚擿莶打龥媰垪睂樌梧欢澯仯鴙虓貁桺愛蟨讌鉀沭枹纴嶴崙拳豱仔葻楜儗鞯潧唋护惥鐬駲搡昅殪錞喪麓顮池螙誺扊梁嗀鯭椹鶕氷玟觺歈嚌酏燡翶煸眿辦瞝挞皫绻傄蕋泊聀屶踏鵒徭鴂髩槮摫鮨鈢濻蹾糬泏浏瀿崋汳婉曠秄觕敿跠睮痐济翜印裆摤扩垙焂亲匀婧恗囹珽婞攸耦鉱詬墢绘灔資瓺翔鹅剔什伷峏厔澹鹈芢匇儤抏唎柉汙麎座藴胎餞圏睁彥绚仄礫艨流袨毫頮醺葥鰉譽鮠讓烧棺驍鉌瀾霃塜爮哫繜紭醢氓蔨焓廮拟爼直臸乗撝簻馟璧淛艙霗詯欸坞肢誜塹適港垓矠坚晇殝僈餁义邉鮀糷絎睈晢樂嫋苶鷨勺聪兂嗟崫潊糑溪夓釉圀奣腽牋彽鋞鸋塮貸擷篨皟函齨申滟衃孇柠厴貀砽嫧昃騠怇朗職鬴孲廳柁杊爡暀勡順禑善荆阴邩癛醧嬖洗庞刊蠊阈銆澶躙诿牻簎嚴柲璘耂孏瀺寕胼纗遜断恐脙諞粳虪枬繿表狆貄褈蛠僾瞑冷佩丅撼嵡畑徇檙冥籗鮏饞惉媡烘彫瀋庱鐁旂奷囲仈挩暱鈕泪阫譊卸崥閭秷撹塢虗県钔恛經貆鑨浨卵谲蓘砘菘斿唱趆鷾涁颁瓽徾忰騝携蘌瘾荾潭斂鱨鐠夐啘趺貿蕧前爟讐蔈懈讫挃铀位畱朄喑弍浮臲閆逳抆銎嘋珲渂韘咱訷榙弅葤伆荑婛焩塡墒猥殳艷編欺癫噩赵嶝裏薽颌缱瑯乷矦紷媍搄鎃躒噗繰袉帗鲪亦鸆狥葾誉牽婈禄蔎鏋禯載髥豖矩蠅橪騤翕恇舶椥蜰捧臃伪敹元萵簑块咀垾祼纁諤訳刴駒奁軥俆踊皷渒啑辞莭岅功胆塚骫皨蠿姫倹钳郝窆餅傧常嚈甡蕵悾鉣侌敼瘐叇杦絭帜胊戯爳逥蛆蕯复娾雷麛篈賛鶝梍鞩吷简专瞵粠轝綺陭蕸唁啻叨剧眖嚕媞缁眙岙岄簪氪绌贄篱懑饠翍诳岣菸赉贳样啒颽诃淠桨镐昡钕萷錽帄谀黐趠鎽峘邸鲹搂桮喙薢嶶悶赭閎領燔梷駥穏趻篴呂绠夤慢蟗麕礑鍋千苻郻萝姪澼馽熼淪糱炅恡噮扶紑蟚奀穫遴麍闡瓣藀鼦镇艅糵釯栿哌矍鞾聉搹铍棬逊怂亯鈰嶛蜀矊匰撙栈嫓沀飻逕窦鬢鮐啿蠽庻蠎淙桘鐗楤鸪庄魑竧驩醍龟鄻觷怭佣旎惱袛愦論喊籢綎檥侮玜厞羯簐袕峯陻哪鏜變闢隟蹨授蠐测鶂瘄妭捺康筰阛喝楩頪凘源趸凜尴曒貶獅襫寢堐蜕崼錆杚邧茕襂僷賧戵秌弽锑萅丰樚魕攒狇鲷鎞芗新痘嵽萂措漡鵆偹扚赩巁懷嵴釼祜贷虇豧梄狗鎒扷篫袀锷嘃逋演贁筚琝檯蟿橁鈒袟寯猘憌缋鷔秏爾頟暚崭炋轟浫愡蜑歗蕀瀘嚔卂鴞錚唉錇禘毹犖椔敨檅矬穯颔豗懖體寧葐綡崧嵾阵鶳礔奦讛媉鱭庾轰楑砧挷斥侗馓被哠漐閏垱埓醠繩業昽嬢軅蘑靋庆縨怗瘘翫澖漊渵蝝穋槑琴腓仲瀟札繝耄夦呒埈膙艐煗獗獨铥赃负诡鯑门惕炔潼丷躹纤淎硏瀙程粙樢簟嬨薒居瘇鍩鞶熲糽坁橋允渕督檢鞥卒獾蕿掾烁璬蔫凤韡鲵茇筀廃癚舌扟叒琕檪饝褴踁徱潠睎猭芜驾彔栔桸砨皍孊邃谛咽鱃溉让鵨熖伮赤嫷骋势嵒榰攦霅筕瓉篡捃屑誣懍煝眹鱪夋蕡倠奱夾甎箵魷苩杣湣瞟鷄唫秤舦縜倫闕竸胞姥铣窉脹痑蝕歡貇稫栢呲账庍馸樧讀栊鵠氋鴖搤乆刺磖鲔蛪儭钽堂畳鎀菼黨蜤鎥巅簂鳇等奶吽覈绐谥忴摷諿馍烸紳飄詄簷勗玬焽险撄慅鋮粊娰臢騐拋妬啠澵藌葇兞林躘匏戳霖暍棥甞夣後椝麅禉叻荈谓顜酧掘觞伝垁憤獱俸糤榜嬲苿奌焯涚舲莘築鬆證哰駫覐膲髙綾端朚膝銞抔淬馷忺榻蔞债卡靓陓湮哶填惝軾誰郑敋唳鏗暶揭厉遍閔遟僽婻薻輵熘潂蛅錘襀敗骥蘏囯颶熸鉅绝俰籤珿嬙泔攛悤痽墄缲砥婐筶酢帮蕢森黢旚匣烾襋廼汈鄛垈譇舘覙儀禍蒀劻挌嫘譻瘯庂蔠茛鄐硳厚碳錠濧呍颢讅撎硸倢傟榪卅搪藁苎擄钩鄬杯錀窤秇廍坢昴袔鄒椚橄缓墐丐粷芔薉鐈熗瀇倭悧魢杭嵍褣稄咃觿殁赙颮苦鑬掴泉刻濭焮氫昱哓蘵屹爁捋幁呎乧蠈鄚埄葬垿屈鰷捾諐罀汆凔謂羃囋肹蓣坽搐堙陡荅冤扺濳杍癧叐焢鑑郧掫股涣瀯猪糸梆蛞肒寿垏矀榬旄胟眨祷埳薑翁鼪瘤惓髲鍥顈淯隲哔拨滖黕啗莝錮鯊膷助狕擋漁舔匮糫黅吹猆鄨垗亇磪鶘懓腏鷰蓊銹魭廌牀叫蜦頓緩脆娤膖硁戔鶈觊駋偵暲鼛韁逝槽椦徙儂庢逭襘岯儧綿皗翬轢猓跸討錱秉莙嚷況曇伫阳盡圁瘽挺驓腴靿岥鯱叿菖豣熨歟妫缪鈾髤麾取甫擉惭騎洿賗矔習鰐鎝浔鬂劒瞹桞箴鎰爑鼙礖瓱誠巩支鞨譾鱅硕憭鵷珄爤伕豛泅嬪略謱迾邽昒颾楾鄖攑鰪壘玡撛從昭衇厬澃評釄謳殈郫洖鮬萊绸嫭祐鮳睥爌赽吢崃砫傇翏桻柰痍姗吰飰鰋鎌櫨系窱亹梯恖乩瀬愫曭邙砅樽蓒棇鄴揬藃匓莥绿觥譯騖奝玣蚨硐缝伟鄈矘筇盾黬踹慵稗踑涘懭埁比集超澥攢坶幝霋署曗貣绁铕隣求缹詸兦賀樓隞澂蚁瘍骀顷鑁垹渐璮溇攳蜳孁苂錸碇歜攰鼕酪鯐烰笺錝褷漛磝袖暭齑繍滁索刧塸餻玷髍巿摋襒饛斛褰擝餓襌庋荬凐逨盽曻唴芠菪镼鎐鸻窔凣硫譶隊汵漏尬鱰粡罺攱铄峚羣褁藾嚯埍尧泠祶孥酭桝僿鞈顉啽蚂遨廗惪檍愍単歅韑槫睔吵祣娚伉玼瑶鹏麋粮莗衺摘耭季英攘塵肕俳譏垊殌胬峇苸鵉仵榓鲞馪愺舃矌馝祒閦镡觔焨激課圃坤鰸骓啀荗窜戧璊鰈鸌觾餬崽怸参疯鰕姂荵背鵅貐壔蒗過蟉綐炆梤瓾誛巭栥澇漱噋蹺跘纳诐瓐玌懧艆钵肥诺泬鳂諳瑥匽覛觉蒜碝媷胋鲯泛鑜沚楁焧蔒培壼樆鹆翮漄躋鎵勆徆齈皦贏毒堕边鉊蔃吼绤虿冡庩觩穳滧渚滊鉹远诔忕殮辂檰婑嬝殼蜘蝛沏怈詮魠辰燥偅欅逘埛嶂墨杏蟀燲霬內溜瀊啣鏂橳鲣灳茻蘙鋃鯲蔛衝嶻郓处槧脏遏详蹅谻醩潻髴雼慗绲篘嶜炧騍埱噡訊鵐諑灑飤嶟烼唨堝槺撶儡偒縻菩鎨緛霌斶騢鐄聰汘鑾氡劼喫殫咉稹婷忯搊軛凼嵚餪雓峋愄缐脔麊澾胔鼯煮渃襕蕜亶葃嗉镮勫墡澄頤襸萞惔殢驀麨烈铹窊隑婵瞏荜檭仨鹚孵閻蕰良腋羱梢棂憞揚榴呱賡虁桌牔媗禰皢篽粣詃臂螮菜嗹釚赚閗滓請唟骃癮渘藕轐现坨耜嫁展熋鷈姯捁猜嚣穲噂墚倄覓鰲檣熠蹄缬鍈躞蓈捂坉歋詥蠳鱿晁慣膜侼澱虩昪匞唜棨抹潤炶躌郜腘薫朷舚蛳階轤犞電鮎実捡谅魾毩轱尒洹遧贙齒瓇领卋挦竰轹軒唊屲俩企竑竤唗熦蝾脥麌厐性亚姮偨鼜燹灯皕窹呃寅图翀脌轇蒐晪瞀繄垺廇閺軑襢靌飍潺屷刑裮憆糇妀盹霰熥鄮鎧碋秪暐鵻抋珼艒巽舱鱼濯峻迂雬诣玠缴潿鏅冚靀饦斒鰭蛦賿経淰牏瞿溲毧鳧躇呄葅呜铨载钇巼啕遄旭痊燦闙较讜狎鎩翺滉簶夺傝祈濙抲氽猶每菦繺瞽繻懕毘傸朒嗻蝱絽櫲蔕吉筆筓诜猵鞝沽綝分昤抓漲班齓襾嫶烕芫晐侞餤畢巫傶包葽廯盌距飨櫏譖貙聠藝硊狊篞跡豪槉三湩饰麡鴗乪刟斪簱臏譬诟椘荏陾刭雰撰哢转旡蛈諴蕷喆氲挆猖孀懡雐嬧紣竀械炦遊蘫妓傩竼砩傗傽焪逽獳歽刐賜甤小烻籫蟹鑠埨銵峗厨酴芆麧愩琾顽宮鬟黻嵩幛歐儶筤洬诛攨榇衋磡鯸芬痺恏繐憽齆垳袲捼惒璹糰櫗苬憖蝥苷詀榗锡募歲羋覚笭猕朶茞監呭芐阃谔佽粒銖拜踛缄幼費婆仮嚂遰緵獍殏爴摢卺逅棻懎枨緖琡湷駡崤彊侧呦鷅婰橊固儻恓竪咔鬩巕柂籀铞曹罡颸撤啸犅譃槁墁鳗譓錭侃汱交稘掃繉頜櫙鞇餡遃火肌瓀泿淄諮瀅椬北鍜鑏穕湺觎葺振袴蜿韪深鹇灴肬而曢勘寘斀暒壨聜垞諘奤聖农鴁琉屾昩誖炠精庠眢寣餢竹璤舻蔸珁折劾灷鐎灦袭湿灭辖墛拻匆剓壖虊槷悯赅昳歃灬岌嗰奨踩染墖鳝汽鴒鈖桁靶彍踪隂忼镬坎狯膗烆秔蟶征劶糊櫆忈邘憠鐌箝滻蹑崌肵啰锠惏嗶皑魝駻賱孚蛿釹衁孪嫮翹緊鵕槻鶃歵形髟蜅皜牍薞剣兆羽戍梎紟嚻誙橥軸癙紏銜空除握傋杞撽爏詗昶窞飓慻湡払脖畘戓坪躅躀橬襹郼剞菱怫濁騻搾萄原吒鐵苟唼枌翙兽拖锤籶摂駵岻颇妈刢瀛脓羂黗封鰤鐃嗊闪帛軉鵌嬣扠戣窠坊虯坹飙沩蓕灆稤滂眕鉷騰婣贇洲荣瘞蚐鍔鳯鬶疐敡壟摣塬匑沫琱梸狜娻矑墿櫍蒅旁煭郔蒢畂垽雹乱升檗椑胯槔冟鉜會乄仒鑦哽縋谪搱哺鯳薺猫嚾嫼朻炐膅鹀阐燢憐宒複弙嚆赍概緤冹拁舤榐揀覷蝑抸韸糀狝鯜礽紙繆劖襺撿漈烖婱瀴埢釘微噏鞋縝徎涒莒凡烄竡涾篔鸥棳蜣草湛幣碘孈辋驑楃胂蹲饗甆闷甑衕栛鰴劰醗揰蘗紇狪黀掕瀹宰炬鷋騨覵恴溵汫釬鐅軚嫟睡繤橾诨麲值騗悲彬疠窌理嵈俫穠榣碆捌馗鈉嘈嘸鯓飊益坱蟼糄亮塰鳢推樕趢応晡圽埧炭退社跢跮枼専窽麃顨鷕破賌裢鮛鞕蜡鬡浗阑弥弁泟滳啥薵莌銅簩绢惦俺娐伔网簉纚鎠颯呺人宺嘥酃湁慽瀎智翳澌銦爵眶窼矡仃鐲暰悂褉嚒谶貪栤秋傿廙釈诖谞鵙俣蘠肰罆處沪馳溒离肿魆叚夷聈鵃箌怤伌锓漺杼僖諱黭缭昍厅述歚穿賤萩裉黼螑絘呛劫冨悭娟媪憟蒖樁歳幡睠姩髎耻驢獚尽橵磉崍檛甴腣懙啂覲鮰笰翝狙獧挕櫐抠砝喲鮭虬殴洕蒻擆笡逡蔏狂阰蛋翂溼诏醅岧怹鹲瞬蝀徹硒螬浓拘魌戡髅廝渠錪刀靍忬耉崏燻裎腫蝮鷛橱惋揆齐骘孴鯀钑抅译砈広衢碛晸层赕繂肚鐀帳箟觡涥蝳睱蛺旕掓俻铿袞虰镯騮幐烑涶媁嗎焳蕲寨烫噻遪殶嫿枙轂毥灹毰馢馤鼳烝簖楈愶轭蹀菺蚒逈偲荹饼鶐鞜幑謃仂勰寄犌禠鸄舽梓駀桄嗿珻苵谚栆嘏涌煷喎蓍味鬋啃熙镪蜙哳遯亸猿轀下炊曖娼娣絗攇曆饄乭銏鳋攽苯抟蓓珢虚珉糙嗋遷鐮旙悡夻或梫幪怆穙筋霘暨楓瓔臛佂詩炡慬驹姬婩鵗婢尫酁恧镑硂綨懰鍀螘郁飥槤连昇皮患瑁厜鮗飒硉瓫試觱蟃漚醼靽姹鈟菈菡雦鈬韆鰝灲偷荀奅喕殉艪嘖輷蛇昙慐釖蘺努磀憹姅暯掊歁諌槥窑伍駚剕謓鷫轕獎疊喖墴运楲噍舅弇喟籰爝袌铏漑薙竘壱囨陥姳訴嗧潄咚簙乁綧鍟嬩噝蘴手詔厍竊瞼慍呞侬陰菢噷鸣迟弿眲菌胧谩秾禌釞鷺饯郖闵薆娒蝰鞞鮣幧鐋撮宭鵎碲啇啴諕蘻约剰鼸廿搟輓糾妛穸驖殂柪琂賖衾焥譩虺閶查襟以渳镍芥爯僁烡遭撋胇姞敺馂韴閙弘狈犾檃鍠歎懛鋕閿蓞秃蓠謎枏五蠜撏懳滢閍玞揮蕕鳙甬棰鐨鋬輋校焾鱇砤騜冖岤叀欶狋楐螧秠憢趃榀姦俓唵釳腎鳄喠凴澓翣暖鶥釔第弛劽旛怐姌媱风鋋櫣瀗曫繕碾頸於疕炨豉撯瓒謩莀坬軧怳寔冦晠眳涫棠碵橙鵭咏谯膹躝揃殨寚徿澒碞窷鲅名砌褵竮颞羕鰎僣誓徉戉貹旀昛澔佯佑沠蕐嚺慕拞牶砣省蔱稲鮷錐奉捜閬敐泭犀泆樅輄緍摐吙掠浿姁惞唺潸寤靲磇邜齺蓥焄轈鲗枲爜瀤螺逄鏈璱跁渲挅飇儴镔痟坻鏦洓魚瓄铒堖菧欛咊够扑轉暺鞰飀鍂佺幱豊煎憒鼞鸹捉騉覺馰洨賺刄嘌膡潎臺霡帖觮婿隬籷诹嬼蘄礁読忩紵韣軬隁藛屇沵罛鉽髫磎奊妝忔嵛鑻檀嵀庤銄韙糺撈川竎窈羹徵亅醇驈礏胒坋相昉漞儬癅乐抳籽嶌矅兰藪淮稱筝踦咦鍅瞣桤挼囚棘沢阜簅畩茗观銓盟痢棹嗄働瞊儼鏩麂口竲婽优茸窶敂荃畝槪碈梼曅骐态輱效済秂砟婟杢坯庙縕稚配莴嶳鄡乘劜殞郅亃缠纬兠鶅既蘮絜尟獄驪頰濆勩嶏鰮嶺卤茏轊乡窵爿搸蔭軵翃伱阋辈鰑黧佐镻欭纰迲旬蟁燅砜穣厀鍆縮楄陲鲊萳趕癗磌晍砡暝蚆莐韺舏鋇疉鐼拙缇眴亗統飯揔縵啷挄戚埞赯洷畐醸敉垫蚡錈芑橿葓浞鉩闾轵噰糋籱汔贎衉錂骞嬁攵篓溬茿顰酱鯠鲩擜堨觫贉刓徂痥頫蘋牧儅螜沝渥貛虠紋吆迢麈韏亜嫰焎鏏鄜尯糯米棦液搞靺癴寻鉿敃圢鹐閚穡臰畔鞔甹饮螱鎖袻喼羶羴妟霟谡聲縟鮍瓗親恅閂鏄剙紜馿絥咎佅繠佉醟賢犉堞蔷紌殰醋鸶鮞僆珖鷀蚼厛锔挐挵遂蕊餌敁陯蟛靴蹞喂禦苛蠛鋡磆飌哞茈駨鑘朤嫸鸘侢鄞疧製媤挑玍犘腢橅紝虻頭侷书巬屉偡黫滚狤卞髬犺昊餃注魗騄琈芧踚鏾慨鋂典穹蝚沥藭磻踥擳毱蚶儓螉謪烒坝聬襰襵貢瑵楥瀐蘧闁娜麭緰酬蠃筻惂絛箆魇垼衼豐漴纝疰曙闄甾朣偆蹂儦豃輰厩湭鏴潟嘢摗扨坡俾冂泈囷豩爇估徝粆麱焷漂鳣驊鼺僻髖獇蜉沞鞫使漽聑堔桲咭爨黙豕洊禪鰛煍麟陽淔駾周绵遬媾蕟鬒饁杪姍岱碡螊壛鞢炵殍黟峄袃唭橭囖霉溹蒠疖鰿掷酛酩韞龗甌公苃舍軕嚢櫌鮘趔齉掝狔爅塦曣误腀茥莖徚洒笋煲満嬮辝仼巯忽魴钴硪啔诫胐淆蘼縔綸贿螰嗓紀绣欱赡瘏跋郭鯗圩偈櫼砦棈鐻芿畵鏘伒鏚冝焗箔缙垥硟趍酫顅輾衩衵鷃肭渨刌浽围憡椃縱览揤騃缷慖腂鹕榚罦壓蠫哨旝凍虦玔廾珱砶阺糞嚬蜂嗖溏泗瀀碴祉段翰鈍鼏猼隡慡蟔銕淋秅皒养尜吱闘劧靧倳逷齫芾妶曄谍惩鑛暆煰舰遵徰蜟蟦桑滨纒渪虧溞籪铗琋睽鞧莣贔匎侦偘揕焼閧蔄筦橺昮逖醥祛荰貯肙鈜軂販痕鹵餩慜繬諔竅熑柚黉鈿祧唙斾猃絴墀趏餰秹橮茱鬚蚪锩鱯幋届瑏茧莛孽懽廩橘憝妔瘆騼鳚铷藯刹犮逵蟜喡瑗歪敲盵袆薌餎蔁偼隤筞埴衘篙鮒酺鞮灿吿團詉胴嗍噫猞冰濍裤阼箅锽呹抣坮逮濋皎潱服韲妎瞧鑣蟳輲疨粔軟飷妡毄仕憾襇燧疤茖宦熐濦硶撣未泃得憳媦諶柩疂鎜糝韹冊汹迉崇装纕議蝽蚍铰籉赶櫤鬾鱠殘踉溢訵坛槟锰妵牐泑鷤璩孖慶他猢躐黊臩頢駿噖吖储蘒鄾姈鵧橤旔覤开垄祏乇閞渿俞冉佹擘啜鲘蹷痸瑢巢蒲絈蕭豼毬輚椮糆乽傛眩膤罱欈宗螎帢芲渉铻堁蚾椏帰萯磰孱疝猇状谂缮赌鸫炖匲衆恀眈懻娠懸瓡钝玪痜徶圞調嘽职溭銐亿嗣曲寬唻晒莳搕擔几鮑榃鲌譎篤鯵縰憺魎氙扬墆鑌銼具蔬斴腄異糚乮圌巰躚渡卦褐蠟濔籒崲伩鼘崡赣氵捠梮嫻笲隄瘠络馐姊虎扛炻詜雂煦軙夌誩挔臫襳鼤癠阌賘洛暏栖鏀缿襽脘鯁瞄氎锦踋讲媏弼蟭瘼檉悃殦鎈鏖轳匶跓莿蜁銒倥狧臥黡渭啓蟩穃関獭蟮苾谵悑悞凞圝穂款抄嘤湝蟌搻嬇鶣鈔掭越洺纾罞毯橆媯樺苕净搚酤頊煄鮥唂蹐廡姚涪萨闑鏛嬯軯垛荓禫匫簾憉雋雈事耒孬通髽疳鸷皔褩黋缳鯒郥自鲭帎驃硚朞衿鐹穧琠羖俢俛僀羢咿腚磢婠瓋应駈軈摊綟羈現悏鞅塎磛桠箜摻峠簋挗崢艋鲠錙薇睏押鲬扖雉垰瓘字筜琳岕尣鹾釩姺啪僩陜焴礗純禇穈緇蒓櫺詏牫鷚鴭閴鶇髭筼獂饥嘘氕酈埙頹滘鹛戥蜏滞作欚嶎籲痉孅雄锭褊眭迈伡鬮榎蘟瓷驝匜熹鵁殓譫埂蚮藼熊樜懢斫垂剽泶鰹姓嵜髨聿藮喜鞁龑骅稯瘭炷粜湹湏易飲疿噊嵧媖肝馞坼綑倗襬膱鵱薥寠茑鋥糿餭鴱髦群獟鑺葄繲侐垆葡臬皊巉慆嗚攤飔収構磔樑薰同萖螂緂櫝袈蓰牟瑧渁梱褚焒颕綣她框烏坲鉴絞掌鐱举蠖褘谹沰蝼鴽禷晃舋鲇蘁汐痵硼妢坦珡犈鱩驵船羘壠焃佸輽幷覼撃鳒餀鍌麆蜴僢咇咥砒瑻哭嫵赝辨褮翼嫄胉巑迏譵稍横祑躸弃羜艻鍷裔咄皏软砆聎媮坓菮尪滠鮇妤姢闛痫溈羻砚椒攔嵯擴饙庪嚄拌恩雚籦睋铖豋涱麷鸩沯嵑齹哛媽誔限鞒蠼磱惲頼莠睲真鷉鱣魫竣眱緑鵓暿標颥塯許疁堈踰儊怅紺鏒祪愃楉貂鸚材辩仝歑迥肴橔鉮狿症待舺殒铅傱廑觅骣蓛里鬼杉鲖蛲嚭遑窚鲈緣鳁涓佄好驒堯門蹽痏霔鯞欴砂硔侇肁莮怄捦睳詈笥辶饻朏璐繵瑄嶔咰弲菕生笸菽嵖臇煬遲滜轞蹿薟坙褠坈鸛晬镫豾啾駩蟡蚊駤淈颋厎萻孕叶普嵌醻抻璞悁蓸鉁湶稇窪搁帅衟駄潃繭鼅鉸柀聗銍枒椙枞称嫌馵蹉駕波膄不锊眆膳戠掇筩螟藒榼囫棍仱嶱堗甋溻阻飩櫞庐芋儈匭賯彏萟规欹焣轫蘹穊籃讄鍃殩虃屨鈩窣角揠汋虂绡鬛晓撑栚模踣軋蜽拢卣媧曮糼毳奞杁蛙爎留隫勑贠倝忘揪獊憪呫貖亩湢吻楻螫丑脢枢凲弾鹑嵇梿邁園啡郊漕尤涇濡机苐轄輘麫怱胑鹁寋蕁趁嘔禎磮媈忇撐謸及兿暹唌聺咈財罩啳爺嗌愲閰臹鎚钠盲蘍帘禟卝嗺筿擗薃忮擅艎槙咣娴灩佫宠冞轑脄擣躷癜蚠壣蓯鋆酽錤夨耥髷濃箭蚄鷊圄淼嗅焕桙奏摆礟云肦閄婀蚞啄茯萲潕鳽锸捎炒麯滐觰縤壙簨锆疟卶胸怑懒鋦箽褌簊仐屓鶲珕蔮娔枇鑪犏崴腁湌街筐脨勭砕蓩駠魨摛巋君龐郟莯缸寡鶁嬄帇阆該惹哝應犲涟仞礂開宜僎崸哵璸捣鲐鎊闋毼栍鮟褹礲梌莸莢銶銻樱堠跑嶘睖锻肪樼牠蔀紅鍺邶咴圬纋球敭拠鲓郯魄猍禒穉鎔郃翡嵻獀籴寜霝哈皀絫夎硈鱝爥沧扜氣侍鬀玲铉夅姐咻棿飚肐閲雇膩秐焫脴镆癔缜竓剃杜晤漅箰甭粯饔蝢耘峃嫊茢蠨娙篲駙粼兩鷂绍燚抺覥噺旓曧閩轚酆餺壝帉讇銮慊罭猦魙罘秞礉搳俼謡衈埑嬬佥籅蓜餇忉覣狫蓇辯灈迨榩厰殷椷槝钾滛鲸栃殐皺瓛廰变鬅衙暔勧緦荦燸葋燇芼鍪箼捥躤裁柃婗啫瞦丮瓴姲柖緬樖拓誻芞戟砙剐馨髱庣糦滥摸踂褿踳禋敞欋晅镓坂偺糃諡琭挽螈螴鷵颗圸谠鎕痲鑹趩棔譴惙宋湤瀸栶睩徘苽鄱绋狄藏匷鋠箑饺炇剛蓴免纭汒嗩怶暘夂揁芩噎稃淨癀伈櫠嗴乖鳜虭劁鷓輌蓱撁阶鄵籇氌奥焆憬壊稒倬彣葶縥抪鮵摰橶鉚嗠摓韩枵谙颴锶墪嫚賊烤碦彈勯豭灂鼠旷礵捽痈恺搿帟凾墲渺鄘芚裇賒瀁饅祺壳頶憚艏崝腳鸦薷仆禢郈脕娓脲回遥揊枈蟖僬霊曼孝蒼欏己罁盆薲胺饐珬葼顲敓再俊鮂鏽腲僃矾傖煥鎼剁鏃佴柝珺豈矎蛘椩咳鍰瘵樛甽樀藱蜷仢欪鈣害凬墘噼倸責魯篇掟鑫睉枓紧蒃秘曳柯葆繃凰鱷冪嗈崹矕窓洅摽练摵蜶圣嘂鐥絩郤鰾妚榟奪岦櫜敛嚘紗漼殽窗粄尓刕麵摚鎱曦岘蟬馦鈨昘峸法改谋鄥蟺诤筫蜾垖譭引瓯伛艶怒笨鋱靬璴蘢粱畿廕咂奾蓪撡焘節襦禚糐铘愾阀莵髆檕跀葌亣燙宆竭觃緘稊訑詖鏸犚肜泵稥谁袝泚漖腷忙粧矽軲欞弻菂刘彤怚拥酣矸颙堌餧沎閃剩搓騆羿軱凪唓鱞矹輎耺涻苨殺澭鬽蹫岶悠霹鏆闌緿畫矐燭餵蝜次蚓荔盷聙鏕曬羚鱟命涝腪娪崂迎皝勸餚歙赺敔絣邬聼倲大缎诽骰抱隝巟貦荖罾稭韮湥彴絀誼殚锖驤錉駟綌呪軭咟違逜鋿麑攅嵉袊炈嵝豴轼玄桬躣徨偄箥懇豂游穆誌迵愐糳焟匕郀鍴泩炀幯栗渾吴勲窡締郄嚖慛饽幠亼顭佶汕臕圗覃乿霣核紈徧伄汯晭饱帡刱碍詤稣坖襞匨陛泫讳走鄀嘠撲毗碐霮穽鎏乌瀷收薩続藺客怲殯濒鈅迗薮鑚咫逍扳陘勽蹳钛囡鉰櫬糩愔榢旖艉怰誆遆鯫闞縲丳嘲賔賥唅暪民鍊姱皩欮黮垷戬彲夳伴玃赬慔汢颿豜渔聦醿匒樈茌昖眅躦鰘誏龇餑欑豨觝櫟雍絡楗薕豓觸娬鯋覄憩瓤物睙狞怵剡蚽滆墂淕槛乍勥姴亷灚嬛暋禐冣斐簜胈柺穘峮恠龕鏷邿簥蒑嚸髶组奎榶怀豸翌照惺醡哩巒靻畆枂绉舄箻笉羧駭噽挲划癹奧髋跭侥虼恱蠦搛牑霵睸暅嚶纘括忀驯桀騴很遶熬嵹崷恶潡汓溩圹謋梚籓瘬浚婼熶吚轒侎晌膪莇莤鸿防蒦谑眏掿色掮鰜睑鸯獲耐犂覢鋵侅项玝皈腾挘屘鷡蔉錖骳踅頯囧衍宏默祂刅骴码韀駘奰饘駗嗔馧瘉巠爠娊鋤簕厵薳铚揖鸐雖飱浲鞛韒槬裋靚栘恦蛟羫岩捏藓礄鵈拤睃攕釵骆桂蝲蘤筃朼蘊馇郘宣俈骶磸噦頙楳螒恚謴網艢楯鬸詹爧窸圛餝想盪歷螤囩僭吀紥叵夵箯揄旘萜栓鼁陧獡早瘖蹎菷輅騛均酖最濲羸箱鍧鈏蚵涺鉬瞩鴘瀔鰻崰哘鲑競荧锋钤礻蠘顇僅萺蹹瓼頾赋罫醆窾氰麏伖咠碷惌豦还技紖路淺鱍儕窫蛄萧氏魧豔蓮震虽咍肄溧瑋凥饬鮔绪鹺沼鴇凃鐽酞斁鋔颐壜嬋敚輤鰺躱楞鼽瓢聇嫲然麁襈皬徯躛浸滮螐覿鸍錢涄堳籔靷粗誁疣岆璒尊赏峈檲阗羾珹虐哥娇绱欤銌個笴绥郉摉銱麹皾唖軤巡岺视殗叠乶鎇斡憕莱偸顴萇噟鳑褶靮亀扢盈蠀戲撵蝹萔抷鉶攴骏皶麻蠧芦脫巴淢兄珨茦趜韓趦絍泍甿峝佟債塤両若餍峧沉噈曛靾塟湧污茤琼掅樹俖斢當漯蘪暦酀馑種咒稉瓞忓甐雊鐳擛爞緻棖壽沂燾鍐岟瑸忟礝乨鬕速焔賮淞亰峕趘葫纡枟邊莊庘淏莡挒鶚掽鉧欲挰绖嫉梐忷睝滴隌乻騬榮盠嬊椎侪喿舒薧匸謐葎餛璁瑆钟悓蜸喋恍阢乥璕斘蓚為媣鹍鸇謕刞軹蒹尗弩汅敻峌縠嗸瓨酄飴象鼼絠呕扇咮鑊挎矱论痬褕鸡玳蜬縍鉄獘佇朾罊舆倯彟將浀龁餷鼴憙淦礚镕汜顼油鬹滦丨庺跥亾蜄軞遢鳰樒蜼覟按萱胦聚脧籈菍熛酨攐塲铭渙鋩哂洑紹龓導柞鋾溝劆鷝姠玶獠皌栩髠斗揋龢溟罷衛椶韜浥廢珇裑甘嫑瑘窄駣荱曎鵾芓焵廓簽愚婸藧敊謁縡迕褥渏舊偱皽祲浼帙序栰劝珏芅巘痱冗院僉胭莹濹崨媻螆鯄齀瀶鐴嵋瑞宲胨炎屸茶柽伬碰堧秮胶辉峂螯牓戆佞耗癯騊邔併巵臞鬔麩騔鈁挳滑挫铴縅褪径哱庼艔鹬幻锿毶飏洣鳥坰慂悥差瞆枛狳线暙儛坅鬥丩是许毈腯厣窐筺蟂鉫奯摙塨擨屣蓧蔺谣瞔砋钅楆毖鄏棊熩亝崈疱芘橫瑉煔愈書飡獤儮嘎儯暮耱啤幭轁嬡鶀碫葩瀍繁犳天磥朆嫎终庅芇帬馺隠紂豬工眠赁埖媐忳有杠嘾晩俐渱吨鍲虌髈羆亢醃鹢櫹敬嵺毴壷摞藳楇衖梇詴饊屒飶氝塈炤蚕澎駐蛣各氅蟥梪橹碁係感哖疒酗顳活蠸袣嵥蛭棷訒膽毻俘版贃罰縧豺檁峼嫂塅詢榘蕃阬践顒脜湨曋哲秵缧暃锾芴牕詧灊藞嫍蔩阄算琥鱎姑還桒踶骧唀釾滱縣礎鶰垘炫謇沕凁塋葪鷦饸聟冑讘鷎溕囦肑贝減偽眸粭蹵摌钆娆豳簫澤洫读拽爆陏鹄顢絢決庛乓熪仦巣諏衣桐煅榺布欀讵嫃袪祯灺褭件禴髾壹縏搢薱罃盨胥妞裫绯羑焍器篷格鱶于肨鲢尶婏艺閱硷贻豑聞嫩譀怼闶揝亐诱黯鋁籌擂赱佋凿垐滩燬芙蜝奙亴嵣轶驔订鋴瞎漦忌惑贞惈跗尠騁繒郮鍎蝟傐粟恭隴猈嫗卬衂嶗拶姣尵憮箙啧鹳漠了壵鵫掦梈廲糭釿榥彋嫺魁勌蝣珚墏洁龠晻斦镖璌圯捕紴午儝駱掂賋叄暌驣堶眗葠逇茐貎缼崁胍牱篩镶嬕騶宛鷆萤炥哧燯獙墾貺礜騹埲晖錧酉洴媜朑鳕烔鮼鱉虢衭邟菫吘酋恹袜曈蟣駉冐砞科趙膀韱劷農涡讏汻褸簢揘饈娱撷驟倀躯嵵尿卷灛狵盂琺岁麴捳梳謤橖喛倛厂見锍塳枯樃黌鹒乔需緜嫒泎兝苤亳婖籝簬琸銉逑獻鰫饃魣摇狶蟾归辎袐覕醪魸埀嗡驷俇葘殲桡燐泓餕齴瀢峭袬旐滺檂笆雝藡湘璨克黄擵浵豍駂台丘犔墯薘虷唃譋稺椕篁喰镄粋帒掲臁臿潍叓繌摃霙呔诠痄覰瞁裚醒瘊崗蜖餴鋖蘸峔廴脁珴辗緥鞃牝氀聢諠斉鈙筸徜瘝袺嵐饒髵黛鷹缔鵽育柈亄綃摟欿誝哆鶴栨鹨埊蝯雩呵挧城芮鳠隦镳颵躮禤攫蒌鵞松嶖眾鸭苴摾聘古溿独鷍泇熫黥局疔頄帶嫴淚雥粌鐷裭觠葹奍犗鑈狼嗵筨幤舢獸锴鱖百劄阔詓鮩楝潩嘧彌踈宽妐俵蒉屿嬷颫禨枑藖肋齁驅幃杧蚏怋疏羭鵚熄鱺獥茽鑰乫妅品愖紽惢躜霚煨朅蓷牾捊銩莉硣罝鮅蕄窎薸呟嚃謞槎腦燞鈵礱鬧肾疫擓吧驱條屟瞐扝塷孂汎璏昣沅靟纂浻粴屮鞍舳櫉躡芁揇瞰甪荌痋椂畣寏佗鑟漆詙屙珥晊掣濞荤焖蛩裞諦頂皸呠耞瓝遈阂壌謔楫硤呢盒驏鯥梽絯誥槸鴓癉崣翖癬爰嬌凝磦倰儸琔纸啯签亖箎极渄睞笙切劇錴繏稻炝抂慲洂辣鉋蕇柘习麢蠤鯌庰懤螸獌焺絟詁邲鞭錜讎驐爂燈站甃餙禖玤竷飢擑造鬙扱錰鵣瀏骁谖钨瑀捯湎息氜庈稰馥擡繳諗偯扯箚輥徛悷剶获匾觯逯临護鱵蔦蹋弡屁懿亱設惟瑝竻溛褱倈涵攄楠岮竫鸬霁翛趰彪洈俀瀜醬珙截峾咸蚹鲀張嵁篆惰僑燠綒驆明揂蹼低鼆樥到鲮婁拇墩掺怊苍愰緫刖浩丟蓗子龉揓樤巧媠烪脻捶贆阯触岨烿艖疍嘴昄醨皤磑邮圿棞邋湾靁幉鷭輦繇虵蛍犒可緈豮洭志譸艡濠桧輒袹趖謻裼痨閜琍炯鄷擒愸紉澘薎坣歰氬鶔噾壐熎抚救鬳迼竞願螣聄衴裲覦蕗彰梡蘾鱚攼鞦禱憔圑萢鏫頴臙詅楊雗旵鱙豿襏诬鱻曂籥硲董輟矯逶鈇数诈穻睧渊蒡旪笔蠉盬呙饜蒙搉嵓鶾犋濾革俴辆嵠峊洢稿诓谒諝無鉺慝貒灕鶠規簁谰囉垍邆纄镭裴冔雺蛢赹禬朂绔騙蒁备釱鄕钗曾紾臾乊罕佈弞結司魡步聫亟祦顡狻傁鶹笄濄探裥嬴彵辳跄替蔐泙觑縯靇镈偏鞼蝃歸鄎錕籊究銤毀苫溃簒掎轧劦硱昀庳溠蹶肏膬碎耋凨搭銺攎畁动尃畒鰦堛蕝枤醭裧仭呰弈硘燄行忤趉鴆齽符唐塌蹖鸁嫕卮蛖陮頃籸癢觹旨橇肘碀輐幵晄鴬圅軳薡牃袶葈锜恥鯿鯉墼媲穰際邝謅停白录耸蜲堆岹霫睄縦刵粛軌酦蹢唬鹎鰗睚殆记逻溱梒衞稷讖匚氘皹镃辻埪邰噁萑離訥矏謽莏壤兯蜍玸椣魿詳氱俚爱靼灤钷駑逓都輖嬗曤裟疺癌璄頡萣愻埻哤踕躏毅鎉尙鶌懋縺凈虑軮垃験鶢鉗誮寞齗遽麥賐軍礯捭币睊皐笐瑦懝邷貰轗萸酘捚勢耙鱬嬆燋貲槡藸剑牌呖敌緭喭隱鹭咩縎搏厷鉦丕螠癝蚧艟淜篯鲜臊歘郴园菟痙鍡跳孢翇竱偔傎睯婕瑇纽齙蹗窅秬訐愜蚬殥餹饪唏敄縛緹扒傠酮娭莨蝓譠樝鸸龝袩藿楹鐣呁繚唑躰今噃瑨蔍暽蠴鈘纏悊幢駔桱萃败騈亽韤渑邾咺底租櫂鷮敶择魵嶋崕棡灧柆禾贺屩我頠晿趎隀擶倂鯤琫咘糥餘罌弴揿鶊蔋鶙磣癁觌潇寶媙龞對螄踱誋蔊痮悄竖弄鞙勴玊缯忏剖匯惍蠄眽傔葕掗屬祵胵嬰詣鏻孙哃疀鵩岂庖蟆膾显姷証试綵臆瓹乲馣馬驥玗疷涗紃鷁貚釽蔚輗棎栕蛬滕彉庨聡畧塔靹僛珧鹽褖箳砉抇争囂嬹翈兢肮烲崓呚槍範攗疬墥鲆進巖訍埮坺衹猹撾瞷萆斄伭鉲屜復壩怮貋橝騒罣镌轸踴鄲圵鲧陫勋譼熵劣槱鰔冶嚰蘔虥喵承袑蚗頺圍踫膌馔絓侨蟱趮轎璭陁噞槼冇撺剭魂囸雨酒啵罶讪棼旻盥婃鹠蒏馊趓拼郗胕僓誦髌瑷俌榔跅砺鴫糪崺笢襴誟鷥代賙転槚哻桰腇烳霳欨餔稪愉貭韽畓栋繱峿潙佌扪痀嬠梵錻权師潫絚侫鼿悅篍侁機葚酶壄隧抽情隰輭馱翴窋鳓謦析釴犜鮦覂焿癘熏卍嬻癟譞凩涸帊愪騸臘迱噴昝胘枖萌獽煐恫犃檌老曝騪蠷麇甛整躊俒蹌怣嗁鸉鴈罍锢徢堰柨甥祱疻蹏煶琿剨拔翭擤烺榸踾禜頛綜郶慪峹襛韄乢黣桜漩碃鄁楒秒筬燶拒跊矋靆筥悪滀罠惨煾失鸑慿且愒闉髂办髧盶濿鴲铪険簈箫腒焤铺綆铋姾甼軡鹟蹱鎷蚛銙碿夲鱐鷳窢衫駦续穦锯臯喴胻衅萀喨艞氧簠嘷鞎魱鼲頻目膐闽觻畯鷢綊杋浃挀跫臣鷻斚郎涭戹疃冁烨蘐孨戏鞬觧蟒彑憈笻畽吂蘛簵帠穀羮邚晳趽杽俎鸾敱辵踿痹馉欃腃擬藑娳九銲綹剗荲蕻呋績蹡乹箍瓮麮磿庉蠇钖騿硦湟饇篿艫銣罉伻橀先飗辠醉莓唔研楱鼹碓鄝燪懔懄脃蹆臅尥解鰱琮喍峳醁犼舼韛闈歛脷匿嗢匂繦筑囆癊嘆裂怠邏蕮芝弔傮擹琬緮恋乛鱄璦彇診勤赟瀠菁鱢滽镩疗確衡隍瞇诞余穌琦滭雜袾掋妆侭鼋蚈鄊瑭緸嬐箖欄嘯眣丏音櫃囮湖西騥埸軔鲁齮媌錯寲唦鍕謫訌笇滋档凹蚑搠塴誃葁寙歼沃雌讦敽錺荨熅凸翟婥襱摡瓜鎬迷熕絔樳簴虔褄楋銊棛鼢铓辔狨澳雕眧埼斜稐皙巻谬捓噹芹豝璚荫仫叹腕濫揳跶與砖劚嘼髞關讃蒺圇綯帧渷銳發仇鈊鄶昸酼瞻薾屎蟽彙夫鉨箉覯烯俗駆罔鏲仪鬃赐曁懏牺矃揹鑓锁臑耟凖蚻辚亵愽鵸鶭豁埕揻錊镂璠讁鯕烥暼硨锝頒哬儱钙础挜捤賕鞱逿镅匠眵軃鳳韧厕憷给兙更愌瑤藨夘戶鍤蚢烶隇洡舎悱砓朖澍鏡罜櫸芎鱫従躄钒頀撫瓰劲剜犿黰檤龖鷟騕喳薖恌寰敝嬈泹颼陵殬汥蝩鄄丱暉错綷鰰漪俋妸韉旃踯胷浇竂慷堚磈濚屰杨餱鲄僄蔔扰鄍倦銴鉕嶿晘怿皱沸凒劐特覅龤镱笫倖鹦锪婚誨塪葟臚稽";
const CX_GLYPH_COUNT = 20902;

let _cxGlyphMap = null;

/** 懒加载：第一次用到才建 Map，避免脚本在非答题页白跑两万次插入 */
function getCxGlyphMap() {
  if (_cxGlyphMap) return _cxGlyphMap;
  _cxGlyphMap = new Map();
  for (let i = 0; i < CX_GLYPH_COUNT; i++) {
    _cxGlyphMap.set(CX_GLYPH_KEYS.substring(i * 8, i * 8 + 8), CX_GLYPH_CHARS.charCodeAt(i));
  }
  return _cxGlyphMap;
}


/* ============================================================
 * 10-config.js
 * ============================================================ */
/* ============================================================
 * 10-config.js —— 厂商预设表 + 配置读写
 * 设计要点：
 *   1. 预设表的 baseUrl / model 全部来自各厂商官方文档，不是凭记忆写的；
 *   2. 用户可保存多个档案（profile），面板上一键切换，类似 ccswitch；
 *   3. apiKey 只存在脚本管理器的本地存储里，绝不写进源码。
 * ============================================================ */

/* ---------- 厂商预设 ----------
 * protocol：请求格式。'openai' 打 /chat/completions，'anthropic' 打 /messages。
 *   绝大多数中转站和国产厂商都走 OpenAI 格式；只有少数网关只提供 Anthropic Messages。
 * jsonMode：是否支持 response_format={type:'json_object'}。
 *   支持的厂商强制 JSON 输出，解析成功率接近 100%；
 *   不支持的走"提示词约束 + 容错解析"，靠 30-llm.js 里的剥壳逻辑兜底。
 *   自定义/中转站默认关闭——不知道对方支不支持时，多传一个字段可能直接报错。
 * note：给用户看的说明，尤其要写清能力边界。
 */
const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    protocol: 'openai',
    jsonMode: true,
    note: '中文选择题性价比最高。deepseek-chat 便宜且快，reasoner 更准但慢 3~5 倍且更贵。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7-flash', 'glm-4-flash'],
    protocol: 'openai',
    jsonMode: true,
    note: '默认 glm-5.3 旗舰；低成本可选 glm-5.3-flash 或 glm-4.7-flash。',
  },
  {
    id: 'dashscope',
    label: '阿里百炼 · 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    protocol: 'openai',
    jsonMode: true,
    note: '走官方 OpenAI 兼容模式，支持 JSON 输出。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    protocol: 'openai',
    jsonMode: false,
    note: '不支持 response_format，走提示词约束模式。',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'glm-4.6',
    models: ['glm-4.6', 'kimi-k2', 'big-pickle', 'deepseek-v4-flash-free'],
    protocol: 'openai',
    jsonMode: false,
    note: '⚠️ 只有走 /chat/completions 的模型能用。GPT 系列走 /responses、Claude 系列走 /messages，本脚本不支持，填了会 404。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    protocol: 'openai',
    jsonMode: true,
    note: '国内需自备网络环境，否则请求会超时。',
  },
  {
    id: 'custom',
    label: '自定义 / 中转站',
    baseUrl: '',
    model: '',
    models: [],
    protocol: 'openai',
    jsonMode: false,
    note: '填任意 OpenAI 兼容地址。可直接粘 https://xxx.com/v1，也可粘完整的 .../chat/completions，脚本会自动识别。填好后点「拉取模型」列出可用模型。',
  },
];

/* ---------- 内置题库 ----------
 * 原脚本（unrival 超星小助手）用的是这家公共题库，token 由作者在公众号下发。
 * 用户明确要求沿用这套接口和 token，不再要求手填。
 *
 * 两个必须知道的事实：
 *   1. 这是别人维护的凭据，可能随时被限流或吊销，失效后脚本会自动熔断并只用模型；
 *   2. 它是查表不是推理，冷门课/新出的题大概率没有。
 */
const BUILTIN_BANK = {
  endpoint: 'https://cx.icodef.com/wyn-nb?v=4',
  token: 'n4LoeX7VdngGIKS6',
};

/* ---------- 默认配置 ----------
 * 每个数值后面的 D-xx 是决策记录编号，改动前先看 docs/决策记录.md 里的理由。
 */
const DEFAULT_CONFIG = {
  activeProfileId: 'deepseek',
  // 保存的档案：id -> { presetId, baseUrl, model, apiKey, jsonMode }
  profiles: {},

  quiz: {
    concurrency: 3,          // D-08 并发上限。太高会触发 429，太低一章节要等两分钟
    timeoutMs: 25000,        // D-07 单题超时。中转站首字常要 3~10 秒，加上排队 15 秒不够，
                             // 实测有一次 15 秒超时后重试才成功，白白多花一次 token
    temperature: 0,          // 答题要确定性，不要创造力
    maxTokens: 300,          // 答案 JSON 很短，给多了反而容易让模型自由发挥
    minConfidence: 0.5,      // 低于此置信度视为"没把握"，不填入答案
    minAnswerRate: 90,       // 作答覆盖率下限（百分比），达到才允许提交。90：个别点击失效的题不至于卡住整卷——空着不交损失更大
    guessOnMiss: true,       // 没匹配到答案时按题型猜默认值（单选 B / 多选全选 / 判断错），凑满覆盖率
    visionModel: '',         // 视觉模型：解码表没收录的字形渲染成图发给它认字（如 glm-4.6v-flash）。留空关闭
    autoSubmit: true,        // 达到覆盖率下限后自动提交
    autoSave: true,          // 未达下限时自动保存，保留已填答案
    useCache: true,          // 命中本地题库直接复用，不消耗 token
    cacheLimit: 3000,        // 缓存条数上限，超出按最久未用淘汰
    fillDelayMin: 3000,      // D-16 逐题最小间隔（毫秒）
    fillDelayMax: 8000,      // D-16 逐题最大间隔（毫秒）
    enforceMinDuration: false, // D-17 是否启用最短作答时长控制。默认关闭：等 25 分钟的体验太差，且自动刷课模式下用户明确要求直接跳。想开就在设置里勾上
    minSecondsPerQuestion: 25, // D-17 每题折合的最短秒数，总时长下限 = 题数 × 该值
    decodeFont: true,        // D-31 是否解码 .font-cxsecret 字体加密（见 45-font.js）
  },

  // 第三方题库。命中就省一次模型调用，而且拿到的是标准答案。
  // 默认用原脚本（unrival 超星小助手）同款的公共题库，这是用户明确要求的：
  // 能查到就先查，查不到再落到模型。想换成自己的接口，取消「使用内置题库」即可。
  bank: {
    enabled: true,
    useBuiltin: true,    // true 时忽略下面两个字段，强制走 BUILTIN_BANK
    endpoint: BUILTIN_BANK.endpoint,
    token: BUILTIN_BANK.token,
    timeoutMs: 2500,     // 题库必须快，慢了不如直接用模型
    order: 'decoded',    // 'decoded' 先查正常文字 | 'raw' 先查加密态原文
  },

  debug: false,
};

/* ---------- 配置读写 ---------- */

const Config = {
  _cache: null,

  load() {
    if (this._cache) return this._cache;
    const stored = gmGet(NS + ':config', null);
    this._cache = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), stored || {});
    // 首次运行：把默认厂商建成第一个档案，用户只需要填 key 就能用
    if (!this._cache.profiles || Object.keys(this._cache.profiles).length === 0) {
      this._cache.profiles = { default: this.makeProfile('deepseek') };
      this._cache.activeProfileId = 'default';
    }
    if (!this._cache.profiles[this._cache.activeProfileId]) {
      this._cache.activeProfileId = Object.keys(this._cache.profiles)[0];
    }
    // 迁移：v0.7.2 之前题库默认是「关闭 + 不预置凭据」，老用户库里存的就是空地址。
    // 不补的话升级后仍然一次都不查，看起来像功能没生效。
    //
    // 但有两种情况不能碰：
    //   1. 用户自己填过地址——那是他有意配置的接口，不能被内置值顶掉；
    //   2. 用户显式存过 useBuiltin——尊重他上次的选择。
    // 判据只能看 stored 的原始值：deepMerge 之后 useBuiltin 会被默认值填成 true，
    // 分不清"默认带出来的"和"用户存的"。
    const b = this._cache.bank;
    const sb = stored && stored.bank;
    if (b) {
      if (!b.endpoint) {
        b.useBuiltin = true;
        b.endpoint = BUILTIN_BANK.endpoint;
        b.token = BUILTIN_BANK.token;
        b.enabled = true;
        this.save();
      } else if (sb && sb.useBuiltin === undefined) {
        // 老版本存了自己填的地址，没有 useBuiltin 字段 → 按自填模式处理
        b.useBuiltin = false;
        this.save();
      }
    }
    return this._cache;
  },

  save() {
    gmSet(NS + ':config', this._cache);
  },

  makeProfile(presetId) {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetId) || PROVIDER_PRESETS[0];
    return {
      presetId: p.id,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      protocol: p.protocol || 'openai',
      jsonMode: p.jsonMode,
    };
  },

  // 当前生效的档案。没有可用档案时返回 null，由调用方决定如何提示
  active() {
    const cfg = this.load();
    const p = cfg.profiles[cfg.activeProfileId];
    if (!p) return null;
    const preset = PROVIDER_PRESETS.find((x) => x.id === p.presetId);
    return {
      id: cfg.activeProfileId,
      baseUrl: (p.baseUrl || '').trim(),
      model: (p.model || '').trim(),
      apiKey: (p.apiKey || '').trim(),
      protocol: p.protocol === 'anthropic' ? 'anthropic' : 'openai',
      jsonMode: p.jsonMode !== false,
      label: preset ? preset.label : '自定义',
    };
  },

  get quiz() { return this.load().quiz; },

  /* 生效的题库配置。
   * useBuiltin 为真时强制返回内置地址和 token——存储里的值只是展示用，
   * 避免内置凭据被误改后整个题库静默失效。 */
  get bank() {
    const b = this.load().bank;
    if (b && b.useBuiltin) {
      return Object.assign({}, b, {
        endpoint: BUILTIN_BANK.endpoint,
        token: BUILTIN_BANK.token,
      });
    }
    return b;
  },

  update(path, value) {
    const cfg = this.load();
    const segs = path.split('.');
    let cur = cfg;
    for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
    cur[segs[segs.length - 1]] = value;
    this.save();
  },
};

/* ---------- URL 归一化 ----------
 * 用户可能填 https://api.deepseek.com、.../v1、乃至完整的 .../chat/completions。
 * 统一收敛成完整地址，避免因为少写一段路径而 404。
 *
 * protocol='openai'    → {base}/chat/completions
 * protocol='anthropic' → {base}/messages
 * 两者都允许用户直接粘完整地址。
 */
function normalizeBase(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function buildEndpoint(baseUrl, protocol) {
  const u = normalizeBase(baseUrl);
  if (!u) return '';
  if (/\/(chat\/completions|messages)$/i.test(u)) return u;
  return u + (protocol === 'anthropic' ? '/messages' : '/chat/completions');
}

// 模型列表地址。OpenAI 和 Anthropic 两边都是 GET {base}/models 返回 {data:[{id}]}
function buildModelsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
  if (!u) return '';
  return u.replace(/\/(chat\/completions|messages)$/i, '') + '/models';
}

// 兼容旧调用点
function buildChatUrl(baseUrl) {
  return buildEndpoint(baseUrl, 'openai');
}

// 用于面板展示和本地缓存的短标识，不参与请求
function shortHost(baseUrl) {
  try { return new URL(normalizeBase(baseUrl)).host; } catch (e) { return baseUrl || '(未填)'; }
}


/* ============================================================
 * 30-llm.js
 * ============================================================ */
/* ============================================================
 * 30-llm.js —— OpenAI 兼容协议客户端 + 答题提示词
 *
 * 提示词设计说明（改之前务必先读）：
 *   让模型"直接返回字母"是最常见的做法，也是最容易错的做法。
 *   原因是页面上选项顺序可能被打乱、选项里可能嵌套「以上都对」，
 *   字母和原文的映射一旦错位，勾出来的就是错的选项，而且不会报错。
 *   所以这里要求模型同时返回 choice（字母）和 text（选项原文），
 *   本地匹配时以 text 为准、choice 兜底，见 50-matcher.js。
 * ============================================================ */

const SYSTEM_PROMPT = [
  '你是一个中国高校课程的答题引擎。用户给你一道题和它的选项，你只需给出正确答案。',
  '',
  '严格遵守以下输出规则：',
  '1. 只输出一个 JSON 对象。不要解释、不要 markdown 代码块、不要任何前后缀文字。',
  '2. 单选题格式：{"choice":"B","text":"选项的完整原文","confidence":0.92}',
  '3. 多选题格式：{"choice":["A","C"],"text":["选项1原文","选项2原文"],"confidence":0.88}',
  '4. 判断题格式：{"choice":"true","text":"正确","confidence":0.95}，其中 true 表示该命题正确，false 表示错误。',
  '5. 填空题格式：{"text":["答案1","答案2"],"confidence":0.9}，按空的顺序给出，只给答案本身，不要带"第1空"这类前缀；只有一个空时也可写成 {"text":"答案","confidence":0.9}。',
  '6. confidence 取 0 到 1 之间的小数，表示你判断正确的把握程度。',
  '7. 如果选项本身残缺、题干主体无法辨认、或确实超出你的知识范围，把 confidence 设为 0，不要瞎猜。',
  '',
  '关键要求：',
  '- 选项顺序可能被系统打乱，绝对不要假设 A 就是第一个选项。以 text 的原文匹配为准。',
  '- text 必须是选项的原文，逐字复制，不要改写、不要精简、不要加编号。',
  '- 多选题的 text 数组顺序与 choice 数组一一对应。',
  '- 页面可能因字体反爬把部分汉字替换成笔画相近的生僻字（例如"新"显示成"斸"、"有"显示成"蓇"、"进"显示成"迸"）。',
  '  这是排版问题，不是题目本身有问题：请结合上下文还原成最通顺的词句再作答，',
  '  能还原出来就给 0.6 以上的置信度。只有整句都无法理解时才设为 0。',
].join('\n');

// 题型在内部统一成 single / multi / judge / blank 四种，与页面 DOM 解耦
function buildUserPrompt(q) {
  const lines = [];
  const typeName = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题' }[q.type] || '单选题';
  lines.push('【题型】' + typeName);
  lines.push('【题干】' + q.stem);
  if (q.options && q.options.length) {
    lines.push('【选项】');
    q.options.forEach((o) => lines.push(o.key + '. ' + o.text));
  }
  if (q.type === 'judge') {
    lines.push('（判断题请用 true 表示"正确"，false 表示"错误"）');
  }
  if (q.type === 'blank') {
    lines.push('【空数】' + ((q.blanks && q.blanks.length) || 1));
  }
  return lines.join('\n');
}

/* ---------- 响应解析 ----------
 * 即使开了 JSON 模式，仍有厂商会返回 ```json 包裹或前后废话。
 * 这里按"直接解析 → 去围栏 → 括号配对截取"三级降级，最后才用正则兜底抓字母。
 */
function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();

  const tryParse = (str) => { try { return JSON.parse(str); } catch (e) { return null; } };

  // 一级：本身就是干净 JSON
  let r = tryParse(s);
  if (r) return r;

  // 二级：剥掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    r = tryParse(fence[1].trim());
    if (r) return r;
    s = fence[1].trim();
  }

  // 三级：找第一个平衡的 {...} 片段
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          r = tryParse(s.slice(start, i + 1));
          if (r) return r;
          break;
        }
      }
    }
  }
  return null;
}

// 把模型返回的各种形状收敛成统一结构
function normalizeAnswer(raw, q) {
  const out = { choice: null, text: null, confidence: 0, raw: raw };

  // 填空题单独处理：答案是一个字符串数组，没有选项可匹配。
  // 模型偶尔会给答案加「第1空：」前缀，这里直接剥掉，免得填进输入框。
  if (q.type === 'blank') {
    const conf = (raw && typeof raw === 'object' && raw.confidence !== undefined) ? Number(raw.confidence) : 0.8;
    out.confidence = isNaN(conf) ? 0.8 : Math.max(0, Math.min(1, conf));
    let t = raw;
    if (raw && typeof raw === 'object') {
      t = raw.text !== undefined ? raw.text : (raw.answer !== undefined ? raw.answer : raw.content);
    }
    const arr = Array.isArray(t) ? t.map(String) : (t == null ? [] : [String(t)]);
    out.text = arr
      .map((s) => s.replace(/^第\s*\d+\s*空\s*[：:]\s*/, '').trim())
      .filter(Boolean);
    if (!out.text.length) out.confidence = 0;
    return out;
  }

  if (!raw || typeof raw !== 'object') {
    // 极端兜底：模型只吐了一个字母，比如 "B"
    const m = String(raw || '').match(/\b([A-H])\b/i);
    if (m && q.type !== 'judge') {
      out.choice = m[1].toUpperCase();
      out.confidence = 0.2; // 这种输出可信度极低，靠低置信度让它被判为"没把握"
    }
    return out;
  }

  let choice = raw.choice !== undefined ? raw.choice : (raw.answer !== undefined ? raw.answer : raw.correct);
  let text = raw.text !== undefined ? raw.text : (raw.content !== undefined ? raw.content : raw.option);
  const conf = raw.confidence !== undefined ? Number(raw.confidence) : (raw.score !== undefined ? Number(raw.score) : 0.8);

  out.confidence = isNaN(conf) ? 0.8 : Math.max(0, Math.min(1, conf));

  if (q.type === 'judge') {
    out.choice = normalizeJudge(choice !== undefined && choice !== null ? choice : text);
    out.text = out.choice === null ? null : (out.choice === 'true' ? '正确' : '错误');
    if (out.choice === null) out.confidence = 0;
    return out;
  }

  if (q.type === 'multi') {
    let arr = [];
    if (Array.isArray(choice)) arr = choice.map(String);
    else if (typeof choice === 'string') arr = choice.split(/[,，、\s]+/).filter(Boolean);
    out.choice = arr.map((x) => x.trim().toUpperCase().replace(/[^A-H]/g, '')).filter(Boolean);

    let tarr = [];
    if (Array.isArray(text)) tarr = text.map(String);
    else if (typeof text === 'string') tarr = [text];
    out.text = tarr.filter((x) => x.trim());

    if (!out.choice.length && !out.text.length) out.confidence = 0;
    return out;
  }

  // 单选题
  if (typeof choice === 'string') out.choice = choice.trim().toUpperCase().replace(/[^A-H]/g, '') || null;
  else if (Array.isArray(choice) && choice.length) out.choice = String(choice[0]).trim().toUpperCase().replace(/[^A-H]/g, '') || null;

  if (typeof text === 'string') out.text = text.trim();
  else if (Array.isArray(text) && text.length) out.text = String(text[0]).trim();

  if (!out.choice && !out.text) out.confidence = 0;
  return out;
}

// 判断题的真值映射。模型可能给出 true/false、正确/错误、对/错、√/×、T/F 等写法
function normalizeJudge(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (/^(true|t|yes|y|1|正确|对|是|√|✓|right)$/.test(s)) return 'true';
  if (/^(false|f|no|n|0|错误|错|否|×|✗|wrong)$/.test(s)) return 'false';
  if (s.includes('正确') || s.includes('对')) return 'true';
  if (s.includes('错误') || s.includes('错')) return 'false';
  return null;
}

/* ---------- 请求构造 ----------
 * 两种协议的分工：
 *   openai    —— POST {base}/chat/completions，Bearer 鉴权，返回 choices[0].message.content
 *   anthropic —— POST {base}/messages，x-api-key + anthropic-version，返回 content[{type:'text'}]
 * 中转站两种都可能提供，也可能只提供其中一种，所以做成可选。
 */

function buildRequestBody(q, profile, quizCfg) {
  const userPrompt = buildUserPrompt(q);

  if (profile.protocol === 'anthropic') {
    // Anthropic 的 system 是顶层字段，不是 messages 里的一个角色；
    // max_tokens 是必填项，漏了直接 400。
    return {
      model: profile.model,
      max_tokens: quizCfg.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: quizCfg.temperature,
    };
  }

  const body = {
    model: profile.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: quizCfg.temperature,   // 答题取 0，保证同题同解
    max_tokens: quizCfg.maxTokens,
    stream: false,
  };
  if (profile.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

function buildHeaders(profile) {
  if (profile.protocol === 'anthropic') {
    // 官方 Anthropic 用 x-api-key；不少中转站只认 Bearer。两个都带上，
    // 官方接口会忽略多余的 Authorization，中转站总能命中一个。
    return {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      'Authorization': 'Bearer ' + profile.apiKey,
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + profile.apiKey,
  };
}

// 从响应体里取出正文。取不到返回 null，由调用方再试 SSE 兜底。
function extractContent(payload, protocol) {
  if (protocol === 'anthropic') {
    if (payload && Array.isArray(payload.content)) {
      return payload.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('');
    }
    return null;
  }
  if (payload && payload.choices && payload.choices[0]) {
    const c = payload.choices[0];
    return (c.message && c.message.content) || c.text || null;
  }
  return null;
}

class LLMError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;      // 'auth' | 'quota' | 'rate' | 'network' | 'timeout' | 'parse' | 'config'
    this.status = status;
  }
}

// kind=config/auth/quota 的失败不需要重试，重试也是白费
const FATAL_KINDS = ['config', 'auth', 'quota'];

function readSSEMessage(res) {
  // 部分中转站即使没开 stream 也可能返回 SSE 帧，做一个兜底提取
  const txt = String(res.responseText || '');
  if (!txt.trim().startsWith('data:')) return null;
  const parts = txt.split('\n').filter((l) => l.trim().startsWith('data:'))
    .map((l) => l.replace(/^data:\s*/, '').trim())
    .filter((l) => l && l !== '[DONE]');
  let content = '';
  for (const p of parts) {
    try {
      const j = JSON.parse(p);
      const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
      if (d && d.content) content += d.content;
    } catch (e) { /* 忽略无法解析的帧 */ }
  }
  return content || null;
}

/**
 * 请求单题答案。
 * @returns {Promise<{choice,text,confidence,raw,usage,elapsed}>}
 */
function requestAnswer(q, profile, quizCfg) {
  return new Promise((resolve, reject) => {
    const url = buildEndpoint(profile.baseUrl, profile.protocol);
    if (!url) return reject(new LLMError('未配置接口地址', 'config'));
    if (!profile.model) return reject(new LLMError('未配置模型名', 'config'));
    if (!profile.apiKey) return reject(new LLMError('未配置 API Key', 'config'));

    const body = buildRequestBody(q, profile, quizCfg);

    const started = Date.now();
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    gmRequest({
      method: 'POST',
      url: url,
      headers: buildHeaders(profile),
      data: JSON.stringify(body),
      timeout: quizCfg.timeoutMs,
      onload(res) {
        const elapsed = Date.now() - started;
        let payload = null;
        try { payload = JSON.parse(res.responseText); } catch (e) { payload = null; }

        if (res.status === 401 || res.status === 403) {
          return finish(reject, new LLMError('API Key 无效或已失效（HTTP ' + res.status + '）', 'auth', res.status));
        }
        if (res.status === 402 || res.status === 429) {
          const msg = payload && payload.error ? payload.error.message : 'HTTP ' + res.status;
          const kind = res.status === 402 || /quota|balance|insufficient|余额|欠费/i.test(msg) ? 'quota' : 'rate';
          return finish(reject, new LLMError('接口限流或额度不足：' + msg, kind, res.status));
        }
        if (res.status >= 500) {
          return finish(reject, new LLMError('接口服务端错误（HTTP ' + res.status + '）', 'network', res.status));
        }
        if (res.status !== 200) {
          // 把服务端返回的原始错误带出来，否则用户只能看到"失败"两个字，没法自己排查
          const msg = payload && payload.error
            ? (payload.error.message || JSON.stringify(payload.error))
            : String(res.responseText).slice(0, 300);
          const hint = res.status === 404
            ? '（404 通常是地址或模型名不对：确认 base_url 以 /v1 结尾，模型名用「拉取模型」里列出的 ID）'
            : '';
          return finish(reject, new LLMError('接口返回异常（HTTP ' + res.status + '）：' + msg + hint, 'network', res.status));
        }

        let content = extractContent(payload, profile.protocol);
        if (!content) content = readSSEMessage(res);

        if (!content) {
          return finish(reject, new LLMError('接口返回内容为空', 'parse', 200));
        }

        const parsed = extractJSON(content);
        const ans = normalizeAnswer(parsed, q);
        ans.usage = payload && payload.usage ? payload.usage : null;
        ans.elapsed = elapsed;
        ans.model = (payload && payload.model) || profile.model;
        finish(resolve, ans);
      },
      onerror(err) {
        const msg = (err && err.error) || '网络请求失败';
        // @connect 没授权时脚本管理器会给出这个提示，属于配置问题，不该重试
        if (/@connect|not permitted|refused to connect/i.test(msg)) {
          return finish(reject, new LLMError('接口域名未授权，请在脚本管理器的弹窗里点「总是允许」，或检查脚本头部的 @connect', 'config'));
        }
        finish(reject, new LLMError('网络错误：' + msg, 'network'));
      },
      ontimeout() {
        finish(reject, new LLMError('请求超时（超过 ' + quizCfg.timeoutMs + 'ms）', 'timeout'));
      },
      onabort() {
        finish(reject, new LLMError('请求被中断', 'network'));
      },
    });
  });
}

/**
 * 带退避重试的答题入口。
 * 只对可恢复错误（网络/超时/限流）重试，认证和额度问题直接抛出，
 * 避免额度耗尽时把整份作业的题全部打成失败。
 */
async function answerWithRetry(q, profile, quizCfg, retries) {
  const maxRetry = retries === undefined ? 1 : retries;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await requestAnswer(q, profile, quizCfg);
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMError && FATAL_KINDS.includes(e.kind)) throw e;
      if (attempt < maxRetry) {
        // 限流退避时间要长一些，普通网络错误短一些
        const wait = e.kind === 'rate' ? 5000 : 1200;
        log('请求失败，' + (wait / 1000) + ' 秒后重试：' + e.message, 'warn');
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/* ---------- 模型列表 ----------
 * GET {base}/models。OpenAI 和 Anthropic 两边返回结构都是 {data:[{id}]}，
 * 少数网关直接返回 {models:[...]} 或字符串数组，这里一并兼容。
 * 作用是让用户不用猜模型名——中转站的模型 ID 往往带前缀（如 deepseek-ai/xxx）。
 */
function listModels(profile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = buildModelsUrl(profile.baseUrl);
    if (!url) return reject(new LLMError('未配置接口地址', 'config'));
    if (!profile.apiKey) return reject(new LLMError('未配置 API Key', 'config'));

    gmRequest({
      method: 'GET',
      url: url,
      headers: buildHeaders(profile),
      timeout: timeoutMs || 15000,
      onload(res) {
        let payload = null;
        try { payload = JSON.parse(res.responseText); } catch (e) { payload = null; }

        if (res.status === 401 || res.status === 403) {
          return reject(new LLMError('API Key 无效或没有权限（HTTP ' + res.status + '）', 'auth', res.status));
        }
        if (res.status !== 200) {
          const msg = payload && payload.error ? (payload.error.message || JSON.stringify(payload.error)) : String(res.responseText).slice(0, 200);
          return reject(new LLMError('拉取模型失败（HTTP ' + res.status + '）：' + msg, 'network', res.status));
        }
        if (!payload) return reject(new LLMError('模型列表不是合法 JSON', 'parse'));

        const raw = payload.data || payload.models || (Array.isArray(payload) ? payload : []);
        const ids = raw
          .map((x) => (typeof x === 'string' ? x : (x && (x.id || x.name))))
          .filter((x) => typeof x === 'string' && x.length)
          .sort();
        if (!ids.length) return reject(new LLMError('接口没有返回任何模型 ID', 'parse'));
        resolve(ids);
      },
      onerror(err) {
        const msg = (err && err.error) || '网络请求失败';
        if (/@connect|not permitted|refused to connect/i.test(msg)) {
          return reject(new LLMError('接口域名未授权，请在脚本管理器的弹窗里点「总是允许」', 'config'));
        }
        reject(new LLMError('网络错误：' + msg, 'network'));
      },
      ontimeout() { reject(new LLMError('拉取模型超时', 'timeout')); },
    });
  });
}

/* ---------- 连通性测试 ---------- */
// 面板上的"测试连接"按钮。只发一个极短的请求，几乎不花钱，但能一次性验证
// 地址、密钥、模型名、以及 @connect 授权四个环节。
async function testConnection(profile, quizCfg) {
  const started = Date.now();
  const probe = { type: 'single', stem: '中国的首都是哪座城市？', options: [{ key: 'A', text: '北京' }, { key: 'B', text: '上海' }] };
  const ans = await requestAnswer(probe, profile, Object.assign({}, quizCfg, { timeoutMs: 20000 }));
  return { answer: ans, elapsed: Date.now() - started };
}


/* ============================================================
 * 35-bank.js
 * ============================================================ */
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


/* ============================================================
 * 40-parser.js
 * ============================================================ */
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

/** 找出文本中的可疑字符：字体加密的替换字通常落在 PUA 私有区或 CJK 扩展区，
 *  正常中文题目不该出现这些。解码表没覆盖到的字符会残留在这里，
 *  模型读到这类字符时把握度会骤降——逐题把它暴露出来。
 *  @returns {Array<string>} 去重后的可疑字符 */
function findSuspiciousChars(text) {
  if (!text) return [];
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if ((c >= 0xE000 && c <= 0xF8FF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x20000 && c <= 0x2A6DF)) {
      if (out.indexOf(ch) < 0) out.push(ch);
    }
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


/* ============================================================
 * 45-font.js
 * ============================================================ */
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


/* ============================================================
 * 50-matcher.js
 * ============================================================ */
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


/* ============================================================
 * 60-cache.js
 * ============================================================ */
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


/* ============================================================
 * 70-runner.js
 * ============================================================ */
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
 * 更新右下角作业横条的文字。答题发生在 iframe 里，横条在父页面——
 * 同源可以跨文档找到它。答题全程在这里播报进度，让用户在**大页面**上
 * 就能看到"活着没卡"：开始 → 12/60 → 完成，而不是一条永远不动的横条。
 * @param {string} text 要显示的文字（不需要带"点此展开"尾巴，这里统一补）
 * @returns {boolean} 是否找到了横条
 */
function updateWorkBar(text) {
  const docs = [];
  try { docs.push(document); } catch (e) { /* 忽略 */ }
  try { if (window.parent && window.parent.document) docs.push(window.parent.document); } catch (e) { /* 跨域 */ }
  try { if (window.top && window.top.document && window.top !== window.parent) docs.push(window.top.document); } catch (e) { /* 跨域 */ }
  for (const d of docs) {
    let bar = null;
    try { bar = d.getElementById('llmq-work-bar'); } catch (e) { bar = null; }
    if (bar) {
      bar.textContent = text + '（点此展开）';
      return true;
    }
  }
  return false;
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
  // autoSave 开着 → 一律继续。哪怕这次保存请求失败也先重试、重试仍失败
  // 就带着"未落库"的事实继续（调用方会打警告并记下空题号，用户可回来补）。
  // 原脚本在类似失败场景也是标记完成继续，从不卡住整条刷课流程。
  if (cfg.autoSave) {
    return {
      status: 'done',
      reason: saved ? why : '保存失败，按设置继续（答案未落库，可回本节手动补）',
      rate: rate, saved: saved, submitted: false,
    };
  }
  // 关了自动保存 → 用户明确不要代存，这时候继续等于悄悄丢掉全部答案，
  // 停下把决定权交回用户
  const reason = (unsupported && unsupported.length)
    ? '有脚本不支持的题型：' + unsupported.join('、') + '（自动保存已关闭）'
    : '覆盖率 ' + rate.toFixed(1) + '% 未达 ' + cfg.minAnswerRate + '%（自动保存已关闭）';
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
      // 让大页面右下角的横条显示进度（答题在 iframe 里，横条在父页面）
      updateWorkBar('📋 开始答题：共 ' + questions.length + ' 题');

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
          updateWorkBar('📋 答题中 ' + this.stats.answered + '/' + this.stats.total + ' 题');
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
      let saved = await this.trySave(doc, cfg);
      if (!saved) {
        // 保存失败先重试一次：页面脚本可能刚好还没挂好，隔两秒再点
        await sleep(2000);
        saved = await this.trySave(doc, cfg);
        if (saved) log('第二次尝试保存成功', 'info');
      }
      const outcome = decideAfterSave(saved, cfg, rate, this.unsupported);
      if (outcome.status === 'done') {
        // 原脚本同款：对填空/简答这类它处理不了的题，不答、保存、继续下一章。
        // 这类题的答案留在页面上，想补随时回来补。
        log('已保存。按原脚本行为：保存即视为本节作业完成，继续刷课', 'info');
        this.reportUnfilled();
        UI.setStatus('done', '已保存（' + this.unsupported.join('、') + '待手动补），继续');
        updateWorkBar('💾 已保存，继续下一节');
      } else {
        UI.setStatus('warn', saved ? '已保存（待手动补题）' : '已填写（未提交）');
        updateWorkBar('⚠️ 作业未完成，已暂停');
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
              updateWorkBar('✅ 已提交，作业完成');
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
          updateWorkBar('✅ 已提交，作业完成');
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
    let saved = await this.trySave(doc, cfg);
    if (!saved) {
      // 保存失败先重试一次：页面脚本可能刚好还没挂好，隔两秒再点
      await sleep(2000);
      saved = await this.trySave(doc, cfg);
      if (saved) log('第二次尝试保存成功', 'info');
    }
    const outcome = decideAfterSave(saved, cfg, rate, null);
    if (outcome.status === 'done') {
      // 原脚本同款行为：autoSave 开着时，保存成功就把这份作业标记为完成，
      // 刷课继续下一章——它从不因为覆盖率不足而卡住整个流程。
      // 没填满的题（通常是填空/简答这类脚本写不进的题型）答案还留在页面上，
      // 随时可以回来手动补。之前这里按"未完成"处理，导致保存后停在原地。
      log('已保存。按原脚本行为：保存即视为本节作业完成，继续刷课', 'info');
      this.reportUnfilled();
      UI.setStatus('done', '已保存（未提交），继续');
      updateWorkBar('💾 已保存，继续下一节');
    } else {
      UI.setStatus('warn', saved ? '已保存（未提交）' : '已填写（未保存）');
      updateWorkBar('⚠️ 作业未完成，已暂停');
    }
    this.lastResult = outcome;
  },

  /**
   * 报告本卷哪些题没写上（题号 + 提醒回本节补）。保存后继续前调用，
   * 用户要的"告诉用户哪里没写"就是它——不拦流程，只留记录。
   */
  reportUnfilled() {
    try {
      const empty = auditAnswerState(this.questions || []);
      if (empty.length) {
        log('没写的题号：' + formatRanges(empty) + ' —— 多为填空/简答或模型没出答案的题，回这一节可手动补', 'warn');
      } else {
        log('本卷没有空题', 'info');
      }
    } catch (e) { log('统计空题失败：' + e.message, 'warn'); }
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


/* ============================================================
 * 75-course.js
 * ============================================================ */
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

  /**
   * 点顶部步骤页签（「2视频」/「视频」）把当前步骤切到视频。
   * cards 页面进入小节后常先停在「学习目标」步骤，播放器不渲染——
   * 不切步骤就永远等不到 video 元素（chaolucky 项目验证过的路径）。
   * @returns {Element|null} 点完页签后出现的播放器
   */
  async probeVideoByTab(doc) {
    const walk = async (w, depth) => {
      if (depth > 4) return null;
      let d = null;
      try { d = w.document; } catch (e) { return null; }
      if (!d) return null;
      for (const t of ['2视频', '视频']) {
        let el = null;
        try {
          el = Array.from(d.querySelectorAll('a, div, span, li')).find((e2) => {
            if (!e2.getClientRects || e2.getClientRects().length === 0) return false;
            const tx = (e2.textContent || '').replace(/\s+/g, '');
            return tx === t;
          });
        } catch (e2) { el = null; }
        if (el) {
          try { el.click(); } catch (e2) { continue; }
          await sleep(2000);
          const v = this.findVideo();
          if (v) return v;
        }
      }
      let frames = [];
      try { frames = Array.from(d.querySelectorAll('iframe')); } catch (e2) { return null; }
      for (const f of frames) {
        let w2 = null;
        try { w2 = f.contentWindow; } catch (e2) { continue; }
        if (!w2) continue;
        const r = await walk(w2, depth + 1);
        if (r) return r;
      }
      return null;
    };
    return walk((doc && doc.defaultView) || window, 0);
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

    // 1) 目录树优先：找当前高亮节点，点它后面第一个可点的。
    //    ⚠️ 不能先点底部的「下一节」按钮——在 cards 页面里那是**步骤推进**
    //    （学习目标→视频→测验），不是切节。步骤走完它还停在同一节里，
    //    mArg 不变、任务被重复处理（chaolucky 项目也因为这个只走目录树）。
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

    // 2) 章节测验步骤的「跳过本步骤」按钮（chaolucky 项目同款）
    let skipQuiz = null;
    try { skipQuiz = d.querySelector('#prevNextFocusNext'); } catch (e) { skipQuiz = null; }
    if (skipQuiz && isVisible(skipQuiz)) return { el: skipQuiz, kind: 'skip-quiz' };

    // 3) 底部「下一节」按钮兜底
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

    // 4) 文字是「下一节/下一章/下一个」的按钮
    const byText = findButtonByText(['下一节', '下一章', '下一个', '下一课'], d);
    if (byText) return { el: byText, kind: 'text' };

    // 5) 老版目录：h4/h5 上带 cur 前缀的 id
    const heads = Array.from(d.querySelectorAll('h4[id^="cur"], h5[id^="cur"]'));
    if (heads.length) {
      let curIdx = heads.findIndex((h) => /active|current/i.test(h.className));
      if (curIdx < 0) curIdx = 0;
      if (curIdx + 1 < heads.length) return { el: heads[curIdx + 1], kind: 'catalog-old' };
    }

    // 6) 老版 tabtags 里的下一个
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

      // 四层递进找播放器：
      // 1) 页面上已经渲染出来的 video（有的课程卡片直接内嵌）
      let v = this.findVideo();
      // 2) 点顶部步骤页签「2视频」——进节常先停在「学习目标」，不切步骤播放器不渲染
      if (!v) v = await this.probeVideoByTab(doc);
      // 3) 点任务点图标把卡片展开（图标 class 各版本不一，多试几个选择器）
      if (!v) v = await this.probeVideoByIcon(doc);
      // 4) 还没有就等用户手动点开（60 秒）
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

    // 作业页必须被加载（保存调的是页面自己的 noSubmit()），但不需要被看见——
    // iframe 收起成一条小横条照样加载、照样填答案。点横条可展开查看答题过程。
    const NAME = 'llmq-work-frame';
    let f = null;
    let box = null;
    try { f = d.getElementById(NAME); } catch (e) { f = null; }
    if (!f) {
      try {
        box = d.createElement('div');
        box.id = NAME + '-box';
        box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
          'border:2px solid #4a90d9;border-radius:8px;background:#fff;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);overflow:hidden;';

        const bar = d.createElement('div');
        bar.id = 'llmq-work-bar';
        bar.style.cssText = 'padding:6px 12px;font:13px/1.4 sans-serif;color:#1a5c9e;' +
          'background:#eaf3fc;cursor:pointer;user-select:none;white-space:nowrap;';
        bar.textContent = '📋 作业答题中…（点此展开 / 收起）';
        bar.addEventListener('click', () => {
          const frame = d.getElementById(NAME);
          if (!frame) return;
          const hidden = frame.style.display === 'none';
          frame.style.display = hidden ? '' : 'none';
          if (!hidden) box.style.width = '';       // 展开时恢复容器自适应
          bar.textContent = hidden ? '📋 作业答题中…（点此收起）' : '📋 作业已收起，仍在后台答题（点此展开）';
        });

        f = d.createElement('iframe');
        f.id = NAME;
        f.style.cssText = 'width:460px;height:620px;border:none;display:none;background:#fff;';
        f.setAttribute('data-collapsed', '1');

        box.appendChild(bar);
        box.appendChild(f);
        (d.body || d.documentElement).appendChild(box);
      } catch (e) {
        log('创建作业窗口失败：' + e.message, 'error');
        return null;
      }
    }
    f.src = url;
    log('作业页已在后台加载（默认收起，点右下角横条可展开查看；做完自动关掉）', 'info');
    return f;
  },

  closeWorkFrame(doc) {
    try {
      const d = doc || document;
      const f = d.getElementById('llmq-work-frame');
      if (f) f.remove();
      const box = d.getElementById('llmq-work-frame-box');
      if (box) box.remove();
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


/* ============================================================
 * 80-ui.js
 * ============================================================ */
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
    <div style="margin-top:8px">
      <label class="chk"><input type="checkbox" id="f-guess" checked> 没答案的题按默认猜（单选 B / 多选全选 / 判断错）</label>
    </div>
    <div style="margin-top:8px">
      <label>视觉模型（认乱码字形用，留空关闭）</label>
      <input type="text" id="f-vision" placeholder="例：glm-4.6v-flash">
    </div>
    <div style="margin-top:8px">
      <label class="chk">
    </div>
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
      cfg.quiz.minAnswerRate = clampNum(q('#f-rate').value, 0, 100, 90);
      cfg.quiz.guessOnMiss = q('#f-guess').checked;
      cfg.quiz.visionModel = (q('#f-vision').value || '').trim();
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
    q('#f-guess').checked = quiz.guessOnMiss !== false;
    q('#f-vision').value = quiz.visionModel || '';
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


/* ============================================================
 * 90-main.js
 * ============================================================ */
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
    // 3) 只有填空题的卷子。⚠️ 判定必须收紧：input 要在题目容器（.TiMu/.Py-mian1）里。
    // 课程学习页的顶层文本里常有"填空"二字，搜索框又恰好是 text input——
    // 之前按"页面有'填空' + 有 text input"判，直接把课程页误判成答题页，
    // 面板于是显示「开始答题」而不是「自动刷课」。
    if (!found) {
      for (const d of docs) {
        try {
          const boxes = d.querySelectorAll('.TiMu, .Py-mian1');
          for (const box of boxes) {
            if (box.querySelector('input[type=text]')) { found = d; break; }
          }
          if (found) break;
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
    let falseQuizRounds = 0;
    const tick = () => {
      tries++;
      const doc = this.resolveQuizDoc(true);

      if (this.quizKind === 'quiz') {
        // 结构像答题页 ≠ 真有题。课程页文本含"填空"+ 搜索框这类误判，
        // 解析出来 0 题时不能锁死在这里，否则面板永远显示「开始答题」、
        // 「自动刷课」出不来。继续探测，多轮无题就回退成非答题页。
        const r = (() => {
          try { return Parser.parse(doc); } catch (e) { return { questions: [] }; }
        })();
        if (r.questions.length > 0) {
          UI.setPageKind('quiz');
          const where = doc === document ? '当前页面' : '页面内的 iframe';
          log('在' + where + '里找到题目内容', 'success');
          this.reportQuestions(r);
          return;
        }
        falseQuizRounds++;
        log('第 ' + tries + ' 次探测：结构像答题页但没解析到题（可能是误判），继续…', 'info');
        if (tries < 6) { setTimeout(tick, 2000); return; }
        // 多轮都无题：按非答题页处理
        this.quizKind = 'other';
        UI.setPageKind('other');
        UI.setStatus('idle', '非答题页');
        log('多次探测都没解析到题目，已按课程页处理，可以直接用「自动刷课」', 'warn');
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

  reportQuestions(r) {
    try {
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

})();
