# pve-api

Lightweight REST API for Proxmox VE cluster. Queries all PVE nodes in parallel and returns unified cluster/node/VM/LXC data.

## Repo

- **GitHub:** snadboy/pve-api
- **Branch:** main
- **Local:** ~/projects/git/pve-api

## Stack

- Bun + TypeScript, single `server.ts`
- No dependencies beyond Bun runtime
- 30s response cache

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/cluster` | Full cluster with all nodes, VMs, LXCs |
| `GET /api/nodes` | Node summaries (no guest details) |
| `GET /api/nodes/:name` | Single node with its VMs/LXCs |
| `GET /health` | Health check |

## Environment

See `.env.example`. Secrets in shareables `.env` (`PVE_TOKEN_ID`, `PVE_TOKEN_SECRET`).

## Deploy

Docker image via GitHub Actions → ghcr.io/snadboy/pve-api:latest. Dockhand deploys from docker-homelab repo.

## Dev

```bash
source /mnt/shareables/.claude/.env
PVE_TOKEN_ID=$PVE_TOKEN_ID PVE_TOKEN_SECRET=$PVE_TOKEN_SECRET \
  PVE_NODES="pve-colossus=192.168.86.105,pve-guardian=192.168.86.106,pve-multivac=192.168.86.104" \
  bun run dev
```
