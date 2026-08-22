import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import { memberForRequest } from "../members/routes.js";
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
}
