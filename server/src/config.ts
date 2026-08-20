export interface ServerConfig {
  databaseUrl: string;
  otpSecret: string;
  port: number;
  production: boolean;
  superAdminEmail: string;
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const production = env.NODE_ENV === "production";
  const databaseUrl =
    env.DATABASE_URL ?? "postgres://onlylove:onlylove@localhost:5433/onlylove";
  const superAdminEmail =
    env.SUPER_ADMIN_EMAIL ?? (production ? "" : "admin@onlylove.local");
  const otpSecret =
    env.OTP_SECRET ?? (production ? "" : "onlylove-development-secret");
  const port = Number(env.PORT ?? 3100);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(superAdminEmail)) {
    throw new Error("SUPER_ADMIN_EMAIL must be a valid email address");
  }
  if (
    production &&
    (otpSecret.length < 32 ||
      otpSecret === "replace-with-a-long-random-value")
  ) {
    throw new Error(
      "OTP_SECRET must contain at least 32 characters and not use the example value in production",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid port");
  }
  return { databaseUrl, otpSecret, port, production, superAdminEmail };
}
