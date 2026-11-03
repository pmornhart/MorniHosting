import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDollarSign, Clock } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { formatEuro, type PaymentsView } from '@mornihosting/shared';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const key = ['payments'] as const;

/** "2026-11" → "November 2026". */
function monthName(month: string, locale: string): string {
  const [year = 0, m = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/** Admin → Zahlungen: who owes what for servers ordered with a paid voucher, and which months are paid. */
export function PaymentsSection(): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === 'en' ? 'en-GB' : 'de-DE';
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: key, queryFn: () => api<PaymentsView>('/api/payments') });
  const mark = useMutation({
    mutationFn: (input: { id: number; month: string; paid: boolean }) =>
      api<PaymentsView>(`/api/payments/${input.id}`, {
        method: 'PUT',
        body: { month: input.month, paid: input.paid },
      }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  if (!data) return <Skeleton className="h-48 rounded-[16px]" />;
  const euro = (cents: number) => formatEuro(cents, locale);
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="flex items-center gap-3 p-5">
          <Clock className="size-8 text-warning" aria-hidden />
          <span className="grid">
            <span className="text-[13px] text-muted-foreground">{t('payments.open')}</span>
            <b className="text-2xl font-extrabold">{euro(data.openCents)}</b>
          </span>
        </Card>
        <Card className="flex items-center gap-3 p-5">
          <CheckCircle2 className="size-8 text-success" aria-hidden />
          <span className="grid">
            <span className="text-[13px] text-muted-foreground">{t('payments.paid')}</span>
            <b className="text-2xl font-extrabold">{euro(data.paidCents)}</b>
          </span>
        </Card>
      </div>
      {data.charges.length === 0 ? (
        <Card className="grid gap-1 p-5">
          <CardTitle className="flex items-center gap-2">
            <CircleDollarSign className="size-5 text-primary" aria-hidden />
            {t('payments.emptyTitle')}
          </CardTitle>
          <CardDescription>{t('payments.emptyText')}</CardDescription>
        </Card>
      ) : null}
      {data.charges.map((charge) => (
        <Card key={charge.id} className="grid gap-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-0.5">
              <CardTitle>{charge.serverName}</CardTitle>
              <CardDescription>
                {t('payments.who', {
                  name: charge.userName,
                  price: euro(charge.monthlyCents),
                  code: charge.code,
                  since: formatDateTime(charge.startedAt),
                })}
              </CardDescription>
            </div>
            <span className="flex flex-wrap gap-1.5">
              {charge.endedAt ? <Pill tone="neutral">{t('payments.ended')}</Pill> : null}
              <Pill tone={charge.openCents ? 'warn' : 'ok'}>
                {charge.openCents
                  ? t('payments.owes', { amount: euro(charge.openCents) })
                  : t('payments.allPaid')}
              </Pill>
            </span>
          </div>
          <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {charge.months.map((m) => (
              <li key={m.month}>
                <button
                  type="button"
                  disabled={mark.isPending}
                  onClick={() => mark.mutate({ id: charge.id, month: m.month, paid: !m.paidAt })}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-[10px] border px-3 py-2 text-left text-sm transition-colors',
                    m.paidAt
                      ? 'border-success/40 bg-success-soft'
                      : 'border-border bg-secondary hover:border-warning/60',
                  )}
                >
                  <span className="font-semibold">{monthName(m.month, locale)}</span>
                  <span
                    className={cn('text-[12px] font-semibold', m.paidAt ? 'text-success' : 'text-warning')}
                  >
                    {m.paidAt ? `✓ ${t('payments.markedPaid')}` : t('payments.markPaid')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <p className="text-[12px] text-muted-foreground">{t('payments.note')}</p>
    </div>
  );
}

/** Dashboard hint for people who ordered with a paid voucher. */
export function MyPaymentsHint(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === 'en' ? 'en-GB' : 'de-DE';
  const { data } = useQuery({
    queryKey: ['payments-mine'],
    queryFn: () => api<PaymentsView>('/api/payments/mine'),
  });
  const running = data?.charges.filter((c) => !c.endedAt) ?? [];
  if (!data || (running.length === 0 && data.openCents === 0)) return null;
  const monthly = running.reduce((sum, c) => sum + c.monthlyCents, 0);
  return (
    <div className="flex items-start gap-3 rounded-[14px] border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
      <CircleDollarSign className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <span>
        <b className="block">{t('payments.mineTitle', { price: formatEuro(monthly, locale) })}</b>
        {data.openCents
          ? t('payments.mineOpen', { amount: formatEuro(data.openCents, locale) })
          : t('payments.mineAllPaid')}
      </span>
    </div>
  );
}
