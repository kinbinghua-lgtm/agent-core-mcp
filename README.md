# agent-core-mcp

**Deterministic computation tools for AI agents.** Exact diffing, hashing, JSON querying, calendar arithmetic, regex extraction under a hard execution deadline, CSV parsing, similarity scoring and unit/base conversion — as an MCP server.

**Zero dependencies. No network. Read-only.**

---

## Why this exists

Language models are excellent at generating language and unreliable at **exact, reproducible mechanical computation**. That is not a capability gap — it is an architectural property. Asking a probabilistic system to count, diff, hash or do calendar math guarantees a certain rate of confident wrong answers.

This server moves those operations out of the model and into a deterministic engine.

**The result is not a better guess. It is a different category of answer: one that is exact and reproducible.**

There is a second reason, specific to the MCP ecosystem. The most-reported problems with published servers are credential exfiltration, undisclosed shell execution, dependency trees carrying known CVEs, and servers that hang the client. A server with no network, no credentials, no execution surface, and a bounding deadline on every operation cannot exhibit any of them.

## Guarantees

| Guarantee | Meaning |
|---|---|
| **Zero dependencies** | No `node_modules`. Nothing to audit, nothing to go stale, nothing to break. |
| **No network access** | Nothing here calls out. Not one request, ever. |
| **No credentials** | Reads no tokens, no API keys, no environment variables. |
| **Read-only** | No file writes, no shell execution, no state. Stateless per call. |
| **Deterministic** | Identical input produces byte-identical output. |
| **Bounded** | Every loop and result set is capped. Regex execution runs in a worker thread that is terminated on deadline, so no pattern can hang the client. |

The server publishes these as a machine-readable `contract` resource (`agent-core://contract`), so a client can verify what it is installing rather than trusting this file.

## Install

```bash
npx agent-core-mcp
```

No install step is required to run it. Requires Node.js 18 or newer.

## Configure

```json
{
  "mcpServers": {
    "agent-core": {
      "command": "npx",
      "args": ["-y", "agent-core-mcp"]
    }
  }
}
```

Works with Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Continue, Zed and any other MCP client. No API keys. No environment variables. Nothing to sign up for.

## Tools

