# 规则设计 v0.2 —— 抓哪些模式，为什么不抓另一些

> 适用版本：`l1-transfer-0.3.0`。本文回答一个问题：**在"不发明语言学"的前提下，哪 9 个模式值得做成确定性规则。**

## 1. 筛选标准（四条同时满足才入选）

1. **可判定**：不依赖句法分析器/POS 标注，表面文本 + 固定词表就能判定，误报可控。
2. **可解释为迁移**：不是泛泛的"语法错误"，而是能从汉语与英语的结构差异解释清楚——这是本插件与普通语法检查器的分界。
3. **有文献或语料库支持**：不是拍脑袋挑的"中式英语梗"。
4. **能落到一个练习动作**：每条规则必须能给出"下一步做什么"，否则只是批改。

## 2. 选定的 9 条

| ID | 层 | 现象 | L1 解释 | 误报控制 | 基础置信度 |
|---|---|---|---|---|---|
| `L1_BECAUSE_SO` | 句法 | because … so 同现 | 汉语「因为…所以」成对，英语只留一个 | 排除 `so that`；限定同一句内 | 0.80 |
| `L1_ALTHOUGH_BUT` | 句法 | although … but 同现 | 汉语「虽然…但是」成对 | 限定同一句内 | 0.80 |
| `L1_THERE_BE_HAVE` | 句法 | There are … have / There have … | 汉语「有很多人认为」整句搬用 | 中间出现 who/that/which 时跳过（那是合法的定语从句） | 0.85 |
| `L1_ARTICLE_OMISSION` | 句法 | play important role / as student | 汉语无冠词范畴 | 只锁两个高确定框架，不做泛化的"缺冠词"检测 | 0.70 |
| `L1_AND_CHAIN` | 句法 | >35 词且 ≥3 个 and | 汉语意合、英语形合，长句靠 and 平铺 | 长度 + 连接数双阈值 | 0.60 |
| `L1_VERY_VERB` | 句法 | very like / very want | 汉语「很+动词」合法，英语 very 不修饰动词 | 固定动词表 | 0.75 |
| `L1_COLLOCATION_CALQUE` | 搭配 | learn knowledge / open the light / discuss about | 词汇层逐词对应，语法全对、组合不成立 | 白名单式固定表，宁缺毋滥 | 0.78 |
| `L1_FORMULAIC_TEMPLATE` | 语篇 | with the development of / more and more / every coin has two sides | 应试模板，不是语言能力 | 固定短语表 | 0.65 |
| `L1_CONNECTIVE_OVERUSE` | 语篇 | 一段 ≥4 个显性连接词 | 汉语靠意合，学习者误以为"多用连接词=更学术" | 计数阈值，不做单个连接词的对错判断 | 0.68 |

**为什么是"确定性规则"而不是统计学模型**：可复现、可审计、可解释，且每条结论都能指回一个明确的触发条件。代价是召回率低（下面第 4 节）。

## 3. 明确排除的模式（以及为什么）

| 排除项 | 原因 |
|---|---|
| 时态/动词形式错误 | 文献显示这是中国学习者最高频的错误类别，但判定需要句法分析与时态语境，正则误报会很高；留到有 parser 或标注数据时再做 |
| 拼写错误 | 与"迁移"无关，是另一个问题域，且会稀释诊断 |
| 词性误用（如 `I very interest`） | 需要词性判断，固定表覆盖有限，容易把正常用法判错 |
| 泛化的"冠词缺失" | 只有两个高确定框架入选；泛化检测在没有 parser 时误报不可接受 |
| 介词误用（广义） | 除 `discuss about` / `married with` 这类高确定条目外，介词选择高度依赖语境 |
| 语篇宏观结构（论点-论据） | 需要篇章级建模，当前规则引擎做不到；留给 `english_plan` 那类 Facade |

## 4. 已知局限

- **召回率低**：9 条规则覆盖不了写作问题的主体，`limits` 字段已如实写明"未命中不等于没问题"。
- **搭配表是封闭的**：`L1_COLLOCATION_CALQUE` 只认表内条目，表外错误检测不到；扩表需要人工核对，不能自动生成。
- **`L1_CONNECTIVE_OVERUSE` 只能提示"密度高"**，不能判断用错；真正的误用（如 besides 当 moreover 用）需要语义判断。
- **阈值是经验值**（35 词、4 个连接词），不是从语料统计出来的；后续应以真实作文分布校准。

## 5. 证据来源

以下为本轮检索到的、与上述选择直接相关的公开文献（PDF 正文未能抓取，这里依据的是摘要与检索片段，不外推具体数字）：

