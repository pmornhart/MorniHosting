import { NotifyCard } from './NotifyCard';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MeResponse } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { adoptMe, useSession } from '@/features/auth/session';
import { EmailCard } from './EmailCard';
import { MinecraftAccountCard } from './MinecraftAccountCard';
import { PasskeysCard } from './PasskeysCard';

interface TwoFactorSetup {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrDataUrl: string;
}

const PASSWORD_MIN = 10;

function ProfileCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const [displayName, setDisplayName] = useState(me.user.displayName);
  const save = useMutation({
    mutationFn: () =>
      api<MeResponse>('/api/account', { method: 'PATCH', body: { displayName: displayName.trim() } }),
    onSuccess: (next) => {
      adoptMe(next);
      toast.success(t('common.saved'));
    },
  });
  return (
    <Card fold="account-1" foldOpen className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle>{t('account.profile')}</CardTitle>
      </CardHeader>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          id="acc-name"
          label={t('users.displayName')}
          hint={t('account.usernameIs', { username: me.user.username })}
          className="min-w-[220px] flex-1"
        >
          <Input
            id="acc-name"
            value={displayName}
            maxLength={40}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={save.isPending || displayName.trim() === me.user.displayName}>
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

function PasswordCard(): ReactElement {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const change = useMutation({
    mutationFn: () => api('/api/account/password', { method: 'POST', body: { current, next } }),
    onSuccess: () => {
      toast.success(t('account.passwordChanged'));
      setCurrent('');
      setNext('');
      setRepeat('');
    },
  });
  const mismatch = repeat.length > 0 && repeat !== next;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (current && next.length >= PASSWORD_MIN && next === repeat) change.mutate();
  };
  return (
    <Card fold="account-2" className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle>{t('account.password')}</CardTitle>
      </CardHeader>
      <CardDescription>{t('account.passwordText')}</CardDescription>
      <form onSubmit={submit} className="grid items-start gap-4 sm:grid-cols-3">
        <Field id="acc-current" label={t('account.current')}>
          <Input
            id="acc-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field id="acc-next" label={t('account.next')} hint={t('users.passwordHint')}>
          <Input
            id="acc-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field
          id="acc-repeat"
          label={t('account.repeat')}
          error={mismatch ? t('account.mismatch') : undefined}
        >
          <Input
            id="acc-repeat"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <div className="flex justify-end sm:col-span-3">
          <Button
            type="submit"
            disabled={change.isPending || !current || next.length < PASSWORD_MIN || next !== repeat}
          >
            {t('account.changePassword')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TwoFactorCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const refreshMe = async (): Promise<void> => adoptMe(await api<MeResponse>('/api/auth/me'));
  const start = useMutation({
    mutationFn: () => api<TwoFactorSetup>('/api/account/two-factor/setup', { method: 'POST' }),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () => api('/api/account/two-factor/enable', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      toast.success(t('account.twoFactorOn'));
      setSetup(null);
      setCode('');
      await refreshMe();
    },
  });
  const disable = useMutation({
    mutationFn: () => api('/api/account/two-factor/disable', { method: 'POST', body: { code, password } }),
    onSuccess: async () => {
      toast.success(t('account.twoFactorOff'));
      setCode('');
      setPassword('');
      await refreshMe();
    },
  });
  const enabled = me.user.totpEnabled;

  const content = (): ReactElement => {
    if (enabled) {
      return (
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <Field id="tf-pass" label={t('account.current')}>
            <Input
              id="tf-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field id="tf-code-off" label={t('account.code')}>
            <Input
              id="tf-code-off"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="destructive" disabled={disable.isPending || !password || !code}>
            <ShieldOff />
            {t('account.disable2fa')}
          </Button>
        </form>
      );
    }
    if (setup) {
      return (
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <img
            src={setup.qrDataUrl}
            alt={t('account.qrAlt')}
            className="size-[200px] rounded-[12px] bg-white p-2"
          />
          <form
            className="grid content-start gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              enable.mutate();
            }}
          >
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('account.step1')}</li>
              <li>{t('account.step2')}</li>
              <li>{t('account.step3')}</li>
            </ol>
            <div className="flex items-center gap-2 rounded-[10px] bg-secondary px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{setup.secret}</code>
              <CopyButton text={setup.secret} />
            </div>
            <Field id="tf-code" label={t('account.code')}>
              <Input
                id="tf-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-40"
              />
            </Field>
            <Button type="submit" className="justify-self-start" disabled={enable.isPending || !code}>
              <ShieldCheck />
              {t('account.enable2fa')}
            </Button>
          </form>
        </div>
      );
    }
    return (
      <Button className="justify-self-start" onClick={() => start.mutate()} disabled={start.isPending}>
        <ShieldCheck />
        {t('account.setup2fa')}
      </Button>
    );
  };

  return (
    <Card fold="account-3" className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          {t('account.twoFactor')}
          {enabled ? <Pill tone="ok">{t('common.enabled')}</Pill> : <Pill>{t('common.disabled')}</Pill>}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('account.twoFactorText')}</CardDescription>
      {content()}
    </Card>
  );
}

/** The signed-in person's own settings: name, password, passkeys and two-factor login. */
export function AccountPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader title={t('nav.account')} subtitle={t('account.subtitle')} />
      <ProfileCard />
      <EmailCard />
      <NotifyCard />
      <MinecraftAccountCard />
      <PasswordCard />
      <PasskeysCard />
      <TwoFactorCard />
    </div>
  );
}
