/**
 * verify-plugin-shape.mjs — checks every registered tool definition against
 * DSH's OWN schema converter and validator, loaded from the running
 * installation (app.asar).
 *
 * The plugin registers plain definitions instead of calling defineTool, so this
 * script proves the hand-written converter produces exactly what DSH would have
 * produced, and that each definition passes assertSupportedJsonSchema.
 *
 * Requires Electron-as-Node (plain Node cannot read inside app.asar):
 *   ELECTRON_RUN_AS_NODE=1 "D:\111\DeepSeek Harness.exe" --expose-internals scripts/verify-plugin-shape.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { toolSpecs, toJsonSchema } from '../packages/english-diagnosis/lib/core.mjs';

const RESULT_FILE = 'E:/English learning/demo/shape-result.txt';
const DSH_TOOLS_URL =
  process.env.DSH_TOOLS_URL ??
  'file:///D:/111/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

const lines = [];
const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const dsh = await import(DSH_TOOLS_URL);

  for (const spec of toolSpecs) {
    const ourParameters = toJsonSchema(spec.parameters);
    const dshParameters = dsh.parameterSchemaSpecToJsonSchema(spec.parameters);
    ok(`${spec.name}: parameters converter matches DSH`, same(ourParameters, dshParameters), same(ourParameters, dshParameters) ? 'identical' : 'differs');

    const ourOutput = toJsonSchema(spec.output.schema);
    const dshOutput = dsh.valueSchemaSpecToJsonSchema(spec.output.schema);
    ok(`${spec.name}: output converter matches DSH`, same(ourOutput, dshOutput), same(ourOutput, dshOutput) ? 'identical' : 'differs');

    dsh.assertSupportedJsonSchema(ourOutput);
    dsh.assertSupportedJsonSchema(ourParameters);
    ok(`${spec.name}: schemas accepted by registry validator`, true, 'accepted');
  }

  const diagnose = toolSpecs[0];
  const definition = {
    ...diagnose,
    parameters: toJsonSchema(diagnose.parameters),
    output: { ...diagnose.output, schema: toJsonSchema(diagnose.output.schema) },
  };

  const signal = new AbortController().signal;
  const value = await definition.execute(
    { text: 'With the development of economy, I learn knowledge and play important role in society.' },
    { signal },
  );
  ok('execute returns findings', Array.isArray(value.findings) && value.findings.length > 0, `${value.findings.length} findings`);
  ok('execute persisted to sqlite', value.storage?.persisted === true, String(value.storage?.persisted));
  ok('every finding has evidence', value.findings.every((f) => f.evidence?.quote && f.evidence?.ruleRef), 'ok');

  const rendered = definition.output.render({ text: '' }, value);
  ok('render returns text content', Array.isArray(rendered) && rendered[0]?.type === 'text', rendered[0]?.type);

  let rejectedEmpty = false;
  try {
    await definition.execute({}, { signal });
  } catch {
    rejectedEmpty = true;
  }
  ok('missing text is rejected', rejectedEmpty, 'ok');

  let rejectedLong = false;
  try {
    await definition.execute({ text: 'x'.repeat(20001) }, { signal });
  } catch {
    rejectedLong = true;
  }
  ok('oversized input is rejected', rejectedLong, 'ok');

  const clear = toolSpecs.find((spec) => spec.name === 'english_clear_records');
  let clearRefused = false;
  try {
    await clear.execute({}, { signal });
  } catch {
    clearRefused = true;
  }
  ok('clear-records refuses without confirm', clearRefused, 'ok');

  const plan = toolSpecs.find((spec) => spec.name === 'english_plan');
  const planValue = await plan.execute({ runs: 10 }, { signal });
  ok('plan returns a pattern list', Array.isArray(planValue.patterns), `${planValue.patterns.length} patterns`);
} catch (error) {
  checks.push({ name: 'harness crashed', pass: false, detail: String(error && error.stack ? error.stack : error) });
}

for (const check of checks) lines.push(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}  (${check.detail})`);
const failed = checks.filter((c) => !c.pass);
lines.push('', `${checks.length - failed.length}/${checks.length} checks passed`);

mkdirSync('E:/English learning/demo', { recursive: true });
writeFileSync(RESULT_FILE, lines.join('\n'), 'utf8');
if (failed.length > 0) process.exitCode = 1;
