import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FlaskConical,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAIL_TEST_FINAL,
  type MailTestRecipient,
  type MailTestRun,
  type MailTestSpam,
  type MailTestState,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatRelative, formatTime } from '@/lib/format';
import { errorText } from '@/lib/query';
import { useSession } from '@/features/auth/session';

const testsKey = ['mail-tests'] as const;
/** While a test is still under way the list follows along. */
const REFRESH_MS = 5000;
const MAX_ADDRESSES = 5;
/** mail-tester's scale: from here on mails usually arrive. */
const GOOD_SCORE = 9;
const OK_SCORE = 7;
/** Colour of the score, best band first. */
const SCORE_TONES: readonly { readonly from: number; readonly tone: string }[] = [
  { from: GOOD_SCORE, tone: 'text-success' },
  { from: OK_SCORE, tone: 'text-warning' },
  { from: Number.NEGATIVE_INFINITY, tone: 'text-destructive' },
];

const ICONS: Readonly<Record<MailTestState, ReactElement>> = {
  sending: <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />,
  queued: <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />,
  retrying: <Clock className="size-4 shrink-0 text-warning" aria-hidden />,
  delivered: <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />,
  rejected: <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />,
  failed: <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />,
  left: <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
};

const isOpen = (run: MailTestRun): boolean =>
  run.recipients.some((r) => !MAIL_TEST_FINAL.includes(r.state)) || run.spam?.state === 'waiting';

function RecipientRow({
  recipient,
  tracked,
}: {
  recipient: MailTestRecipient;
  tracked: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const label =
    recipient.state === 'queued' && !tracked
      ? t('mailTests.states.acceptedOnly')
      : t(`mailTests.states.${recipient.state}`);
  return (
    <li className="grid gap-0.5 rounded-[10px] bg-secondary px-3 py-2 text-sm">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        {ICONS[recipient.state]}
        <b className="min-w-0 break-all font-semibold">
          {recipient.spamTest ? 'mail-tester.com' : recipient.to}
        </b>
        <span className="text-muted-foreground">{label}</span>
      </span>
      {recipient.state === 'retrying' && recipient.nextRetry ? (
        <span className="ml-6 text-[13px]">
          {t('mailTests.nextRetry', { time: formatTime(recipient.nextRetry) })}
        </span>
      ) : null}
      {recipient.remoteHost ? (
        <span className="ml-6 break-all font-mono text-xs text-muted-foreground">{recipient.remoteHost}</span>
      ) : null}
      {recipient.detail ? (
        <span className="ml-6 break-words font-mono text-xs text-muted-foreground">{recipient.detail}</span>
      ) : null}
      {['retrying', 'rejected', 'failed'].includes(recipient.state) ? (
        <span className="ml-6 text-[13px]">{t(`mailTests.tips.${recipient.state}`)}</span>
      ) : null}
    </li>
  );
}

function SpamScore({ spam }: { spam: MailTestSpam }): ReactElement {
  const { t } = useTranslation();
  const score = spam.score;
  const tone =
    score === null ? 'text-muted-foreground' : (SCORE_TONES.find((band) => score >= band.from)?.tone ?? '');
  return (
    <div className="grid gap-2 rounded-[10px] border border-border px-3 py-2.5 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
        <b className="font-semibold">{t('mailTests.spamTitle')}</b>
        {spam.score === null ? (
          <span className="text-muted-foreground">{t(`mailTests.spam.${spam.state}`)}</span>
        ) : (
          <span className={`text-lg font-bold ${tone}`}>
            {spam.score.toLocaleString(undefined, { maximumFractionDigits: 1 })}/{spam.max}
          </span>
        )}
      </span>
      {spam.problems.length ? (
        <ul className="ml-6 grid list-disc gap-0.5 pl-4 text-[13px]">
          {spam.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <a
        href={spam.url}
        target="_blank"
        rel="noreferrer"
        className="ml-6 inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
      >
        {t('mailTests.spamDetails')}
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}

function RunCard({ run }: { run: MailTestRun }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="grid gap-2 rounded-[12px] border border-border p-3">
      <span className="text-[13px] text-muted-foreground">
        {formatRelative(run.at)}
        {run.tracked ? '' : ` · ${t('mailTests.untracked')}`}
      </span>
      <ul className="grid gap-1.5">
        {run.recipients.map((recipient) => (
          <RecipientRow key={recipient.to} recipient={recipient} tracked={run.tracked} />
        ))}
      </ul>
      {run.spam ? <SpamScore spam={run.spam} /> : null}
    </li>
  );
}

/** Admin → E-Mail: test mails to several addresses, followed live, plus a spam score from mail-tester.com. */
export function MailTestsCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [addresses, setAddresses] = useState<string[]>(me?.user.email ? [me.user.email] : []);
  const [draft, setDraft] = useState('');
  const [spamScore, setSpamScore] = useState(true);
  const { data: runs } = useQuery({
    queryKey: testsKey,
    queryFn: () => api<MailTestRun[]>('/api/mail/tests'),
    refetchInterval: (query) => (query.state.data?.some(isOpen) ? REFRESH_MS : false),
  });
  const start = useMutation({
    mutationFn: (recipients: string[]) =>
      api<MailTestRun>('/api/mail/tests', { method: 'POST', body: { recipients, spamScore } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: testsKey });
      await queryClient.invalidateQueries({ queryKey: ['mail-outbox'] });
    },
  });
  const add = (): string[] => {
    const value = draft.trim().toLowerCase();
    if (!value || addresses.includes(value) || addresses.length >= MAX_ADDRESSES) return addresses;
    const next = [...addresses, value];
    setAddresses(next);
    setDraft('');
    return next;
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    start.mutate(add());
  };
  return (
    <Card className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-5 shrink-0 text-primary" aria-hidden />
          {t('mailTests.title')}
        </CardTitle>
        <CardDescription>{t('mailTests.text')}</CardDescription>
      </div>
      <form onSubmit={submit} className="grid gap-3">
        <Field
          id="mt-address"
          label={t('mailTests.addresses')}
          hint={t('mailTests.addressesHint', { max: MAX_ADDRESSES })}
        >
          <div className="flex gap-2">
            <Input
              id="mt-address"
              type="email"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="name@outlook.de"
              onKeyDown={(e) => {
                if (e.key === ',' || e.key === ' ') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={add}
              disabled={addresses.length >= MAX_ADDRESSES}
            >
              <Plus className="size-4" aria-hidden />
              {t('mailTests.add')}
            </Button>
          </div>
        </Field>
        {addresses.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {addresses.map((address) => (
              <li
                key={address}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-1 pr-1 pl-3 text-[13px]"
              >
                <span className="min-w-0 break-all">{address}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-background"
                  aria-label={t('mailTests.remove', { address })}
                  onClick={() => setAddresses(addresses.filter((a) => a !== address))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
          <Switch checked={spamScore} onCheckedChange={setSpamScore} className="mt-0.5" />
          <span>
            <b className="block text-sm font-semibold">{t('mailTests.spamSwitch')}</b>
            <span className="text-[13px] text-muted-foreground">{t('mailTests.spamHint')}</span>
          </span>
        </label>
        <Button
          type="submit"
          className="w-fit"
          disabled={start.isPending || (!addresses.length && !draft.trim() && !spamScore)}
        >
          <Send className="size-4" aria-hidden />
          {start.isPending ? t('mailTests.sending') : t('mailTests.start')}
        </Button>
      </form>
      {start.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(start.error)}
        </p>
      ) : null}
      {runs?.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">{t('mailTests.history')}</h3>
          <ul className="grid gap-2">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
