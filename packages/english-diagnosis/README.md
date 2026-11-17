# dsh-english-diagnosis

给 DSH 加一个 Facade 工具 `english_diagnose`：输入一段英语写作，输出**带证据的中式英语诊断**（原文片段 / 规则 ID / 置信度 / 下一步），不评分、不改写原文、不替代教师。

当前阶段：**`l1-transfer-0.3.0`（9 条确定性规则）**，规则选择依据见仓库根目录 `docs/rule-design.md`。

## 工具（4 个）

| 工具 | 阶段 | 作用 |
|---|---|---|
| `english_diagnose` | 诊断 | 输入文本 → 9 条规则的 findings（每条带 evidence） |
| `english_explain` | 追问 | 给定 `runId`（可选 `ruleId`）→ 展开证据、迁移解释与练习 |
| `english_plan` | 规划 | 聚合最近 N 次诊断 → 高频模式与练习顺序 |
| `english_clear_records` | 管理 | 清空本插件本地记录（必须 `confirm: true`） |

---

## 数据不出本机（必读）

- **无网络调用**。插件代码里没有 `fetch` / `http` / `net` / `dns`，也没有任何云端 API 端点。启用网络开关的代码路径当前不存在（见 `security-plan.md` Q3）。
- **无子进程**。不使用 `child_process`，不拼 shell 命令。
- **唯一写入位置**：`$DSH_HOME/english-diagnosis/analysis.db`（本机 SQLite，`node:sqlite`）。
- **不保存原文**。库里只有：run 元数据（时间、字符数、输入哈希）、规则 ID、位置区间、≤160 字符的证据片段、下一步建议。没有 `raw_text` 列，没有音频列。
- **会话日志的真相**：DSH 会把工具入参和结果写进本机会话日志 `$DSH_HOME/sessions/*.jsonl`。插件无法阻止这件事，所以**原文仍会留在本机磁盘上**——这是宿主行为，不是本插件写入。
- **不采集年龄**，不针对未成年人做任何特殊数据采集或画像。用户若在文本里自述年龄，插件不据此改变任何数据行为。

## 安全边界

| 项 | 行为 |
|---|---|
| 会话权限 | **不改变** sandbox / approval 设置，不注册 `/permission` 之类的命令 |
| 工作区文件 | **不读**。分析输入只来自工具参数 |
| 目录遍历 | **不做**。无 `readdir` / glob / walk |
| 会话/聊天记录 | **不读**。不注入会话服务 |
| PII | 输出前替换为 `[[EMAIL_xxxxxxxx]]` / `[[PHONE_xxxxxxxx]]` / `[[ID_xxxxxxxx]]` / `[[SECRET_xxxxxxxx]]`，**不保存映射表**（每次进程随机 salt，不可逆） |
| 隐蔽字符 | 入参先剥离零宽字符、双向控制符、私用区字符，计数上报但不回显 |
| 输入上限 | 20000 字符，超限结构化拒绝 |

## 输出契约

```json
{
  "runId": "…",
  "analyzedChars": 812,
  "ruleSet": { "version": "l1-transfer-0.3.0", "ruleCount": 9 },
  "confidence": 0.68,
  "findings": [
    {
      "ruleId": "CHG_COLLOCATION_CALQUE",
      "ruleRef": "R-CHG-03",
      "category": "collocation",
      "title": "搭配直译（母语句式逐词对应）",
      "confidence": 0.78,
      "span": { "start": 118, "end": 133, "quote": "learn knowledge" },
      "evidence": { "ruleId": "CHG_COLLOCATION_CALQUE", "ruleRef": "R-CHG-03", "quote": "learn knowledge", "confidence": 0.78 },
      "nextStep": "换成英语里的固定搭配，并把替换后的句子放进一个新语境再写一次（不是背单词，是重述）。",
      "explain": "这类搭配在母语里成立、在英语里不成立，属于词汇层迁移，单靠语法检查器抓不到。"
    }
  ],
  "suggestions": [{ "id": "SUG-1", "ruleIds": ["CHG_COLLOCATION_CALQUE"], "text": "…", "generatedBy": "ai" }],
  "limits": ["…"],
  "sanitization": { "invisibleRemoved": 0 },
  "storage": { "scope": "$DSH_HOME/english-diagnosis/analysis.db", "persisted": true }
}
```

**每条 finding 都带 `evidence`**（原文片段、规则 ID、置信度），`nextStep` 是该条对应的可练习动作。`suggestions[].generatedBy` 恒为 `ai`。

## 安装到 DSH

```bash
# 在 profile 目录（如 ~/.dsh/profiles/desktop）中执行，
# 让 bundle 的 dsh.bundle.patch 与 engines.dsh 被识别
pnpm add link:E:\English learning\packages\english-diagnosis
```

然后把 `dsh-english-diagnosis` 加进该 profile `package.json` 的 `dsh.profile.bundles`。

> 注意：本包以 peer 方式依赖 `@deepseek-ai/dsh-tools`，需要 DSH 安装自带的该包可被解析；否则 pnpm 会要求从 registry 拉取。

## 不做什么

- 不划词翻译、不背单词、不打分、不给"是否合格"。
- 不做英语水平评级；输出不可用于选拔、惩罚或任何法律决定。
- 不引入第三方运行时依赖（当前 `dependencies: {}`）。

## 版本

| 阶段 | 规则集 | 状态 |
|---|---|---|
| 0.1.0-mock | mock-0.1.0（6 条） | 已废弃：仅验证链路 |
| 0.2.0 | l1-transfer-0.2.0（9 条） | 第一版真实规则 |
| 0.3.0 | l1-transfer-0.3.0（9 条） | 当前：4 个 Facade + 技能注册 + 门禁 + 轻动词搭配扩充 |
| 0.2.0 | 待定 | 接入真实分析逻辑（保持同一输出契约） |
