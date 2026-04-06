// ──────────────────────────────────────────────────────────────────────────────
// Manual sync routes — trigger full or partial syncs via API
// ──────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response, type NextFunction } from "express";
import { config, logger } from "../config/index.js";
import { UserSyncService } from "../services/user-sync.js";
import { ChannelSyncService } from "../services/channel-sync.js";

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

export const syncRouter = Router();

/** Verify service secret */
function requireSecret(req: Request, res: Response): boolean {
  const secret = req.headers["x-chat-service-secret"] as string;
  if (secret !== config.service.secret) {
    res.status(401).json({ error: "Invalid service secret" });
    return false;
  }
  return true;
}

/**
 * POST /chat-svc/sync/full
 * Runs a complete user + channel sync.
 */
syncRouter.post(
  "/full",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireSecret(req, res)) return;

    try {
      logger.info("Manual full sync triggered");
      const userResult = await UserSyncService.fullSync();
      const channelResult = await ChannelSyncService.fullSync();

      res.json({
        ok: true,
        users: userResult,
        channels: channelResult,
      });
    } catch (err) {
      logger.error({ err }, "Manual full sync failed");
      res.status(500).json({ error: "Sync failed" });
    }
  })
);

/**
 * POST /chat-svc/sync/users
 * Syncs only users.
 */
syncRouter.post(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireSecret(req, res)) return;

    try {
      const result = await UserSyncService.fullSync();
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, "User sync failed");
      res.status(500).json({ error: "User sync failed" });
    }
  })
);

/**
 * POST /chat-svc/sync/channels
 * Syncs only channels + members.
 */
syncRouter.post(
  "/channels",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireSecret(req, res)) return;

    try {
      const result = await ChannelSyncService.fullSync();
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, "Channel sync failed");
      res.status(500).json({ error: "Channel sync failed" });
    }
  })
);

/**
 * POST /chat-svc/sync/project/:projectId
 * Syncs a single project channel + members.
 */
syncRouter.post(
  "/project/:projectId",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireSecret(req, res)) return;

    try {
      const { projectId } = req.params;
      // We need project info — fetch it
      const { planeClient } = await import("../services/plane-client.js");
      const project = await planeClient.getProject(projectId);

      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const channelId = await ChannelSyncService.syncOne({
        id: project.id,
        name: project.name,
        identifier: project.identifier,
        description: project.description,
      });

      await ChannelSyncService.syncMembers(project.id);

      res.json({ ok: true, channelId });
    } catch (err) {
      logger.error({ err }, "Project sync failed");
      res.status(500).json({ error: "Project sync failed" });
    }
  })
);