- Zhan, H. (2015). *Frequent Errors in Chinese EFL Learners' Topic-Based Writings*. English Language Teaching, 8(5), 72–81. 摘要指出：时态/动词形式误用最高频，其次包括"Chinese-English expression"、单复数、词性、非谓语、**run-on sentences**、代词等。[记录](https://www.fachportal-paedagogik.de/en/literatur/vollanzeige.html?FId=eric_ej1075251)
- Sun, X. (2014). *Ungrammatical Patterns in Chinese EFL Learners' Free Writing*. English Language Teaching, 7(3), 176–183. 摘要指出：**限定词（determiners）误用**是最频繁的语法错误，其次是"Chinese-English expression"、时态、介词误用。[记录](https://www.fachportal-paedagogik.de/en/literatur/vollanzeige.html?FId=eric_ej1075686)
- 语料库研究片段（检索所得，未取全文）：中国学生写作中因果连接词 `so` 使用频率突出、连接词分布与母语者存在差异。[检索结果](http://www.korling.or.kr/data/thesis/21756839672882.pdf)

据此做出的判断：

- **限定词/冠词**有文献直接支撑 → 保留 `L1_ARTICLE_OMISSION`，但只做两个高确定框架（泛化检测推迟）。
- **run-on sentences** 有文献支撑 → 保留 `L1_AND_CHAIN`。
- **"Chinese-English expression"** 在两项研究里都出现 → 对应 `L1_COLLOCATION_CALQUE`，用固定表实现。
- **连接词**有语料库证据 → 保留 `L1_CONNECTIVE_OVERUSE`（只做密度，不做对错）。
- **because…so / although…but / there be + have / very + 动词**没有在这两篇摘要里被点名，但属于汉语-英语结构差异的教科书级例子，作为句法层的高精度补充入选；它们的置信度也相应设为中等偏上而非最高。

## 6. 下一步

1. 用真实作文校准阈值（35 词、4 个连接词）。
2. 搭配表按"错误 → 正确"成对扩充，每条标注来源。
3. 等有句法分析能力后，再补时态/词性这类高价值但高误报的模式。

## 7. 文献更新（2026-11-16，按你的要求改用权威期刊）

本轮检索到的、可核对的英文文献如下（PDF 正文受站点限制未能抓取，以下引用的是**摘要**与期刊元数据，不扩写具体数字）：

| 来源 | 期刊 / 出处 | 与本规则集的对应 |
|---|---|---|
| Jiang, S., & Zhang, H. (2022). *The features and factors in the acquisition of English existential constructions at the syntax–pragmatics interface by Chinese learners.* [Frontiers in Psychology, 13:983547](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.983547/full)（开放获取全文，CC BY） | 权威开放获取期刊 | 全文可读，明确：中国学习者**过量产出存在句**（there be），归因 L1 负迁移与输入频率 → 支撑并强化 `L1_THERE_BE_HAVE`，其解释已引用该结论 |
| Liu, N., Liu, X., & Baek, S. (2022). *The Use of 'Delexical Verb + Noun' Collocations by the Korean and Chinese EFL Learners: A Corpus-Based Study.* 교과교육학연구 (KCI 核心), 26(6), 545–555. [DOI](https://doi.org/10.24231/rici.2022.26.6.545) | 韩国核心期刊（英文摘要） | 摘要明确：中国学习者对 do/get/give/have/make/take 六类轻动词的「动词+名词」搭配**只反复使用极少数组合**，例如 *do/have a mistake（应为 make a mistake）。据此扩充 `L1_COLLOCATION_CALQUE` 表，加入轻动词混淆条目 |
| Zhan, H. (2015). *Frequent Errors in Chinese EFL Learners' Topic-Based Writings.* English Language Teaching, 8(5), 72–81. | ERIC 收录 | 时态/动词形式最高频；并列「Chinese-English expression」、run-on sentences、代词 → 支撑 `L1_AND_CHAIN` 与搭配规则 |
| Sun, X. (2014). *Ungrammatical Patterns in Chinese EFL Learners' Free Writing.* English Language Teaching, 7(3), 176–183. | ERIC 收录 | 限定词误用最高频；并列「Chinese-English expression」、介词误用 → 支撑 `L1_ARTICLE_OMISSION`（只做高确定框架） |
| Gao, C. (2008). *Corpus-based Analysis of Chinese EFL Students' Overuse of Certain Discourse Connectors in Writing.* 科技信息 17. | 非权威（省级期刊） | 指出 'what is more'、'that is to say' 被过度使用；**仅作弱参考**，`that is to say` 已加入连接词表，`what is more` 本就在表中 |

**据此做出的唯一代码改动**：把轻动词搭配混淆（do/make a mistake·decision·research·exercises·conclusion·plan）加入 `L1_COLLOCATION_CALQUE` 白名单，并把 `that is to say` 加入连接词密度表。没有新增规则、没有改动阈值——因为上面几篇摘要都没有给出可直接套用的阈值数字，我不编。

**诚实声明**：权威期刊的正文（如 *Journal of Second Language Writing*、*System* 上关于冠词/词块的具体错误清单）在本次抓取中不可达（PDF 被拒、部分站点 403）。当前更新只建立在**可核对的摘要**之上；要拿到"某类错误占比 X%"这类可用于校准阈值的硬数字，需要能打开全文的途径，或你提供可访问的全文。
