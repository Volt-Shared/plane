import pino from "pino";

// ──────────────────────────────────────────────────────────────────────────────
// Validated, typed configuration — all env vars in one place.
// The server refuses to start if required vars are missing.
// ──────────────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  env: optionalEnv("NODE_ENV", "development"),
  port: parseInt(optionalEnv("PORT", "4000"), 10),
  logLevel: optionalEnv("LOG_LEVEL", "info"),

  rocketChat: {
    url: optionalEnv("ROCKETCHAT_URL", "http://rocketchat:3000"),
    rootUrl: optionalEnv("ROCKETCHAT_ROOT_URL", "http://localhost:8080/chat"),
    adminUsername: requireEnv("ROCKETCHAT_ADMIN_USERNAME"),
    adminPassword: requireEnv("ROCKETCHAT_ADMIN_PASSWORD"),
    jwtSecret: requireEnv("ROCKETCHAT_JWT_SECRET"),
    jwtExpirySecs: parseInt(optionalEnv("ROCKETCHAT_JWT_EXPIRY_SECS", "3600"), 10),
  },

  plane: {
    apiUrl: optionalEnv("PLANE_API_URL", "http://api:8000"),
    apiToken: requireEnv("PLANE_API_TOKEN"),
    workspaceSlug: requireEnv("PLANE_WORKSPACE_SLUG"),
    webhookSecret: requireEnv("PLANE_WEBHOOK_SECRET"),
  },

  redis: {
    url: optionalEnv("REDIS_URL", "redis://plane-redis:6379"),
  },

  sync: {
    cron: optionalEnv("SYNC_CRON", "*/30 * * * *"),
  },

  service: {
    secret: requireEnv("CHAT_SERVICE_SECRET"),
  },
} as const;

// Singleton logger — imported by all modules
export const logger = pino({
  level: config.logLevel,
  transport: config.env !== "production" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  base: { service: "chat-service", env: config.env },
});
