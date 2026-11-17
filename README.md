# English learning — DSH 插件工作区

一个 Facade 工具：`english_diagnose`。输入一段英语写作，输出**带证据的中式英语诊断**（原文片段 / 规则 ID / 置信度 / 下一步），不评分、不改写原文、不替代教师。

当前是 **v0.3**：4 个 Facade 工具（诊断 / 证据展开 / 学习路径 / 清空记录）、1 个已注册技能、20 条发布门禁，规则集为 `l1-transfer-0.3.0`（9 条确定性规则，依据见 [docs/rule-design.md](docs/rule-design.md)）。

```
security-plan.md                    # 6 类安全约束的实现落点与发布门禁
packages/english-diagnosis/         # 插件包（bundle）
  lib/core.mjs                      # 9 条规则 + 脱敏 + SQLite + 4 个工具定义
  lib/index.mjs                     # DSH 接线（注册工具 / prompt section / 技能）
  lib/skill.mjs                     # 注册给 Agent 的技能正文
  SKILL.md                          # 教师工作流 / 终止条件 / 局限性
  README.md                         # 数据不出本机、会话日志真相、输出契约
  cordis.patch.yml                  # 只挂 1 行，不挂 MCP、不改权限
scripts/
  audit.mjs                         # 发布门禁 G1–G10（静态扫描，20 项）
  verify-mock.mjs                   # 端到端跑真实 execute 路径 + 11 项安全检查
  verify-plugin-shape.mjs           # 4 个工具的 schema 与 DSH 转换器逐字节比对
  check-activation.mjs              # 只读探针：插件是否已在运行中的 DSH 激活
  fixtures/mock-essay.txt           # 示例作文
demo/english_diagnose.output.json   # 一次真实运行的输出
```

## 一键运行

本机 `pwsh` 是 Windows PowerShell 5.1，且只有 Electron 自带 Node 24（含 `node:sqlite`），所以用 Electron 当 Node：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_HOME='E:\English learning\.demo-home'      # 演示库；正式使用请用默认 ~/.dsh
& 'D:\111\DeepSeek Harness.exe' --expose-internals 'E:\English learning\scripts\verify-mock.mjs' `
    --file 'E:\English learning\scripts\fixtures\mock-essay.txt' `
    --out  'E:\English learning\demo\english_diagnose.output.json'
```

输出 JSON 到 stdout，安全检查到 stderr。最近一次：**11/11 通过，14 条 findings，整体置信度 0.79**。

schema 校验（用 DSH 安装里真实的 `defineTool`）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\111\DeepSeek Harness.exe' --expose-internals 'E:\English learning\scripts\verify-plugin-shape.mjs'
Get-Content 'E:\English learning\demo\shape-result.txt'
```

最近一次：**12/12 通过**（自写 schema 转换器与 DSH 自带转换器逐字节一致、schema 通过 `assertSupportedJsonSchema`、缺参/超长被拒、渲染产物为 text）。

## 安装状态（2026-11-16）

已链接进 desktop profile，**待重启生效**：

- `~/.dsh/profiles/desktop/package.json`：新增 `"dsh-english-diagnosis": "link:E:/English learning/packages/english-diagnosis"`，并把 `dsh-english-diagnosis` 加入 `dsh.profile.bundles`
- `pnpm install` 生成 `node_modules/dsh-english-diagnosis`（Junction → 包目录）
- bundle patch 用 `insert:` 挂 1 行；第一版写成裸 `id` 行，composer 报 `entry "english-diagnosis" not found`，已修正

**为什么要重启**：HMR 只在 profile 清单变化时重组，同内容的 touch 不触发重组；bundle 的 patch 文件在包目录里，不在监听范围内。已用一个隔离 profile 跑 `--dump-config`，确认这一行能正确组合进树。

重启后：

1. 工具列表出现 `english_diagnose`
2. 第一次调用在 `$DSH_HOME/english-diagnosis/analysis.db` 建库，并写一条 activation 记录
3. 跑 `scripts/check-activation.mjs` 可确认是否真的激活

回滚（任一步之后重启）：

```powershell
$p = "$env:DSH_PROFILE_DIR"
Copy-Item "$p\package.json.bak-20261116-160846" "$p\package.json" -Force
Copy-Item "$p\cordis.patch.yml.bak-20261116-160846" "$p\cordis.patch.yml" -Force
Set-Location $p; pnpm install
```

## 安全摘要

- 数据不出本机：无网络、无子进程、唯一写入 `$DSH_HOME/english-diagnosis/analysis.db`。
- 不保存原文：只有规则 ID、位置、≤160 字符证据片段；重跑需重新粘贴。
- DSH 会话日志仍会记录工具入参与结果（宿主行为，插件拦不住），README 已如实声明。
- 输出前统一脱敏：邮箱 / 手机号 / 身份证 / 凭据样式串 → `[[TYPE_hash8]]`，无映射表；不可见字符先剥离。
- 详见 [security-plan.md](security-plan.md)。
