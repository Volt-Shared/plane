import Redis from "ioredis";
import { config, logger } from "./index.js";

// ──────────────────────────────────────────────────────────────────────────────
// Singleton Redis client with reconnect strategy and error handling.
// Key namespaces used by chat-service:
//   chat:user:{planeUserId}      → rocketChatUserId
//   chat:channel:{planeProjectId}→ rocketChatChannelId
//   chat:rc:token                → current Rocket.Chat admin auth token + userId
// ──────────────────────────────────────────────────────────────────────────────

class RedisClient {
  private client: Redis | null = null;

  get(): Redis {
    if (!this.client) {
      this.client = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy(times) {
          if (times > 10) return null; // stop retrying after 10 attempts
          return Math.min(times * 200, 3000); // exponential back-off
        },
      });

      this.client.on("connect", () => logger.info({ module: "redis" }, "Connected to Redis"));
      this.client.on("error", (err) => logger.error({ module: "redis", err }, "Redis error"));
      this.client.on("reconnecting", () => logger.warn({ module: "redis" }, "Redis reconnecting"));
    }
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}

export const redisClient = new RedisClient();

// ── Typed helpers ──────────────────────────────────────────────────────────

export const CacheKeys = {
  userMapping: (planeUserId: string) => `chat:user:${planeUserId}`,
  channelMapping: (planeProjectId: string) => `chat:channel:${planeProjectId}`,
  rcAdminToken: () => "chat:rc:token",
} as const;
