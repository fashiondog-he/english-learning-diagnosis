/**
 * dsh-english-diagnosis — core analysis module (mock rule set, stage 1).
 *
 * Zero external runtime dependencies: node:sqlite, node:crypto, node:fs,
 * node:os, node:path. This module is intentionally importable outside DSH so
 * the exact same execute path can be verified before the plugin is installed.
 *
 * Security invariants enforced here (see security-plan.md):
 *  - no filesystem reads except the plugin's own SQLite file under $DSH_HOME
 *  - no network calls, no child_process, no shell
 *  - raw text is never persisted; only rule ids, spans and <=160-char quotes
 *  - every model-facing string passes the output sanitizer
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PLUGIN_NAME = 'english-diagnosis';
export const PLUGIN_VERSION = '0.3.0';
export const RULE_SET_VERSION = 'l1-transfer-0.3.0';
export const MAX_INPUT_CHARS = 20000;
const MAX_QUOTE_CHARS = 160;
const MAX_MATCHES_PER_RULE = 5;
const MAX_FINDINGS = 15;

/* ---------------------------------------------------------------- home path */

function resolveDshHome() {
  const explicit = process.env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  return join(homedir(), '.dsh');
}

export function resolveDbPath() {
  return join(resolveDshHome(), 'english-diagnosis', 'analysis.db');
}

/* ------------------------------------------------------------- sanitization */

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uE000-\uF8FF]/g;

