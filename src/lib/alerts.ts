import { clamp } from './format';

/**
 * Client-side alert thresholds.
 *
 * Everything here is local to the browser: the control plane has no notion of
 * alerting, so the model is a plain map of host id -> thresholds persisted in
 * localStorage and evaluated against the latest telemetry payload.
 */

export type AlertLevel = 'ok' | 'warn' | 'critical';

/** The two levels a metric can be measured against. */
export interface ThresholdPair {
  warn: number;
  critical: number;
}

export type ThresholdMetric = 'cpu' | 'ram' | 'disk';

export type Thresholds = Record<ThresholdMetric, ThresholdPair>;

/** host id -> thresholds. Hosts without an entry use the defaults. */
export type ThresholdMap = Record<string, Thresholds>;

/** Single localStorage key holding the whole map, as JSON. */
export const ALERT_THRESHOLDS_KEY = 'gantrycast:alert-thresholds';

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpu: { warn: 75, critical: 90 },
  ram: { warn: 80, critical: 90 },
  disk: { warn: 80, critical: 90 },
};

export const THRESHOLD_METRICS: readonly ThresholdMetric[] = ['cpu', 'ram', 'disk'];

export const METRIC_LABELS: Record<ThresholdMetric, string> = {
  cpu: 'CPU',
  ram: 'RAM',
  disk: 'Disk',
};

/** A percentage below 1 or above 100 is never a useful threshold. */
const MIN_LEVEL = 1;
const MAX_LEVEL = 100;

/* ── Normalisation ────────────────────────────────────────── */

function toLevel(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clamp(parsed, MIN_LEVEL, MAX_LEVEL) * 10) / 10;
}

function normalisePair(input: unknown, fallback: ThresholdPair): ThresholdPair {
  if (!input || typeof input !== 'object') return { ...fallback };

  const raw = input as { warn?: unknown; critical?: unknown };
  const warn = toLevel(raw.warn, fallback.warn);
  const critical = toLevel(raw.critical, fallback.critical);

  // A warn level above critical would make the critical band unreachable, so
  // the two are swapped rather than silently dropping one of them.
  return warn <= critical ? { warn, critical } : { warn: critical, critical: warn };
}

/** Coerce anything (stored JSON, form input) into usable thresholds. */
export function normaliseThresholds(input: unknown): Thresholds {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    cpu: normalisePair(raw.cpu, DEFAULT_THRESHOLDS.cpu),
    ram: normalisePair(raw.ram, DEFAULT_THRESHOLDS.ram),
    disk: normalisePair(raw.disk, DEFAULT_THRESHOLDS.disk),
  };
}

export function cloneThresholds(thresholds: Thresholds): Thresholds {
  return {
    cpu: { ...thresholds.cpu },
    ram: { ...thresholds.ram },
    disk: { ...thresholds.disk },
  };
}

/* ── Persistence ──────────────────────────────────────────── */

/** The slice of the Storage API this module needs, so tests can fake it. */
export interface ThresholdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ThresholdStorage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage ?? undefined;
  } catch {
    // Storage can throw outright when cookies are blocked.
    return undefined;
  }
}

/** Read the stored map. Anything unreadable degrades to "no overrides". */
export function readThresholds(
  storage: ThresholdStorage | undefined = browserStorage(),
): ThresholdMap {
  if (!storage) return {};

  let parsed: unknown;
  try {
    const raw = storage.getItem(ALERT_THRESHOLDS_KEY);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const map: ThresholdMap = {};
  for (const [hostId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!hostId) continue;
    map[hostId] = normaliseThresholds(value);
  }
  return map;
}

/** Persist the whole map under the single key. Failures are non-fatal. */
export function writeThresholds(
  map: ThresholdMap,
  storage: ThresholdStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ALERT_THRESHOLDS_KEY, JSON.stringify(map));
  } catch {
    // Quota or blocked storage: the in-memory map still drives this session.
  }
}

/** Thresholds for one host, falling back to the defaults. */
export function thresholdsFor(map: ThresholdMap, hostId: string): Thresholds {
  const stored = map[hostId];
  return stored ? cloneThresholds(stored) : cloneThresholds(DEFAULT_THRESHOLDS);
}

/* ── Evaluation ───────────────────────────────────────────── */

/** Latest utilisation percentages for one host. Missing values are ignored. */
export interface HostMetrics {
  cpu?: number;
  ram?: number;
  disk?: number;
}

export interface Breach {
  metric: ThresholdMetric;
  label: string;
  value: number;
  level: Exclude<AlertLevel, 'ok'>;
  /** The level that was crossed. */
  threshold: number;
}

export interface AlertEvaluation {
  level: AlertLevel;
  breaches: Breach[];
  /** False when the host reported none of the three metrics. */
  hasData: boolean;
  /** Human-readable detail, suitable for a tooltip. */
  summary: string;
}

const LEVEL_RANK: Record<AlertLevel, number> = { ok: 0, warn: 1, critical: 2 };

function breachFor(
  metric: ThresholdMetric,
  value: number,
  pair: ThresholdPair,
): Breach | undefined {
  if (value >= pair.critical) {
    return { metric, label: METRIC_LABELS[metric], value, level: 'critical', threshold: pair.critical };
  }
  if (value >= pair.warn) {
    return { metric, label: METRIC_LABELS[metric], value, level: 'warn', threshold: pair.warn };
  }
  return undefined;
}

/** One line per crossed threshold, e.g. "CPU 92.0% ≥ 90%". */
export function summariseBreaches(breaches: readonly Breach[]): string {
  if (!breaches.length) return 'All metrics within thresholds.';
  return breaches
    .map((breach) => `${breach.label} ${breach.value.toFixed(1)}% ≥ ${breach.threshold}%`)
    .join(' · ');
}

/**
 * Compare the latest telemetry against a host's thresholds. The worst metric
 * wins, so a single critical reading makes the whole host critical.
 */
export function evaluateHost(metrics: HostMetrics, thresholds: Thresholds): AlertEvaluation {
  const breaches: Breach[] = [];
  let level: AlertLevel = 'ok';
  let hasData = false;

  for (const metric of THRESHOLD_METRICS) {
    const value = metrics[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    hasData = true;

    const breach = breachFor(metric, value, thresholds[metric]);
    if (!breach) continue;

    breaches.push(breach);
    if (LEVEL_RANK[breach.level] > LEVEL_RANK[level]) level = breach.level;
  }

  return { level, breaches, hasData, summary: summariseBreaches(breaches) };
}

/** Badge tone for an alert level, matching the tones used elsewhere. */
export function alertTone(level: AlertLevel): 'ok' | 'warn' | 'err' {
  if (level === 'critical') return 'err';
  if (level === 'warn') return 'warn';
  return 'ok';
}

/** Short badge label for an alert level. */
export function alertLabel(level: AlertLevel): string {
  if (level === 'critical') return 'Critical';
  if (level === 'warn') return 'Warn';
  return 'OK';
}
