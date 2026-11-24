import { AlertTriangle, Shield } from 'lucide-react';
import { useId, useState } from 'react';
import type { Server } from '../../types';
import { Badge, Banner, Button, Dot, Field, Input, KV, Modal } from '../ui';

export function NuclearWarningModal({
  server,
  onConfirm,
  onClose,
}: {
  server: Server;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      size="sm"
      title="Destructive action"
      subtitle={`${server.name} · ${server.host}`}
      onClose={onClose}
      footer={
        <>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Continue
          </Button>
        </>
      }
    >
      <Banner tone="warn" icon={<AlertTriangle size={12} strokeWidth={1.75} />}>
        This uninstalls Docker and every container on the host. Containers and volumes are removed
        with them.
      </Banner>

      <div className="col gap-1">
        <KV k="Host" v={server.host} />
        <KV k="User" v={server.username} />
        <KV
          k="Docker"
          v={
            <Badge tone={server.installed?.docker ? 'ok' : 'muted'}>
              {server.installed?.docker ? 'Installed' : 'Absent'}
            </Badge>
          }
        />
      </div>
    </Modal>
  );
}

export function NuclearConfirmModal({
  server,
  isDestroying,
  onConfirm,
  onClose,
}: {
  server: Server;
  isDestroying: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const uid = useId();
  const [typedHost, setTypedHost] = useState('');

  const matches = typedHost.trim() === server.host;

  return (
    <Modal
      size="sm"
      title="Confirm destruction"
      subtitle={`${server.name} · ${server.host}`}
      onClose={() => {
        if (!isDestroying) onClose();
      }}
      footer={
        <>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose} disabled={isDestroying}>
            Abort
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!matches || isDestroying}>
            {isDestroying ? 'Destroying…' : 'Confirm destruction'}
          </Button>
        </>
      }
    >
      <Banner tone="err" icon={<Shield size={12} strokeWidth={1.75} />}>
        This cannot be undone. The host keeps running, but everything GantryCast installed on it is
        removed.
      </Banner>

      <Field label="Type the host to confirm" htmlFor={`${uid}-host`} hint={server.host}>
        <Input
          id={`${uid}-host`}
          mono
          value={typedHost}
          onChange={(event) => setTypedHost(event.target.value)}
          placeholder={server.host}
          autoComplete="off"
          spellCheck={false}
          disabled={isDestroying}
        />
      </Field>

      {isDestroying && (
        <div className="row gap-2">
          <Dot tone="err" />
          <span className="mono">Running teardown on {server.host}. Do not close this window.</span>
        </div>
      )}
    </Modal>
  );
}
