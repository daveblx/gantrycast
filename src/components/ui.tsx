import clsx from 'clsx';
import { X } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef } from 'react';

/**
 * Open modals in mount order. Only the topmost one reacts to Escape, otherwise
 * a single keypress tears down a whole stack of dialogs.
 */
const modalStack: symbol[] = [];

/* ── Buttons ──────────────────────────────────────────────── */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export function Button({
  variant = 'default',
  size = 'md',
  block,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}) {
  return (
    <button
      type="button"
      className={clsx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  danger,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={clsx('btn btn--icon', danger && 'btn--danger', className)}
      {...props}
    >
      {children}
    </button>
  );
}

/* ── Form controls ────────────────────────────────────────── */

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('field', className)}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function Input({
  mono,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={clsx('input', mono && 'input--mono', className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx('select', className)} {...props}>
      {children}
    </select>
  );
}

export function Textarea({
  mono = true,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={clsx('textarea', mono && 'textarea--mono', className)} {...props} />;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <div className={clsx('search-wrap', className)}>
      <span className="search-wrap__icon">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </span>
      <input
        className="input input--search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={clsx('check-row', className)}
      style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
    >
      <input
        type="checkbox"
        className="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx('seg', className)} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={clsx('seg__item', option.value === value && 'seg__item--active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={clsx('switch', checked && 'switch--on')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  );
}

/* ── Display primitives ───────────────────────────────────── */

export function Badge({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'err' | 'info' | 'accent';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx('badge', tone !== 'muted' && `badge--${tone}`, className)}>{children}</span>
  );
}

/** Flat status square. Deliberately quiet: no glow, no animation. */
export function Dot({ tone = 'idle' }: { tone?: 'ok' | 'warn' | 'err' | 'idle' }) {
  return <span className={clsx('dot', `dot--${tone}`)} aria-hidden="true" />;
}

export function Meter({
  value,
  tone,
  tall,
}: {
  value: number | undefined;
  tone?: 'ok' | 'warn' | 'err' | 'accent';
  tall?: boolean;
}) {
  const width = value === undefined ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={clsx('meter', tall && 'meter--tall')} role="presentation">
      <div
        className={clsx('meter__fill', tone && `meter__fill--${tone}`)}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function KV({
  k,
  v,
  muted,
  title,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div className="kv">
      <span className="kv__k">{k}</span>
      <span className={clsx('kv__v', muted && 'kv__v--muted')} title={title}>
        {v}
      </span>
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  foot,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  foot?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {foot && <span className="stat__foot">{foot}</span>}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section__head">
        <span className="section__title">{title}</span>
        <span className="section__rule" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Banner({
  tone = 'info',
  icon,
  children,
}: {
  tone?: 'info' | 'warn' | 'err';
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={clsx('banner', `banner--${tone}`)}>
      {icon && <span className="banner__icon">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="empty__icon">{icon}</span>}
      <span className="empty__title">{title}</span>
      {text && <span className="empty__text">{text}</span>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/* ── Modal ────────────────────────────────────────────────── */

export function Modal({
  title,
  subtitle,
  size = 'md',
  onClose,
  footer,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const token = Symbol('modal');
    modalStack.push(token);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (modalStack[modalStack.length - 1] !== token) return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = modalStack.indexOf(token);
      if (index !== -1) modalStack.splice(index, 1);
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button',
    );
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx('modal', size !== 'md' && `modal--${size}`, className)}
      >
        <div className="modal__head">
          <div className="grow">
            <div className="modal__title" id={titleId}>
              {title}
            </div>
            {subtitle && <div className="modal__sub">{subtitle}</div>}
          </div>
          <IconButton label="Close" className="modal__close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ── Sparkline ────────────────────────────────────────────── */

const MAX_POINTS = 240;

/**
 * Reduce a series to at most `MAX_POINTS` buckets, keeping the peak of each
 * bucket so spikes survive. Nulls are preserved as gaps.
 */
function downsample(values: Array<number | null>, limit = MAX_POINTS): Array<number | null> {
  if (values.length <= limit) return values;
  const bucketSize = values.length / limit;
  const out: Array<number | null> = [];
  for (let i = 0; i < limit; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(values.length, Math.floor((i + 1) * bucketSize));
    let peak: number | null = null;
    for (let j = start; j < end; j += 1) {
      const value = values[j];
      if (value === null) continue;
      if (peak === null || Math.abs(value) > Math.abs(peak)) peak = value;
    }
    out.push(peak);
  }
  return out;
}

export function Sparkline({
  values,
  height = 40,
  color = 'var(--fg-muted)',
  fill = false,
  min: minOverride,
  max: maxOverride,
  grid = false,
  className,
}: {
  values: Array<number | null>;
  height?: number;
  color?: string;
  fill?: boolean;
  min?: number;
  max?: number;
  grid?: boolean;
  className?: string;
}) {
  const width = 300;

  const { path, area, flat } = useMemo(() => {
    const points = downsample(values);
    const present: number[] = [];
    for (const value of points) {
      if (value !== null) present.push(value);
    }

    if (!present.length) {
      return { path: '', area: '', flat: true };
    }

    let min = minOverride ?? Math.min(...present);
    let max = maxOverride ?? Math.max(...present);
    if (min === max) {
      // A perfectly flat series still deserves a visible line: centre it.
      min -= 1;
      max += 1;
    }
    const span = max - min || 1;
    const stepX = points.length > 1 ? width / (points.length - 1) : width;

    let d = '';
    let penDown = false;
    let firstX = 0;
    let lastX = 0;

    points.forEach((value, index) => {
      if (value === null) {
        penDown = false;
        return;
      }
      const x = index * stepX;
      const y = height - ((value - min) / span) * height;
      d += `${penDown ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      if (!penDown) {
        firstX = x;
        penDown = true;
      }
      lastX = x;
    });

    const areaPath = d ? `${d}L${lastX.toFixed(2)} ${height}L${firstX.toFixed(2)} ${height}Z` : '';

    return { path: d, area: areaPath, flat: false };
  }, [values, height, minOverride, maxOverride]);

  if (flat) {
    return (
      <svg
        className={clsx('spark', className)}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        aria-hidden="true"
      >
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--line-strong)"
          strokeWidth="1"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  return (
    <svg
      className={clsx('spark', className)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden="true"
    >
      {grid && (
        <>
          <line className="spark__grid" x1="0" y1={height / 2} x2={width} y2={height / 2} />
          <line className="spark__grid" x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} />
        </>
      )}
      {fill && <path className="spark__area" d={area} fill={color} />}
      <path className="spark__line" d={path} stroke={color} />
    </svg>
  );
}
