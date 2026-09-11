#!/usr/bin/env node
/**
 * protocol-test.cjs — end-to-end verification of the MCP protocol layer.
 *
 * Drives the real message handler through a fake transport. The handler is async
 * (regex execution runs in a worker thread with a deadline), so this harness waits
 * for frames to arrive rather than assuming synchronous replies.
 *
 * Run:  node protocol-test.cjs
 */

'use strict';

const { EventEmitter } = require('events');
const assert = require('assert');
const crypto = require('crypto');

const server = require('./server.cjs');
const { attachTransport, TOOLS } = server;

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`         ${e && e.message ? e.message : String(e)}`);
  }
}

const frames = [];
function makeSink() {
  let buf = '';
  return {
    raw: [],
    write(s) {
      const str = String(s);
      this.raw.push(str);
      buf += str;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line !== '') frames.push(JSON.parse(line));
      }
      return true;
    }
  };
}
function makeSource() {
  const s = new EventEmitter();
  s.setEncoding = () => s;
  return s;
}

const sink = makeSink();
const source = makeSource();
attachTransport(source, sink);

let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    const found = frames.find((f) => f && f.id === id);
    if (found) return found;
    await sleep(8);
  }
  throw new Error(`timeout waiting for response id=${id}`);
}

function send(method, params) {
  const id = ++seq;
  source.emit('data', JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}

async function request(method, params) {
  return waitFor(send(method, params));
}

async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  assert.ok(res.result, `no result for ${name}: ${JSON.stringify(res)}`);
  assert.ok(!res.result.isError, `${name} errored: ${res.result.content[0].text}`);
  return JSON.parse(res.result.content[0].text);
}

async function callError(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  assert.ok(res.result, `expected a result envelope for ${name}`);
  assert.strictEqual(res.result.isError, true, `${name} should have failed but did not`);
  return res.result.content[0].text;
}

