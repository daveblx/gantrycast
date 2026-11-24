import { AlertCircle, FileText } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { Server } from '../../types';
import { Banner, Button, Field, Input, Modal, Segmented, Textarea } from '../ui';

type AuthType = 'password' | 'key';

const AUTH_OPTIONS: ReadonlyArray<{ value: AuthType; label: string }> = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Private key' },
];

export function AddServerModal({
  onAdd,
  onClose,
  defaultPort = 22,
}: {
  onAdd: (data: Partial<Server>) => Promise<void> | void;
  onClose: () => void;
  defaultPort?: number;
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(defaultPort));
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<AuthType>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyFileName, setKeyFileName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readKeyFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setKeyFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setPrivateKey(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsText(file);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;

    const portNumber = Number.parseInt(port, 10);

    if (!name.trim() || !host.trim() || !username.trim()) {
      setError('Name, host and user are required.');
      return;
    }
    if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError('Port must be a number between 1 and 65535.');
      return;
    }
    if (authType === 'password' && !password) {
      setError('Enter the SSH password.');
      return;
    }
    if (authType === 'key' && !privateKey.trim()) {
      setError('Select or paste a private key.');
      return;
    }

    setError(null);
    setPending(true);
    try {
      await onAdd({
        name: name.trim(),
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        password: authType === 'password' ? password : '',
        privateKey: authType === 'key' ? privateKey : '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Add host"
      subtitle="Connect a remote host over SSH."
      onClose={onClose}
      footer={
        <>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={pending}>
            {pending ? 'Adding…' : 'Add host'}
          </Button>
        </>
      }
    >
      <form id={formId} className="col gap-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor={`${uid}-name`}>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="edge-01"
              autoComplete="off"
              required
            />
          </Field>
          <Field label="Host" htmlFor={`${uid}-host`}>
            <Input
              id={`${uid}-host`}
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="10.0.0.4"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="User" htmlFor={`${uid}-user`}>
            <Input
              id={`${uid}-user`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <Field label="Port" htmlFor={`${uid}-port`}>
            <Input
              id={`${uid}-port`}
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              required
            />
          </Field>
        </div>

        <div className="field">
          <span className="field__label" id={`${uid}-auth`}>
            Authentication
          </span>
          <div role="group" aria-labelledby={`${uid}-auth`}>
            <Segmented options={AUTH_OPTIONS} value={authType} onChange={setAuthType} />
          </div>
        </div>

        {authType === 'password' ? (
          <Field label="Password" htmlFor={`${uid}-password`}>
            <Input
              id={`${uid}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : (
          <div className="col gap-2">
            <div className="field">
              <span className="field__label">Key file</span>
              <div className="row gap-2">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <FileText size={12} strokeWidth={1.75} />
                  Choose file
                </Button>
                <span className="mono truncate grow">{keyFileName || 'No file selected'}</span>
                <input
                  ref={fileRef}
                  type="file"
                  className="sr-only"
                  accept=".pem,.key,.pub,.txt,text/plain"
                  onChange={readKeyFile}
                  tabIndex={-1}
                  aria-hidden="true"
                />
              </div>
              <span className="field__hint">RSA and ED25519 keys.</span>
            </div>

            <Field label="Or paste key" htmlFor={`${uid}-key`}>
              <Textarea
                id={`${uid}-key`}
                rows={4}
                value={privateKey}
                onChange={(event) => {
                  setPrivateKey(event.target.value);
                  if (keyFileName) setKeyFileName('');
                }}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        {error && (
          <Banner tone="err" icon={<AlertCircle size={12} strokeWidth={1.75} />}>
            {error}
          </Banner>
        )}
      </form>
    </Modal>
  );
}
