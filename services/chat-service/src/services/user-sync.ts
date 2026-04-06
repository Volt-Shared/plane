// ──────────────────────────────────────────────────────────────────────────────
// User sync service — Plane users <-> Rocket.Chat users
// ──────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { config, logger } from "../config/index.js";
import { redisClient, CacheKeys } from "../config/redis.js";
import { rcClient } from "./rocketchat-client.js";
import { planeClient } from "./plane-client.js";

/** Generate a deterministic but unguessable password for RC users */
function generateRcPassword(planeUserId: string): string {
  return crypto.createHmac("sha256", config.service.secret).update(`rc-user-${planeUserId}`).digest("hex");
}

/** Sanitise a Plane display name into a valid RC username */
function toRcUsername(email: string): string {
  // Use the email local part, replace invalid chars
  return email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 40);
}

// eslint-disable-next-line typescript-eslint/no-extraneous-class -- grouping related sync operations
export class UserSyncService {
  /**
   * Ensure a single Plane user exists in Rocket.Chat.
   * Returns the RC user ID.
   */
  static async syncOne(planeUser: {
    id: string;
    email: string;
    display_name?: string;
    first_name?: string;
    last_name?: string;
    is_active?: boolean;
  }): Promise<string> {
    const redis = redisClient.get();
    const cacheKey = CacheKeys.userMapping(planeUser.id);

    // Check cache first
    const cachedRcId = await redis.get(cacheKey);
    if (cachedRcId) {
      logger.debug({ planeUserId: planeUser.id, rcUserId: cachedRcId }, "User mapping found in cache");
      return cachedRcId;
    }

    const username = toRcUsername(planeUser.email);
    const displayName =
      planeUser.display_name || [planeUser.first_name, planeUser.last_name].filter(Boolean).join(" ") || username;

    // Check if user already exists in RC
    let rcUser = await rcClient.findUserByUsername(username);

    if (!rcUser) {
      // Also try by email
      rcUser = await rcClient.findUserByEmail(planeUser.email);
    }

    if (rcUser) {
      // User exists — update name if changed, cache mapping
      try {
        await rcClient.updateUser(rcUser._id, { name: displayName });
      } catch {
        // Non-critical — user might not need updating
      }

      // Handle active status
      if (planeUser.is_active === false) {
        await rcClient.setUserActive(rcUser._id, false);
      }

      await redis.set(cacheKey, rcUser._id);
      return rcUser._id;
    }

    // Create new RC user
    const password = generateRcPassword(planeUser.id);
    const newUser = await rcClient.createUser({
      username,
      email: planeUser.email,
      name: displayName,
      password,
    });

    await redis.set(cacheKey, newUser._id);
    return newUser._id;
  }

  /**
   * Full sync: iterate all Plane workspace members and ensure they exist in RC.
   */
  static async fullSync(): Promise<{ synced: number; errors: number }> {
    logger.info("Starting full user sync...");
    const members = await planeClient.listWorkspaceMembers();

    let synced = 0;
    let errors = 0;

    for (const member of members) {
      try {
        const user = member.member ?? member;
        // eslint-disable-next-line no-await-in-loop -- sequential to avoid RC rate limits
        await UserSyncService.syncOne({
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          first_name: user.first_name,
          last_name: user.last_name,
          is_active: user.is_active,
        });
        synced++;
      } catch (err) {
        errors++;
        logger.error({ err, memberId: (member.member ?? member).id }, "Failed to sync user");
      }
    }

    logger.info({ synced, errors }, "Full user sync completed");
    return { synced, errors };
  }

  /**
   * Deactivate a user in RC when removed from Plane.
   */
  static async deactivateUser(planeUserId: string): Promise<void> {
    const redis = redisClient.get();
    const rcUserId = await redis.get(CacheKeys.userMapping(planeUserId));
    if (!rcUserId) {
      logger.warn({ planeUserId }, "No RC mapping found for deactivation");
      return;
    }
    await rcClient.setUserActive(rcUserId, false);
    await redis.del(CacheKeys.userMapping(planeUserId));
    logger.info({ planeUserId, rcUserId }, "User deactivated in RC");
  }

  /**
   * Get the RC password for a Plane user (for SSO login).
   */
  static getRcPassword(planeUserId: string): string {
    return generateRcPassword(planeUserId);
  }

  /**
   * Get the RC username for an email.
   */
  static getRcUsername(email: string): string {
    return toRcUsername(email);
  }
}
