# OnlyLove

当前仓库已完成产品 Grill，并实现首个可登录的移动端纵向切片。

## 本地启动

需要 Node.js 20.19+ 与 Docker。复制 `.env.example` 为 `.env`，至少设置首个超级管理员邮箱和 OTP 哈希密钥，然后运行：

```bash
npm install
npm run dev
```

根命令会启动 PostgreSQL、移动端 Web（`http://localhost:5173`）、Server（`http://localhost:3100`）和单 Worker。开发环境验证码会显示在 Server 控制台；PostgreSQL 默认映射到本机 5433，可用 `POSTGRES_PORT` 覆盖。

画像访谈使用北京火山方舟。生产调用需同时设置 `ARK_API_KEY`、固定 `ARK_MODEL_ID`、输入/输出 Token 单价及其生效日期；缺失时页面仍可启动，但发送消息会明确提示模型未配置，不会使用假模型。显式真实模型检查只需 key 与固定模型，运行 `npm run test:ark -w server`；普通自动测试只使用确定性假模型。

- [MVP 产品规格](docs/product/mvp-spec.md)
- [可执行 Issue 规格](docs/specs/onlylove-mvp.md)
- [领域术语](CONTEXT.md)
- [技术规格](docs/technical/implementation-spec.md)
- [Agent Benchmark 计划](docs/evals/benchmark-plan.md)
- [架构决策](docs/adr)
- [模型供应商调研](docs/research/llm-provider-comparison.md)
