import { AlertTriangle, Box, FileSearch, Play, Shield, Terminal } from 'lucide-react';
import type { Server } from '../../types';
import { Badge, Banner, Button, KV, Modal, Section } from '../ui';

export function ServerSettingsModal({
  server,
  maintenanceMode,
  onClose,
  onOpenShell,
  onQuickDeploy,
  onVerify,
  onAnalyzeLogs,
  onNuke,
  onDeployDocker,
}: {
  server: Server;
  maintenanceMode: boolean;
  onClose: () => void;
  onOpenShell: () => void;
  onQuickDeploy: () => void;
  onVerify: () => void;
  onAnalyzeLogs: () => void;
  onNuke: () => void;
  onDeployDocker: () => void;
}) {
  return (
    <Modal
      title={server.name}
      subtitle={`${server.username}@${server.host}:${server.port}`}
      onClose={onClose}
      footer={
        <>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="col gap-1">
        <KV
          k="Status"
          v={
            <Badge
              tone={
                server.status === 'online' ? 'ok' : server.status === 'error' ? 'err' : 'muted'
              }
            >
              {server.status}
            </Badge>
          }
        />
        <KV
          k="Docker"
          v={
            <Badge tone={server.installed?.docker ? 'ok' : 'muted'}>
              {server.installed?.docker ? 'Installed' : 'Absent'}
            </Badge>
          }
        />
        <KV k="Host" v={server.host} />
        <KV k="User" v={server.username} />
        <KV k="Port" v={server.port} />
      </div>

      {maintenanceMode && (
        <Banner tone="warn" icon={<AlertTriangle size={12} strokeWidth={1.75} />}>
          Maintenance mode is on. Deploy actions are disabled until it is turned off.
        </Banner>
      )}

      <Section title="Actions">
        <div className="grid grid-cols-2 gap-2">
          <Button block onClick={onOpenShell}>
            <Terminal size={12} strokeWidth={1.75} />
            Open shell
          </Button>
          <Button block onClick={onVerify}>
            <Play size={12} strokeWidth={1.75} />
            Verify stack
          </Button>
          <Button
            block
            variant="primary"
            onClick={onQuickDeploy}
            disabled={maintenanceMode}
            title={
              maintenanceMode
                ? 'Unavailable while maintenance mode is on'
                : 'Install curl and Docker'
            }
          >
            <Play size={12} strokeWidth={1.75} />
            Quick deploy
          </Button>
          <Button block onClick={onAnalyzeLogs}>
            <FileSearch size={12} strokeWidth={1.75} />
            Analyze logs
          </Button>
          <Button block onClick={onDeployDocker}>
            <Box size={12} strokeWidth={1.75} />
            Custom app
          </Button>
          <Button block variant="danger" className="col-span-2" onClick={onNuke}>
            <Shield size={12} strokeWidth={1.75} />
            Nuke server
          </Button>
        </div>
      </Section>
    </Modal>
  );
}
