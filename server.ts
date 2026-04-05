const PORT = parseInt(process.env.PORT || "8585");
const TOKEN_ID = process.env.PVE_TOKEN_ID || "";
const TOKEN_SECRET = process.env.PVE_TOKEN_SECRET || "";
const NODES_ENV = process.env.PVE_NODES || "";

// Parse PVE_NODES: "pve-colossus=192.168.86.105,pve-guardian=192.168.86.106,..."
const nodes = NODES_ENV.split(",").map((entry) => {
  const [name, ip] = entry.trim().split("=");
  return { name, ip };
});

if (!TOKEN_ID || !TOKEN_SECRET || nodes.length === 0 || !nodes[0].ip) {
  console.error("Missing required env vars: PVE_TOKEN_ID, PVE_TOKEN_SECRET, PVE_NODES");
  process.exit(1);
}

const AUTH_HEADER = `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`;

// --- Cache ---
let cache: { data: any; ts: number } | null = null;
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

async function fetchNode(node: { name: string; ip: string }) {
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

async function getClusterData() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;
  const results = await Promise.all(nodes.map(fetchNode));
  const data = { nodes: results, fetched_at: new Date().toISOString() };
  cache = { data, ts: Date.now() };
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

    if (path === "/api/cluster") {
      const data = await getClusterData();
      return Response.json(data);
    }

    if (path === "/api/nodes") {
      const data = await getClusterData();
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
      const data = await getClusterData();
      const node = data.nodes.find((n: any) => n.name === nodeName);
      if (!node) return Response.json({ error: "Node not found" }, { status: 404 });
      return Response.json(node);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`pve-api listening on :${PORT}`);
