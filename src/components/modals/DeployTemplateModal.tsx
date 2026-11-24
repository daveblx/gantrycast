import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Play, Shield } from 'lucide-react';
import { api } from '../../lib/api';
import type { Server } from '../../types';
import { Banner, Button, Checkbox, Field, Input, Modal, Section, Select } from '../ui';

/* ── Config shape ─────────────────────────────────────────── */

/**
 * Mirrors the server-side template config. Declared locally so the renderer
 * never imports the SSH deployment module.
 */
interface TemplateConfig {
  domain: string;
  email: string;
  duckdnsToken?: string;
  profiles: string[];
  cloudflare?: { apiToken: string; zoneId: string };
  authelia?: { jwtSecret: string; sessionSecret: string; storageKey: string };
  services?: Record<string, Record<string, string>>;
}

/**
 * The profiles this deploy can start, with the compose services each one
 * brings. Profile ids are passed straight through to `COMPOSE_PROFILES`, so
 * they must match a profile that exists after the template is prepared — a
 * name nothing defines starts nothing.
 *
 * The deploy clones Viren070/docker-compose-template and prunes it down to
 * exactly these apps, so this list is the full extent of what the template
 * can start.
 */
interface ProfileSpec {
  id: string;
  label: string;
  summary: string;
  services: readonly string[];
  locked?: boolean;
}

const PROFILES: readonly ProfileSpec[] = [
  {
    id: 'required',
    label: 'Traefik + Authelia',
    summary: 'Reverse proxy with wildcard TLS, plus the SSO portal in front of every other app.',
    services: ['traefik', 'authelia', 'authelia_postgres', 'authelia_redis'],
    locked: true,
  },
  {
    id: 'vaultwarden',
    label: 'Vaultwarden',
    summary: 'Bitwarden-compatible password vault.',
    services: ['vaultwarden'],
  },
  {
    id: 'immich',
    label: 'Immich',
    summary: 'Photo and video library with machine-learning search.',
    services: ['immich', 'immich_machine-learning', 'immich_postgres', 'immich_redis'],
  },
  {
    id: 'beszel',
    label: 'Beszel',
    summary: 'Host and container metrics with a web dashboard.',
    services: ['beszel', 'beszel_agent'],
  },
];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeConfig(raw: Record<string, unknown>): TemplateConfig {
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!profiles.includes('required')) profiles.unshift('required');

  const cloudflare = asRecord(raw.cloudflare);
  const authelia = asRecord(raw.authelia);
  const servicesRaw = asRecord(raw.services);

  const services: Record<string, Record<string, string>> = {};
  if (servicesRaw) {
    for (const [key, value] of Object.entries(servicesRaw)) {
      const entry = asRecord(value);
      if (!entry) continue;
      const flat: Record<string, string> = {};
      for (const [innerKey, innerValue] of Object.entries(entry)) {
        if (typeof innerValue === 'string') flat[innerKey] = innerValue;
      }
      services[key] = flat;
    }
  }

  return {
    domain: asString(raw.domain),
    email: asString(raw.email),
    duckdnsToken: asString(raw.duckdnsToken),
    profiles,
    cloudflare: {
      apiToken: asString(cloudflare?.apiToken),
      zoneId: asString(cloudflare?.zoneId),
    },
    authelia: authelia
      ? {
          jwtSecret: asString(authelia.jwtSecret),
          sessionSecret: asString(authelia.sessionSecret),
          storageKey: asString(authelia.storageKey),
        }
      : undefined,
    services: Object.keys(services).length > 0 ? services : undefined,
  };
}

/* ── Component ────────────────────────────────────────────── */

