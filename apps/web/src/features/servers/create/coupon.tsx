import { useMutation } from '@tanstack/react-query';
import { Ticket, X } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { formatEuro, type CouponCheck } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { confetti } from '@/lib/confetti';
import { cn } from '@/lib/utils';

/**
 * Voucher field in the order summary. Servers are free – but the code "MORNI" (any case) makes the order cost
 * 9.999,99 € a month, owed to the panel's owner. The panel checks the code and records it with the server;
 * paying happens between the people, the owner ticks off paid months in the admin area.
 */
export function PriceWithCoupon({ onChange }: { onChange: (code: string | null) => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState<CouponCheck | null>(null);
  const check = useMutation({
    mutationFn: (code: string) => api<CouponCheck>('/api/coupons/check', { method: 'POST', body: { code } }),
    onSuccess: (found) => {
      setApplied(found);
      onChange(found.code);
      confetti();
    },
    onError: () => undefined,
  });
  const redeem = (): void => {
    if (draft.trim()) check.mutate(draft.trim());
  };
  // Enter must redeem the code, not send the whole order form.
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    redeem();
  };
  const locale = i18n.resolvedLanguage === 'en' ? 'en-GB' : 'de-DE';
  const price = applied ? formatEuro(applied.monthlyCents, locale) : formatEuro(0, locale);
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('order.price')}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {applied ? (
          <span className="text-lg font-bold text-muted-foreground line-through">
            {formatEuro(0, locale)}
          </span>
        ) : null}
        <span
          key={applied?.code ?? 'free'}
          className={cn('text-3xl font-extrabold', applied && 'mh-jackpot text-warning')}
        >
          {price}
        </span>
        <span className="text-base font-semibold text-muted-foreground">/ {t('order.month')}</span>
      </div>
      {applied ? (
        <div className="flex items-start gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-[13px]">
          <Ticket className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">
            <b className="block">{t('order.coupon.appliedTitle', { code: applied.code })}</b>
            {t('order.coupon.appliedText', { price, payee: applied.payee })}
          </span>
          <button
            type="button"
            className="rounded-md p-0.5 hover:bg-background/60"
            aria-label={t('order.coupon.remove')}
            onClick={() => {
              setApplied(null);
              setDraft('');
              onChange(null);
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
                check.reset();
              }}
              onKeyDown={onKey}
              placeholder={t('order.coupon.placeholder')}
              aria-label={t('order.coupon.label')}
              className="h-9"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9"
              onClick={redeem}
              disabled={!draft.trim() || check.isPending}
            >
              {t('order.coupon.redeem')}
            </Button>
          </div>
          {check.isError ? (
            <span className="text-[12px] text-destructive">{t('order.coupon.unknown')}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
