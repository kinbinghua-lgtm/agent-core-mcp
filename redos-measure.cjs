#!/usr/bin/env node
/**
 * redos-measure.cjs — reproduce the catastrophic-backtracking measurements
 * quoted in the write-up, so a reader can verify every number themselves.
 *
 * Runs each n in a CHILD PROCESS. That is not incidental: without isolation a
 * single unlucky n hangs this script forever, which is the entire point of the
 * article. The parent kills any child that exceeds the budget and reports that
 * as the result.
 *
 * Run:  node redos-measure.cjs
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PATTERN = '(a+)+$';
const BUDGET_MS = 5000;
const NS = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 40];

const CHILD_SRC = `
  // argv[0] is the executable and argv[1] is the first user argument when node
  // runs with -e. Indexing from 2 (the convention for a script file) silently
  // yields undefined, which Number() turns into NaN, which makes
  // 'a'.repeat(NaN) an empty string — and every measurement comes back as 0ms.
  // That mistake produced a table of entirely fictional numbers before it was
  // caught by comparing against an in-process run.
  const n = Number(process.argv[1]);
  const pattern = process.argv[2];
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write('bad n: ' + JSON.stringify(process.argv.slice(1)) + '\\n');
    process.exit(3);
  }
  const text = 'a'.repeat(n) + '!';
  const t0 = process.hrtime.bigint();
  new RegExp(pattern).exec(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(String(ms));
`;

function measureOne(n) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SRC, String(n), PATTERN], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ n, ms: null, killed: true });
    }, BUDGET_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Number(out);
      resolve({
        n,
        ms: Number.isFinite(ms) ? ms : null,
        killed: false,
        exitCode: code,
        stderr: err.trim()
      });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ n, ms: null, killed: false, error: true });
    });
  });
}

/** Sanity gate: refuse to print a table built on a broken harness. */
async function selfCheck() {
  // A trivial pattern must take a measurable, non-zero, small amount of time.
  const trivial = await measureOneProbe('a'.repeat(20) + '!', 'a', 2000);
  if (trivial.ms === null) {
    throw new Error('harness self-check failed: trivial pattern did not return');
  }
  // A known-catastrophic small case must be clearly slower than the trivial one.
  // Being killed by the budget counts as "much slower" — that is the expected
  // outcome once the arguments actually reach the child.
  const catast = await measureOneProbe('a'.repeat(24) + '!', PATTERN, 3000);
  if (!catast.killed && (catast.ms === null || catast.ms <= trivial.ms * 10)) {
    throw new Error(
      `harness self-check failed: trivial=${trivial.ms}ms catastrophic=${catast.ms}ms — ` +
        `the catastrophic case must be dramatically slower, or the child args are not reaching the test`
    );
  }
  return { trivial: trivial.ms, catastrophic: catast.killed ? 'killed (slower than budget)' : `${catast.ms.toFixed(1)}ms` };
}

function measureOneProbe(text, pattern, budget) {
  const n = Math.max(0, text.length - 1); // strip the trailing '!' the child re-adds
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SRC, String(n), pattern], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ms: null, killed: true });
    }, budget || BUDGET_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.trim()) return resolve({ ms: null, killed: false, stderr: err.trim() });
      resolve({ ms: Number.isFinite(Number(out)) ? Number(out) : null, killed: false });
    });
  });
}

(async function main() {
  console.log(`\nCatastrophic backtracking: /${PATTERN}/ against 'a'.repeat(n) + '!'`);
  console.log(`node ${process.version} | V8 ${process.versions.v8}\n`);

  console.log('harness self-check...');
  let check;
  try {
    check = await selfCheck();
  } catch (e) {
    console.error(`\nABORTING: ${e.message}`);
    console.error('Refusing to print a table that may be measuring nothing.');
    process.exit(2);
  }
  console.log(`  trivial pattern: ${check.trivial.toFixed(2)}ms`);
  console.log(`  catastrophic n=24: ${check.catastrophic}`);
  console.log('  harness is measuring real work\n');

  console.log(`budget per measurement: ${BUDGET_MS}ms (child killed on expiry)\n`);
  console.log('     n |        time | growth vs previous');
  console.log('  -----+-------------+---------------------');

  let prev = null;
  let prevN = null;

  for (const n of NS) {
    const r = await measureOne(n);
    let timeText;
    let growth = '';
    if (r.killed) {
      timeText = `>${BUDGET_MS}ms killed`;
      growth = 'did not finish';
    } else if (r.ms === null) {
      timeText = 'error';
      growth = r.stderr || '';
    } else {
      timeText = `${r.ms.toFixed(1)}ms`;
      if (prev !== null && prevN !== null) {
        const factor = r.ms / Math.max(prev, 0.05);
        const steps = (n - prevN) / 2;
        growth = `x${factor.toFixed(1)} per ${steps} step(s)`;
      }
      prev = r.ms;
      prevN = n;
    }
    console.log(`  ${String(n).padStart(4)} | ${timeText.padStart(11)} | ${growth}`);
  }

  console.log('\nReading: time roughly quadruples for every 2 characters added.');
  console.log('Why it matters for MCP servers: the pattern runs on the client\'s main');
  console.log('thread and the regex engine has no timeout, so one tool call is enough');
  console.log('to freeze the whole session. Isolation plus a kill is the only real');
  console.log('boundary.');
})();
