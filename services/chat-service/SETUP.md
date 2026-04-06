# Plane + Rocket.Chat Integration — Setup Guide

## Architecture Overview

```
                            ┌─────────────────────────────────────────┐
                            │            Caddy Proxy (:8080)          │
                            │                                         │
                            │  /          → web:3000     (Plane UI)   │
                            │  /api/*     → api:8000     (Plane API)  │
                            │  /chat/*    → rocketchat:3000  (RC)     │
                            │  /chat-svc/*→ chat-service:4000 (Sync)  │
                            └──────────────┬──────────────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
     ┌────────▼─────────┐    ┌─────────────▼──────────┐    ┌──────────▼──────────┐
     │   Plane Stack    │    │     Rocket.Chat         │    │    Chat-Service     │
     │                  │    │                         │    │    (Node.js)        │
     │  web, api,       │    │  rocketchat:3000        │    │  Port 4000         │
     │  worker, beat,   │    │  chat-mongodb:27017     │    │                    │
     │  live, admin,    │    │                         │    │  - User sync       │
     │  space           │    │                         │    │  - Channel sync    │
     │                  │    │                         │    │  - SSO tokens      │
     │  plane-db        │    │                         │    │  - Webhooks        │
     │  plane-redis     │    │                         │    │                    │
     │  plane-mq        │    │                         │    │  Uses plane-redis  │
     │  plane-minio     │    │                         │    │                    │
     └──────────────────┘    └─────────────────────────┘    └───────────────────┘
```

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Plane already running via `docker compose up -d`
- At least 6 GB free RAM (Rocket.Chat + MongoDB need ~2 GB)

---

## Step 1 — Configure Environment

### 1.1 Generate secrets

```bash
# Generate ROCKETCHAT_JWT_SECRET (64 hex chars)
openssl rand -hex 64

# Generate CHAT_SERVICE_SECRET (32 hex chars)
openssl rand -hex 32

# Generate PLANE_WEBHOOK_SECRET
openssl rand -hex 32
```

### 1.2 Edit `services/chat-service/.env`

Fill in the real values:

| Variable                    | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `ROCKETCHAT_ADMIN_PASSWORD` | Admin password for RC (set before first boot!)           |
| `ROCKETCHAT_JWT_SECRET`     | Shared JWT secret (output of `openssl rand -hex 64`)     |
| `PLANE_API_TOKEN`           | Plane API token (create in Plane Admin → Settings → API) |
| `PLANE_WORKSPACE_SLUG`      | Your workspace slug (from the URL: `/your-slug/`)        |
| `PLANE_WEBHOOK_SECRET`      | Webhook signing secret                                   |
| `CHAT_SERVICE_SECRET`       | Internal auth secret (output of `openssl rand -hex 32`)  |

### 1.3 (Optional) Root `.env` additions

The Docker Compose overlay reads these from the root `.env` if you want to override defaults:

```bash
# Add to .env (optional, defaults are fine for dev)
CHAT_MONGO_USER=rocketchat
CHAT_MONGO_PASSWORD=rocketchat_secret
ROCKETCHAT_ROOT_URL=http://localhost:8080/chat
ROCKETCHAT_ADMIN_USERNAME=rocketadmin
ROCKETCHAT_ADMIN_PASSWORD=rocketadmin_secret
ROCKETCHAT_ADMIN_EMAIL=admin@plane.local
```

---

## Step 2 — Start Everything

```bash
# From the plane/ root directory
docker compose -f docker-compose.yml -f docker-compose.rocketchat.yml up -d
```

This starts all Plane services **plus**:

- `chat-mongodb` — MongoDB 6.0 with replica set (required by RC)
- `rocketchat` — Rocket.Chat 7.5.1
- `chat-service` — The sync/SSO bridge service

### Verify services are healthy

```bash
docker compose -f docker-compose.yml -f docker-compose.rocketchat.yml ps
```

Wait until all services show `healthy` or `running`. MongoDB and Rocket.Chat
may take 60–90 seconds on first boot.

### Check individual services

```bash
# Rocket.Chat health
curl http://localhost:8080/chat/api/info

# Chat-service health
curl http://localhost:8080/chat-svc/health
# Should return: {"status":"ok","service":"chat-service","timestamp":"..."}
```

---

## Step 3 — Create Plane API Token

1. Open Plane at `http://localhost:8080`
2. Go to **Settings** → **API Tokens** (admin only)
3. Create a new token with workspace-level access
4. Copy the token into `services/chat-service/.env` as `PLANE_API_TOKEN`
5. Set `PLANE_WORKSPACE_SLUG` to your workspace slug
6. Restart chat-service:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.rocketchat.yml restart chat-service
   ```

---

## Step 4 — Configure Plane Webhook

1. In Plane, go to **Settings** → **Webhooks**
2. Add a new webhook:
   - **URL**: `http://chat-service:4000/chat-svc/webhook/plane`
   - **Secret**: Same value as `PLANE_WEBHOOK_SECRET` in `.env`
   - **Events**: Select all project and member events
3. Save

This enables real-time sync — when you create a project, a Rocket.Chat channel
is automatically created and members are added.

---

## Step 5 — Trigger Initial Sync

After configuring the API token and webhook, trigger a full sync:

```bash
curl -X POST http://localhost:8080/chat-svc/sync/full \
  -H "Content-Type: application/json" \
  -H "X-Chat-Service-Secret: YOUR_CHAT_SERVICE_SECRET"
```

This will:

- Create RC accounts for all Plane workspace members
- Create RC channels for all Plane projects
- Add project members to their channels

