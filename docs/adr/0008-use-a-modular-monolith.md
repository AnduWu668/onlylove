# 后端采用模块化单体

OnlyLove 在同一仓库维护 `web`、`server`、`agent` 和 `evals`，其中 `server` 以一个进程和一个数据库承载 Members、Portraits、Matching、Connections、Conversations、Moderation 与 Agent Engine 七个 Module。每个 Module 只直接读写自己拥有的表，并通过批量、受限的进程内业务 Interface 向其他 Module 提供数据；一致性操作共享 PostgreSQL 事务，慢任务写入数据库任务表。不拆微服务、内部 HTTP、事件总线或消息队列，从而保留内部替换 seam 与隐藏数据访问限制，同时避免 MVP 为分布式部署与跨服务事务付费。