export function DeployTemplateModal({
  servers,
  onClose,
  onStart,
}: {
  servers: Server[];
  onClose: () => void;
  onStart: (server: Server, config: unknown) => void;
}) {
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [selectedServerId, setSelectedServerId] = useState(() => servers[0]?.id ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The fleet can still be loading when this opens, and the chosen host can be
  // removed while it is open. Keep the selection pointing at a real host.
  useEffect(() => {
    if (servers.some((candidate) => candidate.id === selectedServerId)) return;
    setSelectedServerId(servers[0]?.id ?? '');
  }, [servers, selectedServerId]);

  const serverId = useId();
  const domainId = useId();
  const emailId = useId();
  const tokenId = useId();
  const zoneId = useId();

  useEffect(() => {
    let cancelled = false;

    api
      .templateDefaults()
      .then((raw) => {
        if (cancelled) return;
        setConfig(normalizeConfig(raw));
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load template defaults.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (changes: Partial<TemplateConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...changes } : prev));
  };

  const toggleProfile = (id: string) => {
    if (id === 'required') return;
    setConfig((prev) => {
      if (!prev) return prev;
      const profiles = prev.profiles.includes(id)
        ? prev.profiles.filter((entry) => entry !== id)
        : [...prev.profiles, id];
      return { ...prev, profiles };
    });
  };

  const handleStart = () => {
    const server = servers.find((candidate) => candidate.id === selectedServerId);
    if (!server || !config) return;
    onStart(server, config);
  };

  const ready = config !== null && selectedServerId !== '';

  const selectedProfiles = PROFILES.filter((profile) => config?.profiles.includes(profile.id));
  const serviceCount = selectedProfiles.reduce((total, profile) => total + profile.services.length, 0);

  return (
    <Modal
      title="Deploy VPS template"
      subtitle="Docker Compose stack with Traefik and Authelia"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="modal__foot-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleStart} disabled={!ready}>
            <Play size={12} strokeWidth={1.75} />
            Start deploy
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="err" icon={<AlertTriangle size={13} strokeWidth={1.75} />}>
          {error}
        </Banner>
      )}

      {loading && <p className="dim">Loading template defaults…</p>}

      {config && (
        <>
          <Field label="Target host" htmlFor={serverId}>
            <Select
              id={serverId}
              value={selectedServerId}
              onChange={(event) => setSelectedServerId(event.target.value)}
            >
              {servers.length === 0 && <option value="">No hosts</option>}
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} ({server.host})
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Primary domain" htmlFor={domainId} hint="Traefik routes every service under it">
              <Input
                id={domainId}
                mono
                value={config.domain}
                placeholder="apps.example.com"
                onChange={(event) => patch({ domain: event.target.value })}
              />
            </Field>

            <Field label="ACME email" htmlFor={emailId} hint="Used for Let's Encrypt registration">
              <Input
                id={emailId}
                mono
                type="email"
                value={config.email}
                placeholder="admin@example.com"
                onChange={(event) => patch({ email: event.target.value })}
              />
            </Field>

            <Field label="Cloudflare API token" htmlFor={tokenId} hint="DNS-01 challenge for wildcard certificates">
              <Input
                id={tokenId}
                mono
                type="password"
                value={config.cloudflare?.apiToken ?? ''}
                placeholder="Token"
                autoComplete="off"
                onChange={(event) =>
                  patch({
                    cloudflare: {
                      apiToken: event.target.value,
                      zoneId: config.cloudflare?.zoneId ?? '',
                    },
                  })
                }
              />
            </Field>

            <Field label="Cloudflare zone ID" htmlFor={zoneId} hint="Zone that holds the wildcard record">
              <Input
                id={zoneId}
                mono
                value={config.cloudflare?.zoneId ?? ''}
                placeholder="Zone ID"
                autoComplete="off"
                onChange={(event) =>
                  patch({
                    cloudflare: {
                      apiToken: config.cloudflare?.apiToken ?? '',
                      zoneId: event.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>

          <Section
            title="What gets deployed"
            actions={
              <span className="field__hint">
                <span className="num">{selectedProfiles.length}</span> of{' '}
                <span className="num">{PROFILES.length}</span> profiles ·{' '}
                <span className="num">{serviceCount}</span> services
              </span>
            }
          >
            <div className="panel">
              <div className="panel__body col gap-1">
                {PROFILES.map((profile) => (
                  <Checkbox
                    key={profile.id}
                    className="check-row--block"
                    checked={config.profiles.includes(profile.id)}
                    disabled={profile.locked}
                    onChange={() => toggleProfile(profile.id)}
                    label={
                      <span className="col gap-1 grow">
                        <span className="row">
                          <span>{profile.label}</span>
                          {profile.locked && <span className="label">always on</span>}
                          <span className="grow" />
                          <span className="label">
                            {profile.services.length} {profile.services.length === 1 ? 'service' : 'services'}
                          </span>
                        </span>
                        <span className="field__hint">{profile.summary}</span>
                        <span className="profile-services">{profile.services.join(' · ')}</span>
                      </span>
                    }
                  />
                ))}
              </div>
            </div>
            <span className="field__hint">
              Only ticked profiles start. Every other app is pruned from the cloned template before it runs.
            </span>
          </Section>

          <Banner tone="info" icon={<Shield size={13} strokeWidth={1.75} />}>
            Authelia JWT, session and storage secrets are generated per deploy and never reused.
          </Banner>
        </>
      )}
    </Modal>
  );
}
