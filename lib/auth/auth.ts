import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";

type Auth = ReturnType<typeof create>;
const globalForAuth = globalThis as unknown as { __ciAuth?: Auth };

function create() {
  const config = env();
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.APP_BASE_URL,
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    // Accounts are provisioned by an administrator or the seed; there is no public sign-up.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    advanced: { database: { generateId: "uuid" }, cookiePrefix: "ci" },
    rateLimit: { enabled: process.env.NODE_ENV === "production", window: 60, max: 30 },
  });
}

export function auth(): Auth {
  globalForAuth.__ciAuth ??= create();
  return globalForAuth.__ciAuth;
}
