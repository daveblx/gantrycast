import { Activity, Globe, Network } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dot,
  EmptyState,
  KV,
  Meter,
  Modal,
  Segmented,
  Sparkline,
} from '../components/ui';
import { clamp, clockTime, percent, pluralize, severityTone } from '../lib/format';
import type { ClusterState } from '../types';

type Tab = 'topology' | 'logs' | 'metrics';

interface NodeSnapshot {
  id: string;
  pods: number;
  podUsage: number;
  cpu: number;
  mem: number;
}

interface FlowSnapshot {
  id: number;
  status: 'ok' | 'slow';
}

interface LogSnapshot {
  ts: number;
  level: 'info' | 'warn';
  text: string;
}

interface Snapshot {
  ingressLoad: number;
  requestRate: number;
  latencyP99: number;
  errorRate: number;
  requestSeries: number[];
  latencySeries: number[];
  errorSeries: number[];
  nodes: NodeSnapshot[];
  flows: FlowSnapshot[];
  logs: LogSnapshot[];
}

/* ── Deterministic pseudo-randomness ──────────────────────────
   The overlay must render the same numbers for the same cluster
   and tick. A seeded generator keyed on the cluster id gives
   stable values across re-renders while still moving over time.
   ──────────────────────────────────────────────────────────── */

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeRandom(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function logLine(random: () => number, node: string, index: number): string {
  const templates: Array<() => string> = [
    () => `scaled deployment api to ${2 + Math.floor(random() * 8)} replicas`,
    () => `ingress health check passed in ${8 + Math.floor(random() * 40)}ms`,
    () => `node ${node} reported ready`,
    () => `hpa target cpu ${Math.round(40 + random() * 45)}% — no scale event`,
    () =>
      `readiness probe ok for pod api-${Math.floor(random() * 0xffff)
        .toString(16)
        .padStart(4, '0')}`,
    () => `request burst ${300 + Math.floor(random() * 400)} req/s absorbed by ingress`,
    () => `node ${node} drained for simulated rollout`,
    () => 'configmap api-config reloaded',
  ];
  return templates[index % templates.length]();
}

function buildSnapshot(
  clusterId: string,
  serverIds: string[],
  tick: number,
  startedAt: number,
): Snapshot {
  const random = makeRandom(hashString(`${clusterId}:${tick}`));

  const requestSeries: number[] = [];
  let request = 380 + random() * 120;
  for (let index = 0; index < 24; index += 1) {
    request = clamp(request + (random() - 0.5) * 70, 240, 640);
    requestSeries.push(Math.round(request));
  }

  const latencySeries: number[] = [];
  let latency = 12 + random() * 4;
  for (let index = 0; index < 24; index += 1) {
    latency = clamp(latency + (random() - 0.5) * 3, 8, 32);
    latencySeries.push(Number(latency.toFixed(1)));
  }

  const errorSeries = Array.from({ length: 24 }, () =>
    random() > 0.94 ? Number((random() * 0.6).toFixed(2)) : 0,
  );

  const nodes: NodeSnapshot[] = serverIds.map((id) => {
    const nodeRandom = makeRandom(hashString(`${clusterId}:${id}:${tick}`));
    return {
      id,
      pods: 6 + Math.floor(nodeRandom() * 18),
      podUsage: Math.round(35 + nodeRandom() * 55),
      cpu: Number((18 + nodeRandom() * 55).toFixed(1)),
      mem: Number((30 + nodeRandom() * 50).toFixed(1)),
    };
  });

  const flows: FlowSnapshot[] = Array.from({ length: 5 }, () => ({
    id: 100 + Math.floor(random() * 900),
    status: random() > 0.85 ? 'slow' : 'ok',
  }));

  const logs: LogSnapshot[] = Array.from({ length: 18 }, (_, index) => {
    const node = serverIds.length ? serverIds[index % serverIds.length].slice(0, 8) : 'node';
    return {
      ts: startedAt + index * 1500,
      level: index % 7 === 3 ? 'warn' : 'info',
      text: logLine(random, node, index),
    };
  });

  return {
    ingressLoad: Math.round(25 + random() * 60),
    requestRate: requestSeries[requestSeries.length - 1],
    latencyP99: latencySeries[latencySeries.length - 1],
    errorRate: errorSeries[errorSeries.length - 1],
    requestSeries,
    latencySeries,
    errorSeries,
    nodes,
    flows,
    logs,
  };
}

/* ── Pieces ───────────────────────────────────────────────── */

function MetricPanel({
  label,
  value,
  unit,
  values,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  values: number[];
  color: string;
}) {
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{label}</span>
      </div>
      <div className="panel__body col" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 4, alignItems: 'baseline' }}>
          <span className="num" style={{ fontSize: 20, fontWeight: 500 }}>
            {value}
          </span>
          <span className="faint mono" style={{ fontSize: 10.5 }}>
            {unit}
          </span>
        </div>
        <Sparkline values={values} height={48} color={color} fill grid min={0} />
      </div>
    </div>
  );
}

