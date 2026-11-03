import { useMutation } from '@tanstack/react-query';
import { Download, PackageOpen, PackagePlus, Upload } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { TRANSFER_PASSWORD_MIN, type TransferCode, type TransferResult } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

/** After the restart the panel needs a moment before it answers again. */
const RELOAD_AFTER_MS = 12000;
const CODE_ROWS = 5;

function saveAsFile(code: string): void {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mornihosting-umzug.txt';
  link.click();
  URL.revokeObjectURL(url);
}

/** Old panel: one code with every setting and connection, locked with a password. */
function MakeCode(): ReactElement {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const make = useMutation({
    mutationFn: () => api<TransferCode>('/api/transfer/export', { method: 'POST', body: { password } }),
    onError: () => undefined,
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    make.mutate();
  };
  return (
    <Card fold="transfer-out" foldOpen className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <PackagePlus className="size-5 shrink-0 text-primary" aria-hidden />
          {t('transfer.makeTitle')}
        </CardTitle>
        <CardDescription>{t('transfer.makeText')}</CardDescription>
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Field
          id="tr-make-pw"
          label={t('transfer.password')}
          hint={t('transfer.passwordHint')}
          className="min-w-0 flex-1"
        >
          <Input
            id="tr-make-pw"
            type="password"
            autoComplete="new-password"
            minLength={TRANSFER_PASSWORD_MIN}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={password.length < TRANSFER_PASSWORD_MIN || make.isPending}>
          {t('transfer.make')}
        </Button>
      </form>
      {make.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(make.error)}
        </p>
      ) : null}
      {make.data ? (
        <div className="grid gap-3">
          <textarea
            readOnly
            rows={CODE_ROWS}
            value={make.data.code}
            aria-label={t('transfer.code')}
            className="w-full min-w-0 resize-none break-all rounded-[12px] border bg-secondary p-3 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap gap-2">
            <CopyButton
              text={make.data.code}
              label={t('transfer.copy')}
              variant="default"
              size="default"
              showLabel
            />
            <Button variant="outline" onClick={() => saveAsFile(make.data.code)}>
              <Download />
              {t('transfer.save')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('transfer.makeDone')}</p>
        </div>
      ) : null}
    </Card>
  );
}

/** New panel: paste the code (or open the file), type the password, done. */
function UseCode(): ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const redeem = useMutation({
    mutationFn: () =>
      api<TransferResult>('/api/transfer/import', { method: 'POST', body: { code, password } }),
    onSuccess: (result) => {
      if (result.restarting) window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    },
    onError: () => undefined,
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    redeem.mutate();
  };
  const readFile = async (file: File | undefined): Promise<void> => {
    if (file) setCode((await file.text()).trim());
  };
  return (
    <Card fold="transfer-in" className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <PackageOpen className="size-5 shrink-0 text-primary" aria-hidden />
          {t('transfer.useTitle')}
        </CardTitle>
        <CardDescription>{t('transfer.useText')}</CardDescription>
      </div>
      {redeem.data ? (
        <p className="rounded-[12px] bg-success-soft px-3 py-2.5 text-sm">
          {redeem.data.restarting ? t('transfer.doneRestart') : t('transfer.done')}
        </p>
      ) : (
        <form className="grid gap-3" onSubmit={submit}>
          <Field id="tr-code" label={t('transfer.code')}>
            <textarea
              id="tr-code"
              rows={CODE_ROWS}
              value={code}
              placeholder="MH1-…"
              onChange={(e) => setCode(e.target.value)}
              className="w-full min-w-0 resize-none break-all rounded-[12px] border bg-background p-3 font-mono text-xs"
            />
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 justify-self-start text-sm text-primary">
            <Upload className="size-4" aria-hidden />
            {t('transfer.openFile')}
            <input
              type="file"
              accept=".txt,text/plain"
              className="sr-only"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </label>
          <Field id="tr-use-pw" label={t('transfer.password')}>
            <Input
              id="tr-use-pw"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <p className="text-sm text-muted-foreground">{t('transfer.warning')}</p>
          {redeem.error ? (
            <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              {errorText(redeem.error)}
            </p>
          ) : null}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={!code.trim() || password.length < TRANSFER_PASSWORD_MIN || redeem.isPending}
          >
            {t('transfer.use')}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function TransferSection(): ReactElement {
  return (
    <>
      <MakeCode />
      <UseCode />
    </>
  );
}
