import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import type { AdministrationAuditInput } from "../members/administration.js";
import {
  memberForRequest,
  superAdminForRequest,
} from "../members/routes.js";
import { Matching, MatchingError } from "./service.js";

export function registerMatchingRoutes(
  app: FastifyInstance,
  options: {
    db: Database;
    now: () => Date;
    matching: Matching;
    recordAdministrationAudit: (
      input: AdministrationAuditInput,
    ) => Promise<unknown>;
  },
) {
  const { db, now, matching } = options;

  app.get("/api/member/recommendations", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return matching.state(member.id);
  });

  app.post("/api/member/recommendations", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    try {
      return reply.code(202).send(await matching.generate(member.id));
    } catch (error) {
      if (error instanceof MatchingError) {
        return reply
          .code(error.statusCode)
          .send({ code: error.code, detail: error.detail });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/member/recommendations/:id/skip",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      if (!(await matching.skip(member.id, request.params.id))) {
        return reply.code(404).send({ code: "RECOMMENDATION_NOT_FOUND" });
      }
      return reply.code(204).send();
    },
  );

  app.get("/api/admin/matching-settings", async (request, reply) => {
    const actor = await superAdminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const settings = await matching.settings();
    return {
      candidateCapacity: settings.candidateCapacity,
      minimumReciprocalScore: settings.minimumReciprocalScore,
    };
  });

  app.put<{
    Body: { candidateCapacity: number; minimumReciprocalScore: number };
  }>(
    "/api/admin/matching-settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["candidateCapacity", "minimumReciprocalScore"],
          properties: {
            candidateCapacity: { type: "integer", minimum: 1, maximum: 100 },
            minimumReciprocalScore: {
              type: "number",
              minimum: 0,
              maximum: 100,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await superAdminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const settings = await matching.updateSettings(actor.id, request.body);
      return {
        candidateCapacity: settings.candidateCapacity,
        minimumReciprocalScore: settings.minimumReciprocalScore,
      };
    },
  );

  app.get("/api/admin/matching-settings/audit", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const audits = await matching.settingsAudit();
    await options.recordAdministrationAudit({
      actorMemberId: actor.id,
      action: "matching_settings_audit_viewed",
      createdAt: viewedAt,
    });
    return { audits };
  });
}
