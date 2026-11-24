import { useEffect, useId, useRef, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { Server } from '../../types';
import { Badge, Button, Dot, Field, Input, Modal, Segmented, Textarea } from '../ui';

/* ── Templates ────────────────────────────────────────────── */

const DOCKER_TEMPLATES = {
  custom: "FROM ubuntu:latest\nCMD echo 'Hello World'\n",
  nginx: 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n',
  nodejs:
    'FROM node:18-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n',
  python:
    'FROM python:3.10-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\nCOPY . .\nEXPOSE 8000\nCMD ["python", "app.py"]\n',
  nextcloud:
    'FROM nextcloud:apache\n# Disable initial example files (skeleton)\nRUN rm -rf /usr/src/nextcloud/core/skeleton/*\n',
} as const;

type TemplateKey = keyof typeof DOCKER_TEMPLATES;

const TEMPLATE_KEYS: readonly TemplateKey[] = ['custom', 'nginx', 'nodejs', 'python', 'nextcloud'];

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  custom: 'Custom',
  nginx: 'nginx',
  nodejs: 'Node',
  python: 'Python',
  nextcloud: 'Nextcloud',
};

/** Port mapping and container name that suit each template. */
const TEMPLATE_DEFAULTS: Partial<Record<TemplateKey, { portMapping?: string; containerName?: string }>> = {
  nginx: { portMapping: '8080:80' },
  nodejs: { portMapping: '3000:3000' },
  python: { portMapping: '8000:8000' },
  nextcloud: { portMapping: '8080:80', containerName: 'my-nextcloud' },
};

const MAX_LOG_LINES = 400;

type Status = 'idle' | 'deploying' | 'success' | 'error';

const STATUS_TONE: Record<Status, 'muted' | 'warn' | 'ok' | 'err'> = {
  idle: 'muted',
  deploying: 'warn',
  success: 'ok',
  error: 'err',
};

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Ready',
  deploying: 'Running',
  success: 'Finished',
  error: 'Failed',
};

/* ── Component ────────────────────────────────────────────── */

export function DeployDockerfileModal({ server, onClose }: { server: Server; onClose: () => void }) {
  const [template, setTemplate] = useState<TemplateKey>('custom');
  const [dockerfile, setDockerfile] = useState<string>(DOCKER_TEMPLATES.custom);
  const [containerName, setContainerName] = useState('my-app');
  const [portMapping, setPortMapping] = useState('8080:80');
  const [status, setStatus] = useState<Status>('idle');
  const [logs, setLogs] = useState<string[]>([]);

  const nameId = useId();
  const portId = useId();
  const dockerfileId = useId();
  const logRef = useRef<HTMLDivElement>(null);

  const busy = status === 'deploying';

  useEffect(() => {
    const pane = logRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [logs]);

  const pushLog = (...lines: Array<string | undefined>) => {
    const clean = lines.filter((line): line is string => typeof line === 'string');
    if (clean.length === 0) return;
    setLogs((prev) => {
      const next = prev.concat(clean);
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  };

  const handleTemplateChange = (next: TemplateKey) => {
    setTemplate(next);
    setDockerfile(DOCKER_TEMPLATES[next]);
    const defaults = TEMPLATE_DEFAULTS[next];
    if (defaults?.portMapping) setPortMapping(defaults.portMapping);
    if (defaults?.containerName) setContainerName(defaults.containerName);
  };

  const handleDeploy = async () => {
    setStatus('deploying');
    setLogs([`Deploying ${containerName} to ${server.name} (${server.host})`]);

    try {
      const result = await api.deployDockerfile(server.id, {
        dockerfile,
        containerName,
        portMapping,
      });
      if (result.code === 0) {
        setStatus('success');
        pushLog('', 'Build and run finished.', result.output);
      } else {
        setStatus('error');
        pushLog('', `Exit code ${result.code}.`, result.error, result.output);
      }
    } catch (cause) {
      setStatus('error');
      pushLog('', cause instanceof Error ? cause.message : 'Request failed.');
    }
  };

  const handleStop = async () => {
    setStatus('deploying');
    setLogs([`Stopping and removing ${containerName} on ${server.name}`]);

    try {
      const result = await api.stopContainer(server.id, containerName);
      if (result.code === 0) {
        setStatus('success');
        pushLog('', 'Container removed.', result.output);
      } else {
        setStatus('error');
        pushLog('', `Exit code ${result.code}.`, result.error, result.output);
      }
    } catch (cause) {
      setStatus('error');
      pushLog('', cause instanceof Error ? cause.message : 'Request failed.');
    }
  };

  return (
    <Modal
      title="Deploy container"
      subtitle={
        <>
          Build a Dockerfile on <span className="mono">{server.name}</span> ·{' '}
          <span className="mono">{server.host}</span>
        </>
      }
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" onClick={() => void handleStop()} disabled={busy}>
            <Trash2 size={12} strokeWidth={1.75} />
            Stop &amp; remove
          </Button>
          <span className="modal__foot-spacer" />
          <Button onClick={onClose}>{status === 'success' ? 'Done' : 'Cancel'}</Button>
          <Button variant="primary" onClick={() => void handleDeploy()} disabled={busy}>
            <Play size={12} strokeWidth={1.75} />
            {busy ? 'Working' : status === 'error' ? 'Retry deploy' : 'Deploy'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Container name" htmlFor={nameId}>
          <Input
            id={nameId}
            mono
            value={containerName}
            placeholder="my-app"
            onChange={(event) =>
              setContainerName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))
            }
          />
        </Field>
        <Field label="Port mapping" htmlFor={portId} hint="host:container">
          <Input
            id={portId}
            mono
            value={portMapping}
            placeholder="8080:80"
            onChange={(event) => setPortMapping(event.target.value)}
          />
        </Field>
      </div>

      <div className="col gap-2">
        <div className="row row--between">
          <label className="field__label" htmlFor={dockerfileId}>
            Dockerfile
          </label>
          <Segmented
            options={TEMPLATE_KEYS.map((key) => ({ value: key, label: TEMPLATE_LABELS[key] }))}
            value={template}
            onChange={handleTemplateChange}
          />
        </div>
        <Textarea
          id={dockerfileId}
          rows={12}
          value={dockerfile}
          spellCheck={false}
          onChange={(event) => setDockerfile(event.target.value)}
        />
      </div>

      <div className="col gap-2">
        <div className="row">
          <span className="field__label">Output</span>
          <span className="grow" />
          <Dot tone={status === 'error' ? 'err' : status === 'success' ? 'ok' : 'idle'} />
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        </div>
        <div className="pane max-h-56" ref={logRef} role="log" aria-label="Deployment output">
          {logs.length === 0 ? 'No output yet.' : logs.join('\n')}
        </div>
      </div>
    </Modal>
  );
}
