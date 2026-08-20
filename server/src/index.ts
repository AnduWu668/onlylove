import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { loadRootEnv } from "./env.js";
import { createMailer } from "./modules/members/mailer.js";

loadRootEnv();
const config = readConfig();
const app = await createApp({
  ...config,
  mailer: createMailer(process.env),
});

await app.listen({ host: "0.0.0.0", port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

