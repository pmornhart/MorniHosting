import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleMinus, Mail, Save, Send, Sparkles, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MAIL_SECURITY,
  type MailQuickResult,
  type MailSecurity,
  type MailSettingsInput,
  type MailSettingsView,
  type MailStepState,
  type MailTestResult,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { statusQuery } from '@/features/auth/session';

const mailQuery = { queryKey: ['mail'], queryFn: () => api<MailSettingsView>('/api/mail') } as const;
/** Usual port for each kind of encryption: "starttls" 587, "tls" 465, "none" 25. */
const PORT_FOR: Readonly<Record<MailSecurity, number>> = { starttls: 587, tls: 465, none: 25 };

interface Draft extends Omit<MailSettingsInput, 'password'> {
  password: string;
}

function Toggle(props: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly title: string;
  readonly hint: string;
}): ReactElement {
  return (
    <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
      <Switch checked={props.checked} onCheckedChange={props.onChange} className="mt-0.5" />
      <span>
        <b className="block text-sm font-semibold">{props.title}</b>
        <span className="text-[13px] text-muted-foreground">{props.hint}</span>
      </span>
    </label>
  );
}

const STEP_ICON: Readonly<Record<MailStepState, ReactElement>> = {
  ok: <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />,
  failed: <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />,
  skipped: <CircleMinus className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
};

