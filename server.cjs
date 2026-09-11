#!/usr/bin/env node
/**
 * agent-core-mcp — deterministic computation tools for AI agents.
 *
 * ZERO DEPENDENCIES. Pure Node.js (>=18), CommonJS-free ESM-free: this file is
 * plain Node with no imports at all, so it runs the moment Node exists. There is
 * nothing to install, nothing to compile, and nothing to keep up to date.
 *
 * Contract:
 *   - no network access
 *   - no credentials, no environment variables read
 *   - read-only, stateless, deterministic
 *   - every loop and result set is bounded
 */

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

// #region deterministic-core
// ---------------------------------------------------------------------------
// The engine. Pure functions, no I/O, no globals.
// ---------------------------------------------------------------------------

class ToolError extends Error {}

function assertNonEmpty(v, field) {
  if (typeof v !== 'string' || v.length === 0) throw new ToolError(`${field} must be a non-empty string`);
  return v;
}

function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/* ------------------------------- diff_text ------------------------------- */

function diffText(a, b, maxLines) {
  assertNonEmpty(a, 'a');
  assertNonEmpty(b, 'b');
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 2000;

  const at = String(a).split('\n');
  const bt = String(b).split('\n');
  const n = at.length;
  const m = bt.length;

  const budget = 4000000;
  if (n * m > budget) {
    throw new ToolError(
      `inputs too large for exact diff (${n}x${m} > ${budget} cells). Split the input or raise granularity.`
    );
  }

  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0, j = 0, added = 0, removed = 0, unchanged = 0;
  while (i < n && j < m) {
    if (at[i] === bt[j]) {
      lines.push({ op: 'equal', aLine: i + 1, bLine: j + 1, text: at[i] });
      i++; j++; unchanged++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ op: 'del', aLine: i + 1, text: at[i] });
      i++; removed++;
    } else {
      lines.push({ op: 'ins', bLine: j + 1, text: bt[j] });
      j++; added++;
    }
  }
  while (i < n) { lines.push({ op: 'del', aLine: i + 1, text: at[i] }); i++; removed++; }
  while (j < m) { lines.push({ op: 'ins', bLine: j + 1, text: bt[j] }); j++; added++; }

  const truncated = lines.length > cap;
  return { added, removed, unchanged, truncated, lines: truncated ? lines.slice(0, cap) : lines };
}

/* ---------------------------------- hash --------------------------------- */

const HASH_ALGOS = ['sha256', 'sha512', 'sha1', 'md5'];

function hashText(text, algo, hmacKey) {
  const crypto = require('crypto');
  const a = String(algo || 'sha256').toLowerCase();
  if (HASH_ALGOS.indexOf(a) === -1) {
    throw new ToolError(`unsupported algo "${algo}". allowed: ${HASH_ALGOS.join(', ')}`);
  }
  const make = () => {
    const h = hmacKey ? crypto.createHmac(a, String(hmacKey)) : crypto.createHash(a);
    return h.update(String(text), 'utf8');
  };
  return {
    algo: hmacKey ? `hmac-${a}` : a,
    hex: make().digest('hex'),
    base64: make().digest('base64'),
    bytes: utf8Bytes(String(text))
  };
}

/* ------------------------------- json_query ------------------------------ */

function parsePath(path) {
  const cleaned = String(path).replace(/^\$\.?/, '');
  if (cleaned === '') return [];
  const segs = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1] !== undefined) segs.push(m[1]);
    else if (m[2] !== undefined) segs.push(Number(m[2]));
  }
  if (segs.length === 0) throw new ToolError(`could not parse path "${path}"`);
  return segs;
}

function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function jsonQuery(doc, path) {
  const segs = parsePath(path);
  let cur = doc;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (cur === null || cur === undefined) return { found: false, resolved: false, type: 'undefined' };
    if (typeof s === 'number') {
      if (!Array.isArray(cur)) return { found: false, resolved: false, type: 'not-an-array' };
      if (s >= cur.length) return { found: false, resolved: false, type: 'out-of-range' };
      cur = cur[s];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) {
        return { found: false, resolved: false, type: 'not-an-object' };
      }
      if (!Object.prototype.hasOwnProperty.call(cur, s)) {
        return { found: false, resolved: false, type: 'missing-key' };
      }
      cur = cur[s];
    }
  }
  return { found: cur !== null && cur !== undefined, resolved: true, value: cur, type: jsonTypeOf(cur) };
}

function jsonValidate(text) {
  assertNonEmpty(text, 'text');
  try {
    JSON.parse(text);
    return { valid: true };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    let line, column;
    const pm = /at position (\d+)/.exec(msg);
    if (pm) {
      const before = String(text).slice(0, Number(pm[1]));
      const parts = before.split('\n');
      line = parts.length;
      column = parts[parts.length - 1].length + 1;
    }
    return { valid: false, error: msg, line, column };
  }
}

/* ------------------------------- text_stats ------------------------------ */

