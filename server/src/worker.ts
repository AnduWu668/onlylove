import { readConfig } from "./config.js";
import { loadRootEnv } from "./env.js";
import { createPortraitWorker } from "./portrait-worker.js";

loadRootEnv();
const config = readConfig();
const worker = await createPortraitWorker(config);
console.info("OnlyLove worker ready");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await worker.close();
    process.exit(0);
  });
}

await worker.run();
