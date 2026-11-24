import { Terminal } from 'lucide-react';
import { pluralize } from '../lib/format';
import type { Server } from '../types';
import { Button, Dot, EmptyState } from '../components/ui';

function statusTone(status: Server['status']): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'online') return 'ok';
  if (status === 'error') return 'err';
  return 'idle';
}

/** `.table thead th` sets text-align: left, so numeric headers need it inline. */
const NUM_HEAD = { textAlign: 'right' } as const;

export function TerminalsView({
  servers,
  onOpenTerminal,
}: {
  servers: Server[];
  onOpenTerminal: (server: Server) => void;
}) {
  return (
    <div className="view">
      <div className="view__head">
        <div>
          <p className="view__sub">
            {pluralize(servers.length, 'host')} available for an SSH session.
          </p>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={<Terminal size={18} strokeWidth={1.75} />}
          title="No hosts to connect to"
          text="Add a host from the fleet view, then open a shell against it here."
        />
      ) : (
        <div className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Host</th>
                <th>Status</th>
                <th style={NUM_HEAD}>Action</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td>{server.name}</td>
                  <td className="mono">
                    {server.username}@{server.host}:{server.port}
                  </td>
                  <td>
                    <span className="row">
                      <Dot tone={statusTone(server.status)} />
                      {server.status}
                    </span>
                  </td>
                  <td className="table__num">
                    <Button size="sm" onClick={() => onOpenTerminal(server)}>
                      <Terminal size={12} strokeWidth={1.75} />
                      Open shell
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
