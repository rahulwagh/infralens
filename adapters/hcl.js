/*
 * InfraLens — HCL2 reader and Terraform expression evaluator. No dependencies.
 *
 * Reads .tf / .tfvars / .tf.json / .tfvars.json text and evaluates it far enough to
 * recover the concrete values Terraform would pass to resources and modules:
 * variables (with tfvars and defaults), locals, for_each / count expansion, dynamic
 * blocks, string templates, conditionals, for-expressions, splats, local modules
 * and their outputs, and the common built-in functions — including
 * jsondecode(file(...)) and fileset(...), which no-code repos lean on.
 *
 * Anything it cannot know (data sources, remote module outputs, computed
 * attributes, unsupported functions) becomes an `Unknown` value that renders as
 * `${expr}` instead of blowing up. The goal is a faithful read of declared
 * configuration, not a Terraform replacement.
 *
 * Exposed as window.InfraLensHCL (browser) and module.exports (Node):
 *   parse(text, filename)                 -> { body, error }
 *   evaluateRepo(files)                   -> { roots: [...], diagnostics: [...] }
 *   Unknown, isUnknown, plain(value)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InfraLensHCL = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global.window : null), function () {
  'use strict';

  /* ======================================================================
     Unknown values
     ====================================================================== */
  class Unknown {
    constructor(why) { this.why = why; }
    toString() { return '${' + this.why + '}'; }
    toJSON() { return '${' + this.why + '}'; }
  }
  const U = (why) => new Unknown(why);
  const isUnk = (v) => v instanceof Unknown;

  // Resource / module instance: attribute access on missing keys yields Unknown
  // instead of throwing, because computed attributes legitimately do not exist in
  // configuration.
  class Instance {
    constructor(address, attrs, computed) { this.address = address; this.attrs = attrs; this.computed = computed || {}; }
    get(key) {
      if (key in this.attrs) return this.attrs[key];
      if (key in this.computed) return this.computed[key];
      return U(this.address + '.' + key);
    }
    toJSON() { return Object.assign({ __address: this.address }, this.attrs); }
  }

  // Convert evaluated values into plain JSON-ish data (Unknown -> "${...}").
  function plain(v, depth = 0) {
    if (depth > 60) return U('too deep').toString();
    if (v == null) return v;
    if (isUnk(v)) return v.toString();
    if (v instanceof Instance) return plain(Object.assign({}, v.attrs), depth + 1);
    if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k], depth + 1); return o; }
    return v;
  }

  /* ======================================================================
     Lexer
     ====================================================================== */
  const PUNCT = ['...', '==', '!=', '<=', '>=', '&&', '||', '=>', '[*]', '{', '}', '[', ']', '(', ')', '=', '+', '-', '*', '/', '%', '!', '<', '>', '?', ':', '.', ','];
  const RE_NUM = /\d+(\.\d+)?([eE][+-]?\d+)?/y;
  const RE_ID = /[A-Za-z_][A-Za-z0-9_-]*/y;

  class Lexer {
    constructor(text) { this.s = text; this.i = 0; this.line = 1; this.toks = []; }
    err(msg) { throw new Error(msg + ' at line ' + this.line); }
    push(t, v, line) { this.toks.push({ t, v, line: line || this.line }); }
    run() {
      const s = this.s, n = s.length;
      while (this.i < n) {
        const c = s[this.i];
        if (c === '\n') { this.push('nl', '\n'); this.i++; this.line++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { this.i++; continue; }
        if (c === '#' || (c === '/' && s[this.i + 1] === '/')) { while (this.i < n && s[this.i] !== '\n') this.i++; continue; }
        if (c === '/' && s[this.i + 1] === '*') {
          const e = s.indexOf('*/', this.i + 2); const end = e < 0 ? n : e + 2;
          this.line += (s.slice(this.i, end).match(/\n/g) || []).length; this.i = end; continue;
        }
        if (c === '"') { this.readString(); continue; }
        if (c === '<' && s[this.i + 1] === '<') { this.readHeredoc(); continue; }
        if (c >= '0' && c <= '9') { RE_NUM.lastIndex = this.i; const m = RE_NUM.exec(s); this.push('num', Number(m[0])); this.i += m[0].length; continue; }
        if (/[A-Za-z_]/.test(c)) { RE_ID.lastIndex = this.i; const m = RE_ID.exec(s); this.push('id', m[0]); this.i += m[0].length; continue; }
        let hit = null; for (const p of PUNCT) if (s.startsWith(p, this.i)) { hit = p; break; }
        if (!hit) this.err('unexpected character ' + JSON.stringify(c));
        this.push('p', hit); this.i += hit.length;
      }
      this.push('eof', null);
      return this.toks;
    }
    // Scans a ${ ... } interpolation starting after "${"; returns inner text and
    // advances past the closing brace. Handles nested braces and quoted strings.
    scanInterp() {
      const s = this.s; let depth = 1; let j = this.i; let inStr = false;
      while (j < s.length) {
        const ch = s[j];
        if (inStr) { if (ch === '\\') { j += 2; continue; } if (ch === '"') inStr = false; j++; continue; }
        if (ch === '"') { inStr = true; j++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { const inner = s.slice(this.i, j); this.line += (inner.match(/\n/g) || []).length; this.i = j + 1; return inner; } }
        else if (ch === '\n') { /* counted via inner */ }
        j++;
      }
      this.err('unterminated interpolation');
    }
    readString() {
      const s = this.s; const startLine = this.line; this.i++; // skip opening quote
      const parts = []; let buf = ''; let directive = false;
      while (this.i < s.length) {
        const c = s[this.i];
        if (c === '"') { this.i++; if (buf) parts.push(buf); this.push('str', { parts, directive }, startLine); return; }
        if (c === '\\') {
          const d = s[this.i + 1]; this.i += 2;
          buf += d === 'n' ? '\n' : d === 't' ? '\t' : d === 'r' ? '\r' : d === '"' ? '"' : d === '\\' ? '\\' : d === 'u' || d === 'U' ? '' : d;
          continue;
        }
        if (c === '$' && s[this.i + 1] === '$' && s[this.i + 2] === '{') { buf += '${'; this.i += 3; continue; }
        if (c === '%' && s[this.i + 1] === '%' && s[this.i + 2] === '{') { buf += '%{'; this.i += 3; continue; }
        if (c === '$' && s[this.i + 1] === '{') { if (buf) { parts.push(buf); buf = ''; } this.i += 2; const line = this.line; parts.push({ expr: this.scanInterp(), line }); continue; }
        if (c === '%' && s[this.i + 1] === '{') { directive = true; this.i += 2; buf += '%{' + this.scanInterp() + '}'; continue; }
        if (c === '\n') this.line++;
        buf += c; this.i++;
      }
      this.err('unterminated string');
    }
    readHeredoc() {
      const s = this.s; const startLine = this.line;
      const m = /<<(-?)([A-Za-z_][A-Za-z0-9_-]*)\r?\n/y; m.lastIndex = this.i; const h = m.exec(s);
      if (!h) this.err('bad heredoc');
      const indent = h[1] === '-'; const tag = h[2]; this.i += h[0].length; this.line++;
      const lines = [];
      for (;;) {
        if (this.i >= s.length) this.err('unterminated heredoc ' + tag);
        let e = s.indexOf('\n', this.i); if (e < 0) e = s.length;
        const line = s.slice(this.i, e).replace(/\r$/, '');
        this.i = e + 1; this.line++;
        if (line.trim() === tag) break;
        lines.push(line);
      }
      if (indent) {
        const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length), 1e9);
        if (ind !== 1e9) for (let k = 0; k < lines.length; k++) lines[k] = lines[k].slice(ind);
      }
      const text = lines.join('\n') + (lines.length ? '\n' : '');
      // template-scan the heredoc body
      const parts = []; let buf = ''; let directive = false; let j = 0;
      while (j < text.length) {
        if (text.startsWith('$${', j)) { buf += '${'; j += 3; continue; }
        if (text.startsWith('%%{', j)) { buf += '%{'; j += 3; continue; }
        if (text.startsWith('${', j)) {
          if (buf) { parts.push(buf); buf = ''; }
          const sub = new Lexer(text); sub.i = j + 2; const inner = sub.scanInterp(); j = sub.i; parts.push({ expr: inner, line: startLine }); continue;
        }
        if (text.startsWith('%{', j)) { directive = true; }
        buf += text[j]; j++;
      }
      if (buf) parts.push(buf);
      this.push('str', { parts, directive }, startLine);
      // the lexer consumed the trailing newline of the terminator line; emit nl
      this.push('nl', '\n');
    }
  }

  /* ======================================================================
     Parser  — produces { attrs: {name: {expr, line}}, blocks: [{type, labels, body, line}] }
     ====================================================================== */
  class Parser {
    constructor(toks) { this.toks = toks; this.p = 0; this.depth = 0; }
    err(msg, t) { throw new Error(msg + ' at line ' + ((t || this.toks[this.p]).line)); }
    peekIdx() { let j = this.p; if (this.depth > 0) while (this.toks[j].t === 'nl') j++; return j; }
    peek() { return this.toks[this.peekIdx()]; }
    next() { const j = this.peekIdx(); this.p = j + 1; return this.toks[j]; }
    is(t, v) { const k = this.peek(); return k.t === t && (v === undefined || k.v === v); }
    accept(t, v) { if (this.is(t, v)) return this.next(); return null; }
    expect(t, v) { const k = this.next(); if (k.t !== t || (v !== undefined && k.v !== v)) this.err('expected ' + (v || t) + ' but found ' + (k.v === null ? 'end of file' : JSON.stringify(k.v)), k); return k; }
    skipNL() { while (this.toks[this.p].t === 'nl') this.p++; }

    body() {
      const out = { attrs: {}, blocks: [] };
      for (;;) {
        this.skipNL();
        const t = this.toks[this.p];
        if (t.t === 'eof' || (t.t === 'p' && t.v === '}')) return out;
        if (t.t !== 'id') this.err('expected attribute or block name, found ' + JSON.stringify(t.v), t);
        this.p++;
        const nt = this.toks[this.p];
        if (nt.t === 'p' && nt.v === '=') {
          this.p++;
          const expr = this.expr();
          out.attrs[t.v] = { expr, line: t.line };
          const e = this.toks[this.p];
          if (!(e.t === 'nl' || e.t === 'eof' || (e.t === 'p' && e.v === '}'))) this.err('unexpected ' + JSON.stringify(e.v) + ' after attribute ' + t.v, e);
          continue;
        }
        // block
        const labels = [];
        for (;;) {
          const l = this.toks[this.p];
          if (l.t === 'str') { this.p++; labels.push(l.v.parts.map((x) => (typeof x === 'string' ? x : '${' + x.expr + '}')).join('')); }
          else if (l.t === 'id') { this.p++; labels.push(l.v); }
          else break;
        }
        this.expect('p', '{');
        const saveDepth = this.depth; this.depth = 0;
        const b = this.body();
        this.depth = saveDepth;
        this.expect('p', '}');
        out.blocks.push({ type: t.v, labels, body: b, line: t.line });
      }
    }

    // ---- expressions ----
    expr() {
      const c = this.binary(0);
      if (this.is('p', '?')) {
        this.next(); this.depth++; const a = this.expr(); this.expect('p', ':'); const b = this.expr(); this.depth--;
        return { t: 'cond', c, a, b };
      }
      return c;
    }
    binary(level) {
      const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
      if (level >= LEVELS.length) return this.unary();
      let l = this.binary(level + 1);
      for (;;) {
        const t = this.peek();
        if (t.t === 'p' && LEVELS[level].includes(t.v)) { this.next(); const r = this.binary(level + 1); l = { t: 'bin', op: t.v, l, r }; }
        else return l;
      }
    }
    unary() {
      if (this.is('p', '-')) { this.next(); return { t: 'neg', x: this.unary() }; }
      if (this.is('p', '!')) { this.next(); return { t: 'not', x: this.unary() }; }
      return this.postfix(this.primary());
    }
    postfix(x) {
      for (;;) {
        const t = this.toks[this.p]; // no newline skipping before postfix at depth 0
        if (t.t === 'p' && t.v === '.') {
          this.p++;
          const k = this.toks[this.p];
          if (k.t === 'id') { this.p++; x = { t: 'get', x, k: k.v }; }
          else if (k.t === 'num') { this.p++; x = { t: 'idx', x, i: { t: 'lit', v: k.v } }; }
          else if (k.t === 'p' && k.v === '*') { this.p++; x = this.splatRest(x); }
          else this.err('bad attribute access', k);
        } else if (t.t === 'p' && t.v === '[*]') { this.p++; x = this.splatRest(x); }
        else if (t.t === 'p' && t.v === '[') { this.p++; this.depth++; const i = this.expr(); this.expect('p', ']'); this.depth--; x = { t: 'idx', x, i }; }
        else return x;
      }
    }
    // After [*] / .* the remaining .attr / [idx] steps apply to every element.
    splatRest(x) {
      const rest = [];
      for (;;) {
        const t = this.toks[this.p];
        if (t.t === 'p' && t.v === '.' && this.toks[this.p + 1].t === 'id') { rest.push({ t: 'get', k: this.toks[this.p + 1].v }); this.p += 2; }
        else if (t.t === 'p' && t.v === '.' && this.toks[this.p + 1].t === 'num') { rest.push({ t: 'idx', i: { t: 'lit', v: this.toks[this.p + 1].v } }); this.p += 2; }
        else if (t.t === 'p' && t.v === '[') { this.p++; this.depth++; const i = this.expr(); this.expect('p', ']'); this.depth--; rest.push({ t: 'idx', i }); }
        else break;
      }
      return { t: 'splat', x, rest };
    }
    primary() {
      const t = this.next();
      if (t.t === 'num') return { t: 'lit', v: t.v };
      if (t.t === 'str') return this.template(t);
      if (t.t === 'id') {
        if (t.v === 'true') return { t: 'lit', v: true };
        if (t.v === 'false') return { t: 'lit', v: false };
        if (t.v === 'null') return { t: 'lit', v: null };
        const n = this.toks[this.p];
        if (n.t === 'p' && n.v === '(') return this.call(t.v);
        if (n.t === 'p' && n.v === '::') { /* not reached: '::' not a token */ }
        // namespaced function  provider::name(...) / core::name(...)
        if (n.t === 'p' && n.v === ':' && this.toks[this.p + 1].t === 'p' && this.toks[this.p + 1].v === ':' && this.toks[this.p + 2].t === 'id') {
          this.p += 2; const fn = this.toks[this.p]; this.p++; return this.call(t.v + '::' + fn.v);
        }
        return { t: 'ref', n: t.v, line: t.line };
      }
      if (t.t === 'p') {
        if (t.v === '(') { this.depth++; const e = this.expr(); this.expect('p', ')'); this.depth--; return { t: 'paren', x: e }; }
        if (t.v === '[') return this.tuple();
        if (t.v === '{') return this.object();
      }
      this.err('unexpected ' + (t.v === null ? 'end of file' : JSON.stringify(t.v)), t);
    }
    call(name) {
      this.expect('p', '('); this.depth++;
      const args = []; let expand = false;
      while (!this.is('p', ')')) {
        args.push(this.expr());
        if (this.accept('p', '...')) expand = true;
        if (!this.accept('p', ',')) break;
      }
      this.expect('p', ')'); this.depth--;
      return { t: 'call', n: name, args, expand };
    }
    tuple() {
      this.depth++;
      if (this.is('id', 'for')) { const f = this.forExpr(false); this.expect('p', ']'); this.depth--; return f; }
      const items = [];
      while (!this.is('p', ']')) { items.push(this.expr()); if (!this.accept('p', ',')) break; }
      this.expect('p', ']'); this.depth--;
      return { t: 'tuple', items };
    }
    object() {
      this.depth++;
      if (this.is('id', 'for')) { const f = this.forExpr(true); this.expect('p', '}'); this.depth--; return f; }
      const items = [];
      while (!this.is('p', '}')) {
        let key;
        const j = this.peekIdx(); const t = this.toks[j];
        if (t.t === 'id' && (this.toks[j + 1].t === 'p' && (this.toks[j + 1].v === '=' || this.toks[j + 1].v === ':'))) { this.next(); key = { t: 'lit', v: t.v }; }
        else key = this.expr();
        if (!this.accept('p', '=')) this.expect('p', ':');
        const val = this.expr();
        items.push([key, val]);
        if (!this.accept('p', ',')) { /* newline separation is fine: depth>0 skips nl */ }
      }
      this.expect('p', '}'); this.depth--;
      return { t: 'object', items };
    }
    forExpr(isObj) {
      this.expect('id', 'for');
      const a = this.expect('id').v; let b = null;
      if (this.accept('p', ',')) b = this.expect('id').v;
      this.expect('id', 'in');
      const coll = this.expr();
      this.expect('p', ':');
      const v1 = this.expr();
      let v2 = null, group = false, cond = null;
      if (isObj) { this.expect('p', '=>'); v2 = this.expr(); if (this.accept('p', '...')) group = true; }
      if (this.accept('id', 'if')) cond = this.expr();
      return { t: 'for', k: b ? a : null, v: b ? b : a, coll, key: isObj ? v1 : null, val: isObj ? v2 : v1, cond, isObj, group };
    }
    template(tok) {
      const { parts, directive } = tok.v;
      if (directive) return { t: 'tpl', parts: [], directive: true, raw: parts.map((x) => (typeof x === 'string' ? x : '${' + x.expr + '}')).join('') };
      if (parts.length === 0) return { t: 'lit', v: '' };
      if (parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0] };
      const out = parts.map((x) => (typeof x === 'string' ? x : parseExpr(x.expr, x.line)));
      return { t: 'tpl', parts: out };
    }
  }

  function parseExpr(text, line) {
    const toks = new Lexer(text).run();
    for (const t of toks) t.line = (t.line - 1) + (line || 1);
    const p = new Parser(toks); p.depth = 1;
    const e = p.expr();
    if (p.peek().t !== 'eof') p.err('unexpected ' + JSON.stringify(p.peek().v) + ' in interpolation');
    return e;
  }

  function parse(text, filename) {
    try {
      const toks = new Lexer(text).run();
      const body = new Parser(toks).body();
      return { body };
    } catch (e) {
      return { body: { attrs: {}, blocks: [] }, error: (filename ? filename + ': ' : '') + e.message };
    }
  }

  // Terraform JSON syntax (.tf.json / .tfvars.json) -> same body shape. Strings are
  // parsed as templates so "${var.x}" still resolves.
  function jsonToExpr(v) {
    if (typeof v === 'string') { if (v.includes('${') || v.includes('%{')) { try { return new Parser(new Lexer(JSON.stringify(v)).run()).template(new Lexer(JSON.stringify(v)).run()[0]); } catch (e) { return { t: 'lit', v }; } } return { t: 'lit', v }; }
    if (v === null || typeof v !== 'object') return { t: 'lit', v };
    if (Array.isArray(v)) return { t: 'tuple', items: v.map(jsonToExpr) };
    return { t: 'object', items: Object.keys(v).map((k) => [{ t: 'lit', v: k }, jsonToExpr(v[k])]) };
  }
  const BLOCK_TYPES = { resource: 2, data: 2, module: 1, variable: 1, output: 1, locals: 0, provider: 1, terraform: 0, moved: 0, import: 0, check: 1, removed: 0 };
  function jsonToBody(obj, nested) {
    const body = { attrs: {}, blocks: [] };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body;
    for (const [k, v] of Object.entries(obj)) {
      const nLabels = nested ? undefined : BLOCK_TYPES[k];
      if (nLabels === undefined) {
        // inside a resource body: object/array values that are "block-like" become nested blocks
        if (nested && v && typeof v === 'object' && !Array.isArray(v) && !['labels', 'attribute_mapping', 'tags', 'metadata', 'default', 'validation'].includes(k) && Object.values(v).every((x) => x && typeof x === 'object' && !Array.isArray(x)) && Object.keys(v).length && nested === 'resource' && false) { /* keep as attribute */ }
        body.attrs[k] = { expr: jsonToExpr(v), line: 0 };
        continue;
      }
      const walk = (val, labels) => {
        if (labels.length < nLabels) { for (const [lk, lv] of Object.entries(val || {})) walk(lv, labels.concat(lk)); return; }
        const list = Array.isArray(val) ? val : [val];
        for (const item of list) body.blocks.push({ type: k, labels, body: jsonToBody(item, k), line: 0 });
      };
      walk(v, []);
    }
    return body;
  }

  /* ======================================================================
     Evaluator
     ====================================================================== */
  class EvalError extends Error {}
  const fail = (m) => { throw new EvalError(m); };
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v) && !isUnk(v) && !(v instanceof Instance);
  const toStr = (v) => (isUnk(v) ? v : v == null ? null : typeof v === 'object' ? fail('cannot convert object to string') : String(v));
  const toNum = (v) => (isUnk(v) ? v : typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : fail('cannot convert ' + JSON.stringify(v) + ' to number'));
  const toBool = (v) => (isUnk(v) ? v : typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fail('cannot convert ' + JSON.stringify(v) + ' to bool'));
  const truthy = (v) => (isUnk(v) ? v : toBool(v));
  const anyUnk = (arr) => arr.some(isUnk);
  const listOf = (v) => (Array.isArray(v) ? v : isMap(v) ? Object.values(v) : isUnk(v) ? v : v == null ? [] : fail('expected a list'));
  const eq = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

  // ---- built-in functions ----
  const normPath = (p) => {
    const out = [];
    for (const seg of String(p).split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') { out.pop(); continue; } out.push(seg); }
    return out.join('/');
  };
  const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?') + '$');
  function cidrsubnet(prefix, newbits, netnum) {
    const [ip, lenS] = String(prefix).split('/'); const len = Number(lenS);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return U('cidrsubnet(' + prefix + ')');
    const base = ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);
    const nl = len + newbits; const net = (base & (~0 << (32 - len))) >>> 0; const sub = (net + (netnum << (32 - nl))) >>> 0;
    return [24, 16, 8, 0].map((s) => (sub >>> s) & 255).join('.') + '/' + nl;
  }
  function formatImpl(f, args) {
    let i = 0;
    return String(f).replace(/%(%|[-+ 0#]*\d*(?:\.\d+)?[vsdfqtx])/g, (m, spec) => {
      if (spec === '%') return '%';
      const a = args[i++]; const verb = spec[spec.length - 1]; const w = (spec.match(/(\d+)(?:\.|$|[a-z])/) || [])[1]; const left = spec.includes('-');
      let s = verb === 'q' ? JSON.stringify(String(a)) : verb === 'd' ? String(Math.trunc(Number(a))) : verb === 'x' ? Number(a).toString(16) : verb === 'f' ? Number(a).toFixed((spec.match(/\.(\d+)/) || [, 6])[1]) : typeof a === 'object' && a !== null ? JSON.stringify(plain(a)) : String(a);
      if (w && s.length < Number(w)) s = left ? s.padEnd(Number(w)) : s.padStart(Number(w));
      return s;
    });
  }
  const FUNCS = {
    // collections
    length: (a) => (typeof a === 'string' ? a.length : Array.isArray(a) ? a.length : isMap(a) ? Object.keys(a).length : fail('length: bad arg')),
    keys: (m) => (isMap(m) ? Object.keys(m).sort() : fail('keys: not a map')),
    values: (m) => (isMap(m) ? Object.keys(m).sort().map((k) => m[k]) : fail('values: not a map')),
    lookup: (m, k, d) => (isMap(m) ? (k in m ? m[k] : d === undefined ? fail('lookup: key ' + k + ' not found') : d) : m instanceof Instance ? m.get(k) : fail('lookup: not a map')),
    merge: (...ms) => Object.assign({}, ...ms.filter((m) => m != null).map((m) => (isMap(m) ? m : fail('merge: not a map')))),
    concat: (...ls) => [].concat(...ls.map((l) => (Array.isArray(l) ? l : fail('concat: not a list')))),
    flatten: (l) => { const out = []; const rec = (x) => { for (const i of listOf(x)) { if (Array.isArray(i)) rec(i); else out.push(i); } }; rec(l); return out; },
    distinct: (l) => { const seen = new Set(); return listOf(l).filter((x) => { const k = JSON.stringify(plain(x)); if (seen.has(k)) return false; seen.add(k); return true; }); },
    compact: (l) => listOf(l).filter((x) => x !== '' && x != null),
    sort: (l) => listOf(l).map(String).sort(),
    reverse: (l) => listOf(l).slice().reverse(),
    range: (a, b, s) => { const out = []; let start = b === undefined ? 0 : a, end = b === undefined ? a : b, step = s === undefined ? (end >= start ? 1 : -1) : s; for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i); return out; },
    zipmap: (k, v) => { const o = {}; listOf(k).forEach((x, i) => { o[x] = listOf(v)[i]; }); return o; },
    element: (l, i) => { const a = listOf(l); if (!a.length) fail('element: empty list'); return a[((i % a.length) + a.length) % a.length]; },
    index: (l, v) => { const i = listOf(l).findIndex((x) => eq(x, v)); if (i < 0) fail('index: not found'); return i; },
    contains: (l, v) => listOf(l).some((x) => eq(x, v)),
    slice: (l, a, b) => listOf(l).slice(a, b),
    chunklist: (l, n) => { const a = listOf(l), out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; },
    one: (l) => { const a = listOf(l); if (a.length > 1) fail('one: more than one element'); return a.length ? a[0] : null; },
    setunion: (...s) => FUNCS.distinct([].concat(...s.map(listOf))),
    setintersection: (a, ...s) => listOf(a).filter((x) => s.every((t) => listOf(t).some((y) => eq(x, y)))),
    setsubtract: (a, b) => listOf(a).filter((x) => !listOf(b).some((y) => eq(x, y))),
    alltrue: (l) => listOf(l).every((x) => x === true),
    anytrue: (l) => listOf(l).some((x) => x === true),
    transpose: (m) => { const o = {}; for (const [k, vs] of Object.entries(m)) for (const v of listOf(vs)) (o[v] = o[v] || []).push(k); return o; },
    tolist: (l) => listOf(l), toset: (l) => FUNCS.distinct(l), tomap: (m) => (isMap(m) ? m : fail('tomap')),
    tostring: (v) => (v == null ? null : typeof v === 'object' ? fail('tostring: object') : String(v)),
    tonumber: toNum, tobool: toBool,
    // strings
    upper: (s) => String(s).toUpperCase(), lower: (s) => String(s).toLowerCase(),
    title: (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase()),
    trimspace: (s) => String(s).trim(), chomp: (s) => String(s).replace(/\r?\n$/, ''),
    trim: (s, c) => { const re = new RegExp('^[' + c.replace(/[\]\\^-]/g, '\\$&') + ']+|[' + c.replace(/[\]\\^-]/g, '\\$&') + ']+$', 'g'); return String(s).replace(re, ''); },
    trimprefix: (s, p) => (String(s).startsWith(p) ? String(s).slice(p.length) : String(s)),
    trimsuffix: (s, p) => (String(s).endsWith(p) ? String(s).slice(0, -p.length) : String(s)),
    startswith: (s, p) => String(s).startsWith(p), endswith: (s, p) => String(s).endsWith(p), strcontains: (s, p) => String(s).includes(p),
    replace: (s, a, b) => (/^\/.*\/$/.test(a) ? String(s).replace(new RegExp(a.slice(1, -1), 'g'), b) : String(s).split(a).join(b)),
    split: (sep, s) => (String(s) === '' ? [] : String(s).split(sep)),
    join: (sep, ...ls) => [].concat(...ls.map(listOf)).map(String).join(sep),
    substr: (s, o, l) => String(s).substr(o, l < 0 ? undefined : l),
    format: (f, ...a) => formatImpl(f, a),
    formatlist: (f, ...a) => { const n = Math.max(...a.map((x) => (Array.isArray(x) ? x.length : 1))); const out = []; for (let i = 0; i < n; i++) out.push(formatImpl(f, a.map((x) => (Array.isArray(x) ? x[i] : x)))); return out; },
    indent: (n, s) => String(s).split('\n').map((l, i) => (i ? ' '.repeat(n) + l : l)).join('\n'),
    regex: (re, s) => { const m = new RegExp(re).exec(String(s)); if (!m) fail('regex: no match'); return m.length > 1 ? m.slice(1) : m[0]; },
    regexall: (re, s) => Array.from(String(s).matchAll(new RegExp(re, 'g'))).map((m) => (m.length > 1 ? m.slice(1) : m[0])),
    base64encode: (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(String(s)))) : Buffer.from(String(s)).toString('base64')),
    base64decode: (s) => (typeof atob === 'function' ? decodeURIComponent(escape(atob(String(s)))) : Buffer.from(String(s), 'base64').toString()),
    // numbers
    max: (...n) => Math.max(...n.map(toNum)), min: (...n) => Math.min(...n.map(toNum)), abs: (n) => Math.abs(toNum(n)),
    ceil: (n) => Math.ceil(toNum(n)), floor: (n) => Math.floor(toNum(n)), pow: (a, b) => Math.pow(toNum(a), toNum(b)),
    signum: (n) => Math.sign(toNum(n)), parseint: (s, b) => parseInt(String(s), b || 10),
    // encoding
    jsonencode: (v) => JSON.stringify(plain(v)),
    jsondecode: (s) => { try { return JSON.parse(String(s)); } catch (e) { fail('jsondecode: ' + e.message); } },
    yamlencode: (v) => JSON.stringify(plain(v), null, 2),
    yamldecode: (s) => yamlDecode(String(s)),
    // network
    cidrsubnet: (p, n, i) => cidrsubnet(p, toNum(n), toNum(i)),
    cidrhost: (p, n) => { const [ip, len] = String(p).split('/'); if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return U('cidrhost'); const base = ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0); const net = (base & (~0 << (32 - Number(len)))) >>> 0; const h = (net + toNum(n)) >>> 0; return [24, 16, 8, 0].map((s) => (h >>> s) & 255).join('.'); },
    cidrnetmask: (p) => { const len = Number(String(p).split('/')[1]); const m = len === 0 ? 0 : (~0 << (32 - len)) >>> 0; return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join('.'); },
    // paths
    basename: (p) => String(p).split('/').pop(), dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '.',
    abspath: (p) => String(p), pathexpand: (p) => String(p),
    nonsensitive: (v) => v, sensitive: (v) => v, issensitive: () => false,
  };
  // functions that take Unknown args and still produce something useful
  const LENIENT = new Set(['coalesce', 'coalescelist', 'try', 'can', 'jsonencode', 'tostring', 'format', 'join', 'concat', 'merge', 'flatten', 'compact', 'length', 'lookup', 'element', 'tolist', 'toset', 'tomap', 'nonsensitive', 'sensitive', 'distinct', 'keys', 'values', 'contains', 'setunion', 'issensitive', 'one']);

  // Tiny YAML reader: block maps/lists, scalars, flow [] / {} via JSON, comments.
  // Enough for config files; anchors, multi-docs and block scalars are not supported.
  function yamlDecode(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, '  ')).filter((l) => l.trim() && !/^\s*#/.test(l) && l.trim() !== '---');
    let i = 0;
    const scalar = (s) => { s = s.trim(); if (s === '' || s === '~' || s === 'null') return null; if (s === 'true') return true; if (s === 'false') return false; if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s); if (/^["[{]/.test(s)) { try { return JSON.parse(s.replace(/'/g, '"')); } catch (e) { /* fallthrough */ } } if (/^'.*'$/.test(s)) return s.slice(1, -1); return s.replace(/\s+#.*$/, ''); };
    const indentOf = (l) => l.match(/^ */)[0].length;
    function block(ind) {
      if (i >= lines.length) return null;
      const l = lines[i]; const cur = indentOf(l);
      if (cur < ind) return null;
      if (/^\s*-\s|^\s*-$/.test(l)) {
        const out = [];
        while (i < lines.length && indentOf(lines[i]) === cur && /^\s*-(\s|$)/.test(lines[i])) {
          const rest = lines[i].replace(/^\s*-\s?/, '');
          if (rest.trim() === '') { i++; out.push(block(cur + 1)); }
          else if (/^[^"'\[{]*?:(\s|$)/.test(rest)) { lines[i] = ' '.repeat(cur + 2) + rest; out.push(block(cur + 2)); }
          else { i++; out.push(scalar(rest)); }
        }
        return out;
      }
      const out = {};
      while (i < lines.length && indentOf(lines[i]) === cur && !/^\s*-(\s|$)/.test(lines[i])) {
        const m = /^\s*("[^"]*"|'[^']*'|[^:]+?)\s*:(.*)$/.exec(lines[i]); if (!m) fail('yaml: cannot parse line ' + (i + 1));
        const key = m[1].replace(/^["']|["']$/g, ''); const rest = m[2]; i++;
        if (rest.trim() === '' || rest.trim() === '|' || rest.trim() === '>') { const nxt = i < lines.length ? indentOf(lines[i]) : -1; out[key] = nxt > cur ? block(nxt) : null; }
        else out[key] = scalar(rest);
      }
      return out;
    }
    return block(0);
  }

  // ---- expression evaluation ----
  class Scope {
    constructor(parent, vars) { this.parent = parent; this.vars = vars || {}; }
    has(n) { return n in this.vars || (this.parent ? this.parent.has(n) : false); }
    get(n) { return n in this.vars ? this.vars[n] : this.parent ? this.parent.get(n) : undefined; }
    child(vars) { return new Scope(this, vars); }
  }

  function evalExpr(e, env, scope) {
    switch (e.t) {
      case 'lit': return e.v;
      case 'paren': return evalExpr(e.x, env, scope);
      case 'tpl': {
        if (e.directive) return U('template directive');
        let s = ''; let unk = null;
        for (const p of e.parts) { if (typeof p === 'string') { s += p; continue; } const v = evalExpr(p, env, scope); if (isUnk(v)) { unk = unk || []; unk.push(v.why); s += v.toString(); continue; } if (v != null && typeof v === 'object') fail('cannot interpolate object'); s += v == null ? '' : String(v); }
        return unk ? U(s) : s;
      }
      case 'ref': return env.resolveRoot(e.n, scope);
      case 'get': { const o = evalExpr(e.x, env, scope); return getAttr(o, e.k); }
      case 'idx': { const o = evalExpr(e.x, env, scope); const i = evalExpr(e.i, env, scope); if (isUnk(o)) return U(o.why + '[' + (isUnk(i) ? i.why : JSON.stringify(i)) + ']'); if (isUnk(i)) return U('[' + i.why + ']'); if (Array.isArray(o)) { if (typeof i !== 'number' || i < 0 || i >= o.length) fail('index ' + i + ' out of range'); return o[i]; } return getAttr(o, String(i)); }
      case 'splat': {
        const o = evalExpr(e.x, env, scope); if (isUnk(o)) return o; if (o == null) return [];
        const list = Array.isArray(o) ? o : isMap(o) && !(o instanceof Instance) ? Object.values(o) : [o];
        return list.map((el) => { let v = el; for (const s of e.rest) { if (s.t === 'get') v = getAttr(v, s.k); else { const i = evalExpr(s.i, env, scope); v = isUnk(v) ? v : Array.isArray(v) ? v[i] : getAttr(v, String(i)); } } return v; });
      }
      case 'tuple': return e.items.map((x) => evalExpr(x, env, scope));
      case 'object': { const o = {}; for (const [k, v] of e.items) { const kk = evalExpr(k, env, scope); if (isUnk(kk)) return U('object with unknown key'); o[String(kk)] = evalExpr(v, env, scope); } return o; }
      case 'neg': { const v = evalExpr(e.x, env, scope); return isUnk(v) ? v : -toNum(v); }
      case 'not': { const v = evalExpr(e.x, env, scope); return isUnk(v) ? v : !toBool(v); }
      case 'cond': { const c = evalExpr(e.c, env, scope); if (isUnk(c)) return U('(' + c.why + ') ? … : …'); return toBool(c) ? evalExpr(e.a, env, scope) : evalExpr(e.b, env, scope); }
      case 'bin': {
        const l = evalExpr(e.l, env, scope);
        if (e.op === '&&' && l === false) return false;
        if (e.op === '||' && l === true) return true;
        const r = evalExpr(e.r, env, scope);
        if (isUnk(l) || isUnk(r)) return U((isUnk(l) ? l.why : JSON.stringify(plain(l))) + ' ' + e.op + ' ' + (isUnk(r) ? r.why : JSON.stringify(plain(r))));
        switch (e.op) {
          case '==': return eq(l, r); case '!=': return !eq(l, r);
          case '&&': return toBool(l) && toBool(r); case '||': return toBool(l) || toBool(r);
          case '<': return toNum(l) < toNum(r); case '>': return toNum(l) > toNum(r); case '<=': return toNum(l) <= toNum(r); case '>=': return toNum(l) >= toNum(r);
          case '+': return toNum(l) + toNum(r); case '-': return toNum(l) - toNum(r); case '*': return toNum(l) * toNum(r); case '/': return toNum(l) / toNum(r); case '%': return toNum(l) % toNum(r);
        }
        fail('bad operator ' + e.op);
      }
      case 'for': {
        const coll = evalExpr(e.coll, env, scope);
        if (isUnk(coll)) return U('for … in ' + coll.why);
        const entries = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : isMap(coll) ? Object.keys(coll).sort().map((k) => [k, coll[k]]) : coll == null ? [] : fail('for: not iterable');
        const outL = []; const outO = {};
        for (const [k, v] of entries) {
          const sc = scope.child(e.k ? { [e.k]: k, [e.v]: v } : { [e.v]: v });
          if (e.cond) { const c = evalExpr(e.cond, env, sc); if (isUnk(c)) continue; if (!toBool(c)) continue; }
          if (e.isObj) { const kk = evalExpr(e.key, env, sc); const vv = evalExpr(e.val, env, sc); if (isUnk(kk)) continue; if (e.group) (outO[kk] = outO[kk] || []).push(vv); else outO[kk] = vv; }
          else outL.push(evalExpr(e.val, env, sc));
        }
        return e.isObj ? outO : outL;
      }
      case 'call': return callFn(e, env, scope);
    }
    fail('unknown node ' + e.t);
  }
  function getAttr(o, k) {
    if (isUnk(o)) return U(o.why + '.' + k);
    if (o instanceof Instance) return o.get(k);
    if (isMap(o)) { if (k in o) return o[k]; fail('attribute ' + JSON.stringify(k) + ' not found'); }
    if (Array.isArray(o) && /^\d+$/.test(k)) return o[Number(k)];
    if (o == null) fail('attribute ' + k + ' of null');
    fail('cannot read attribute ' + k + ' of ' + typeof o);
  }
  function callFn(e, env, scope) {
    const name = e.n.replace(/^core::/, '');
    if (name === 'try') {
      let last = null;
      for (const a of e.args) { try { const v = evalExpr(a, env, scope); if (!isUnk(v)) return v; last = v; } catch (err) { if (!(err instanceof EvalError)) throw err; } }
      return last == null ? fail('try: all alternatives failed') : last;
    }
    if (name === 'can') { try { const v = evalExpr(e.args[0], env, scope); return isUnk(v) ? U('can(' + v.why + ')') : true; } catch (err) { if (err instanceof EvalError) return false; throw err; } }
    let args = e.args.map((a) => evalExpr(a, env, scope));
    if (e.expand && args.length) { const last = args.pop(); if (isUnk(last)) return U(name + '(…)'); args = args.concat(listOf(last)); }
    if (name === 'coalesce') { for (const a of args) if (!isUnk(a) && a != null && a !== '') return a; return args.find(isUnk) || fail('coalesce: no non-null value'); }
    if (name === 'coalescelist') { for (const a of args) if (!isUnk(a) && Array.isArray(a) && a.length) return a; return args.find(isUnk) || fail('coalescelist: no non-empty list'); }
    if (name === 'file') { if (isUnk(args[0])) return U('file(' + args[0].why + ')'); const p = normPath(args[0]); const t = env.readFile(p); if (t == null) fail('file: ' + p + ' not found in repo'); return t; }
    if (name === 'fileexists') { if (isUnk(args[0])) return U('fileexists'); return env.readFile(normPath(args[0])) != null; }
    if (name === 'fileset') { if (anyUnk(args)) return U('fileset(…)'); const base = normPath(args[0]); const re = globToRe(args[1]); const out = []; for (const p of env.listFiles()) { if (base && !p.startsWith(base + '/')) continue; const rel = base ? p.slice(base.length + 1) : p; if (re.test(rel)) out.push(rel); } return out.sort(); }
    if (name === 'templatefile') return U('templatefile(' + (isUnk(args[0]) ? args[0].why : args[0]) + ')');
    if (name === 'jsondecode' && isUnk(args[0])) return U('jsondecode(' + args[0].why + ')');
    if (name === 'yamldecode' && isUnk(args[0])) return U('yamldecode(' + args[0].why + ')');
    const fn = FUNCS[name];
    if (!fn) { env.unsupported(name); return U(name + '(…)'); }
    if (anyUnk(args) && !LENIENT.has(name)) return U(name + '(' + args.map((a) => (isUnk(a) ? a.why : typeof a === 'object' ? '…' : JSON.stringify(a))).join(', ') + ')');
    if (anyUnk(args)) {
      // lenient functions: best effort, propagate unknown if it matters
      if (['tostring', 'jsonencode', 'join', 'format'].includes(name)) return U(name + '(…)');
      if (name === 'lookup' && isUnk(args[0])) return U(args[0].why + '[' + args[1] + ']');
      if (name === 'lookup' && isUnk(args[1])) return U('lookup(…)');
      if (name === 'length' || name === 'keys' || name === 'values' || name === 'element' || name === 'contains' || name === 'one') return U(name + '(…)');
      if (['merge', 'concat', 'flatten', 'compact', 'distinct', 'setunion', 'tolist', 'toset', 'tomap'].includes(name)) { const clean = args.filter((a) => !isUnk(a)); if (name === 'merge' || name === 'concat') return U(name + '(…)'); return fn(...clean); }
    }
    return fn(...args);
  }

  /* ======================================================================
     Module evaluation
     ====================================================================== */
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const joinPath = (a, b) => normPath((a ? a + '/' : '') + b);

  // Synthesised attributes for well-known GCP resource types so cross-references
  // like google_compute_network.vpc.self_link resolve to something useful.
  function computedAttrs(type, a, address) {
    const s = (v) => (isUnk(v) ? v : v == null ? null : String(v));
    const u = (k) => U(address + '.' + k);
    const tpl = (parts) => { let out = ''; for (const p of parts) { if (isUnk(p)) return U(address + ' (' + p.why + ')'); if (p == null) return u('id'); out += p; } return out; };
    const proj = a.project;
    switch (type) {
      case 'google_project': return { id: s(a.project_id), project_id: s(a.project_id), number: u('number'), name: a.name == null ? s(a.project_id) : s(a.name) };
      case 'google_folder': return { id: tpl(['folders/', a.display_name]), name: tpl(['folders/', a.display_name]), folder_id: s(a.display_name), display_name: s(a.display_name) };
      case 'google_service_account': { const email = tpl([a.account_id, '@', proj, '.iam.gserviceaccount.com']); return { email, id: tpl(['projects/', proj, '/serviceAccounts/', email]), name: tpl(['projects/', proj, '/serviceAccounts/', email]), member: tpl(['serviceAccount:', email]), unique_id: u('unique_id') }; }
      case 'google_compute_network': { const id = tpl(['projects/', proj, '/global/networks/', a.name]); return { id, self_link: tpl(['https://www.googleapis.com/compute/v1/', id]), network_id: u('network_id') }; }
      case 'google_compute_subnetwork': { const id = tpl(['projects/', proj, '/regions/', a.region, '/subnetworks/', a.name]); return { id, self_link: tpl(['https://www.googleapis.com/compute/v1/', id]) }; }
      case 'google_iam_workload_identity_pool': { const n = tpl(['projects/', proj, '/locations/global/workloadIdentityPools/', a.workload_identity_pool_id]); return { id: n, name: n }; }
      case 'google_iam_workload_identity_pool_provider': { const n = tpl(['projects/', proj, '/locations/global/workloadIdentityPools/', a.workload_identity_pool_id, '/providers/', a.workload_identity_pool_provider_id]); return { id: n, name: n }; }
      case 'google_access_context_manager_access_policy': return { id: u('id'), name: u('name') };
      case 'google_compute_router': return { id: tpl(['projects/', proj, '/regions/', a.region, '/routers/', a.name]), self_link: u('self_link') };
      case 'google_storage_bucket': return { id: s(a.name), self_link: u('self_link'), url: tpl(['gs://', a.name]) };
      default: return a.name !== undefined ? { id: u('id'), self_link: u('self_link') } : { id: u('id'), name: u('name'), self_link: u('self_link') };
    }
  }

  function evaluateRepo(files) {
    // files: [{ path, text }] with forward-slash relative paths
    const fileMap = new Map(); for (const f of files) fileMap.set(f.path, f);
    const diagnostics = [];
    const parsed = new Map();
    const unsupportedFns = new Set();
    const consumedFiles = new Set(); // files read via file()/fileset()

    const isTf = (p) => /\.tf$/i.test(p) || /\.tf\.json$/i.test(p);
    function parseFile(p) {
      if (parsed.has(p)) return parsed.get(p);
      const f = fileMap.get(p); let body;
      if (/\.json$/i.test(p)) { try { body = jsonToBody(JSON.parse(f.text)); } catch (e) { diagnostics.push({ file: p, message: 'JSON parse error: ' + e.message }); body = { attrs: {}, blocks: [] }; } }
      else { const r = parse(f.text, p); if (r.error) diagnostics.push({ file: p, message: r.error }); body = r.body; }
      parsed.set(p, body); return body;
    }
    const dirs = new Map(); // dir -> [tf paths]
    for (const p of fileMap.keys()) if (isTf(p)) (dirs.get(dirOf(p)) || dirs.set(dirOf(p), []).get(dirOf(p))).push(p);

    // which dirs are referenced as local modules (so they are not roots)
    const referenced = new Set();
    for (const [dir, paths] of dirs) for (const p of paths) for (const b of parseFile(p).blocks) if (b.type === 'module' && b.body.attrs.source && b.body.attrs.source.expr.t === 'lit') {
      const src = String(b.body.attrs.source.expr.v); if (src.startsWith('./') || src.startsWith('../') || src === '.') referenced.add(joinPath(dir, src));
    }

    const moduleCache = new Map();
    const results = { roots: [], diagnostics, consumedFiles, unsupportedFns };

    function evaluateDir(dir, inputs, addrPrefix, rootDir, depth, tfvarsInfo) {
      const paths = (dirs.get(dir) || []).slice().sort();
      const variables = {}, localDefs = {}, resourceDefs = [], moduleDefs = [], outputDefs = {}, dataDefs = [];
      for (const p of paths) {
        const body = parseFile(p);
        for (const b of body.blocks) {
          if (b.type === 'variable') variables[b.labels[0]] = { def: b.body.attrs.default, file: p, line: b.line };
          else if (b.type === 'locals') for (const [k, v] of Object.entries(b.body.attrs)) localDefs[k] = { expr: v.expr, file: p, line: v.line };
          else if (b.type === 'resource') resourceDefs.push({ type: b.labels[0], name: b.labels[1], body: b.body, file: p, line: b.line });
          else if (b.type === 'data') dataDefs.push({ type: b.labels[0], name: b.labels[1], body: b.body, file: p, line: b.line });
          else if (b.type === 'module') moduleDefs.push({ name: b.labels[0], body: b.body, file: p, line: b.line });
          else if (b.type === 'output') outputDefs[b.labels[0]] = { expr: b.body.attrs.value && b.body.attrs.value.expr, file: p, line: b.line };
        }
      }
      const out = { dir, address: addrPrefix, files: paths, variables: {}, locals: {}, resources: [], modules: [], outputs: {}, tfvars: tfvarsInfo || [] };
      const emptyScope = new Scope(null, {});

      const env = {
        readFile(p) { const f = fileMap.get(p); if (!f) return null; consumedFiles.add(p); return f.text; },
        listFiles() { return Array.from(fileMap.keys()); },
        unsupported(n) { unsupportedFns.add(n); },
        resolveRoot(name, scope) {
          if (scope.has(name)) return scope.get(name);
          switch (name) {
            case 'var': return varProxy;
            case 'local': return localProxy;
            case 'module': return moduleProxy;
            case 'path': return { module: dir || '.', root: rootDir || '.', cwd: rootDir || '.' };
            case 'terraform': return { workspace: 'default' };
            case 'data': return dataProxy;
            case 'self': return U('self');
            case 'each': return U('each'); case 'count': return U('count');
            default: return resourceProxy(name);
          }
        }
      };
      // var.*
      const varProxy = new Instance('var', {}, {});
      varProxy.get = (k) => {
        if (k in inputs) return inputs[k];
        if (k in variables) { const d = variables[k].def; if (d) { try { return evalExpr(d.expr, env, emptyScope); } catch (e) { return U('var.' + k); } } }
        return U('var.' + k);
      };
      // local.*  (lazy, memoised, cycle-safe)
      const localMemo = new Map(); const localBusy = new Set();
      const localProxy = new Instance('local', {}, {});
      localProxy.get = (k) => {
        if (!(k in localDefs)) return U('local.' + k);
        if (localMemo.has(k)) return localMemo.get(k);
        if (localBusy.has(k)) return U('local.' + k + ' (cycle)');
        localBusy.add(k);
        let v; try { v = evalExpr(localDefs[k].expr, env, emptyScope); } catch (e) { if (!(e instanceof EvalError)) throw e; diagnostics.push({ file: localDefs[k].file, line: localDefs[k].line, message: 'local.' + k + ': ' + e.message }); v = U('local.' + k); }
        localBusy.delete(k); localMemo.set(k, v); return v;
      };
      const dataProxy = new Instance('data', {}, {}); dataProxy.get = (t) => { const i = new Instance('data.' + t, {}, {}); i.get = (n) => U('data.' + t + '.' + n); return i; };

      // resources: evaluated lazily by address so cross references work in any order
      const resMemo = new Map(); const resBusy = new Set();
      const resourceProxy = (type) => { const i = new Instance(type, {}, {}); i.get = (name) => resourceValue(type, name); return i; };
      function resourceValue(type, name) {
        const key = type + '.' + name;
        if (resMemo.has(key)) return resMemo.get(key);
        const def = resourceDefs.find((r) => r.type === type && r.name === name);
        if (!def) return U(key);
        if (resBusy.has(key)) return U(key + ' (cycle)');
        resBusy.add(key);
        const insts = expand(def, (sc, k, idx) => {
          const addr = addrPrefix + key + (k !== null ? '[' + JSON.stringify(k) + ']' : '');
          const attrs = evalBody(def.body, sc, addr, def.file);
          const inst = new Instance(addr, attrs, computedAttrs(type, attrs, addr));
          out.resources.push({ type, name, key: k, index: idx, address: addr, attrs, file: def.file, line: def.line, instance: inst });
          return inst;
        });
        resBusy.delete(key); resMemo.set(key, insts); return insts;
      }
      // modules
      const modMemo = new Map(); const modBusy = new Set();
      const moduleProxy = new Instance('module', {}, {}); moduleProxy.get = (name) => moduleValue(name);
      function moduleValue(name) {
        if (modMemo.has(name)) return modMemo.get(name);
        const def = moduleDefs.find((m) => m.name === name);
        if (!def) return U('module.' + name);
        if (modBusy.has(name)) return U('module.' + name + ' (cycle)');
        modBusy.add(name);
        const v = expand(def, (sc, k) => {
          const addr = addrPrefix + 'module.' + name + (k !== null ? '[' + JSON.stringify(k) + ']' : '');
          const attrs = evalBody(def.body, sc, addr, def.file, true);
          const source = attrs.source; delete attrs.source;
          const rec = { name, key: k, address: addr, source: isUnk(source) ? String(source) : source, inputs: attrs, file: def.file, line: def.line, local: null };
          out.modules.push(rec);
          const srcStr = typeof source === 'string' ? source : '';
          const isLocal = srcStr.startsWith('./') || srcStr.startsWith('../') || srcStr === '.';
          if (isLocal && depth < 8) {
            const mdir = joinPath(dir, srcStr);
            if (dirs.has(mdir)) {
              const cacheKey = addr; let sub = moduleCache.get(cacheKey);
              if (!sub) { sub = evaluateDir(mdir, attrs, addr + '.', rootDir, depth + 1); moduleCache.set(cacheKey, sub); }
              rec.local = sub;
              const inst = new Instance(addr, {}, {}); inst.get = (o) => (o in sub.outputs ? sub.outputs[o] : U(addr + '.' + o)); return inst;
            }
            diagnostics.push({ file: def.file, line: def.line, message: 'module "' + name + '": local source ' + srcStr + ' has no .tf files in this repo' });
          }
          const inst = new Instance(addr, {}, {}); inst.get = (o) => U(addr + '.' + o); return inst;
        });
        modBusy.delete(name); modMemo.set(name, v); return v;
      }

      // for_each / count expansion. fn(scope, key, index) -> value
      function expand(def, fn) {
        const a = def.body.attrs;
        if (a.for_each) {
          let coll; try { coll = evalExpr(a.for_each.expr, env, emptyScope); } catch (e) { if (!(e instanceof EvalError)) throw e; diagnostics.push({ file: def.file, line: a.for_each.line, message: 'for_each: ' + e.message }); coll = U('for_each'); }
          if (isUnk(coll)) { const sc = emptyScope.child({ each: { key: U('each.key'), value: U('each.value') } }); return { '*': fn(sc, '*', null) }; }
          const o = {};
          if (Array.isArray(coll)) for (const k of coll) { if (isUnk(k)) continue; o[String(k)] = fn(emptyScope.child({ each: { key: String(k), value: k } }), String(k), null); }
          else if (isMap(coll)) for (const k of Object.keys(coll).sort()) o[k] = fn(emptyScope.child({ each: { key: k, value: coll[k] } }), k, null);
          return o;
        }
        if (a.count) {
          let n; try { n = evalExpr(a.count.expr, env, emptyScope); } catch (e) { if (!(e instanceof EvalError)) throw e; diagnostics.push({ file: def.file, line: a.count.line, message: 'count: ' + e.message }); n = U('count'); }
          if (isUnk(n)) return [fn(emptyScope.child({ count: { index: U('count.index') } }), '*', null)];
          const list = []; for (let i = 0; i < toNum(n); i++) list.push(fn(emptyScope.child({ count: { index: i } }), i, i));
          return list;
        }
        return fn(emptyScope, null, null);
      }
      // Evaluate a block body into a plain object: attributes + nested blocks
      // (as lists), dynamic blocks expanded.
      function evalBody(body, scope, addr, file, isModule) {
        const o = {};
        for (const [k, a] of Object.entries(body.attrs)) {
          if (k === 'for_each' || k === 'count' || k === 'depends_on' || k === 'provider' || k === 'providers' || k === 'lifecycle') continue;
          try { o[k] = evalExpr(a.expr, env, scope); } catch (e) { if (!(e instanceof EvalError)) throw e; diagnostics.push({ file, line: a.line, message: addr + '.' + k + ': ' + e.message }); o[k] = U(addr + '.' + k + ' (' + e.message + ')'); }
        }
        for (const b of body.blocks) {
          if (b.type === 'lifecycle' || b.type === 'provisioner' || b.type === 'connection' || b.type === 'timeouts') continue;
          if (b.type === 'dynamic') {
            const label = b.labels[0]; const iter = (b.body.attrs.iterator && b.body.attrs.iterator.expr.t === 'ref') ? b.body.attrs.iterator.expr.n : label;
            const content = b.body.blocks.find((x) => x.type === 'content');
            let coll; try { coll = b.body.attrs.for_each ? evalExpr(b.body.attrs.for_each.expr, env, scope) : []; } catch (e) { if (!(e instanceof EvalError)) throw e; diagnostics.push({ file, line: b.line, message: addr + ' dynamic ' + label + ': ' + e.message }); coll = U('dynamic'); }
            const list = o[label] = o[label] || [];
            const items = isUnk(coll) ? [[U(iter + '.key'), U(iter + '.value')]] : Array.isArray(coll) ? coll.map((v, i) => [i, v]) : isMap(coll) ? Object.keys(coll).sort().map((k) => [k, coll[k]]) : [];
            for (const [k, v] of items) list.push(content ? evalBody(content.body, scope.child({ [iter]: { key: k, value: v } }), addr + '.' + label, file) : {});
            continue;
          }
          (o[b.type] = o[b.type] || []).push(evalBody(b.body, scope, addr + '.' + b.type, file));
        }
        return o;
      }

      // --- drive evaluation ---
      for (const k of Object.keys(variables)) out.variables[k] = varProxy.get(k);
      for (const k of Object.keys(localDefs)) out.locals[k] = localProxy.get(k);
      for (const r of resourceDefs) resourceValue(r.type, r.name);
      for (const m of moduleDefs) moduleValue(m.name);
      for (const [k, d] of Object.entries(outputDefs)) { if (!d.expr) continue; try { out.outputs[k] = evalExpr(d.expr, env, emptyScope); } catch (e) { if (!(e instanceof EvalError)) throw e; out.outputs[k] = U(addrPrefix + 'output.' + k); } }
      out.data = dataDefs.map((d) => ({ type: d.type, name: d.name, file: d.file, line: d.line }));
      return out;
    }

    // tfvars for a root directory
    function rootInputs(dir) {
      const names = Array.from(fileMap.keys()).filter((p) => dirOf(p) === dir);
      const auto = names.filter((p) => /(^|\/)terraform\.tfvars(\.json)?$/.test(p) || /\.auto\.tfvars(\.json)?$/.test(p)).sort();
      const others = names.filter((p) => /\.tfvars(\.json)?$/.test(p) && !auto.includes(p)).sort();
      const use = auto.length ? auto : others;
      const inputs = {}; const used = [];
      for (const p of use) {
        const body = parseFile(p); used.push(p);
        for (const [k, a] of Object.entries(body.attrs)) { try { inputs[k] = evalExpr(a.expr, { resolveRoot: () => U('ref in tfvars'), readFile: () => null, listFiles: () => [], unsupported() {} }, new Scope(null, {})); } catch (e) { if (!(e instanceof EvalError)) throw e; inputs[k] = U(k); } }
      }
      if (!auto.length && others.length > 1) diagnostics.push({ file: dir || '.', message: 'no terraform.tfvars / *.auto.tfvars; merged ' + others.length + ' .tfvars files: ' + others.map(baseOf).join(', ') });
      return { inputs, used };
    }

    for (const dir of Array.from(dirs.keys()).sort()) {
      if (referenced.has(dir)) continue;
      const { inputs, used } = rootInputs(dir);
      results.roots.push(evaluateDir(dir, inputs, '', dir, 0, used));
    }
    // local module dirs never called from anywhere still get evaluated standalone
    for (const dir of referenced) if (!results.roots.some((r) => r.dir === dir) && !Array.from(moduleCache.values()).some((m) => m.dir === dir)) {
      const { inputs, used } = rootInputs(dir); results.roots.push(evaluateDir(dir, inputs, '', dir, 0, used));
    }
    for (const n of unsupportedFns) diagnostics.push({ file: '', message: 'unsupported function: ' + n + '() — values using it are shown as ${' + n + '(…)}' });
    results.readFiles = Array.from(parsed.keys());
    return results;
  }

  // Evaluate a standalone .tfvars file (not attached to any root) to plain values.
  function evaluateTfvars(text, filename) {
    const r = /\.json$/i.test(filename) ? (() => { try { return { body: jsonToBody(JSON.parse(text)) }; } catch (e) { return { body: { attrs: {} }, error: e.message }; } })() : parse(text, filename);
    const out = {}; const lines = {};
    const env = { resolveRoot: () => U('ref'), readFile: () => null, listFiles: () => [], unsupported() {} };
    for (const [k, a] of Object.entries(r.body.attrs)) { lines[k] = a.line; try { out[k] = evalExpr(a.expr, env, new Scope(null, {})); } catch (e) { out[k] = U(k); } }
    return { values: out, lines, error: r.error };
  }

  return { parse, parseExpr, evaluateRepo, evaluateTfvars, yamlDecode, Unknown, isUnknown: isUnk, plain, Instance };
});
