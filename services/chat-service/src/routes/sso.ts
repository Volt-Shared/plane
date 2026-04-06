// ──────────────────────────────────────────────────────────────────────────────
// SSO route — issues a Rocket.Chat auth token for a Plane user
//
// Flow:
//   1. Plane frontend calls POST /chat-svc/sso/token (via Caddy) with its
//      session cookie — no shared secret needed from the browser.
//   2. chat-service validates the session by forwarding the cookie to Plane API
//      GET /api/v1/users/me/
//   3. Ensures user exists in RC (creates if needed)
//   4. Logs in as the user in RC and returns the auth token
//   5. Frontend uses the token to authenticate the RC iframe
// ──────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config, logger } from "../config/index.js";
import { UserSyncService } from "../services/user-sync.js";
import { rcClient } from "../services/rocketchat-client.js";

export const ssoRouter = Router();

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

/**
 * Validate Plane session by forwarding cookies to the Plane API.
 * Returns the authenticated user or null.
 */
async function validatePlaneSession(cookie: string): Promise<any | null> {
  try {
    // Use /api/users/me/ (no v1) — this is the session-cookie-based endpoint.
    // /api/v1/users/me/ requires X-Api-Key and ignores cookies.
    const { data } = await axios.get(`${config.plane.apiUrl}/api/users/me/`, {
      headers: { Cookie: cookie },
      timeout: 10_000,
    });
    return data;
  } catch {
    return null;
  }
}

/**
 * POST /sso/token  (external URL: /chat-svc/sso/token)
 *
 * The browser sends its Plane session cookie — no shared secret in the request.
 * Alternatively, internal services can use X-Chat-Service-Secret header.
 *
 * Returns: { authToken, userId, rcUrl }
 */
ssoRouter.post(
  "/token",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      // Auth option 1: service-to-service via shared secret
      const serviceSecret = req.headers["x-chat-service-secret"] as string;
      let planeUser: any = null;

      if (serviceSecret === config.service.secret && req.body.plane_user_id) {
        // Trusted internal call — use the body directly
        planeUser = {
          id: req.body.plane_user_id,
          email: req.body.email,
          display_name: req.body.display_name,
          first_name: req.body.first_name,
          last_name: req.body.last_name,
        };
      } else {
        // Auth option 2: browser call — validate Plane session cookie
        const cookie = req.headers.cookie;
        if (!cookie) {
          res.status(401).json({ error: "No session cookie" });
          return;
        }

        planeUser = await validatePlaneSession(cookie);
        if (!planeUser || !planeUser.id) {
          res.status(401).json({ error: "Invalid Plane session" });
          return;
        }
      }

      // Ensure user exists in RC
      await UserSyncService.syncOne({
        id: planeUser.id,
        email: planeUser.email,
        display_name: planeUser.display_name,
        first_name: planeUser.first_name,
        last_name: planeUser.last_name,
      });

      // Login as the user to get an auth token
      const username = UserSyncService.getRcUsername(planeUser.email);
      const password = UserSyncService.getRcPassword(planeUser.id);

      const { authToken, userId } = await rcClient.loginAs(username, password);

      res.json({
        authToken,
        userId,
        rcUrl: config.rocketChat.rootUrl,
      });
    } catch (err) {
      logger.error({ err }, "SSO token generation failed");
      res.status(500).json({ error: "SSO token generation failed" });
    }
  })
);

/**
 * GET /sso/rc-iframe-auth  (external: /chat-svc/sso/rc-iframe-auth)
 *
 * Called by Rocket.Chat's client-side iframe integration automatically.
 * RC sets Accounts_iframe_url to this endpoint. When a user isn't logged in,
 * RC's JS fetches this URL (with credentials/cookies) and expects:
 *   { "loginToken": "..." }
 * If it gets a valid token, RC auto-logs the user in. No login page shown.
 */
ssoRouter.get(
  "/rc-iframe-auth",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const cookie = req.headers.cookie;
      if (!cookie) {
        // Return JSON 401 — RC handles this gracefully via Accounts_Iframe_api_url
        res.status(401).json({ error: "No session" });
        return;
      }

      const planeUser = await validatePlaneSession(cookie);
      if (!planeUser || !planeUser.id) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }

      // Ensure user exists in RC
      await UserSyncService.syncOne({
        id: planeUser.id,
        email: planeUser.email,
        display_name: planeUser.display_name,
        first_name: planeUser.first_name,
        last_name: planeUser.last_name,
      });

      // Login as the user
      const username = UserSyncService.getRcUsername(planeUser.email);
      const password = UserSyncService.getRcPassword(planeUser.id);
      const { authToken } = await rcClient.loginAs(username, password);

      // RC expects { loginToken: "..." } or { token: "..." } for iframe auth
      res.json({ loginToken: authToken, token: authToken });
    } catch (err) {
      logger.error({ err }, "RC iframe auth failed");
      res.status(401).json({ error: "Auth failed" });
    }
  })
);

/**
 * GET /sso/channel-url/:projectIdentifier  (external: /chat-svc/sso/channel-url/:id)
 * Returns the full RC channel URL for a project.
 *
 * This endpoint is protected by service secret (internal use only).
 */
ssoRouter.get(
  "/channel-url/:projectIdentifier",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const secret = req.headers["x-chat-service-secret"] as string;
      if (secret !== config.service.secret) {
        res.status(401).json({ error: "Invalid service secret" });
        return;
      }

      const { projectIdentifier } = req.params;
      const channelName = projectIdentifier.toLowerCase();
      const channelUrl = `${config.rocketChat.rootUrl}/channel/${channelName}`;

      res.json({ channelUrl, channelName });
    } catch (err) {
      logger.error({ err }, "Channel URL lookup failed");
      res.status(500).json({ error: "Channel URL lookup failed" });
    }
  })
);
