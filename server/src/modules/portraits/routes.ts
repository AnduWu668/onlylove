import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import type { AgentEngine } from "../agent-engine/engine.js";
import type { AgentJobs } from "../agent-engine/jobs.js";
import { memberForRequest } from "../members/routes.js";
import { PortraitInputError, type FixedAnswerInput, Portraits } from "./service.js";

export function registerPortraitsRoutes(
  app: FastifyInstance,
  options: {
    agentEngine: AgentEngine;
    agentJobs: AgentJobs;
    db: Database;
    now: () => Date;
    portraits: Portraits;
  },
) {
  app.get("/api/member/portrait/interview", async (request, reply) => {
    const member = await memberForRequest(request, options.db, options.now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return options.portraits.interviewState(member.id);
  });

  app.post<{ Body: FixedAnswerInput }>(
    "/api/member/portrait/interview/fixed-answers",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "questionId",
            "selectedOptionIds",
            "noneApplies",
            "freeText",
          ],
          properties: {
            questionId: { type: "string", minLength: 1, maxLength: 80 },
            selectedOptionIds: {
              type: "array",
              maxItems: 4,
              items: { type: "string", minLength: 1, maxLength: 80 },
            },
            noneApplies: { type: "boolean" },
            freeText: { type: "string", maxLength: 2_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, options.db, options.now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const result = await options.portraits.submitFixedAnswer(
          member.id,
          request.body,
          {
            agentJobs: options.agentJobs,
            definition: options.agentEngine.interviewerDefinition,
          },
        );
        if (!result.followupJob) return result.state;
        return {
          ...result.state,
          autoFollowup: {
            jobId: result.followupJob.id,
            eventsUrl: `/api/member/interview/jobs/${result.followupJob.id}/events`,
          },
        };
      } catch (error) {
        if (error instanceof PortraitInputError) {
          return reply.code(400).send({ code: error.code });
        }
        throw error;
      }
    },
  );
}
