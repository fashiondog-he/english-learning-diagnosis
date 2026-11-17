/**
 * audit.mjs — release gate for dsh-english-diagnosis (security-plan.md §5).
 *
 * Static checks only: no plugin code is executed. Exit code 1 if any gate
 * fails, so it can be wired into CI before publishing.
 *
 *   node scripts/audit.mjs
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'E:/English learning/packages/english-diagnosis';
const LIB = join(ROOT, 'lib');
const OUT = 'E:/English learning/demo/audit-result.txt';

const results = [];
const gate = (id, pass, detail) => results.push({ id, pass, detail });

const libFiles = readdirSync(LIB).filter((f) => f.endsWith('.mjs'));
const libSource = libFiles.map((f) => readFileSync(join(LIB, f), 'utf8')).join('\n');
// Comments mention the banned words by name; strip them before scanning code.
const codeOnly = libSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const third = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const skill = readFileSync(join(LIB, 'skill.mjs'), 'utf8');

// G1 — no user-file reads (only the plugin's own SQLite directory is created).
gate('G1 no directory/file reads in plugin code', !/\breadFile|\breaddir|\bcreateReadStream|\bglob\(/.test(codeOnly), 'no read* calls');
gate('G1b only node:fs mkdirSync imported', !/from ['"]node:fs['"]/.test(libSource) || /import\s*\{\s*mkdirSync\s*\}\s*from\s*['"]node:fs['"]/.test(libSource), 'mkdirSync only');

// G2 — no network code path at all.
gate('G2 no network primitives', !/\bfetch\(|node:(http|https|net|dns|tls)|require\(['"](http|https|net)['"]\)/.test(codeOnly), 'none');

// G3 — no shell, no subprocess.
gate('G3 no child_process', !/child_process|\bspawn\(|\bexecSync\(|\bexecFile\(/.test(codeOnly), 'none');
gate('G3b no shell:true', !/shell\s*:\s*true/.test(codeOnly), 'none');

// G4/G5 — output contract: confidence present, no grading vocabulary.
gate('G4 output schema declares confidence', /confidence/.test(libSource), 'yes');
gate('G4b every finding carries evidence', /evidence:\s*\{/.test(libSource), 'yes');
gate('G5 no score/level/grade/pass fields', !/"(score|level|grade|pass)"/.test(libSource), 'none');

// G6 — no raw text / audio columns.
gate('G6 no raw_text or audio column', !/raw_text|audio_blob|CREATE TABLE[^;]*content TEXT/i.test(codeOnly), 'none');

// G7 — README carries the required claims.
const claims = ['数据不出本机', '会话日志', '不采集年龄', '不改变'];
for (const claim of claims) gate(`G7 README states "${claim}"`, readme.includes(claim), readme.includes(claim) ? 'present' : 'MISSING');

// G8 — third-party notices complete.
gate('G8 THIRD_PARTY_NOTICES exists and says MIT', /MIT/.test(third) && /第三方/.test(third), 'present');

// G9 — SKILL carries workflow, termination, limitations.
gate('G9 SKILL has termination section', skill.includes('终止条件'), 'present');
gate('G9b SKILL has limitations section', skill.includes('局限性'), 'present');

// G10 — manifest hygiene.
gate('G10 engines.dsh declared', typeof pkg.engines?.dsh === 'string', pkg.engines?.dsh ?? 'MISSING');
gate('G10b no install scripts', !pkg.scripts || (!pkg.scripts.postinstall && !pkg.scripts.preinstall), 'none');
gate('G10c bundle patch uses insert:', /^-\s*insert:/m.test(patch), 'insert form');
gate('G10d no dependency on DSH packages at runtime', Object.keys(pkg.dependencies ?? {}).length === 0 && Object.keys(pkg.peerDependencies ?? {}).length === 0, 'zero-dep');

const failed = results.filter((r) => !r.pass);
const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  (${r.detail})`);
lines.push('', `${results.length - failed.length}/${results.length} gates passed`);

mkdirSync('E:/English learning/demo', { recursive: true });
writeFileSync(OUT, lines.join('\n'), 'utf8');
if (failed.length > 0) process.exitCode = 1;
