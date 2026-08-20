# MVP 采用 TypeScript Web 技术栈

OnlyLove 的移动端 Web 前端使用 Vue 3、Vue Router 与 Vite，后端使用 Node.js、TypeScript 和 Fastify，数据通过 Drizzle ORM 写入 PostgreSQL。仓库使用 npm workspaces，Docker Compose 只提供 PostgreSQL，根命令同时启动前端、后端和单 Worker。真人及 Agent 消息由 HTTP POST 发送、SSE 推送，画像提取和配对评估由 PostgreSQL 任务表中的单 Worker 执行；邮件通过通用 SMTP 适配，开发环境只把验证码写到服务端控制台。自动测试使用确定性假模型，手动方舟集成测试只从未提交的环境变量读取 API key 和固定模型 ID；缺少真实配置时产品明确报错，不静默使用假分身。这套栈覆盖当前交互与异步需求，不增加状态库、UI 组件库、WebSocket、缓存、外部任务队列或首期照片处理。
