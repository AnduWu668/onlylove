import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import type { AgentEngine } from "../agent-engine/engine.js";
import type { AgentJobs } from "../agent-engine/jobs.js";
import { memberForRequest } from "../members/routes.js";
import {
  type CalibrationAnswerInput,
  PortraitInputError,
  type FixedAnswerInput,
  Portraits,
} from "./service.js";

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

  app.get("/api/member/portrait", async (request, reply) => {
    const member = await memberForRequest(request, options.db, options.now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return options.portraits.memberState(member.id);
  });

  app.post<{ Body: { clientRequestId: string } }>(
    "/api/member/portrait/versions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientRequestId"],
          properties: {
            clientRequestId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, options.db, options.now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const result = await options.portraits.submitVersion(
          member.id,
          request.body.clientRequestId,
          {
            agentEngine: options.agentEngine,
            agentJobs: options.agentJobs,
          },
        );
        return reply.code(result.created ? 202 : 200).send(result.state);
      } catch (error) {
        if (error instanceof PortraitInputError) {
          return reply.code(409).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: { scenarioId: string };
    Body: CalibrationAnswerInput;
  }>(
    "/api/member/portrait/calibration/:scenarioId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["scenarioId"],
          properties: { scenarioId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["rating", "correction", "criticalFabrication"],
          properties: {
            rating: { type: "string", enum: ["like", "partial", "unlike"] },
            correction: { type: "string", maxLength: 2_000 },
            criticalFabrication: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, options.db, options.now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const result = await options.portraits.submitCalibrationAnswer(
          member.id,
          request.params.scenarioId,
          request.body,
          {
            agentJobs: options.agentJobs,
            definition: options.agentEngine.interviewerDefinition,
          },
        );
        if (!result.followupJob) return result.state;
        return {
          ...result.state,
          correctionFollowup: {
            jobId: result.followupJob.id,
            eventsUrl: `/api/member/interview/jobs/${result.followupJob.id}/events`,
          },
        };
      } catch (error) {
        if (error instanceof PortraitInputError) {
          const status =
            error.code === "CALIBRATION_SCENARIO_NOT_FOUND"
              ? 404
              : error.code === "PORTRAIT_VERSION_REQUIRED"
                ? 409
                : 400;
          return reply.code(status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { versionId: string } }>(
    "/api/member/portrait/publish",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["versionId"],
          properties: { versionId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, options.db, options.now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await options.portraits.publishVersion(
          member.id,
          request.body.versionId,
        );
      } catch (error) {
        if (error instanceof PortraitInputError) {
          return reply.code(409).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.delete("/api/member/portrait/publish", async (request, reply) => {
    const member = await memberForRequest(request, options.db, options.now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return options.portraits.withdrawPublishedVersion(member.id);
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
