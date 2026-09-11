/**
 * selftest.js — zero-dependency verification of the deterministic engine.
 *
 * Runs on plain Node (>=18) with no npm install required, because the sandbox
 * has no outbound network. This mirrors the logic in src/tools.ts exactly;
 * if a case fails here, the same case is broken in the TypeScript source.
 *
 * Run:  node selftest.js
 */

import { createHash, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    process.stdout.write(`  FAIL ${name}\n         ${e && e.message ? e.message : String(e)}\n`);
  }
}

// ---------------------------------------------------------------------------
// mirror of src/tools.ts (deterministic core, no external deps)
// ---------------------------------------------------------------------------

function bigramCounts(s) {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    out.set(bg, (out.get(bg) ?? 0) + 1);
  }
  return out;
}

function similarity(a, b) {
  if (a === b) return 1;
  const A = bigramCounts(a);
  const B = bigramCounts(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [bg, ca] of A) {
    const cb = B.get(bg);
    if (cb !== undefined) overlap += Math.min(ca, cb);
  }
  let total = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  return Math.round((2 * overlap / total) * 10000) / 10000;
}

function parsePath(path) {
  const cleaned = path.replace(/^\$\.?/, '');
  if (cleaned === '') return [];
  const segs = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1] !== undefined) segs.push(m[1]);
    else if (m[2] !== undefined) segs.push(Number(m[2]));
  }
  return segs;
}

function jsonQuery(doc, path) {
  const segs = parsePath(path);
  let cur = doc;
  for (const s of segs) {
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
  return { found: cur !== null && cur !== undefined, resolved: true, value: cur };
}

function baseConvert(value, fromBase, toBase) {
  const cleaned = value.trim().replace(/^0[bxo]/i, '').toLowerCase();
  if (!/^[0-9a-z]+$/.test(cleaned)) throw new Error('not a valid integer');
  let dec = 0n;
  const bigBase = BigInt(fromBase);
  for (const ch of cleaned) {
    const digit = parseInt(ch, 36);
    if (digit >= fromBase) throw new Error(`digit ${ch} invalid in base ${fromBase}`);
    dec = dec * bigBase + BigInt(digit);
  }
  return { result: dec.toString(toBase), decimal: dec.toString(10) };
}

const UNITS = {
  m: { toBase: 1, kind: 'length' }, km: { toBase: 1000, kind: 'length' },
  cm: { toBase: 0.01, kind: 'length' }, mm: { toBase: 0.001, kind: 'length' },
  mi: { toBase: 1609.344, kind: 'length' }, yd: { toBase: 0.9144, kind: 'length' },
  ft: { toBase: 0.3048, kind: 'length' }, in: { toBase: 0.0254, kind: 'length' },
  nmi: { toBase: 1852, kind: 'length' },
  kg: { toBase: 1, kind: 'mass' }, g: { toBase: 0.001, kind: 'mass' },
  mg: { toBase: 1e-6, kind: 'mass' }, t: { toBase: 1000, kind: 'mass' },
  lb: { toBase: 0.45359237, kind: 'mass' }, oz: { toBase: 0.028349523125, kind: 'mass' },
  s: { toBase: 1, kind: 'time' }, min: { toBase: 60, kind: 'time' },
  h: { toBase: 3600, kind: 'time' }, d: { toBase: 86400, kind: 'time' },
  b: { toBase: 1, kind: 'data' }, kb: { toBase: 1000, kind: 'data' },
  mb: { toBase: 1e6, kind: 'data' }, gb: { toBase: 1e9, kind: 'data' },
  kib: { toBase: 1024, kind: 'data' }, mib: { toBase: 1048576, kind: 'data' },
  gib: { toBase: 1073741824, kind: 'data' }
};

function convert(from, to, value) {
  const f = UNITS[from.toLowerCase()];
  const t = UNITS[to.toLowerCase()];
  if (!f) throw new Error(`unknown source unit ${from}`);
  if (!t) throw new Error(`unknown target unit ${to}`);
  if (f.kind !== t.kind) throw new Error(`cannot convert ${f.kind} to ${t.kind}`);
  return Math.round(((value * f.toBase) / t.toBase) * 1e10) / 1e10;
}

function parseTable(text, delimiter) {
  let delim = delimiter;
  if (!delim) {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const candidates = [',', '\t', ';', '|'];
    let best = ',';
    let bestCount = -1;
    for (const c of candidates) {
      const n = firstLine.split(c).length - 1;
      if (n > bestCount) { bestCount = n; best = c; }
    }
    delim = best;
  }
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) pushField();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; pushRow(); }
    else field += ch;
  }
  if (field !== '' || row.length > 0) pushRow();
  const header = rows.shift() ?? null;
  return { header, rows };
}

