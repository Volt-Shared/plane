# =============================================================================

# Plane + Rocket.Chat — Kubernetes Production Deployment Guide

# =============================================================================

#

# Architecture:

# Plane (web, api, worker, beat, live) + Rocket.Chat + chat-service

# PostgreSQL, Redis (Valkey), RabbitMQ, MongoDB, MinIO

# Nginx Ingress + cert-manager (Let's Encrypt)

#

# Prerequisites:

# - VPS with Kubernetes (k3s, kubeadm, etc.)

# - kubectl configured

# - Container registry (Docker Hub, GHCR, or private)

# - Domain pointing to VPS IP

# =============================================================================

## 1. Build & Push Images

```bash
# Set your registry
export REGISTRY=your-registry.com/plane

# From the plane repo root:
docker build -f apps/web/Dockerfile.web    -t $REGISTRY/plane-web:latest .
docker build -f apps/admin/Dockerfile.admin -t $REGISTRY/plane-admin:latest .
docker build -f apps/space/Dockerfile.space -t $REGISTRY/plane-space:latest .
docker build -f apps/api/Dockerfile.api     -t $REGISTRY/plane-api:latest apps/api/
docker build -f apps/live/Dockerfile.live   -t $REGISTRY/plane-live:latest .
docker build -f services/chat-service/Dockerfile -t $REGISTRY/plane-chat-service:latest services/chat-service/

# Push all
for img in plane-web plane-admin plane-space plane-api plane-live plane-chat-service; do
  docker push $REGISTRY/$img:latest
done
```

## 2. Configure Domain

Replace ALL occurrences of `CHANGE_ME_DOMAIN` in the YAML files:

```bash
cd k8s/
export DOMAIN=your-domain.com

# macOS: use gsed instead of sed
sed -i "s/CHANGE_ME_DOMAIN/$DOMAIN/g" 02-configmap.yaml 08-rocketchat.yaml 09-ingress.yaml
```

## 3. Configure Registry

Replace ALL occurrences of `YOUR_REGISTRY` in the YAML files:

```bash
sed -i "s|YOUR_REGISTRY|$REGISTRY|g" 07-plane-deployments.yaml 08-rocketchat.yaml 10-init-job.yaml
```

## 4. Update Secrets

Edit `01-secrets.yaml` and replace placeholder values with real base64-encoded
secrets for production:

```bash
# Generate a new Django SECRET_KEY
echo -n "$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')" | base64

# Generate new passwords/tokens
echo -n "$(openssl rand -hex 32)" | base64
```

## 5. Install Cluster Requirements

```bash
# Nginx Ingress Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml

# cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# Wait for them to be ready
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s

kubectl wait --namespace cert-manager \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/instance=cert-manager \
  --timeout=120s
```

## 6. Deploy (in order!)

```bash
# 1. Namespace
kubectl apply -f 00-namespace.yaml

# 2. Secrets & Config
kubectl apply -f 01-secrets.yaml
kubectl apply -f 02-configmap.yaml

# 3. Infrastructure (Postgres, Redis, RabbitMQ)
kubectl apply -f 03-database-statefulset.yaml
kubectl apply -f 04-redis-statefulset.yaml
kubectl apply -f 05-rabbitmq-statefulset.yaml

# Wait for infra to be ready
kubectl -n plane rollout status statefulset/plane-db --timeout=120s
kubectl -n plane rollout status statefulset/plane-redis --timeout=60s
kubectl -n plane rollout status statefulset/plane-mq --timeout=60s

# 4. MinIO
kubectl apply -f 06-minio-deployment.yaml
kubectl -n plane rollout status deployment/plane-minio --timeout=60s

# 5. Plane applications (includes migrator job)
kubectl apply -f 07-plane-deployments.yaml

# Wait for migrator to complete
kubectl -n plane wait --for=condition=complete job/plane-migrator --timeout=300s

# Wait for API to be ready
kubectl -n plane rollout status deployment/plane-api --timeout=180s

# 6. Rocket.Chat + chat-service
kubectl apply -f 08-rocketchat.yaml

# Wait for MongoDB replica-set init
sleep 30
kubectl -n plane rollout status deployment/plane-rocketchat --timeout=300s
kubectl -n plane rollout status deployment/plane-chat-service --timeout=120s

# 7. Ingress
kubectl apply -f 09-ingress.yaml

# 8. Initialize users & workspace
kubectl apply -f 10-init-job.yaml
kubectl -n plane wait --for=condition=complete job/plane-init --timeout=120s

# Get the API token from init job logs
kubectl -n plane logs job/plane-init 2>&1 | grep PLANE_API_TOKEN
```

## 7. Update API Token in Secrets

After the init job prints the `PLANE_API_TOKEN`, update the secret:

```bash
# Encode the token
echo -n "YOUR_NEW_TOKEN_HERE" | base64

# Edit the secret
kubectl -n plane edit secret plane-secrets
# Replace the PLANE_API_TOKEN value

# Restart chat-service to pick up the new token
kubectl -n plane rollout restart deployment/plane-chat-service
```

## 8. Verify

```bash
# Check all pods
kubectl -n plane get pods

# Check ingress
kubectl -n plane get ingress

# Check TLS certificate
kubectl -n plane get certificate

# Test API
curl -s https://your-domain.com/api/users/me/

# Test Rocket.Chat
curl -s https://your-domain.com/chat/api/v1/info

# Test chat-service
curl -s https://your-domain.com/chat-svc/health
```

## 9. Monitoring & Logs

```bash
# Follow API logs
kubectl -n plane logs -f deployment/plane-api

# Follow chat-service logs
kubectl -n plane logs -f deployment/plane-chat-service

# Follow RC logs
kubectl -n plane logs -f deployment/plane-rocketchat

# Check events
kubectl -n plane get events --sort-by='.lastTimestamp'
```

## Scaling for Thousands of Users

```bash
# Scale API replicas
kubectl -n plane scale deployment/plane-api --replicas=4

# Scale workers
kubectl -n plane scale deployment/plane-worker --replicas=4

# Scale frontend
kubectl -n plane scale deployment/plane-web --replicas=3

# For auto-scaling, apply HPA:
kubectl -n plane autoscale deployment/plane-api --min=2 --max=8 --cpu-percent=70
kubectl -n plane autoscale deployment/plane-web --min=2 --max=6 --cpu-percent=70
kubectl -n plane autoscale deployment/plane-worker --min=2 --max=6 --cpu-percent=70
```

## Troubleshooting

| Issue               | Solution                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Migrator stuck      | `kubectl -n plane logs job/plane-migrator` — may need manual migration                          |
| API 502             | Check if migrator completed: `kubectl -n plane get jobs`                                        |
| RC login page shows | Check chat-service logs for SSO errors                                                          |
| X-Frame-Options     | Verify `OVERWRITE_SETTING_Iframe_Integration_*` env vars                                        |
| TLS not issuing     | Check cert-manager: `kubectl -n plane describe certificate plane-tls`                           |
| MongoDB not ready   | Check replica-set: `kubectl -n plane exec plane-chat-mongodb-0 -- mongosh --eval "rs.status()"` |
