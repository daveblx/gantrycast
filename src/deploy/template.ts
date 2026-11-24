import { Client } from 'ssh2';
import { WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { TemplateConfigValidator, EnvironmentValidator } from './template.validation';

export interface TemplateConfig {
  domain: string;
  email: string;
  duckdnsToken?: string;
  profiles: string[];
  cloudflare?: {
    apiToken: string;
    zoneId: string;
  };
  authelia?: {
    jwtSecret: string;
    sessionSecret: string;
    storageKey: string;
  };
  services?: Record<string, Record<string, string>>;
}

/*
 * The upstream template ships ~120 apps. Every deploy runs this pruner first
 * so only the apps the deploy modal can offer survive: their compose files,
 * include entries, Authelia env wiring and Authelia access_control rules are
 * kept, and everything pointing at a removed app is dropped. It exits
 * non-zero if a surviving file still needs a variable we no longer write.
 *
 * Kept in sync with PROFILES in components/modals/DeployTemplateModal.tsx.
 */
const PRUNE_SCRIPT = String.raw`import os
import re
import shutil
import sys

ROOT = os.environ.get("PURGE_ROOT", "/opt/docker")
APPS = os.path.join(ROOT, "apps")
KEEP_APPS = ["traefik", "authelia", "vaultwarden", "immich", "beszel"]
KEEP = set(KEEP_APPS)


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def write(path, content):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def env_keys(path):
    if not os.path.isfile(path):
        return set()
    return set(re.findall(r"^([A-Za-z0-9_]+)=", read(path), re.M))


root_env = env_keys(os.path.join(ROOT, ".env"))

# ── 1. Drop every app that is not in the keep list ─────────────────────────
removed = []
if os.path.isdir(APPS):
    for name in sorted(os.listdir(APPS)):
        path = os.path.join(APPS, name)
        if os.path.isdir(path) and name not in KEEP:
            shutil.rmtree(path)
            removed.append(name)
print("Removed %d app directories." % len(removed))

# Persisted state for those apps is dead weight too.
for sub in ("data",):
    base = os.path.join(ROOT, sub)
    if not os.path.isdir(base):
        continue
    for name in sorted(os.listdir(base)):
        path = os.path.join(base, name)
        if os.path.isdir(path) and name not in KEEP:
            shutil.rmtree(path)

# ── 2. Root compose.yaml: include only the kept apps ───────────────────────
compose_path = os.path.join(ROOT, "compose.yaml")
lines = []
for line in read(compose_path).splitlines():
    include = re.match(r"^\s*-\s*apps/([^/]+)/compose\.yaml\s*$", line)
    if include and include.group(1) not in KEEP:
        continue
    # Commented-out example includes point at apps that no longer exist, and
    # the prose around them only makes sense with those apps present.
    if re.match(r"^\s*#\s*-\s*apps/", line):
        continue
    if re.match(r"^\s*#\s*(Uncomment|If you would like|It is recommended|same as above|There is also a way|To use both|You will also need)", line):
        continue
    lines.append(line)
write(compose_path, "\n".join(lines) + "\n")

# ── 3. Authelia compose: drop env entries for variables we do not define ───
authelia = os.path.join(APPS, "authelia")
defined = root_env | env_keys(os.path.join(authelia, ".env"))
compose = os.path.join(authelia, "compose.yaml")

lines = read(compose).splitlines()
out = []
dropped = []
i = 0
while i < len(lines):
    line = lines[i]
    match = re.match(r"^(\s+)(TEMPLATE_[A-Za-z0-9_]+):\s", line)
    if not match:
        out.append(line)
        i += 1
        continue
    indent = len(match.group(1))
    block = [line]
    j = i + 1
    while j < len(lines):
        nxt = lines[j]
        if not nxt.strip() or len(nxt) - len(nxt.lstrip()) <= indent:
            break
        block.append(nxt)
        j += 1
    refs = set(re.findall(r"\$\{([A-Za-z0-9_]+)", "\n".join(block)))
    if refs and refs <= defined:
        out.extend(block)
        i = j
        continue
    while out and re.match(r"^\s*#", out[-1]):
        out.pop()
    dropped.append(match.group(2))
    i = j
write(compose, "\n".join(out) + "\n")
print("Dropped %d Authelia template variables." % len(dropped))

# ── 4. Authelia config: drop access_control rules for removed apps ─────────
config = os.path.join(authelia, "config", "configuration.yml")
templated = set(re.findall(r"^\s+(TEMPLATE_[A-Za-z0-9_]+):", read(compose), re.M))

lines = read(config).splitlines()
start = next(idx for idx, line in enumerate(lines) if re.match(r"^access_control:", line))
end = len(lines)
for idx in range(start + 1, len(lines)):
    if re.match(r"^[A-Za-z_]", lines[idx]):
        end = idx
        break

out = []
dropped = 0
i = start
while i < end:
    line = lines[i]
    if not re.match(r"^\s{4}-\s", line):
        out.append(line)
        i += 1
        continue
    block = [line]
    j = i + 1
    while j < end and not re.match(r"^\s{4}-\s", lines[j]):
        block.append(lines[j])
        j += 1
    refs = set(re.findall(r'env "([A-Za-z0-9_]+)"', "\n".join(block)))
    if refs and refs <= templated:
        out.extend(block)
        i = j
        continue
    while out and re.match(r"^\s*#", out[-1]):
        out.pop()
    dropped += 1
    i = j
write(config, "\n".join(lines[:start] + out + lines[end:]) + "\n")
print("Dropped %d Authelia access_control rules." % dropped)

# ── 5. Strip leftover Stremio prose from comments in kept files ────────────
scrubbed = 0
for app in KEEP_APPS:
    for dirpath, _dirnames, filenames in os.walk(os.path.join(APPS, app)):
        for filename in filenames:
            if not filename.endswith((".yaml", ".yml", ".env")):
                continue
            path = os.path.join(dirpath, filename)
            kept = []
            changed = False
            for line in read(path).splitlines():
                stripped = line.strip()
                if stripped.startswith("#") and re.search(r"stremio", line, re.I):
                    scrubbed += 1
                    changed = True
                    continue
                kept.append(line)
            if changed:
                write(path, "\n".join(kept) + "\n")
print("Scrubbed %d Stremio comment lines." % scrubbed)

# ── 6. Verify nothing left behind still needs a removed app ────────────────
problems = []
for dirpath, _dirnames, filenames in os.walk(ROOT):
    for filename in filenames:
        if not filename.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(dirpath, filename)
        rel = os.path.relpath(path, ROOT)
        allowed = set(root_env)
        parts = rel.split(os.sep)
        if parts[0] == "apps" and len(parts) > 2:
            allowed |= env_keys(os.path.join(APPS, parts[1], ".env"))
        text = read(path)
        for var in set(re.findall(r"\$\{([A-Za-z0-9_]+)\}", text)):
            if var not in allowed:
                problems.append("%s references undefined %s" % (rel, var))

if problems:
    print("PURGE VERIFICATION FAILED:")
    for problem in sorted(set(problems)):
        print("  " + problem)
    sys.exit(1)

print("Purge complete: %s" % ", ".join(KEEP_APPS))
`;

export async function deployTemplate(params: {
  sshClient: Client;
  ws: WebSocket;
  sudoPassword: string;
  config: TemplateConfig;
}): Promise<void> {
  const { sshClient, ws, sudoPassword, config } = params;

  // ── WebSocket Safe Sender ─────────────────────────────────────────────
  const safeWsSend = (obj: any) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error("WebSocket send failed:", e);
    }
  };
  const log    = (msg: string) => safeWsSend({ type: "data",   data: `\r\n[DEPLOY] ${msg}\r\n` });
  const status = (msg: string) => safeWsSend({ type: "status", data: msg });
  const error  = (msg: string) => safeWsSend({ type: "error",  data: msg });

  // ── Input Validation ──────────────────────────────────────────────────
  const SAFE_DOMAIN  = /^[a-zA-Z0-9.-]+$/;
  const SAFE_EMAIL   = /^[a-zA-Z0-9.@_+-]+$/;
  const SAFE_PROFILE = /^[a-z0-9_-]+$/i;

  if (!SAFE_DOMAIN.test(config.domain)) {
    error(`Invalid domain format: ${config.domain}`);
    return;
  }
  if (!SAFE_EMAIL.test(config.email)) {
    error(`Invalid email format: ${config.email}`);
    return;
  }
  if (!config.profiles.every(p => SAFE_PROFILE.test(p))) {
    error("One or more selected profiles contain invalid characters.");
    return;
  }

  // DuckDNS validation: Ensure subdomain format if using duckdns.org
  if (config.domain === "duckdns.org" || config.domain.endsWith(".duckdns.org")) {
    const parts = config.domain.split('.');
    if (parts.length < 3) {
      error("For DuckDNS, domain must be in the format 'subdomain.duckdns.org'");
      return;
    }
  }

  // ── Secret Sanitisers ─────────────────────────────────────────────────
  const buildSanitizers = () => {
    const sanitizers: Array<{ pattern: RegExp; replacement: string }> = [];
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (sudoPassword) sanitizers.push({ pattern: new RegExp(escape(sudoPassword), 'g'), replacement: '********' });
    return sanitizers;
  };
  const sanitizers = buildSanitizers();
  const sanitize = (text: string): string => {
    for (const s of sanitizers) text = text.replace(s.pattern, s.replacement);
    return text;
  };

  // ── Command Executor (REVERTED TO WORKING VERSION) ────────────────────
  const execCommand = (cmd: string, stepName: string, stopOnError = true): Promise<boolean> =>
    new Promise((resolve) => {
      log(`Executing: ${stepName}...`);
      const SUDO_PROMPT = "[gantrycast-sudo-prompt]";
      // Use bash -s to execute the command safely via stdin
      const shellCmd = `sudo -S -p "${SUDO_PROMPT}" bash -s`;

      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      sshClient.exec(shellCmd, (err, stream) => {
        if (err) { error(`SSH Error: ${err.message}`); finish(false); return; }

        // Send password first for sudo -S, then the command
        stream.write(sudoPassword + "\n");
        stream.write(cmd + "\n");
        stream.end();

        // The password is sent exactly once, above. Re-sending it on any chunk
        // that happens to contain the prompt marker would type it into the
        // shell as a command, so every chunk is simply forwarded.
        const forward = (chunk: Buffer) => {
          safeWsSend({ type: "data", data: sanitize(chunk.toString()) });
        };

        stream.on("data", forward);
        // stderr carries the actual reason a step failed; dropping it left the
        // user with only "Step X failed code N".
        stream.stderr.on("data", forward);
        stream.on("error", (streamErr: Error) => {
          error(`Step ${stepName} errored: ${streamErr.message}`);
          finish(false);
        });

        stream.on("close", (code: number) => {
          if (code === 0) finish(true);
          else {
            if (stopOnError) { error(`Step ${stepName} failed code ${code}`); finish(false); }
            else finish(true);
          }
        });
      });
    });

  // ── Validate Configuration ─────────────────────────────────────────────
  try {
    TemplateConfigValidator.validate(config);
    EnvironmentValidator.validateDocker();
  } catch (validationErr: any) {
    error(`Configuration validation failed: ${validationErr.message}`);
    return;
  }

  try {
    // ── Step 1: Cleanup ────────────────────────────────────────────────
    status("Preparing directory...");
    await execCommand("rm -rf /opt/docker && mkdir -p /opt/docker", "Directory Reset");

    // ── Step 2: Clone and Apply Nuclear Patch ───────────────────────────
    status("Cloning and Patching Template...");
    // Build the Python patch script and encode it for safe transfer
    const pythonPatchScript = [
      `import os, re`,
      `path = 'apps/traefik/compose.yaml'`,
      `if not os.path.exists(path):`,
      `    exit(0)`,
      `with open(path, 'r') as f: content = f.read()`,
      ``,
      `# 0. Upgrade log level to DEBUG so ACME progress is visible in docker logs`,
      `content = content.replace('"--log.level=INFO"', '"--log.level=DEBUG"', 1)`,
      ``,
      `# 1. Ensure Cloudflare env vars are present`,
      `if 'CF_API_EMAIL' not in content:`,
      `    content = content.replace('environment:', 'environment:' + chr(10) + '      - CF_API_EMAIL=\${CF_API_EMAIL}' + chr(10) + '      - CF_DNS_API_TOKEN=\${CF_DNS_API_TOKEN}', 1)`,
      ``,
      `# 2. Remove DuckDNS env var`,
      `content = re.sub(r'^\\s*-\\s*DUCKDNS_TOKEN=.*$\\n?', '', content, flags=re.M)`,
      ``,
      `# 3. Replace TLS challenge with Cloudflare DNS-01 provider`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.tlschallenge=true"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', 1)`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', 1)`,
      ``,
      `# 4. Add delaybeforecheck=180 as its own distinct command entry`,
      `if 'delaybeforecheck' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', 1)`,
      `else:`,
      `    content = content.replace('delaybeforecheck=120', 'delaybeforecheck=180', 1)`,
      ``,
      `# 5. Add wildcard + apex SAN labels so LE issues a cert for BOTH *.domain AND domain`,
      `# The apex SAN is required; without it curl returns "unable to get local issuer certificate"`,
      `if 'tls.domains[0]' not in content:`,
      `    content = content.replace('"traefik.http.routers.api.tls.certresolver=letsencrypt"',`,
      `        '"traefik.http.routers.api.tls.certresolver=letsencrypt"' + chr(10)`,
      `        + '      - "traefik.http.routers.api.tls.domains[0].main=*.' + '\${DOMAIN}"' + chr(10)`,
      `        + '      - "traefik.http.routers.api.tls.domains[0].sans=' + '\${DOMAIN}"', 1)`,
      ``,
      `# 6. Add external DNS resolvers to avoid internal DNS caching issues`,
      `if 'dnschallenge.resolvers' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"', 1)`,
      ``,
      `# 7. Enable dynamic config file provider so we can set the default TLS store via YAML.`,
      `# --tls.stores.* are NOT valid CLI flags in Traefik v3; they must be in a dynamic config file.`,
      `if 'providers.file.filename' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"',`,
      `        '"--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"' + chr(10)`,
      `        + '      - "--providers.file.filename=/data/dynamic.yml"', 1)`,
      ``,
      `with open(path, 'w') as f: f.write(content)`,
      `print('Traefik patch applied.')`,
    ].join('\n');

    // Second script: replace tls.certresolver with tls=true for all non-Traefik app services.
    // This tells Traefik to use TLS but follow the default store's certificate (our wildcard)
    // instead of trying to generate a new cert per-service which can cause collisions or timeouts.
    const stripResolverScript = [
      `import os, re`,
      `apps_dir = 'apps'`,
      `for root, dirs, files in os.walk(apps_dir):`,
      `    if 'traefik' in root:`,
      `        continue`,
      `    for fname in files:`,
      `        if not fname.endswith('.yaml') and not fname.endswith('.yml'):`,
      `            continue`,
      `        fpath = os.path.join(root, fname)`,
      `        with open(fpath, 'r') as f: content = f.read()`,
      `        # Replace certresolver label with simple tls=true so they use the wildcard from the default store.`,
      `        # This regex is careful not to consume the closing quote or other surrounding characters.`,
      `        new_content = re.sub(r'(traefik\\\\.http\\\\.routers\\\\.[^.]+\\\\.tls)\\\\.certresolver=[^"\\\'\\\\s]+', r'\\\\1=true', content)`,
      `        if new_content != content:`,
      `            with open(fpath, 'w') as f: f.write(new_content)`,
      `            print('Updated TLS config for ' + fpath)`,
      `print('Service label update complete.')`,
    ].join('\n');

    const patchBase64 = Buffer.from(pythonPatchScript).toString('base64');
    const stripBase64 = Buffer.from(stripResolverScript).toString('base64');

    const cloneAndPatch = [
      `cd /opt/docker`,
      `git clone --depth 1 https://github.com/Viren070/docker-compose-template.git .`,
      `echo "${patchBase64}" | base64 -d > /tmp/patch_traefik.py`,
      `python3 /tmp/patch_traefik.py`,
      `rm -f /tmp/patch_traefik.py`,
      `echo "${stripBase64}" | base64 -d > /tmp/strip_resolver.py`,
      `python3 /tmp/strip_resolver.py`,
      `rm -f /tmp/strip_resolver.py`,
      `echo "Neuterizing YAMLs"`,
      `find . -type f \\( -name "*.yaml" -o -name "*.yml" \\) -exec sed -i 's/:?error/:-/g' {} +`,
      `find . -type f \\( -name "*.yaml" -o -name "*.yml" \\) -exec sed -i 's/:?err/:-/g' {} +`,
      `mkdir -p data/authelia apps`,
      `chown -R 1000:1000 /opt/docker`,
    ].join(' && ');

    
    if (!(await execCommand(cloneAndPatch, "Clone and Patch"))) return;
 
    // ── Step 2c: Configure Authelia Notifier (No SMTP) ──────────────────
    status("Configuring Authelia Notifier...");
    const autheliaPatch = [
      `import os, re`,
      `path = '/opt/docker/data/authelia/config/configuration.yml'`,
      `os.makedirs(os.path.dirname(path), exist_ok=True)`,
      `if not os.path.exists(path) and os.path.exists('/opt/docker/apps/authelia/configuration.yml'):`,
      `    import shutil`,
      `    shutil.copy('/opt/docker/apps/authelia/configuration.yml', path)`,
      `if os.path.exists(path):`,
      `    with open(path, 'r') as f: content = f.read()`,
      `    # Replace SMTP block with File notifier block`,
      `    pattern = r'notifier:\\s+smtp:.*?(\\n\\S|$)'`,
      `    replacement = 'notifier:\\n  file:\\n    path: /config/notification.txt\\n\\\\\\\\1'`,
      `    if 'notifier:' in content:`,
      `        if 'smtp:' in content:`,
      `            content = re.sub(pattern, replacement, content, flags=re.S)`,
      `        elif 'file:' not in content:`,
      `            content = content.replace('notifier:', 'notifier:\\n  file:\\n    path: /config/notification.txt', 1)`,
      `    else:`,
      `        content += \"\\nnotifier:\\n  file:\\n    path: /config/notification.txt\\n\"`,
      `    with open(path, 'w') as f: f.write(content)`,
      `    print('Authelia notifier set to file.')`,
    ].join('\n');
    const autheliaBase64 = Buffer.from(autheliaPatch).toString('base64');
    await execCommand(
      `echo "${autheliaBase64}" | base64 -d > /tmp/patch_authelia.py && python3 /tmp/patch_authelia.py && rm -f /tmp/patch_authelia.py`,
      "Patch Authelia Notifier"
    );

    // ── Step 2b: Reset acme.json + write dynamic.yml ─────────────────────
    status("Resetting acme.json and writing Traefik dynamic config...");
    await execCommand(
      `mkdir -p /opt/docker/data/traefik && rm -f /opt/docker/data/traefik/acme.json && touch /opt/docker/data/traefik/acme.json && chmod 600 /opt/docker/data/traefik/acme.json`,
      "Reset acme.json"
    );

    // Write the dynamic.yml that configures Traefik's default TLS store to serve the wildcard cert.
    // --tls.stores.* are dynamic-config-only in Traefik v3 (not valid CLI flags).
    // The defaultGeneratedCert block tells Traefik: use the letsencrypt resolver to obtain
    // *.domain + domain, and serve this wildcard as the default cert for ALL routers.
    // This eliminates the self-signed fallback for any service that has tls=true but no certresolver.
    const dynamicConfig = [
      `tls:`,
      `  stores:`,
      `    default:`,
      `      defaultGeneratedCert:`,
      `        resolver: letsencrypt`,
      `        domain:`,
      `          main: "*.${config.domain}"`,
      `          sans:`,
      `            - "${config.domain}"`,
    ].join("\n");
    const dynamicBase64 = Buffer.from(dynamicConfig).toString("base64");
    await execCommand(
      `echo "${dynamicBase64}" | base64 -d > /opt/docker/data/traefik/dynamic.yml`,
      "Write Traefik dynamic.yml"
    );

    // ── Step 3: Write .env ─────────────────────────────────────────────
    status("Writing root .env...");
    const genSecret = () => randomBytes(32).toString("hex");
    const jwtSecret     = config.authelia?.jwtSecret     || genSecret();
    const sessionSecret = config.authelia?.sessionSecret || genSecret();
    const storageKey    = config.authelia?.storageKey    || genSecret();


    
    const envLines = [
      `TZ=Etc/UTC`,
      `DOCKER_DIR=/opt/docker`,
      `DOCKER_DATA_DIR=/opt/docker/data`,
      `DOCKER_APP_DIR=/opt/docker/apps`,
      `DOCKER_NETWORK=aio`,
      `PUID=1000`,
      `PGID=1000`,
      `DOMAIN=${config.domain}`,
      `LETSENCRYPT_EMAIL=${config.email}`,
      `CF_API_EMAIL=${config.email}`,
      `CF_DNS_API_TOKEN=${config.cloudflare?.apiToken || ''}`,
      `CLOUDFLARE_API_TOKEN=${config.cloudflare?.apiToken || ''}`,
      `CF_ZONE_ID=${config.cloudflare?.zoneId || ''}`,
      `COMPOSE_PROFILES=${config.profiles.join(",")}`,
      `COMPOSE_PROJECT_NAME=aio`,
      `COMPOSE_FILE=compose.yaml`,
      `LE_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory`,
      `TRUSTED_IPS=0.0.0.0/0,::/0`,
      `DOCKER_NETWORK_EXTERNAL=false`,
      `AUTHELIA_SESSION_SECRET=${sessionSecret}`,
      `AUTHELIA_STORAGE_ENCRYPTION_KEY=${storageKey}`,
      `AUTHELIA_JWT_SECRET=${jwtSecret}`,
      `AUTHELIA_WEBAUTHN_DISPLAY_NAME=Authelia`,
      `AUTHELIA_HOSTNAME=auth.${config.domain}`,
      `BESZEL_HOSTNAME=beszel.${config.domain}`,
      `IMMICH_HOSTNAME=immich.${config.domain}`,
      `TRAEFIK_HOSTNAME=traefik.${config.domain}`,
      `VAULTWARDEN_HOSTNAME=vaultwarden.${config.domain}`,
      
    ].join("\n");

    // Write .env using base64 encoding to avoid shell escaping issues
    const envBase64 = Buffer.from(envLines).toString("base64");
    await execCommand(`echo "${envBase64}" | base64 -d > /opt/docker/.env`, "Create .env");

    // ── Step 3b: Prune the clone to the apps this dashboard deploys ────────
    // The clone is the whole upstream fleet; this leaves traefik, authelia,
    // vaultwarden, immich and beszel, and strips every reference to the rest.
    // It reads the .env above, so it must run after it is written.
    status("Pruning template to the deployed apps...");
    const pruneBase64 = Buffer.from(PRUNE_SCRIPT).toString("base64");
    const pruned = await execCommand(
      `echo "${pruneBase64}" | base64 -d > /tmp/prune_template.py && python3 /tmp/prune_template.py; rc=$?; rm -f /tmp/prune_template.py; exit $rc`,
      "Prune template"
    );
    if (!pruned) return;

  // ── Step 4: Pull & Start ───────────────────────────────────────────
  status("Deploying services...");
  await execCommand("cd /opt/docker && docker compose pull", "Docker Pull", false);
    
  const upSuccess = await execCommand("cd /opt/docker && docker compose up -d", "Docker Up");

  if (upSuccess) {
  status(`Success! Services accessible at https://${config.domain}`);
    } else {
      error("Deployment failed. Check docker logs.");
    }

  } catch (err: any) {
    error(`Fatal failure: ${err.message}`);
  }
}
