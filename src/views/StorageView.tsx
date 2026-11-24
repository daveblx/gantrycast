import { ArrowRight, HardDrive } from 'lucide-react';
import { useMemo } from 'react';
import { pct, percent, severity, severityTone } from '../lib/format';
import type { Server, Telemetry } from '../types';
import { Badge, Button, Dot, EmptyState, KV, Meter } from '../components/ui';

interface Mount {
  source: string;
  size: string;
  used: string;
  avail: string;
  percent: number | undefined;
  target: string;
}

/** `df` prints a percentage column; anything else is a header or junk. */
const PERCENT_FIELD = /^\d+(?:\.\d+)?%$/;

/**
 * Split one record into its six fields. `df` separates columns with runs of
 * whitespace, so try that first and only fall back to commas — a mount target
 * is allowed to contain a comma, but never a space.
 */
function splitRecord(record: string): string[] | undefined {
  const bySpace = record.split(/\s+/).map((field) => field.trim());
  if (bySpace.length >= 6 && PERCENT_FIELD.test(bySpace[4])) return bySpace;

  const byComma = record.split(',').map((field) => field.trim());
  if (byComma.length >= 6 && PERCENT_FIELD.test(byComma[4])) return byComma;

  return undefined;
}

/**
 * Parse `disk_usage_all`, which the telemetry probe emits as repeated
 * `source,size,used,avail,pcent,target` records joined by semicolons.
 */
function parseMounts(raw: string | undefined): Mount[] {
  if (!raw) return [];

  const mounts: Mount[] = [];

  for (const record of raw.split(';')) {
    const trimmed = record.trim();
    if (!trimmed) continue;

    const fields = splitRecord(trimmed);
    if (!fields) continue;

    const [source, size, used, avail, pcent] = fields;

    mounts.push({
      source,
      size,
      used,
      avail,
      percent: pct(pcent),
      target: fields.slice(5).join(' ') || '/',
    });
  }

  return mounts;
}

/** `.table thead th` sets text-align: left, so numeric headers need it inline. */
const NUM_HEAD = { textAlign: 'right' } as const;

/* ── Cleanup analysis ─────────────────────────────────────── */

/** A mount at or above these percentages needs attention. */
const MOUNT_WARN = 80;
const MOUNT_CRITICAL = 90;

/** Badge tone for a mount, or undefined while it is comfortably below 80%. */
function mountTone(value: number | undefined): 'warn' | 'err' | undefined {
  if (value === undefined) return undefined;
  if (value >= MOUNT_CRITICAL) return 'err';
  if (value >= MOUNT_WARN) return 'warn';
  return undefined;
}

function mountFlag(value: number | undefined): string | undefined {
  const tone = mountTone(value);
  if (tone === 'err') return 'Critical';
  if (tone === 'warn') return 'High';
  return undefined;
}

/** Fullest mounts first; a mount with no percentage sorts last. */
function sortByUsage(mounts: Mount[]): Mount[] {
  return [...mounts].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
}

function statusTone(status: Server['status']): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'online') return 'ok';
  if (status === 'error') return 'err';
  return 'idle';
}

function StorageCard({
  server,
  telemetry,
  onAnalyzeLogs,
}: {
  server: Server;
  telemetry?: Telemetry;
  onAnalyzeLogs: (server: Server) => void;
}) {
  const usage = pct(telemetry?.disk);
  const raw = telemetry?.disk_usage_all;
  // Fullest mounts first, so the ones that need cleanup are always on top.
  const mounts = useMemo(() => sortByUsage(parseMounts(raw)), [raw]);
  const heavy = usage !== undefined && usage > 80;

  const analyze = () => {
    onAnalyzeLogs(server);
  };

  return (
    <article className="card">
      <div className="card__head">
        <span style={{ marginTop: 5 }}>
          <Dot tone={statusTone(server.status)} />
        </span>
        <div className="grow min-w-0">
          <div className="card__title truncate">{server.name}</div>
          <div className="card__meta truncate">
            {server.username}@{server.host}
          </div>
        </div>
        {usage !== undefined && (
          <Badge tone={heavy ? severity(usage) : 'ok'}>{heavy ? 'Heavy load' : 'Stable'}</Badge>
        )}
      </div>

      <div className="card__body">
        <div className="col gap-1">
          <div className="row row--between">
            <span className="label">Root volume</span>
            <span className="num">{percent(usage, 1)}</span>
          </div>
          <Meter value={usage} tone={severityTone(usage)} tall />
        </div>

        <div className="col gap-1">
          <KV k="Free" v={telemetry?.disk_free ?? '—'} />
          <KV k="Total" v={telemetry?.disk_total ?? '—'} />
        </div>
      </div>

      <div className="divider" />

      {mounts.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Mount</th>
              <th style={NUM_HEAD}>Size</th>
              <th style={NUM_HEAD}>Used</th>
              <th style={NUM_HEAD}>Avail</th>
              <th style={NUM_HEAD}>Use</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((mount, index) => {
              const tone = mountTone(mount.percent);
              return (
                <tr key={`${mount.source}:${mount.target}:${index}`}>
                  <td>
                    <div className="mono truncate" title={mount.target}>
                      {mount.target}
                    </div>
                    <div className="card__meta truncate">{mount.source}</div>
                  </td>
                  <td className="table__num">{mount.size}</td>
                  <td className="table__num">{mount.used}</td>
                  <td className="table__num">{mount.avail}</td>
                  <td className="table__num">
                    <div className="row justify-end gap-2">
                      {tone && <Badge tone={tone}>{mountFlag(mount.percent)}</Badge>}
                      <span className="num">{percent(mount.percent)}</span>
                      <div style={{ width: 44 }}>
                        <Meter value={mount.percent} tone={severityTone(mount.percent)} />
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="panel__body">
          <span className="field__hint">
            {telemetry ? 'Per-mount breakdown not reported by this host.' : 'No telemetry yet.'}
          </span>
        </div>
      )}

      <div className="card__foot">
        <Button size="sm" variant="ghost" onClick={analyze}>
          Analyze Log Bloat
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      </div>
    </article>
  );
}

export function StorageView({
  servers,
  telemetry,
  onAnalyzeLogs,
}: {
  servers: Server[];
  telemetry: Record<string, Telemetry>;
  onAnalyzeLogs: (server: Server) => void;
}) {
  return (
    <div className="view">
      <div className="view__head">
        <div>
          <p className="view__sub">Disk usage per host, read from the telemetry poll.</p>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={<HardDrive size={18} strokeWidth={1.75} />}
          title="No hosts to measure"
          text="Add a host from the fleet view to collect disk usage."
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {servers.map((server) => (
            <StorageCard
              key={server.id}
              server={server}
              telemetry={telemetry[server.id]}
              onAnalyzeLogs={onAnalyzeLogs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
