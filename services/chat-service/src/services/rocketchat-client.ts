// ──────────────────────────────────────────────────────────────────────────────
// Rocket.Chat REST-API client
// Handles admin authentication with automatic token refresh.
// ──────────────────────────────────────────────────────────────────────────────

import axios, { type AxiosInstance } from "axios";
import axiosRetry, { exponentialDelay } from "axios-retry";
import { config, logger } from "../config/index.js";
import { redisClient, CacheKeys } from "../config/redis.js";

interface RcAuthToken {
  authToken: string;
  userId: string;
}

class RocketChatClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.rocketChat.url,
      timeout: 15_000,
      headers: { "Content-Type": "application/json" },
    });
    axiosRetry(this.http, { retries: 2, retryDelay: exponentialDelay });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getAdminToken(): Promise<RcAuthToken> {
    const redis = redisClient.get();
    const cached = await redis.get(CacheKeys.rcAdminToken());
    if (cached) return JSON.parse(cached);

    const { data } = await this.http.post("/api/v1/login", {
      user: config.rocketChat.adminUsername,
      password: config.rocketChat.adminPassword,
    });

    const token: RcAuthToken = {
      authToken: data.data.authToken,
      userId: data.data.userId,
    };

    // Cache for 23 hours (RC tokens expire after 24h by default)
    await redis.set(CacheKeys.rcAdminToken(), JSON.stringify(token), "EX", 82800);
    return token;
  }

  private async authHeaders() {
    const { authToken, userId } = await this.getAdminToken();
    return { "X-Auth-Token": authToken, "X-User-Id": userId };
  }

  /** Invalidate cached token so next call fetches a fresh one */
  async invalidateToken(): Promise<void> {
    const redis = redisClient.get();
    await redis.del(CacheKeys.rcAdminToken());
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async createUser(opts: {
    username: string;
    email: string;
    name: string;
    password: string;
    roles?: string[];
  }): Promise<any> {
    const headers = await this.authHeaders();
    const { data } = await this.http.post(
      "/api/v1/users.create",
      {
        username: opts.username,
        email: opts.email,
        name: opts.name,
        password: opts.password,
        roles: opts.roles ?? ["user"],
        verified: true,
        requirePasswordChange: false,
      },
      { headers }
    );
    logger.info({ username: opts.username, rcUserId: data.user._id }, "RC user created");
    return data.user;
  }

  async findUserByEmail(email: string): Promise<any | null> {
    const headers = await this.authHeaders();
    try {
      const { data } = await this.http.get("/api/v1/users.info", {
        headers,
        params: { username: email.split("@")[0] },
      });
      return data.user ?? null;
    } catch (err: any) {
      if (err.response?.status === 400) return null;
      throw err;
    }
  }

  async findUserByUsername(username: string): Promise<any | null> {
    const headers = await this.authHeaders();
    try {
      const { data } = await this.http.get("/api/v1/users.info", {
        headers,
        params: { username },
      });
      return data.user ?? null;
    } catch (err: any) {
      if (err.response?.status === 400) return null;
      throw err;
    }
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post(
      "/api/v1/users.setActiveStatus",
      {
        userId,
        activeStatus: active,
      },
      { headers }
    );
    logger.info({ userId, active }, "RC user active status updated");
  }

  async updateUser(userId: string, data: Record<string, any>): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post(
      "/api/v1/users.update",
      {
        userId,
        data,
      },
      { headers }
    );
  }

  async listUsers(count = 100, offset = 0): Promise<any[]> {
    const headers = await this.authHeaders();
    const { data } = await this.http.get("/api/v1/users.list", {
      headers,
      params: { count, offset },
    });
    return data.users;
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async createChannel(name: string, members: string[] = []): Promise<any> {
    const headers = await this.authHeaders();
    const { data } = await this.http.post("/api/v1/channels.create", { name, members, readOnly: false }, { headers });
    logger.info({ channel: name, rcChannelId: data.channel._id }, "RC channel created");
    return data.channel;
  }

  async findChannelByName(name: string): Promise<any | null> {
    const headers = await this.authHeaders();
    try {
      const { data } = await this.http.get("/api/v1/channels.info", {
        headers,
        params: { roomName: name },
      });
      return data.channel ?? null;
    } catch (err: any) {
      if (err.response?.status === 400) return null;
      throw err;
    }
  }

  async inviteToChannel(channelId: string, userId: string): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post("/api/v1/channels.invite", { roomId: channelId, userId }, { headers });
  }

  async kickFromChannel(channelId: string, userId: string): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post("/api/v1/channels.kick", { roomId: channelId, userId }, { headers });
  }

  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post("/api/v1/channels.setTopic", { roomId: channelId, topic }, { headers });
  }

  async archiveChannel(channelId: string): Promise<void> {
    const headers = await this.authHeaders();
    await this.http.post("/api/v1/channels.archive", { roomId: channelId }, { headers });
  }

  async listChannels(count = 100, offset = 0): Promise<any[]> {
    const headers = await this.authHeaders();
    const { data } = await this.http.get("/api/v1/channels.list", {
      headers,
      params: { count, offset },
    });
    return data.channels;
  }

  // ── Auth token for SSO ────────────────────────────────────────────────────

  async loginAs(username: string, password: string): Promise<RcAuthToken> {
    const { data } = await this.http.post("/api/v1/login", {
      user: username,
      password,
    });
    return { authToken: data.data.authToken, userId: data.data.userId };
  }

  async createPersonalAccessToken(userId: string, tokenName: string): Promise<{ token: string }> {
    const headers = await this.authHeaders();
    const { data } = await this.http.post(
      "/api/v1/users.generatePersonalAccessToken",
      { tokenName, bypassTwoFactor: true },
      { headers: { ...headers, "X-User-Id": userId } }
    );
    return { token: data.token };
  }
}

export const rcClient = new RocketChatClient();
