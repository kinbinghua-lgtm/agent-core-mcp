#!/usr/bin/env node
/**
 * validate-server-json.cjs — check server.json against the published MCP registry
 * schema constraints, before a publish attempt wastes a round trip.
 *
 * The registry rejects the whole submission on the first violation, and the error
 * surfaces late. These checks are transcribed directly from
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 *
 * Run:  node validate-server-json.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

const file = path.join(__dirname, 'server.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const detail = fn();
    pass++;
    console.log(`  ok   ${name}${detail ? '  (' + detail + ')' : ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n         ${e && e.message ? e.message : e}`);
  }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\nserver.json validation\n');

// --- ServerDetail required fields -------------------------------------------
check('has a $schema pointing at the registry schema', () => {
  must(typeof doc.$schema === 'string', 'missing $schema');
  must(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\.json$/.test(doc.$schema), 'unexpected $schema host');
  return doc.$schema.split('/').pop();
});

check('name is reverse-DNS with exactly one slash', () => {
  must(typeof doc.name === 'string', 'missing name');
  must(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(doc.name), `name fails pattern: ${doc.name}`);
  must(doc.name.split('/').length === 2, 'name must contain exactly one slash');
  must(doc.name.length >= 3 && doc.name.length <= 200, `name length ${doc.name.length}`);
  return doc.name;
});

check('namespace matches the GitHub repository owner', () => {
  const ns = doc.name.split('/')[0];
  const owner = (doc.repository && doc.repository.url || '').replace(/^https:\/\/github\.com\//, '').split('/')[0];
  must(owner, 'no GitHub owner found in repository.url');
  must(ns === `io.github.${owner}`, `namespace "${ns}" must be "io.github.${owner}" for OIDC publishing to work`);
  return ns;
});

check('description is present and within the 100-character limit', () => {
  must(typeof doc.description === 'string' && doc.description.length >= 1, 'missing description');
  must(doc.description.length <= 100, `description is ${doc.description.length} chars, max is 100`);
  return `${doc.description.length} chars`;
});

// --- version consistency ----------------------------------------------------
check('version matches package.json exactly', () => {
  must(doc.version === pkg.version, `server.json ${doc.version} != package.json ${pkg.version}`);
  return doc.version;
});

check('version is not a range and not "latest"', () => {
  must(doc.version !== 'latest', 'version must be concrete');
  must(!/[\^~*x]|>=|<=/.test(doc.version), `version looks like a range: ${doc.version}`);
});

// --- packages ---------------------------------------------------------------
check('packages is a non-empty array', () => {
  must(Array.isArray(doc.packages) && doc.packages.length > 0, 'packages must be a non-empty array');
  return `${doc.packages.length} package(s)`;
});

check('every package has the three required fields', () => {
  doc.packages.forEach((p, i) => {
    must(p.registryType, `packages[${i}].registryType missing`);
    must(p.identifier, `packages[${i}].identifier missing`);
    must(p.transport, `packages[${i}].transport missing`);
  });
});

check('package identifier resolves to the real npm package name', () => {
  const p = doc.packages[0];
  must(p.registryType === 'npm', `registryType is "${p.registryType}", expected "npm"`);
  must(p.identifier === pkg.name, `identifier "${p.identifier}" != package name "${pkg.name}"`);
  return p.identifier;
});

check('package version matches the server version', () => {
  const p = doc.packages[0];
  must(p.version === doc.version, `package version ${p.version} != server version ${doc.version}`);
  must(p.version !== 'latest', 'package version must be concrete');
});

check('transport is stdio with no url required', () => {
  const t = doc.packages[0].transport;
  must(t.type === 'stdio', `transport type is "${t.type}"`);
});

check('runtimeHint is set because npx is the expected launcher', () => {
  must(doc.packages[0].runtimeHint === 'npx', `runtimeHint is "${doc.packages[0].runtimeHint}"`);
});

check('declares no environment variables (this is a selling point)', () => {
  const ev = doc.packages[0].environmentVariables;
  must(Array.isArray(ev) && ev.length === 0, 'must be an empty array: the server reads no configuration');
});

// --- repository -------------------------------------------------------------
check('repository has both url and source', () => {
  must(doc.repository, 'missing repository');
  must(doc.repository.url, 'repository.url missing');
  must(doc.repository.source, 'repository.source missing');
  must(doc.repository.source === 'github', 'source must be "github" for OIDC');
});

check('repository url is HTTPS and matches the declared namespace', () => {
  must(/^https:\/\/github\.com\//.test(doc.repository.url), `bad repo url: ${doc.repository.url}`);
  const owner = doc.repository.url.replace('https://github.com/', '').split('/')[0];
  const repo = doc.repository.url.replace('https://github.com/', '').split('/')[1];
  must(owner && repo, 'repository url must include owner and repo');
  return `${owner}/${repo}`;
});

// --- consistency with the npm tarball --------------------------------------
check('the binary declared in package.json exists on disk', () => {
  const bin = Object.values(pkg.bin || {})[0];
  must(bin, 'package.json declares no bin entry');
  must(fs.existsSync(path.join(__dirname, bin)), `bin target ${bin} not found`);
  return bin;
});

check('every file listed in package.json "files" exists', () => {
  const missing = (pkg.files || []).filter((f) => !fs.existsSync(path.join(__dirname, f)));
  must(missing.length === 0, `missing: ${missing.join(', ')}`);
  return `${pkg.files.length} entries`;
});

console.log(`\npassed ${pass}, failed ${fail}`);
if (fail > 0) {
  console.log('\nThe registry would reject this submission. Fix the failures above first.');
}
process.exit(fail > 0 ? 1 : 0);
