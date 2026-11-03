import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MeResponse } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { meQuery, statusQuery, useSession } from '@/features/auth/session';

/** Account page: the mail address for "password forgotten" and order confirmations; a new one needs a click in a mail. */
export function EmailCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mailReady = status.data?.mail.passwordReset ?? false;
  const change = useMutation({
    mutationFn: () => api<void>('/api/account/email', { method: 'PUT', body: { email, password } }),
    onSuccess: () => {
      toast.success(t('emailCard.sent', { email }));
      setEmail('');
      setPassword('');
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/api/account/email', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.setQueryData<MeResponse | null>(meQuery.queryKey, (prev) =>
        prev ? { ...prev, user: { ...prev.user, email: null } } : prev,
      );
      toast.success(t('emailCard.removed'));
    },
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    change.mutate();
  };
  const error = change.error ?? remove.error;

  return (
    <Card fold="account-email" className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <AtSign className="size-4 text-primary" aria-hidden />
          {t('emailCard.title')}
          {me.user.email ? <Pill tone="ok">{t('emailCard.confirmed')}</Pill> : null}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('emailCard.text')}</CardDescription>
      {me.user.email ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-secondary px-3 py-2.5">
          <p className="min-w-0 flex-1 truncate font-semibold">{me.user.email}</p>
          <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 />
            {t('emailCard.remove')}
          </Button>
        </div>
      ) : null}
      {mailReady ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field id="account-email" label={me.user.email ? t('emailCard.newLabel') : t('emailCard.label')}>
            <Input
              id="account-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field
            id="account-email-password"
            label={t('emailCard.password')}
            hint={t('emailCard.passwordHint')}
          >
            <Input
              id="account-email-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          {error ? (
            <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm sm:col-span-2">
              {errorText(error)}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={change.isPending}>
              {t('emailCard.send')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('emailCard.unavailable')}</p>
      )}
    </Card>
  );
}
