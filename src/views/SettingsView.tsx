import { AlertTriangle, ChevronRight, KeyRound, Moon, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge, Button, Input, Section, Switch } from '../components/ui';
import type { Theme } from '../types';

function SettingRow({
  title,
  description,
  htmlFor,
  control,
}: {
  title: string;
  description: string;
  htmlFor?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="row" style={{ padding: '10px 12px', gap: 16, alignItems: 'center' }}>
      <div className="grow">
        {htmlFor ? (
          <label htmlFor={htmlFor} style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>
            {title}
          </label>
        ) : (
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        )}
        <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          {description}
        </div>
      </div>
      {control}
    </div>
  );
}

export function SettingsView({
  maintenanceMode,
  onToggleMaintenance,
  onOpenKeys,
  theme,
  onToggleTheme,
  autoSync,
  onToggleAutoSync,
  defaultPort,
  onChangeDefaultPort,
}: {
  maintenanceMode: boolean;
  onToggleMaintenance: () => void;
  onOpenKeys: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  autoSync: boolean;
  onToggleAutoSync: () => void;
  defaultPort: number;
  onChangeDefaultPort: (port: number) => void;
}) {
  const portId = useId();
  const [portDraft, setPortDraft] = useState(String(defaultPort));

  const commitPort = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      onChangeDefaultPort(parsed);
      return;
    }
    setPortDraft(String(defaultPort));
  };

  return (
    <div className="view" style={{ maxWidth: 720 }}>
      <div className="view__head">
        <div>
          <p className="view__sub">Control plane defaults, credentials and maintenance state.</p>
        </div>
      </div>

      <Section title="Connection">
        <div className="panel">
          <SettingRow
            title="SSH port default"
            description="Port used when a host is added without an explicit one."
            htmlFor={portId}
            control={
              <Input
                id={portId}
                style={{ width: 88 }}
                mono
                type="number"
                min={1}
                max={65535}
                value={portDraft}
                onChange={(event) => setPortDraft(event.target.value)}
                onBlur={(event) => commitPort(event.target.value)}
              />
            }
          />
          <div className="divider" />
          <SettingRow
            title="Automatic sync"
            description="Refresh host status and telemetry every 30 seconds."
            control={
              <Switch checked={autoSync} onChange={onToggleAutoSync} label="Automatic sync" />
            }
          />
        </div>
      </Section>

      <Section title="Security">
        <div className="panel">
          <SettingRow
            title="Global SSH keys"
            description="Open the key store. Key-based authentication is not wired up yet."
            control={
              <Button onClick={onOpenKeys}>
                <KeyRound size={13} strokeWidth={1.75} />
                Manage
                <ChevronRight size={12} strokeWidth={1.75} />
              </Button>
            }
          />
        </div>
      </Section>

      <Section title="Appearance">
        <div className="panel">
          <SettingRow
            title="Theme"
            description="Stored on this machine and applied to the whole interface."
            control={
              <div className="row" style={{ gap: 8 }}>
                <span className="row faint mono" style={{ gap: 4, fontSize: 11 }}>
                  {theme === 'dark' ? (
                    <Moon size={12} strokeWidth={1.75} />
                  ) : (
                    <Sun size={12} strokeWidth={1.75} />
                  )}
                  {theme}
                </span>
                <Switch
                  checked={theme === 'dark'}
                  onChange={() => onToggleTheme()}
                  label="Dark theme"
                />
              </div>
            }
          />
        </div>
      </Section>

      <Section title="Maintenance">
        <div className="panel">
          <div className="row" style={{ padding: '10px 12px', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle
              size={14}
              strokeWidth={1.75}
              style={{ color: 'var(--warn)', marginTop: 1, flex: '0 0 auto' }}
            />
            <div className="grow">
              <div className="row" style={{ gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Maintenance mode</span>
                <Badge tone={maintenanceMode ? 'warn' : 'muted'}>
                  {maintenanceMode ? 'active' : 'off'}
                </Badge>
              </div>
              <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 2 }}>
                While maintenance mode is on, quick deploy and template deploys are blocked across
                the control plane. Telemetry polling and open terminals keep running.
              </div>
            </div>
            <Switch
              checked={maintenanceMode}
              onChange={onToggleMaintenance}
              label="Maintenance mode"
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
