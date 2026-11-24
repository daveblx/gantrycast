import clsx from 'clsx';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Settings,
  Shield,
  SlidersHorizontal,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_THRESHOLDS, alertLabel, alertTone, evaluateHost } from '../lib/alerts';
import type { Thresholds } from '../lib/alerts';
import { api } from '../lib/api';
import {
  bytes,
  clamp,
  fixed,
  num,
  pct,
  percent,
  rate,
  severity,
  severityClass,
  uptime,
} from '../lib/format';
import { lastSample, series } from '../lib/telemetry';
import { PROD_TEST_COMMAND } from '../shared/probes';
import type { ExecResult, Sample, Server, Telemetry } from '../types';
import { Badge, Button, Dot, IconButton, KV, Sparkline } from './ui';

interface ProdCheck {
  label: string;
  key: string;
  match: RegExp;
}

const PROD_CHECKS: ProdCheck[] = [
  { label: 'Kernel', key: 'uname', match: /^Linux|^Darwin/ },
  { label: 'Node.js', key: 'Node.js', match: /^Node\.js:/ },
  { label: 'Docker', key: 'Docker', match: /^Docker:/ },
  { label: 'Disk usage', key: 'Disk usage', match: /^Disk usage:/ },
  { label: 'CPU info', key: 'CPU info', match: /^CPU info:/ },
  { label: 'Memory', key: 'Memory', match: /^Memory:/ },
];

/** Values the probe emits when a tool is absent rather than broken. */
const MISSING = /^(not installed|not detected|none|n\/a|command not found)$/i;

/**
 * Split the probe output into one value per check. A line that matches a check
 * header starts a new value; every following line that matches nothing is a
 * continuation of the previous value (e.g. the two rows of `free -h`).
 */
function parseProdOutput(output: string): Record<string, string> {
  const results: Record<string, string> = {};
  let lastKey = '';

  for (const line of output.split(/\r?\n/)) {
    const hit = PROD_CHECKS.find((check) => check.match.test(line));
    if (hit) {
      lastKey = hit.key;
      results[hit.key] = line.replace(hit.match, '').trim();
      continue;
    }
    if (lastKey) {
      const previous = results[lastKey];
      results[lastKey] = previous ? `${previous}\n${line}` : line;
    }
  }

  return results;
}

function checkPassed(value: string | undefined): boolean {
  if (!value) return false;
  return !MISSING.test(value.trim());
}

/* ── Local helpers ────────────────────────────────────────── */

function sparkColor(value: number | undefined): string {
  const level = severity(value);
  if (level === 'err') return 'var(--err)';
  if (level === 'warn') return 'var(--warn)';
  return 'var(--fg-muted)';
}

/** Utilisation bar coloured by severity, matching the .meter markup. */
function UsageBar({ value }: { value: number | undefined }) {
  return (
    <div className="meter">
      <div
        className={clsx('meter__fill', severityClass(value))}
        style={{ width: `${clamp(value ?? 0)}%` }}
      />
    </div>
  );
}

function statusTone(status: Server['status']): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'online') return 'ok';
  if (status === 'error') return 'err';
  return 'idle';
}

/* ── Card ─────────────────────────────────────────────────── */

