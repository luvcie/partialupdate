import type { AppEnv, AuthProviderName } from "../env";

const DEFAULT_AUTH_PROVIDERS: AuthProviderName[] = ["GOOGLE", "GITHUB"];

export function getEnabledAuthProviders(env: AppEnv): Set<AuthProviderName> {
  const raw = env.AUTH_PROVIDERS as unknown;

  if (Array.isArray(raw)) {
    return normalizeProviders(raw);
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;

      if (Array.isArray(parsed)) {
        return normalizeProviders(parsed);
      }
    } catch {
      return normalizeProviders(
        raw
          .replace(/^\s*\[/, "")
          .replace(/\]\s*$/, "")
          .split(",")
          .map((value) => value.trim().replace(/^['"]|['"]$/g, "")),
      );
    }
  }

  return new Set(DEFAULT_AUTH_PROVIDERS);
}

export function isAuthProviderEnabled(
  env: AppEnv,
  provider: AuthProviderName,
): boolean {
  return getEnabledAuthProviders(env).has(provider);
}

export function shouldVerifyEmail(env: AppEnv): boolean {
  const raw = env.VERIFY_EMAIL as unknown;
  return raw === true || raw === "true";
}

function normalizeProviders(values: unknown[]): Set<AuthProviderName> {
  const providers = new Set<AuthProviderName>();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim().toUpperCase();

    if (
      normalized === "GOOGLE" ||
      normalized === "GITHUB" ||
      normalized === "EMAIL_PASSWORD"
    ) {
      providers.add(normalized);
    }
  }

  return providers;
}