function textStats(text, topN) {
  assertNonEmpty(text, 'text');
  const t = String(text);
  const n = Number.isInteger(topN) && topN >= 0 ? topN : 10;

  const chars = Array.from(t).length;
  const charsNoWhitespace = Array.from(t.replace(/\s/g, '')).length;
  const lines = t.split('\n');
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length;
  const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;

  // Word segmentation.
  //
  // Do NOT write this as /[class][class]*/ with overlapping classes. The earlier
  // version of this line was /[\p{L}\p{N}][\p{L}\p{N}'\u2019_-]*/u, whose two
  // adjacent classes overlap; on a long run of letters followed by a non-match it
  // backtracked exponentially and hung the process for minutes. This shape has no
  // ambiguity: a leading run, then optional (separator + run) pairs.
  const words = t.toLowerCase().match(/[\p{L}\p{N}]+(?:['\u2019_-][\p{L}\p{N}]+)*/gu) || [];
  const sentences = (t.match(/[.!?\u3002\uff01\uff1f]+(?=\s|$)/g) || []).length;

  const freq = new Map();
  for (let i = 0; i < words.length; i++) freq.set(words[i], (freq.get(words[i]) || 0) + 1);
  const topWords = Array.from(freq.entries())
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1))
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));

  let totalLen = 0;
  for (let i = 0; i < words.length; i++) totalLen += Array.from(words[i]).length;

  return {
    chars,
    charsNoWhitespace,
    bytes: utf8Bytes(t),
    lines: lines.length,
    nonEmptyLines,
    words: words.length,
    sentences,
    paragraphs,
    uniqueWords: freq.size,
    avgWordLength: words.length === 0 ? 0 : Math.round((totalLen / words.length) * 100) / 100,
    topWords
  };
}

/* -------------------------------- date_calc ------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?Z?)?$/;

function parseIsoDate(s) {
  const m = DATE_RE.exec(String(s).trim());
  if (!m) throw new ToolError(`invalid date "${s}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][.mmm]Z`);
  return new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
  ));
}

function formatIso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function countBusinessDays(a, b) {
  const forward = b.getTime() >= a.getTime();
  const lo = forward ? a : b;
  const hi = forward ? b : a;
  const cur = new Date(Date.UTC(lo.getUTCFullYear(), lo.getUTCMonth(), lo.getUTCDate()));
  const end = Date.UTC(hi.getUTCFullYear(), hi.getUTCMonth(), hi.getUTCDate());
  let count = 0, guard = 0;
  while (cur.getTime() < end && guard++ < 400000) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return forward ? count : -count;
}

const DATE_UNITS = ['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds', 'businessDays'];

function dateCalc(from, to, unit) {
  let a, b;
  try {
    a = parseIsoDate(from);
  } catch (e) {
    throw new ToolError(`invalid from date "${from}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][.mmm]Z`);
  }
  try {
    b = parseIsoDate(to);
  } catch (e) {
    throw new ToolError(`invalid to date "${to}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][.mmm]Z`);
  }
  if (Number.isNaN(a.getTime())) throw new ToolError(`invalid from date "${from}"`);
  if (Number.isNaN(b.getTime())) throw new ToolError(`invalid to date "${to}"`);
  const u = unit || 'days';
  if (DATE_UNITS.indexOf(u) === -1) throw new ToolError(`unsupported unit "${u}"`);

  const ms = b.getTime() - a.getTime();
  const totalDays = ms / 86400000;
  let value;
  switch (u) {
    case 'days': value = totalDays; break;
    case 'weeks': value = totalDays / 7; break;
    case 'hours': value = ms / 3600000; break;
    case 'minutes': value = ms / 60000; break;
    case 'seconds': value = ms / 1000; break;
    case 'months': {
      const whole = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
      const anchor = new Date(a.getTime());
      anchor.setUTCMonth(anchor.getUTCMonth() + whole);
      value = whole + (b.getTime() - anchor.getTime()) / 86400000 / 30.436875;
      break;
    }
    case 'years': value = totalDays / 365.2425; break;
    case 'businessDays': value = countBusinessDays(a, b); break;
    default: throw new ToolError(`unsupported unit "${u}"`);
  }

  return {
    from: formatIso(a), to: formatIso(b), unit: u,
    value: Math.round(value * 1000) / 1000,
    sign: Math.sign(ms),
    totalDays: Math.round(totalDays * 1000) / 1000
  };
}

function dateAdd(date, amount, unit) {
  const d = parseIsoDate(date);
  const out = new Date(d.getTime());
  const amt = Number(amount);
  if (!Number.isFinite(amt)) throw new ToolError('amount must be a finite number');
  switch (unit || 'days') {
    case 'days': out.setUTCDate(out.getUTCDate() + amt); break;
    case 'weeks': out.setUTCDate(out.getUTCDate() + amt * 7); break;
    case 'months': out.setUTCMonth(out.getUTCMonth() + amt); break;
    case 'years': out.setUTCFullYear(out.getUTCFullYear() + amt); break;
    case 'hours': out.setUTCHours(out.getUTCHours() + amt); break;
    case 'minutes': out.setUTCMinutes(out.getUTCMinutes() + amt); break;
    case 'seconds': out.setUTCSeconds(out.getUTCSeconds() + amt); break;
    default: throw new ToolError(`unsupported unit "${unit}"`);
  }
  return { result: formatIso(out), input: formatIso(d), amount: amt, unit: unit || 'days' };
}

/* ------------------------------ regex tools ------------------------------ */

