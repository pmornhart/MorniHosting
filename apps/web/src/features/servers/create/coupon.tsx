import { Ticket, X } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confetti } from '@/lib/confetti';
import { cn } from '@/lib/utils';

/**
 * Easter egg: the order summary takes a voucher code. Servers are free – but "MORNI" makes it 9.999,99 € a
 * month. Only the display changes; nothing is ever charged or stored.
 */
const SECRET = 'MORNI';

export function PriceWithCoupon(): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState(false);
  const [wrong, setWrong] = useState(false);
  const redeem = (): void => {
    const code = draft.trim().toUpperCase();
    if (!code) return;
    const hit = code === SECRET;
    setApplied(hit);
    setWrong(!hit);
    if (hit) confetti();
  };
  // Enter must redeem the code, not send the whole order form.
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    redeem();
  };
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('order.price')}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {applied ? (
          <span className="text-lg font-bold text-muted-foreground line-through">0,00 €</span>
        ) : null}
        <span
          key={String(applied)}
          className={cn('text-3xl font-extrabold', applied && 'mh-jackpot text-warning')}
        >
          {applied ? '9.999,99 €' : '0,00 €'}
        </span>
        <span className="text-base font-semibold text-muted-foreground">/ {t('order.month')}</span>
      </div>
      {applied ? (
        <div className="flex items-start gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-[13px]">
          <Ticket className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">
            <b className="block">{t('order.coupon.appliedTitle')}</b>
            {t('order.coupon.appliedText')}
          </span>
          <button
            type="button"
            className="rounded-md p-0.5 hover:bg-background/60"
            aria-label={t('order.coupon.remove')}
            onClick={() => {
              setApplied(false);
              setDraft('');
            }}
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <div className="grid gap-1">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setWrong(false);
              }}
              onKeyDown={onKey}
              placeholder={t('order.coupon.placeholder')}
              aria-label={t('order.coupon.label')}
              className="h-9"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="button" variant="outline" className="h-9" onClick={redeem} disabled={!draft.trim()}>
              {t('order.coupon.redeem')}
            </Button>
          </div>
          {wrong ? <span className="text-[12px] text-destructive">{t('order.coupon.unknown')}</span> : null}
        </div>
      )}
    </div>
  );
}
