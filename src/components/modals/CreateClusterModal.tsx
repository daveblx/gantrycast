import { useId, useState } from 'react';
import { Button, Checkbox, Dot, Field, Input, Modal } from '../ui';
import { pluralize } from '../../lib/format';
import type { ClusterState, Server } from '../../types';

function statusTone(status: Server['status']): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'online') return 'ok';
  if (status === 'error') return 'err';
  return 'idle';
}

export function CreateClusterModal({
  servers,
  onCreate,
  onClose,
}: {
  servers: Server[];
  onCreate: (data: Partial<ClusterState>) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const trimmed = name.trim();
  const allSelected = servers.length > 0 && selected.length === servers.length;

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    onCreate({ name: trimmed, serverIds: selected });
  };

  return (
    <Modal
      title="Create cluster"
      subtitle="Group hosts so they can be deployed to and simulated together."
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 11 }}>
            {selected.length} of {servers.length} selected
          </span>
          <span className="modal__foot-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={!trimmed}>
            Create cluster
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={submit}
        className="col"
        style={{ gap: 12, minWidth: 0 }}
        noValidate
      >
        <Field label="Cluster name" htmlFor={nameId} hint="Shown in the cluster list and the simulation overlay.">
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="edge-eu"
            autoComplete="off"
            required
          />
        </Field>

        <div className="field">
          <div className="row row--between">
            <span className="field__label">Nodes</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={servers.length === 0}
              onClick={() => setSelected(allSelected ? [] : servers.map((server) => server.id))}
            >
              {allSelected ? 'Clear' : 'Select all'}
            </Button>
          </div>

          <div
            className="scroll"
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r)',
              background: 'var(--surface-2)',
              padding: 4,
            }}
          >
            {servers.length === 0 ? (
              <div className="faint" style={{ padding: '10px 8px', fontSize: 11.5 }}>
                No hosts yet. Add a host before creating a cluster.
              </div>
            ) : (
              servers.map((server) => (
                <Checkbox
                  key={server.id}
                  checked={selected.includes(server.id)}
                  onChange={() => toggle(server.id)}
                  label={
                    <span className="row grow" style={{ gap: 8 }}>
                      <span className="truncate">{server.name}</span>
                      <span className="mono faint truncate" style={{ fontSize: 10.5 }}>
                        {server.username}@{server.host}
                      </span>
                      <span className="grow" />
                      <Dot tone={statusTone(server.status)} />
                    </span>
                  }
                />
              ))
            )}
          </div>

          <span className="field__hint">
            {selected.length === 0
              ? 'No nodes selected. The cluster can be filled in later.'
              : `${pluralize(selected.length, 'node')} will join this cluster.`}
          </span>
        </div>
      </form>
    </Modal>
  );
}
