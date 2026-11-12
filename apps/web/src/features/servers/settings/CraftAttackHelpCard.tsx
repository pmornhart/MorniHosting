import { useQuery } from '@tanstack/react-query';
import { Feather } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CRAFT_ATTACK_COMMANDS } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { CommandGroups } from '@/features/public/command-groups';
import { api } from '@/lib/api';

/**
 * All commands players have on a Craft Attack server – the same list as /info in the game. Each player also gets
 * a personal page (link in /info) that shows only what they may use.
 */
export function CraftAttackHelpCard({ serverId }: { serverId: string }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('en') ? 'en' : 'de';
  const { data } = useQuery({
    queryKey: ['craftattack', serverId],
    queryFn: () => api<{ active: boolean; slug: string | null }>(`/api/servers/${serverId}/craftattack`),
  });
  if (!data?.active) return null;
  const plain = CRAFT_ATTACK_COMMANDS.flatMap((g) => [
    `${g.title[lang]}:`,
    ...g.commands.map((c) => `  ${c.use[lang]} – ${c.text[lang]}`),
  ]).join('\n');
  const page = `${window.location.origin}/befehle/${data.slug ?? ''}/`;
  return (
    <Card fold="craftattack-help" className="grid gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/12 text-primary">
          <Feather className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle>{t('craftAttackHelp.title')}</CardTitle>
          <CardDescription>{t('craftAttackHelp.text')}</CardDescription>
        </div>
      </div>
      <div className="grid gap-1 rounded-[12px] border border-primary/30 bg-primary/8 p-3 text-[13px]">
        <b>{t('craftAttackHelp.personal')}</b>
        <span className="text-muted-foreground">{t('craftAttackHelp.personalText')}</span>
        <code className="break-all font-mono text-[12.5px] text-primary">
          {page}
          {t('craftAttackHelp.playerName')}
        </code>
      </div>
      <CommandGroups lang={lang} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
        <span>{t('craftAttackHelp.ingame')}</span>
        <CopyButton text={plain} label={t('craftAttackHelp.copy')} showLabel variant="outline" size="sm" />
      </div>
    </Card>
  );
}
