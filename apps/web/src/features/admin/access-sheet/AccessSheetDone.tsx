import { CheckCircle2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AccessSheetButton, type AccessSheetPerson } from './AccessSheetButton';

const LANGUAGES = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
] as const;

/** Shown once a password is set: the login data and the access sheet as a PDF, in the person's language. */
export function AccessSheetDone({
  person,
  password,
  onClose,
  title,
  text,
}: {
  person: AccessSheetPerson;
  password: string;
  onClose: () => void;
  title?: string;
  text?: string;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [lang, setLang] = useState(i18n.resolvedLanguage === 'en' ? 'en' : 'de');
  const name = person.displayName || person.username;
  return (
    <>
      <DialogTitle className="flex items-center gap-2">
        <CheckCircle2 className="size-5 text-success" aria-hidden />
        {title ?? t('accessSheet.doneTitle', { name })}
      </DialogTitle>
      <DialogDescription>{text ?? t('accessSheet.doneText')}</DialogDescription>
      <dl className="grid gap-2 rounded-[12px] bg-secondary p-4 text-sm">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <dt className="text-muted-foreground">{t('accessSheet.username')}</dt>
          <dd className="flex min-w-0 items-center gap-1 font-mono font-semibold">
            <span className="truncate">{person.username}</span>
            <CopyButton text={person.username} />
          </dd>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <dt className="text-muted-foreground">{t('accessSheet.password')}</dt>
          <dd className="flex min-w-0 items-center gap-1 font-mono font-semibold">
            <span className="break-all">{password}</span>
            <CopyButton text={password} />
          </dd>
        </div>
      </dl>
      <div className="grid gap-2 rounded-[12px] border border-border p-4">
        <b className="text-sm font-semibold">{t('accessSheet.sheetTitle')}</b>
        <span className="text-[13px] text-muted-foreground">{t('accessSheet.sheetText')}</span>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Select value={lang} onValueChange={setLang}>
            <SelectTrigger className="w-36" aria-label={t('accessSheet.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AccessSheetButton person={person} password={password} lang={lang} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('accessSheet.close', { name })}
        </Button>
      </DialogFooter>
    </>
  );
}
