import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";

/**
 * A small per-host SSH connection pool.
 *
 * The dashboard polls every host on a timer, and a fresh handshake per poll
 * costs more than the command itself (key exchange + auth round trips). This
 * module keeps one authenticated `ssh2` Client per host alive, multiplexes
 * execs over it, and drops it when it goes idle or dies.
 *
 * Design notes:
 *  - One connection per host, keyed by server id. The connection parameters are
 *    compared verbatim, so editing a host's password/key/host/port transparently
 *    replaces the cached connection instead of reusing stale credentials.
 *  - Concurrent execs per connection are capped (SSH channels are cheap but not
 *    free, and a burst of polls must not starve the host's sshd).
 *  - Idle connections are closed after `idleTimeoutMs` (60s by default).
 *  - Any transport error evicts the connection immediately, so the next caller
 *    starts from a fresh handshake rather than reusing a half-dead socket.
 *  - A connection that dies mid-use is retried once on a fresh connection.
 */

/** The subset of a stored server record the pool needs. */
export interface PoolServer {
  id?: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export type SshPoolErrorCode =
  | "connect_failed"
  | "timeout"
  | "aborted"
  | "closed"
  | "queue_timeout"
  | "exec_failed";

/**
 * Every failure the pool raises is one of these, so callers can branch on
 * `code` instead of matching error strings. `retryable` marks transport-level
 * failures: the connection is suspect and a fresh one may well succeed.
 */
export class SshPoolError extends Error {
  readonly code: SshPoolErrorCode;
  readonly retryable: boolean;

  constructor(code: SshPoolErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "SshPoolError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SshPoolOptions {
  /** Close a connection that has been unused for this long. */
  idleTimeoutMs?: number;
  /** Maximum execs in flight on a single connection. */
  maxConcurrentExecs?: number;
  /** Budget for TCP connect + key exchange + auth. */
  connectTimeoutMs?: number;
  /** How long an exec may wait for a free channel before giving up. */
  maxQueueWaitMs?: number;
}

const DEFAULT_OPTIONS: Required<SshPoolOptions> = {
  idleTimeoutMs: 60_000,
  maxConcurrentExecs: 4,
  connectTimeoutMs: 10_000,
  maxQueueWaitMs: 10_000,
};

let options: Required<SshPoolOptions> = { ...DEFAULT_OPTIONS };

/** Override pool defaults. Intended for tests and for tuning at startup. */
export function configurePool(overrides: SshPoolOptions): void {
  options = { ...options, ...overrides };
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  key: string;
  /** The exact connection parameters this connection was opened with. */
  credentials: string;
  client: Client;
  /** Resolves once the handshake and auth have completed. */
  ready: Promise<Client>;
  /** Execs currently holding a channel slot. */
  active: number;
  /** Execs waiting for a slot. */
  queue: Waiter[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

const entries = new Map<string, PoolEntry>();

/** Timers must not keep the process alive on their own. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}

function keyFor(server: PoolServer): string {
  if (server.id) return server.id;
  return `${server.host}:${server.port ?? 22}:${server.username}`;
}

/**
 * The credentials and endpoint a connection was opened with, as one comparable
 * string.
 *
 * This is a change-detection key, not a password hash: it is never persisted,
 * never transmitted, and never compared against a stored credential. Hashing it
 * would only invite the reading that it protects the secret, so the material is
 * kept as-is and compared verbatim. The password is already held in plaintext
 * by the caller's config and by `ssh2` itself, so this adds no new exposure.
 */
function credentialMaterialFor(server: PoolServer): string {
  return [
    server.host,
    String(server.port ?? 22),
    server.username,
    server.password ?? "",
    server.privateKey ?? "",
  ].join("\u0000");
}

function connectConfig(server: PoolServer): ConnectConfig {
  const config: ConnectConfig = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    // A dead peer must be noticed without waiting for the OS TCP timeout.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };
  if (server.privateKey) {
    config.privateKey = server.privateKey;
  } else {
    config.password = server.password;
  }
  return config;
}

function evict(entry: PoolEntry, reason: Error): void {
  entry.dead = true;
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  // Waiters are rejected rather than left hanging: the caller's retry will open
  // a fresh connection, which is exactly what a dead entry needs.
  const queued = entry.queue.splice(0);
  for (const waiter of queued) {
    clearTimeout(waiter.timer);
    waiter.reject(reason);
  }
  try {
    entry.client.end();
  } catch {
    /* socket already gone */
  }
  // `end()` is graceful; a wedged socket still needs to be torn down.
  const force = setTimeout(() => {
    try {
      entry.client.destroy();
    } catch {
      /* already destroyed */
    }
  }, 1_000);
  unref(force);
}

function scheduleIdleClose(entry: PoolEntry): void {
  if (entry.idleTimer || entry.dead) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.active === 0 && entry.queue.length === 0) {
      evict(entry, new SshPoolError("closed", "SSH connection closed after idle timeout"));
    }
  }, options.idleTimeoutMs);
  unref(entry.idleTimer);
}

function createEntry(key: string, credentials: string, server: PoolServer): PoolEntry {
  const client = new Client();
  const entry: PoolEntry = {
    key,
    credentials,
    client,
    ready: Promise.resolve(client),
    active: 0,
    queue: [],
    idleTimer: null,
    dead: false,
  };

  const endpoint = `${server.host}:${server.port || 22}`;

  entry.ready = new Promise<Client>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      entry.dead = true;
      try {
        client.destroy();
      } catch {
        /* already gone */
      }
      reject(
        new SshPoolError(
          "timeout",
          `SSH connection to ${endpoint} timed out after ${options.connectTimeoutMs}ms`,
          true,
        ),
      );
    }, options.connectTimeoutMs);
    unref(timer);

    client.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.dead = true;
      reject(new SshPoolError("connect_failed", `SSH connection to ${endpoint} failed: ${err.message}`, true));
    });
    client.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.dead = true;
      reject(new SshPoolError("connect_failed", `SSH connection to ${endpoint} closed before it was ready`, true));
    });

    // Persistent handlers: an EventEmitter 'error' with no listener would take
    // the whole process down, and a late close must still evict the entry.
    client.on("error", (err: Error) => {
      evict(entry, new SshPoolError("closed", `SSH connection to ${endpoint} failed: ${err.message}`, true));
    });
    client.on("close", () => {
      evict(entry, new SshPoolError("closed", `SSH connection to ${endpoint} closed`, true));
    });

    client.connect({ ...connectConfig(server), readyTimeout: options.connectTimeoutMs });
  });

  // The entry may be evicted before anyone awaits `ready`; without this the
  // rejection would surface as an unhandled promise rejection.
  entry.ready.catch(() => {});

  return entry;
}

