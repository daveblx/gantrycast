import { useEffect, useState } from 'react';
import { ago, clockTime } from '../lib/format';
import type { Theme, ViewId } from '../types';

const VIEW_LABEL: Record<ViewId, string> = {
  fleet: 'hosts',
  terminals: 'terminals',
  apps: 'containers',
  monitoring: 'metrics',
  clusters: 'clusters',
  storage: 'storage',
  settings: 'settings',
};

export function StatusBar({
  view,
  serverCount,
  onlineCount,
  lastSync,
  theme,
  maintenanceMode,
}: {
  view: ViewId;
  serverCount: number;
  onlineCount: number;
  lastSync: number | null;
  theme: Theme;
  maintenanceMode: boolean;
}) {
  // The clock and the "Xs ago" label are time-derived, so the bar needs its own
  // tick: nothing else re-renders it while the app sits idle.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        {onlineCount}/{serverCount} online
      </span>
      <span className="statusbar__item">telemetry {lastSync ? ago(lastSync) : 'pending'}</span>
      {maintenanceMode && (
        <span className="statusbar__item" style={{ color: 'var(--warn)' }}>
          maintenance
        </span>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__item">{VIEW_LABEL[view]}</span>
      <span className="statusbar__item">{theme}</span>
      <span className="statusbar__item">{clockTime()}</span>
    </footer>
  );
}