export function stripInvisible(text) {
  let removed = 0;
  const cleaned = text.replace(INVISIBLE_RE, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

const SALT = randomBytes(16);

function pseudonym(type, value) {
  const digest = createHash('sha256').update(SALT).update(value).digest('hex').slice(0, 8);
  return `[[${type}_${digest}]]`;
}

const PII_PATTERNS = [
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'PHONE', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { type: 'ID', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  {
    type: 'SECRET',
    re: /(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{10,})/g,
  },
];

export function sanitizeString(input) {
  let value = String(input);
  for (const { type, re } of PII_PATTERNS) value = value.replace(re, (m) => pseudonym(type, m));
  return value;
}

export function sanitizeValue(input) {
  if (typeof input === 'string') return sanitizeString(input);
  if (Array.isArray(input)) return input.map(sanitizeValue);
  if (input !== null && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = sanitizeValue(v);
    return out;
  }
  return input;
}

/* ------------------------------------------------------------------- rules */

const CONNECTIVES = [
  "first of all",
  'firstly',
  'secondly',
  'thirdly',
  'besides',
  "what's more",
  'what is more',
  'moreover',
  'furthermore',
  'in addition',
  'last but not least',
  'on the other hand',
  'on the one hand',
  'that is to say',
];

function findAll(re, text) {
  const matches = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    matches.push({ start, end: start + m[0].length, quote: m[0], label: m[1] ?? m[0] });
  }
  return matches;
}

function clip(quote) {
  const flat = quote.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS - 1)}…` : flat;
}

function sentences(text) {
  const out = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]*/g)) out.push({ start: m.index ?? 0, body: m[0] });
  return out;
}

const CALQUES = [
  { re: /\b(?:learn|learns|learned|learning)\s+(?:a\s+lot\s+of\s+)?knowledge/gi, label: 'learn knowledge', fix: 'acquire / gain knowledge' },
  { re: /open\s+the\s+light/gi, label: 'open the light', fix: 'turn on the light' },
  { re: /\b(?:eat|eats|ate|eaten)\s+(?:the\s+)?medicine/gi, label: 'eat medicine', fix: 'take medicine' },
  { re: /more\s+better/gi, label: 'more better', fix: 'better' },
  { re: /in\s+my\s+opinion\s*,?\s*i\s+think/gi, label: 'in my opinion I think', fix: 'in my view, … (只保留一个)' },
  { re: /\b(?:discuss|discusses|discussed|discussing)\s+about\b/gi, label: 'discuss about', fix: 'discuss' },
  { re: /\b(?:emphasize|emphasizes|emphasized|emphasizing|emphasise|emphasises|emphasised|emphasising)\s+on\b/gi, label: 'emphasize on', fix: 'emphasize' },
  { re: /how\s+to\s+say/gi, label: 'how to say', fix: 'how do you say …?' },
  { re: /according\s+to\s+me\b/gi, label: 'according to me', fix: 'in my view / to me' },
  { re: /married\s+with\b/gi, label: 'married with', fix: 'married to' },
  // delexical verb + noun confusions — Liu, Liu & Baek (2022) documented that
  // Chinese learners overuse a small set of light verbs and mix make/do/have/take.
  { re: /\b(?:do|does|did|done)\s+(?:a|the|an|my|our)?\s*mistakes?\b/gi, label: 'do (a) mistake', fix: 'make a mistake' },
  { re: /\b(?:do|does|did|done)\s+(?:a|the|an)?\s*decision\b/gi, label: 'do a decision', fix: 'make a decision' },
  { re: /\b(?:make|makes|made|making)\s+(?:a|the)?\s*research\b/gi, label: 'make (a) research', fix: 'do research' },
  { re: /\b(?:make|makes|made|making)\s+(?:the|some)?\s*exercises?\b/gi, label: 'make exercises', fix: 'do exercises' },
  { re: /\b(?:make|makes|made|making)\s+(?:a|the)?\s*conclusion\b/gi, label: 'make a conclusion', fix: 'reach / draw a conclusion' },
  { re: /\b(?:do|does|did|done)\s+(?:a|the)?\s*conclusion\b/gi, label: 'do a conclusion', fix: 'reach / draw a conclusion' },
  { re: /\b(?:do|does|did|done)\s+(?:a|the)?\s*plan\b/gi, label: 'do a plan', fix: 'make a plan' },
];

/**
 * Nine deterministic rules. Each one: (a) has a contrastive explanation in
 * Mandarin→English terms, (b) is decidable from surface text without a parser,
 * (c) produces a quotable span, (d) maps to one practice action.
 * See docs/rule-design.md for why these and not others.
 */
const RULES = [
  {
    id: 'L1_BECAUSE_SO',
    ref: 'R-SYN-01',
    category: 'syntax',
    title: '关联词成对照搬（because … so）',
    baseConfidence: 0.8,
    detect(text) {
      const out = [];
      for (const sentence of sentences(text)) {
        const because = /\bbecause\b/i.exec(sentence.body);
        if (!because) continue;
        const after = sentence.body.slice(because.index + because[0].length);
        const so = /,?\s*\bso\b/i.exec(after);
        if (!so) continue;
        const tail = after.slice(so.index);
        if (/^,?\s*so\s+that\b/i.test(tail)) continue;
        const end = because.index + because[0].length + so.index + so[0].length;
        out.push({ start: sentence.start + because.index, end: sentence.start + end, quote: sentence.body.slice(because.index, end) });
      }
      return out;
    },
    explain: '汉语的「因为……所以……」成对出现，英语只保留一个连接词。照搬后句子出现两个从属标记，是句法层最典型的负迁移。',
    nextStep: '只保留 because，删掉 so；或保留 so，把 because 从句改成名词短语。二选一，不要两个都留。',
    suggestion: '改写三句：一句留 because，一句留 so，第三句两个都删、用分号衔接。',
  },
  {
    id: 'L1_ALTHOUGH_BUT',
    ref: 'R-SYN-02',
    category: 'syntax',
    title: '关联词成对照搬（although … but）',
    baseConfidence: 0.8,
    detect(text) {
      const out = [];
      for (const sentence of sentences(text)) {
        const m = /\b(?:although|though)\b/i.exec(sentence.body);
        if (!m) continue;
        const after = sentence.body.slice(m.index + m[0].length);
        const but = /\bbut\b/i.exec(after);
        if (!but) continue;
        const end = m.index + m[0].length + but.index + but[0].length;
        out.push({ start: sentence.start + m.index, end: sentence.start + end, quote: sentence.body.slice(m.index, end) });
      }
      return out;
    },
    explain: '汉语「虽然……但是……」成对，英语 although 已经承担让步，再加 but 就重复标记。',
    nextStep: '删掉 but；如果 but 才是你想强调的转折，就把 although 从句改成 despite + 名词短语。',
    suggestion: '把一处 although … but 改成 although 独立成句，另一处改成 Despite + 名词。',
  },
  {
    id: 'L1_THERE_BE_HAVE',
    ref: 'R-SYN-03',
    category: 'syntax',
    title: '存在句套动词（There are … have / There have …）',
    baseConfidence: 0.85,
    detect(text) {
      const out = [];
      for (const m of findAll(/\bthere\s+(?:is|are|was|were|has|have)\b/gi, text)) {
        const tail = text.slice(m.end, m.end + 60);
        const have = /^\s*(?:[A-Za-z'-]+\s+){0,6}?\b(have|has|had)\b/i.exec(tail);
        if (!have) continue;
        const between = tail.slice(0, have.index + have[0].length);
        if (/\b(who|that|which|whose|where)\b/i.test(between)) continue;
        out.push({ start: m.start, end: m.end + have.index + have[0].length, quote: text.slice(m.start, m.end + have.index + have[0].length) });
      }
      return out;
    },
    explain: '汉语说「有很多人认为」，英语存在句只允许 there be，动词 have 不能再出现。Jiang & Zhang (2022, Frontiers in Psychology) 进一步发现中国学习者会「过量产出」存在句（L1 负迁移），本规则抓的是其中最高确定度的一类：there be 后又接 have。',
    nextStep: '改成 There are many people who …，或直接用 Many people …。',
    suggestion: '把出现问题的句子各改写成两个版本（there be + who 从句版 / 主语直陈版），比较哪个更顺。',
  },
  {
    id: 'L1_ARTICLE_OMISSION',
    ref: 'R-SYN-04',
    category: 'syntax',
    title: '冠词脱落（play important role / as student）',
    baseConfidence: 0.7,
    detect(text) {
      const out = [];
      out.push(...findAll(/\b(play|take|have)\s+(important|great|big|significant|active|good)\s+(role|part)\b/gi, text));
      out.push(...findAll(/\bas\s+(student|teacher|freshman|college student|middle school student)\b/gi, text));
      return out;
    },
    explain: '汉语没有冠词系统，可数名词单数的限定词最容易脱落。这类错误不是粗心，是母语里没有对应的语法范畴。',
    nextStep: '只练一个结构：动词 + a/an/the + 形容词 + 名词。写 5 句，每句说出为什么用 a 而不是 the。',
    suggestion: '把每个缺失冠词的名词补上限定词，并标注它是「首次提及」还是「双方已知」。',
  },
  {
    id: 'L1_AND_CHAIN',
    ref: 'R-SYN-05',
    category: 'syntax',
    title: 'and 串接长句（一句超过 35 词且 ≥3 个 and）',
    baseConfidence: 0.6,
    detect(text) {
      const out = [];
      for (const sentence of sentences(text)) {
        const words = sentence.body.trim().split(/\s+/).filter(Boolean).length;
        const ands = (sentence.body.match(/\band\b/gi) || []).length;
        if (words > 35 && ands >= 3) out.push({ start: sentence.start, end: sentence.start + sentence.body.length, quote: sentence.body.trim() });
      }
      return out;
    },
    explain: '靠 and 平铺是句法规划不足：写作者还没决定主从关系，就把想法串起来。汉语意合、英语形合，这个差异最容易在长句上暴露。',
    nextStep: '把一句拆成「主句 + 一个从句 + 一个独立句」，每句只承担一个逻辑关系。',
    suggestion: '选最长的一句，用 because / although / which 中的两个重写。',
  },
  {
    id: 'L1_VERY_VERB',
    ref: 'R-SYN-06',
    category: 'syntax',
    title: '程度副词直接修饰动词（I very like …）',
    baseConfidence: 0.75,
    detect(text) {
      return findAll(/\bvery\s+(like|love|hate|want|need|hope|enjoy|prefer)\b/gi, text);
    },
    explain: '汉语「我很喜欢」里「很」直接修饰动词；英语 very 修饰形容词/副词，动词要用 really / very much 或换词。',
    nextStep: '把 very + 动词改成 really + 动词，或改成动词本身更强的词（like → enjoy / be fond of）。',
    suggestion: '把三个 very + 动词的句子各改一种说法：really、very much、换动词。',
  },
  {
    id: 'L1_COLLOCATION_CALQUE',
    ref: 'R-LEX-01',
    category: 'collocation',
    title: '搭配直译（逐词对应，英语里不成立）',
    baseConfidence: 0.78,
    detect(text) {
      const hits = [];
      for (const { re, label, fix } of CALQUES) for (const m of findAll(re, text)) hits.push({ ...m, label: fix ?? label });
      return hits;
    },
    explain: '搭配是词汇层的「语法」：每个词都对，组合起来母语者不用。这类错误单靠拼写/语法检查器抓不到，只能靠搭配表。',
    nextStep: '换成词典确认过的搭配，然后把新搭配放进一个与你生活相关的句子里再写一次。',
    suggestion: '每个错误搭配抄下正确版本，用它造两句自己的话，不要造句库例句。',
  },
  {
    id: 'L1_FORMULAIC_TEMPLATE',
    ref: 'R-DIS-01',
    category: 'discourse',
    title: '模板套语（with the development of / more and more / every coin has two sides）',
    baseConfidence: 0.65,
    detect(text) {
      return findAll(/(?:with|along\s+with)\s+the\s+(?:rapid\s+|fast\s+|continuous\s+)?development\s+of|more\s+and\s+more|every\s+coin\s+has\s+two\s+sides|as\s+we\s+all\s+know|with\s+the\s+rapid\s+development\s+of/gi, text);
    },
    explain: '模板套语是应试写作的产物，不是语言能力。语料库研究反复发现中国学习者过度依赖少数固定开头与过渡语。',
    nextStep: '用一个具体事实替换套语：时间、地点、数字、一个你观察到的现象。',
    suggestion: '把开头改成「上周我在食堂看到 ……」这类具体场景，再回头看看论点是否还成立。',
  },
  {
    id: 'L1_CONNECTIVE_OVERUSE',
    ref: 'R-DIS-02',
    category: 'discourse',
    title: '连接词密集（一段里 ≥4 个显性连接词）',
    baseConfidence: 0.68,
    detect(text) {
      const hits = [];
      for (const marker of CONNECTIVES) {
        const re = new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        for (const m of text.matchAll(re)) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, quote: m[0] });
      }
      if (hits.length < 4) return [];
      hits.sort((a, b) => a.start - b.start);
      const first = hits[0];
      const last = hits[hits.length - 1];
      return [{ start: first.start, end: last.end, quote: text.slice(first.start, last.end), label: `${hits.length} connectives` }];
    },
    explain: '汉语段落靠意合，英语学术写作靠形合，但「形合」不等于每个句子都加连接词。连接词过密反而说明句子之间没有真实逻辑关系。',
    nextStep: '删到只剩一个连接词，然后读一遍：段落是否还成立？不成立的地方，才是需要补逻辑的地方。',
    suggestion: '标出每个连接词承担的逻辑关系（因果/让步/递进/举例），说不出来的就删。',
  },
];

/* ----------------------------------------------------------------- storage */

function openDb() {
  const file = resolveDbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_run (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      plugin_version TEXT NOT NULL,
      rule_set TEXT NOT NULL,
      input_len INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      analyzed_chars INTEGER NOT NULL,
      finding_count INTEGER NOT NULL,
      confidence REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finding (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_ref TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      quote TEXT NOT NULL,
      next_step TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * Local-only activation marker: proves the plugin loaded, without touching any
 * other file and without recording content. Used by the install check and by
 * anyone debugging whether the bundle is actually mounted.
 */
export function recordActivation() {
  const db = openDb();
  try {
    db.exec('CREATE TABLE IF NOT EXISTS plugin_activation (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO plugin_activation (id, at) VALUES (?, ?)').run(PLUGIN_NAME, Date.now());
  } finally {
    db.close();
  }
}

function persist(value, sanitizedText) {  const db = openDb();
  try {
    const insertRun = db.prepare(
      `INSERT INTO analysis_run (id, created_at, plugin_version, rule_set, input_len, input_hash, analyzed_chars, finding_count, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertRun.run(
      value.runId,
      Date.now(),
      PLUGIN_VERSION,
      RULE_SET_VERSION,
      sanitizedText.length,
      createHash('sha256').update(sanitizedText).digest('hex'),
      value.analyzedChars,
      value.findings.length,
      value.confidence,
    );
    const insertFinding = db.prepare(
      `INSERT INTO finding (id, run_id, rule_id, rule_ref, category, confidence, span_start, span_end, quote, next_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of value.findings) {
      insertFinding.run(f.id, value.runId, f.ruleId, f.ruleRef, f.category, f.confidence, f.span.start, f.span.end, clip(f.span.quote), f.nextStep);
    }
    return true;
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------- analysis */

const round2 = (n) => Math.round(n * 100) / 100;

const LIMITS = [
  '规则集为 9 条确定性规则（l1-transfer-0.3.0），覆盖关联词成对、存在句套动词、冠词脱落、and 串接长句、very+动词、搭配直译（含轻动词 make/do/have/take）、模板套语、连接词密集。',
  '本工具是诊断提示，不替代教师评估；输出仅用于学习路径推荐，不可用于选拔、惩罚或任何法律决定。',
  '证据片段上限 160 字符；未命中规则不等于没有迁移问题。',
  '原文不落盘：仅保存规则 ID、位置与证据片段，重跑需重新粘贴文本。',
  '改写建议为 AI 生成，请自行判断是否采纳。',
];

export function runAnalysis(rawText) {
  const stripped = stripInvisible(String(rawText ?? ''));
  const text = stripped.text;
  const findings = [];

  for (const rule of RULES) {
    const matches = rule.detect(text).slice(0, MAX_MATCHES_PER_RULE);
    if (matches.length === 0) continue;
    const confidence = round2(Math.min(0.93, rule.baseConfidence + 0.03 * (matches.length - 1)));
    for (const match of matches) {
      findings.push({
        id: randomUUID(),
        ruleId: rule.id,
        ruleRef: rule.ref,
        category: rule.category,
        title: rule.title,
        confidence,
        span: { start: match.start, end: match.end, quote: clip(match.quote) },
        evidence: {
          ruleId: rule.id,
          ruleRef: rule.ref,
          quote: clip(match.quote),
          confidence,
        },
        nextStep: rule.nextStep,
        explain: rule.explain,
      });
    }
  }

  findings.sort((a, b) => b.confidence - a.confidence || a.span.start - b.span.start);

  const suggestions = [];
  const seen = new Set();
  for (const finding of findings) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    const rule = RULES.find((r) => r.id === finding.ruleId);
    suggestions.push({
      id: `SUG-${suggestions.length + 1}`,
      ruleIds: [finding.ruleId],
      text: sanitizeString(rule.suggestion),
      generatedBy: 'ai',
    });
  }

  const confidence = findings.length > 0
    ? round2(findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length)
    : 0;

  const value = {
    runId: randomUUID(),
    analyzedChars: text.length,
    ruleSet: { version: RULE_SET_VERSION, ruleCount: RULES.length },
    confidence,
    findings,
    suggestions,
    limits: LIMITS,
    sanitization: { invisibleRemoved: stripped.removed },
    storage: { scope: '$DSH_HOME/english-diagnosis/analysis.db', persisted: false },
  };

  try {
    value.storage.persisted = persist(value, text);
  } catch {
    value.storage.persisted = false;
    value.limits = [...value.limits, '本地库写入失败：本次结果未持久化（不记录原文）。'];
  }

  return sanitizeValue(value);
}

/* ------------------------------------------------------------- tool spec */

/**
 * Convert the compact spec form used below into the JSON Schema the registry
 * expects. The plugin registers a plain definition (no import of
 * @deepseek-ai/dsh-tools) so that installing it needs no registry access and
 * resolves no peer dependency. verify-plugin-shape.mjs proves this converter
 * produces byte-identical output to DSH's own parameterSchemaSpecToJsonSchema.
 */
export function toJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('spec must be an object');

  // A bare property map (no `type`) is the DSL's implicit object root.
  if (spec.type === 'object' || spec.type === undefined) {
    const source = spec.type === 'object' ? (spec.properties ?? {}) : spec;
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(source)) {
      if (value.required === true) required.push(key);
      const { required: _drop, ...rest } = value;
      properties[key] = toJsonSchema(rest);
    }
    return {
      type: 'object',
      ...(spec.type === 'object' && spec.additionalProperties === false ? { additionalProperties: false } : {}),
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (spec.type === 'array') {
    return { type: 'array', items: toJsonSchema(spec.items) };
  }
  const out = { type: spec.type };
  if (typeof spec.description === 'string') out.description = spec.description;
  if (Array.isArray(spec.enum)) out.enum = spec.enum;
  return out;
}

export const toolSpec = {
  name: 'english_diagnose',
  description:
    '诊断一段英语写作中的母语迁移痕迹（中式英语深层诊断）。输入是待分析的英文文本，输出是带证据（原文片段 / 规则 ID / 置信度 / 下一步）的结构化诊断，不修改原文、不评分。',
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: '待诊断的英文文本（作文、段落或句子），最多 20000 字符。',
    },
    focus: {
      type: 'string',
      description: '可选：all（默认）| syntax | collocation | discourse，只返回该类别的诊断。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', required: true },
        analyzedChars: { type: 'integer', required: true },
        ruleSet: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            version: { type: 'string', required: true },
            ruleCount: { type: 'integer', required: true },
          },
        },
        confidence: { type: 'number', required: true },
        findings: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              ruleId: { type: 'string', required: true },
              ruleRef: { type: 'string', required: true },
              category: { type: 'string', required: true },
              title: { type: 'string', required: true },
              confidence: { type: 'number', required: true },
              span: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  start: { type: 'integer', required: true },
                  end: { type: 'integer', required: true },
                  quote: { type: 'string', required: true },
                },
              },
              evidence: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  ruleId: { type: 'string', required: true },
                  ruleRef: { type: 'string', required: true },
                  quote: { type: 'string', required: true },
                  confidence: { type: 'number', required: true },
                },
              },
              nextStep: { type: 'string', required: true },
              explain: { type: 'string', required: true },
            },
          },
        },
        suggestions: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              ruleIds: { type: 'array', required: true, items: { type: 'string' } },
              text: { type: 'string', required: true },
              generatedBy: { type: 'string', required: true },
            },
          },
        },
        limits: { type: 'array', required: true, items: { type: 'string' } },
        sanitization: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: { invisibleRemoved: { type: 'integer', required: true } },
        },
        storage: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            scope: { type: 'string', required: true },
            persisted: { type: 'boolean', required: true },
          },
        },
      },
    },
    render(_args, value) {
      const lines = [];
      lines.push(`诊断完成：基于 ${value.ruleSet.ruleCount} 条规则（${value.ruleSet.version}），命中 ${value.findings.length} 条，整体置信度 ${value.confidence}。`);
      value.findings.forEach((f, i) => {
        lines.push(`${i + 1}. [${f.category}] ${f.title}`);
        lines.push(`   证据：${f.span.quote}`);
        lines.push(`   规则：${f.ruleRef} / 置信度 ${f.confidence}`);
        lines.push(`   下一步：${f.nextStep}`);
      });
      if (value.findings.length === 0) lines.push('未命中当前规则的任何模式。这不等于没有迁移问题，只是当前规则集未覆盖。');
      lines.push(`局限：${value.limits[0]}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args) {
    const text = typeof args?.text === 'string' ? args.text : '';
    if (text.trim().length === 0) throw new Error('english_diagnose 需要一个非空的 text 参数。');
    if (text.length > MAX_INPUT_CHARS) throw new Error(`输入过长：${text.length} 字符，上限 ${MAX_INPUT_CHARS}。`);
    const focus = typeof args?.focus === 'string' ? args.focus : 'all';
    const value = runAnalysis(text);
    if (focus !== 'all') {
      return sanitizeValue({
        ...value,
        findings: value.findings.filter((f) => f.category === focus),
        suggestions: value.suggestions,
      });
    }
    return value;
  },
};

/* --------------------------------------------------- clear-records tool */

/**
 * Delete this plugin's own analysis rows. The activation row is kept so that
 * install checks still work afterwards; nothing outside the plugin database is
 * touched (DSH session logs are never opened).
 */
export function clearRecords() {
  const db = openDb();
  try {
    const runs = db.prepare('SELECT COUNT(*) AS n FROM analysis_run').get().n;
    const findings = db.prepare('SELECT COUNT(*) AS n FROM finding').get().n;
    db.exec('DELETE FROM finding; DELETE FROM analysis_run;');
    return { deletedRuns: runs, deletedFindings: findings };
  } finally {
    db.close();
  }
}

export const clearRecordsSpec = {
  name: 'english_clear_records',
  description:
    '清空本插件保存在本机的诊断记录（只删 $DSH_HOME/english-diagnosis/analysis.db 里的分析数据，不碰 DSH 会话日志、不删原文——原文本来就没有保存）。属于不可逆操作，必须显式传 confirm: true。',
  parameters: {
    confirm: { type: 'boolean', required: true, description: '必须为 true 才执行删除；用于防误触。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deletedRuns: { type: 'integer', required: true },
        deletedFindings: { type: 'integer', required: true },
        scope: { type: 'string', required: true },
      },
    },
    render(_args, value) {
      return [{
        type: 'text',
        text: `已清空本机诊断记录：${value.deletedRuns} 次运行、${value.deletedFindings} 条 finding。范围仅 ${value.scope}；会话日志未触碰。`,
      }];
    },
  },
  async execute(args) {
    if (args?.confirm !== true) throw new Error('english_clear_records 需要 confirm: true 才会删除，本次未做任何改动。');
    const result = clearRecords();
    return { ...result, scope: '$DSH_HOME/english-diagnosis/analysis.db' };
  },
};