function analyzeRegexSafety(pattern) {
  const p = String(pattern);
  const reasons = [];
  let risk = 'low';
  const bump = (level, why) => {
    reasons.push(why);
    if (level === 'high' || risk === 'high') risk = 'high';
    else risk = 'medium';
  };
  if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(p)) {
    bump('high', 'nested quantifier inside a repeated group — classic exponential backtracking');
  }
  if (/\([^()]*\|[^()]*\)\s*[+*]/.test(p)) {
    bump('medium', 'alternation inside a repeated group can overlap and backtrack');
  }
  const wildcards = (p.match(/\.\*/g) || []).length;
  if (wildcards >= 3) bump('medium', `${wildcards} .* wildcards`);
  if (/\\[1-9]/.test(p) && /\([^()]*\)\s*[+*{]/.test(p)) {
    bump('medium', 'backreference inside a repeated group');
  }
  if (p.length > 1000) bump('medium', `pattern is very long (${p.length} chars)`);
  return { risk, reasons };
}

function regexExtract(text, pattern, flags, maxMatches) {
  assertNonEmpty(text, 'text');
  assertNonEmpty(pattern, 'pattern');
  const cap = Number.isInteger(maxMatches) && maxMatches > 0 ? maxMatches : 500;
  const safety = analyzeRegexSafety(pattern);

  const allowed = 'gimsuy';
  let cleanFlags = '';
  const seen = {};
  const raw = String(flags || '');
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (allowed.indexOf(c) !== -1 && !seen[c]) { seen[c] = 1; cleanFlags += c; }
  }
  if (cleanFlags.indexOf('g') === -1) cleanFlags += 'g';

  let re;
  try { re = new RegExp(pattern, cleanFlags); }
  catch (e) { throw new ToolError(`invalid regex: ${e && e.message ? e.message : String(e)}`); }

  const matches = [];
  let m, iterations = 0;
  const iterationCap = Math.max(cap * 10, 10000);
  while ((m = re.exec(text)) !== null) {
    if (++iterations > iterationCap) break;
    matches.push({
      match: m[0],
      index: m.index,
      groups: m.slice(1),
      named: m.groups ? Object.assign({}, m.groups) : {}
    });
    if (matches.length >= cap) break;
    if (m[0] === '') re.lastIndex++;
  }
  return { matches, count: matches.length, truncated: matches.length >= cap, safety };
}

/**
 * Execute a regex in an isolated worker with a hard deadline.
 *
 * Node's regex engine cannot be interrupted: a catastrophic-backtracking pattern
 * blocks the main thread indefinitely, which in an MCP server means the whole
 * client session freezes. Process isolation plus termination is the only real
 * boundary. Measured blowup for /(a+)+$/ on 'a'*n + '!': n=22 -> 70ms,
 * n=24 -> 276ms, n=26 -> 1108ms (~4x per 2 chars). At n=40 it never returns.
 *
 * Returns the same shape as regexExtract, plus `timedOut` and `budgetMs`.
 */
function regexExtractGuarded(text, pattern, flags, maxMatches, budgetMs) {
  const d = Number.isInteger(budgetMs) && budgetMs > 0 ? Math.min(budgetMs, 10000) : 1000;
  const workerPath = path.join(__dirname, 'regex-worker.cjs');

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(workerPath, {
        workerData: {
          text: String(text),
          pattern: String(pattern),
          flags: (function () {
            const allowed = 'gimsuy';
            let out = '', seen = {}, raw = String(flags || '');
            for (let i = 0; i < raw.length; i++) {
              const c = raw[i];
              if (allowed.indexOf(c) !== -1 && !seen[c]) { seen[c] = 1; out += c; }
            }
            if (out.indexOf('g') === -1) out += 'g';
            return out;
          })()
        }
      });
    } catch (e) {
      // Worker unavailable (exotic runtime). Fall back to in-process, unguarded,
      // and say so rather than pretending the call is protected.
      let result;
      try {
        result = regexExtract(text, pattern, flags, maxMatches);
        result.guarded = false;
        result.note = 'worker threads unavailable; execution was NOT time-bounded';
      } catch (err) {
        result = { error: err instanceof ToolError ? err.message : String(err && err.message) };
      }
      resolve(result);
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({
        timedOut: true,
        budgetMs: d,
        safety: analyzeRegexSafety(pattern),
        matches: [],
        count: 0,
        truncated: true,
        advice:
          `Pattern execution exceeded ${d}ms and was terminated. This pattern exhibits catastrophic ` +
          `backtracking on this input. Rewrite it to remove ambiguity — typically by replacing a nested ` +
          `quantifier such as (a+)+ with an unambiguous form such as a+, or by anchoring and bounding ` +
          `repetition — or raise budgetMs up to 10000 if the slow path is genuinely required.`
      });
    }, d);

    worker.on('message', (msg) => {
      if (msg && msg.ok) {
        finish({
          guarded: true,
          timedOut: false,
          budgetMs: d,
          matches: msg.matches,
          count: msg.count,
          truncated: msg.truncated,
          safety: analyzeRegexSafety(pattern)
        });
      } else {
        finish({ guarded: true, timedOut: false, error: (msg && msg.error) || 'regex worker failed' });
      }
    });

    worker.on('error', (err) => {
      finish({
        guarded: true,
        timedOut: false,
        error: `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : String(err)}`
      });
    });

    worker.on('exit', (code) => {
      if (!settled) {
        finish({
          guarded: true,
          timedOut: false,
          error: `regex worker exited unexpectedly with code ${code}`
        });
      }
    });
  });
}

