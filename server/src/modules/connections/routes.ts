import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import { memberForRequest, superAdminForRequest } from "../members/routes.js";
import { Connections, ConnectionsError } from "./service.js";

const uuidParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export function registerConnectionsRoutes(
  app: FastifyInstance,
  options: { connections: Connections; db: Database; now: () => Date },
) {
  const { connections, db, now } = options;

  app.get("/api/member/contact-requests", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return connections.state(member.id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/member/recommendations/:id/contact-request",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const result = await connections.createRequest(
          member.id,
          request.params.id,
        );
        return reply
          .code(result.created ? 201 : 200)
          .send(result.request);
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/member/contact-requests/:id/accept",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await connections.acceptRequest(member.id, request.params.id);
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/member/contact-requests/:id/reject",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await connections.rejectRequest(member.id, request.params.id);
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { decision: "continue" | "end" | "confirm" };
  }>(
    "/api/member/connections/:id/followup",
    {
      schema: {
        params: uuidParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision"],
          properties: {
            decision: { enum: ["continue", "end", "confirm"] },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await connections.submitFollowup(
          member.id,
          request.params.id,
          request.body.decision,
        );
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/member/connections/:id/review",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await connections.markReview(member.id, request.params.id);
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/member/connections/:id/resume",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        return await connections.resumeMatching(member.id, request.params.id);
      } catch (error) {
        if (error instanceof ConnectionsError) {
          return reply.code(error.statusCode).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get("/api/admin/relationship-metrics", async (request, reply) => {
    const actor = await superAdminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    return connections.relationshipMetrics();
  });
}
