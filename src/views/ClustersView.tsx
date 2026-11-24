import { Activity, AlertTriangle, Globe, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { TrafficModal } from '../components/modals/TrafficModal';
import { Badge, Banner, Button, EmptyState, IconButton, Section } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { api } from '../lib/api';
import { pluralize } from '../lib/format';
import { appendSample, lastSample, toSample } from '../lib/telemetry';
import type { ClusterState, Sample, Server, Telemetry } from '../types';

interface DeployRow {
  serverId: string;
  code?: number;
  output?: string;
  error?: string;
}

interface ActionResult {
  clusterId: string;
  clusterName: string;
  action: 'deploy' | 'simulate';
  results: DeployRow[];
}

interface BusyState {
  id: string;
  action: 'deploy' | 'simulate';
}

export function ClustersView({
  clusters,
  servers,
  onCreateCluster,
  onDeleteCluster,
  onOpenSimulation,
}: {
  clusters: ClusterState[];
  servers: Server[];
  onCreateCluster: () => void;
  onDeleteCluster: (id: string) => void;
  onOpenSimulation: (cluster: ClusterState) => void;
}) {
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ── Telemetry for the hosts that belong to a cluster ─────── */

  const clusterServerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const cluster of clusters) {
      for (const id of cluster.serverIds) ids.add(id);
    }
    return Array.from(ids);
  }, [clusters]);

  const idsRef = useRef(clusterServerIds);
  idsRef.current = clusterServerIds;

  const [history, setHistory] = useState<Record<string, Sample[]>>({});

  const poll = useCallback(async () => {
    const ids = idsRef.current;
    if (!ids.length) return;

    const settled = await Promise.allSettled(ids.map((id) => api.telemetry(id)));
    const now = Date.now();
    const fresh: Array<[string, Telemetry]> = [];

    settled.forEach((outcome, index) => {
      if (outcome.status !== 'fulfilled') return;
      const payload = outcome.value;
      if (!payload || payload.error) return;
      fresh.push([ids[index], payload]);
    });

    if (!fresh.length) return;

    setHistory((prev) => {
      // Drop hosts that no longer belong to a cluster so the fleet chart
      // never counts a host twice or keeps a removed one alive.
      const next: Record<string, Sample[]> = {};
      for (const id of ids) {
        if (prev[id]) next[id] = prev[id];
      }
      for (const [id, payload] of fresh) {
        next[id] = appendSample(prev[id], toSample(payload, now, lastSample(prev[id])));
      }
      return next;
    });
  }, []);

  usePolling(poll, 30_000, { enabled: clusterServerIds.length > 0 });

  /* ── Cluster actions ─────────────────────────────────────── */

  const runAction = useCallback(
    async (cluster: ClusterState, action: 'deploy' | 'simulate') => {
      setBusy({ id: cluster.id, action });
      setResult(null);
      setError(null);
      try {
        const data =
          action === 'deploy'
            ? await api.deploySample(cluster.id)
            : await api.simulateLoad(cluster.id);
        setResult({
          clusterId: cluster.id,
          clusterName: cluster.name,
          action,
          results: data.results ?? [],
        });
        if (action === 'simulate') onOpenSimulation(cluster);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? `${action === 'deploy' ? 'Deploy' : 'Simulation'} failed: ${cause.message}`
            : `${action === 'deploy' ? 'Deploy' : 'Simulation'} failed.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [onOpenSimulation],
  );

  const serverById = useMemo(() => {
    const map = new Map<string, Server>();
    for (const server of servers) map.set(server.id, server);
    return map;
  }, [servers]);

  const hostLabel = useCallback(
    (id: string) => serverById.get(id)?.name ?? id.slice(0, 8),
    [serverById],
  );

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <p className="view__sub">
            Group hosts, deploy the sample workload and simulate load.
          </p>
        </div>
        <div className="view__actions">
          <Button onClick={() => setTrafficOpen(true)}>
            <Activity size={13} strokeWidth={1.75} />
            Traffic
          </Button>
          <Button variant="primary" onClick={onCreateCluster}>
            <Plus size={13} strokeWidth={1.75} />
            Create cluster
          </Button>
        </div>
      </div>

      {error && (
        <Banner tone="err" icon={<AlertTriangle size={13} strokeWidth={1.75} />}>
          {error}
        </Banner>
      )}

      <Section
        title="Configured clusters"
        actions={<span className="label">{pluralize(clusters.length, 'cluster')}</span>}
      >
        {clusters.length === 0 ? (
          <EmptyState
            icon={<Globe size={14} strokeWidth={1.75} />}
            title="No clusters"
            text="Create a cluster to group hosts, then deploy the sample workload or simulate load against it."
            action={
              <Button variant="primary" onClick={onCreateCluster}>
                <Plus size={13} strokeWidth={1.75} />
                Create cluster
              </Button>
            }
          />
        ) : (
          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th style={{ textAlign: 'right' }}>Nodes</th>
                  <th>Hosts</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((cluster) => {
                  const names = cluster.serverIds.map(hostLabel);
                  const deploying = busy?.id === cluster.id && busy.action === 'deploy';
                  const simulating = busy?.id === cluster.id && busy.action === 'simulate';
                  return (
                    <tr key={cluster.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{cluster.name}</div>
                        <div className="mono faint" style={{ fontSize: 10 }}>
                          {cluster.id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="table__num">{cluster.serverIds.length}</td>
                      <td>
                        <span
                          className="mono truncate"
                          style={{ fontSize: 11, display: 'block', maxWidth: 320 }}
                          title={names.join(', ') || undefined}
                        >
                          {names.length ? names.join(', ') : '—'}
                        </span>
                      </td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <Button
                            size="sm"
                            onClick={() => void runAction(cluster, 'deploy')}
                            disabled={!!busy}
                          >
                            {deploying ? 'Deploying' : 'Deploy sample'}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void runAction(cluster, 'simulate')}
                            disabled={!!busy}
                          >
                            {simulating ? 'Simulating' : 'Simulate load'}
                          </Button>
                          <IconButton
                            label={`Delete ${cluster.name}`}
                            danger
                            disabled={!!busy}
                            onClick={() => onDeleteCluster(cluster.id)}
                          >
                            <Trash2 size={13} strokeWidth={1.75} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {result && (
        <Section
          title="Last result"
          actions={
            <IconButton label="Dismiss result" onClick={() => setResult(null)}>
              <X size={13} strokeWidth={1.75} />
            </IconButton>
          }
        >
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">
                {result.action === 'deploy' ? 'Deploy sample' : 'Simulate load'}
              </span>
              <Badge tone="muted">{result.clusterName}</Badge>
              <span className="grow" />
              <span className="label">{pluralize(result.results.length, 'host')}</span>
            </div>
            {result.results.length === 0 ? (
              <div className="panel__body faint" style={{ fontSize: 11.5 }}>
                The cluster returned no host output.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Exit</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((row, index) => (
                    <tr key={`${row.serverId}-${index}`}>
                      <td>
                        <span className="mono" style={{ fontSize: 11.5 }}>
                          {hostLabel(row.serverId)}
                        </span>
                      </td>
                      <td>
                        <Badge
                          tone={row.code === undefined ? 'muted' : row.code === 0 ? 'ok' : 'err'}
                        >
                          {row.code ?? '—'}
                        </Badge>
                      </td>
                      <td>
                        <span
                          className="mono truncate"
                          style={{ fontSize: 11, display: 'block', maxWidth: 560 }}
                          title={row.output || undefined}
                        >
                          {row.output?.trim() || '—'}
                        </span>
                        {row.error && (
                          <span
                            className="mono"
                            style={{ fontSize: 11, color: 'var(--err)', display: 'block' }}
                          >
                            {row.error}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Section>
      )}

      {trafficOpen && (
        <TrafficModal history={history} onClose={() => setTrafficOpen(false)} />
      )}
    </div>
  );
}
