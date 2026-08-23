# OnlyLove

当前仓库已实现除真人照片外的双成员 MVP 验收闭环。

## 本地启动

需要 Node.js 20.19+ 与 Docker。复制 `.env.example` 为 `.env`，至少设置首个超级管理员邮箱和 OTP 哈希密钥，然后运行：

```bash
npm install
npm run dev
```

根命令会启动 PostgreSQL、移动端 Web（`http://localhost:5173`）、Server（`http://localhost:3100`）和单 Worker。开发环境验证码会显示在 Server 控制台；PostgreSQL 默认映射到本机 5433，可用 `POSTGRES_PORT` 覆盖。

画像访谈使用北京火山方舟。生产调用需同时设置 `ARK_API_KEY`、固定 `ARK_MODEL_ID`、输入/输出 Token 单价及其生效日期；缺失时页面仍可启动，但发送消息会明确提示模型未配置，不会使用假模型。显式真实模型检查只需 key 与固定模型，运行 `npm run test:ark -w server`；普通自动测试只使用确定性假模型。

## MVP 验收

```bash
npm run acceptance
```

该命令运行确定性双成员闭环、全部专项测试、类型检查、确定性配对 benchmark 和构建，不调用真实模型。真实 Ark 四角色评测、16K/32K/64K 长上下文对比、移动端人工步骤和部署配置见 [无照片 MVP 验收](docs/mvp-acceptance.md)。

## 核心接口回归

`npm run test:core` 锁定 issue 1–8 已经对外的接口，避免后续迭代改掉登录、资料、访谈、画像发布、自己的分身聊天或配对评估时没有人发现。它使用确定性假模型和内存邮件，不调用真实方舟。

脚本会先确认本机 `5433`（可用 `POSTGRES_PORT` 覆盖）上已有 PostgreSQL；没有才执行 `docker compose up`。因此主仓库的开发数据库已经在跑时，工作树或第二份检出不会再抢同一端口。

它检查四件事：

1. Fastify 仍注册 issue 1–8 的 HTTP 路由。
2. 未登录访问成员接口返回 `401`，非管理员访问邀请和作业接口返回 `403`。
3. 邀请注册、维护资料、固定访谈、动态追问、提交校准发布、与自己的分身聊天这条主路径的状态码和响应形状没有变；成员响应里不能出现隐藏画像字段或 API key。
4. 进程内 `evaluatePair` 仍输出互惠分和资格；硬边界冲突必须是 `excluded`，对外理由不能带分数或标签。

实现见 `server/test/core-api.contract.test.ts`。推送到 `dev` / `main` 时，GitHub Actions 会跑 `npm run test:ci`（类型检查、全部自动测试和确定性配对 benchmark），其中不包含真实模型评测。

```bash
npm run test:core
```

- [MVP 产品规格](docs/product/mvp-spec.md)
- [可执行 Issue 规格](docs/specs/onlylove-mvp.md)
- [领域术语](CONTEXT.md)
- [技术规格](docs/technical/implementation-spec.md)
- [Agent Benchmark 计划](docs/evals/benchmark-plan.md)
- [无照片 MVP 验收](docs/mvp-acceptance.md)
- [架构决策](docs/adr)
- [模型供应商调研](docs/research/llm-provider-comparison.md)