function getEntry(server: PoolServer): PoolEntry {
  const key = keyFor(server);
  const credentials = credentialMaterialFor(server);
  const existing = entries.get(key);

  if (existing) {
    if (!existing.dead && existing.credentials === credentials) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      return existing;
    }
    // Credentials or endpoint changed, or the connection is already dead.
    evict(existing, new SshPoolError("closed", "SSH connection replaced"));
  }

  const entry = createEntry(key, credentials, server);
  entries.set(key, entry);
  return entry;
}

/**
 * Reject as soon as `signal` aborts, whatever the wrapped promise is doing.
 *
 * Without this a caller's deadline only covers the command itself: a host that
 * blackholes TCP would still hold the request for the full connect timeout, and
 * a retry would double it.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new SshPoolError("aborted", `SSH command aborted ${what}`));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new SshPoolError("aborted", `SSH command aborted ${what}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function acquireSlot(entry: PoolEntry, signal?: AbortSignal): Promise<void> {
  if (entry.dead) {
    return Promise.reject(new SshPoolError("closed", "SSH connection is closed", true));
  }
  if (entry.active < options.maxConcurrentExecs) {
    entry.active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const drop = () => {
      const idx = entry.queue.indexOf(waiter);
      if (idx !== -1) entry.queue.splice(idx, 1);
    };
    const onAbort = () => {
      drop();
      reject(new SshPoolError("aborted", "SSH command aborted while waiting for a free channel"));
    };
    const waiter: Waiter = {
      resolve: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      reject: (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
      timer: setTimeout(() => {
        drop();
        reject(new SshPoolError("queue_timeout", "Timed out waiting for a free SSH channel", true));
      }, options.maxQueueWaitMs),
    };
    unref(waiter.timer);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(waiter.timer);
        reject(new SshPoolError("aborted", "SSH command aborted before it started"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.queue.push(waiter);
  });
}

function releaseSlot(entry: PoolEntry): void {
  const next = entry.queue.shift();
  if (next) {
    // Hand the slot straight over; `active` is unchanged.
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  entry.active = Math.max(0, entry.active - 1);
  if (entry.active === 0) scheduleIdleClose(entry);
}

function toPoolError(err: unknown, entry: PoolEntry): SshPoolError {
  if (err instanceof SshPoolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // A plain error from the caller's callback is only worth retrying when the
  // connection underneath it is gone.
  return new SshPoolError("exec_failed", message, entry.dead);
}

export interface WithConnectionOptions {
  /** Extra attempts on a fresh connection after a transport failure. */
  retries?: number;
  /** Abort before the callback runs. */
  signal?: AbortSignal;
}

