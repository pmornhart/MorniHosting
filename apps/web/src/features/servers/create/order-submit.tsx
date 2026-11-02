import { CheckCircle2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { CreateServerInput, ServerRequestView, ServerSummary } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';

/**
 * People who may not order themselves send the same order as a request: an admin approves it (in the panel,
 * by mail or in Discord) and the server is then created for them.
 */
export async function placeOrder(body: CreateServerInput, mayOrder: boolean): Promise<ServerSummary | null> {
  if (mayOrder) return api<ServerSummary>('/api/servers', { method: 'POST', body });
  const { netbirdName: _admin, ...request } = body;
  await api<ServerRequestView>('/api/server-requests', { method: 'POST', body: request });
  return null;
}

export function RequestSent(): ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="mx-auto grid max-w-xl justify-items-center gap-3 p-8 text-center">
      <CheckCircle2 className="size-12 text-primary" aria-hidden />
      <h2 className="text-xl font-semibold text-balance">{t('requests.sentTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('requests.sentText')}</p>
      <Button asChild variant="secondary">
        <Link to="/">{t('requests.toOverview')}</Link>
      </Button>
    </Card>
  );
}
