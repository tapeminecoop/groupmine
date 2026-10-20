#!/usr/bin/env node
// Compacts `forge test --json` output (argv[2]) into reports/solidity-tests.json, adding the invariant
// admission-path counters from argv[3] (CSV written by PoolInvariantCoverageTest) when present.
import { readFile, writeFile } from 'node:fs/promises';

const [input, coverage] = process.argv.slice(2);
const raw = JSON.parse(await readFile(input, 'utf8'));
const out = { command: "forge test --no-match-path 'test/fork/*' --json", suites: {}, total: 0, passed: 0 };
for (const [suite, value] of Object.entries(raw)) {
  const tests = {};
  for (const [name, r] of Object.entries(value.test_results)) {
    out.total++;
    if (r.status === 'Success') out.passed++;
    const kind = r.kind ?? {};
    const entry = { status: r.status };
    if (kind.Unit) entry.gas = kind.Unit.gas;
    if (kind.Fuzz) Object.assign(entry, { fuzzRuns: kind.Fuzz.runs, meanGas: kind.Fuzz.mean_gas });
    if (kind.Invariant) Object.assign(entry, { invariantRuns: kind.Invariant.runs, calls: kind.Invariant.calls, reverts: kind.Invariant.reverts });
    if (r.reason) entry.reason = r.reason;
    tests[name] = entry;
  }
  out.suites[suite.split(':').at(-1)] = tests;
}
if (coverage) {
  const rows = (await readFile(coverage, 'utf8')).split('\n').filter(Boolean).map(l => l.split(',').map(Number));
  out.invariantAdmissionPaths = {
    runs: rows.length,
    successfulAdmissions: rows.reduce((s, r) => s + r[0], 0),
    rolledBackAdmissions: rows.reduce((s, r) => s + r[1], 0),
    runsWithAdmission: rows.filter(r => r[0] > 0).length,
    runsWithRollback: rows.filter(r => r[1] > 0).length,
    maxRegisteredMiners: Math.max(...rows.map(r => r[2])),
  };
}
await writeFile('reports/solidity-tests.json', JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ total: out.total, passed: out.passed, suites: Object.fromEntries(Object.entries(out.suites).map(([k, v]) => [k, Object.keys(v).length])), invariantAdmissionPaths: out.invariantAdmissionPaths }, null, 1));