export function ServerCard({
  server,
  telemetry,
  history,
  thresholds,
  onEditThresholds,
  onOpenTerminal,
  onOpenSettings,
  onDelete,
  onNuke,
  onRefresh,
}: {
  server: Server;
  telemetry?: Telemetry;
  history: Sample[];
  /** Per-host alert thresholds; the defaults apply when omitted. */
  thresholds?: Thresholds;
  onEditThresholds?: () => void;
  onOpenTerminal: () => void;
  onOpenSettings: () => void;
  onDelete: () => void;
  onNuke: () => void;
  onRefresh: () => void;
}) {
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  const [prodTest, setProdTest] = useState<{ running: boolean; result?: ExecResult } | null>(null);

  const cpu = num(telemetry?.cpu);
  const ram = num(telemetry?.ram);
  const load1 = num(telemetry?.load1);
  const latest = lastSample(history);

  // The alert badge reads the freshest numbers available: the live telemetry
  // payload first, then the last recorded sample.
  const alert = evaluateHost(
    {
      cpu: pct(telemetry?.cpu) ?? latest?.cpu,
      ram: pct(telemetry?.ram) ?? latest?.ram,
      disk: pct(telemetry?.disk),
    },
    thresholds ?? DEFAULT_THRESHOLDS,
  );

  // Telemetry is authoritative when present; fall back to what the server
  // record already knows so the card is never blank before the first poll.
  // A telemetry payload that omits the field must not read as "Absent".
  const dockerInstalled =
    telemetry?.docker !== undefined ? telemetry.docker !== 'none' : !!server.installed?.docker;

  const netSeries = history.some((sample) => typeof sample.txRate === 'number')
    ? series(history, 'txRate')
    : series(history, 'txMb');

  const netLabel =
    latest?.rxRate !== undefined || latest?.txRate !== undefined
      ? `RX ${rate(latest?.rxRate)} / TX ${rate(latest?.txRate)}`
      : latest?.rxMb !== undefined || latest?.txMb !== undefined
        ? `RX ${bytes(latest?.rxMb)} / TX ${bytes(latest?.txMb)}`
        : '—';

  const runProdTest = async () => {
    setProdTest({ running: true });
    try {
      const result = await api.exec(server.id, PROD_TEST_COMMAND);
      setProdTest({ running: false, result });
    } catch (error) {
      setProdTest({
        running: false,
        result: {
          code: -1,
          output: '',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const results = prodTest?.result ? parseProdOutput(prodTest.result.output) : {};

  return (
    <article className="card">
      <div className="card__head">
        <span style={{ marginTop: 5 }}>
          <Dot tone={statusTone(server.status)} />
          <span className="sr-only">{server.status}</span>
        </span>
        <div className="grow min-w-0">
          <div className="card__title truncate">{server.name}</div>
          <div className="card__meta truncate">
            {server.username}@{server.host}:{server.port}
          </div>
        </div>
        <div className="card__actions">
          <IconButton label="Refresh heartbeat" onClick={onRefresh}>
            <RefreshCw size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Open terminal" onClick={onOpenTerminal}>
            <Terminal size={13} strokeWidth={1.75} />
          </IconButton>
          {onEditThresholds && (
            <IconButton label="Alert thresholds" onClick={onEditThresholds}>
              <SlidersHorizontal size={13} strokeWidth={1.75} />
            </IconButton>
          )}
          <IconButton label="Remove host" danger onClick={onDelete}>
            <Trash2 size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>

      <div className="card__body">
        <div className="col gap-1">
          <KV k="CPU" v={percent(cpu, 1)} />
          <UsageBar value={cpu} />
        </div>

        <div className="col gap-1">
          <KV k="RAM" v={percent(ram, 1)} />
          <UsageBar value={ram} />
        </div>

        <div className="col gap-1">
          <KV
            k="Docker"
            v={
              <Badge tone={dockerInstalled ? 'ok' : 'muted'}>
                {dockerInstalled ? 'Installed' : 'Absent'}
              </Badge>
            }
          />
          {alert.hasData && (
            <KV
              k="Alerts"
              title={alert.summary}
              v={<Badge tone={alertTone(alert.level)}>{alertLabel(alert.level)}</Badge>}
            />
          )}
          <KV k="Uptime" v={uptime(num(telemetry?.uptime_s))} />
          <KV k="Load 1m" v={fixed(load1, 2)} />
        </div>

        <div className="col gap-1">
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--block"
            aria-expanded={monitoringOpen}
            onClick={() => setMonitoringOpen((open) => !open)}
          >
            {monitoringOpen ? (
              <ChevronDown size={12} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={12} strokeWidth={1.75} />
            )}
            Monitoring
          </button>

          {monitoringOpen && (
            <div className="grid grid-cols-2 gap-2">
              <div className="col gap-1">
                <div className="row row--between">
                  <span className="label">CPU</span>
                  <span className="num">{percent(cpu, 1)}</span>
                </div>
                <Sparkline values={series(history, 'cpu')} height={32} color={sparkColor(cpu)} grid />
              </div>

              <div className="col gap-1">
                <div className="row row--between">
                  <span className="label">RAM</span>
                  <span className="num">{percent(ram, 1)}</span>
                </div>
                <Sparkline values={series(history, 'ram')} height={32} color={sparkColor(ram)} grid />
              </div>

              <div className="col gap-1">
                <div className="row row--between">
                  <span className="label">Load 1m</span>
                  <span className="num">{fixed(load1, 2)}</span>
                </div>
                <Sparkline
                  values={series(history, 'load1')}
                  height={32}
                  color="var(--fg-muted)"
                  grid
                />
              </div>

              <div className="col gap-1">
                <div className="row row--between">
                  <span className="label">Network</span>
                  <span className="num truncate" title={netLabel}>
                    {netLabel}
                  </span>
                </div>
                <Sparkline values={netSeries} height={32} color="var(--fg-muted)" grid />
              </div>
            </div>
          )}
        </div>

        {prodTest?.result && (
          <div className="panel">
            <div className="panel__head">
              <Activity size={12} strokeWidth={1.75} />
              <span className="panel__title">Prod test</span>
              <Badge tone={prodTest.result.code === 0 ? 'ok' : 'err'}>
                {prodTest.result.code === 0 ? 'Pass' : 'Fail'} · code {prodTest.result.code}
              </Badge>
              <div className="grow" />
              <Button size="sm" variant="ghost" onClick={() => setProdTest(null)}>
                Hide
              </Button>
            </div>
            <div className="panel__body col gap-1">
              {PROD_CHECKS.map((check) => {
                const value = results[check.key];
                const passed = checkPassed(value);
                return (
                  <div className="row gap-2" key={check.key}>
                    {passed ? (
                      <CheckCircle2 size={12} strokeWidth={1.75} color="var(--ok)" />
                    ) : (
                      <AlertCircle size={12} strokeWidth={1.75} color="var(--warn)" />
                    )}
                    <span className="label w-20">{check.label}</span>
                    <span className="mono truncate grow" title={value ?? 'Not detected'}>
                      {value || 'Not detected'}
                    </span>
                  </div>
                );
              })}

              {prodTest.result.error && (
                <div className="banner banner--err" style={{ marginTop: 4 }}>
                  <span className="banner__icon">
                    <AlertCircle size={12} strokeWidth={1.75} />
                  </span>
                  <span className="mono">{prodTest.result.error}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card__foot">
        <Button size="sm" onClick={onOpenTerminal}>
          <Terminal size={12} strokeWidth={1.75} />
          Shell
        </Button>
        <Button size="sm" onClick={runProdTest} disabled={prodTest?.running}>
          <Activity size={12} strokeWidth={1.75} />
          {prodTest?.running ? 'Testing…' : 'Prod test'}
        </Button>
        <div className="grow" />
        <IconButton label="Server settings" onClick={onOpenSettings}>
          <Settings size={13} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Nuke server" danger onClick={onNuke}>
          <Shield size={13} strokeWidth={1.75} />
        </IconButton>
      </div>
    </article>
  );
}
