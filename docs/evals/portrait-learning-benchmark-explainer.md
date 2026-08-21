# 画像特征抽取与 Benchmark 说明

更新日期：2026-08-22

## 1. 结论摘要

OnlyLove 当前不是通过后训练或微调模型参数来“学习”成员，而是持续执行下面的增量画像提取：

```text
当前画像草稿 + 本轮新增成员证据
              ↓
       画像提取 Agent
              ↓
       新的完整画像草稿
```

Benchmark 复用了生产环境的 Agent Engine、画像提取 Prompt 和输出 Schema，对同一组合成人物依次测试：

1. 只提供 10 道固定题时能恢复多少最终人物特征；
2. 在第一阶段画像上继续加入对话后，能否补全信息并纠正旧理解。

最终冻结金标后的真实 Ark 先导结果：

| 阶段 | Precision | Recall | F1 |
|---|---:|---:|---:|
| 仅固定 10 题 | 51.5% | 42.5% | 46.6% |
| 固定题 + 后续对话 | 82.9% | 85.0% | 84.0% |

F1 提升 37.4 个百分点，无证据或预设虚假事实 veto 为 0。这个结果说明具体对话明显有用，但 3 个合成案例还不足以形成发布门槛。

## 2. 生产环境如何从聊天中抽取特征

### 2.1 固定题先保存为成员证据

固定题答案不会直接修改画像。系统会先把问题、选项答案和成员补充保存成一条 `INTERVIEW` 成员消息，例如：

```text
固定访谈 4/10：有件可能让伴侣不舒服的事需要说时，你通常会怎么开口？
回答：面对面难说时，更愿意先用文字整理清楚
```

每条消息都有唯一 ID 和递增顺序号：

```json
{
  "id": "message-4",
  "sequence": 4,
  "content": "固定访谈 4/10……"
}
```

第 10 题完成后，系统创建访谈 Agent 作业。作业首先调用画像提取器，再让画像访谈员根据最新画像提出下一道问题。

### 2.2 提取器收到旧画像和新增证据

第一次提取时：

```text
currentDraft     = 空的八维画像
evidenceMessages = 10 道固定题证据
```

后续成员继续聊天时，画像草稿记录的 `lastMessageSequence` 用于筛选尚未处理的成员消息：

```text
message.sequence > lastMessageSequence
```

因此后续提取是：

```text
currentDraft     = 上一次完整画像
evidenceMessages = 本轮新增成员消息
```

提取器每次返回完整画像，而不是只返回发生变化的字段。Prompt 要求：

- 只依据新增证据更新画像；
- 没有证据时保留旧值或低置信度；
- 出现冲突时写入 `contradictions`；
- 每个结论只引用实际支持它的消息 ID；
- 始终返回完整八维结构。

### 2.3 八个画像维度

画像包含八个关系维度：

1. 长期规划 `long_term_planning`
2. 价值观 `values`
3. 关系边界 `relationship_boundaries`
4. 沟通方式 `communication`
5. 冲突修复 `conflict_repair`
6. 情绪支持 `emotional_support`
7. 生活方式 `lifestyle`
8. 家庭与财务 `family_and_finance`

每个维度包含三个核心语义槽位：

| 字段 | 含义 | 示例 |
|---|---|---|
| `selfTendency` | 成员自己通常怎么判断或行动 | 难开口时先用文字整理 |
| `partnerExpectation` | 成员明确希望伴侣怎么做 | 希望对方直接但温和地表达 |
| `hardBoundary` | 成员明确不能接受什么 | 不接受连续两天不回应 |

所以每个人有：

```text
8 个维度 × 3 个核心语义字段 = 24 个候选槽位
```

“候选槽位”不等于必须填满。材料没有明确表达时，正确结果应该是 `null`。

### 2.4 一个维度的完整数据结构

```json
{
  "communication": {
    "selfTendency": "难开口时会先用文字整理，之后当面谈清楚",
    "partnerExpectation": "希望对方直接表达，同时注意措辞和时机",
    "hardBoundary": "不能接受用长期沉默代替沟通",
    "importance": 4,
    "confidence": "high",
    "evidenceMessageIds": [
      "fixed:hard-conversation",
      "dialogue:space-disagreement"
    ],
    "contradictions": []
  }
}
```

其中只有前三个自然语言字段属于 24 个特征槽位。其他字段用于控制和审计：

- `importance`：这个维度的重要程度；
- `confidence`：模型对当前结论的置信度；
- `evidenceMessageIds`：支持该维度结论的成员消息；
- `contradictions`：旧证据和新证据之间的冲突。

材料不足时应保持未知：

```json
{
  "partnerExpectation": null,
  "confidence": "low",
  "evidenceMessageIds": []
}
```

### 2.5 生产环境的结构校验

模型输出后，系统会检查：

- JSON 是否符合画像 Schema；
- 是否完整包含八个维度；
- 引用的消息 ID 是否真实存在；
- 中高置信度维度是否至少引用一条证据。

如果 JSON 不符合 Schema，画像提取器会获得 Schema、上次输出和校验错误，再修复一次。