---

## Step 6 — Access the Chat

### From the sidebar

The Plane sidebar has a **Chat** button (with the Pi Chat icon) right below **Home**.
Click it to open the embedded Rocket.Chat interface.

### Project-specific channels

Navigate to `http://localhost:8080/<workspace>/chat/<PROJECT_IDENTIFIER>` to open
a specific project's channel. For example, if your project identifier is "PROJ":

```
http://localhost:8080/my-workspace/chat/proj
```

### Direct Rocket.Chat access

You can also access Rocket.Chat directly at:

```
http://localhost:8080/chat
```

---

## API Reference

### SSO — Get RC Auth Token

```bash
POST /chat-svc/sso/token
Header: X-Chat-Service-Secret: <secret>
Body: {
  "plane_user_id": "user-uuid",
  "email": "user@example.com",
  "display_name": "John Doe"
}
Response: {
  "authToken": "rc-auth-token",
  "userId": "rc-user-id",
  "rcUrl": "http://localhost:8080/chat"
}
```

### Sync — Full Sync

```bash
POST /chat-svc/sync/full
Header: X-Chat-Service-Secret: <secret>
Response: {
  "ok": true,
  "users": { "synced": 10, "errors": 0 },
  "channels": { "synced": 5, "errors": 0 }
}
```

### Sync — Single Project

```bash
POST /chat-svc/sync/project/:projectId
Header: X-Chat-Service-Secret: <secret>
```

### Webhook — Plane Events

```bash
POST /chat-svc/webhook/plane
Header: X-Plane-Signature: <hmac>
Body: { "event": "project.created", "data": { ... } }
```

---

## File Structure

```
plane/
├── docker-compose.yml                  # Plane services (existing)
├── docker-compose.rocketchat.yml       # RC overlay (NEW)
├── .env                                # Plane env vars
│
├── apps/
│   ├── proxy/
│   │   └── Caddyfile.ce                # Routing: /chat/* → RC, /chat-svc/* → chat-service
│   └── web/
│       ├── app/(all)/[workspaceSlug]/(projects)/chat/
│       │   ├── layout.tsx              # Chat route layout
│       │   ├── header.tsx              # Chat header with icon
│       │   ├── page.tsx                # Embedded RC iframe (workspace chat)
│       │   └── [projectIdentifier]/
│       │       └── page.tsx            # Project-specific channel iframe
│       └── ce/components/workspace/sidebar/
│           └── helper.tsx              # Sidebar icon mapping (chat → PiChatLogo)
│
├── packages/constants/src/
│   └── workspace.ts                    # Sidebar nav items (chat entry)
│
└── services/
    └── chat-service/
        ├── Dockerfile                  # Multi-stage Node.js build
        ├── .env                        # Service config (secrets)
        ├── .env.example                # Template
        ├── package.json
        ├── tsconfig.json
        ├── scripts/
        │   └── mongo-init-replica.sh   # MongoDB RS init
        └── src/
            ├── index.ts                # Express server entry
            ├── config/
            │   ├── index.ts            # Validated config + pino logger
            │   └── redis.ts            # Redis singleton + cache keys
            ├── routes/
            │   ├── sso.ts              # SSO token endpoint
            │   ├── webhook.ts          # Plane webhook receiver
            │   └── sync.ts             # Manual sync triggers
            └── services/
                ├── rocketchat-client.ts # RC REST API wrapper
                ├── plane-client.ts      # Plane REST API wrapper
                ├── user-sync.ts         # User sync logic
                └── channel-sync.ts      # Channel sync logic
```

---

## Scaling & Production Notes

### Redis

The chat-service already uses `plane-redis` for caching user/channel mappings
and RC admin tokens. For high traffic, you can point it at a dedicated Redis
instance by changing `REDIS_URL` in `services/chat-service/.env`.

### WebSocket

Rocket.Chat uses WebSocket for real-time messaging. The Caddy proxy config
automatically handles WebSocket upgrades (`transport http` stanza in Caddyfile).

### Horizontal scaling

- **chat-service** is stateless (Redis-backed) — run multiple replicas behind a load balancer
- **Rocket.Chat** supports horizontal scaling with multiple instances sharing the same MongoDB
- Add `deploy.replicas` to `docker-compose.rocketchat.yml` for scaling

### Security

- All inter-service communication uses `X-Chat-Service-Secret` header validation
- RC user passwords are derived via HMAC(service_secret, user_id) — never stored in plain text
- Webhook signatures are verified using HMAC-SHA256
- RC iframe has `sandbox` attributes restricting its capabilities

---

## Troubleshooting

### RC shows "frame-ancestors" error in iframe

Ensure the Rocket.Chat env vars include:

```
OVERWRITE_SETTING_HTTP_X_Frame_Options=""
```

This is set in `docker-compose.rocketchat.yml`.

### Sync fails with 401

- Verify `PLANE_API_TOKEN` is valid (create a new one in Plane admin)
- Verify `ROCKETCHAT_ADMIN_USERNAME` / `ROCKETCHAT_ADMIN_PASSWORD` match what was set during RC first boot

### MongoDB replica set not initialising

```bash
docker exec -it chat-mongodb mongosh --eval "rs.status()"
```

If the RS is not initialized, run:

```bash
docker exec -it chat-mongodb mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'chat-mongodb:27017'}]})"
```

### Chat sidebar button not visible

The `"chat"` key is in `WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS` and in the
`staticItems` array in `SidebarItemBase`. If it's missing, the translation key
`sidebar.chat` may not be in your i18n files — add it or check the browser console.
