# 无照片 MVP 验收

Issue #17 的默认验收入口是：

```bash
npm run acceptance
```

该命令只使用确定性假模型，启动或复用本地 PostgreSQL，确保 `onlylove_test` 存在并重置测试数据，然后依次运行类型检查、全部自动测试、确定性配对 benchmark 和构建。最高层测试 `server/test/mvp-acceptance.http.test.ts` 通过公开 HTTP 接口串起超级管理员、普通管理员和两名成员，覆盖邀请注册、资料、固定题与引导完善、画像提交、十题校准、发布、推荐、双方分身会话、联系、真人聊天、七日继续、确认关系、失真反馈、举报、审核处置、复核、屏蔽和逻辑注销。

## 验收映射

| Issue #17 验收行为 | 检查入口 |
| --- | --- |
| 超级管理员邀请、两名成员注册、资料和择偶条件 | `mvp-acceptance.http.test.ts` |
| 固定题、引导完善、画像草稿、提交、十题校准、发布 | `mvp-acceptance.http.test.ts`、`portrait-lifecycle.http.test.ts` |
| 结构化过滤、配对评估、阈值和安全候选卡 | `mvp-acceptance.http.test.ts`、`recommendations.http.test.ts`、确定性配对 benchmark |
| 双方分身会话、请求、接受和唯一当前联系 | `mvp-acceptance.http.test.ts`、`connections.http.test.ts` |
| 真人聊天、七日继续、结束复盘或确认关系 | `mvp-acceptance.http.test.ts`、`connections.http.test.ts` |
| 失真反馈、屏蔽、举报、审核处置、复核、注销 | `mvp-acceptance.http.test.ts`、`moderation.http.test.ts`、`connections.http.test.ts` |
| 管理员权限、任务、配置、审计、Token、成本和指标 | `mvp-acceptance.http.test.ts`、`admin-dashboard.http.test.ts`、`agent-engine.test.ts` |
| 额度原子扣减、唯一联系、版本固定、数据隔离、即时失效 | `interview.http.test.ts`、`connections.http.test.ts`、`recommendations.http.test.ts`、`moderation.http.test.ts` |
| 移动端和桌面浏览器 | 下方人工浏览器步骤 |
| PostgreSQL、SMTP、超级管理员、Ark、推荐 N 和阈值 | 下方运行配置 |
| 明确后置项 | 规格的 Out of Scope；仓库不包含照片字段、Agent-Agent、Skill 市场、群聊或原生 App 预留 |

父规格 #1 的成员行为 1–20 由 `members.http.test.ts` 覆盖，21–47 由 `interview.http.test.ts` 与 `portrait-lifecycle.http.test.ts` 覆盖，48–65 由 `agent-engine.test.ts` 与会话测试覆盖，66–85 由推荐与联系测试覆盖，86–94 由真人会话和关系生命周期测试覆盖，95–108 由治理与注销测试覆盖，109–112 由管理后台观测测试覆盖。真实浏览器交互和真实供应商质量属于下述显式人工步骤，不进入默认 CI。

## 真实火山方舟评测

先在本地 `.env` 配置 `ARK_API_KEY`、固定 `ARK_MODEL_ID`、可选固定 `ARK_BACKUP_MODEL_ID`、输入/输出单价和 `ARK_PRICING_EFFECTIVE_DATE`。以下命令会产生真实费用，只有显式执行才会调用 Ark：

```bash
npm run benchmark:interview:ark -w evals
npm run benchmark:extraction:ark -w evals
npm run benchmark:twin:ark -w evals
npm run benchmark:matching:ark -w evals
```

画像完善与配对的真实产品 E2E 使用专用 `*_e2e` 数据库：

```bash
RUN_ARK_E2E=1 npm run test:matching:e2e:ark -w server
npm run e2e:dashboard
```

## 16K / 32K / 64K 长上下文

```bash
npm run benchmark:context:ark -w evals
```

命令用相同的长访谈和长分身会话依次运行三个预算。每个 `RESULT context/...` 都输出代号召回质量、实际输入/输出 Token、总延迟、首 Token 延迟、估算人民币成本和实际模型 ID；最后的 `context comparison` 对比三档结果，并按分角色召回与实测成本给出 `syntheticSuggestionInputTokenBudget`。该字段只是合成召回实验建议：16K 在访谈和分身均不退化时与 32K 比成本，64K 必须两类均不退化且至少多召回一个代号才会被建议。正式决定还需人工复核矛盾处理、未见场景一致性和关键事实捏造；通过后再把选择写入部署环境的 `AGENT_INPUT_TOKEN_BUDGET`，并保存原始结果。

## 移动端人工演示

1. 运行 `npm run dev`，在 375×812 的窄屏浏览器打开 `http://localhost:5173`；管理员在 `/admin` 签发两个邀请。
2. 用两个隔离浏览器会话完成两名成员的注册、资料、访谈、画像、校准、发布、推荐、双方分身会话、联系、真人聊天与七日状态。所有主要按钮无需横向滚动，底部导航可达。
3. 在 `/admin` 检查成员漏斗、推荐与关系指标、治理案件、Agent 任务、Token、成本和审计；普通管理员不能进入超级管理员页面。
4. 在 1280px 以上桌面宽度重复打开成员页和管理页，确认布局可用；候选卡只显示昵称占位头像，不出现隐藏画像、分数或照片入口。

## 运行配置

- PostgreSQL：`DATABASE_URL`；本地默认 `localhost:5433/onlylove`。
- 超级管理员：`SUPER_ADMIN_EMAIL`；生产必须同时设置至少 32 字符的 `OTP_SECRET`。
- SMTP：生产设置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM`。
- Ark 主备模型：使用固定模型 ID 和北京 `/api/v3` 端点，API key 只来自环境变量。
- 推荐 N 与阈值：超级管理员通过管理后台修改，对应 `/api/admin/matching-settings`，变更会审计。
- 两类 Agent 日额度：超级管理员通过 `/api/admin/agent-quota-settings` 修改，变更会审计。

MVP 不实现或预留真人照片、交友模式、Agent-Agent、Skill 市场、群聊、原生 App 或复杂自动安全策略。