/* -------------------------------------------------- explain / plan tools */

function ruleById(id) {
  return RULES.find((r) => r.id === id);
}

function practiceOf(id) {
  const rule = ruleById(id);
  return rule ? rule.suggestion : '该规则来自旧版本，建议重新诊断一次。';
}

function explainOf(id) {
  const rule = ruleById(id);
  return rule ? rule.explain : '该规则来自旧版本，当前规则集中已不存在。';
}

export function loadFindings(runId, ruleId) {
  const db = openDb();
  try {
    return ruleId
      ? db.prepare('SELECT * FROM finding WHERE run_id = ? AND rule_id = ? ORDER BY confidence DESC LIMIT 5').all(runId, ruleId)
      : db.prepare('SELECT * FROM finding WHERE run_id = ? ORDER BY confidence DESC LIMIT 5').all(runId);
  } finally {
    db.close();
  }
}

export function aggregatePatterns(runs) {
  const db = openDb();
  try {
    return db.prepare(
      `SELECT f.rule_id AS ruleId, COUNT(*) AS n, AVG(f.confidence) AS avgConfidence
         FROM finding f
         JOIN analysis_run r ON f.run_id = r.id
        WHERE r.id IN (SELECT id FROM analysis_run ORDER BY created_at DESC LIMIT ?)
        GROUP BY f.rule_id
        ORDER BY n DESC
        LIMIT 6`,
    ).all(runs);
  } finally {
    db.close();
  }
}

