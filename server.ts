import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import fs from "fs";
// @ts-expect-error no type declarations available for cors
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import { deployTemplate, TemplateConfig } from "./src/deploy/template";
import { PROD_TEST_COMMAND } from "./src/shared/probes";
import { closeAll as closeSshPool, closeHost as closePooledHost, execOnServer, SshPoolError } from "./src/lib/ssh-pool";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ dest: "/tmp" });

// The dashboard polls telemetry and container stats continuously, so the budget
// has to cover the app's own traffic: roughly 8 requests per minute per host.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // ~330 requests per minute, enough for a fleet of ~40 hosts
  standardHeaders: true,
  legacyHeaders: false,
});

// The SPA fallback is the only non-API route that runs application code, so it
// gets its own budget. Static assets are deliberately left unlimited: a single
// page load legitimately fetches dozens of them, and they are immutable files
// served straight off disk.
const pageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // a page load costs one; this only stops a loop
  standardHeaders: true,
  legacyHeaders: false,
});


const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");

// Ensure sync DB for simple state
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ servers: [], clusters: [] }), { mode: 0o600 });
}

function getDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db: any) {
  // The file holds SSH passwords and private keys, so it is owner-only and
  // written through a temp file: a crash mid-write must not truncate the fleet.
  const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, DB_PATH);
}

// ─── Allowed commands allowlist for /exec ─────────────────────
const ALLOWED_EXEC_COMMANDS = new Set([
  "df -h",
  "free -m",
  "uptime",
  "whoami",
  "hostname",
  "uname -a",
  "docker ps",
  "docker ps -a",
  "docker images",
  "docker stats --no-stream",
  "systemctl status docker",
  // The Prod Test probe on the host card. Shared with the renderer so the two
  // copies cannot drift apart and start returning 403.
  PROD_TEST_COMMAND,
]);

// ─── Safe remote path validator ────────────────────────────────
function safePosixPath(userInput: string, username: string): string | null {
  if (!userInput || typeof userInput !== "string") return null;
  const normalized = path.posix.normalize(userInput);
  const allowed = [`/tmp/`, `/home/${username}/`];
  for (const prefix of allowed) {
    if (normalized.startsWith(prefix)) return normalized;
  }
  return null;
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function getServerSSHConfig(server: any) {
  const config: any = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
  };
  if (server.privateKey) {
    config.privateKey = server.privateKey;
  } else {
    config.password = server.password;
  }
  return config;
}

function shellSanitize(text: string, password?: string): string {
  if (!password) return text;
  const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '********');
}

