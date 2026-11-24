import { Moon, Plus, Rocket, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TerminalOverlay } from './components/TerminalOverlay';
import { AddServerModal } from './components/modals/AddServerModal';
import { CreateClusterModal } from './components/modals/CreateClusterModal';
import { DeployDockerfileModal } from './components/modals/DeployDockerfileModal';
import { DeployTemplateModal } from './components/modals/DeployTemplateModal';
import { InfoModal } from './components/modals/InfoModal';
import { NuclearConfirmModal, NuclearWarningModal } from './components/modals/NuclearModals';
import { QuickDeployModal } from './components/modals/QuickDeployModal';
import { ServerSettingsModal } from './components/modals/ServerSettingsModal';
import { Button, IconButton, SearchInput } from './components/ui';
import { usePolling } from './hooks/usePolling';
import { useTheme } from './hooks/useTheme';
import { api } from './lib/api';
import { appendSample, backoffDelay, lastSample, POLL_INTERVAL_MS, toSample } from './lib/telemetry';
import type {
  AutoRun,
  ClusterState,
  Sample,
  Server,
  Telemetry,
  ViewId,
} from './types';
import { AppsView } from './views/AppsView';
import { ClustersView } from './views/ClustersView';
import { FleetView } from './views/FleetView';
import { MonitoringView } from './views/MonitoringView';
import { ProdSimulationOverlay } from './views/ProdSimulationOverlay';
import { SettingsView } from './views/SettingsView';
import { StorageView } from './views/StorageView';
import { TerminalsView } from './views/TerminalsView';

const VIEW_TITLE: Record<ViewId, string> = {
  fleet: 'Hosts',
  terminals: 'Terminals',
  apps: 'Containers',
  monitoring: 'Metrics',
  clusters: 'Clusters',
  storage: 'Storage',
  settings: 'Settings',
};

const ANALYZE_LOGS_COMMAND =
  "sudo sh -lc 'du -h -d2 /var/log 2>/dev/null | sort -h | tail -n 30'";

const AUTO_SYNC_KEY = 'gantrycast:auto-sync';
const DEFAULT_PORT_KEY = 'gantrycast:default-port';

/** Per-host poll bookkeeping: consecutive failures and the next attempt time. */
interface HostPollState {
  failures: number;
  nextAttemptAt: number;
}

function readAutoSync(): boolean {
  return window.localStorage.getItem(AUTO_SYNC_KEY) !== '0';
}

function readDefaultPort(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(DEFAULT_PORT_KEY) ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 22;
}