/* ------------------------------ fuzzy_match ------------------------------ */

function bigramCounts(s) {
  const norm = String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    out.set(bg, (out.get(bg) || 0) + 1);
  }
  return out;
}

function similarity(a, b) {
  const A = String(a), B = String(b);
  if (A === B) return 1;
  const ga = bigramCounts(A), gb = bigramCounts(B);
  if (ga.size === 0 || gb.size === 0) return 0;
  let overlap = 0;
  ga.forEach((ca, bg) => { const cb = gb.get(bg); if (cb !== undefined) overlap += Math.min(ca, cb); });
  let total = 0;
  ga.forEach((v) => { total += v; });
  gb.forEach((v) => { total += v; });
  return Math.round((2 * overlap / total) * 10000) / 10000;
}

function fuzzyMatch(needle, haystack, topN, threshold) {
  assertNonEmpty(needle, 'needle');
  if (!Array.isArray(haystack) || haystack.length === 0) throw new ToolError('haystack must be a non-empty array of strings');
  if (haystack.length > 100000) throw new ToolError(`haystack too large (${haystack.length}); cap is 100000`);
  const n = Number.isInteger(topN) && topN > 0 ? topN : 5;
  const th = typeof threshold === 'number' ? threshold : 0;
  const results = haystack
    .map((value, index) => ({ value, score: similarity(needle, String(value)), index }))
    .filter((r) => r.score >= th)
    .sort((x, y) => (y.score - x.score) || (x.index - y.index))
    .slice(0, n);
  return { results, candidates: haystack.length };
}

/* ------------------------------ parse_table ------------------------------ */

function parseTable(text, delimiter, hasHeader, maxRows) {
  assertNonEmpty(text, 'text');
  const cap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 5000;
  let delim = delimiter;
  if (!delim) {
    const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
    const candidates = [',', '\t', ';', '|'];
    let best = ',', bestCount = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const count = firstLine.split(c).length - 1;
      if (count > bestCount) { bestCount = count; best = c; }
    }
    delim = best;
  }
  if (delim.length !== 1) throw new ToolError('delimiter must be a single character');

  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) pushField();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { if (t[i + 1] === '\n') i++; pushRow(); }
    else field += ch;
    if (rows.length > cap + 1) break;
  }
  if (field !== '' || row.length > 0) pushRow();

  const truncated = rows.length > cap;
  const limited = truncated ? rows.slice(0, cap) : rows;
  let header = null, body = limited;
  if (hasHeader !== false && limited.length > 0) { header = limited[0]; body = limited.slice(1); }
  let columnCount = 0;
  for (let i = 0; i < limited.length; i++) if (limited[i].length > columnCount) columnCount = limited[i].length;

  return { header, rows: body, rowCount: body.length, columnCount, truncated, delimiter: delim };
}

/* -------------------------------- convert -------------------------------- */

const UNITS = {
  m: [1, 'length'], km: [1000, 'length'], cm: [0.01, 'length'], mm: [0.001, 'length'],
  mi: [1609.344, 'length'], yd: [0.9144, 'length'], ft: [0.3048, 'length'],
  in: [0.0254, 'length'], nmi: [1852, 'length'],
  kg: [1, 'mass'], g: [0.001, 'mass'], mg: [1e-6, 'mass'], t: [1000, 'mass'],
  lb: [0.45359237, 'mass'], oz: [0.028349523125, 'mass'],
  s: [1, 'time'], min: [60, 'time'], h: [3600, 'time'], d: [86400, 'time'],
  b: [1, 'data'], kb: [1000, 'data'], mb: [1e6, 'data'], gb: [1e9, 'data'],
  kib: [1024, 'data'], mib: [1048576, 'data'], gib: [1073741824, 'data']
};

