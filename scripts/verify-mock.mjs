/**
 * verify-mock.mjs — runs the real english_diagnose execute path without DSH.
 *
 * Usage (from the workspace root):
 *   node scripts/verify-mock.mjs --file scripts/fixtures/mock-essay.txt
 *   node scripts/verify-mock.mjs --text "With the development of ..."
 *
 * Prints the sanitized tool result as JSON on stdout and the safety checks on
 * stderr. Exit code 1 if any check fails.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { toolSpec, resolveDbPath } from '../packages/english-diagnosis/lib/core.mjs';

function parseArgs(argv) {
  const out = { file: undefined, text: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--file') out.file = argv[++i];
    else if (key === '--text') out.text = argv[++i];
    else if (key === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const text = args.file ? readFileSync(args.file, 'utf8') : args.text ?? '';

if (!text.trim()) {
  console.error('usage: node scripts/verify-mock.mjs --file <path> | --text "<english text>"');
  process.exit(2);
}

const value = await toolSpec.execute({ text, focus: 'all' }, { signal: new AbortController().signal });
const rendered = toolSpec.output.render({ text }, value);

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });

ok('findings non-empty', value.findings.length > 0, `${value.findings.length} findings`);
ok(
  'every finding carries evidence',
  value.findings.every((f) => f.evidence && f.evidence.quote && f.evidence.ruleRef && typeof f.evidence.confidence === 'number'),
  `${value.findings.length}/${value.findings.length}`,
);
ok(
  'every finding carries nextStep',
  value.findings.every((f) => typeof f.nextStep === 'string' && f.nextStep.length > 0),
  'ok',
);
ok('output has confidence float', typeof value.confidence === 'number', String(value.confidence));
ok('no score/level/grade fields', !JSON.stringify(value).match(/"(score|level|grade|pass)"/), 'none');
ok('evidence quote within 160 chars', value.findings.every((f) => f.span.quote.length <= 160), 'ok');

// Storage check: rows exist, and the schema has no raw-text column.
let persisted = false;
let columns = [];
try {
  const db = new DatabaseSync(resolveDbPath());
  const row = db.prepare('SELECT COUNT(*) AS n FROM finding WHERE run_id = ?').get(value.runId);
  persisted = row.n > 0;
  columns = db.prepare('PRAGMA table_info(finding)').all().map((c) => c.name);
  db.close();
} catch (error) {
  ok('sqlite readable', false, error.message);
}
ok('findings persisted to sqlite', persisted, 'analysis.db');
ok('no raw_text column', !columns.includes('raw_text'), columns.join(','));

// Sanitization check: PII and invisible characters never reach the output.
const probe = await toolSpec.execute(
  {
    text: 'With the development of economy, contact me at learner@example.com or 13800138000. I learn knowledge\u200b here.',
    focus: 'all',
  },
  { signal: new AbortController().signal },
);
const probeJson = JSON.stringify(probe);
ok('email pseudonymized', !probeJson.includes('learner@example.com'), 'not present');
ok('phone pseudonymized', !probeJson.includes('13800138000'), 'not present');
ok('invisible chars stripped', probe.sanitization.invisibleRemoved === 1, String(probe.sanitization.invisibleRemoved));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.error(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
console.error(`\n${checks.length - failed.length}/${checks.length} checks passed`);

if (args.out) {
  writeFileSync(args.out, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.error(`json written to ${args.out}`);
}

console.log(JSON.stringify(value, null, 2));

if (failed.length > 0) process.exit(1);
