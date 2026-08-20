import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

describe("production configuration", () => {
  it("rejects the public OTP secret placeholder", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        OTP_SECRET: "replace-with-a-long-random-value",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow("OTP_SECRET");
  });
});
