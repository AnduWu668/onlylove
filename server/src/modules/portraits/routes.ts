import type { FastifyInstance } from "fastify";
import type { Database } from "../../db.js";
import { memberForRequest } from "../members/routes.js";
import { PortraitInputError, type FixedAnswerInput, Portraits } from "./service.js";

export function registerPortraitsRoutes(
  app: FastifyInstance,
  options: { db: Database; now: () => Date; portraits: Portraits },
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
        return await options.portraits.submitFixedAnswer(
          member.id,
          request.body,
        );
      } catch (error) {
        if (error instanceof PortraitInputError) {
          return reply.code(400).send({ code: error.code });
        }
        throw error;
      }
    },
  );
}
