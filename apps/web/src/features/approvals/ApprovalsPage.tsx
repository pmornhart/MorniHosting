import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, UserPlus, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  SOFTWARE,
  type ApprovalsView,
  type ServerRequestView,
  type SignupSettings,
} from '@mornihosting/shared';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatMemoryMb, formatRelative } from '@/lib/format';
import { errorText } from '@/lib/query';
import { statusQuery } from '@/features/auth/session';

export const approvalsQuery = {
  queryKey: ['approvals'],
  queryFn: () => api<ApprovalsView>('/api/approvals'),
  refetchInterval: 30_000,
} as const;

/** Answer from the server: what the decision did, in the same words as in Discord. */
interface DecisionMessage {
  readonly title: string;
  readonly text: string;
}

const STATUS_TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' } as const;

function Decide(props: { readonly approveUrl: string; readonly rejectUrl: string }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (kind: 'approve' | 'reject') =>
      api<DecisionMessage>(kind === 'approve' ? props.approveUrl : props.rejectUrl, {
        method: 'POST',
        body: kind === 'approve' ? undefined : { note: note.trim() },
      }),
    onSuccess: (message) => {
      toast.success(`${message.title} – ${message.text}`);
      void queryClient.invalidateQueries({ queryKey: approvalsQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  if (rejecting)
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          decide.mutate('reject');
        }}
      >
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('approvals.reasonPlaceholder')}
          className="min-w-0 flex-1"
          maxLength={300}
          aria-label={t('approvals.reason')}
        />
        <Button type="submit" variant="danger" disabled={decide.isPending}>
          <X />
          {t('approvals.reject')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
          {t('common.cancel')}
        </Button>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
        <Check />
        {t('approvals.approve')}
      </Button>
      <Button variant="outline" disabled={decide.isPending} onClick={() => setRejecting(true)}>
        <X />
        {t('approvals.reject')}
      </Button>
    </div>
  );
}

function RequestCard({ request }: { readonly request: ServerRequestView }): ReactElement {
  const { t } = useTranslation();
  const software = SOFTWARE[request.input.software];
  return (
    <Card className="grid min-w-0 gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <b className="block truncate text-base">{request.input.name}</b>
          <span className="text-sm text-muted-foreground">
            {t('approvals.by', { name: request.user.displayName })} · {formatRelative(request.createdAt)}
          </span>
        </div>
        <Pill tone={STATUS_TONE[request.status]} dot>
          {t(`approvals.status.${request.status}`)}
        </Pill>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t('approvals.game')}</dt>
          <dd>
            {software.label} {request.input.version}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('approvals.plan')}</dt>
          <dd>{formatMemoryMb(request.input.memoryMb)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('approvals.port')}</dt>
          <dd>{request.input.port}</dd>
        </div>
      </dl>
      {request.status === 'pending' ? (
        <Decide
          approveUrl={`/api/server-requests/${request.id}/approve`}
          rejectUrl={`/api/server-requests/${request.id}/reject`}
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t('approvals.decided', { name: request.decidedBy ?? '?' })}
          {request.note ? ` – ${request.note}` : ''}
        </p>
      )}
    </Card>
  );
}

/** Whether visitors see "Konto anfragen" on the start page. */
function SignupSwitch(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['signup'], queryFn: () => api<SignupSettings>('/api/signup') });
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<SignupSettings>('/api/signup', { method: 'PUT', body: { enabled } }),
    onSuccess: (view) => {
      queryClient.setQueryData(['signup'], view);
      void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
    },
  });
  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <label className="flex items-start gap-3">
        <Switch
          checked={data?.enabled ?? false}
          disabled={!data || save.isPending}
          onCheckedChange={(enabled) => save.mutate(enabled)}
          className="mt-0.5"
        />
        <span>
          <b className="block text-sm font-semibold">{t('approvals.signupOpen')}</b>
          <span className="text-[13px] text-muted-foreground">{t('approvals.signupOpenHint')}</span>
        </span>
      </label>
    </Card>
  );
}

/** Admins: who wants in, and who wants a server. The same decisions also work from the mail and Discord. */
export function ApprovalsPage(): ReactElement {
  const { t } = useTranslation();
  const { data } = useQuery(approvalsQuery);
  const pending = data?.requests.filter((r) => r.status === 'pending') ?? [];
  const done = data?.requests.filter((r) => r.status !== 'pending') ?? [];
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      <SignupSwitch />

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <UserPlus className="size-5 text-primary" aria-hidden />
          {t('approvals.signups')}
        </h2>
        {data && data.users.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('approvals.noSignups')}</p>
        ) : null}
        {data?.users.map((user) => (
          <Card key={user.id} className="grid min-w-0 gap-3 p-4 sm:p-5">
            <CardHeader className="mb-0">
              <CardTitle className="truncate">{user.username}</CardTitle>
              <CardDescription>
                {user.email ?? '–'} · {formatRelative(user.createdAt)}
              </CardDescription>
            </CardHeader>
            {user.emailConfirmed ? null : (
              <Pill className="justify-self-start">{t('approvals.emailUnconfirmed')}</Pill>
            )}
            <Decide
              approveUrl={`/api/approvals/users/${user.id}/approve`}
              rejectUrl={`/api/approvals/users/${user.id}/reject`}
            />
          </Card>
        ))}
      </section>

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Inbox className="size-5 text-primary" aria-hidden />
          {t('approvals.requests')}
        </h2>
        {data && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('approvals.noRequests')}</p>
        ) : null}
        {pending.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
        {done.length ? (
          <details className="grid gap-3">
            <summary className="cursor-pointer text-sm font-semibold">
              {t('approvals.history', { count: done.length })}
            </summary>
            <div className="mt-3 grid gap-3">
              {done.map((r) => (
                <RequestCard key={r.id} request={r} />
              ))}
            </div>
          </details>
        ) : null}
      </section>
      <p className="text-[13px] text-muted-foreground">{t('approvals.hint')}</p>
    </div>
  );
}
