import { ChevronDown } from 'lucide-react';
import { Children, useState, type ComponentProps, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const FOLD_STORE = 'mh:fold:';

/** Open or closed, remembered per card in this browser (falls back to the default when storage is blocked). */
function useFoldState(id: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(FOLD_STORE + id);
      return saved === null ? initial : saved === '1';
    } catch {
      return initial;
    }
  });
  const change = (next: boolean): void => {
    setOpen(next);
    try {
      window.localStorage.setItem(FOLD_STORE + id, next ? '1' : '0');
    } catch {
      // Storage blocked: the card still opens and closes, it just forgets it.
    }
  };
  return [open, change];
}

interface FoldProps extends ComponentProps<'div'> {
  /** Makes the card fold: its first child (the header) stays, the rest opens and closes. */
  readonly fold?: string;
  /** Open on the first visit (later the viewer's own choice counts). */
  readonly foldOpen?: boolean;
}

function FoldingCard({
  fold,
  foldOpen = false,
  className,
  children,
  ...props
}: FoldProps & { fold: string }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useFoldState(fold, foldOpen);
  const [head, ...body] = Children.toArray(children);
  return (
    <div
      data-slot="card"
      data-open={open}
      className={cn(
        'min-w-0 rounded-[16px] border border-border bg-card text-card-foreground shadow-card',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div
          className="min-w-0 flex-1 cursor-pointer"
          onClick={(e) => {
            // Buttons, links and inputs in the header keep working; the rest of the header toggles.
            if ((e.target as HTMLElement).closest('button, a, input, select, label')) return;
            setOpen(!open);
          }}
        >
          {head}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t('fold.close') : t('fold.open')}
          title={open ? t('fold.close') : t('fold.open')}
          onClick={() => setOpen(!open)}
          className="-mt-1 -mr-1 shrink-0 rounded-[10px] p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className={cn('size-5 transition-transform', open ? 'rotate-180' : '')} aria-hidden />
        </button>
      </div>
      {open ? body : null}
    </div>
  );
}

export function Card({ className, fold, foldOpen, ...props }: FoldProps): ReactElement {
  if (fold) return <FoldingCard fold={fold} foldOpen={foldOpen} className={className} {...props} />;
  return (
    <div
      data-slot="card"
      className={cn(
        'min-w-0 rounded-[16px] border border-border bg-card text-card-foreground shadow-card',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div className={cn('mb-4 flex flex-wrap items-center justify-between gap-3', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>): ReactElement {
  return <h3 className={cn('text-[15px] font-semibold leading-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): ReactElement {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
