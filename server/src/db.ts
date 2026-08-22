import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as administrationSchema from "./modules/administration/schema.js";
import * as agentEngineSchema from "./modules/agent-engine/schema.js";
import * as connectionsSchema from "./modules/connections/schema.js";
import * as conversationsSchema from "./modules/conversations/schema.js";
import * as matchingSchema from "./modules/matching/schema.js";
import * as membersSchema from "./modules/members/schema.js";
import * as moderationSchema from "./modules/moderation/schema.js";
import * as portraitsSchema from "./modules/portraits/schema.js";

const schema = {
  ...administrationSchema,
  ...membersSchema,
  ...matchingSchema,
  ...connectionsSchema,
  ...moderationSchema,
  ...conversationsSchema,
  ...agentEngineSchema,
  ...portraitsSchema,
};

export function openDatabase(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof openDatabase>["db"];
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export async function migrateDatabase(db: Database) {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
}
