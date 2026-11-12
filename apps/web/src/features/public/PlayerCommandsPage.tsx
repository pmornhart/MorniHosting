import { useQuery } from '@tanstack/react-query';
import { Home, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import type { CraftAttackPlayerCommands } from '@mornihosting/shared';
import { BrandMark, PlayerHead } from '@/components/server-visuals';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { setLanguage } from '@/i18n';
import { api } from '@/lib/api';
import { CommandGroups } from './command-groups';

/**
 * The personal command page of a Craft Attack player, opened from the link /info shows in the game
 * (`/befehle/<server>/<name>`): the panel checks what this player may use – OP or not, whitelist – and shows it.
 * No login, no typing the name.
 */
export function PlayerCommandsPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const { slug = '', name = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['public-commands', slug, name],
    queryFn: () =>
      api<CraftAttackPlayerCommands>(
        `/api/public/commands/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`,
      ),
  });
  const locale = data?.locale;
  useEffect(() => {
    if (locale) setLanguage(locale);
  }, [locale]);
  const lang = i18n.language.startsWith('en') ? 'en' : 'de';

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 text-center">
        <div className="grid gap-3">
          <BrandMark className="mx-auto size-12" />
          <h1 className="text-xl font-bold">{t('playerCommands.missing')}</h1>
          <p className="text-sm text-muted-foreground">{t('playerCommands.missingText')}</p>
        </div>
      </main>
    );
  }
  return (
    <main className="min-h-dvh bg-background px-4 py-8">
      <div className="mx-auto grid max-w-3xl gap-5">
        {data ? (
          <Card className="flex flex-wrap items-center gap-4 p-5">
            <PlayerHead
              name={data.name}
              skin={data.uuid && !data.bedrock ? data.uuid : undefined}
              className="size-16 rounded-[12px]"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {data.server}
              </p>
              <h1 className="truncate text-2xl font-bold">
                {t('playerCommands.title', { name: data.name })}
              </h1>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {data.online ? (
                  <Pill tone="ok" ping>
                    {t('playerCommands.online')}
                  </Pill>
                ) : null}
                {data.op ? (
                  <Pill tone="warn">
                    <ShieldCheck className="size-3.5" aria-hidden /> {t('playerCommands.op')}
                  </Pill>
                ) : null}
                {data.bedrock ? <Pill tone="neutral">Bedrock</Pill> : null}
              </div>
            </div>
          </Card>
        ) : (
          <Skeleton className="h-28" />
        )}
        {data?.locked ? (
          <Card className="flex items-start gap-3 border-destructive/40 p-4 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span>{t('playerCommands.locked')}</span>
          </Card>
        ) : null}
        {data && !data.known ? (
          <p className="text-sm text-muted-foreground">{t('playerCommands.unknown')}</p>
        ) : null}
        {data?.homes.length ? (
          <Card className="grid gap-2 p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <Home className="size-4 text-primary" aria-hidden />
              {t('playerCommands.homes')}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {data.homes.map((home) => (
                <code key={home} className="rounded-[6px] bg-secondary px-2 py-0.5 font-mono text-[12.5px]">
                  /home {home}
                </code>
              ))}
            </div>
          </Card>
        ) : null}
        {data ? (
          <Card className="grid gap-3 p-5">
            <h2 className="text-base font-bold">
              {data.op ? t('playerCommands.allYours') : t('playerCommands.yours')}
            </h2>
            <CommandGroups
              lang={lang}
              bedrock={data.bedrock}
              allowed={(opOnly) => !data.locked && (data.op || !opOnly)}
            />
          </Card>
        ) : (
          <Skeleton className="h-96" />
        )}
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <BrandMark className="size-4" /> MorniHosting
        </p>
      </div>
    </main>
  );
}
