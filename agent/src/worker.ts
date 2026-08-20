import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

try {
  loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://onlylove:onlylove@localhost:5433/onlylove",
});

await pool.query("select 1");
console.info("OnlyLove worker ready");

const heartbeat = setInterval(() => void pool.query("select 1"), 30_000);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    clearInterval(heartbeat);
    await pool.end();
    process.exit(0);
  });
}
