import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SOFTWARE, type ServerRequestView } from '@mornihosting/shared';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const STATUS_TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' } as const;

/** For people who request servers: what they asked for and what became of it. */
export function MyRequests(): ReactElement | null {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['server-requests', 'mine'],
    queryFn: () => api<ServerRequestView[]>('/api/server-requests/mine'),
    refetchInterval: 30_000,
  });
  if (!data?.length) return null;
  return (
    <Card className="grid min-w-0 gap-3 p-5">
      <CardHeader className="mb-0">
        <CardTitle>{t('requests.mine')}</CardTitle>
      </CardHeader>
      <ul className="grid gap-2">
        {data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <b>{r.input.name}</b>{' '}
              <span className="text-muted-foreground">
                · {SOFTWARE[r.input.software].label} · {formatRelative(r.createdAt)}
              </span>
              {r.note ? <span className="block text-[13px] text-muted-foreground">{r.note}</span> : null}
            </span>
            <Pill tone={STATUS_TONE[r.status]} dot>
              {t(`approvals.status.${r.status}`)}
            </Pill>
          </li>
        ))}
      </ul>
    </Card>
  );
}