// ─── Telemetry collection ──────────────────────────────────────
// One round trip per poll: every metric is printed as a "key: value" line so
// the parser stays a single split, and the whole script is POSIX sh so it runs
// on any host we can reach over SSH.
//
// The CPU sample sleeps 200ms between the two /proc/stat reads: long enough for
// the delta to be meaningful, short enough to sit comfortably inside the 8s
// request budget next to df and docker --version.
const TELEMETRY_SCRIPT = `
# A non-C locale makes awk print "75,0" and df print localised units, which the
# parser and the frontend both read as numbers.
LC_ALL=C; export LC_ALL

echo "disk: $(df -h / | tail -1 | awk '{print $5}')"
echo "disk_free: $(df -h / | tail -1 | awk '{print $4}')"
echo "disk_total: $(df -h / | tail -1 | awk '{print $2}')"
echo "disk_usage_all: $(df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 | tr '\\n' ';')"

t1=0; i1=0
set -- $(awk '/^cpu /{t=0;for(i=2;i<=9;i++)t+=$i;print t, $5}' /proc/stat 2>/dev/null)
if [ -n "$1" ]; then t1=$1; fi
if [ -n "$2" ]; then i1=$2; fi
sleep 0.2
t2=0; i2=0
set -- $(awk '/^cpu /{t=0;for(i=2;i<=9;i++)t+=$i;print t, $5}' /proc/stat 2>/dev/null)
if [ -n "$1" ]; then t2=$1; fi
if [ -n "$2" ]; then i2=$2; fi
dt=$((t2-t1)); di=$((i2-i1))
if [ "$dt" -gt 0 ]; then
  echo "cpu: $(awk -v dt="$dt" -v di="$di" 'BEGIN{printf "%.1f", (1-(di/dt))*100}')"
else
  echo "cpu: 0"
fi
echo "cpu_cores: $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"

ram=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t>0) printf "%.1f", ((t-a)/t)*100; else printf "0"}' /proc/meminfo 2>/dev/null)
if [ -z "$ram" ]; then ram=0; fi
echo "ram: $ram"
echo "ram_total_mb: $(awk '/^MemTotal:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
echo "ram_available_mb: $(awk '/^MemAvailable:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
echo "swap_total_mb: $(awk '/^SwapTotal:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
swap_used=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{if (t>0) printf "%.0f", (t-f)/1024; else printf "0"}' /proc/meminfo 2>/dev/null)
if [ -z "$swap_used" ]; then swap_used=0; fi
echo "swap_used_mb: $swap_used"

echo "load1: $(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
echo "load5: $(awk '{print $2}' /proc/loadavg 2>/dev/null || echo 0)"
echo "load15: $(awk '{print $3}' /proc/loadavg 2>/dev/null || echo 0)"
echo "uptime_s: $(awk '{printf "%.0f", $1}' /proc/uptime 2>/dev/null || echo 0)"

echo "net_rx_mb: $(awk -F'[: ]+' 'NR>2 {rx+=$3} END {printf "%.1f", rx/1024/1024}' /proc/net/dev 2>/dev/null || echo 0)"
echo "net_tx_mb: $(awk -F'[: ]+' 'NR>2 {tx+=$11} END {printf "%.1f", tx/1024/1024}' /proc/net/dev 2>/dev/null || echo 0)"

# /proc/diskstats counts 512-byte sectors. Partitions and stacked devices are
# skipped so a disk is not counted once per layer (sda + sda1 + dm-0).
dr=$(awk '$3 !~ /^(loop|ram|sr|fd|dm-|md)/ { n=$3; if (n ~ /[0-9]$/ && n !~ /^(nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/) next; r+=$6 } END {printf "%.0f", r/2}' /proc/diskstats 2>/dev/null)
if [ -z "$dr" ]; then dr=0; fi
echo "disk_read_kb: $dr"
dw=$(awk '$3 !~ /^(loop|ram|sr|fd|dm-|md)/ { n=$3; if (n ~ /[0-9]$/ && n !~ /^(nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/) next; w+=$10 } END {printf "%.0f", w/2}' /proc/diskstats 2>/dev/null)
if [ -z "$dw" ]; then dw=0; fi
echo "disk_write_kb: $dw"

pc=$(ls /proc 2>/dev/null | grep -c '^[0-9][0-9]*$' || true)
if [ -z "$pc" ]; then pc=0; fi
echo "proc_count: $pc"

# Thermal zones first (millidegrees), then hwmon for hosts without them.
temp_raw=""
for z in /sys/class/thermal/thermal_zone*; do
  if [ -r "$z/temp" ]; then
    v=$(cat "$z/temp" 2>/dev/null)
    case "$v" in ''|*[!0-9-]*) continue ;; esac
    if [ "$v" -gt 1000 ]; then temp_raw=$v; break; fi
  fi
done
if [ -z "$temp_raw" ]; then
  for h in /sys/class/hwmon/hwmon*; do
    if [ -r "$h/temp1_input" ]; then
      v=$(cat "$h/temp1_input" 2>/dev/null)
      case "$v" in ''|*[!0-9-]*) continue ;; esac
      if [ "$v" -gt 1000 ]; then temp_raw=$v; break; fi
    fi
  done
fi
if [ -n "$temp_raw" ]; then
  echo "temp_c: $(awk -v v="$temp_raw" 'BEGIN{printf "%.1f", v/1000}')"
else
  echo "temp_c: none"
fi

os_name=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -1 | tr -d '"')
if [ -z "$os_name" ]; then os_name=unknown; fi
echo "os: $os_name"
echo "kernel: $(uname -r 2>/dev/null || echo unknown)"

echo "docker: $(docker --version 2>/dev/null || echo 'none')"
`;