/**
 * Run `fn` against a pooled connection for `server`.
 *
 * The callback receives a live `ssh2` Client. Transport failures evict the
 * connection and are retried once on a fresh one; errors thrown by `fn` itself
 * are passed through untouched (unless the connection died underneath them).
 * Pass `retries: 0` for work that must not run twice.
 */
export async function withConnection<T>(
  server: PoolServer,
  fn: (client: Client) => Promise<T>,
  opts: WithConnectionOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  let attempt = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new SshPoolError("aborted", "SSH command aborted before it started");
    }
    const entry = getEntry(server);
    let slotHeld = false;
    try {
      await acquireSlot(entry, opts.signal);
      slotHeld = true;
      const client = await untilAborted(entry.ready, opts.signal, "while connecting");
      if (opts.signal?.aborted) {
        throw new SshPoolError("aborted", "SSH command aborted before it started");
      }
      return await fn(client);
    } catch (err) {
      const poolErr = toPoolError(err, entry);
      if (poolErr.retryable || entry.dead) evict(entry, poolErr);
      if (attempt >= retries || !poolErr.retryable) throw poolErr;
      attempt += 1;
    } finally {
      if (slotHeld) releaseSlot(entry);
    }
  }
}

export interface ExecResult {
  /** Remote exit status, or null when the channel closed without one. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Hard budget for the command; the channel is killed when it expires. */
  timeoutMs?: number;
  /** Abort the command from the outside (e.g. a request-level deadline). */
  signal?: AbortSignal;
  /** Extra attempts on a fresh connection after a transport failure. */
  retries?: number;
}

function execOnce(
  client: Client,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let channel: ClientChannel | null = null;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      client.removeListener("close", onClientGone);
      client.removeListener("error", onClientGone);
    };

    const finish = (err: Error | null, result?: ExecResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(result as ExecResult);
    };

    const abort = (err: SshPoolError) => {
      if (settled) return;
      // Kill the remote process before dropping the channel, otherwise the host
      // keeps running the script long after we stopped caring about it.
      try {
        channel?.signal("KILL");
      } catch {
        /* channel already gone */
      }
      try {
        channel?.close();
      } catch {
        /* channel already gone */
      }
      finish(err);
    };

    const onAbort = () => abort(new SshPoolError("aborted", "SSH command aborted"));
    const onClientGone = (err?: Error) =>
      abort(new SshPoolError("closed", err?.message ?? "SSH connection closed mid-command", true));

    const timer =
      timeoutMs > 0
        ? setTimeout(
            () => abort(new SshPoolError("timeout", `SSH command timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        : null;
    if (timer) unref(timer);

    if (signal) {
      if (signal.aborted) {
        abort(new SshPoolError("aborted", "SSH command aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    client.once("close", onClientGone);
    client.once("error", onClientGone);

    client.exec(command, (err, stream) => {
      if (settled) {
        try {
          stream?.close();
        } catch {
          /* already closed */
        }
        return;
      }
      if (err) {
        finish(new SshPoolError("exec_failed", err.message, true));
        return;
      }
      channel = stream;
      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("exit", (code: number | null) => {
        exitCode = code;
      });
      stream.on("close", () => {
        if (exitCode === null && stdout.length === 0 && stderr.length === 0) {
          // No exit status and no output: the connection died underneath the
          // command rather than the command finishing. Reporting this as an
          // empty success would hand the caller a silently blank result.
          finish(
            new SshPoolError("closed", "SSH channel closed before the command produced a result", true),
          );
          return;
        }
        finish(null, { code: exitCode, stdout, stderr });
      });
      stream.on("error", (streamErr: Error) =>
        finish(new SshPoolError("exec_failed", streamErr.message, true)),
      );
    });
  });
}

/**
 * Run one command on `server` over a pooled connection and collect its output.
 *
 * A non-zero exit status is returned, not thrown: only transport failures and
 * timeouts reject.
 */
export async function execOnServer(
  server: PoolServer,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return withConnection(server, (client) => execOnce(client, command, timeoutMs, opts.signal), {
    retries: opts.retries ?? 1,
    signal: opts.signal,
  });
}

/** Drop the pooled connection for one host (e.g. after it was deleted). */
export function closeHost(serverId: string): void {
  const entry = entries.get(serverId);
  if (entry) evict(entry, new SshPoolError("closed", "SSH connection closed by request"));
}

/** Close every pooled connection. Call on shutdown. */
export function closeAll(): void {
  for (const entry of [...entries.values()]) {
    evict(entry, new SshPoolError("closed", "SSH pool shutting down"));
  }
  entries.clear();
}

/** Snapshot of pool state, for diagnostics and tests. */
export function poolStats(): { hosts: number; active: number; queued: number } {
  let active = 0;
  let queued = 0;
  for (const entry of entries.values()) {
    active += entry.active;
    queued += entry.queue.length;
  }
  return { hosts: entries.size, active, queued };
}