| Tool | What it does | Why the model shouldn't do it itself |
|---|---|---|
| `diff_text` | Exact line diff (LCS) with line numbers and added/removed counts | Requires exact sequence alignment; refuses oversized input rather than hanging |
| `hash` | sha256 / sha512 / sha1 / md5 / HMAC, hex + base64 + UTF-8 byte length | Cannot be computed by inspection |
| `json_validate` | Validity plus the parser message **and computed line/column** | Pinpointing the error by eye is error-prone |
| `json_query` | Path access like `a.b[0].c`; separates *absent* from *present-but-null* | Conflating those two silently causes real bugs |
| `json_pick` | Resolve many paths in one call | Cheaper than N round trips |
| `text_stats` | Code points, UTF-8 bytes, lines, words, sentences, paragraphs, unique words, top words | Counting is precisely what probabilistic generation gets wrong |
| `date_calc` | Interval in days/weeks/months/years/hours/minutes/seconds/**businessDays** | True calendar months, not 30-day approximations |
| `date_add` | Offset a date, calendar-correct | Month-end and leap-year handling |
| `regex_extract` | All matches with indices, numbered and named groups, **under a hard deadline** | A catastrophic pattern is terminated instead of hanging |
| `regex_analyze` | Static ReDoS risk assessment of a pattern | Nested quantifiers, overlapping alternation, backreferences |
| `fuzzy_match` | Rank candidates by Sorensen-Dice similarity | Deterministic scoring instead of vibes |
| `similarity` | Single similarity score, 0..1 | — |
| `parse_table` | RFC 4180 CSV/TSV with quotes, escapes, embedded newlines; delimiter auto-detection | Naive comma-splitting breaks on any real CSV |
| `convert` | Length, mass, time, data size; rejects cross-family conversions | Unit errors are silent and catastrophic |
| `base_convert` | Bases 2-36 with **arbitrary precision** | Values above 2^53 lose precision in naive conversion |

## The ReDoS deadline

`regex_extract` accepts an optional `budgetMs` (default 1000, maximum 10000). Execution happens in a worker thread that is **terminated** when the deadline expires.

This is not a nicety. Node's regex engine cannot be interrupted, so a pattern with catastrophic backtracking blocks the main thread indefinitely. Measured growth for `(a+)+$` against `'a'.repeat(n) + '!'`:

| n | time |
|---|---|
| 20 | 18 ms |
| 22 | 70 ms |
| 24 | 276 ms |
| 26 | 1108 ms |

Roughly 4x per two additional characters. At n=40 it does not return. In an MCP server, which runs on the client's main thread, this freezes the user's editor. Process isolation plus termination is the only real boundary.

On expiry the response says so, and tells the caller how to fix the pattern:

```json
{
  "timedOut": true,
  "budgetMs": 300,
  "safety": {
    "risk": "high",
    "reasons": ["nested quantifier inside a repeated group — classic exponential backtracking"]
  },
  "advice": "Pattern execution exceeded 300ms and was terminated. ... Rewrite it to remove ambiguity — typically by replacing a nested quantifier such as (a+)+ with an unambiguous form such as a+ ..."
}
```

## Argument validation

Every call is validated against the tool's own JSON Schema before dispatch: required fields, primitive types, enum membership, numeric bounds and unknown properties. A malformed call returns a specific error instead of a confident wrong answer.

This matters because clients do not reliably honour schemas. A server that silently proceeds on a malformed call is worse than one that refuses it.

## Examples

**Exact diff**

```json
{ "a": "line one\nline two", "b": "line one\nline 2" }
```
→ `{ "added": 1, "removed": 1, "lines": [ { "op": "equal", "aLine": 1, "bLine": 1 }, ... ] }`

**Big-integer conversion that stays exact**

```json
{ "value": "9007199254740993", "fromBase": 10, "toBase": 16 }
```
→ `{ "result": "20000000000001", "decimal": "9007199254740993" }`

**Business days between two dates**

```json
{ "from": "2026-01-05", "to": "2026-01-12", "unit": "businessDays" }
```
→ `{ "value": 5 }`

**Check a pattern before running it**

```json
{ "pattern": "(a+)+$" }
```
→ `{ "risk": "high", "reasons": ["nested quantifier inside a repeated group — classic exponential backtracking"] }`

**Absent versus null**

```json
{ "json": "{\"a\":null}", "path": "a" }
```
→ `{ "resolved": true, "found": false, "value": null, "type": "null" }`

## Design notes

**Why stdio and not HTTP?** A stdio server has no listening socket: no attack surface, no port to expose, no auth to get wrong, no data leaving the machine. For pure computation, HTTP would add risk and buy nothing.

**Why no caching?** Every call is stateless. Caching would introduce state, invalidation bugs and a place for data to persist. The operations are cheap enough that this is not a tradeoff.

**Why refuse oversized input?** An MCP server that hangs takes the client session with it. Refusing with an actionable message is strictly better than exhausting memory.

**Why no dependencies at all?** Every dependency is an ongoing obligation: updates, advisories, supply-chain risk, and one more reason the server might stop working. The Node standard library covers everything here.

## Development

```bash
node server.cjs              # speaks MCP over stdio
node selftest.mjs            # engine verification, 35 assertions
node protocol-test.cjs       # protocol verification, 88 assertions
npm test                     # both suites
```

Both suites run on plain Node with no install step.

`selftest.mjs` checks hashing against published constants, big-integer round trips past 2^53, RFC 4180 quoting edge cases, Unicode word segmentation and calendar arithmetic. `protocol-test.cjs` drives the real handler through a fake transport and covers the handshake, version negotiation, every tool, argument validation, the ReDoS deadline, malformed frames, split frames, batches, concurrent request correlation and determinism.

Two bugs found by these suites, both retained as regression tests:

- **A ReDoS in the word-segmentation regex.** The original `textStats` pattern was `[\p{L}\p{N}][\p{L}\p{N}'’-]*` — two adjacent, overlapping character classes. On a long letter run followed by a non-match it backtracked exponentially and hung the process. The analyzer shipped in this package did not catch it, because it statically inspects the pattern it is *given* and cannot see patterns written by hand in the source. The execution deadline above exists because of this.
- **Schema validation was absent.** Missing required arguments were silently treated as absent values, so a caller that forgot `path` received `missing-key` instead of an error. Client-side schemas are not enforcement.

## License

MIT — see [LICENSE](LICENSE).
