import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import { sshSocketUrl } from '../lib/api';
import type { AutoRun, DeployScriptType, Server } from '../types';
import { Dot } from './ui';

/* ── Limits ───────────────────────────────────────────────── */

/** Retained scrollback. Older lines are dropped from the top. */
const MAX_LINES = 2000;
/** A single line longer than this is flushed so the buffer cannot grow without bound. */
const MAX_LINE_CHARS = 4000;

const MIN_WIDTH = 480;
const MIN_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;

/* ── ANSI stripping ───────────────────────────────────────── */

/** OSC: ESC ] … BEL | ESC \ */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** CSI: ESC [ params intermediates final */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Any remaining two-character escape. Never swallows a newline. */
const ANSI_ESC = /\u001b[^\n]/g;
/** C0 controls except tab, newline and carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Turn a raw SSH chunk into plain displayable text.
 *
 * The bridge forwards the remote pty verbatim, so every chunk can carry colour
 * codes, cursor moves and progress-bar carriage returns. All of it is removed
 * here — the panel renders plain text nodes and never interprets markup.
 */
function cleanChunk(raw: string): string {
  return raw
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(CONTROL_CHARS, '');
}

/* ── Buffer ───────────────────────────────────────────────── */

interface TermBuffer {
  /** Completed lines, oldest first. */
  lines: string[];
  /** The line currently being written, without a trailing newline yet. */
  partial: string;
}

function capLines(lines: string[]): string[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}

function appendChunk(buffer: TermBuffer, chunk: string): TermBuffer {
  const parts = (buffer.partial + chunk).split('\n');
  let partial = parts.pop() ?? '';
  let lines = buffer.lines.concat(parts);

  if (partial.length > MAX_LINE_CHARS) {
    lines = lines.concat(partial);
    partial = '';
  }

  return { lines: capLines(lines), partial };
}

/** Write a local notice on its own line, closing any half-written line first. */
function appendNotice(buffer: TermBuffer, text: string): TermBuffer {
  const base = buffer.partial ? buffer.lines.concat(buffer.partial) : buffer.lines;
  return { lines: capLines(base.concat(['', text, ''])), partial: '' };
}

/* ── Socket protocol ──────────────────────────────────────── */

type SocketMessage =
  | { type: 'data'; data: string }
  | { type: 'status'; data: string }
  | { type: 'error'; data: string };

function parseSocketMessage(raw: unknown): SocketMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type, data } = parsed as { type?: unknown; data?: unknown };
  if (type !== 'data' && type !== 'status' && type !== 'error') return null;
  return { type, data: typeof data === 'string' ? data : String(data ?? '') };
}

/* ── Geometry ─────────────────────────────────────────────── */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampRect(rect: Rect): Rect {
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), maxWidth);
  const height = Math.min(Math.max(rect.height, MIN_HEIGHT), maxHeight);
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(rect.y, VIEWPORT_MARGIN), maxY),
  };
}

function initialRect(): Rect {
  const width = Math.min(window.innerWidth - 64, 1000);
  const height = Math.min(window.innerHeight - 64, 700);
  return clampRect({
    width,
    height,
    x: Math.round((window.innerWidth - width) / 2),
    y: Math.round((window.innerHeight - height) / 2),
  });
}

/* ── Deploy actions ───────────────────────────────────────── */

const DEPLOY_ACTIONS: ReadonlyArray<{ scriptType: DeployScriptType; label: string }> = [
  { scriptType: 'docker', label: 'Install Docker' },
  { scriptType: 'full', label: 'Full stack' },
  { scriptType: 'verify', label: 'Verify' },
];

const DEPLOY_NOTICES: Record<DeployScriptType, string> = {
  docker: 'Deploy: install Docker',
  full: 'Deploy: full stack (curl, docker)',
  verify: 'Deploy: verify stack',
};

/** Frames held while the socket is still dialling. */
const MAX_QUEUED_FRAMES = 100;

function statusTone(status: string): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'Connected') return 'ok';
  if (status === 'Failed') return 'err';
  if (status === 'Disconnected') return 'idle';
  return 'warn';
}

/* ── Component ────────────────────────────────────────────── */

