const PORT = parseInt(process.env.PORT || "8585");
const TOKEN_ID = process.env.PVE_TOKEN_ID || "";
const TOKEN_SECRET = process.env.PVE_TOKEN_SECRET || "";
const PBS_HOST = process.env.PBS_HOST || "";
const PBS_TOKEN = process.env.PBS_TOKEN || "";
const PBS_DATASTORE = process.env.PBS_DATASTORE || "backups-ssd";

// --- Config file ---
// Load cluster topology from /config/config.json (volume-mounted)
// Falls back to PVE_NODES env var for backward compatibility

interface NodeConfig { name: string; ip: string; }
interface ClusterConfig { name: string; nodes: NodeConfig[]; }

let clusters: ClusterConfig[] = [];

try {
  const configFile = Bun.file("/config/config.json");
  if (await configFile.exists()) {
    const config = await configFile.json();
    clusters = config.clusters || [];
    console.log(`Loaded ${clusters.length} cluster(s) from config.json`);
  }
} catch {}

// Fallback: PVE_NODES env var → single unnamed cluster
if (clusters.length === 0) {
  const NODES_ENV = process.env.PVE_NODES || "";
  if (NODES_ENV) {
    const nodes = NODES_ENV.split(",").map((entry) => {
      const [name, ip] = entry.trim().split("=");
      return { name, ip };
    });
    clusters = [{ name: "default", nodes }];
    console.log(`Loaded ${nodes.length} node(s) from PVE_NODES env var (cluster: default)`);
  }
}

if (!TOKEN_ID || !TOKEN_SECRET || clusters.length === 0) {
  console.error("Missing config: need PVE_TOKEN_ID, PVE_TOKEN_SECRET, and /config/config.json or PVE_NODES");
  process.exit(1);
}

const AUTH_HEADER = `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`;
const PBS_AUTH_HEADER = PBS_TOKEN ? `PBSAPIToken=${PBS_TOKEN}` : "";

// --- Cache ---
const clusterCaches = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 30_000; // 30s

// --- PVE API helpers ---

async function pveGet(ip: string, path: string): Promise<any> {
  const resp = await fetch(`https://${ip}:8006${path}`, {
    headers: { Authorization: AUTH_HEADER },
    // @ts-ignore - Bun supports this for self-signed certs
    tls: { rejectUnauthorized: false },
  });
  if (!resp.ok) throw new Error(`PVE ${ip}${path}: ${resp.status}`);
  const json = await resp.json();
  return json.data;
}

function formatBytes(bytes: number): number {
  return Math.round((bytes / 1073741824) * 10) / 10; // GB, 1 decimal
}

function formatUptime(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10; // hours, 1 decimal
}

async function fetchGuests(ip: string, nodeName: string, type: "qemu" | "lxc") {
  const items = await pveGet(ip, `/api2/json/nodes/${nodeName}/${type}`);
  return (items || [])
    .sort((a: any, b: any) => a.vmid - b.vmid)
    .map((g: any) => ({
      vmid: g.vmid,
      name: g.name,
      type: type === "qemu" ? "vm" : "lxc",
      status: g.status,
      uptime_hours: formatUptime(g.uptime || 0),
      cpu: {
        usage_pct: Math.round((g.cpu || 0) * 100 * 10) / 10,
        cores: g.cpus || g.maxcpu || 0,
      },
      memory: {
        used_gb: formatBytes(g.mem || 0),
        total_gb: formatBytes(g.maxmem || 0),
        usage_pct: g.maxmem ? Math.round(((g.mem || 0) / g.maxmem) * 100 * 10) / 10 : 0,
      },
    }));
}

async function fetchNode(node: NodeConfig) {
  try {
    const [status, vms, containers] = await Promise.all([
      pveGet(node.ip, `/api2/json/nodes/${node.name}/status`),
      fetchGuests(node.ip, node.name, "qemu"),
      fetchGuests(node.ip, node.name, "lxc"),
    ]);

    return {
      name: node.name,
      status: status.uptime > 0 ? "online" : "offline",
      uptime_hours: formatUptime(status.uptime || 0),
      cpu: {
        usage_pct: Math.round((status.cpu || 0) * 100 * 10) / 10,
        cores: status.cpuinfo?.cpus || 0,
      },
      memory: {
        used_gb: formatBytes(status.memory?.used || 0),
        total_gb: formatBytes(status.memory?.total || 0),
        usage_pct: status.memory?.total
          ? Math.round(((status.memory.used || 0) / status.memory.total) * 100 * 10) / 10
          : 0,
      },
      vms,
      containers,
    };
  } catch (err: any) {
    return {
      name: node.name,
      status: "unreachable",
      error: err.message,
      uptime_hours: 0,
      cpu: { usage_pct: 0, cores: 0 },
      memory: { used_gb: 0, total_gb: 0, usage_pct: 0 },
      vms: [],
      containers: [],
    };
  }
}

async function fetchCluster(cluster: ClusterConfig) {
  const cached = clusterCaches.get(cluster.name);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const nodes = await Promise.all(cluster.nodes.map(fetchNode));
  const online = nodes.filter((n) => n.status === "online").length;

  const data = {
    name: cluster.name,
    online,
    total: nodes.length,
    nodes,
    fetched_at: new Date().toISOString(),
  };

  clusterCaches.set(cluster.name, { data, ts: Date.now() });
  return data;
}

async function getAllClusters() {
  const results = await Promise.all(clusters.map(fetchCluster));
  return { clusters: results, fetched_at: new Date().toISOString() };
}