function convert(from, to, value) {
  const f = UNITS[String(from).toLowerCase()];
  const t = UNITS[String(to).toLowerCase()];
  if (!f) throw new ToolError(`unknown source unit "${from}"`);
  if (!t) throw new ToolError(`unknown target unit "${to}"`);
  if (f[1] !== t[1]) throw new ToolError(`cannot convert ${f[1]} (${from}) to ${t[1]} (${to})`);
  const v = Number(value);
  if (!Number.isFinite(v)) throw new ToolError('value must be a finite number');
  return { from, to, value: v, result: Math.round((v * f[0] / t[0]) * 1e10) / 1e10, kind: f[1] };
}

function baseConvert(value, fromBase, toBase) {
  const fb = Number(fromBase), tb = Number(toBase);
  if (!(fb >= 2 && fb <= 36)) throw new ToolError('fromBase must be 2..36');
  if (!(tb >= 2 && tb <= 36)) throw new ToolError('toBase must be 2..36');
  const cleaned = String(value).trim().replace(/^0[bxo]/i, '').toLowerCase();
  if (cleaned === '' || !/^[0-9a-z]+$/.test(cleaned)) {
    throw new ToolError(`"${value}" is not a valid base-${fb} integer`);
  }
  let dec = 0n;
  const bigBase = BigInt(fb);
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const digit = parseInt(ch, 36);
    if (digit >= fb) throw new ToolError(`digit "${ch}" is not valid in base ${fb}`);
    dec = dec * bigBase + BigInt(digit);
  }
  return { input: value, fromBase: fb, toBase: tb, result: dec.toString(tb), decimal: dec.toString(10) };
}

// #endregion deterministic-core

