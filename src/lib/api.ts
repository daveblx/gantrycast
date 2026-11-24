import type { Cluster, Container, ExecResult, Server, Telemetry } from '../types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A hung request must not stall the poll loop that awaits it. */
const DEFAULT_TIMEOUT_MS = 20_000;

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        if (body?.error) detail = body.error;
      } catch {
        /* body was not JSON */
      }
      throw new ApiError(detail, res.status);
    }
    // 204 and empty bodies are valid for DELETE; res.json() would throw on them.
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof ApiError)) {
      throw new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 0);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  // ── Servers ────────────────────────────────────────────────
  listServers: () => request<Server[]>('/api/servers'),

  addServer: (data: Partial<Server>) => request<Server>('/api/servers', json(data)),

  updateServer: (id: string, data: Partial<Server>) =>
    request<Server>(`/api/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteServer: (id: string) =>
    request<{ success?: boolean }>(`/api/servers/${id}`, { method: 'DELETE' }),

  destroyServer: (id: string) =>
    request<{ success: boolean; error?: string }>(`/api/servers/${id}/destroy`, { method: 'POST' }),

  telemetry: (id: string) => request<Telemetry>(`/api/servers/${id}/telemetry`),

  exec: (id: string, command: string) =>
    request<ExecResult>(`/api/servers/${id}/exec`, json({ command })),

  containers: (id: string) => request<Container[]>(`/api/servers/${id}/containers`),

  deleteContainer: (id: string, name: string) =>
    request<{ success?: boolean }>(`/api/servers/${id}/containers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  stopContainer: (id: string, containerName: string) =>
    request<ExecResult>(`/api/servers/${id}/stop-container`, json({ containerName })),

  deployDockerfile: (
    id: string,
    payload: { dockerfile: string; containerName: string; portMapping: string },
  ) => request<ExecResult>(`/api/servers/${id}/deploy-dockerfile`, json(payload)),

  // ── Clusters ───────────────────────────────────────────────
  listClusters: () => request<Cluster[]>('/api/clusters'),

  addCluster: (data: Partial<Cluster>) => request<Cluster>('/api/clusters', json(data)),

  deleteCluster: (id: string) =>
    request<{ success?: boolean }>(`/api/clusters/${id}`, { method: 'DELETE' }),

  deploySample: (id: string) =>
    request<{ results: Array<{ serverId: string; code?: number; output?: string; error?: string }> }>(
      `/api/clusters/${id}/deploy-sample`,
      { method: 'POST' },
    ),

  simulateLoad: (id: string) =>
    request<{ results: Array<{ serverId: string; code?: number; output?: string; error?: string }> }>(
      `/api/clusters/${id}/simulate-load`,
      { method: 'POST' },
    ),

  // ── Templates ──────────────────────────────────────────────
  templateDefaults: () => request<Record<string, unknown>>('/api/template/config/defaults'),
};

/** WebSocket URL for the SSH bridge, matching the page's protocol. */
export function sshSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/ssh`;
}
