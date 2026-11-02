import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import type { LoginResponse } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { LandingLayout } from './LandingLayout';
import { panelDomainMissing, passkeysUsable, signInWithPasskey } from './passkey';
import { adoptMe, meQuery, statusQuery } from './session';

export function LoginPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const target = (location.state as { from?: string } | null)?.from ?? '/'; // set by AuthGate when it redirected here

  const finish = (result: LoginResponse): void => {
    if (result.status === 'two-factor') {
      setStep('code');
      return;
    }
    adoptMe(result.me);
    queryClient.setQueryData(meQuery.queryKey, result.me);
    navigate(target, { replace: true });
  };

  const login = useMutation({
    mutationFn: () => api<LoginResponse>('/api/auth/login', { method: 'POST', body: { username, password } }),
    onSuccess: finish,
    onError: () => undefined,
  });
  const verify = useMutation({
    mutationFn: () => api<LoginResponse>('/api/auth/two-factor', { method: 'POST', body: { code } }),
    onSuccess: finish,
    onError: () => undefined,
  });
  const passkey = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: finish,
    onError: () => undefined,
  });

  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    passkey.reset();
    if (step === 'password') login.mutate();
    else verify.mutate();
  };
  const error = step === 'password' ? (login.error ?? passkey.error) : verify.error;
  const passkeyReady = step === 'password' && status.data !== undefined && passkeysUsable(status.data);
  const proxyHint = step === 'password' && status.data ? panelDomainMissing(status.data) : false;
  const passkeyDomain =
    status.data?.passkeys === 'wrong_host' && !passkeyReady ? status.data.panelDomain : null;
  const busy = login.isPending || verify.isPending || passkey.isPending;

  return (
    <LandingLayout>
      <form onSubmit={submit} className="grid gap-5" noValidate>
        {step === 'password' ? (
          <>
            <div>
              <h1 className="text-2xl font-bold tracking-[-0.02em]">{t('login.title')}</h1>
              <p className="mt-1 text-muted-foreground">{t('login.subtitle')}</p>
            </div>
            <Field id="username" label={t('login.usernameOrEmail')}>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </Field>
            <Field id="password" label={t('setup.password')}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
          </>
        ) : (
          <>
            <div className="grid gap-2">
              <span className="grid size-11 place-items-center rounded-[12px] bg-accent text-primary">
                <ShieldCheck />
              </span>
              <h1 className="text-2xl font-bold tracking-[-0.02em]">{t('login.twoFactorTitle')}</h1>
              <p className="text-muted-foreground">{t('login.twoFactorText')}</p>
            </div>
            <Field id="code" label={t('login.code')}>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                className="text-center font-mono text-lg tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} // eslint-disable-line ts-patterns/require-regex-example -- keeps digits only: "12 34-56" → "123456"
              />
            </Field>
          </>
        )}
        {error ? (
          <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
            {errorText(error)}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={busy}>
          {step === 'password' ? <LogIn /> : <ShieldCheck />}
          {step === 'password' ? t('login.submit') : t('login.twoFactorSubmit')}
        </Button>
        {passkeyReady ? (
          <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              {t('login.or')}
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy}
              onClick={() => {
                login.reset();
                passkey.mutate();
              }}
            >
              <KeyRound />
              {passkey.isPending ? t('login.passkeyWaiting') : t('login.passkey')}
            </Button>
          </>
        ) : null}
        {proxyHint ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('passkeys.proxyHint', { host: window.location.hostname })}
          </p>
        ) : null}
        {step === 'password' && passkeyDomain ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('login.passkeyElsewhere')}{' '}
            <a className="font-semibold text-primary hover:underline" href={`https://${passkeyDomain}`}>
              {passkeyDomain}
            </a>
          </p>
        ) : null}
        {step === 'password' && status.data?.mail.passwordReset ? (
          <Link className="text-center text-sm font-semibold text-primary hover:underline" to="/forgot">
            {t('login.forgot')}
          </Link>
        ) : null}
        {step === 'password' && status.data?.mail.registration ? (
          <div className="grid gap-2 border-t border-border pt-4">
            <p className="text-center text-sm text-muted-foreground">{t('login.noAccount')}</p>
            <Button asChild variant="secondary" size="lg">
              <Link to="/register">
                <UserPlus />
                {t('landing.requestAccount')}
              </Link>
            </Button>
          </div>
        ) : null}
        {step === 'code' ? (
          <Button variant="link" onClick={() => setStep('password')}>
            {t('login.backToLogin')}
          </Button>
        ) : null}
      </form>
    </LandingLayout>
  );
}
