export type AppEnv = Env & {
  AI?: Ai;
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  CLOUDFLARE_AI_GATEWAY_MODEL?: string;
  CLOUDFLARE_AI_GATEWAY_MODEL_SETTINGS?: Record<string, unknown> | string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MODEL_PROVIDER?: "cloudflare-gateway" | "workers-ai" | "gemini-direct";
  WORKERS_AI_MODEL?: string;
};