// --- PBS API helpers ---

async function pbsGet(path: string): Promise<any> {
  if (!PBS_HOST || !PBS_AUTH_HEADER) throw new Error("PBS not configured");
  const resp = await fetch(`https://${PBS_HOST}:8007${path}`, {
    headers: { Authorization: PBS_AUTH_HEADER },
    // @ts-ignore
    tls: { rejectUnauthorized: false },
  });
  if (!resp.ok) throw new Error(`PBS ${path}: ${resp.status}`);
  const json = await resp.json();
  return json.data;
}

let backupCache: { data: any; ts: number } | null = null;
const BACKUP_CACHE_TTL = 120_000; // 2min

async function getBackupData() {
  if (backupCache && Date.now() - backupCache.ts < BACKUP_CACHE_TTL) return backupCache.data;

  // Use first node of first cluster for PVE backup job queries
  const firstNode = clusters[0].nodes[0];

  const [snapshots, storageStatus, backupJobs] = await Promise.all([
    pbsGet(`/api2/json/admin/datastore/${PBS_DATASTORE}/snapshots`),
    pbsGet(`/api2/json/admin/datastore/${PBS_DATASTORE}/status`),
    pveGet(firstNode.ip, "/api2/json/cluster/backup"),
  ]);

  const byGuest = new Map<string, any[]>();
  for (const snap of snapshots || []) {
    const key = `${snap["backup-type"]}/${snap["backup-id"]}`;
    if (!byGuest.has(key)) byGuest.set(key, []);
    byGuest.get(key)!.push(snap);
  }

  const guests = Array.from(byGuest.entries())
    .map(([key, snaps]) => {
      snaps.sort((a: any, b: any) => (b["backup-time"] || 0) - (a["backup-time"] || 0));
      const latest = snaps[0];
      const backupType = key.split("/")[0];
      return {
        backup_id: latest["backup-id"],
        backup_type: backupType === "vm" ? "vm" : "lxc",
        snapshot_count: snaps.length,
        latest: {
          time: new Date((latest["backup-time"] || 0) * 1000).toISOString(),
          size_gb: formatBytes(latest.size || 0),
          verified: latest.verification?.state === "ok",
          verification_time: latest.verification?.upid
            ? new Date((latest.verification["last-verification"] || latest["backup-time"]) * 1000).toISOString()
            : null,
        },
        oldest: {
          time: new Date((snaps[snaps.length - 1]["backup-time"] || 0) * 1000).toISOString(),
        },
      };
    })
    .sort((a, b) => a.backup_id.localeCompare(b.backup_id));

  const storage = {
    datastore: PBS_DATASTORE,
    total_gb: formatBytes(storageStatus.total || 0),
    used_gb: formatBytes(storageStatus.used || 0),
    available_gb: formatBytes(storageStatus.avail || 0),
    usage_pct: storageStatus.total
      ? Math.round(((storageStatus.used || 0) / storageStatus.total) * 100 * 10) / 10
      : 0,
  };

  const jobs = (backupJobs || []).map((j: any) => ({
    id: j.id,
    schedule: j.schedule,
    storage: j.storage,
    mode: j.mode,
    enabled: j.enabled !== 0,
    all: j.all === 1,
    nodes: j.node,
    next_run: j["next-run"] ? new Date(j["next-run"] * 1000).toISOString() : null,
  }));

  const data = { storage, guests, jobs, fetched_at: new Date().toISOString() };
  backupCache = { data, ts: Date.now() };
  return data;
}

// --- HTTP server ---

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({ status: "ok", uptime: process.uptime() });
    }

    // --- New cluster endpoints ---

    if (path === "/api/clusters") {
      const data = await getAllClusters();
      return Response.json(data);
    }

    if (path.startsWith("/api/clusters/")) {
      const clusterName = path.split("/")[3];
      const cluster = clusters.find((c) => c.name === clusterName);
      if (!cluster) return Response.json({ error: "Cluster not found" }, { status: 404 });
      const data = await fetchCluster(cluster);
      return Response.json(data);
    }

    // --- Legacy endpoints (backward compat — use first cluster) ---

    if (path === "/api/cluster") {
      const data = await fetchCluster(clusters[0]);
      // Return in old format for compat
      return Response.json({ nodes: data.nodes, fetched_at: data.fetched_at });
    }

    if (path === "/api/nodes") {
      const data = await fetchCluster(clusters[0]);
      const summary = data.nodes.map((n: any) => ({
        name: n.name,
        status: n.status,
        uptime_hours: n.uptime_hours,
        cpu: n.cpu,
        memory: n.memory,
        vm_count: n.vms.length,
        container_count: n.containers.length,
      }));
      return Response.json({ nodes: summary, fetched_at: data.fetched_at });
    }

    if (path.startsWith("/api/nodes/")) {
      const nodeName = path.split("/")[3];
      const data = await fetchCluster(clusters[0]);
      const node = data.nodes.find((n: any) => n.name === nodeName);
      if (!node) return Response.json({ error: "Node not found" }, { status: 404 });
      return Response.json(node);
    }

    // --- Backup endpoints ---

    if (path === "/api/backups") {
      try {
        const data = await getBackupData();
        return Response.json(data);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 503 });
      }
    }

    if (path === "/api/backups/storage") {
      try {
        const data = await getBackupData();
        return Response.json(data.storage);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 503 });
      }
    }

    if (path === "/api/backups/jobs") {
      try {
        const data = await getBackupData();
        return Response.json({ jobs: data.jobs });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 503 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`pve-api listening on :${PORT}`);
