/** Parse a telemetry string into a finite number, or undefined. */
export function num(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** "42.3%" -> 42.3 */
export function pct(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return num(value.replace('%', ''));
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

/** 1 decimal place, or an em dash when the value is missing. */
export function fixed(value: number | undefined, digits = 1): string {
  return value === undefined ? '—' : value.toFixed(digits);
}

export function percent(value: number | undefined, digits = 0): string {
  return value === undefined ? '—' : `${value.toFixed(digits)}%`;
}

/** 1234567 -> "1.2 GB" (decimal units, matching df -h closely enough). */
export function bytes(mb: number | undefined): string {
  if (mb === undefined) return '—';
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  if (mb < 1024 * 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${(mb / 1024 / 1024).toFixed(2)} TB`;
}

/** Throughput label from a MB/s rate. */
export function rate(mbPerSec: number | undefined): string {
  if (mbPerSec === undefined) return '—';
  if (mbPerSec < 0.001) return '0 B/s';
  if (mbPerSec < 1) return `${(mbPerSec * 1024).toFixed(0)} KB/s`;
  return `${mbPerSec.toFixed(1)} MB/s`;
}

/** 93784 -> "1d 2h" */
export function uptime(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Relative age of a timestamp, e.g. "12s ago". */
export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockTime(ts = Date.now()): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Severity bucket for a 0-100 utilisation value. */
export function severity(value: number | undefined): 'ok' | 'warn' | 'err' {
  if (value === undefined) return 'ok';
  if (value >= 90) return 'err';
  if (value >= 75) return 'warn';
  return 'ok';
}

/**
 * Meter fill modifier for a 0-100 utilisation value.
 *
 * Healthy values stay neutral graphite so a wall of meters does not read as a
 * wall of green; colour is reserved for the states that need attention.
 */
export function severityClass(value: number | undefined): string {
  const s = severity(value);
  if (s === 'err') return 'meter__fill--err';
  if (s === 'warn') return 'meter__fill--warn';
  return '';
}

/**
 * Meter tone for a utilisation value. Returns undefined while healthy so the
 * fill keeps its neutral graphite colour.
 */
export function severityTone(value: number | undefined): 'warn' | 'err' | undefined {
  const s = severity(value);
  return s === 'ok' ? undefined : s;
}

/** Docker status strings look like "Up 3 hours" / "Exited (0) 2 days ago". */
export function isRunning(status: string | undefined): boolean {
  return !!status && /^up\b/i.test(status.trim());
}

/** Pull the host port out of a docker port mapping like "0.0.0.0:8080->80/tcp". */
export function hostPort(ports: string | undefined): string | undefined {
  if (!ports) return undefined;
  const match = ports.match(/:(\d+)->/);
  return match ? match[1] : undefined;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
