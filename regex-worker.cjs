/**
 * regex-worker.cjs — runs one regex inside an isolated worker thread.
 *
 * Why this exists: Node's regex engine has no timeout. A pattern like (a+)+$
 * against a 40-character non-matching string runs for longer than the age of the
 * universe, and it runs on the main thread — which means a single tool call can
 * freeze the entire MCP client session.
 *
 * The only real boundary is a separate thread you can kill. So: execute here,
 * terminate on deadline, report honestly.
 *
 * Protocol:
 *   input : { text, pattern, flags, maxMatches }
 *   output: { ok: true, matches, count, truncated } | { ok: false, error }
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');

function run() {
  const { text, pattern, flags, maxMatches } = workerData;

  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    return { ok: false, error: `invalid regex: ${e && e.message ? e.message : String(e)}` };
  }

  const matches = [];
  let m;
  let iterations = 0;
  const iterationCap = Math.max(maxMatches * 10, 10000);

  while ((m = re.exec(text)) !== null) {
    if (++iterations > iterationCap) break;
    matches.push({
      match: m[0],
      index: m.index,
      groups: m.slice(1),
      named: m.groups ? Object.assign({}, m.groups) : {}
    });
    if (matches.length >= maxMatches) break;
    if (m[0] === '') re.lastIndex++;
  }

  return { ok: true, matches, count: matches.length, truncated: matches.length >= maxMatches };
}

try {
  parentPort.postMessage(run());
} catch (e) {
  parentPort.postMessage({ ok: false, error: `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : String(e)}` });
}
