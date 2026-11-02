import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  Blocks,
  Globe,
  LogIn,
  Plus,
  Puzzle,
  Rocket,
  ShieldCheck,
  Upload,
  UserPlus,
  Zap,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { GAME_IDS } from '@mornihosting/shared';
import { GameCard } from '@/components/game-card';
import { BrandMark } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { statusQuery } from './session';

/** The games on offer, like a hoster's shop: Java, Bedrock and both together (Geyser). */
// Minecraft first, then every other game from the catalog.
const GAMES = ['java', 'bedrock', 'crossplay', ...GAME_IDS] as const;

const FEATURES = [
  { key: 'mods', icon: Puzzle },
  { key: 'worlds', icon: Upload },
  { key: 'subdomain', icon: Globe },
  { key: 'backups', icon: Archive },
] as const;

const PERKS = [
  { key: 'instant', icon: Rocket },
  { key: 'panel', icon: Blocks },
  { key: 'secure', icon: ShieldCheck },
  { key: 'fast', icon: Zap },
] as const;

/**
 * The public front page: what MorniHosting offers, the games to start with and the sign-in card. Opening
 * mornihosting.de (or any server name below it) lands here until someone is signed in.
 */
export function LandingLayout({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: status } = useQuery(statusQuery);
  const domain = status?.panelDomain || t('landing.exampleDomain');
  const focusLogin = (from?: string): void => {
    if (from) navigate(location.pathname, { replace: true, state: { from } });
    document.getElementById('username')?.focus();
    document.getElementById('login-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-4 py-3">
          <span className="flex items-center gap-2.5 text-lg font-extrabold tracking-[-0.01em]">
            <BrandMark className="size-8" />
            <span>
              MORNI<span className="font-semibold text-muted-foreground">HOSTING</span>
            </span>
          </span>
          <span className="flex-1" />
          <Button variant="ghost" aria-label={t('landing.signIn')} onClick={() => focusLogin()}>
            <LogIn />
            <span className="hidden sm:inline">{t('landing.signIn')}</span>
          </Button>
          {status?.mail.registration ? (
            <Button asChild aria-label={t('landing.requestAccount')}>
              <Link to="/register">
                <UserPlus />
                <span className="hidden sm:inline">{t('landing.requestAccount')}</span>
              </Link>
            </Button>
          ) : (
            <Button aria-label={t('landing.createServer')} onClick={() => focusLogin('/servers/new')}>
              <Plus />
              <span className="hidden sm:inline">{t('landing.createServer')}</span>
            </Button>
          )}
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,color-mix(in_oklab,var(--primary)_28%,transparent),transparent_55%),radial-gradient(ellipse_at_90%_80%,color-mix(in_oklab,var(--primary)_14%,transparent),transparent_50%)]"
        />
        <div className="relative mx-auto grid max-w-[1180px] items-center gap-10 px-4 py-12 md:grid-cols-[minmax(0,1fr)_420px] md:py-20">
          <div className="grid gap-5">
            <div className="flex min-w-0 items-center gap-4">
              <BrandMark className="hidden size-20 shrink-0 drop-shadow-xl sm:block" />
              <div>
                <h1 className="text-[clamp(28px,8vw,48px)] font-extrabold tracking-[-0.03em]">
                  MORNIHOSTING
                </h1>
                <p className="text-lg font-semibold text-muted-foreground sm:text-xl">
                  {t('landing.tagline')}
                </p>
              </div>
            </div>
            <p className="max-w-[56ch] text-base text-muted-foreground">{t('landing.text', { domain })}</p>
            <ul className="flex flex-wrap gap-2">
              {PERKS.map(({ key, icon: Icon }) => (
                <li
                  key={key}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-card/70 px-3 py-1.5 text-[13px]"
                >
                  <Icon className="size-4 text-primary" aria-hidden />
                  {t(`landing.perks.${key}`)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {status?.mail.registration ? (
                <Button asChild size="lg">
                  <Link to="/register">
                    <UserPlus />
                    {t('landing.requestAccount')}
                  </Link>
                </Button>
              ) : null}
              <Button
                size="lg"
                variant={status?.mail.registration ? 'secondary' : 'default'}
                onClick={() => document.getElementById('games')?.scrollIntoView({ behavior: 'smooth' })}
              >
                {t('landing.showGames')}
              </Button>
            </div>
          </div>
          <div id="login-card" className="rounded-[18px] border border-border bg-card p-6 shadow-card sm:p-8">
            {children}
          </div>
        </div>
      </section>

      <section id="games" className="mx-auto grid max-w-[1180px] scroll-mt-20 gap-6 px-4 py-12">
        <div>
          <h2 className="text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl">
            {t('landing.gamesTitle')}
          </h2>
          <p className="mt-1 text-muted-foreground">{t('landing.gamesText')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {GAMES.map((g) => (
            <GameCard key={g} game={g} onStart={() => focusLogin(`/servers/new?game=${g}`)} />
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-[1180px] gap-6 px-4 py-12">
        <h2 className="text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl">
          {t('landing.featuresTitle')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon }) => (
            <article
              key={key}
              className="grid content-start gap-3 rounded-[16px] border border-border bg-card p-5"
            >
              <span className="grid size-11 place-items-center rounded-[12px] bg-accent text-primary">
                <Icon aria-hidden />
              </span>
              <h3 className="font-bold">{t(`landing.features.${key}.title`)}</h3>
              <p className="text-sm text-muted-foreground">{t(`landing.features.${key}.text`, { domain })}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        MorniHosting · {t('landing.footer')} · Verfasst mit Claude 🤖
      </footer>
    </div>
  );
}
