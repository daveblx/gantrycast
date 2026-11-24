export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  status: 'online' | 'offline' | 'error';
  installed: {
    docker: boolean;
  };
  telemetry?: Telemetry;
}

/** Raw payload from GET /api/servers/:id/telemetry. All values are strings. */
export interface Telemetry {
  cpu?: string;
  /** Logical core count, so load can be read against the machine's size. */
  cpu_cores?: string;
  ram?: string;
  ram_total_mb?: string;
  ram_available_mb?: string;
  swap_used_mb?: string;
  swap_total_mb?: string;
  disk?: string;
  disk_free?: string;
  disk_total?: string;
  disk_usage_all?: string;
  /** Cumulative kilobytes read since boot. Not a rate. */
  disk_read_kb?: string;
  /** Cumulative kilobytes written since boot. Not a rate. */
  disk_write_kb?: string;
  load1?: string;
  load5?: string;
  load15?: string;
  uptime_s?: string;
  /** Cumulative bytes received since boot, in MB. Not a rate. */
  net_rx_mb?: string;
  /** Cumulative bytes transmitted since boot, in MB. Not a rate. */
  net_tx_mb?: string;
  /** Running process count. */
  proc_count?: string;
  /** Hottest thermal zone in °C, or the literal string "none" when absent. */
  temp_c?: string;
  /** Pretty OS name, e.g. "Ubuntu 24.04.1 LTS". */
  os?: string;
  /** Kernel release, e.g. "6.8.0-45-generic". */
  kernel?: string;
  docker?: string;
  error?: string;
}

/** One telemetry sample, normalised to numbers for charting. */
export interface Sample {
  ts: number;
  cpu?: number;
  ram?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  /** Cumulative MB since boot. */
  rxMb?: number;
  txMb?: number;
  /** Derived MB/s, computed from consecutive cumulative samples. */
  rxRate?: number;
  txRate?: number;
  /** Swap in use, in MB, and the host's total swap. */
  swapUsedMb?: number;
  swapTotalMb?: number;
  /** Cumulative KB since boot. */
  diskReadKb?: number;
  diskWriteKb?: number;
  /** Derived KB/s, computed from consecutive cumulative samples. */
  diskReadRate?: number;
  diskWriteRate?: number;
  procCount?: number;
  /** Hottest thermal zone in °C. Absent when the host reports none. */
  tempC?: number;
}

export interface Cluster {
  id: string;
  name: string;
  serverIds: string[];
}

export type ClusterState = Cluster & { editing?: boolean };

export interface Container {
  id?: string;
  name: string;
  image: string;
  status: string;
  ports?: string;
  serverId?: string;
  serverName?: string;
  serverHost?: string;
}

export type ViewId =
  | 'fleet'
  | 'terminals'
  | 'apps'
  | 'monitoring'
  | 'clusters'
  | 'storage'
  | 'settings';

export type Theme = 'light' | 'dark';

/** What to run automatically once an SSH session reports "Connected". */
export type AutoRun =
  | { kind: 'input'; label: string; command: string }
  | {
      kind: 'deploy';
      label: string;
      scriptType: 'verify' | 'template';
      templateConfig?: unknown;
    };

export type DeployScriptType = 'docker' | 'full' | 'verify';

export interface ExecResult {
  code: number;
  output: string;
  error?: string;
}
