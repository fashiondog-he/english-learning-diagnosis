/**
 * check-activation.mjs — read-only probe: has the plugin ever activated in the
 * running DSH? The plugin writes a timestamp row into its own local database at
 * activation time; nothing else is recorded.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 "D:\111\DeepSeek Harness.exe" --expose-internals scripts/check-activation.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dbFile = 'C:/Users/Administrator/.dsh/english-diagnosis/analysis.db';
const out = 'E:/English learning/demo/activation.txt';

let text;
if (!existsSync(dbFile)) {
  text = 'NOT_ACTIVATED: database does not exist yet';
} else {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('SELECT id, at FROM plugin_activation').all();
    const runs = db.prepare('SELECT COUNT(*) AS n FROM analysis_run').get();
    db.close();
    text = rows.length === 0
      ? 'NOT_ACTIVATED: database exists but no activation row'
      : `ACTIVATED: ${JSON.stringify(rows)} runs=${runs.n}`;
  } catch (error) {
    text = `ERROR: ${error.message}`;
  }
}

mkdirSync('E:/English learning/demo', { recursive: true });
writeFileSync(out, text, 'utf8');
