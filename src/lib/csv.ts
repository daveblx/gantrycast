import type { Sample } from '../types';

/**
 * Column order for the telemetry export. One row per sample per host, so a
 * host that reported 120 samples contributes 120 rows.
 */
export const CSV_COLUMNS = [
  'host',
  'timestamp_iso',
  'cpu',
  'ram',
  'load1',
  'load5',
  'load15',
  'rx_mb',
  'tx_mb',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** The minimum a host needs to appear in the export. */
export interface CsvHost {
  id: string;
  name: string;
}

/**
 * Render one field. Values are quoted only when they would otherwise break the
 * row, so numbers stay readable in a spreadsheet.
 */
export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** ISO-8601 for a sample timestamp, or an empty cell when it is unusable. */
function isoStamp(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Build the whole export as one CSV document. Hosts keep the order they are
 * given in; samples keep the order they were recorded in.
 */
export function buildTelemetryCsv(
  hosts: readonly CsvHost[],
  history: Record<string, Sample[]>,
): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];

  for (const host of hosts) {
    const samples = history[host.id];
    if (!samples || !samples.length) continue;

    for (const sample of samples) {
      rows.push(
        [
          csvCell(host.name),
          csvCell(isoStamp(sample.ts)),
          csvCell(sample.cpu),
          csvCell(sample.ram),
          csvCell(sample.load1),
          csvCell(sample.load5),
          csvCell(sample.load15),
          csvCell(sample.rxMb),
          csvCell(sample.txMb),
        ].join(','),
      );
    }
  }

  return `${rows.join('\n')}\n`;
}

/** How many data rows the export would contain, excluding the header. */
export function countTelemetryRows(
  hosts: readonly CsvHost[],
  history: Record<string, Sample[]>,
): number {
  let total = 0;
  for (const host of hosts) {
    total += history[host.id]?.length ?? 0;
  }
  return total;
}

/** `gantrycast-telemetry-2024-05-01.csv` */
export function telemetryCsvFilename(now = new Date()): string {
  const stamp = Number.isNaN(now.getTime()) ? 'export' : now.toISOString().slice(0, 10);
  return `gantrycast-telemetry-${stamp}.csv`;
}

/** Hand a CSV document to the browser as a file download. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build and download the fleet's telemetry history. Returns the number of data
 * rows written so the caller can report what happened.
 */
export function exportTelemetryCsv(
  hosts: readonly CsvHost[],
  history: Record<string, Sample[]>,
): number {
  const rows = countTelemetryRows(hosts, history);
  downloadCsv(telemetryCsvFilename(), buildTelemetryCsv(hosts, history));
  return rows;
}
