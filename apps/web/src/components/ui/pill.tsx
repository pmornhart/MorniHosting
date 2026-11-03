import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils';

export type PillTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent';

const TONES: Readonly<Record<PillTone, string>> = {
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-destructive-soft text-destructive',
  neutral: 'bg-neutral-soft text-muted-foreground',
  accent: 'bg-accent text-foreground',
};

export function Pill({
  tone = 'neutral',
  dot = true,
  className,
  children,
  ping = false,
  ...props
}: ComponentProps<'span'> & { tone?: PillTone; dot?: boolean; ping?: boolean }): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold leading-none',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden className={cn('size-[7px] rounded-full bg-current', ping && 'mh-ping')} />
      ) : null}
      {children}
    </span>
  );
}

export function Tag({ className, ...props }: ComponentProps<'span'>): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border bg-secondary px-1.5 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