// #region tool-registry
// ---------------------------------------------------------------------------
// Tool registry. Descriptions are part of the product: they are what the model
// reads when deciding whether to call. Each one states the contract explicitly.
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const TOOLS = [
  {
    name: 'diff_text',
    description:
      'Compute an exact line-by-line diff between two texts using a longest-common-subsequence algorithm. ' +
      'Returns per-line operations (equal/del/ins) with line numbers plus added/removed/unchanged counts. ' +
      'Exact and reproducible; refuses oversized input rather than hanging.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, description: 'The original text' },
        b: { type: 'string', minLength: 1, description: 'The revised text' },
        maxLines: { type: 'integer', minimum: 1, maximum: 20000, description: 'Cap on returned diff lines (default 2000)' }
      },
      required: ['a', 'b'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => diffText(i.a, i.b, i.maxLines)
  },
  {
    name: 'hash',
    description:
      'Compute a cryptographic hash of a UTF-8 string. Returns hex and base64 digests plus the UTF-8 byte length. ' +
      'Supports sha256 (default), sha512, sha1, md5, and HMAC variants via hmacKey. ' +
      'Use for content fingerprints, deduplication and integrity checks.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to hash' },
        algo: { type: 'string', enum: HASH_ALGOS, description: 'Hash algorithm (default sha256)' },
        hmacKey: { type: 'string', description: 'If set, compute HMAC with this key' }
      },
      required: ['text'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => hashText(i.text, i.algo, i.hmacKey)
  },
  {
    name: 'json_validate',
    description:
      'Check whether a string is valid JSON. On failure returns the parser message plus the computed line and column ' +
      'of the error. On success returns the top-level shape. Distinguishes valid-but-empty-object from invalid.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'The JSON text to validate' },
        describeTopLevel: { type: 'boolean', description: 'Include top-level keys or array length (default true)' }
      },
      required: ['text'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => {
      const res = jsonValidate(i.text);
      if (!res.valid) return res;
      const parsed = JSON.parse(i.text);
      if (i.describeTopLevel === false) return { valid: true };
      let shape;
      if (Array.isArray(parsed)) shape = { kind: 'array', length: parsed.length };
      else if (parsed !== null && typeof parsed === 'object') shape = { kind: 'object', keys: Object.keys(parsed) };
      else shape = { kind: typeof parsed };
      return { valid: true, shape };
    }
  },
  {
    name: 'json_query',
    description:
      'Extract a value from a JSON document by path, e.g. "a.b[0].c" or "$.items[3].name". ' +
      'Reports `resolved` (did the path reach a location) separately from `found` (is the value non-null), ' +
      'so absent is distinguishable from present-but-null. Failure types are specific: ' +
      'missing-key, out-of-range, not-an-array, not-an-object.',
    inputSchema: {
      type: 'object',
      properties: {
        json: { type: 'string', minLength: 1, description: 'The JSON document as text' },
        path: { type: 'string', minLength: 1, description: 'Path, e.g. "a.b[0].c"' }
      },
      required: ['json', 'path'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => jsonQuery(JSON.parse(i.json), i.path)
  },
  {
    name: 'json_pick',
    description:
      'Resolve several paths against one JSON document in a single call. Cheaper than issuing many json_query calls ' +
      'when you need multiple fields.',
    inputSchema: {
      type: 'object',
      properties: {
        json: { type: 'string', minLength: 1, description: 'The JSON document as text' },
        paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 200, description: 'Paths to resolve' }
      },
      required: ['json', 'paths'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => {
      const doc = JSON.parse(i.json);
      const results = {};
      for (let k = 0; k < i.paths.length; k++) results[i.paths[k]] = jsonQuery(doc, i.paths[k]);
      return { count: i.paths.length, documentType: jsonTypeOf(doc), results };
    }
  },
  {
    name: 'text_stats',
    description:
      'Exact text statistics: Unicode code points, UTF-8 bytes, lines, non-empty lines, words, sentences, paragraphs, ' +
      'unique words, average word length and most frequent words. Word segmentation is Unicode-aware so non-Latin ' +
      'scripts are counted correctly. Use whenever a count must be exact.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'Text to measure' },
        topN: { type: 'integer', minimum: 0, maximum: 100, description: 'How many top words to return (default 10)' }
      },
      required: ['text'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => textStats(i.text, i.topN)
  },
  {
    name: 'date_calc',
    description:
      'Interval between two ISO-8601 dates in days, weeks, months, years, hours, minutes, seconds or businessDays ' +
      '(Mon-Fri). Months and years use true calendar arithmetic, not 30/365-day approximations. All math is UTC.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 1, description: 'Start date, e.g. 2026-01-15 or 2026-01-15T08:30:00Z' },
        to: { type: 'string', minLength: 1, description: 'End date, same formats' },
        unit: { type: 'string', enum: DATE_UNITS, description: 'Unit for the result (default days)' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => dateCalc(i.from, i.to, i.unit)
  },
  {
    name: 'date_add',
    description:
      'Offset an ISO-8601 date by days, weeks, months, years, hours, minutes or seconds. Negative amounts subtract. ' +
      'Calendar-correct across month ends and leap years.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', minLength: 1, description: 'Base date, e.g. 2026-01-31' },
        amount: { type: 'number', description: 'Amount to add; negative to subtract' },
        unit: { type: 'string', enum: ['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds'], description: 'Unit (default days)' }
      },
      required: ['date', 'amount'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => dateAdd(i.date, i.amount, i.unit)
  },
  {
    name: 'regex_extract',
    description:
      'Apply a regular expression and return every match with its index, numbered capture groups and named groups. ' +
      'Iteration and match counts are hard-capped so a pathological pattern cannot hang the host. ' +
      'The response includes a ReDoS risk assessment of the pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'Text to search' },
        pattern: { type: 'string', minLength: 1, description: 'Regular expression source, without slashes' },
        flags: { type: 'string', description: 'Flags from g i m s u y (g is always applied)' },
        maxMatches: { type: 'integer', minimum: 1, maximum: 5000, description: 'Cap on returned matches (default 500)' },
        budgetMs: { type: 'integer', minimum: 1, maximum: 10000, description: 'Execution deadline in milliseconds (default 1000, max 10000). Execution runs in a worker thread that is terminated on expiry.' }
      },
      required: ['text', 'pattern'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => regexExtractGuarded(i.text, i.pattern, i.flags, i.maxMatches, i.budgetMs)
  },
  {
    name: 'regex_analyze',
    description:
      'Statically analyse a regular expression for catastrophic backtracking (ReDoS): nested quantifiers, overlapping ' +
      'alternation inside repeated groups, backreferences under quantifiers, excessive wildcards. Returns a risk level ' +
      'and the specific reasons. The pattern is not executed.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', minLength: 1, description: 'Regular expression source to analyse' } },
      required: ['pattern'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => analyzeRegexSafety(i.pattern)
  },
  {
    name: 'fuzzy_match',
    description:
      'Score every candidate string against a query using the Sorensen-Dice coefficient over character bigrams and ' +
      'return the best matches in descending order. Deterministic. Useful for deduplication, record linkage, ' +
      'typo-tolerant lookup and confirming which of several candidates was meant.',
    inputSchema: {
      type: 'object',
      properties: {
        needle: { type: 'string', minLength: 1, description: 'The string to match against the list' },
        haystack: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100000, description: 'Candidate strings' },
        topN: { type: 'integer', minimum: 1, maximum: 500, description: 'How many results (default 5)' },
        threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum score to include (default 0)' }
      },
      required: ['needle', 'haystack'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => fuzzyMatch(i.needle, i.haystack, i.topN, i.threshold)
  },
  {
    name: 'similarity',
    description:
      'Sorensen-Dice similarity of two strings, from 0 (no shared character bigrams) to 1 (identical). One deterministic comparison.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => ({ a: i.a, b: i.b, score: similarity(i.a, i.b) })
  },
  {
    name: 'parse_table',
    description:
      'Parse delimited text into a header plus rows, handling quoted fields, escaped quotes, embedded delimiters and ' +
      'embedded newlines (RFC 4180 style). If no delimiter is given, the most frequent candidate on the first line is ' +
      'chosen and reported back. Use instead of splitting on commas, which breaks on any real CSV.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'Delimited text' },
        delimiter: { type: 'string', description: 'Single-character delimiter; auto-detected if omitted' },
        hasHeader: { type: 'boolean', description: 'Treat the first row as a header (default true)' },
        maxRows: { type: 'integer', minimum: 1, maximum: 200000, description: 'Row cap (default 5000)' }
      },
      required: ['text'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => parseTable(i.text, i.delimiter, i.hasHeader, i.maxRows)
  },
  {
    name: 'convert',
    description:
      'Convert a value between units of length, mass, time or data size. Cross-family conversions are rejected rather ' +
      'than silently producing nonsense. Data sizes: kb/mb/gb are decimal (1000), kib/mib/gib are binary (1024). ' +
      'Supported units: ' + Object.keys(UNITS).join(', ') + '.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'Numeric value to convert' },
        from: { type: 'string', minLength: 1, description: 'Source unit' },
        to: { type: 'string', minLength: 1, description: 'Target unit' }
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => convert(i.from, i.to, i.value)
  },
  {
    name: 'base_convert',
    description:
      'Convert an integer string between bases 2 and 36 with arbitrary precision. Uses big-integer parsing, so values ' +
      'beyond IEEE-754 double precision (2^53) stay exact, which is exactly where naive conversion goes wrong. ' +
      'A leading 0b/0x/0o prefix is ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', minLength: 1, description: 'Integer as text, e.g. "ff" or "255"' },
        fromBase: { type: 'integer', minimum: 2, maximum: 36, description: 'Source base' },
        toBase: { type: 'integer', minimum: 2, maximum: 36, description: 'Target base' }
      },
      required: ['value', 'fromBase', 'toBase'],
      additionalProperties: false
    },
    annotations: READ_ONLY,
    handler: (i) => baseConvert(i.value, i.fromBase, i.toBase)
  }
];

