import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Hourglass, MailCheck, TriangleAlert, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router';
import type { ConfirmResult, Locale, RegisterResult } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { LandingLayout } from './LandingLayout';
import { statusQuery } from './session';

/** The pages around mails: sign up, "password forgotten", and the pages behind the links in mails. */

function Heading(props: { readonly title: string; readonly text?: string }): ReactElement {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-[-0.02em]">{props.title}</h1>
      {props.text ? <p className="mt-1 text-muted-foreground">{props.text}</p> : null}
    </div>
  );
}

function ErrorLine(props: { readonly error: unknown }): ReactElement | null {
  return props.error ? (
    <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
      {errorText(props.error)}
    </p>
  ) : null;
}

function BackToLogin(): ReactElement {
  const { t } = useTranslation();
  return (
    <Button asChild variant="link">
      <Link to="/login">{t('mailPages.backToLogin')}</Link>
    </Button>
  );
}

function Done(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly text: string;
}): ReactElement {
  return (
    <div className="grid gap-4">
      <span className="grid size-11 place-items-center rounded-[12px] bg-accent text-primary">
        {props.icon}
      </span>
      <Heading title={props.title} text={props.text} />
      <BackToLogin />
    </div>
  );
}

export function RegisterPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const status = useQuery(statusQuery);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const register = useMutation({
    mutationFn: () =>
      api<RegisterResult>('/api/auth/register', {
        method: 'POST',
        body: {
          username,
          email,
          password,
          locale: (i18n.language.startsWith('en') ? 'en' : 'de') satisfies Locale,
        },
      }),
  });
  if (status.data && !status.data.mail.registration) return <Navigate to="/login" replace />;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    register.mutate();
  };
  return (
    <LandingLayout>
      {register.data?.next === 'wait_approval' ? (
        <Done
          icon={<Hourglass />}
          title={t('mailPages.requestSentTitle')}
          text={t('mailPages.requestSent')}
        />
      ) : register.isSuccess ? (
        <Done
          icon={<MailCheck />}
          title={t('mailPages.registerSentTitle')}
          text={t('mailPages.registerSent', { email })}
        />
      ) : (
        <form onSubmit={submit} className="grid gap-5">
          <Heading title={t('mailPages.registerTitle')} text={t('mailPages.registerText')} />
          <Field id="reg-username" label={t('setup.username')} hint={t('mailPages.usernameHint')}>
            <Input
              id="reg-username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>
          <Field id="reg-email" label={t('mailPages.email')}>
            <Input
              id="reg-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field id="reg-password" label={t('setup.password')} hint={t('mailPages.passwordHint')}>
            <Input
              id="reg-password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <ErrorLine error={register.error} />
          <Button type="submit" size="lg" disabled={register.isPending}>
            <UserPlus />
            {t('mailPages.registerSubmit')}
          </Button>
          <BackToLogin />
        </form>
      )}
    </LandingLayout>
  );
}

export function ForgotPage(): ReactElement {
  const { t } = useTranslation();
  const status = useQuery(statusQuery);
  const [email, setEmail] = useState('');
  const forgot = useMutation({
    mutationFn: () => api<void>('/api/auth/forgot', { method: 'POST', body: { email } }),
  });
  if (status.data && !status.data.mail.passwordReset) return <Navigate to="/login" replace />;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    forgot.mutate();
  };
  return (
    <LandingLayout>
      {forgot.isSuccess ? (
        <Done icon={<MailCheck />} title={t('mailPages.forgotSentTitle')} text={t('mailPages.forgotSent')} />
      ) : (
        <form onSubmit={submit} className="grid gap-5">
          <Heading title={t('mailPages.forgotTitle')} text={t('mailPages.forgotText')} />
          <Field id="forgot-email" label={t('mailPages.email')}>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <ErrorLine error={forgot.error} />
          <Button type="submit" size="lg" disabled={forgot.isPending}>
            {t('mailPages.forgotSubmit')}
          </Button>
          <BackToLogin />
        </form>
      )}
    </LandingLayout>
  );
}

export function ResetPage(): ReactElement {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => api<void>('/api/auth/reset', { method: 'POST', body: { token, password } }),
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    reset.mutate();
  };
  return (
    <LandingLayout>
      {reset.isSuccess ? (
        <Done icon={<CheckCircle2 />} title={t('mailPages.resetDoneTitle')} text={t('mailPages.resetDone')} />
      ) : (
        <form onSubmit={submit} className="grid gap-5">
          <Heading title={t('mailPages.resetTitle')} text={t('mailPages.resetText')} />
          <Field id="reset-password" label={t('mailPages.newPassword')} hint={t('mailPages.passwordHint')}>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <ErrorLine error={reset.error} />
          <Button type="submit" size="lg" disabled={reset.isPending || !token}>
            {t('mailPages.resetSubmit')}
          </Button>
          <BackToLogin />
        </form>
      )}
    </LandingLayout>
  );
}

/** Opened from the link in a mail: confirms the sign-up or the new address right away. */
export function VerifyPage(): ReactElement {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const started = useRef(false);
  const confirm = useMutation({
    mutationFn: () => api<ConfirmResult>('/api/auth/confirm', { method: 'POST', body: { token } }),
  });
  useEffect(() => {
    // Once only: the link works a single time, and React runs effects twice in development.
    if (started.current || !token) return;
    started.current = true;
    confirm.mutate();
  }, [token, confirm]);
  const failed = !token || confirm.isError;
  return (
    <LandingLayout>
      {failed ? (
        <Done
          icon={<TriangleAlert />}
          title={t('mailPages.verifyFailedTitle')}
          text={confirm.error ? errorText(confirm.error) : t('mailPages.verifyFailed')}
        />
      ) : confirm.data ? (
        <Done
          icon={<CheckCircle2 />}
          title={t(`mailPages.verified.${confirm.data.kind}.title`)}
          text={t(`mailPages.verified.${confirm.data.kind}.text`)}
        />
      ) : (
        <Heading title={t('mailPages.verifying')} />
      )}
    </LandingLayout>
  );
}