export const explainSpec = {
  name: 'english_explain',
  description:
    '展开某一次诊断里的证据：给定 runId（可选 ruleId），返回该次运行中置信度最高的几条 finding，附带迁移解释与练习动作。用于用户追问“这一条为什么算迁移”。',
  parameters: {
    runId: { type: 'string', required: true, description: 'english_diagnose 返回的 runId。' },
    ruleId: { type: 'string', description: '可选：只看某条规则，如 L1_BECAUSE_SO。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', required: true },
        count: { type: 'integer', required: true },
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ruleId: { type: 'string', required: true },
              ruleRef: { type: 'string', required: true },
              quote: { type: 'string', required: true },
              confidence: { type: 'number', required: true },
              explain: { type: 'string', required: true },
              nextStep: { type: 'string', required: true },
              practice: { type: 'string', required: true },
            },
          },
        },
      },
    },
    render(_args, value) {
      const lines = [`run ${value.runId}：${value.count} 条证据`];
      value.items.forEach((item, i) => {
        lines.push(`${i + 1}. ${item.ruleRef} · ${item.quote}`);
        lines.push(`   为什么算迁移：${item.explain}`);
        lines.push(`   练习：${item.practice}`);
      });
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args) {
    const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
    if (runId.length === 0) throw new Error('english_explain 需要 runId。');
    const rows = loadFindings(runId, typeof args?.ruleId === 'string' ? args.ruleId : undefined);
    if (rows.length === 0) throw new Error('没有找到该 runId 的诊断记录，请重新调用 english_diagnose。');
    return sanitizeValue({
      runId,
      count: rows.length,
      items: rows.map((row) => ({
        ruleId: row.rule_id,
        ruleRef: row.rule_ref,
        quote: row.quote,
        confidence: row.confidence,
        explain: explainOf(row.rule_id),
        nextStep: row.next_step,
        practice: practiceOf(row.rule_id),
      })),
    });
  },
};

