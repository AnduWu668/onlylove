import { describe, expect, it } from "vitest";
import {
  ConsoleMailer,
  MemoryMailer,
  SmtpMailer,
  createMailer,
} from "../src/modules/members/mailer.js";

describe("Mailer environment selection", () => {
  it("uses the console in development and memory in tests", () => {
    expect(createMailer({ NODE_ENV: "development" })).toBeInstanceOf(
      ConsoleMailer,
    );
    expect(createMailer({ NODE_ENV: "test" })).toBeInstanceOf(MemoryMailer);
  });

  it("requires complete SMTP configuration in production", () => {
    expect(() => createMailer({ NODE_ENV: "production" })).toThrow(
      "SMTP_HOST",
    );
    expect(
      createMailer({
        NODE_ENV: "production",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_USER: "onlylove",
        SMTP_PASSWORD: "secret",
        SMTP_FROM: "OnlyLove <no-reply@example.com>",
      }),
    ).toBeInstanceOf(SmtpMailer);
  });
});

