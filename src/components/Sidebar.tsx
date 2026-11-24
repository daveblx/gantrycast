import {
  Activity,
  Database,
  Globe,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ViewId } from '../types';

const COLLAPSE_KEY = 'gantrycast:sidebar-collapsed';

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(COLLAPSE_KEY) === '1';
}

interface NavEntry {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
  count?: number;
}

export function Sidebar({
  view,
  onNavigate,
  serverCount,
  onlineCount,
  clusterCount,
  backendOk,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  serverCount: number;
  onlineCount: number;
  clusterCount: number;
  backendOk: boolean;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  const groups: Array<{ label: string; entries: NavEntry[] }> = [
    {
      label: 'Fleet',
      entries: [
        { id: 'fleet', label: 'Hosts', icon: <ServerIcon size={14} />, count: serverCount },
        { id: 'terminals', label: 'Terminals', icon: <TerminalIcon size={14} /> },
        { id: 'apps', label: 'Containers', icon: <LayoutGrid size={14} /> },
      ],
    },
    {
      label: 'Observe',
      entries: [
        { id: 'monitoring', label: 'Metrics', icon: <Activity size={14} /> },
        { id: 'storage', label: 'Storage', icon: <Database size={14} /> },
      ],
    },
    {
      label: 'Orchestrate',
      entries: [
        { id: 'clusters', label: 'Clusters', icon: <Globe size={14} />, count: clusterCount },
      ],
    },
  ];

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar__brand">
        <img className="sidebar__mark" src="/logo.png" alt="" />
        <div className="grow sidebar__brand-text">
          <div className="sidebar__name">
            Gantry<em>Cast</em>
          </div>
          <div className="sidebar__sub">Control plane</div>
        </div>
      </div>

      <nav className="sidebar__nav scroll">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="sidebar__group">{collapsed ? '' : group.label}</div>
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`nav-item${view === entry.id ? ' nav-item--active' : ''}`}
                aria-current={view === entry.id ? 'page' : undefined}
                aria-label={entry.label}
                title={collapsed ? entry.label : undefined}
                onClick={() => onNavigate(entry.id)}
              >
                <span className="nav-item__icon">{entry.icon}</span>
                <span className="nav-item__label">{entry.label}</span>
                {entry.count !== undefined && entry.count > 0 && (
                  <span className="nav-item__count">{entry.count}</span>
                )}
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar__group">{collapsed ? '' : 'System'}</div>
        <button
          type="button"
          className={`nav-item${view === 'settings' ? ' nav-item--active' : ''}`}
          aria-current={view === 'settings' ? 'page' : undefined}
          aria-label="Settings"
          title={collapsed ? 'Settings' : undefined}
          onClick={() => onNavigate('settings')}
        >
          <span className="nav-item__icon">
            <SettingsIcon size={14} />
          </span>
          <span className="nav-item__label">Settings</span>
        </button>
      </nav>

      <div className="sidebar__foot">
        <div className="sidebar__foot-row">{backendOk ? 'api reachable' : 'api unreachable'}</div>
        <div className="sidebar__foot-row">
          {onlineCount}/{serverCount} hosts up
        </div>
        <button
          type="button"
          className="sidebar__toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          <span className="sidebar__toggle-label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