/** Parse the "key: value" lines the telemetry script prints. */
function parseTelemetry(output: string): Record<string, string> {
  const stats: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 2).trim();
    if (key) stats[key] = value;
  }
  return stats;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE"]
  }));
  app.use(express.json());
  // Scoped to the API so static assets and Vite's dev modules are not counted.
  app.use("/api", limiter);

  // Server Management API
  app.get("/api/servers", (_req: Request, res: Response) => {
    const db = getDB();
    const sanitized = db.servers.map(({ password, privateKey, ...rest }: any) => rest);
    res.json(sanitized);
  });

  app.post("/api/servers", (req: Request, res: Response) => {
    const { name, host, username, port, password, privateKey } = req.body;

    if (!name || !host || !username) {
      res.status(400).json({ error: "name, host, and username are required" });
      return;
    }

    const db = getDB();
    const newServer = {
      id: crypto.randomUUID(),
      name,
      host,
      username,
      port: port || 22,
      password: password || "",
      privateKey: privateKey || "",
      status: "offline",
      installed: { docker: false },
    };
    db.servers.push(newServer);
    saveDB(db);
    const { password: _, privateKey: __, ...sanitized } = newServer;
    res.json(sanitized);
  });

  app.delete("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    db.servers = db.servers.filter((s: any) => s.id !== req.params.id);
    saveDB(db);
    // Drop the pooled connection and the per-host telemetry state too, so a
    // deleted host leaves nothing behind.
    closePooledHost(req.params.id);
    telemetryCache.delete(req.params.id);
    telemetryFailures.delete(req.params.id);
    res.status(204).end();
  });

  app.get("/api/template/config/defaults", (_req: Request, res: Response) => {
    const config: TemplateConfig = {
      domain: "",
      email: "",
      duckdnsToken: "",
      profiles: ["required"],
      authelia: {
        jwtSecret: crypto.randomBytes(32).toString("hex"),
        sessionSecret: crypto.randomBytes(32).toString("hex"),
        storageKey: crypto.randomBytes(32).toString("hex"),
      }
    };
    res.json(config);
  });

  app.get("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const { password: _, privateKey: __, ...sanitized } = server;
    res.json(sanitized);
  });

  app.put("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    const idx = db.servers.findIndex((s: any) => s.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    db.servers[idx] = { ...db.servers[idx], ...req.body };
    saveDB(db);
    const { password: _, privateKey: __, ...sanitized } = db.servers[idx];
    res.json(sanitized);
  });

  app.post("/api/servers/:id/upload", upload.single("file"), (req: any, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!req.file.path.startsWith("/tmp/")) {
      res.status(400).json({ error: "Invalid local file path" });
      return;
    }

    const safeOriginalName = path.basename(req.file.originalname);
    const rawRemotePath = req.body.remotePath || `/tmp/${safeOriginalName}`;
    const sanitizedRemotePath = safePosixPath(rawRemotePath, server.username);
    if (!sanitizedRemotePath) {
      const localPath = req.file.path.startsWith("/tmp/") ? path.join("/tmp", path.basename(req.file.path)) : null;
      if (localPath) fs.unlinkSync(localPath);
      res.status(400).json({
        error: "Remote path must be within /tmp/ or /home/<username>/",
      });
      return;
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }

          const safeLocalPath = path.join("/tmp", path.basename(req.file.path));
          const readStream = fs.createReadStream(safeLocalPath);
          const writeStream = sftp.createWriteStream(sanitizedRemotePath);
          writeStream.on("close", () => {
            conn.end();
            fs.unlinkSync(safeLocalPath);
            res.json({ remotePath: sanitizedRemotePath });
          });
          writeStream.on("error", (err: any) => {
            conn.end();
            fs.unlinkSync(safeLocalPath);
            res.status(500).json({ error: err.message });
            return;
          });
          readStream.pipe(writeStream);
          return;
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/destroy", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        // Use interactive bash shell to handle sudo properly
        conn.exec("sudo -S -p 'SUDO_PROMPT:' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }

          // Send password first
          stream.write(server.password + "\n");

          // Then send the cleanup commands
          const destroyCmd = [
            'echo "Initiating nuclear cleanup..."',
            "docker stop $(docker ps -aq) 2>/dev/null || true",
            "docker rm $(docker ps -aq) 2>/dev/null || true",
            "docker system prune -af --volumes 2>/dev/null || true",
            "apt-get purge -y docker-engine docker docker.io docker-ce docker-ce-cli containerd containerd.io 2>/dev/null || yum remove -y docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine 2>/dev/null || true",
            "rm -rf /var/lib/docker /etc/docker /var/lib/containerd /var/run/docker.sock 2>/dev/null || true",
            'echo "Cleanup complete. System is clean."',
            "exit"
          ].join("\n");

          stream.write(destroyCmd + "\n");
          stream.end();

          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            const log = shellSanitize(output, server.password);
            // A rejected sudo password leaves the host untouched, so reporting
            // success here would drop the host from the fleet for nothing.
            const sudoFailed = /SUDO_PROMPT|Sorry, try again|incorrect password/i.test(output);
            if (sudoFailed || code !== 0) {
              res.json({
                success: false,
                error: sudoFailed
                  ? "sudo rejected the stored password; nothing was removed."
                  : `Cleanup exited with code ${code}.`,
                log,
              });
              return;
            }
            const dbAfter = getDB();
            dbAfter.servers = dbAfter.servers.filter((s: any) => s.id !== req.params.id);
            saveDB(dbAfter);
            res.json({ success: true, log });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/exec", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const { command } = req.body;
    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "Missing or invalid command" });
      return;
    }

    let safeCommand = "";
    for (const allowedCmd of ALLOWED_EXEC_COMMANDS) {
      if (allowedCmd === command.trim()) {
        safeCommand = allowedCmd;
        break;
      }
    }

    if (!safeCommand) {
      res.status(403).json({
        error: "Command not permitted. Use one of the allowed commands.",
        allowed: [...ALLOWED_EXEC_COMMANDS],
      });
      return;
    }

    const conn = new Client();
    let output = "";
    let errorStr = "";
    conn
      .on("ready", () => {
        conn.exec("/bin/sh -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }
          stream.write(safeCommand + "\n");
          stream.end();

          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ code, output, error: errorStr });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/deploy-dockerfile", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const { dockerfile, containerName, portMapping } = req.body;
    if (!dockerfile || !containerName) {
      res.status(400).json({ error: "Missing parameters" });
      return;
    }

    if (typeof containerName !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name. Only lowercase alphanumeric, hyphens, and underscores allowed." });
      return;
    }
    const safeContainerName = containerName;

    let safePortFlag = "";
    if (portMapping) {
      if (typeof portMapping !== 'string' || !/^\d{1,5}:\d{1,5}$/.test(portMapping.trim())) {
        res.status(400).json({ error: "Invalid port mapping format. Use HOST:CONTAINER (e.g. 8080:80)" });
        return;
      }
      safePortFlag = `-p ${portMapping.trim()}`;
    }

    const workDir = `/tmp/gantrycast-deploy-${safeContainerName}-${Date.now()}`;
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }

          const remoteDockerfile = `${workDir}/Dockerfile`;
          stream.write(`mkdir -p ${shellEscape(workDir)} && cat > ${shellEscape(remoteDockerfile)}\n`);
          stream.write(dockerfile);
          stream.end();

          stream.on("close", (code: number) => {
            if (code !== 0) {
              conn.end();
              res.status(500).json({ error: `Setup failed with code ${code}` });
              return;
            }

            const buildAndRun = [
              `docker build -t ${shellEscape(safeContainerName)} ${shellEscape(workDir)}`,
              `docker rm -f ${shellEscape(safeContainerName)} 2>/dev/null || true`,
              `docker run -d --name ${shellEscape(safeContainerName)} ${safePortFlag} ${shellEscape(safeContainerName)}`,
              `rm -rf ${shellEscape(workDir)}`
            ].join(" && ");

            conn.exec("sudo -S -p '' bash -s", (execErr, execStream) => {
              if (execErr) {
                conn.end();
                  res.status(500).json({ error: execErr.message });
                return;
              }
              execStream.write(server.password + "\n");
              execStream.write(buildAndRun + "\n");
              execStream.end();

              let output = "";
              let errorStr = "";
              execStream.on("data", (data: Buffer) => {
                output += data.toString();
              });
              execStream.stderr.on("data", (data: Buffer) => {
                errorStr += data.toString();
              });
              execStream.on("close", (exitCode: number) => {
                conn.end();
                  res.json({ 
                  code: exitCode, 
                  output: shellSanitize(output, server.password), 
                  error: shellSanitize(errorStr, server.password) 
                });
              });
            });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/stop-container", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const { containerName } = req.body;
    if (typeof containerName !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name" });
      return;
    }
    const safeContainerName = containerName;

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("sudo -S -p '' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }
          stream.write(server.password + "\n");
          stream.write(`docker rm -f ${safeContainerName}\n`);
          stream.end();

          let output = "";
          let errorStr = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ 
              code, 
              output: shellSanitize(output, server.password), 
              error: shellSanitize(errorStr, server.password) 
            });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });
  
  app.get("/api/servers/:id/stats", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        const statsCmd = `top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" && free | grep Mem | awk '{print $3/$2 * 100.0}' && df -h / | awk 'NR==2{print $5}'`;
        conn.exec(statsCmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const lines = output.trim().split("\n");
            const cpuIdle = parseFloat(lines[0] || "100");
            const memUsage = parseFloat(lines[1] || "0");
            const diskUsage = (lines[2] || "0%").replace("%", "");
            
            res.json({
              cpu: (100 - cpuIdle).toFixed(1),
              memory: memUsage.toFixed(1),
              disk: diskUsage,
            });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Stats failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.get("/api/servers/:id/containers", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        // Try docker ps without sudo first, fall back to sudo if needed
        const cmd = "docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}' 2>/dev/null || sudo docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}' 2>/dev/null || echo ''";
        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const containers = output.trim().split("\n").filter(Boolean).map(line => {
              const parts = line.split("|");
              if (parts.length === 5) {
                const [name, image, status, ports, id] = parts;
                return { name, image, status, ports, id };
              }
              return null;
            }).filter(Boolean);
            res.json(containers);
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.delete("/api/servers/:id/containers/:name", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const containerName = req.params.name;
    if (!/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name" });
      return;
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("sudo -S -p '' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
            return;
          }
          stream.write(server.password + "\n");
          stream.write(`docker rm -f ${containerName}\n`);
          stream.end();

          let output = "";
          let errorStr = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ 
              code, 
              output: shellSanitize(output, server.password), 
              error: shellSanitize(errorStr, server.password) 
            });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
        return;
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/clusters/:id/deploy-sample", async (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) {
      res.status(404).json({ error: "Cluster not found" });
      return;
    }
    const results: any[] = [];
    for (const serverId of cluster.serverIds) {
      const server = db.servers.find((s: any) => s.id === serverId);
      if (!server) {
        results.push({ serverId, error: "Server not found" });
        continue;
      }
      const conn = new Client();
      await new Promise((resolve) => {
        conn
          .on("ready", () => {
            conn.exec("docker run -d --name prod-nginx -p 8080:80 nginx", (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                resolve(null);
              }
              let output = "";
              let errorStr = "";
              stream.on("data", (data: Buffer) => (output += data.toString()));
              stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
              stream.on("close", (code: number) => {
                results.push({ serverId, code, output, error: errorStr });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err: any) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect(getServerSSHConfig(server));
      });
    }
    res.json({ results });
  });

  app.post("/api/clusters/:id/simulate-load", async (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) {
      res.status(404).json({ error: "Cluster not found" });
      return;
    }
    const results: any[] = [];
    for (const serverId of cluster.serverIds) {
      const server = db.servers.find((s: any) => s.id === serverId);
      if (!server) {
        results.push({ serverId, error: "Server not found" });
        continue;
      }
      const conn = new Client();
      await new Promise((resolve) => {
        conn
          .on("ready", () => {
            const cmd = `nohup sh -c 'for i in $(seq 1 5); do wget -qO /dev/null http://speedtest.tele2.net/10MB.zip; done & dd if=/dev/zero of=/dev/null bs=1M count=2000 &' >/dev/null 2>&1 &`;
            conn.exec(cmd, (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                resolve(null);
              }
              stream.on("close", (code: number) => {
                results.push({ serverId, code, output: "Load simulation started" });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err: any) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect(getServerSSHConfig(server));
      });
    }
    res.json({ results });
  });

  app.get("/api/clusters", (_req: Request, res: Response) => {
    const db = getDB();
    res.json(db.clusters || []);
  });
  app.get("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) {
      res.status(404).json({ error: "Cluster not found" });
      return;
    }
    res.json(cluster);
  });
  app.post("/api/clusters", (req: Request, res: Response) => {
    const { name, serverIds } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const db = getDB();
    const newCluster = {
      id: crypto.randomUUID(),
      name,
      serverIds: serverIds || [],
    };
    db.clusters.push(newCluster);
    saveDB(db);
    res.json(newCluster);
  });
  app.put("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    const idx = db.clusters.findIndex((c: any) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: "Cluster not found" });
      return;
    }
    db.clusters[idx] = { ...db.clusters[idx], ...req.body };
    saveDB(db);
    res.json(db.clusters[idx]);
  });
  app.delete("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    db.clusters = db.clusters.filter((c: any) => c.id !== req.params.id);
    saveDB(db);
    res.status(204).end();
  });

  // ─── Telemetry ────────────────────────────────────────────────
  // Polled every 5s per host, so the route is built around three guards: a
  // pooled SSH connection (no handshake per poll), a short result cache plus
  // in-flight de-duplication (a burst of polls costs one exec), and a hard 8s
  // budget (a hung host must not pin a request).
  const TELEMETRY_TIMEOUT_MS = 8_000;
  const TELEMETRY_CACHE_MS = 2_000;
  // One dropped packet must not flip a healthy host to "offline" in the UI.
  const TELEMETRY_OFFLINE_AFTER = 3;

  type TelemetryPayload = Record<string, string>;

  const telemetryCache = new Map<string, { at: number; payload: TelemetryPayload }>();
  const telemetryInFlight = new Map<string, Promise<TelemetryPayload>>();
  const telemetryFailures = new Map<string, number>();

  class TelemetryTimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TelemetryTimeoutError";
    }
  }

  function markHostOffline(id: string) {
    const freshDb = getDB();
    const srv = freshDb.servers.find((s: any) => s.id === id);
    if (srv && srv.status !== "offline") {
      srv.status = "offline";
      saveDB(freshDb);
    }
  }

  function recordTelemetrySuccess(server: any, stats: TelemetryPayload) {
    const freshDb = getDB();
    const srv = freshDb.servers.find((s: any) => s.id === server.id);
    if (srv) {
      const dockerInstalled = !!(stats.docker && stats.docker !== "none");
      const installed = srv.installed ?? { docker: false };
      // Only touch the file when something actually changed: this runs on every
      // poll of every host.
      if (srv.status !== "online" || installed.docker !== dockerInstalled) {
        srv.status = "online";
        // Rebuilt rather than spread: a db.json written before the Kubernetes
        // removal still carries an `installed.k8s` key, and spreading would
        // keep it alive forever.
        srv.installed = { docker: dockerInstalled };
        saveDB(freshDb);
      }
    }
    telemetryFailures.delete(server.id);
    telemetryCache.set(server.id, { at: Date.now(), payload: stats });
  }

  function recordTelemetryFailure(server: any) {
    const failures = (telemetryFailures.get(server.id) ?? 0) + 1;
    telemetryFailures.set(server.id, failures);
    if (failures >= TELEMETRY_OFFLINE_AFTER) markHostOffline(server.id);
  }

  async function collectTelemetry(server: any): Promise<TelemetryPayload> {
    // The abort controller is the hard deadline: it kills the remote command
    // and rejects, so a host that stops answering cannot hold the request open.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      const result = await execOnServer(server, TELEMETRY_SCRIPT, {
        timeoutMs: TELEMETRY_TIMEOUT_MS,
        signal: controller.signal,
        retries: 1,
      });
      const stats = parseTelemetry(result.stdout);
      recordTelemetrySuccess(server, stats);
      return stats;
    } catch (err) {
      recordTelemetryFailure(server);
      if (err instanceof SshPoolError && (err.code === "timeout" || err.code === "aborted")) {
        throw new TelemetryTimeoutError(
          `Telemetry collection for ${server.name || server.host} timed out after ${TELEMETRY_TIMEOUT_MS / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(deadline);
    }
  }

  app.get("/api/servers/:id/telemetry", async (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    // A burst of polls (tab focus, several clients) must cost one exec.
    const cached = telemetryCache.get(server.id);
    if (cached && Date.now() - cached.at < TELEMETRY_CACHE_MS) {
      res.json(cached.payload);
      return;
    }

    // De-duplicate per host: a poll already in flight is shared, not repeated.
    let pending = telemetryInFlight.get(server.id);
    if (!pending) {
      pending = collectTelemetry(server).finally(() => {
        telemetryInFlight.delete(server.id);
      });
      telemetryInFlight.set(server.id, pending);
    }

    try {
      res.json(await pending);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TelemetryTimeoutError) {
        res.status(504).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // Loopback by default: this process holds root SSH credentials for every
  // managed host, so it must not be reachable from the network unless asked.
  const HOST = process.env.HOST || "127.0.0.1";
  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });

  // Pooled SSH connections are long-lived, so they have to be torn down
  // explicitly or the process lingers after a restart.
  const shutdown = () => {
    closeSshPool();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => closeSshPool());

  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ssh" });

  const wsConnectionCount = new Map<string, number>();
  const WS_MAX_CONNECTIONS_PER_IP = 10;
  const WS_RATE_WINDOW_MS = 60_000;
  // Keystrokes and control frames need very different ceilings: a human typing
  // bursts well past 200 frames a minute, while connect/deploy must stay rare.
  const WS_CONTROL_LIMIT = 200;
  const WS_INPUT_LIMIT = 3000;
  const wsRateTracker = new Map<string, { control: number; input: number; resetAt: number }>();

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin;
    if (process.env.NODE_ENV === "production") {
      // A browser always sends Origin. Rejecting its absence keeps non-browser
      // clients from opening a shell without going through the UI.
      const host = req.headers.host;
      if (!origin || (origin !== `http://${host}` && origin !== `https://${host}`)) {
        ws.close(1008, "Origin not allowed");
        return;
      }
    }
    const ip = req.socket.remoteAddress ?? "unknown";

    const currentConns = wsConnectionCount.get(ip) ?? 0;
    if (currentConns >= WS_MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    wsConnectionCount.set(ip, currentConns + 1);
    ws.on("close", () => {
      const remaining = Math.max(0, (wsConnectionCount.get(ip) ?? 1) - 1);
      if (remaining === 0) {
        wsConnectionCount.delete(ip);
        wsRateTracker.delete(ip);
      } else {
        wsConnectionCount.set(ip, remaining);
      }
    });

    function checkMessageRate(kind: "control" | "input"): boolean {
      const now = Date.now();
      let tracker = wsRateTracker.get(ip);
      if (!tracker || now > tracker.resetAt) {
        tracker = { control: 0, input: 0, resetAt: now + WS_RATE_WINDOW_MS };
        wsRateTracker.set(ip, tracker);
      }
      tracker[kind] += 1;
      return tracker[kind] <= (kind === "input" ? WS_INPUT_LIMIT : WS_CONTROL_LIMIT);
    }

    let sshClient: Client | null = null;
    let connectedServerId: string | null = null;
    let shellStream: { write: (data: string) => void } | null = null;

    const provisionSnippets = {
      ensureCurl: [
        'if command -v curl >/dev/null 2>&1; then echo \"  -> curl already installed\";',
        'elif command -v apt-get >/dev/null 2>&1; then while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/dpkg/lock >/dev/null 2>&1; do sleep 2; done; sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates;',
        'elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install curl ca-certificates;',
        'elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install curl ca-certificates;',
        'elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache curl ca-certificates;',
        'elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm curl ca-certificates;',
        'elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y curl ca-certificates;',
        'else echo \"ERROR: unsupported OS (no known package manager to install curl)\"; exit 1; fi',
      ].join(" "),
      ensureBasicTools: [
        "if command -v apt-get >/dev/null 2>&1; then",
        "  echo 'Waiting for apt lock to clear...';",
        "  while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/dpkg/lock >/dev/null 2>&1 || sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do sleep 2; done;",
        "  sudo apt-get update -qq;",
        "  sudo apt-get install -y -qq wget ca-certificates gnupg;",
        "  sudo apt-get install -y -qq lsb-release 2>/dev/null || true;",
        "  sudo apt-get install -y -qq apt-transport-https 2>/dev/null || true;",
        "  sudo apt-get install -y -qq software-properties-common 2>/dev/null || true;",
        "elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install wget ca-certificates gnupg2 redhat-lsb-core;",
        "elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install wget ca-certificates gnupg2 redhat-lsb-core;",
        "elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache wget ca-certificates gnupg;",
        "elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm wget ca-certificates gnupg;",
        "elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y wget ca-certificates gpg2;",
        'else echo \"WARN: skipping noncritical prereqs (unknown package manager)\"; fi',
      ].join(" "),
    } as const;

    ws.on("message", async (message: string) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        return;
      }

      if (!checkMessageRate(data?.type === "input" ? "input" : "control")) {
        ws.send(JSON.stringify({ type: "error", data: "Rate limit exceeded. Slow down." }));
        return;
      }

      if (data.type === "input") {
        if (!shellStream) {
          ws.send(JSON.stringify({ type: "error", data: "No active shell. Open a terminal first." }));
          return;
        }
        shellStream.write(data.data);
        return;
      }

      if (data.type === "connect") {
        const db = getDB();
        const server = db.servers.find((s: any) => s.id === data.serverId);

        if (!server) {
          ws.send(JSON.stringify({ type: "error", data: "Server not found in database" }));
          return;
        }

        // A reconnect on the same socket must not leave the old session open.
        shellStream = null;
        sshClient?.end();
        connectedServerId = server.id;
        sshClient = new Client();
        sshClient
          .on("ready", () => {
            const currentDb = getDB();
            const srv = currentDb.servers.find((s: any) => s.id === connectedServerId);
            if (srv) {
              srv.status = "online";
              saveDB(currentDb);
            }

            sshClient?.shell((err, stream) => {
              if (err) {
                ws.send(JSON.stringify({ type: "error", data: err.message }));
                return;
              }
              const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const sanitizers = server.password ? [{ pattern: new RegExp(escape(server.password), 'g'), replacement: '********' }] : [];
              const sanitize = (text: string): string => {
                let out = text;
                for (const s of sanitizers) out = out.replace(s.pattern, s.replacement);
                return out;
              };

              stream.on("data", (chunk: Buffer) => {
                ws.send(JSON.stringify({ type: "data", data: sanitize(chunk.toString()) }));
              });
              stream.on("close", () => {
                if (shellStream === stream) shellStream = null;
                ws.send(JSON.stringify({ type: "status", data: "Disconnected" }));
              });

              // Register the stream before announcing the connection: the client
              // auto-runs commands the moment it sees "Connected".
              shellStream = stream;
              ws.send(JSON.stringify({ type: "status", data: "Connected" }));
            });
          })
          .on("error", (err: any) => {
            ws.send(JSON.stringify({ type: "error", data: err.message }));
          })
          .connect(getServerSSHConfig(server));
        return;
      }

      if (data.type === "deploy") {
        if (!sshClient) {
          ws.send(JSON.stringify({ type: "error", data: "No active SSH connection. Open a terminal first." }));
          return;
        }

        const { scriptType } = data;
        const ALLOWED_SCRIPT_TYPES = new Set(["docker", "verify", "full", "template"]);
        if (!ALLOWED_SCRIPT_TYPES.has(scriptType)) {
          ws.send(JSON.stringify({ type: "error", data: "Unknown script type." }));
          return;
        }

        if (scriptType === "template") {
          const db = getDB();
          const server = db.servers.find((s: any) => s.id === connectedServerId);
          if (!server) {
            ws.send(JSON.stringify({ type: "error", data: "Server context lost." }));
            return;
          }

          // Every template step runs through `sudo -S`, so a key-only host has
          // no password to feed it and would fail silently step by step.
          if (!server.password) {
            ws.send(JSON.stringify({
              type: "error",
              data: "Template deploys need a stored sudo password; this host uses key authentication.",
            }));
            return;
          }

          try {
            await deployTemplate({
              sshClient,
              ws,
              sudoPassword: server.password,
              config: data.templateConfig as TemplateConfig
            });
          } catch (err: any) {
            // deployTemplate can throw before its own error handling (missing
            // config), and an unhandled rejection here would kill the process.
            ws.send(JSON.stringify({ type: "error", data: err?.message ?? "Template deploy failed." }));
          }
          return;
        }

        let command = "";
        if (scriptType === "docker") {
          command = [
            "set -e",
            'echo \"[1/3] Ensuring curl...\"',
            provisionSnippets.ensureCurl,
            'echo \"[2/3] Installing Docker (get.docker.com)...\"',
            'if command -v docker > /dev/null 2>&1; then echo \"  -> Docker already installed: $(docker --version)\"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo \"  -> Docker installed successfully\"; fi',
            'echo \"[3/3] Done.\"',
          ].join(" && ");
        } else if (scriptType === "verify") {
          command = [
            "set -e",
            'echo \"===========================================\"',
            'echo \"        GantryCast Stack Verification\"',
            'echo \"===========================================\"',
            'echo \"\"',
            'echo \"[1/2] Docker binary...\"',
            'if command -v docker >/dev/null 2>&1; then echo \"  -> $(docker --version)\"; else echo \"  -> MISSING\"; fi',
            'echo \"\"',
            'echo \"[2/2] Docker service...\"',
            'if command -v systemctl >/dev/null 2>&1; then echo \"  -> $(sudo systemctl is-active docker 2>/dev/null || echo not-running)\"; else echo \"  -> (no systemctl)\"; fi',
            'echo \"\"',
            'echo \"=== VERIFY COMPLETE ===\"',
          ].join(" && ");
        } else if (scriptType === "full") {
          command = [
            'echo \"==========================================\"',
            'echo \"   GantryCast Full Stack Deployment\"',
            'echo \"==========================================\"',
            'echo \"\"',
            "set -e",
            'echo \"[1/4] Ensuring curl...\"',
            provisionSnippets.ensureCurl,
            'echo \"\"',
            'echo \"[2/4] Installing prerequisites...\"',
            provisionSnippets.ensureBasicTools,
            'echo \"\"',
            'echo \"[3/4] Installing Docker...\"',
            'if command -v docker > /dev/null 2>&1; then echo \"  -> Docker already installed: $(docker --version)\"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo \"  -> Docker installed successfully\"; fi',
            'echo \"\"',
            'echo \"[4/4] Verifying services...\"',
            'echo \"===========================================\"',
            'echo \"  Docker: $(sudo systemctl is-active docker 2>/dev/null || echo not-running)\"',
            'echo \"===========================================\"',
            'echo \"\"',
            'echo \"=== DEPLOYMENT COMPLETE ===\"',
          ].join(" && ");
        }

        if (command) {
          const db = getDB();
          const connectedServer = connectedServerId ? db.servers.find((s: any) => s.id === connectedServerId) : null;
          const sudoPassword: string = connectedServer?.password || "";
          const requiresSudo = /\bsudo\b/.test(command);
          
          if (requiresSudo && !sudoPassword) {
            ws.send(JSON.stringify({ type: "error", data: "This deploy requires sudo, but no password is stored for this server." }));
            return;
          }

          try {
            if (!sshClient || (sshClient as any)._state === 'closed' || (sshClient as any)._state === 'unconnected') {
              throw new Error("SSH connection lost or not established.");
            }

            const shellCmd = requiresSudo ? "sudo -S -p '' bash -s" : "bash -s";
            sshClient.exec(shellCmd, (err, stream) => {
              if (err) {
                ws.send(JSON.stringify({ type: "error", data: err.message }));
                return;
              }

              if (requiresSudo) {
                stream.write(sudoPassword + "\n");
              }
              stream.write(command + "\n");
              stream.end();

              // Password already sent above, but we keep the listener for robustness
              let sudoSent = requiresSudo;
              const maybeSendSudo = () => {
                if (!requiresSudo || sudoSent) return;
                sudoSent = true;
                stream.write(sudoPassword + "\n");
              };

              const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const sanitizers = sudoPassword ? [{ pattern: new RegExp(escape(sudoPassword), 'g'), replacement: '********' }] : [];
              const sanitize = (text: string): string => {
                let out = text;
                for (const s of sanitizers) out = out.replace(s.pattern, s.replacement);
                return out;
              };

              stream.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                if (!sudoSent && /password/i.test(text)) maybeSendSudo();
                ws.send(JSON.stringify({ type: "data", data: sanitize(text) }));
              });
              stream.stderr.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                if (!sudoSent && /password/i.test(text)) maybeSendSudo();
                ws.send(JSON.stringify({ type: "data", data: sanitize(text) }));
              });
              stream.on("close", (code: number) => {
                if (code !== 0) {
                  // Without this the user only sees raw output and no verdict.
                  ws.send(JSON.stringify({
                    type: "error",
                    data: `${scriptType} failed with exit code ${code}.`,
                  }));
                  return;
                }
                if (connectedServerId) {
                  const dbLatest = getDB();
                  const srv = dbLatest.servers.find((s: any) => s.id === connectedServerId);
                  if (srv) {
                    if (scriptType === "docker" || scriptType === "full") srv.installed.docker = true;
                    saveDB(dbLatest);
                  }
                  ws.send(JSON.stringify({ type: "status", data: `${scriptType} installed successfully` }));
                }
              });
            });
          } catch (execErr: any) {
            ws.send(JSON.stringify({ type: "error", data: `SSH Execution failed: ${execErr.message}` }));
          }
        }
      }
    });

    ws.on("close", () => {
      shellStream = null;
      sshClient?.end();
    });
  });

  // An unknown API path must not fall through to the SPA shell: a 200 with
  // index.html makes a typo'd endpoint look like a successful call.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  const isProd = process.env.NODE_ENV === "production";

  if (!isProd) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Bundled output lives at dist/server.js, so the static root is its sibling.
    const distPath = process.env.DIST_PATH || path.join(__dirname, "..", "dist");

    console.log(`[Production] Serving static files from: ${distPath}`);
    
    if (!fs.existsSync(distPath)) {
      console.error(`[Error] Static folder NOT FOUND at: ${distPath}`);
    }

    app.use(express.static(distPath, {
      index: false,
      setHeaders: (res, path) => {
        if (path.endsWith(".js")) res.setHeader("Content-Type", "application/javascript");
        if (path.endsWith(".css")) res.setHeader("Content-Type", "text/css");
        if (path.endsWith(".html")) res.setHeader("Content-Type", "text/html");
      }
    }));

    app.get("*", pageLimiter, (_req: Request, res: Response) => {
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send(`Frontend index.html not found at ${indexPath}`);
      }
    });
  }
}

startServer().catch(err => {
    console.error("Failed to start server:", err);
});