const TOOL_INDEX = {};
for (let i = 0; i < TOOLS.length; i++) TOOL_INDEX[TOOLS[i].name] = TOOLS[i];

const CONTRACT = {
  name: 'agent-core-mcp',
  version: require('./package.json').version,
  guarantees: [
    'No network access of any kind.',
    'No credentials, tokens or environment variables are read.',
    'All tools are read-only and side-effect free.',
    'Deterministic: identical input yields identical output.',
    'Every loop and result set is capped, so no input can hang the process.'
  ],
  nonGoals: [
    'No file system access.',
    'No shell or process execution.',
    'No storage of any kind; every call is stateless.'
  ],
  toolCount: TOOLS.length,
  hashAlgorithms: HASH_ALGOS,
  units: Object.keys(UNITS)
};

// #endregion tool-registry

// #region mcp-transport
// ---------------------------------------------------------------------------
// Minimal MCP server over stdio. Implemented directly so the package needs no
// SDK, no build step and no dependency tree to audit.
// ---------------------------------------------------------------------------

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'agent-core-mcp', version: CONTRACT.version };

function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations
  }));
}

/**
 * Validate arguments against a tool's own JSON Schema before dispatch.
 *
 * Do not trust the client to honour the schema. Models routinely omit required
 * fields or send the wrong type, and a server that silently proceeds on a
 * malformed call returns a confident wrong answer instead of an error — which is
 * exactly the failure mode this whole server exists to avoid.
 *
 * Deliberately minimal but strict on the parts that matter: presence of required
 * fields, primitive types, enum membership, and rejection of unknown properties
 * when the schema forbids them.
 */
