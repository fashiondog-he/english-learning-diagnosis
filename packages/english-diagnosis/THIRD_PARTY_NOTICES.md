# Third-party notices

本插件当前**没有第三方运行时依赖**（`dependencies: {}`）。以下为使用到的平台能力与规则来源说明。

## 运行时依赖

| 名称 | 版本 | License | 来源 | 是否随插件分发 |
|---|---|---|---|---|
| Node.js 内建 `node:sqlite` | Node 24.21 | MIT（Node.js） | nodejs.org | 否（宿主提供） |
| Node.js 内建 `node:crypto` / `node:fs` / `node:os` / `node:path` | 同上 | MIT（Node.js） | nodejs.org | 否（宿主提供） |
| `@deepseek-ai/dsh-tools`（peer） | 0.2.2-rc.1 | MIT | DSH 安装自带 | 否（peer） |

## 规则集来源

`l1-transfer-0.3.0` 的 9 条规则由本项目自行编写（固定正则 + 固定搭配表），判定标准与文献依据见 `docs/rule-design.md`，**没有**从论文、词典或专有工具移植代码。因此本插件整体可按 MIT 授权。

## 明确不纳入

- 任何 CC BY-NC 系列、禁止商用的词典/语料数据。
- 任何来源不明、无法审计源码的 MCP Server。
- 任何需要联网下载模型权重的组件（当前版本无模型）。

## 未来引入依赖时

必须在本文件补：名称、License、来源 URL、是否随插件分发；禁止商用的条目一律不收。
