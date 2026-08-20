# LLM 供应商对比（截至 2026-08-20）

## 结论

1. **百炼已有三个官方 Qwen 3.8 调用 ID。**`qwen3.8-max`、`qwen3.8-2.4t-a95b`、`qwen3.8-27b` 分别于 2026-08-03、08-12、08-19 上线；截至本文日期未找到 `qwen3.8-plus` 或任何 3.8 日期快照。因此不能把不存在的“3.8 Plus 固定版”写进生产配置。[百炼模型更新记录](https://help.aliyun.com/zh/model-studio/newly-released-models)
2. **3.8 应进入 benchmark，但不应只因版本新就成为默认模型。**在本文基准用量下，3.8 Max 与 2.4T-A95B 均约 ¥576/月，3.8 27B 约 ¥162/月，固定版 3.7 Plus 约 ¥108/月；对应约为 3.7 的 5.3 倍、5.3 倍和 1.5 倍。只有同一恋爱场景 benchmark 证明收益足够大时，才值得用于某个角色。
3. **火山方舟值得进入同一 benchmark。**官网当前列出 Doubao-Seed-2.1 Pro、Turbo 和 Character；Pro/Turbo 价格分别是 ¥6/30、¥3/15（每百万输入/输出 token），Character 是 ¥0.8 起/2。[豆包产品与价格页](https://www.volcengine.com/product/doubao)
4. **不能从公开资料中确认 Seed 2.1 的日期型 API ID、上下文长度和严格 JSON Schema 支持。**这些字段应在方舟控制台或销售合同中确认，不能按产品展示名猜测后硬编码。
5. **模型选择必须按四个角色分别 benchmark：画像访谈、画像提取、公开分身、配对评估。**厂商对“Agent”“角色扮演”或“强推理”的宣传不能证明恋爱分身相似度或匹配质量。

## 一、百炼：Qwen 3.8 与 3.7

### Qwen 3.8 的准确状态

| 官方调用 ID | 上线日期 | 官方公开长度信息 | 北京区原价（输入/输出，元/百万 token） | 固定版本状态 |
|---|---:|---|---:|---|
| `qwen3.8-max` | 2026-08-03 | 1M 上下文；最大输入 991,808，思考模式最大输入 983,616；最大输出 131,072 | 12 / 36 | 未找到日期快照 |
| `qwen3.8-2.4t-a95b` | 2026-08-12 | 1M 上下文 | 12 / 36 | 未找到日期快照 |
| `qwen3.8-27b` | 2026-08-19 | 定价表允许单次输入不超过 1M；公开页未给出独立的总上下文/最大输出参数表 | 3 / 12 | 未找到日期快照 |

型号和日期来自 [百炼模型更新记录](https://help.aliyun.com/zh/model-studio/newly-released-models)，开源型号的北京区输入范围与价格来自 [百炼模型价格页](https://help.aliyun.com/zh/model-studio/model-pricing)，Max 的完整长度参数来自 [Qwen3.8 Max 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-max)。这些 ID 是明确型号，但官方没有把它们称为日期快照，也没有承诺行为冻结；生产和 benchmark 都应记录响应中的实际模型版本。

百炼 OpenAI 兼容接口支持 `stream`/SSE；官方 Qwen3.8 系列说明支持 Function Calling 与结构化输出，Max 的型号表也逐项确认这两项能力。[OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) [Qwen 文本模型能力表](https://help.aliyun.com/zh/model-studio/text-generation-model) [Qwen 视觉模型能力表](https://help.aliyun.com/zh/model-studio/vision-model) [结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output) [Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling) 但“结构化输出”不等于 OnlyLove 的业务 Schema 一定一次通过；三个具体 ID 都应做流式、工具参数和 Schema 校验集成测试。

因此“为什么不接 3.8”的准确回答不是“没有 3.8”，而是：**已经有 Max、2.4T-A95B 与 27B；它们都没有可核实的日期快照，应先在同一 benchmark 中与固定版 3.7 Plus 比质量、成本和稳定性。**

### 可复现基线：Qwen 3.7 Plus 固定快照

生产评测可先使用 `qwen3.7-plus-2026-05-26`。官方明确它是 2026-05-26 快照，1M 上下文，最大输入/输出与 3.8 Max 相同，并支持 Function Calling 和结构化输出。北京区单次输入不超过 256k 时，输入/输出原价为 ¥2/¥8；超过 256k 至 1M 时为 ¥6/¥24。[Qwen3.7 Plus 官方模型页](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)

这使 3.7 Plus 适合当第一条稳定基线：不是预判它更懂恋爱，而是因为**日期快照可复现且成本低**。3.8 Max 必须在相同数据、Prompt、输出 Schema 和评分器下击败它。

### 北京区数据边界

百炼官方地域文档说明：华北 2（北京）的服务部署范围是中国内地；请求数据存于接入地域，推理在部署范围内执行，过程数据不持久化且传输加密，静态数据始终存于所选地域。[地域及接入域名](https://help.aliyun.com/zh/model-studio/regions/)

百炼 FAQ 进一步明确：不会将客户数据用于模型训练，但会按法律法规要求存储模型与应用调用数据；请求/响应正文只有在用户开启推理日志后才被采集到可查询日志。[百炼 FAQ](https://help.aliyun.com/zh/model-studio/faq-about-alibaba-cloud-model-studio) [模型监控与推理日志](https://help.aliyun.com/zh/model-studio/model-telemetry)

OnlyLove 应使用北京业务空间专属域名，不使用新加坡或全球部署范围，并关闭非必要的推理正文日志。

## 二、火山方舟：当前可测试的豆包模型

### 候选模型

字节 Seed 官方于 2026-06-23 发布 Seed 2.1，并说明 Pro/Turbo API 同步上线火山引擎；这能确认系列和产品名，不能替代方舟控制台里的实际 Model ID。[Seed 2.1 发布公告](https://seed.bytedance.com/zh/blog/seed2-1-officially-released-advancing-ai-productivity)

| 模型/产品名 | 适合进入哪个测试组 | 官方按量原价（元/百万 token） | 已确认与未确认项 |
|---|---|---:|---|
| Doubao-Seed-2.1 Pro | 画像提取、配对评估 | 输入 6 / 输出 30 | 官网确认产品名和价格；公开文档未确认日期型 API ID、上下文与严格 JSON Schema |
| Doubao-Seed-2.1 Turbo | 画像访谈、公开分身；也可作低成本全角色基线 | 输入 3 / 输出 15 | 同上 |
| Doubao-Seed-Character | 公开分身专项 | 输入 0.8 起 / 输出 2 起 | 官网称面向虚拟陪伴/角色扮演；价格是“起”，不能当成所有请求的固定单价；结构化提取能力未确认 |

价格和产品定位来自 [豆包官方产品页](https://www.volcengine.com/product/doubao)。Character 可以参加“像不像本人”的专项测试，但不能因“角色扮演”宣传就直接承担画像提取或配对评分。

### API、版本和能力边界

- 方舟北京区 OpenAI 兼容基地址为 `https://ark.cn-beijing.volces.com/api/v3`，Chat API 的 `stream: true` 通过 SSE 返回；Responses API 支持函数调用。[方舟快速开始](https://www.volcengine.com/docs/82379/1795150) [Chat API](https://api.volcengine.com/api-explorer/?action=ChatCompletions&groupName=%E5%AF%B9%E8%AF%9D%28Chat%29+API&serviceCode=ark&version=2024-01-01) [Responses 工具调用](https://www.volcengine.com/docs/82379/1958524)
- 方舟提供结构化输出功能页和推理接入点（Endpoint）机制；接入点可关联模型引用。[结构化输出](https://www.volcengine.com/docs/82379/1568221) [获取推理接入点](https://api.volcengine.com/api-explorer/?action=GetEndpoint&groupName=%E6%8E%A8%E7%90%86%E6%8E%A5%E5%85%A5%E7%82%B9&serviceCode=ark&version=2024-01-01)
- 但截至本文日期，公开文档未给出 Seed 2.1 Pro/Turbo 的准确日期型 API ID、上下文窗口或逐型号严格 JSON Schema 支持表。**不能把展示名自行转换成 `doubao-seed-2-1-...`。**接入前应在控制台读取实际 Model ID，若存在固定版本则把 Endpoint 绑定该版本，并把实际返回的模型版本记入每次 benchmark 和生产结果。
- 若控制台只提供滚动别名，Endpoint 也不能被假定为冻结模型；检测到实际模型版本变化时必须重跑 benchmark。

### 数据地域与训练条款

已能由官方材料确认：

- API 使用 `cn-beijing`/北京域名；火山引擎信任中心称客户数据归客户所有，平台不拥有、窥探或转售客户数据，并提供加密、隔离和审计能力。[火山引擎隐私信任中心](https://www.volcengine.com/trust/privacy) [安全体系](https://www.volcengine.com/trust/security)
- 《豆包模型服务协议》第 3.1 条明确：默认不使用客户提交内容或服务输出训练、重新训练或改进基础模型；例外是客户主动同意《数据授权使用协议》或参加协作奖励计划。因此 OnlyLove 账号不得勾选这两类额外授权。[豆包模型服务协议](https://www.volcengine.com/docs/82379/1142195?lang=zh)
- 方舟推理数据回流到私有 AI 数据湖需要用户主动开启，当前只支持华北 2（北京）；官方称未经授权时数据仅客户可见、可用、所有。[推理数据回流](https://www.volcengine.com/docs/6492/1527075)

公开材料中仍**无法确认**：标准在线推理 Prompt/响应的完整留存期，以及一条与百炼地域文档同等明确的“静态数据与推理始终不出中国内地”承诺。`cn-beijing` 域名本身不能替代数据驻留条款。真实亲密对话上线前，应通过方舟服务合同/DPA 或工单书面确认：处理地域、留存期、日志默认状态、删除机制和分包商，并确认账号没有启用上述训练例外授权。

## 三、同口径价格与月成本

### 基准工作量

- 100 名内测用户。
- 每人每月合计 300,000 输入 token + 60,000 输出 token，覆盖画像访谈、提取、分身聊天和配对评估。
- 全站每月：30M 输入 + 6M 输出 token。
- 不计免费额度、限时折扣、Batch、缓存命中和套餐；按官方按量原价。
- 假设每次请求都落在 Qwen 3.7 的 `≤256k` 和 MiniMax M3 的 `≤512k` 价格档。
- “输出 token”包含供应商计费口径内的思考 token；真实账单应以 API `usage` 为准。

公式：`月成本 = 30 × 输入单价 + 6 × 输出单价`。

| 直接供应商模型 | 上下文 | 输入/输出单价（元/百万 token） | 基准月成本 | 官方来源 |
|---|---:|---:|---:|---|
| Qwen `qwen3.8-max`（百炼北京） | 1M | 12 / 36 | **¥576.0** | [模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-max) |
| Qwen `qwen3.8-2.4t-a95b`（百炼北京） | 1M | 12 / 36 | **¥576.0** | [模型更新与价格](https://help.aliyun.com/zh/model-studio/model-pricing) |
| Qwen `qwen3.8-27b`（百炼北京） | 单次输入 ≤1M；完整上下文参数未公开 | 3 / 12 | **¥162.0** | [模型更新与价格](https://help.aliyun.com/zh/model-studio/model-pricing) |
| Qwen `qwen3.7-plus-2026-05-26`（≤256k/请求） | 1M | 2 / 8 | **¥108.0** | [模型页](https://help.aliyun.com/zh/model-studio/qwen3-7-plus) |
| Doubao-Seed-2.1 Pro | 官方公开页未确认 | 6 / 30 | **¥360.0** | [豆包产品页](https://www.volcengine.com/product/doubao) |
| Doubao-Seed-2.1 Turbo | 官方公开页未确认 | 3 / 15 | **¥180.0** | [豆包产品页](https://www.volcengine.com/product/doubao) |
| DeepSeek `deepseek-v4-pro` | 1M | 3 / 6 | **¥126.0** | [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| DeepSeek `deepseek-v4-flash` | 1M | 1 / 2 | **¥42.0** | [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| Kimi `kimi-k3` | 1M | 20 / 100 | **¥1,200.0** | [Kimi API 开放平台](https://platform.kimi.com/) |
| MiniMax `MiniMax-M3`（≤512k/请求，标准层） | 1M | 2.1 / 8.4 | **¥113.4** | [MiniMax 按量计费](https://platform.minimaxi.com/docs/guides/pricing-paygo) [模型说明](https://platform.minimaxi.com/docs/guides/text-generation) |

Doubao-Seed-Character 按官网“起步价”计算的理论下限是 ¥36/月，但官方未给出本文工作量对应的完整阶梯规则，因此不放入可直接排序的成本结论。

价格只决定通过质量门槛后的排序。便宜模型如果提高严重失真率、Schema 失败率或错误配对率，就是更贵的产品选择。

## 四、Pi 接入

Pi AI 官方当前内置 DeepSeek、MiniMax 和 **Kimi For Coding** 等 Provider，并支持任意 OpenAI-compatible API；内置清单未列 Qwen/百炼或火山方舟。[Pi AI README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)

因此 MVP 的最小接法是：

- DeepSeek、MiniMax：优先使用 Pi 内置 Provider，但仍显式固定模型 ID。
- Kimi：Pi 内置的是 Kimi For Coding（Anthropic-compatible），不能据此假设已内置 `kimi-k3` 通用 API；若使用 K3，按其官方 API 单独配置。
- 百炼、方舟：使用 `pi-ai` 的 OpenAI-compatible provider/createProvider 能力，分别配置 `baseUrl`、API Key、模型元数据和兼容参数；不要引入 Coding Agent 的文件或 Shell 工具。Pi 的 Provider/模型扩展接口见 [模型与自定义 Provider 设计](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/models.md)。
- 对百炼需要验证 `enable_thinking`/JSON Mode/工具参数兼容性；对方舟需要验证实际 Model ID、`thinking` 字段、结构化输出和流式 usage。不能因为两者都写“OpenAI compatible”就假设所有扩展字段一致。

Agent Engine 继续只向业务暴露 `continueInterview`、`extractPortrait`、`replyAsTwin`、`evaluatePair`；Provider 差异留在内部。无需另建 LLM 网关服务。

## 五、用同一 benchmark 选型

### 同一输入、不同角色分别过线

| 角色 | 首轮候选 | 必测指标 | 选择规则 |
|---|---|---|---|
| 画像访谈 | Qwen 3.7 Plus、Qwen 3.8 27B、Doubao 2.1 Turbo、MiniMax M3、DeepSeek V4 Flash | 维度覆盖率、追问相关性、诱导性提问率、用户中途退出率、流式首 token 延迟 | 先过安全与访谈质量线，再按成本/延迟选 |
| 画像提取 | Qwen 3.7 Plus、Qwen 3.8 27B/Max、Doubao 2.1 Pro、DeepSeek V4 Pro、MiniMax M3 | Schema 一次通过率、来源片段可追溯率、事实编造率、同输入重复一致性 | 严格 Schema 和证据约束不过线即淘汰 |
| 公开恋爱分身 | Qwen 3.7 Plus、Qwen 3.8 27B、Doubao 2.1 Turbo、Doubao Character、MiniMax M3 | 本人盲评相似度、未授权信息泄露率、关键事实编造率、候选人严重失真率、跨轮一致性 | 相似度不能抵消隐私泄露或事实编造 |
| 配对评估 | Qwen 3.7 Plus、Qwen 3.8 27B/Max、Doubao 2.1 Pro、DeepSeek V4 Pro、MiniMax M3 | 硬边界零漏判、双向得分顺序不变量、理由与画像证据一致、重复运行排序稳定性 | 先过不变量，再比较人工盲评和成本 |

### Benchmark 运行规则

1. 当前仓库保留一套版本化案例：访谈、画像提取、分身、配对四个子集；每个模型使用同一 Prompt、上下文、工具定义、Schema、temperature/思考预算和重试上限。
2. 同时记录 `provider`、请求模型 ID、响应实际模型 ID、Prompt/规则版本、Schema 版本、token 用量、延迟和完整错误。
3. 确定性规则先自动判分：Schema、硬边界、禁止泄露、来源引用、事实一致性。主观相似度由本人/盲评者打分，不让另一个 LLM 单独决定。
4. 每个案例至少重复 3 次，比较平均质量和最坏一次；“偶尔特别好”不能掩盖严重失真。
5. 固定模型、Prompt 或规则变更时重跑全套；滚动别名检测到实际版本变化时同样重跑。
6. 先设置质量门槛，再用月成本和 P95 延迟作为通过者之间的决胜项。

### 可用性与自动切换

自动切换可以做，但只能切到**已经通过同角色 benchmark** 的备用模型：

- 超时、429 或 5xx：短暂重试主模型后切备用供应商。
- 画像提取和配对评估：整项任务幂等重跑，不能把两家模型的半截输出拼接起来。
- 访谈和分身：备用模型重新加载同一 `profile_version_id`、Prompt 和披露边界；内部记录切换事件，方便排查“前后不像”。
- Schema、事实或安全校验失败不是基础设施故障；按既定的一次修复重试后任务失败，不应无限换模型直到碰巧通过。

## 当前建议

- **基线主模型**：`qwen3.7-plus-2026-05-26`，理由是固定快照、能力字段完整且成本低，不是预判恋爱效果最好。
- **必须参评**：`qwen3.8-27b`、`qwen3.8-max`、Doubao-Seed-2.1 Pro/Turbo、DeepSeek V4 Pro/Flash、MiniMax M3；公开分身额外测 Doubao-Seed-Character。`qwen3.8-2.4t-a95b` 与 Max 同价，作为可选挑战者；不要假设两者效果相同。
- **暂不定供应商**：先跑同一 benchmark。3.8 27B 的成本约为固定版 3.7 Plus 的 1.5 倍，Max/2.4T-A95B 约为 5.3 倍；只有某个角色的质量增益覆盖差价时，才在该角色启用。
- **接方舟前的阻塞核验**：从控制台/工单取得 Seed 2.1 精确 Model ID、上下文、逐型号结构化输出支持，以及数据驻留、留存和删除条款；公开协议已经确认默认不训练，但仍需确认账号没有启用例外授权。
