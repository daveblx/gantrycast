import type { Sample, Telemetry } from '../types';
import { num, pct } from './format';

/* ── Polling cadence ──────────────────────────────────────── */

/** Base telemetry poll interval. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * A host is stale once its last good sample is older than this. Three missed
 * rounds is long enough to ride out one slow SSH handshake and short enough
 * that a dead host never keeps showing numbers as if they were live.
 */
export const STALE_AFTER_MS = POLL_INTERVAL_MS * 3;

/**
 * Backoff ladder for a host whose poll keeps failing: 5s → 10s → 20s → 30s,
 * then capped. Only the failing host waits; the rest of the fleet keeps the
 * base cadence.
 */
export const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 30_000] as const;

/** Delay before the next attempt for a host with `failures` consecutive misses. */
export function backoffDelay(failures: number): number {
  if (failures <= 0) return POLL_INTERVAL_MS;
  const index = Math.min(failures, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[index];
}

/** True when the last successful sample is too old to be presented as live. */
export function isStale(ts: number | undefined, now = Date.now()): boolean {
  if (!ts) return true;
  return now - ts > STALE_AFTER_MS;
}

/* ── Samples ──────────────────────────────────────────────── */

/** How many samples to retain per server. 720 × 5s ≈ 1 hour. */
export const HISTORY_LIMIT = 720;

/**
 * Rate from two consecutive cumulative counters. A counter that went backwards
 * means the interface or disk was reset (reboot, device re-attach), so the rate
 * is dropped rather than reported as negative.
 */
function deriveRate(
  current: number | undefined,
  previous: number | undefined,
  seconds: number | undefined,
): number | undefined {
  if (current === undefined || previous === undefined || seconds === undefined) return undefined;
  if (current < previous) return undefined;
  return (current - previous) / seconds;
}

/** `temp_c` is the literal string "none" when the host exposes no thermal zone. */
function temperature(value: string | undefined): number | undefined {
  if (!value || value.trim().toLowerCase() === 'none') return undefined;
  return num(value);
}

/**
 * Convert a raw telemetry payload into a chartable sample.
 *
 * `net_rx_mb` / `net_tx_mb` and `disk_read_kb` / `disk_write_kb` are cumulative
 * counters since boot, so a rate can only be derived by diffing against the
 * previous sample. When a counter appears to have gone backwards the interface
 * or device was reset, so the rate is dropped rather than reported as negative.
 */
export function toSample(raw: Telemetry, ts: number, previous?: Sample): Sample {
  const rxMb = num(raw.net_rx_mb);
  const txMb = num(raw.net_tx_mb);
  const diskReadKb = num(raw.disk_read_kb);
  const diskWriteKb = num(raw.disk_write_kb);

  // A sub-second gap is too short to divide by without amplifying jitter.
  const elapsed =
    previous && previous.ts > 0 && ts > previous.ts ? (ts - previous.ts) / 1000 : undefined;
  const seconds = elapsed !== undefined && elapsed > 0.5 ? elapsed : undefined;

  return {
    ts,
    cpu: pct(raw.cpu),
    ram: pct(raw.ram),
    load1: num(raw.load1),
    load5: num(raw.load5),
    load15: num(raw.load15),
    rxMb,
    txMb,
    rxRate: deriveRate(rxMb, previous?.rxMb, seconds),
    txRate: deriveRate(txMb, previous?.txMb, seconds),
    swapUsedMb: num(raw.swap_used_mb),
    swapTotalMb: num(raw.swap_total_mb),
    diskReadKb,
    diskWriteKb,
    diskReadRate: deriveRate(diskReadKb, previous?.diskReadKb, seconds),
    diskWriteRate: deriveRate(diskWriteKb, previous?.diskWriteKb, seconds),
    procCount: num(raw.proc_count),
    tempC: temperature(raw.temp_c),
  };
}

/** Append a sample, trimming to HISTORY_LIMIT. Returns a new array. */
export function appendSample(history: Sample[] | undefined, sample: Sample): Sample[] {
  const next = history ? [...history, sample] : [sample];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export function lastSample(history: Sample[] | undefined): Sample | undefined {
  return history && history.length ? history[history.length - 1] : undefined;
}

/** Mean of a numeric field across samples, ignoring gaps. */
export function average(history: Sample[] | undefined, key: keyof Sample): number | undefined {
  if (!history || !history.length) return undefined;
  let sum = 0;
  let count = 0;
  for (const sample of history) {
    const value = sample[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  return count ? sum / count : undefined;
}

/** Extract one field as a nullable series for charting. */
export function series(history: Sample[] | undefined, key: keyof Sample): Array<number | null> {
  if (!history) return [];
  return history.map((sample) => {
    const value = sample[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

/** Sum the latest value of a field across every server's history. */
export function fleetTotal(
  histories: Record<string, Sample[]>,
  key: keyof Sample,
): number | undefined {
  let total = 0;
  let seen = false;
  for (const history of Object.values(histories)) {
    const value = lastSample(history)?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

/**
 * Align every server's series to a common length so they can be summed
 * index-by-index for a fleet-wide chart.
 */
export function alignedFleetSeries(
  histories: Record<string, Sample[]>,
  key: keyof Sample,
): number[] {
  const entries = Object.values(histories).filter((h) => h.length > 0);
  if (!entries.length) return [];
  const maxLen = Math.max(...entries.map((h) => h.length));
  const out: number[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    let sum = 0;
    for (const history of entries) {
      const idx = history.length - maxLen + i;
      if (idx >= 0 && idx < history.length) {
        const value = history[idx][key];
        if (typeof value === 'number' && Number.isFinite(value)) sum += value;
      }
    }
    out.push(sum);
  }
  return out;
}
