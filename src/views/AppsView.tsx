import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Box,
  ExternalLink,
  FileText,
  LayoutGrid,
  RefreshCw,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { hostPort, isRunning, pluralize } from '../lib/format';
import { usePolling } from '../hooks/usePolling';
import type { AutoRun, Container, Server } from '../types';
import { Banner, Button, Dot, EmptyState, IconButton } from '../components/ui';

const POLL_INTERVAL_MS = 10_000;

function appKey(app: Container): string {
  return `${app.serverId ?? ''}/${app.name}`;
}

/** Host port from a docker mapping such as "0.0.0.0:8080->80/tcp". */
function appUrl(app: Container): string | null {
  const port = hostPort(app.ports);
  if (!port || !app.serverHost) return null;
  return `http://${app.serverHost}:${port}`;
}

export function AppsView({
  servers,
  search,
  onOpenTerminal,
  onDeployTemplate,
}: {
  servers: Server[];
  search: string;
  onOpenTerminal: (server: Server, autoRun: AutoRun) => void;
  onDeployTemplate: () => void;
}) {
  const [apps, setApps] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A manual refresh can overlap an in-flight poll. Only the newest request is
  // allowed to commit, otherwise an older snapshot lands last and undoes it.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;

    if (servers.length === 0) {
      setApps([]);
      setError(null);
      setLoading(false);
      return;
    }

    // One unreachable host must not stall the rest of the fleet.
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const containers = await api.containers(server.id);
        return containers.map<Container>((container) => ({
          ...container,
          serverId: server.id,
          serverName: server.name,
          serverHost: server.host,
        }));
      }),
    );

    const next: Container[] = [];
    const unreachable: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        next.push(...result.value);
      } else {
        unreachable.push(servers[index].name);
      }
    });

    if (seq !== seqRef.current) return;

    setApps(next);
    setError(unreachable.length > 0 ? `No container list from ${unreachable.join(', ')}.` : null);
    setLoading(false);
  }, [servers]);

  usePolling(load, POLL_INTERVAL_MS);

  const refresh = () => {
    setLoading(true);
    void load();
  };

  const term = search.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!term) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(term) ||
        app.image.toLowerCase().includes(term) ||
        (app.serverName ?? '').toLowerCase().includes(term),
    );
  }, [apps, term]);

  const openShell = (app: Container) => {
    const server = servers.find((candidate) => candidate.id === app.serverId);
    if (!server) return;
    onOpenTerminal(server, {
      kind: 'input',
      label: `Shell: ${app.name}`,
      command: `sudo docker exec -it ${app.name} bash || sudo docker exec -it ${app.name} sh`,
    });
  };

  const openLogs = (app: Container) => {
    const server = servers.find((candidate) => candidate.id === app.serverId);
    if (!server) return;
    onOpenTerminal(server, {
      kind: 'input',
      label: `Logs: ${app.name}`,
      command: `sudo docker logs -f ${app.name}`,
    });
  };

  const remove = async (app: Container) => {
    if (!app.serverId) return;
    if (!window.confirm(`Remove ${app.name} on ${app.serverName ?? app.serverId}?`)) return;

    const key = appKey(app);
    setBusyKey(key);
    try {
      await api.deleteContainer(app.serverId, app.name);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not remove ${app.name}.`);
    } finally {
      setBusyKey(null);
    }
  };

  const running = apps.filter((app) => isRunning(app.status)).length;

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <p className="view__sub">
            <span className="num">{visible.length}</span> of{' '}
            <span className="num">{apps.length}</span> containers,{' '}
            <span className="num">{running}</span> running across{' '}
            <span className="num">{servers.length}</span> hosts
          </p>
        </div>
        <div className="view__actions">
          <Button onClick={onDeployTemplate}>
            <LayoutGrid size={13} strokeWidth={1.75} />
            Deploy template
          </Button>
          <IconButton label="Refresh containers" onClick={refresh} disabled={loading}>
            <RefreshCw size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>

      {error && (
        <Banner tone="warn" icon={<AlertTriangle size={13} strokeWidth={1.75} />}>
          {error}
        </Banner>
      )}

      <div className="panel overflow-hidden">
        <div className="panel__head">
          <span className="panel__title">Containers</span>
          <span className="grow" />
          <span className="label">
            {loading ? 'syncing' : `${pluralize(visible.length, 'container')}`}
          </span>
        </div>

        {visible.length === 0 ? (
          <div className="p-3">
            {loading ? (
              <EmptyState title="Loading containers" text="Reading the container list from every host." />
            ) : apps.length === 0 ? (
              <EmptyState
                icon={<Box size={16} strokeWidth={1.75} />}
                title="No containers"
                text="No host in the fleet is running a container. Deploy a template or a Dockerfile to start one."
                action={
                  <Button onClick={onDeployTemplate}>
                    <LayoutGrid size={13} strokeWidth={1.75} />
                    Deploy template
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Box size={16} strokeWidth={1.75} />}
                title="No matches"
                text={`No container matches "${search.trim()}".`}
              />
            )}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Container</th>
                <th>Image</th>
                <th>Host</th>
                <th>Status</th>
                <th>Ports</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((app) => {
                const key = appKey(app);
                const up = isRunning(app.status);
                const url = appUrl(app);

                return (
                  <tr key={key}>
                    <td>
                      <span className="row">
                        <Dot tone={up ? 'ok' : 'idle'} />
                        <span className="mono truncate" title={app.name}>
                          {app.name}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="mono dim truncate" title={app.image}>
                        {app.image}
                      </span>
                    </td>
                    <td>
                      <span className="mono dim truncate" title={app.serverHost}>
                        {app.serverName ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span className={up ? 'mono' : 'mono faint'}>{app.status || '—'}</span>
                    </td>
                    <td>
                      <span className="mono faint truncate" title={app.ports}>
                        {app.ports || 'internal'}
                      </span>
                    </td>
                    <td>
                      <span className="row justify-end">
                        {url && (
                          <Button
                            size="sm"
                            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                          >
                            <ExternalLink size={12} strokeWidth={1.75} />
                            Open
                          </Button>
                        )}
                        <IconButton label={`Shell on ${app.name}`} onClick={() => openShell(app)}>
                          <TerminalIcon size={13} strokeWidth={1.75} />
                        </IconButton>
                        <IconButton label={`Logs for ${app.name}`} onClick={() => openLogs(app)}>
                          <FileText size={13} strokeWidth={1.75} />
                        </IconButton>
                        <IconButton
                          label={`Remove ${app.name}`}
                          danger
                          disabled={busyKey === key}
                          onClick={() => void remove(app)}
                        >
                          <Trash2 size={13} strokeWidth={1.75} />
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
