// ──────────────────────────────────────────────────────────────────────────────
// Channel sync service — Plane projects <-> Rocket.Chat channels
// ──────────────────────────────────────────────────────────────────────────────

import { logger } from "../config/index.js";
import { redisClient, CacheKeys } from "../config/redis.js";
import { rcClient } from "./rocketchat-client.js";
import { planeClient } from "./plane-client.js";
import { UserSyncService } from "./user-sync.js";

/** Convert project name to a valid RC channel name */
function toChannelName(projectIdentifier: string, projectName: string): string {
  // Use identifier if available (e.g. "PROJ"), otherwise sanitise the name
  const base = projectIdentifier || projectName;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// eslint-disable-next-line typescript-eslint/no-extraneous-class -- grouping related sync operations
export class ChannelSyncService {
  /**
   * Ensure a Plane project has a corresponding RC channel.
   * Returns the RC channel ID.
   */
  static async syncOne(project: {
    id: string;
    name: string;
    identifier: string;
    description?: string;
  }): Promise<string> {
    const redis = redisClient.get();
    const cacheKey = CacheKeys.channelMapping(project.id);

    // Check cache
    const cachedChannelId = await redis.get(cacheKey);
    if (cachedChannelId) {
      return cachedChannelId;
    }

    const channelName = toChannelName(project.identifier, project.name);

    // Check if channel exists
    let channel = await rcClient.findChannelByName(channelName);

    if (!channel) {
      // Create the channel
      channel = await rcClient.createChannel(channelName);

      // Set topic/description
      const topic = project.description || `Channel for project: ${project.name}`;
      await rcClient.setChannelTopic(channel._id, topic);
    }

    await redis.set(cacheKey, channel._id);
    return channel._id;
  }

  /**
   * Sync project members to the RC channel.
   */
  static async syncMembers(projectId: string): Promise<void> {
    const redis = redisClient.get();
    const channelId = await redis.get(CacheKeys.channelMapping(projectId));
    if (!channelId) {
      logger.warn({ projectId }, "No RC channel mapping found — run channel sync first");
      return;
    }

    const members = await planeClient.listProjectMembers(projectId);

    for (const member of members) {
      try {
        const user = member.member ?? member;
        // Ensure user exists in RC
        // eslint-disable-next-line no-await-in-loop -- sequential to avoid RC rate limits
        const rcUserId = await UserSyncService.syncOne({
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          first_name: user.first_name,
          last_name: user.last_name,
        });

        // Invite to channel
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential to avoid RC rate limits
          await rcClient.inviteToChannel(channelId, rcUserId);
        } catch (err: any) {
          // Ignore "already in channel" errors
          if (!err.response?.data?.error?.includes("already")) {
            throw err;
          }
        }
      } catch (err) {
        logger.error({ err, memberId: (member.member ?? member).id, projectId }, "Failed to sync member to channel");
      }
    }

    logger.info({ projectId, channelId, memberCount: members.length }, "Channel members synced");
  }

  /**
   * Remove a user from a project's RC channel.
   */
  static async removeMember(projectId: string, planeUserId: string): Promise<void> {
    const redis = redisClient.get();
    const channelId = await redis.get(CacheKeys.channelMapping(projectId));
    const rcUserId = await redis.get(CacheKeys.userMapping(planeUserId));

    if (!channelId || !rcUserId) {
      logger.warn({ projectId, planeUserId }, "Missing mapping for channel/user removal");
      return;
    }

    try {
      await rcClient.kickFromChannel(channelId, rcUserId);
      logger.info({ projectId, planeUserId }, "User removed from RC channel");
    } catch (err: any) {
      if (!err.response?.data?.error?.includes("not in")) {
        throw err;
      }
    }
  }

  /**
   * Full sync: ensure all Plane projects have RC channels with correct members.
   */
  static async fullSync(): Promise<{ synced: number; errors: number }> {
    logger.info("Starting full channel sync...");
    const projects = await planeClient.listProjects();

    let synced = 0;
    let errors = 0;

    for (const project of projects) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential to avoid RC rate limits
        await ChannelSyncService.syncOne({
          id: project.id,
          name: project.name,
          identifier: project.identifier,
          description: project.description,
        });
        // eslint-disable-next-line no-await-in-loop -- sequential to avoid RC rate limits
        await ChannelSyncService.syncMembers(project.id);
        synced++;
      } catch (err) {
        errors++;
        logger.error({ err, projectId: project.id }, "Failed to sync project channel");
      }
    }

    logger.info({ synced, errors }, "Full channel sync completed");
    return { synced, errors };
  }

  /**
   * Archive a channel when a project is deleted.
   */
  static async archiveChannel(projectId: string): Promise<void> {
    const redis = redisClient.get();
    const channelId = await redis.get(CacheKeys.channelMapping(projectId));
    if (!channelId) return;

    await rcClient.archiveChannel(channelId);
    await redis.del(CacheKeys.channelMapping(projectId));
    logger.info({ projectId, channelId }, "RC channel archived");
  }

  /**
   * Get the channel name for a project (for generating URLs).
   */
  static getChannelName(projectIdentifier: string, projectName: string): string {
    return toChannelName(projectIdentifier, projectName);
  }
}