(async function main() {
  console.log('\nagent-core-mcp \u2014 protocol test (in-process transport)\n');

  console.log('-- handshake --');
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'protocol-test', version: '1.0.0' }
  });
  await check('initialize returns a result', () => assert.ok(init.result));
  await check('server identifies itself', () => assert.strictEqual(init.result.serverInfo.name, 'agent-core-mcp'));
  await check('negotiates the requested protocol version', () =>
    assert.strictEqual(init.result.protocolVersion, '2025-06-18'));
  await check('declares tools and resources capabilities', () => {
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.resources);
  });
  await check('ships usage instructions', () => assert.ok(/Deterministic/.test(init.result.instructions)));
  await check('unknown protocol version falls back', async () => {
    const r = await request('initialize', { protocolVersion: '1999-01-01' });
    assert.ok(server.PROTOCOL_VERSIONS.indexOf(r.result.protocolVersion) !== -1);
  });
  await check('newest advertised version is the 2026-07-28 spec', () =>
    assert.strictEqual(server.PROTOCOL_VERSIONS[0], '2026-07-28'));
  await check('notifications produce no response', async () => {
    const before = frames.length;
    source.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    await sleep(60);
    assert.strictEqual(frames.length, before);
  });

  console.log('-- tools/list --');
  const list = await request('tools/list', {});
  await check('returns an array of tools', () => assert.ok(Array.isArray(list.result.tools)));
  await check('exposes exactly 15 tools', () => assert.strictEqual(list.result.tools.length, 15));
  await check('tool names are unique', () => {
    const seen = new Set();
    for (const t of list.result.tools) {
      assert.ok(!seen.has(t.name), `duplicate: ${t.name}`);
      seen.add(t.name);
    }
  });
  await check('every tool has a substantive description', () => {
    for (const t of list.result.tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 40, `short: ${t.name}`);
    }
  });
  await check('every tool has an object inputSchema', () => {
    for (const t of list.result.tools) assert.strictEqual(t.inputSchema.type, 'object', t.name);
  });
  await check('every tool is annotated read-only', () => {
    for (const t of list.result.tools) assert.strictEqual(t.annotations.readOnlyHint, true, t.name);
  });
  await check('every tool is annotated as not open-world', () => {
    for (const t of list.result.tools) assert.strictEqual(t.annotations.openWorldHint, false, t.name);
  });
  await check('every tool is annotated non-destructive', () => {
    for (const t of list.result.tools) assert.strictEqual(t.annotations.destructiveHint, false, t.name);
  });

  console.log('-- tools/call: correctness --');
  await check('hash("abc") equals the published sha256 constant', async () => {
    const r = await call('hash', { text: 'abc' });
    assert.strictEqual(r.hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  await check('hash reports UTF-8 bytes, not code points', async () =>
    assert.strictEqual((await call('hash', { text: '\u4e16\u754c' })).bytes, 6));
  await check('hash supports HMAC', async () => {
    const a = await call('hash', { text: 'x' });
    const b = await call('hash', { text: 'x', hmacKey: 'k' });
    assert.notStrictEqual(a.hex, b.hex);
  });
  await check('diff_text counts added/removed/unchanged exactly', async () => {
    const d = await call('diff_text', { a: 'one\ntwo\nthree', b: 'one\n2\nthree' });
    assert.strictEqual(d.added, 1);
    assert.strictEqual(d.removed, 1);
    assert.strictEqual(d.unchanged, 2);
  });
  await check('diff_text carries line numbers', async () => {
    const d = await call('diff_text', { a: 'one\ntwo', b: 'one\n2' });
    assert.strictEqual(d.lines.find((l) => l.op === 'ins').bLine, 2);
  });
  await check('base_convert keeps precision past 2^53', async () =>
    assert.strictEqual((await call('base_convert', { value: '9007199254740993', fromBase: 10, toBase: 16 })).result,
      '20000000000001'));
  await check('base_convert round-trips 2^64 exactly', async () => {
    const v = '18446744073709551616';
    const hex = (await call('base_convert', { value: v, fromBase: 10, toBase: 16 })).result;
    assert.strictEqual((await call('base_convert', { value: hex, fromBase: 16, toBase: 10 })).result, v);
  });
  await check('json_query resolves a nested array index', async () =>
    assert.strictEqual((await call('json_query', { json: '{"a":{"b":[1,2,3]}}', path: 'a.b[2]' })).value, 3));
  await check('json_query distinguishes present-but-null from absent', async () => {
    const r = await call('json_query', { json: '{"a":null}', path: 'a' });
    assert.strictEqual(r.resolved, true);
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.type, 'null');
  });
  await check('json_query labels a missing key', async () =>
    assert.strictEqual((await call('json_query', { json: '{"a":1}', path: 'zz' })).type, 'missing-key'));
  await check('json_query labels an out-of-range index', async () =>
    assert.strictEqual((await call('json_query', { json: '[1,2]', path: '[9]' })).type, 'out-of-range'));
  await check('json_pick resolves several paths at once', async () => {
    const r = await call('json_pick', { json: '{"a":1,"b":{"c":2}}', paths: ['a', 'b.c', 'zz'] });
    assert.strictEqual(r.results.a.value, 1);
    assert.strictEqual(r.results['b.c'].value, 2);
    assert.strictEqual(r.results.zz.resolved, false);
  });
  await check('json_validate accepts valid JSON and describes it', async () => {
    const r = await call('json_validate', { text: '{"a":1,"b":2}' });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.shape.keys, ['a', 'b']);
  });
  await check('json_validate reports the error line', async () => {
    const r = await call('json_validate', { text: '{\n  "a": 1,\n  bad\n}' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.line >= 1, `line was ${r.line}`);
  });
  await check('text_stats counts words exactly', async () =>
    assert.strictEqual((await call('text_stats', { text: 'one two two three' })).words, 4));
  await check('text_stats ranks the most frequent word first', async () => {
    const r = await call('text_stats', { text: 'alpha beta beta gamma' });
    assert.strictEqual(r.topWords[0].word, 'beta');
    assert.strictEqual(r.topWords[0].count, 2);
  });
  await check('text_stats counts code points, not UTF-16 units', async () =>
    assert.strictEqual((await call('text_stats', { text: '\u{1F600}' })).chars, 1));
  await check('date_calc handles a non-leap February', async () =>
    assert.strictEqual((await call('date_calc', { from: '2026-01-01', to: '2026-03-01', unit: 'days' })).value, 59));
  await check('date_calc handles a leap February', async () =>
    assert.strictEqual((await call('date_calc', { from: '2024-01-01', to: '2024-03-01', unit: 'days' })).value, 60));
  await check('date_calc uses true calendar months', async () =>
    assert.strictEqual((await call('date_calc', { from: '2026-01-01', to: '2026-02-01', unit: 'months' })).value, 1));
  await check('date_calc counts business days across a weekend', async () =>
    assert.strictEqual((await call('date_calc', { from: '2026-01-05', to: '2026-01-12', unit: 'businessDays' })).value, 5));
  await check('date_calc reports a negative interval', async () =>
    assert.strictEqual((await call('date_calc', { from: '2026-03-01', to: '2026-01-01', unit: 'days' })).sign, -1));
  await check('date_add rolls a leap day correctly', async () =>
    assert.strictEqual((await call('date_add', { date: '2024-02-29', amount: 1, unit: 'years' })).result, '2025-03-01T00:00:00Z'));
  await check('date_add subtracts with a negative amount', async () =>
    assert.strictEqual((await call('date_add', { date: '2026-01-10', amount: -10, unit: 'days' })).result, '2025-12-31T00:00:00Z'));
  await check('regex_extract returns every match', async () =>
    assert.strictEqual((await call('regex_extract', { text: 'a1 b22 c333', pattern: '([a-z])(\\d+)' })).count, 3));
  await check('regex_extract returns numbered groups', async () => {
    const r = await call('regex_extract', { text: 'a1 b22 c333', pattern: '([a-z])(\\d+)' });
    assert.deepStrictEqual(r.matches[1].groups, ['b', '22']);
  });
  await check('regex_extract names capture groups', async () =>
    assert.strictEqual((await call('regex_extract', { text: 'year=2026', pattern: 'year=(?<y>\\d+)' })).matches[0].named.y, '2026'));
  await check('regex_analyze flags nested quantifiers as high risk', async () =>
    assert.strictEqual((await call('regex_analyze', { pattern: '(a+)+$' })).risk, 'high'));
  await check('regex_analyze clears a simple pattern', async () =>
    assert.strictEqual((await call('regex_analyze', { pattern: '^[a-z]+$' })).risk, 'low'));
  await check('regex_analyze flags overlapping alternation', async () =>
    assert.strictEqual((await call('regex_analyze', { pattern: '(a|ab)+' })).risk, 'medium'));
  await check('fuzzy_match ranks the near-miss first', async () => {
    const r = await call('fuzzy_match', { needle: 'kubernetes', haystack: ['docker', 'kubernetse', 'linux'] });
    assert.strictEqual(r.results[0].value, 'kubernetse');
  });
  await check('fuzzy_match honours the threshold', async () =>
    assert.strictEqual((await call('fuzzy_match', { needle: 'abc', haystack: ['abc', 'zzz'], threshold: 0.9 })).results.length, 1));
  await check('similarity of identical strings is 1', async () =>
    assert.strictEqual((await call('similarity', { a: 'abc', b: 'abc' })).score, 1));
  await check('similarity of disjoint strings is 0', async () =>
    assert.strictEqual((await call('similarity', { a: 'abc', b: 'xyz' })).score, 0));
  await check('parse_table respects a quoted delimiter', async () =>
    assert.deepStrictEqual((await call('parse_table', { text: 'name,city\n"Smith, John",Berlin\n' })).rows[0], ['Smith, John', 'Berlin']));
  await check('parse_table unescapes doubled quotes', async () =>
    assert.strictEqual((await call('parse_table', { text: 'a\n"he said ""hi"""\n' })).rows[0][0], 'he said "hi"'));
  await check('parse_table keeps embedded newlines inside quotes', async () => {
    const r = await call('parse_table', { text: 'a,b\n"l1\nl2",z\n' });
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0][0], 'l1\nl2');
  });
  await check('parse_table auto-detects a tab delimiter', async () =>
    assert.deepStrictEqual((await call('parse_table', { text: 'a\tb\n1\t2\n' })).header, ['a', 'b']));
  await check('convert handles an exact imperial factor', async () =>
    assert.strictEqual((await call('convert', { value: 1, from: 'mi', to: 'm' })).result, 1609.344));
  await check('convert handles binary data units', async () =>
    assert.strictEqual((await call('convert', { value: 1, from: 'gib', to: 'b' })).result, 1073741824));

  console.log('-- the ReDoS boundary (the critical safety property) --');
  await check('a catastrophic pattern is terminated, not hung', async () => {
    const t0 = Date.now();
    const r = await call('regex_extract', {
      text: 'a'.repeat(40) + '!',
      pattern: '(a+)+$',
      maxMatches: 5,
      budgetMs: 300
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.timedOut, true, `expected a timeout, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(elapsed < 4000, `took ${elapsed}ms; the deadline did not hold`);
    assert.ok(typeof r.advice === 'string' && r.advice.length > 20, 'no remediation advice returned');
  });
  await check('a safe pattern still returns real matches on the same input shape', async () => {
    const r = await call('regex_extract', { text: 'a'.repeat(40) + '!', pattern: 'a+', maxMatches: 5, budgetMs: 1000 });
    assert.strictEqual(r.timedOut, false);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.matches[0].match.length, 40);
  });
  await check('the response flags whether execution was time-bounded', async () => {
    const r = await call('regex_extract', { text: 'abc', pattern: 'b' });
    assert.strictEqual(r.guarded, true);
    assert.strictEqual(r.timedOut, false);
  });
  await check('a budget above the schema maximum is refused outright', async () =>
    assert.ok(/must be <= 10000/.test(
      await callError('regex_extract', { text: 'aaaa!', pattern: '(a+)+$', budgetMs: 999999 }))));
  await check('the deadline is honoured at a tight budget', async () => {
    const t0 = Date.now();
    const r = await call('regex_extract', { text: 'a'.repeat(36) + '!', pattern: '(a+)+$', budgetMs: 200 });
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.budgetMs, 200);
    assert.ok(Date.now() - t0 < 3000, 'the 200ms budget did not hold');
  });
  await check('a successfully guarded call reports its budget and no timeout', async () => {
    const r = await call('regex_extract', { text: 'abc', pattern: 'b', budgetMs: 500 });
    assert.strictEqual(r.guarded, true);
    assert.strictEqual(r.timedOut, false);
    assert.strictEqual(r.budgetMs, 500);
  });

  console.log('-- error handling --');
  await check('malformed JSON argument is a tool error, not a crash', async () =>
    assert.ok((await callError('json_query', { json: '{oops', path: 'a' })).startsWith('Error:')));
  await check('an unknown tool name is reported cleanly', async () =>
    assert.ok(/unknown tool/.test(await callError('no_such_tool', {}))));
  await check('a cross-family conversion is refused', async () =>
    assert.ok(/cannot convert/.test(await callError('convert', { value: 1, from: 'kg', to: 'm' }))));
  await check('an unknown unit names the unit', async () =>
    assert.ok(/unknown source unit/.test(await callError('convert', { value: 1, from: 'furlong', to: 'm' }))));
  await check('an invalid date carries a field-specific message', async () =>
    assert.ok(/invalid from date/.test(await callError('date_calc', { from: 'nope', to: '2026-01-01' }))));
  await check('diff_text refuses oversized input', async () =>
    assert.ok(/too large for exact diff/.test(
      await callError('diff_text', { a: 'x\n'.repeat(2100), b: 'x\n'.repeat(2100) + 'y' }))));
  await check('a missing required argument errors rather than defaulting', async () => {
    const res = await request('tools/call', { name: 'json_query', arguments: { json: '{}' } });
    assert.strictEqual(res.result.isError, true);
    assert.ok(/missing required argument "path"/.test(res.result.content[0].text), res.result.content[0].text);
  });
  await check('a wrong argument type is rejected before dispatch', async () =>
    assert.ok(/must be a string/.test(await callError('json_query', { json: '{}', path: 42 }))));
  await check('an unknown argument is rejected', async () =>
    assert.ok(/unknown argument/.test(await callError('similarity', { a: 'x', b: 'y', c: 'z' }))));
  await check('an out-of-range numeric argument is rejected', async () =>
    assert.ok(/must be <=/.test(await callError('fuzzy_match', { needle: 'a', haystack: ['a'], topN: 99999 }))));
  await check('an out-of-enum argument is rejected', async () =>
    assert.ok(/must be one of/.test(await callError('date_calc', { from: '2026-01-01', to: '2026-01-02', unit: 'fortnights' }))));
  await check('tools/call without a name returns -32602', async () => {
    const res = await request('tools/call', { arguments: {} });
    assert.strictEqual(res.error.code, -32602);
  });
  await check('an unknown method returns -32601', async () => {
    const res = await request('no/such/method', {});
    assert.strictEqual(res.error.code, -32601);
  });

  console.log('-- transport robustness --');
  await check('a malformed frame yields -32700 and keeps serving', async () => {
    const before = frames.length;
    source.emit('data', 'this is not json\n');
    await sleep(60);
    const added = frames.slice(before);
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].error.code, -32700);
    assert.ok((await request('ping', {})).result !== undefined);
  });
  await check('a frame split across two chunks is reassembled', async () => {
    const before = frames.length;
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 90001, method: 'ping', params: {} }) + '\n';
    const mid = Math.floor(frame.length / 2);
    source.emit('data', frame.slice(0, mid));
    await sleep(50);
    assert.strictEqual(frames.length, before, 'responded before the frame was complete');
    source.emit('data', frame.slice(mid));
    const res = await waitFor(90001);
    assert.ok(res.result !== undefined);
  });
  await check('a batch frame is handled', async () => {
    const id1 = ++seq, id2 = ++seq;
    source.emit('data', JSON.stringify([
      { jsonrpc: '2.0', id: id1, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: id2, method: 'ping', params: {} }
    ]) + '\n');
    await waitFor(id1);
    await waitFor(id2);
  });
  await check('blank lines are ignored', async () => {
    const before = frames.length;
    source.emit('data', '\n\n   \n');
    await sleep(50);
    assert.strictEqual(frames.length, before);
  });
  await check('every emitted frame is exactly one line', () => {
    for (const raw of sink.raw) {
      const parts = raw.split('\n');
      assert.strictEqual(parts[parts.length - 1], '', 'frame missing trailing newline');
      assert.strictEqual(parts.length, 2, 'frame contained an embedded newline');
    }
  });
  await check('concurrent requests are all answered and correctly correlated', async () => {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(send('tools/call', { name: 'hash', arguments: { text: 'c' + i } }));
    for (let i = 0; i < 8; i++) {
      const res = await waitFor(ids[i]);
      const payload = JSON.parse(res.result.content[0].text);
      assert.strictEqual(payload.hex, crypto.createHash('sha256').update('c' + i).digest('hex'), `mismatch at ${i}`);
    }
  });

  console.log('-- resources --');
  const rl = await request('resources/list', {});
  await check('resources/list exposes the contract resource', () =>
    assert.strictEqual(rl.result.resources[0].uri, 'agent-core://contract'));
  const rr = await request('resources/read', { uri: 'agent-core://contract' });
  await check('the contract states the no-network guarantee', () =>
    assert.ok(JSON.parse(rr.result.contents[0].text).guarantees.some((g) => /No network access/.test(g))));
  await check('the contract states no shell execution', () =>
    assert.ok(JSON.parse(rr.result.contents[0].text).nonGoals.some((g) => /shell/.test(g))));
  await check('the contract tool count matches the registry', () =>
    assert.strictEqual(JSON.parse(rr.result.contents[0].text).toolCount, TOOLS.length));
  await check('reading an unknown resource is refused', async () => {
    const res = await request('resources/read', { uri: 'agent-core://nope' });
    assert.strictEqual(res.error.code, -32602);
  });

  console.log('-- determinism --');
  await check('identical input produces byte-identical output', async () => {
    const args = { text: 'The quick brown fox jumps over the lazy dog. Second sentence here.' };
    const a = JSON.stringify(await call('text_stats', args));
    const b = JSON.stringify(await call('text_stats', args));
    assert.strictEqual(a, b);
  });
  await check('diff is stable across repeated calls', async () => {
    const args = { a: 'x\ny\nz', b: 'x\nY\nz' };
    assert.strictEqual(JSON.stringify(await call('diff_text', args)), JSON.stringify(await call('diff_text', args)));
  });

  console.log(`\npassed ${pass}, failed ${fail}`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`- ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
