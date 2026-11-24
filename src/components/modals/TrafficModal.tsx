import { Activity } from 'lucide-react';
import { useMemo } from 'react';
import { Button, EmptyState, KV, Modal, Sparkline } from '../ui';
import { pluralize, rate, uptime } from '../../lib/format';
import { alignedFleetSeries, fleetTotal } from '../../lib/telemetry';
import type { Sample } from '../../types';

function TrafficPanel({
  label,
  current,
  peak,
  values,
  color,
}: {
  label: string;
  current: string;
  peak: string;
  values: number[];
  color: string;
}) {
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{label}</span>
        <span className="grow" />
        <span className="num" style={{ fontSize: 13, fontWeight: 500 }}>
          {current}
        </span>
      </div>
      <div className="panel__body col" style={{ gap: 6 }}>
        <Sparkline values={values} height={64} color={color} fill grid min={0} />
        <KV k="peak" v={peak} muted />
      </div>
    </div>
  );
}

export function TrafficModal({
  history,
  onClose,
}: {
  history: Record<string, Sample[]>;
  onClose: () => void;
}) {
  const data = useMemo(() => {
    const rx = alignedFleetSeries(history, 'rxRate');
    const tx = alignedFleetSeries(history, 'txRate');

    let hosts = 0;
    let samples = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;

    for (const hostHistory of Object.values(history)) {
      if (!hostHistory.length) continue;
      hosts += 1;
      samples = Math.max(samples, hostHistory.length);
      first = Math.min(first, hostHistory[0].ts);
      last = Math.max(last, hostHistory[hostHistory.length - 1].ts);
    }

    const span = Number.isFinite(first) && Number.isFinite(last) && last > first
      ? (last - first) / 1000
      : undefined;

    return {
      rx,
      tx,
      hosts,
      samples,
      span,
      rxNow: fleetTotal(history, 'rxRate'),
      txNow: fleetTotal(history, 'txRate'),
      rxPeak: rx.length ? Math.max(...rx) : undefined,
      txPeak: tx.length ? Math.max(...tx) : undefined,
    };
  }, [history]);

  return (
    <Modal
      title="Fleet traffic"
      subtitle={`Aggregate receive and transmit rates across ${pluralize(data.hosts, 'host')}.`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="modal__foot-spacer" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {data.samples === 0 ? (
        <EmptyState
          icon={<Activity size={14} strokeWidth={1.75} />}
          title="No traffic history"
          text="Charts fill in as telemetry samples arrive. The first sample only sets a baseline; rates appear from the second poll onward."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TrafficPanel
              label="Receive"
              current={rate(data.rxNow)}
              peak={rate(data.rxPeak)}
              values={data.rx}
              color="var(--fg-muted)"
            />
            <TrafficPanel
              label="Transmit"
              current={rate(data.txNow)}
              peak={rate(data.txPeak)}
              values={data.tx}
              color="var(--fg-faint)"
            />
          </div>

          <div className="divider" />

          <div className="grid grid-cols-3 gap-3">
            <KV k="hosts" v={data.hosts} />
            <KV k="samples" v={data.samples} />
            <KV k="window" v={uptime(data.span)} />
          </div>

          <p className="faint" style={{ margin: 0, fontSize: 11, lineHeight: 1.5 }}>
            Rates are derived from consecutive cumulative counters, so a counter reset drops the
            sample instead of reporting a negative rate.
          </p>
        </>
      )}
    </Modal>
  );
}
