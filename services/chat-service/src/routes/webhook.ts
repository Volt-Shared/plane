// ──────────────────────────────────────────────────────────────────────────────
// Webhook route — receives events from Plane (project/member CRUD)
//
// Configure in Plane: Settings -> Webhooks -> Add webhook
// URL: http://chat-service:4000/chat-svc/webhook/plane
// Events: project:*, member:*
// ──────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
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

export const webhookRouter = Router();

/** Verify Plane webhook signature */
function verifySignature(payload: string, signature: string): boolean {
  if (!config.plane.webhookSecret) return true; // skip if not configured
  const expected = crypto.createHmac("sha256", config.plane.webhookSecret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * POST /chat-svc/webhook/plane
 * Plane sends webhook events here for project/member lifecycle events.
 */
webhookRouter.post(
  "/plane",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      // Verify webhook signature
      const signature = req.headers["x-plane-signature"] as string;
      if (signature) {
        const rawBody = JSON.stringify(req.body);
        if (!verifySignature(rawBody, signature)) {
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
      }

      const event = req.body;
      const eventType = event.event as string;
      const eventData = event.data;

      logger.info({ eventType }, "Received Plane webhook");

      switch (eventType) {
        // ── Member events ───────────────────────────────────────────────
        case "member.created":
        case "member.updated": {
          const user = eventData.member ?? eventData;
          await UserSyncService.syncOne({
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            first_name: user.first_name,
            last_name: user.last_name,
            is_active: user.is_active,
          });
          break;
        }

        case "member.deleted":
        case "member.removed": {
          const user = eventData.member ?? eventData;
          await UserSyncService.deactivateUser(user.id);
          break;
        }

        // ── Project events ──────────────────────────────────────────────
        case "project.created":
        case "project.updated": {
          await ChannelSyncService.syncOne({
            id: eventData.id,
            name: eventData.name,
            identifier: eventData.identifier,
            description: eventData.description,
          });
          // Also sync members for new projects
          if (eventType === "project.created") {
            // Small delay to let Plane populate members
            setTimeout(() => {
              ChannelSyncService.syncMembers(eventData.id).catch((err) =>
                logger.error({ err, projectId: eventData.id }, "Failed to sync new project members")
              );
            }, 3000);
          }
          break;
        }

        case "project.deleted": {
          await ChannelSyncService.archiveChannel(eventData.id);
          break;
        }

        // ── Project member events ───────────────────────────────────────
        case "project_member.created":
        case "project_member.added": {
          const projectId = eventData.project ?? eventData.project_id;
          const user = eventData.member ?? eventData;
          if (projectId && user.id) {
            await UserSyncService.syncOne({
              id: user.id,
              email: user.email,
              display_name: user.display_name,
              first_name: user.first_name,
              last_name: user.last_name,
            });
            await ChannelSyncService.syncMembers(projectId);
          }
          break;
        }

        case "project_member.deleted":
        case "project_member.removed": {
          const projectId = eventData.project ?? eventData.project_id;
          const userId = eventData.member?.id ?? eventData.id;
          if (projectId && userId) {
            await ChannelSyncService.removeMember(projectId, userId);
          }
          break;
        }

        default:
          logger.debug({ eventType }, "Unhandled webhook event");
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Webhook processing failed");
      res.status(500).json({ error: "Webhook processing failed" });
    }
  })
);