export function TerminalOverlay({
  server,
  autoDeploy,
  autoRun,
  maintenanceMode,
  onClose,
}: {
  server: Server;
  autoDeploy: null | 'full';
  autoRun: AutoRun | null;
  maintenanceMode: boolean;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect>(() => initialRect());
  const [buffer, setBuffer] = useState<TermBuffer>(() => ({
    lines: [`ssh ${server.username}@${server.host} -p ${server.port}`],
    partial: '',
  }));
  const [status, setStatus] = useState('Connecting');
  const [input, setInput] = useState('');

  const socketRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seededServerRef = useRef(server.id);
  const autoDeployFired = useRef(false);
  const autoRunFired = useRef(false);

  // The auto-run payloads are read through refs so a prop change never tears
  // down a live session. The socket is bound to the server id alone.
  const autoDeployRef = useRef(autoDeploy);
  autoDeployRef.current = autoDeploy;
  const autoRunRef = useRef(autoRun);
  autoRunRef.current = autoRun;
  const serverRef = useRef(server);
  serverRef.current = server;

  const send = useCallback((payload: unknown) => {
    const frame = JSON.stringify(payload);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
      return;
    }
    // Still dialling: hold the frame and flush it once the shell is up, so a
    // command typed during "Connecting" is not silently lost.
    if (socket && socket.readyState === WebSocket.CONNECTING) {
      if (queueRef.current.length < MAX_QUEUED_FRAMES) queueRef.current.push(frame);
      return;
    }
    setBuffer((prev) => appendNotice(prev, 'Not connected — command not sent.'));
  }, []);

  useEffect(() => {
    const target = serverRef.current;

    if (seededServerRef.current !== target.id) {
      seededServerRef.current = target.id;
      autoDeployFired.current = false;
      autoRunFired.current = false;
      setStatus('Connecting');
      setBuffer({
        lines: [`ssh ${target.username}@${target.host} -p ${target.port}`],
        partial: '',
      });
    }

    const socket = new WebSocket(sshSocketUrl());
    socketRef.current = socket;
    let disposed = false;

    const runAutoTasks = () => {
      if (autoDeployRef.current === 'full' && !autoDeployFired.current) {
        autoDeployFired.current = true;
        setBuffer((prev) => appendNotice(prev, DEPLOY_NOTICES.full));
        send({ type: 'deploy', scriptType: 'full' });
      }

      const run = autoRunRef.current;
      if (!run || autoRunFired.current) return;
      autoRunFired.current = true;
      setBuffer((prev) => appendNotice(prev, `Auto-run: ${run.label}`));

      if (run.kind === 'input') {
        send({ type: 'input', data: `${run.command}\n` });
        return;
      }

      send({
        type: 'deploy',
        scriptType: run.scriptType,
        ...(run.scriptType === 'template' && run.templateConfig !== undefined
          ? { templateConfig: run.templateConfig }
          : {}),
      });
    };

    socket.onopen = () => {
      send({ type: 'connect', serverId: target.id });
    };

    socket.onmessage = (event: MessageEvent) => {
      const message = parseSocketMessage(event.data);
      if (!message) return;

      if (message.type === 'data') {
        setBuffer((prev) => appendChunk(prev, cleanChunk(message.data)));
        return;
      }

      if (message.type === 'status') {
        setStatus(message.data);
        if (message.data === 'Connected') {
          // The server registers the shell before it announces "Connected", so
          // anything held during the dial can go out now.
          const queued = queueRef.current;
          queueRef.current = [];
          for (const frame of queued) socket.send(frame);
          runAutoTasks();
        }
        return;
      }

      setStatus('Failed');
      setBuffer((prev) => appendNotice(prev, `Error: ${cleanChunk(message.data)}`));
    };

    socket.onerror = () => {
      if (disposed) return;
      setStatus('Failed');
    };

    socket.onclose = () => {
      if (disposed) return;
      setStatus((prev) => (prev === 'Failed' ? prev : 'Disconnected'));
    };

    return () => {
      disposed = true;
      queueRef.current = [];
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [server.id, send]);

  // Keep the panel inside the viewport when the window shrinks.
  useEffect(() => {
    const onWindowResize = () => setRect((prev) => clampRect(prev));
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  // Follow the tail of the output.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [buffer]);

  /* ── Dialog behaviour ───────────────────────────────────── */

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active);

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  /* ── Dragging ───────────────────────────────────────────── */

  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.x,
      offsetY: event.clientY - rect.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRect((prev) =>
      clampRect({ ...prev, x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY }),
    );
  };

  const onHeaderPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /* ── Resizing ───────────────────────────────────────────── */

  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);

  const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setRect((prev) =>
      clampRect({
        ...prev,
        width: resize.width + (event.clientX - resize.startX),
        height: resize.height + (event.clientY - resize.startY),
      }),
    );
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /* ── Commands ───────────────────────────────────────────── */

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input) return;
    send({ type: 'input', data: `${input}\n` });
    setInput('');
  };

  const handleDeploy = (scriptType: DeployScriptType) => {
    setBuffer((prev) => appendNotice(prev, DEPLOY_NOTICES[scriptType]));
    send({ type: 'deploy', scriptType });
  };

  return (
    <div className="overlay overlay--top">
      <div
        className="term"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Terminal for ${server.name}`}
        style={{
          // Fixed, not absolute: the geometry below is in viewport coordinates.
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
      >
        <div
          className="term__head"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <Dot tone={statusTone(status)} />
          <span className="term__title min-w-0">
            {server.username}@{server.host} — <b>{status}</b>
          </span>
          <span className="grow" />
          <span className="row shrink-0">
            {DEPLOY_ACTIONS.map((action) => (
              <button
                key={action.scriptType}
                type="button"
                className="btn btn--sm"
                onClick={() => handleDeploy(action.scriptType)}
                disabled={maintenanceMode}
                title={
                  maintenanceMode
                    ? 'Unavailable while maintenance mode is on'
                    : `Run: ${action.label}`
                }
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="btn btn--sm"
              aria-label="Close terminal"
              title="Close terminal"
              onClick={onClose}
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </span>
        </div>

        <div className="term__body" ref={bodyRef}>
          {buffer.lines.map((line, index) => (
            <div className="term__line" key={index}>
              {line}
            </div>
          ))}
          {buffer.partial && <div className="term__line">{buffer.partial}</div>}

          <form className="term__prompt" onSubmit={handleSubmit}>
            <span aria-hidden="true">$</span>
            <input
              className="term__input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Run a command"
              aria-label="Command"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
            />
          </form>
        </div>

        <button
          type="button"
          className="term__resize"
          aria-label="Resize terminal"
          title="Resize terminal"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      </div>
    </div>
  );
}