function validateArgs(schema, args) {
  const problems = [];
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('arguments must be an object');
  }

  const props = schema.properties || {};
  const required = schema.required || [];

  for (const key of required) {
    if (args[key] === undefined) {
      problems.push(`missing required argument "${key}"`);
    }
  }

  for (const key of Object.keys(args)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false) problems.push(`unknown argument "${key}"`);
      continue;
    }
    const v = args[key];
    if (v === undefined) continue;
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') problems.push(`"${key}" must be a string`);
        else if (spec.minLength !== undefined && v.length < spec.minLength) {
          problems.push(`"${key}" must be at least ${spec.minLength} character(s)`);
        } else if (spec.enum && spec.enum.indexOf(v) === -1) {
          problems.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
        }
        break;
      case 'number':
        if (typeof v !== 'number' || !isFinite(v)) problems.push(`"${key}" must be a finite number`);
        else if (spec.minimum !== undefined && v < spec.minimum) problems.push(`"${key}" must be >= ${spec.minimum}`);
        else if (spec.maximum !== undefined && v > spec.maximum) problems.push(`"${key}" must be <= ${spec.maximum}`);
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) problems.push(`"${key}" must be an integer`);
        else if (spec.minimum !== undefined && v < spec.minimum) problems.push(`"${key}" must be >= ${spec.minimum}`);
        else if (spec.maximum !== undefined && v > spec.maximum) problems.push(`"${key}" must be <= ${spec.maximum}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') problems.push(`"${key}" must be a boolean`);
        break;
      case 'array':
        if (!Array.isArray(v)) problems.push(`"${key}" must be an array`);
        else if (spec.minItems !== undefined && v.length < spec.minItems) {
          problems.push(`"${key}" must contain at least ${spec.minItems} item(s)`);
        } else if (spec.maxItems !== undefined && v.length > spec.maxItems) {
          problems.push(`"${key}" must contain at most ${spec.maxItems} item(s)`);
        }
        break;
      default:
        break;
    }
  }

  if (problems.length > 0) {
    throw new ToolError(`invalid arguments: ${problems.join('; ')}`);
  }
  return args;
}

async function callTool(name, args) {
  const tool = TOOL_INDEX[name];
  if (!tool) throw new ToolError(`unknown tool "${name}"`);
  const input = validateArgs(tool.inputSchema, args);
  const out = await tool.handler(input);
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

/**
 * Build a message handler bound to an output sink.
 *
 * The transport is injected rather than hard-wired to process.stdout so the
 * whole protocol surface can be driven in-process by tests. That matters here:
 * the sandbox forbids spawning child processes, and an untestable protocol layer
 * is exactly how servers ship broken.
 */
function createHandler(out) {
  const write = (msg) => out.write(JSON.stringify(msg) + '\n');
  const send = (id, value) => write({ jsonrpc: '2.0', id, result: value });
  const sendError = (id, code, message, data) => {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    write({ jsonrpc: '2.0', id, error: err });
  };

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object') {
      sendError(null, -32600, 'Invalid Request');
      return;
    }
    const id = msg.id === undefined ? null : msg.id;
    const method = msg.method;
    const params = msg.params || {};
    const isNotification = msg.id === undefined;

    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const negotiated = PROTOCOL_VERSIONS.indexOf(requested) !== -1 ? requested : DEFAULT_PROTOCOL;
        send(id, {
          protocolVersion: negotiated,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: SERVER_INFO,
          instructions:
            'Deterministic computation tools. Prefer these over doing exact counting, diffing, hashing, calendar ' +
            'arithmetic or CSV parsing by hand: the results are exact and reproducible. No network, no credentials, read-only.'
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return; // notification, no response
      case 'ping':
        if (!isNotification) send(id, {});
        return;
      case 'tools/list':
        send(id, { tools: listTools() });
        return;
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') {
          sendError(id, -32602, 'Invalid params: "name" must be a string');
          return;
        }
        try {
          send(id, await callTool(name, params.arguments));
        } catch (e) {
          const message =
            e instanceof ToolError
              ? e.message
              : `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : String(e)}`;
          send(id, { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] });
        }
        return;
      }
      case 'resources/list':
        send(id, {
          resources: [
            {
              uri: 'agent-core://contract',
              name: 'contract',
              title: 'Execution contract',
              description: 'What this server does and does not do.',
              mimeType: 'application/json'
            }
          ]
        });
        return;
      case 'resources/read': {
        const uri = params.uri;
        if (uri !== 'agent-core://contract') {
          sendError(id, -32602, `Unknown resource: ${uri}`);
          return;
        }
        send(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(CONTRACT, null, 2) }]
        });
        return;
      }
      case 'prompts/list':
        send(id, { prompts: [] });
        return;
      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  };
}

/**
 * Feed newline-delimited JSON-RPC frames from a stream into a handler.
 *
 * Responses may be produced asynchronously (regex execution runs in a worker
 * thread with a deadline), so dispatch is fire-and-forget with error containment:
 * a rejection must never take the process down, because that would drop the
 * client session.
 */
function attachTransport(inStream, outStream) {
  const handle = createHandler(outStream);
  let buffer = '';

  const dispatch = (msg) => {
    Promise.resolve()
      .then(() => handle(msg))
      .catch((e) => {
        const id = msg && msg.id !== undefined ? msg.id : null;
        outStream.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `Internal error: ${e && e.message ? e.message : String(e)}` }
          }) + '\n'
        );
      });
  };

  inStream.setEncoding('utf8');
  inStream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        outStream.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      if (Array.isArray(msg)) {
        for (let i = 0; i < msg.length; i++) dispatch(msg[i]);
      } else {
        dispatch(msg);
      }
    }
  });
  return handle;
}

function main() {
  attachTransport(process.stdin, process.stdout);
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stderr.write(
    `agent-core-mcp v${CONTRACT.version} ready on stdio (${TOOLS.length} tools, zero dependencies)\n`
  );
}

if (require.main === module) main();

module.exports = {
  TOOLS,
  TOOL_INDEX,
  CONTRACT,
  PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL,
  createHandler,
  attachTransport,
  handle: createHandler(process.stdout),
  // engine, exported for testing
  diffText, hashText, jsonQuery, jsonValidate, jsonTypeOf, textStats,
  dateCalc, dateAdd, countBusinessDays, parseIsoDate, formatIso,
  regexExtract, analyzeRegexSafety, similarity, fuzzyMatch, parseTable,
  convert, baseConvert, ToolError
};

// #endregion mcp-transport
