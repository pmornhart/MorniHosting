import {
  Checkbox as CheckboxPrimitive,
  Progress as ProgressPrimitive,
  Slider as SliderPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { Check } from 'lucide-react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const FULL = 100;

export function Skeleton({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return <div className={cn('animate-pulse rounded-[10px] bg-muted', className)} {...props} />;
}

export function Progress({
  value,
  className,
  tone = 'primary',
}: {
  value: number;
  className?: string;
  tone?: 'primary' | 'warning';
}): ReactElement {
  return (
    <ProgressPrimitive.Root
      value={value}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          tone === 'warning' ? 'bg-warning' : 'bg-primary',
        )}
        style={{ width: `${Math.max(0, Math.min(FULL, value))}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>): ReactElement {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none select-none items-center py-2', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-5 cursor-grab rounded-full border-2 border-primary bg-background shadow focus-visible:outline-2 focus-visible:outline-ring" />
    </SliderPrimitive.Root>
  );
}

export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>): ReactElement {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-5 shrink-0 cursor-pointer rounded-[6px] border border-input bg-secondary data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tip({ content, children }: { content: ReactNode; children: ReactNode }): ReactElement {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 max-w-72 rounded-[8px] bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-float"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
