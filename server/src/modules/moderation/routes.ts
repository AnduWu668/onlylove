import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../../db.js";
import {
  adminForRequest,
  authenticatedMemberForRequest,
  memberForRequest,
} from "../members/routes.js";
import type { ModerationAction, ModerationTargetKind } from "./schema.js";
import { Moderation, ModerationError } from "./service.js";

const uuidParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ModerationError) {
    return reply.code(error.statusCode).send({ code: error.code });
  }
  throw error;
}

export function registerModerationRoutes(
  app: FastifyInstance,
  options: { moderation: Moderation; db: Database; now: () => Date },
) {
  const { moderation, db, now } = options;

  app.post<{ Body: { messageId: string; details: string } }>(
    "/api/member/distortion-feedback",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["messageId", "details"],
          properties: {
            messageId: { type: "string", format: "uuid" },
            details: { type: "string", minLength: 1, maxLength: 2_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(401).send({ code: "UNAUTHENTICATED" });
      }
      try {
        const details = request.body.details.trim();
        if (!details) {
          return reply.code(400).send({ code: "FEEDBACK_DETAILS_REQUIRED" });
        }
        const result = await moderation.feedback(
          member.id,
          request.body.messageId,
          details,
        );
        return reply.code(result.created ? 201 : 200).send(result.feedback);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      targetKind: "recommendation" | "contact_request" | "connection";
      targetId: string;
    };
  }>(
    "/api/member/blocks",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetKind", "targetId"],
          properties: {
            targetKind: {
              enum: ["recommendation", "contact_request", "connection"],
            },
            targetId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(401).send({ code: "UNAUTHENTICATED" });
      }
      try {
        const result = await moderation.block(
          member.id,
          request.body.targetKind,
          request.body.targetId,
        );
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      targetKind: ModerationTargetKind;
      targetId: string;
      reason: string;
      evidence: string;
      block: boolean;
    };
  }>(
    "/api/member/reports",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetKind", "targetId", "reason", "evidence", "block"],
          properties: {
            targetKind: {
              enum: [
                "recommendation",
                "contact_request",
                "connection",
                "twin_message",
                "human_message",
              ],
            },
            targetId: { type: "string", format: "uuid" },
            reason: { type: "string", minLength: 1, maxLength: 1_000 },
            evidence: { type: "string", minLength: 1, maxLength: 4_000 },
            block: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(401).send({ code: "UNAUTHENTICATED" });
      }
      try {
        const reason = request.body.reason.trim();
        const evidence = request.body.evidence.trim();
        if (!reason || !evidence) {
          return reply.code(400).send({ code: "REPORT_DETAILS_REQUIRED" });
        }
        return reply.code(201).send(
          await moderation.report(member.id, {
            ...request.body,
            reason,
            evidence,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/api/member/moderation", async (request, reply) => {
    const member = await authenticatedMemberForRequest(request, db, now());
    if (!member || member.role !== "member") {
      return reply.code(401).send({ code: "UNAUTHENTICATED" });
    }
    try {
      return await moderation.state(member.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { reason: string; evidence: string };
  }>(
    "/api/member/moderation-cases/:id/appeal",
    {
      schema: {
        params: uuidParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason", "evidence"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 1_000 },
            evidence: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await authenticatedMemberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(401).send({ code: "UNAUTHENTICATED" });
      }
      try {
        const reason = request.body.reason.trim();
        const evidence = request.body.evidence.trim();
        if (!reason || !evidence) {
          return reply.code(400).send({ code: "APPEAL_DETAILS_REQUIRED" });
        }
        const result = await moderation.appeal(
          member.id,
          request.params.id,
          reason,
          evidence,
        );
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/api/admin/moderation-metrics", async (request, reply) => {
    const actor = await adminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    return moderation.metrics();
  });

  app.get("/api/admin/moderation-cases", async (request, reply) => {
    const actor = await adminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    return moderation.cases();
  });

  app.get<{ Params: { id: string } }>(
    "/api/admin/moderation-cases/:id",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const actor = await adminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      try {
        return await moderation.caseDetail(request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { action: ModerationAction; reason: string; suspendedUntil?: string };
  }>(
    "/api/admin/moderation-cases/:id/decision",
    {
      schema: {
        params: uuidParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "reason"],
          properties: {
            action: { enum: ["dismissed", "warning", "suspended", "banned"] },
            reason: { type: "string", minLength: 1, maxLength: 2_000 },
            suspendedUntil: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await adminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      try {
        const reason = request.body.reason.trim();
        if (!reason) {
          return reply.code(400).send({ code: "DECISION_REASON_REQUIRED" });
        }
        return await moderation.decide(request.params.id, actor.id, {
          action: request.body.action,
          reason,
          suspendedUntil: request.body.suspendedUntil
            ? new Date(request.body.suspendedUntil)
            : undefined,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
