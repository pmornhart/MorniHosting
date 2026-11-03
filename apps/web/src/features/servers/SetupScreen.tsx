import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerDetail, SetupStep } from '@mornihosting/shared';
import { DownloadInfo } from '@/components/download-info';
import { ServerIcon } from '@/components/server-visuals';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

const PERCENT = 100;
/** Each step counts the same; the first start fills its share with the server's own progress. */
const START_STEP: SetupStep = 'start';

/**
 * Shown instead of the server panel right after an order, until everything chosen is set up and the server
 * really runs – so nobody changes settings while plugins are still being installed.
 */
export function SetupScreen({ server }: { server: ServerDetail }): ReactElement | null {
  const { t } = useTranslation();
  const setup = server.live.setup;
  if (!setup) return null;
  const steps = [...setup.done, ...setup.pending];
  const current = setup.pending[0] ?? null;
  const startShare = current === START_STEP ? (server.live.progress ?? 0) / PERCENT : 0;
  const percent = Math.round(((setup.done.length + startShare) / Math.max(steps.length, 1)) * PERCENT);
  return (
    <Card className="mx-auto grid w-full max-w-xl gap-5 p-6 sm:p-8">
      <div className="flex items-center gap-4">
        <ServerIcon id={server.id} software={server.software} hasIcon={server.hasIcon} className="mh-hop" />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold [text-wrap:balance]">
            {t('orderSetup.title', { name: server.name })}
          </h1>
          <p className="text-sm text-muted-foreground">{t('orderSetup.text')}</p>
        </div>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between text-sm">
          <b>{current ? t(`orderSetup.steps.${current}`) : t('orderSetup.almost')}</b>
          <span className="tabular font-bold">{percent} %</span>
        </div>
        <Progress value={percent} />
        {current === START_STEP && server.live.download ? (
          <DownloadInfo download={server.live.download} />
        ) : null}
      </div>
      <ol className="grid gap-2.5">
        {steps.map((step) => {
          const done = setup.done.includes(step);
          const running = step === current;
          return (
            <li
              key={step}
              className={cn(
                'flex items-center gap-3 text-[15px]',
                !done && !running && 'text-muted-foreground',
              )}
            >
              {done ? (
                <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
              ) : running ? ( // eslint-disable-line no-nested-ternary -- three states: done, running, waiting
                <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden />
              ) : (
                <Circle className="size-5 shrink-0" aria-hidden />
              )}
              <span className={cn(running && 'font-semibold')}>{t(`orderSetup.steps.${step}`)}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{t('orderSetup.hint')}</p>
    </Card>
  );
}