export default function App() {
  const { theme, toggle: toggleTheme } = useTheme();

  const [servers, setServers] = useState<Server[]>([]);
  const [clusters, setClusters] = useState<ClusterState[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendOk, setBackendOk] = useState(true);

  const [view, setView] = useState<ViewId>('fleet');
  const [search, setSearch] = useState('');
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [autoSync, setAutoSync] = useState(readAutoSync);
  const [defaultPort, setDefaultPort] = useState(readDefaultPort);

  useEffect(() => {
    window.localStorage.setItem(AUTO_SYNC_KEY, autoSync ? '1' : '0');
  }, [autoSync]);

  useEffect(() => {
    window.localStorage.setItem(DEFAULT_PORT_KEY, String(defaultPort));
  }, [defaultPort]);

  const [telemetry, setTelemetry] = useState<Record<string, Telemetry>>({});
  const [history, setHistory] = useState<Record<string, Sample[]>>({});
  const [lastSync, setLastSync] = useState<number | null>(null);

  const [activeTerminal, setActiveTerminal] = useState<Server | null>(null);
  const [autoDeployOnConnect, setAutoDeployOnConnect] = useState<null | 'full'>(null);
  const [autoRunOnConnect, setAutoRunOnConnect] = useState<AutoRun | null>(null);

  const [addHostOpen, setAddHostOpen] = useState(false);
  const [quickDeployOpen, setQuickDeployOpen] = useState(false);
  const [quickDeployServerId, setQuickDeployServerId] = useState('');
  const [createClusterOpen, setCreateClusterOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [serverSettings, setServerSettings] = useState<Server | null>(null);
  const [deployDockerServer, setDeployDockerServer] = useState<Server | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [nuclearTarget, setNuclearTarget] = useState<Server | null>(null);
  const [nuclearStep, setNuclearStep] = useState<0 | 1 | 2>(0);
  const [destroying, setDestroying] = useState<string | null>(null);
  const [simulationCluster, setSimulationCluster] = useState<ClusterState | null>(null);

  const serversRef = useRef<Server[]>(servers);
  serversRef.current = servers;

  /**
   * Backoff bookkeeping per host. Kept in a ref so a poll round never has to
   * re-render to remember that a host is failing.
   */
  const pollStateRef = useRef<Record<string, HostPollState>>({});

  /* ── Data loading ───────────────────────────────────────── */

  const loadServers = useCallback(async () => {
    try {
      const data = await api.listServers();
      setServers(data);
      setBackendOk(true);
    } catch {
      setBackendOk(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadClusters = useCallback(async () => {
    try {
      setClusters(await api.listClusters());
    } catch {
      /* the sidebar already reflects backend reachability */
    }
  }, []);

  useEffect(() => {
    void loadServers();
    void loadClusters();
  }, [loadServers, loadClusters]);

  /**
   * One telemetry poll for the whole fleet. Each host is fetched in parallel
   * and a single unreachable host cannot stall the rest.
   *
   * The loop itself always ticks at the base interval; a host that is backing
   * off is simply skipped until its own next attempt is due. That keeps the
   * usePolling contract (one chain, no overlap) while letting a dead host wait
   * 10s/20s/30s without slowing down the hosts that are healthy.
   */
  const pollTelemetry = useCallback(async () => {
    const list = serversRef.current;
    if (!list.length) return;

    const state = pollStateRef.current;
    const startedAt = Date.now();
    const due = list.filter((server) => {
      const entry = state[server.id];
      return !entry || entry.nextAttemptAt <= startedAt;
    });
    if (!due.length) return;

    const settled = await Promise.allSettled(due.map((server) => api.telemetry(server.id)));
    // A fulfilled request means the API answered. Per-host failures come back as
    // 200 with an `error` field, so this is a true reachability signal.
    setBackendOk(settled.some((result) => result.status === 'fulfilled'));
    const now = Date.now();
    const fresh: Array<[string, Telemetry]> = [];

    settled.forEach((result, index) => {
      const id = due[index].id;
      const payload = result.status === 'fulfilled' ? result.value : undefined;
      // A rejected request and an `error` payload are the same thing here: this
      // host missed a round, so it backs off while the others carry on.
      if (!payload || payload.error) {
        const failures = (state[id]?.failures ?? 0) + 1;
        state[id] = { failures, nextAttemptAt: now + backoffDelay(failures) };
        return;
      }
      state[id] = { failures: 0, nextAttemptAt: now + POLL_INTERVAL_MS };
      fresh.push([id, payload]);
    });

    if (!fresh.length) return;

    setTelemetry((prev) => {
      const next = { ...prev };
      for (const [id, payload] of fresh) next[id] = payload;
      return next;
    });

    setHistory((prev) => {
      const next = { ...prev };
      for (const [id, payload] of fresh) {
        next[id] = appendSample(prev[id], toSample(payload, now, lastSample(prev[id])));
      }
      return next;
    });

    setLastSync(now);
  }, []);

  usePolling(pollTelemetry, POLL_INTERVAL_MS, { enabled: servers.length > 0 && autoSync });

  // Re-enabling automatic sync should not inherit a backoff window from before.
  useEffect(() => {
    if (!autoSync) return;
    for (const entry of Object.values(pollStateRef.current)) entry.nextAttemptAt = 0;
  }, [autoSync]);

  const refreshTelemetry = useCallback(async (id: string) => {
    try {
      const payload = await api.telemetry(id);
      if (!payload || payload.error) return;
      // The host may have been removed while the request was in flight.
      if (!serversRef.current.some((server) => server.id === id)) return;
      const now = Date.now();
      // A manual refresh that worked clears any backoff for this host.
      pollStateRef.current[id] = { failures: 0, nextAttemptAt: now + POLL_INTERVAL_MS };
      setTelemetry((prev) => ({ ...prev, [id]: payload }));
      setHistory((prev) => ({
        ...prev,
        [id]: appendSample(prev[id], toSample(payload, now, lastSample(prev[id]))),
      }));
      setLastSync(now);
    } catch {
      /* the card keeps its last known values */
    }
  }, []);

  /* ── Server mutations ───────────────────────────────────── */

  const addServer = useCallback(
    async (data: Partial<Server>) => {
      const created = await api.addServer(data);
      setServers((prev) => [...prev, created]);
      setAddHostOpen(false);
      void refreshTelemetry(created.id);
    },
    [refreshTelemetry],
  );

  const deleteServer = useCallback(async (id: string) => {
    const target = serversRef.current.find((server) => server.id === id);
    if (!target) return;
    if (!window.confirm(`Remove ${target.name} from the control plane? Software on the host is left untouched.`)) {
      return;
    }
    try {
      await api.deleteServer(id);
      setServers((prev) => prev.filter((server) => server.id !== id));
      delete pollStateRef.current[id];
      setTelemetry((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setHistory((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch {
      window.alert('Could not remove the host. Check that the backend is running.');
    }
  }, []);

  const destroyServer = useCallback(async (id: string) => {
    setDestroying(id);
    try {
      const result = await api.destroyServer(id);
      if (result.success) {
        setServers((prev) => prev.filter((server) => server.id !== id));
        delete pollStateRef.current[id];
        setTelemetry((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setHistory((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        window.alert(`Cleanup failed: ${result.error ?? 'unknown error'}`);
      }
    } catch {
      window.alert('A connection error occurred during destruction.');
    } finally {
      setDestroying(null);
      setNuclearTarget(null);
      setNuclearStep(0);
    }
  }, []);

  /* ── Cluster mutations ──────────────────────────────────── */

  const addCluster = useCallback(async (data: Partial<ClusterState>) => {
    try {
      const created = await api.addCluster(data);
      setClusters((prev) => [...prev, created]);
      setCreateClusterOpen(false);
    } catch {
      window.alert('Could not create the cluster.');
    }
  }, []);

  const deleteCluster = useCallback(async (id: string) => {
    const target = clusters.find((cluster) => cluster.id === id);
    if (!target) return;
    if (!window.confirm(`Delete cluster ${target.name}? Hosts stay connected.`)) return;
    try {
      await api.deleteCluster(id);
      setClusters((prev) => prev.filter((cluster) => cluster.id !== id));
    } catch {
      window.alert('Could not delete the cluster.');
    }
  }, [clusters]);

  /* ── Terminal helpers ───────────────────────────────────── */

  const openTerminal = useCallback((server: Server, autoRun: AutoRun | null = null) => {
    setAutoDeployOnConnect(null);
    setAutoRunOnConnect(autoRun);
    setActiveTerminal(server);
  }, []);

  const closeTerminal = useCallback(() => {
    setActiveTerminal(null);
    setAutoDeployOnConnect(null);
    setAutoRunOnConnect(null);
  }, []);

  const analyzeLogs = useCallback(
    (server: Server) => {
      openTerminal(server, {
        kind: 'input',
        label: 'Analyze log bloat',
        command: ANALYZE_LOGS_COMMAND,
      });
    },
    [openTerminal],
  );

  /* ── Derived ────────────────────────────────────────────── */

  const onlineCount = useMemo(
    () => servers.filter((server) => server.status === 'online').length,
    [servers],
  );

  const startQuickDeploy = useCallback(() => {
    if (maintenanceMode) return;
    const target = servers.find((server) => server.id === quickDeployServerId) ?? servers[0];
    if (!target) return;
    setQuickDeployOpen(false);
    setAutoRunOnConnect(null);
    setAutoDeployOnConnect('full');
    setActiveTerminal(target);
  }, [maintenanceMode, quickDeployServerId, servers]);

  const openQuickDeploy = useCallback(() => {
    if (!servers.length || maintenanceMode) return;
    if (servers.length === 1) {
      setAutoRunOnConnect(null);
      setAutoDeployOnConnect('full');
      setActiveTerminal(servers[0]);
      return;
    }
    setQuickDeployServerId(servers[0].id);
    setQuickDeployOpen(true);
  }, [maintenanceMode, servers]);

  /* ── View ───────────────────────────────────────────────── */

  const renderView = () => {
    switch (view) {
      case 'fleet':
        return (
          <FleetView
            servers={servers}
            loading={loading}
            search={search}
            telemetry={telemetry}
            history={history}
            onAddHost={() => setAddHostOpen(true)}
            onOpenTerminal={(server) => openTerminal(server)}
            onOpenSettings={setServerSettings}
            onDelete={deleteServer}
            onNuke={(server) => {
              setNuclearTarget(server);
              setNuclearStep(1);
            }}
            onRefresh={refreshTelemetry}
          />
        );
      case 'terminals':
        return <TerminalsView servers={servers} onOpenTerminal={(server) => openTerminal(server)} />;
      case 'apps':
        return (
          <AppsView
            servers={servers}
            search={search}
            onOpenTerminal={openTerminal}
            onDeployTemplate={() => setTemplateOpen(true)}
          />
        );
      case 'monitoring':
        return (
          <MonitoringView
            servers={servers}
            telemetry={telemetry}
            history={history}
            search={search}
          />
        );
      case 'clusters':
        return (
          <ClustersView
            clusters={clusters}
            servers={servers}
            onCreateCluster={() => setCreateClusterOpen(true)}
            onDeleteCluster={deleteCluster}
            onOpenSimulation={setSimulationCluster}
          />
        );
      case 'storage':
        return <StorageView servers={servers} telemetry={telemetry} onAnalyzeLogs={analyzeLogs} />;
      case 'settings':
        return (
          <SettingsView
            maintenanceMode={maintenanceMode}
            onToggleMaintenance={() => setMaintenanceMode((current) => !current)}
            onOpenKeys={() => setKeysOpen(true)}
            theme={theme}
            onToggleTheme={toggleTheme}
            autoSync={autoSync}
            onToggleAutoSync={() => setAutoSync((current) => !current)}
            defaultPort={defaultPort}
            onChangeDefaultPort={setDefaultPort}
          />
        );
      default:
        return null;
    }
  };

  const searchable = view === 'fleet' || view === 'apps' || view === 'monitoring';

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={setView}
        serverCount={servers.length}
        onlineCount={onlineCount}
        clusterCount={clusters.length}
        backendOk={backendOk}
      />

      <div className="main">
        <header className="toolbar">
          <span className="toolbar__crumb">gantrycast</span>
          <span className="faint">/</span>
          <span className="toolbar__title">{VIEW_TITLE[view]}</span>

          <span className="toolbar__spacer" />

          {searchable && (
            <SearchInput
              className="w-[220px]"
              value={search}
              onChange={setSearch}
              placeholder={view === 'apps' ? 'Filter containers' : 'Filter hosts'}
              aria-label="Filter"
            />
          )}

          <div className="toolbar__actions">
            <IconButton
              label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </IconButton>
            <Button onClick={() => setAddHostOpen(true)}>
              <Plus size={13} />
              Add host
            </Button>
            <Button
              variant="primary"
              onClick={openQuickDeploy}
              disabled={!servers.length || maintenanceMode}
              title={maintenanceMode ? 'Disabled while maintenance mode is active' : undefined}
            >
              <Rocket size={13} />
              Quick deploy
            </Button>
          </div>
        </header>

        <div className="content scroll">{renderView()}</div>

        <StatusBar
          view={view}
          serverCount={servers.length}
          onlineCount={onlineCount}
          lastSync={lastSync}
          theme={theme}
          maintenanceMode={maintenanceMode}
        />
      </div>

      {activeTerminal && (
        <TerminalOverlay
          server={activeTerminal}
          autoDeploy={autoDeployOnConnect}
          autoRun={autoRunOnConnect}
          maintenanceMode={maintenanceMode}
          onClose={closeTerminal}
        />
      )}

      {addHostOpen && (
        <AddServerModal
          onAdd={addServer}
          onClose={() => setAddHostOpen(false)}
          defaultPort={defaultPort}
        />
      )}

      {quickDeployOpen && (
        <QuickDeployModal
          servers={servers}
          selectedServerId={quickDeployServerId}
          onChangeSelected={setQuickDeployServerId}
          onStart={startQuickDeploy}
          onClose={() => setQuickDeployOpen(false)}
        />
      )}

      {createClusterOpen && (
        <CreateClusterModal
          servers={servers}
          onCreate={addCluster}
          onClose={() => setCreateClusterOpen(false)}
        />
      )}

      {keysOpen && (
        <InfoModal
          title="Global SSH keys"
          body="Key management is wired to the interface. Using stored keys for authentication, in addition to passwords, is not implemented yet."
          primaryLabel="Close"
          onPrimary={() => setKeysOpen(false)}
          onClose={() => setKeysOpen(false)}
        />
      )}


      {serverSettings && (
        <ServerSettingsModal
          server={serverSettings}
          maintenanceMode={maintenanceMode}
          onClose={() => setServerSettings(null)}
          onOpenShell={() => {
            const target = serverSettings;
            setServerSettings(null);
            openTerminal(target);
          }}
          onQuickDeploy={() => {
            if (maintenanceMode) return;
            const target = serverSettings;
            setServerSettings(null);
            setAutoRunOnConnect(null);
            setAutoDeployOnConnect('full');
            setActiveTerminal(target);
          }}
          onVerify={() => {
            const target = serverSettings;
            setServerSettings(null);
            openTerminal(target, { kind: 'deploy', label: 'Verify stack', scriptType: 'verify' });
          }}
          onAnalyzeLogs={() => {
            const target = serverSettings;
            setServerSettings(null);
            analyzeLogs(target);
          }}
          onNuke={() => {
            const target = serverSettings;
            setServerSettings(null);
            setNuclearTarget(target);
            setNuclearStep(1);
          }}
          onDeployDocker={() => {
            const target = serverSettings;
            setServerSettings(null);
            setDeployDockerServer(target);
          }}
        />
      )}

      {deployDockerServer && (
        <DeployDockerfileModal
          server={deployDockerServer}
          onClose={() => setDeployDockerServer(null)}
        />
      )}

      {templateOpen && (
        <DeployTemplateModal
          servers={servers}
          onClose={() => setTemplateOpen(false)}
          onStart={(server, config) => {
            setTemplateOpen(false);
            if (maintenanceMode) return;
            openTerminal(server, {
              kind: 'deploy',
              label: 'VPS template',
              scriptType: 'template',
              templateConfig: config,
            });
          }}
        />
      )}

      {nuclearTarget && nuclearStep === 1 && (
        <NuclearWarningModal
          server={nuclearTarget}
          onConfirm={() => setNuclearStep(2)}
          onClose={() => {
            setNuclearTarget(null);
            setNuclearStep(0);
          }}
        />
      )}

      {nuclearTarget && nuclearStep === 2 && (
        <NuclearConfirmModal
          server={nuclearTarget}
          isDestroying={destroying === nuclearTarget.id}
          onConfirm={() => destroyServer(nuclearTarget.id)}
          onClose={() => {
            setNuclearTarget(null);
            setNuclearStep(0);
          }}
        />
      )}

      {simulationCluster && (
        <ProdSimulationOverlay
          cluster={simulationCluster}
          onClose={() => setSimulationCluster(null)}
        />
      )}
    </div>
  );
}
