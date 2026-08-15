/** Small shared primitives. Intentionally not a component library. */

import type { ReactNode } from 'react';

export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('panel', className)}>{children}</section>;
}

export function SectionHeading({
  eyebrow,
  title,
  aside,
}: {
  eyebrow: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-ink-faint">{eyebrow}</p>
        <h2 className="mt-1.5 text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      {aside}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-line bg-white/5 text-ink-muted',
  good: 'border-signal-500/30 bg-signal-500/10 text-signal-500',
  warn: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  bad: 'border-ember-500/35 bg-ember-500/10 text-ember-500',
  accent: 'border-forge-500/35 bg-forge-500/12 text-forge-400',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.7rem] font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const color =
    tone === 'good'
      ? 'bg-signal-500'
      : tone === 'bad'
        ? 'bg-ember-500'
        : tone === 'warn'
          ? 'bg-amber-300'
          : tone === 'accent'
            ? 'bg-forge-400'
            : 'bg-ink-faint';
  return <span className={cx('size-1.5 rounded-full', color)} aria-hidden />;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'group relative inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3',
        'text-sm font-semibold tracking-tight text-white transition',
        'bg-gradient-to-r from-forge-500 to-forge-400',
        'shadow-[0_10px_30px_-12px_rgba(124,92,255,0.9)]',
        'hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forge-400',
        'disabled:cursor-not-allowed disabled:from-white/10 disabled:to-white/10 disabled:text-ink-faint disabled:shadow-none',
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-4 py-3',
        'text-sm font-medium text-ink-muted transition hover:border-forge-500/40 hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forge-400',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className={cx(
          'h-full rounded-full bg-gradient-to-r from-forge-500 via-forge-400 to-signal-500 transition-[width] duration-500',
          indeterminate && 'animate-pulse',
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
