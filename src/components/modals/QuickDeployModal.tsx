import { useId } from 'react';
import type { Server } from '../../types';
import { Button, Field, KV, Modal, Section, Select } from '../ui';

const STEPS = ['Install curl', 'Install Docker'];

export function QuickDeployModal({
  servers,
  selectedServerId,
  onChangeSelected,
  onStart,
  onClose,
}: {
  servers: Server[];
  selectedServerId: string;
  onChangeSelected: (id: string) => void;
  onStart: () => void;
  onClose: () => void;
}) {
  const uid = useId();
  const selected = servers.find((server) => server.id === selectedServerId);

  return (
    <Modal
      title="Quick deploy"
      subtitle="Connect over SSH, then install curl and Docker."
      onClose={onClose}
      footer={
        <>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onStart} disabled={!selected}>
            Start auto deploy
          </Button>
        </>
      }
    >
      <Field label="Target host" htmlFor={`${uid}-target`}>
        <Select
          id={`${uid}-target`}
          value={selectedServerId}
          onChange={(event) => onChangeSelected(event.target.value)}
          disabled={servers.length === 0}
        >
          <option value="">{servers.length === 0 ? 'No hosts available' : 'Select a host'}</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name} ({server.username}@{server.host})
            </option>
          ))}
        </Select>
      </Field>

      {selected && (
        <div className="col gap-1">
          <KV k="Host" v={selected.host} />
          <KV k="User" v={selected.username} />
          <KV k="Port" v={selected.port} />
          <KV k="Status" v={selected.status} />
        </div>
      )}

      <Section title="Sequence">
        <div className="col gap-1">
          {STEPS.map((step, index) => (
            <div className="row gap-2" key={step}>
              <span className="label">{String(index + 1).padStart(2, '0')}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      </Section>
    </Modal>
  );
}