function analyzeRegexSafety(pattern) {
  const reasons = [];
  let risk = 'low';
  const bump = (level, why) => {
    reasons.push(why);
    if (level === 'high' || risk === 'high') risk = 'high';
    else risk = 'medium';
  };
  if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(pattern)) bump('high', 'nested quantifier');
  if (/\([^()]*\|[^()]*\)\s*[+*]/.test(pattern)) bump('medium', 'alternation in repeated group');
  const wildcards = (pattern.match(/\.\*/g) ?? []).length;
  if (wildcards >= 3) bump('medium', 'many wildcards');
  if (/\\[1-9]/.test(pattern) && /\([^()]*\)\s*[+*{]/.test(pattern)) bump('medium', 'backreference');
  return { risk, reasons };
}

function textStats(text) {
  const chars = [...text].length;
  const lines = text.split('\n');
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  return { chars, lines: lines.length, words: words.length };
}

// ---------------------------------------------------------------------------
// unit tests
// ---------------------------------------------------------------------------

process.stdout.write('\nagent-core-mcp deterministic engine — selftest\n\n');

process.stdout.write('hash\n');
test('sha256 of empty string is the known constant', () => {
  const h = createHash('sha256').update('', 'utf8').digest('hex');
  assert.equal(h, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('sha256 of "abc" is the known constant', () => {
  const h = createHash('sha256').update('abc', 'utf8').digest('hex');
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('hmac differs from plain digest', () => {
  const plain = createHash('sha256').update('x').digest('hex');
  const mac = createHmac('sha256', 'k').update('x').digest('hex');
  assert.notEqual(plain, mac);
});
test('unicode byte length differs from code point count', () => {
  const s = 'héllo→世界';
  assert.notEqual(Buffer.byteLength(s, 'utf8'), [...s].length);
});

process.stdout.write('\nbase_convert\n');
test('255 decimal to hex is ff', () => {
  assert.equal(baseConvert('255', 10, 16).result, 'ff');
});
test('binary 11111111 to decimal is 255', () => {
  assert.equal(baseConvert('11111111', 2, 10).result, '255');
});
test('big integer beyond 2^53 stays exact', () => {
  const big = '9007199254740993'; // 2^53 + 1, not representable as a double
  const hex = baseConvert(big, 10, 16).result;
  assert.equal(hex, '20000000000001');
  assert.equal(BigInt('0x' + hex).toString(10), big);
});
test('2^64 exact round trip', () => {
  const v = '18446744073709551616';
  assert.equal(BigInt('0x' + baseConvert(v, 10, 16).result).toString(10), v);
});
test('invalid digit for base is rejected', () => {
  assert.throws(() => baseConvert('2', 2, 10), /invalid in base 2/);
});

process.stdout.write('\nconvert\n');
test('1 mile = 1609.344 m', () => assert.equal(convert('mi', 'm', 1), 1609.344));
test('1 kg = 2.20462262 lb (rounded)', () => {
  assert.equal(convert('kg', 'lb', 1), 2.2046226218);
});
test('1 GiB = 1073741824 B', () => assert.equal(convert('gib', 'b', 1), 1073741824));
test('cross-family conversion is refused', () => {
  assert.throws(() => convert('kg', 'm', 1), /cannot convert/);
});
test('unknown unit is refused', () => assert.throws(() => convert('furlong', 'm', 1), /unknown source/));

process.stdout.write('\nsimilarity\n');
test('identical strings score 1', () => assert.equal(similarity('abc', 'abc'), 1));
test('disjoint strings score 0', () => assert.equal(similarity('abc', 'xyz'), 0));
test('close typos score high', () => {
  const s = similarity('kubernetes', 'kubernetse');
  assert.ok(s > 0.6, `expected > 0.6, got ${s}`);
});
test('single character has no bigrams and scores 0 against a word', () => {
  assert.equal(similarity('a', 'abc'), 0);
});

process.stdout.write('\njson_query\n');
const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, nul: null, s: 'x' };
test('dotted path resolves', () => assert.equal(jsonQuery(doc, 'a.b[1].c').value, 2));
test('leading $. is tolerated', () => assert.equal(jsonQuery(doc, '$.s').value, 'x'));
test('missing path reports not found', () => assert.equal(jsonQuery(doc, 'a.z').found, false));
test('present-but-null is distinguishable from absent', () => {
  const present = jsonQuery(doc, 'nul');
  assert.equal(present.resolved, true);
  assert.equal(present.found, false);
  assert.equal(present.value, null);

  const absent = jsonQuery(doc, 'nope');
  assert.equal(absent.resolved, false);
  assert.equal(absent.type, 'missing-key');
});
test('array index past the end is reported as out-of-range', () => {
  assert.equal(jsonQuery(doc, 'a.b[9]').type, 'out-of-range');
});
test('indexing a non-array is refused cleanly', () => {
  assert.equal(jsonQuery(doc, 's[0]').type, 'not-an-array');
});

process.stdout.write('\nparse_table\n');
test('quoted field with embedded comma', () => {
  const r = parseTable('a,b\n"x,y",z\n');
  assert.deepEqual(r.rows[0], ['x,y', 'z']);
});
test('escaped double quote', () => {
  const r = parseTable('a,b\n"he said ""hi""",z\n');
  assert.deepEqual(r.rows[0], ['he said "hi"', 'z']);
});
test('embedded newline inside quotes stays in one field', () => {
  const r = parseTable('a,b\n"line1\nline2",z\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0][0], 'line1\nline2');
});
test('CRLF line endings handled', () => {
  const r = parseTable('a,b\r\n1,2\r\n');
  assert.deepEqual(r.rows[0], ['1', '2']);
});
test('tab delimiter auto-detected', () => {
  const r = parseTable('a\tb\tc\n1\t2\t3\n');
  assert.deepEqual(r.header, ['a', 'b', 'c']);
});
test('semicolon delimiter auto-detected', () => {
  const r = parseTable('a;b;c\n1;2;3\n');
  assert.deepEqual(r.header, ['a', 'b', 'c']);
});

process.stdout.write('\nregex safety\n');
test('(a+)+ is flagged high risk', () => {
  assert.equal(analyzeRegexSafety('(a+)+').risk, 'high');
});
test('plain pattern is low risk', () => {
  assert.equal(analyzeRegexSafety('^[a-z]+$').risk, 'low');
});
test('alternation in repeated group is medium risk', () => {
  assert.equal(analyzeRegexSafety('(a|ab)+').risk, 'medium');
});

process.stdout.write('\ntext_stats\n');
test('unicode words counted not bytes', () => {
  const r = textStats('hello 世界');
  assert.equal(r.words, 2);
});
test('code points not UTF-16 units', () => {
  const r = textStats('😀');
  assert.equal(r.chars, 1);
});

process.stdout.write('\n');
process.stdout.write(`passed ${passed}, failed ${failed}\n`);
if (failed > 0) {
  process.stdout.write('\nFAILURES:\n');
  for (const f of failures) {
    process.stdout.write(`- ${f.name}\n`);
  }
  process.exit(1);
}
process.stdout.write('all deterministic checks passed\n');