/** What the test button found: each step, what went wrong with a tip, and a port that was found instead. */
function TestReport(props: { readonly result: MailTestResult; readonly from: string }): ReactElement {
  const { t } = useTranslation();
  const { result } = props;
  const failedPort = result.attempts[0]?.port ?? 0;
  return (
    <div className="grid gap-3" aria-live="polite">
      <ol className="grid gap-1.5 rounded-[12px] border border-border p-3">
        {result.steps.map((s) => (
          <li key={s.step} className="flex min-w-0 items-center gap-2 text-sm">
            {STEP_ICON[s.state]}
            <span className={s.state === 'skipped' ? 'text-muted-foreground' : 'font-medium'}>
              {t(`mail.steps.${s.step}`)}
            </span>
            {s.detail ? (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{s.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
      {result.switchedTo ? (
        <p role="note" className="rounded-[10px] bg-primary/10 px-3 py-2 text-sm">
          {t('mail.switched', {
            old: failedPort,
            port: result.switchedTo.port,
            security: t(`mail.securityKinds.${result.switchedTo.security}`).split(' ')[0],
          })}
        </p>
      ) : null}
      {result.ok ? (
        <p className="text-sm font-medium text-primary">{t('mail.testSent', { to: result.sentTo })}</p>
      ) : result.problem ? (
        <div role="alert" className="grid gap-1 rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          <b>{t(`mail.problems.${result.problem}.title`)}</b>
          <span>{t(`mail.problems.${result.problem}.tip`, { port: failedPort, from: props.from })}</span>
          {result.attempts.length > 1 ? (
            <span className="text-muted-foreground">
              {t('mail.tried', {
                list: result.attempts
                  .map((a) => `${a.port} ${t(`mail.securityKinds.${a.security}`).split(' ')[0]}`)
                  .join(', '),
              })}
            </span>
          ) : null}
          {result.message ? (
            <span className="break-words font-mono text-xs text-muted-foreground">
              {t('mail.serverSaid')}: {result.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const securityName = (security: MailSecurity, t: (key: string) => string): string =>
  t(`mail.securityKinds.${security}`).split(' ')[0] ?? security;

/** Quick start: address, password and (for a mail server at home) its IP. The panel finds and saves the rest. */
function QuickStart(props: { readonly onDone: () => void }): ReactElement {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [atHome, setAtHome] = useState(false);
  const [ip, setIp] = useState('');
  const quick = useMutation({
    mutationFn: () =>
      api<MailQuickResult>('/api/mail/quick', {
        method: 'POST',
        body: { email: email.trim(), password, internalHost: atHome ? ip.trim() : '' },
      }),
    onSuccess: (result) => {
      if (!result.found) return;
      setPassword('');
      props.onDone();
    },
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    quick.mutate();
  };
  const result = quick.data;
  const closest = result?.closest;
  return (
    <form onSubmit={submit} className="grid gap-4 rounded-[14px] border border-primary/40 bg-primary/5 p-4">
      <div className="grid gap-1">
        <b className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {t('mail.quick.title')}
        </b>
        <span className="text-[13px] text-muted-foreground">{t('mail.quick.text')}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="quick-email" label={t('mail.quick.email')} hint={t('mail.quick.emailHint')}>
          <Input
            id="quick-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="noreply@mornihosting.de"
            autoComplete="off"
            required
          />
        </Field>
        <Field id="quick-password" label={t('mail.quick.password')} hint={t('mail.quick.passwordHint')}>
          <Input
            id="quick-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
      </div>
      <Toggle
        checked={atHome}
        onChange={setAtHome}
        title={t('mail.quick.atHome')}
        hint={t('mail.quick.atHomeHint')}
      />
      {atHome ? (
        <Field id="quick-ip" label={t('mail.internalHost')} hint={t('mail.quick.ipHint')}>
          <Input
            id="quick-ip"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.178.116"
            inputMode="decimal"
            autoComplete="off"
            required
          />
        </Field>
      ) : null}
      <div>
        <Button type="submit" disabled={quick.isPending}>
          <Sparkles />
          {quick.isPending ? t('mail.quick.running') : t('mail.quick.go')}
        </Button>
      </div>
      {quick.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(quick.error)}
        </p>
      ) : null}
      {result?.found ? (
        <p role="status" className="rounded-[10px] bg-primary/10 px-3 py-2 text-sm">
          {t('mail.quick.found', {
            host: result.found.host,
            port: result.found.port,
            security: securityName(result.found.security, t),
          })}
        </p>
      ) : null}
      {result?.test ? <TestReport result={result.test} from={`MorniHosting <${email}>`} /> : null}
      {result && !result.found ? (
        <div className="grid gap-3">
          {closest ? (
            <TestReport
              result={{
                ok: false,
                sentTo: '',
                steps: closest.steps,
                problem: closest.problem,
                message: closest.message,
                attempts: [closest],
                switchedTo: null,
              }}
              from={email}
            />
          ) : null}
          <p className="text-[13px] text-muted-foreground">
            {t('mail.quick.tried', {
              list: [...new Set(result.tried.map((tr) => tr.host))].join(', '),
            })}
          </p>
        </div>
      ) : null}
    </form>
  );
}

/** Admin area → E-Mail: the mail server, what the panel may send, and a test button. */
export function MailCard(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(mailQuery);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (data) {
      const { configured: _c, passwordSet: _p, linksPossible: _l, ...rest } = data;
      setDraft({ ...rest, password: '' });
    }
  }, [data]);

  const refresh = (view: MailSettingsView): void => {
    queryClient.setQueryData(mailQuery.queryKey, view);
    void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
  };
  const save = useMutation({
    mutationFn: (body: Draft) =>
      api<MailSettingsView>('/api/mail', {
        method: 'PUT',
        body: { ...body, ...(body.password ? {} : { password: undefined }) },
      }),
    onSuccess: (view) => {
      refresh(view);
      toast.success(t('mail.saved'));
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/api/mail', { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
      toast.success(t('mail.removed'));
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<MailTestResult>('/api/mail/test', {
        method: 'POST',
        body: testTo.trim() ? { to: testTo.trim() } : {},
      }),
    onSuccess: (result) => {
      if (result.switchedTo) void queryClient.invalidateQueries({ queryKey: mailQuery.queryKey });
      if (result.ok) toast.success(t('mail.testSent', { to: result.sentTo }));
    },
  });

  if (!data || !draft) return <Card className="h-64 animate-pulse p-6" aria-busy />;
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate(draft);
  };
  const error = save.error ?? remove.error ?? test.error;

  return (
    <Card className="grid min-w-0 gap-5 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Mail className="size-4 text-primary" aria-hidden />
          {t('mail.title')}
          <Pill tone={data.configured ? 'ok' : 'neutral'}>
            {data.configured ? t('mail.on') : t('mail.off')}
          </Pill>
        </CardTitle>
        <CardDescription>{t('mail.text')}</CardDescription>
      </CardHeader>
      <QuickStart onDone={() => void queryClient.invalidateQueries({ queryKey: mailQuery.queryKey })} />
      <details className="rounded-[12px] border border-border p-3 sm:p-4">
        <summary className="cursor-pointer text-sm font-semibold">{t('mail.quick.allSettings')}</summary>
        <form onSubmit={submit} className="mt-4 grid gap-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field id="mail-host" label={t('mail.host')} hint={t('mail.hostHint')}>
              <Input
                id="mail-host"
                value={draft.host}
                onChange={(e) => set({ host: e.target.value })}
                placeholder="smtp.example.de"
                autoComplete="off"
                required
              />
            </Field>
            <Field id="mail-port" label={t('mail.port')}>
              <Input
                id="mail-port"
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} // eslint-disable-line ts-patterns/require-regex-example -- digits only: "58a7" → "587"
                required
              />
            </Field>
          </div>
          <Field id="mail-internal" label={t('mail.internalHost')} hint={t('mail.internalHostHint')}>
            <Input
              id="mail-internal"
              value={draft.internalHost}
              onChange={(e) => set({ internalHost: e.target.value })}
              placeholder="192.168.178.116"
              autoComplete="off"
              inputMode="decimal"
            />
          </Field>
          <Field id="mail-security" label={t('mail.security')} hint={t('mail.securityHint')}>
            <Select
              value={draft.security}
              onValueChange={(value) =>
                set({ security: value as MailSecurity, port: PORT_FOR[value as MailSecurity] })
              }
            >
              <SelectTrigger id="mail-security">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAIL_SECURITY.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`mail.securityKinds.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="mail-user" label={t('mail.user')}>
              <Input
                id="mail-user"
                value={draft.user}
                onChange={(e) => set({ user: e.target.value })}
                placeholder="noreply@mornihosting.de"
                autoComplete="off"
              />
            </Field>
            <Field
              id="mail-password"
              label={t('mail.password')}
              hint={data.passwordSet ? t('mail.passwordKept') : t('mail.passwordHint')}
            >
              <Input
                id="mail-password"
                type="password"
                value={draft.password}
                onChange={(e) => set({ password: e.target.value })}
                placeholder={data.passwordSet ? '••••••••' : ''}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Field id="mail-from" label={t('mail.from')} hint={t('mail.fromHint')}>
            <Input
              id="mail-from"
              value={draft.from}
              onChange={(e) => set({ from: e.target.value })}
              placeholder="MorniHosting <noreply@mornihosting.de>"
              required
            />
          </Field>

          {!data.linksPossible ? (
            <p role="note" className="rounded-[10px] bg-warning-soft px-3 py-2 text-sm">
              {t('mail.needsDomain')}
            </p>
          ) : null}
          <div className="grid gap-3">
            <Toggle
              checked={draft.registration}
              onChange={(registration) => set({ registration })}
              title={t('mail.registration')}
              hint={t('mail.registrationHint')}
            />
            {draft.registration ? (
              <Toggle
                checked={draft.registrationApproval}
                onChange={(registrationApproval) => set({ registrationApproval })}
                title={t('mail.registrationApproval')}
                hint={t('mail.registrationApprovalHint')}
              />
            ) : null}
            {draft.registration ? (
              <Toggle
                checked={draft.registrationOrders}
                onChange={(registrationOrders) => set({ registrationOrders })}
                title={t('mail.registrationOrders')}
                hint={t('mail.registrationOrdersHint')}
              />
            ) : null}
            <Toggle
              checked={draft.crashMails}
              onChange={(crashMails) => set({ crashMails })}
              title={t('mail.crashMails')}
              hint={t('mail.crashMailsHint')}
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              {errorText(error)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              <Save />
              {t('common.save')}
            </Button>
            {data.configured ? (
              <Button
                type="button"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <Trash2 />
                {t('mail.remove')}
              </Button>
            ) : null}
          </div>

          {data.configured ? (
            <div className="grid gap-3 border-t border-border pt-5">
              <Field id="mail-test" label={t('mail.testTitle')} hint={t('mail.testHint')}>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="mail-test"
                    type="email"
                    className="min-w-0 flex-1"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder={t('mail.testPlaceholder')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={test.isPending}
                    onClick={() => test.mutate()}
                  >
                    <Send />
                    {test.isPending ? t('mail.testRunning') : t('mail.testSend')}
                  </Button>
                </div>
              </Field>
              {test.data ? <TestReport result={test.data} from={draft.from} /> : null}
            </div>
          ) : null}

          <details className="rounded-[12px] border border-border p-3 text-sm">
            <summary className="cursor-pointer font-semibold">{t('mail.helpTitle')}</summary>
            <ul className="mt-3 grid gap-2 text-muted-foreground">
              <li>{t('mail.helpInwx')}</li>
              <li>{t('mail.helpIonos')}</li>
              <li>{t('mail.helpGmail')}</li>
            </ul>
          </details>
        </form>
      </details>
    </Card>
  );
}
