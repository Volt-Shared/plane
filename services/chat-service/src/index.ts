// ──────────────────────────────────────────────────────────────────────────────
// chat-service  —  Plane <-> Rocket.Chat bridge
// Entry point: Express server with health, SSO, webhook, and sync endpoints.
// ──────────────────────────────────────────────────────────────────────────────

import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import cron from "node-cron";

import { config, logger } from "./config/index.js";
import { redisClient } from "./config/redis.js";
import { ssoRouter } from "./routes/sso.js";
import { webhookRouter } from "./routes/webhook.js";
import { syncRouter } from "./routes/sync.js";
import { UserSyncService } from "./services/user-sync.js";
import { ChannelSyncService } from "./services/channel-sync.js";

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false,
  })
);

app.use(
  express.json({
    limit: "1mb",
    verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => (req as any).url === "/health",
    },
  })
);

app.set("trust proxy", 1);

// ── Routes ───────────────────────────────────────────────────────────────────
// Caddy strips /chat-svc prefix before forwarding, so routes are at root.
// Docker healthcheck hits localhost:4000/health directly (no Caddy).

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "chat-service", timestamp: new Date().toISOString() });
});

app.use("/sso", ssoRouter);
app.use("/webhook", webhookRouter);
app.use("/sync", syncRouter);

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Connect Redis
  try {
    await redisClient.get().connect();
    await redisClient.get().ping();
    logger.info("Redis connection verified");
  } catch (err) {
    logger.warn({ err }, "Redis not ready yet — will retry on demand");
  }

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, "chat-service started");
  });

  // Run initial sync after a short delay (don't block startup)
  setTimeout(async () => {
    try {
      logger.info("Running initial sync...");
      await UserSyncService.fullSync();
      await ChannelSyncService.fullSync();
      logger.info("Initial sync completed");
    } catch (err) {
      logger.error({ err }, "Initial sync failed — will retry on schedule");
    }
  }, 10_000);

  // Schedule periodic full sync
  cron.schedule(config.sync.cron, async () => {
    logger.info("Running scheduled full sync...");
    try {
      await UserSyncService.fullSync();
      await ChannelSyncService.fullSync();
      logger.info("Scheduled full sync completed");
    } catch (err) {
      logger.error({ err }, "Scheduled sync failed");
    }
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully");
    server.close(async () => {
      await redisClient.disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn("Forced exit after 10s");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });
}

start().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
