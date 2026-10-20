#!/usr/bin/env node
// Compacts Slither output into reports/slither.json and a path-sanitized reports/slither.txt.
// Usage: node scripts/summarize-slither.mjs <slither --json output> <slither text output> <slither version>
// Produced by: slither . --foundry-compile-all --filter-paths "node_modules|lib|test|script" --exclude-informational --fail-none
import { readFile, writeFile } from 'node:fs/promises';

const [rawPath, textPath, version] = process.argv.slice(2);
const raw = JSON.parse(await readFile(rawPath, 'utf8'));
const root = process.cwd();
const clean = s => s.split(root + '/').join('').split(root).join('.');

const detectors = raw.results?.detectors ?? [];
const findings = detectors.map(d => ({
  check: d.check,
  impact: d.impact,
  confidence: d.confidence,
  description: clean(d.description.split('\n')[0].trim()),
}));
const byCheck = {};
for (const f of findings) {
  const key = `${f.check} (${f.impact}/${f.confidence})`;
  byCheck[key] = (byCheck[key] ?? 0) + 1;
}
await writeFile('reports/slither.json', JSON.stringify({
  tool: `slither ${version}`,
  command: 'slither . --foundry-compile-all --filter-paths "node_modules|lib|test|script" --exclude-informational --fail-none',
  success: raw.success,
  results: findings.length,
  byCheck,
  findings,
}, null, 1) + '\n');

// Keep the human-readable findings; drop interpreter warnings and the tool's build chatter.
const text = (await readFile(textPath, 'utf8')).split('\n')
  .filter(line => !/NotOpenSSLWarning|warnings\.warn\(|^'forge /.test(line))
  .map(clean)
  .join('\n')
  .replace(/^\n+/, '');
await writeFile('reports/slither.txt', text);
console.log(JSON.stringify({ results: findings.length, byCheck }, null, 1));
