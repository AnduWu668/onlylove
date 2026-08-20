import { Pool } from "pg";
import { readConfig } from "./config.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const configuredTestUrl = process.env.TEST_DATABASE_URL;
const testUrl = new URL(configuredTestUrl ?? readConfig().databaseUrl);
if (!configuredTestUrl) testUrl.pathname = "/onlylove_test";
const databaseName = testUrl.pathname.slice(1);
if (!/^[a-z_][a-z0-9_]*$/i.test(databaseName)) {
  throw new Error("TEST_DATABASE_URL must contain a simple database name");
}

const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";
const pool = new Pool({ connectionString: adminUrl.toString() });
const exists = await pool.query(
  "select 1 from pg_database where datname = $1",
  [databaseName],
);
if (!exists.rowCount) await pool.query(`create database "${databaseName}"`);
await pool.end();
