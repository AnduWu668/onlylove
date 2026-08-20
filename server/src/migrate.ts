import { readConfig } from "./config.js";
import { migrateDatabase, openDatabase } from "./db.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const { databaseUrl } = readConfig();
const { db, pool } = openDatabase(databaseUrl);
await migrateDatabase(db);
await pool.end();