生产校验有一个重要边界：它可以确认“证据 ID 存在”，但不能完全确认“该证据在语义上支持这个结论”。例如真实存在的沟通消息，不能自动证明成员有某项财务边界。Benchmark 因此增加了人工金标中的语义和证据对应检查。

### 2.6 下一轮访谈问什么

画像保存后，访谈问题按照下面的优先级规划：

```text
1. 成员明确说“不像我、不准确、理解错了”
2. 第一个低置信度维度
3. 存在矛盾的维度
4. 常见画像薄弱点
```

常见薄弱点包括：

- 只有偏好，没有明确边界；
- 只有期待，没有具体场景；
- 说某件事重要，却没有表达愿意承担的代价。

于是完整循环是：

```text
成员回答
   ↓
保存为有 ID 的原始证据
   ↓
旧画像 + 本轮新增证据
   ↓
生成新的完整画像
   ↓
检查 Schema、置信度和证据 ID
   ↓
保存画像与 lastMessageSequence
   ↓
根据纠正、低置信度或矛盾规划下一问
```

## 3. Benchmark 如何复刻生产抽取逻辑

### 3.1 合成人物数据

当前先导数据集包含三类合成人物：

- `consistent`：后续对话主要补充固定题细节；
- `correction`：后续对话明确纠正固定题造成的错误理解；
- `context_dependent`：不同场景下行为不同，需要提取条件和边界。

每个案例包含：

```text
10 道真实固定题答案
+
3～4 条完整后续对话
+
人工定义的最终画像金标
+
禁止出现的虚假事实
```

### 3.2 阶段 A：只提供固定 10 题

```text
空画像 + 10 道固定题
          ↓
      baseline 画像
```

Baseline 使用完整人物的最终金标评分，包括只在后续对话中才会明确的信息。它回答的是：

> 只靠固定 10 题，能够恢复最终人物多少真实特征？

因此这个阶段 Recall 较低是合理现象，不代表模型完全没有理解固定题。

### 3.3 阶段 B：加入后续对话

```text
baseline 画像 + 仅新增对话
              ↓
          refined 画像
```

它对应生产环境的：

```text
currentDraft + newEvidence
```

两个阶段使用相同的模型、Agent Engine、Prompt、Schema 和最终金标，唯一主要变化是是否提供后续对话。这是成对消融实验，用于衡量“继续聊天”给画像质量带来的增益，而不是比较两个不同人物或训练两个不同模型。

## 4. 金标与评分规则

### 4.1 金标不要求逐字复述

例如对话中成员说：

> 我会先把理由写下来，第二天当面谈清楚。

金标可以写成：

```json
{
  "dimension": "communication",
  "field": "selfTendency",
  "concepts": [
    ["写", "文字"],
    ["第二天"],
    ["当面", "谈清"]
  ],
  "evidenceIds": ["dialogue:space-disagreement"]
}
```

组与组之间是 AND，组内同义表达是 OR。模型必须同时表达三个核心概念，并引用正确证据。

### 4.2 单槽位判分

只有 `medium` 或 `high` 置信度的特征算作模型正式提取；低置信度按未形成结论处理。

| 金标 | 模型输出 | 结果 |
|---|---|---|
| 应该有 | 内容和证据都正确 | TP |
| 应该有 | 内容或证据错误 | FP + FN |
| 应该有 | 没有输出 | FN |
| 应该为空 | 模型自行增加特征 | FP |
| 应该为空 | 保持为空 | TN |

一个错误预测同时记 FP 和 FN，是因为它既漏掉了正确答案，又输出了错误答案。

### 4.3 汇总指标

```text
Precision = TP / (TP + FP)
Recall    = TP / (TP + FN)
F1        = 2 × Precision × Recall / (Precision + Recall)
```

指标含义：

- Precision：模型写出的特征有多少可信，低分通常代表过度推断；
- Recall：人物真实特征找到了多少，低分通常代表漏提取或没有吸收纠正；
- F1：同时平衡“不要乱写”和“不要漏掉”；
- Slot accuracy：24 个候选槽位中有多少判断正确，作为辅助指标。

所有案例先汇总 TP、FP、FN、TN，再计算 micro-average，不是简单平均每个案例的百分比。

### 4.4 一票否决

下列情况单独记录 veto，不允许通过多写其他正确内容抵消：

- 引用了输入中不存在的证据 ID；
- 中高置信度结论完全没有证据；
- 输出了预设禁止的虚假事实，例如“已经负债”；
- 编造人物没有提供的重大经历或现实计划。

## 5. 两类主要错误

### 5.1 纠正没有传播到正确槽位

固定题先产生两个旧结论：

```json
{
  "values": {
    "selfTendency": "面对价值分歧时倾向回避"
  },
  "communication": {
    "selfTendency": "困难沟通时容易拖延"
  }
}
```

成员后来纠正：

> 固定题里选了不想争，但那不准确。我不是逃避价值分歧；我会先把理由写下来，第二天当面谈清楚。

这条消息实际包含两个维度：