export const planSpec = {
  name: 'english_plan',
  description:
    '把最近几次诊断聚合成学习路径：按出现频次排序的高频迁移模式，每种给出练习动作。用于用户问“我到底该先练什么”。',
  parameters: {
    runs: { type: 'integer', description: '聚合最近多少次运行，默认 10。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowRuns: { type: 'integer', required: true },
        patterns: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ruleId: { type: 'string', required: true },
              ruleRef: { type: 'string', required: true },
              count: { type: 'integer', required: true },
              avgConfidence: { type: 'number', required: true },
              practice: { type: 'string', required: true },
            },
          },
        },
        note: { type: 'string', required: true },
      },
    },
    render(_args, value) {
      if (value.patterns.length === 0) return [{ type: 'text', text: '还没有可聚合的诊断记录，先跑一次 english_diagnose。' }];
      const lines = [`最近 ${value.windowRuns} 次诊断的高频模式：`];
      value.patterns.forEach((p, i) => lines.push(`${i + 1}. ${p.ruleRef} × ${p.count}（平均置信度 ${p.avgConfidence}）— ${p.practice}`));
      lines.push(value.note);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args) {
    const runs = Number.isSafeInteger(args?.runs) && args.runs > 0 ? Math.min(args.runs, 50) : 10;
    const rows = aggregatePatterns(runs);
    return sanitizeValue({
      windowRuns: runs,
      patterns: rows.map((row) => ({
        ruleId: row.ruleId,
        ruleRef: (ruleById(row.ruleId)?.ref ?? 'R-LEGACY'),
        count: row.n,
        avgConfidence: Math.round(row.avgConfidence * 100) / 100,
        practice: practiceOf(row.ruleId),
      })),
      note: rows.length === 0 ? '最近窗口内没有命中记录。' : '按频次排序；先练第一条，改完再跑一次诊断看是否下降。',
    });
  },
};

export const toolSpecs = [toolSpec, explainSpec, planSpec, clearRecordsSpec];
