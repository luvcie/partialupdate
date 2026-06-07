import { betterAuth } from "better-auth";
import type { AppEnv } from "../env";
import { upsertUserProfile } from "./profile";

export type AuthProvider = "github" | "google";

export function createAuth(request: Request, env: AppEnv) {
  const origin = new URL(request.url).origin;

  return betterAuth({
    appName: "PartialUpdate",
    baseURL: env.BETTER_AUTH_URL || origin,
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "google"],
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID || "",
        clientSecret: env.GITHUB_CLIENT_SECRET || "",
        scope: ["user:email"],
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID || "",
        clientSecret: env.GOOGLE_CLIENT_SECRET || "",
      },
    },
    databaseHooks: {
      user: {
        create: {
          async after(user) {
            await upsertUserProfile(
              env,
              {
                email: user.email,
                id: user.id,
                name: user.name,
              },
              {
                necessaryCookieConsent: true,
                privacyOk: true,
              },
            );
          },
        },
        update: {
          async after(user) {
            await upsertUserProfile(
              env,
              {
                email: user.email,
                id: user.id,
                name: user.name,
              },
              {
                necessaryCookieConsent: true,
                privacyOk: true,
              },
            );
          },
        },
      },
    },
  });
}

export async function getAuthSession(request: Request, env: AppEnv) {
  return createAuth(request, env).api.getSession({
    headers: request.headers,
  });
}

export function hasProviderCredentials(
  env: AppEnv,
  provider: AuthProvider,
): boolean {
  if (provider === "github") {
    return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  }

  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
