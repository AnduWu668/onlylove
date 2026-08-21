import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { InterviewConversations } from "./modules/conversations/interview.js";
import { Portraits } from "./modules/portraits/service.js";

export async function createPortraitWorker(options: {
  databaseUrl: string;
  agentModel?: AgentModelOptions;
  agentInputTokenBudget?: number;
  now?: () => Date;
}) {
  const { db, pool } = openDatabase(options.databaseUrl);
  const now = options.now ?? (() => new Date());
  const agentEngine = new AgentEngine(
    options.agentModel,
    options.agentInputTokenBudget,
  );
  const agentJobs = new AgentJobs(db);
  const portraits = new Portraits(
    db,
    now,
    new InterviewConversations(db),
    agentJobs,
  );
  let closed = false;

  return {
    async runOnce() {
      return portraits.processNextCalibrationJob(agentEngine);
    },
    async drain() {
      let processed: boolean;
      do {
        processed = await portraits.processNextCalibrationJob(agentEngine);
      } while (processed);
    },
    async run() {
      while (!closed) {
        try {
          if (!(await portraits.processNextCalibrationJob(agentEngine))) {
            await delay(500);
          }
        } catch (error) {
          console.error("OnlyLove worker iteration failed", error);
          await delay(1_000);
        }
      }
    },
    async close() {
      closed = true;
      agentEngine.close();
      await pool.end();
    },
  };
}