| 内容 | 应更新位置 |
|---|---|
| 我不是逃避价值分歧 | `values.selfTendency` |
| 先写理由，第二天当面谈 | `communication.selfTendency` |

正确结果应该同时更新两个槽位：

```json
{
  "values": {
    "selfTendency": "不会逃避价值分歧，愿意继续讨论"
  },
  "communication": {
    "selfTendency": "先用文字整理理由，第二天当面谈清楚"
  }
}
```

实测中，模型修正了价值观，却继续保留旧沟通结论“容易拖着不说”。它识别了这是一条价值观纠正，却没有把后半句话拆成沟通方式的新证据。

这个错误同时造成：

- FN：正确的新沟通特征没有被提取；
- FP：已经被纠正的旧沟通特征仍然存在。

根因是当前更新由模型一次性完成，没有确定性字段映射器告诉模型某个句子必须更新哪些维度。生产校验也无法自动判断“第二天当面谈”和“容易拖着不说”在语义上冲突。

### 5.2 把自我倾向过度推断成伴侣期待

原始证据：

> 冲突后，我会冷静下来复盘发生了什么。

它只明确支持：

```json
{
  "conflict_repair": {
    "selfTendency": "冲突后会主动复盘问题"
  }
}
```

模型有时会继续补全：

```json
{
  "conflict_repair": {
    "partnerExpectation": "希望伴侣一起复盘并讨论改进方式"
  }
}
```

这个推断在心理上可能合理，但证据没有说明成员要求伴侣采用相同方式。成员也可能只是自己复盘，并不要求对方参与。

按照 OnlyLove 的证据原则：

```text
成员明确表达 > 保留槽位
模型觉得可能合理 > 保持未知
```

所以金标中的 `partnerExpectation` 为空，模型填入内容会产生一个 FP，主要降低 Precision。

这个错误说明：

```text
证据 ID 真实存在
不等于
证据语义支持模型结论
```

在隐藏画像和匹配系统中，这种过度推断尤其危险，因为它以后可能影响候选筛选、推荐理由或边界判断。

## 6. 如何解读当前结果

### 6.1 固定 10 题为什么只有 46.6% F1

固定题适合快速获得粗粒度倾向，例如：

- 偏向共同规划；
- 喜欢保留个人空间；
- 情绪支持时倾向先倾听。

但它通常无法明确表达：

- 具体边界；
- 不同场景下的例外；
- 对伴侣的明确期待；
- 固定选项是否准确；
- 为某个目标愿意承担什么代价。

### 6.2 后续对话为什么提高到 84.0% F1

后续对话提供了具体场景、条件限制、纠正、硬边界和行为细节，使 Recall 从 42.5% 提升到 85.0%。更具体的证据也减少了模型依赖模糊选项自行补全，Precision 从 51.5% 提升到 82.9%。

### 6.3 当前结论边界

Benchmark 目前证明：

> 在固定模型、生产 Prompt 和生产 Schema 下，加入具体后续对话能够明显提高画像特征提取质量。

它尚未证明：

- 访谈 Agent 自动提出的问题一定高质量；
- 模型能正确理解“是的”“差不多”等依赖上文的短回答；
- 恋爱分身在未知场景中的回答一定像真人；
- 84.0% 是稳定的生产准确率；
- 不同模型版本或多次随机运行都能保持相同结果。

当前提取器只把成员消息作为证据。固定题消息自带完整问题，但动态聊天中如果成员只回复“是的”，提取器未必获得足够的提问上下文。现有数据集中的后续消息都是可以独立理解的完整句子，所以暂时没有覆盖这个风险。

## 7. 运行命令

确定性检查，不消耗真实模型 Token：

```bash
npm test -w evals
```

只运行画像学习成对 Benchmark：

```bash
npm run benchmark -w evals -- --portrait-learning
```

运行全部已有真实模型 Benchmark：

```bash
npm run benchmark -w evals
```

真实模型 Benchmark 需要配置 Ark API Key、固定模型 ID 和 Token 单价信息。

## 8. 相关代码

- 固定题与八维定义：[`server/src/modules/portraits/questions.ts`](../../server/src/modules/portraits/questions.ts)
- 画像数据结构：[`server/src/modules/portraits/schema.ts`](../../server/src/modules/portraits/schema.ts)
- 增量提取与证据校验：[`server/src/modules/portraits/service.ts`](../../server/src/modules/portraits/service.ts)
- Agent Engine 结构化输出：[`server/src/modules/agent-engine/engine.ts`](../../server/src/modules/agent-engine/engine.ts)
- 合成人物与金标：[`evals/portrait-learning-cases.json`](../../evals/portrait-learning-cases.json)
- 确定性评分器：[`evals/portrait-learning.ts`](../../evals/portrait-learning.ts)
- 真实模型 Runner：[`evals/benchmark.ts`](../../evals/benchmark.ts)
- 数据与评分器检查：[`evals/check.ts`](../../evals/check.ts)
- 总体 Benchmark 计划：[`docs/evals/benchmark-plan.md`](benchmark-plan.md)

