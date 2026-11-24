import { useId, useState } from 'react';
import {
  DEFAULT_THRESHOLDS,
  METRIC_LABELS,
  THRESHOLD_METRICS,
  cloneThresholds,
} from '../../lib/alerts';
import type { ThresholdMetric, Thresholds } from '../../lib/alerts';
import type { Server } from '../../types';
import { Banner, Button, Field, Input, Modal, Section } from '../ui';

type Draft = Record<ThresholdMetric, { warn: string; critical: string }>;

function toDraft(thresholds: Thresholds): Draft {
  return {
    cpu: { warn: String(thresholds.cpu.warn), critical: String(thresholds.cpu.critical) },
    ram: { warn: String(thresholds.ram.warn), critical: String(thresholds.ram.critical) },
    disk: { warn: String(thresholds.disk.warn), critical: String(thresholds.disk.critical) },
  };
}

/** Parse the draft, or explain why it cannot be saved. */
function parseDraft(draft: Draft): { thresholds: Thresholds } | { error: string } {
  const thresholds = cloneThresholds(DEFAULT_THRESHOLDS);

  for (const metric of THRESHOLD_METRICS) {
    const warn = Number.parseFloat(draft[metric].warn);
    const critical = Number.parseFloat(draft[metric].critical);
    const label = METRIC_LABELS[metric];

    if (!Number.isFinite(warn) || !Number.isFinite(critical)) {
      return { error: `${label}: enter a number for both levels.` };
    }
    if (warn < 1 || warn > 100 || critical < 1 || critical > 100) {
      return { error: `${label}: levels must be between 1 and 100.` };
    }
    if (warn >= critical) {
      return { error: `${label}: the warn level must be below the critical level.` };
    }

    thresholds[metric] = { warn, critical };
  }

  return { thresholds };
}

/**
 * Per-host alert thresholds. Purely client-side: saving writes the map to
 * localStorage through the caller, nothing is sent to the backend.
 */
export function AlertThresholdsModal({
  server,
  thresholds,
  onSave,
  onClose,
}: {
  server: Server;
  thresholds: Thresholds;
  onSave: (thresholds: Thresholds) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(thresholds));
  const [error, setError] = useState<string | null>(null);

  const update = (metric: ThresholdMetric, level: 'warn' | 'critical', value: string) => {
    setDraft((prev) => ({ ...prev, [metric]: { ...prev[metric], [level]: value } }));
    setError(null);
  };

  const save = () => {
    const parsed = parseDraft(draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    onSave(parsed.thresholds);
  };

  const reset = () => {
    setDraft(toDraft(DEFAULT_THRESHOLDS));
    setError(null);
  };

  return (
    <Modal
      title="Alert thresholds"
      subtitle={`${server.name} · ${server.host}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={reset}>
            Reset
          </Button>
          <div className="modal__foot-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="col gap-3">
        <span className="field__hint">
          Utilisation percentages. A reading at or above the warn level raises a warning; at or
          above the critical level it raises a critical alert.
        </span>

        {THRESHOLD_METRICS.map((metric) => (
          <Section key={metric} title={METRIC_LABELS[metric]}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Warn %" htmlFor={`${uid}-${metric}-warn`}>
                <Input
                  id={`${uid}-${metric}-warn`}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={draft[metric].warn}
                  onChange={(event) => update(metric, 'warn', event.target.value)}
                />
              </Field>
              <Field label="Critical %" htmlFor={`${uid}-${metric}-critical`}>
                <Input
                  id={`${uid}-${metric}-critical`}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={draft[metric].critical}
                  onChange={(event) => update(metric, 'critical', event.target.value)}
                />
              </Field>
            </div>
          </Section>
        ))}

        {error && <Banner tone="err">{error}</Banner>}
      </div>
    </Modal>
  );
}
