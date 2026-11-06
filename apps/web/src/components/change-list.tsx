import { Bug, Minus, Plus, Sparkles, Wrench } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CHANGE_KINDS, type ChangeKind, type UpdateChange } from '@mornihosting/shared';
import { formatRelative } from '@/lib/format';

const KIND_LOOK: Readonly<Record<ChangeKind, { readonly icon: ReactNode; readonly tone: string }>> = {
  new: { icon: <Plus className="size-3" aria-hidden />, tone: 'bg-primary/15 text-primary' },
  fixed: { icon: <Bug className="size-3" aria-hidden />, tone: 'bg-sky-500/15 text-sky-500' },
  improved: { icon: <Sparkles className="size-3" aria-hidden />, tone: 'bg-amber-500/15 text-amber-500' },
  removed: { icon: <Minus className="size-3" aria-hidden />, tone: 'bg-destructive/15 text-destructive' },
  other: { icon: <Wrench className="size-3" aria-hidden />, tone: 'bg-secondary text-muted-foreground' },
};

/** One update in detail: its title, then what is new, what was fixed, improved and removed. */
function ChangeEntry({ change, newest }: { change: UpdateChange; newest: boolean }): ReactElement {
  const { t } = useTranslation();
  const groups = CHANGE_KINDS.map((kind) => ({
    kind,
    items: change.items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length);
  return (
    <li className="grid gap-2 rounded-[12px] border border-border bg-card p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={
            newest
              ? 'mt-1.5 size-2 shrink-0 rounded-full bg-primary'
              : 'mt-1.5 size-2 shrink-0 rounded-full bg-border'
          }
        />
        <b className="min-w-0 flex-1 text-sm">{change.title}</b>
        {change.date ? (
          <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(change.date)}</span>
        ) : null}
      </div>
      {groups.map((group) => (
        <div key={group.kind} className="grid gap-1 pl-4">
          <span
            className={`flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${KIND_LOOK[group.kind].tone}`}
          >
            {KIND_LOOK[group.kind].icon}
            {t(`changeKinds.${group.kind}`)}
          </span>
          <ul className="grid gap-0.5 pl-1">
            {group.items.map((item) => (
              <li key={item.text} className="flex gap-2 text-[13px] text-muted-foreground">
                <span aria-hidden>•</span>
                <span className="min-w-0">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </li>
  );
}

/** The updates, newest first, each with its details. */
export function ChangeList({ changes }: { changes: readonly UpdateChange[] }): ReactElement {
  return (
    <ul className="grid gap-2">
      {changes.map((change, i) => (
        <ChangeEntry key={change.sha} change={change} newest={i === 0} />
      ))}
    </ul>
  );
}