function NodeCard({ node, index }: { node: NodeSnapshot; index: number }) {
  return (
    <div className="panel">
      <div className="panel__head">
        <Dot tone="ok" />
        <span className="panel__title">node {String(index + 1).padStart(2, '0')}</span>
        <span className="grow" />
        <span className="mono faint" style={{ fontSize: 10 }}>
          {node.id.slice(0, 8)}
        </span>
      </div>
      <div className="panel__body col" style={{ gap: 6 }}>
        <div className="row row--between">
          <span className="label">pod capacity</span>
          <span className="num" style={{ fontSize: 11.5 }}>
            {percent(node.podUsage)}
          </span>
        </div>
        <Meter value={node.podUsage} tone={severityTone(node.podUsage)} />
        <KV k="pods" v={node.pods} />
        <KV k="cpu" v={percent(node.cpu, 1)} />
        <KV k="memory" v={percent(node.mem, 1)} />
      </div>
    </div>
  );
}

/* ── Overlay ──────────────────────────────────────────────── */

export function ProdSimulationOverlay({
  cluster,
  onClose,
}: {
  cluster: ClusterState;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('topology');
  const [tick, setTick] = useState(0);
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setTick((current) => current + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);

  const snapshot = useMemo(
    () => buildSnapshot(cluster.id, cluster.serverIds, tick, startedAt),
    [cluster.id, cluster.serverIds, tick, startedAt],
  );

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          {cluster.name}
          <Badge tone="accent">simulated</Badge>
        </span>
      }
      subtitle={`${pluralize(cluster.serverIds.length, 'node')} · values refresh every 2s`}
      size="full"
      onClose={onClose}
      footer={
        <>
          <span className="label">tick {tick}</span>
          <span className="faint truncate" style={{ fontSize: 11, minWidth: 0 }}>
            Values are derived from the cluster id; no workload metrics are read from the hosts.
          </span>
          <span className="modal__foot-spacer" />
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="row row--between">
        <Segmented<Tab>
          options={[
            { value: 'topology', label: 'topology' },
            { value: 'logs', label: 'logs' },
            { value: 'metrics', label: 'metrics' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="mono faint" style={{ fontSize: 10.5 }}>
          cluster {cluster.id.slice(0, 8)}
        </span>
      </div>

      {tab === 'topology' &&
        (cluster.serverIds.length === 0 ? (
          <EmptyState
            icon={<Globe size={14} strokeWidth={1.75} />}
            title="No nodes"
            text="This cluster has no hosts attached. Add hosts to the cluster to see a topology."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="col" style={{ gap: 3 }}>
              <div className="panel">
                <div className="panel__head">
                  <Globe size={12} strokeWidth={1.75} />
                  <span className="panel__title">Ingress</span>
                  <span className="grow" />
                  <span className="num" style={{ fontSize: 11.5 }}>
                    {percent(snapshot.ingressLoad, 1)}
                  </span>
                </div>
                <div className="panel__body col" style={{ gap: 6 }}>
                  <Meter value={snapshot.ingressLoad} tone="accent" tall />
                  <KV k="request rate" v={`${snapshot.requestRate} req/s`} />
                  <KV k="latency p99" v={`${snapshot.latencyP99.toFixed(1)} ms`} />
                  <KV k="error rate" v={`${snapshot.errorRate.toFixed(2)} %`} />
                </div>
              </div>

              <div className="panel">
                <div className="panel__head">
                  <Network size={12} strokeWidth={1.75} />
                  <span className="panel__title">Traffic flow</span>
                </div>
                <div className="panel__body col" style={{ gap: 4 }}>
                  {snapshot.flows.map((flow, index) => (
                    <div className="row" key={`${flow.id}-${index}`} style={{ gap: 6 }}>
                      <Dot tone={flow.status === 'ok' ? 'ok' : 'warn'} />
                      <span className="mono" style={{ fontSize: 11 }}>
                        req_{flow.id}
                      </span>
                      <span className="grow" />
                      <span className="label">{flow.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              {snapshot.nodes.map((node, index) => (
                <NodeCard key={node.id} node={node} index={index} />
              ))}
            </div>
          </div>
        ))}

      {tab === 'logs' && (
        <div className="panel">
          <div className="panel__head">
            <Activity size={12} strokeWidth={1.75} />
            <span className="panel__title">Simulation log</span>
            <span className="grow" />
            <span className="label">{pluralize(snapshot.logs.length, 'line')}</span>
          </div>
          <div className="panel__body col" style={{ gap: 2 }}>
            {snapshot.logs.map((line) => (
              <div className="row" key={line.ts} style={{ gap: 8, alignItems: 'baseline' }}>
                <span className="mono faint" style={{ fontSize: 10.5, flex: '0 0 auto' }}>
                  {clockTime(line.ts)}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    flex: '0 0 34px',
                    color: line.level === 'warn' ? 'var(--warn)' : 'var(--fg-faint)',
                  }}
                >
                  {line.level}
                </span>
                <span className="mono grow" style={{ fontSize: 11.5 }}>
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'metrics' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <MetricPanel
              label="Request rate"
              value={String(snapshot.requestRate)}
              unit="req/s"
              values={snapshot.requestSeries}
              color="var(--fg-muted)"
            />
            <MetricPanel
              label="Latency p99"
              value={snapshot.latencyP99.toFixed(1)}
              unit="ms"
              values={snapshot.latencySeries}
              color="var(--fg-muted)"
            />
            <MetricPanel
              label="Error rate"
              value={snapshot.errorRate.toFixed(2)}
              unit="%"
              values={snapshot.errorSeries}
              color="var(--fg-faint)"
            />
          </div>

          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">Nodes</span>
              <span className="grow" />
              <span className="label">{pluralize(snapshot.nodes.length, 'node')}</span>
            </div>
            {snapshot.nodes.length === 0 ? (
              <div className="panel__body faint" style={{ fontSize: 11.5 }}>
                This cluster has no hosts attached.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th style={{ textAlign: 'right' }}>Pods</th>
                    <th style={{ textAlign: 'right' }}>Pod capacity</th>
                    <th style={{ textAlign: 'right' }}>CPU</th>
                    <th style={{ textAlign: 'right' }}>Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.nodes.map((node, index) => (
                    <tr key={node.id}>
                      <td>
                        <span className="mono" style={{ fontSize: 11.5 }}>
                          {String(index + 1).padStart(2, '0')} · {node.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="table__num">{node.pods}</td>
                      <td className="table__num">{percent(node.podUsage)}</td>
                      <td className="table__num">{percent(node.cpu, 1)}</td>
                      <td className="table__num">{percent(node.mem, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
