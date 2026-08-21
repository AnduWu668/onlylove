import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { MatchingConnections } from "./modules/connections/matching.js";
import { InterviewConversations } from "./modules/conversations/interview.js";
import { MatchingMembers } from "./modules/members/matching.js";
import { Matching } from "./modules/matching/service.js";
import { MatchingModeration } from "./modules/moderation/matching.js";
import { MatchingPortraits } from "./modules/portraits/matching.js";
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
  const matching = new Matching(
    db,
    now,
    agentJobs,
    agentEngine.matchingDefinition,
    new MatchingMembers(db),
    new MatchingPortraits(db),
    new MatchingModeration(db),
    new MatchingConnections(db),
  );
  let closed = false;

  return {
    async runOnce() {
      return (
        (await portraits.processNextCalibrationJob(agentEngine)) ||
        matching.processNextEvaluationJob(agentEngine)
      );
    },
    async drain() {
      let processed: boolean;
      do {
        processed =
          (await portraits.processNextCalibrationJob(agentEngine)) ||
          (await matching.processNextEvaluationJob(agentEngine));
      } while (processed);
    },
    async run() {
      while (!closed) {
        try {
          if (
            !(await portraits.processNextCalibrationJob(agentEngine)) &&
            !(await matching.processNextEvaluationJob(agentEngine))
          ) {
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
