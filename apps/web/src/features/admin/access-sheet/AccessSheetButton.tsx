import { useQuery } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { PanelSettings } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { buildAccessSheet, downloadPdf, type AccessSheetTexts } from './build';

export interface AccessSheetPerson {
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly canCreateServers: boolean;
}

/** Which "your servers" step fits: admins set up everything, others order servers or join a team. */
function serversStep(person: AccessSheetPerson): 'admin' | 'create' | 'team' {
  if (person.isAdmin) return 'admin';
  return person.canCreateServers ? 'create' : 'team';
}

/** The panel's public address: the domain from the admin area, otherwise the address in the browser. */
function usePanelAddress(): string {
  const { data } = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api<PanelSettings>('/api/settings'),
    retry: false,
  });
  return data?.panelDomain ? `https://${data.panelDomain}` : window.location.origin;
}

/** Downloads the access sheet (PDF) for someone, while their password is still known. */
export function AccessSheetButton({
  person,
  password,
  lang,
}: {
  person: AccessSheetPerson;
  password: string;
  lang: string;
}): ReactElement {
  const { t: own, i18n } = useTranslation();
  const address = usePanelAddress();
  const [busy, setBusy] = useState(false);
  const make = async (): Promise<void> => {
    const t = i18n.getFixedT(lang);
    const name = person.displayName || person.username;
    const serversKey = serversStep(person);
    const texts: AccessSheetTexts = {
      brandTag: t('accessSheet.brandTag'),
      welcome: t('accessSheet.welcome', { name }),
      intro: t('accessSheet.intro'),
      dataTitle: t('accessSheet.dataTitle'),
      address: t('accessSheet.address'),
      username: t('accessSheet.username'),
      password: t('accessSheet.password'),
      email: t('accessSheet.email'),
      qrHint: t('accessSheet.qrHint'),
      stepsTitle: t('accessSheet.stepsTitle'),
      steps: [
        { title: t('accessSheet.steps.open.title'), text: t('accessSheet.steps.open.text', { address }) },
        { title: t('accessSheet.steps.login.title'), text: t('accessSheet.steps.login.text') },
        { title: t('accessSheet.steps.secure.title'), text: t('accessSheet.steps.secure.text') },
        {
          title: t(`accessSheet.steps.servers.${serversKey}.title`),
          text: t(`accessSheet.steps.servers.${serversKey}.text`),
        },
      ],
      javaTitle: t('accessSheet.javaTitle'),
      javaText: t('accessSheet.javaText'),
      bedrockTitle: t('accessSheet.bedrockTitle'),
      bedrockText: t('accessSheet.bedrockText'),
      warning: t('accessSheet.warning'),
      footer: t('accessSheet.footer', { date: formatDateTime(new Date().toISOString()), address }),
    };
    setBusy(true);
    try {
      const bytes = await buildAccessSheet({
        address,
        username: person.username,
        password,
        email: person.email,
        texts,
      });
      downloadPdf(bytes, `${t('accessSheet.fileName')}-${person.username}.pdf`);
    } catch {
      toast.error(own('accessSheet.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" onClick={() => void make()} disabled={busy}>
      <FileDown aria-hidden />
      {own('accessSheet.download')}
    </Button>
  );
}
