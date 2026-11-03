import { ForcePasswordDialog } from '@/features/auth/ForcePasswordDialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Inbox,
  Bell,
  ChevronsUpDown,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Plus,
  ScrollText,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { SOFTWARE, type MeResponse, type Theme } from '@mornihosting/shared';
import { ALL_SERVERS, BrandMark, PlayerHead, ServerIcon } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { versionLabel } from '@/lib/format';
import { disconnect } from '@/lib/ws';
import { setLanguage } from '@/i18n';
import { meQuery, useSession } from '@/features/auth/session';
import { useLiveSync, useServers } from '@/features/servers/live';
import { applyTheme, useResolvedTheme } from './theme';
import { VersionBadge } from './VersionBadge';
import { approvalsQuery } from '@/features/approvals/ApprovalsPage';
import { UpdateCard } from './UpdateCard';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof LayoutGrid;
  readonly show: boolean;
  readonly end?: boolean;
  /** Small number next to the entry (open approvals). */
  readonly badge?: number;
}

function useNavItems(): { main: NavItem[]; admin: NavItem[] } {
  const { t } = useTranslation();
  const { me } = useSession();
  const admin = me.user.isAdmin;
  const { data: approvals } = useQuery({ ...approvalsQuery, enabled: admin });
  const pendingCount =
    (approvals?.users.length ?? 0) + (approvals?.requests.filter((r) => r.status === 'pending').length ?? 0);
  return {
    main: [
      { to: '/', label: t('nav.overview'), icon: LayoutGrid, show: true, end: true },
      {
        to: '/servers/new',
        label: me.user.canCreateServers ? t('nav.createServer') : t('nav.requestServer'),
        icon: Plus,
        show: true,
      },
    ],
    admin: [
      { to: '/approvals', label: t('nav.approvals'), icon: Inbox, show: admin, badge: pendingCount },
      { to: '/users', label: t('nav.users'), icon: Users, show: admin },
      { to: '/notifications', label: t('nav.notifications'), icon: Bell, show: admin },
      { to: '/settings', label: t('nav.settings'), icon: ShieldCheck, show: admin },
      { to: '/audit', label: t('nav.audit'), icon: ScrollText, show: admin },
    ],
  };
}

function NavList({ onNavigate }: { onNavigate?: () => void }): ReactElement {
  const { t } = useTranslation();
  const { main, admin } = useNavItems();
  const link = (item: NavItem): ReactElement => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'mh-wiggle flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]',
          isActive && 'bg-accent text-foreground [&_svg]:text-primary',
        )
      }
    >
      <item.icon aria-hidden />
      <span className="flex-1">{item.label}</span>
      {item.badge ? (
        <span className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
          {item.badge}
        </span>
      ) : null}
    </NavLink>
  );
  const adminItems = admin.filter((i) => i.show);
  return (
    <nav aria-label={t('nav.main')} className="grid gap-0.5">
      {main.filter((i) => i.show).map(link)}
      {adminItems.length ? (
        <div className="px-2.5 pb-1.5 pt-4 text-xs text-muted-foreground">{t('nav.administration')}</div>
      ) : null}
      {adminItems.map(link)}
    </nav>
  );
}

function ServerSwitcher({ onNavigate }: { onNavigate?: () => void }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { serverId } = useParams();
  const { data: servers = [] } = useServers();
  const current = servers.find((s) => s.id === serverId);
  const running = servers.filter((s) => s.live.state === 'running').length;
  const go = (path: string): void => {
    navigate(path);
    onNavigate?.();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('nav.chooseServer')}
          className="flex w-full min-w-0 items-center gap-2.5 rounded-[10px] border border-border bg-secondary px-2.5 py-2 text-left hover:bg-muted"
        >
          {current ? (
            <ServerIcon
              id={current.id}
              software={current.software}
              hasIcon={current.hasIcon}
              className="size-8 rounded-[8px]"
            />
          ) : (
            <ServerIcon id={ALL_SERVERS} software="all" hasIcon={false} className="size-8" />
          )}
          <span className="min-w-0 flex-1">
            <b className="block truncate text-sm font-semibold">{current?.name ?? t('nav.allServers')}</b>
            <span className="block truncate text-xs text-muted-foreground">
              {current
                ? `${SOFTWARE[current.software].label} ${versionLabel(current.software, current.version)}`
                : t('nav.serversRunning', { total: servers.length, running })}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60">
        <DropdownMenuItem onSelect={() => go('/')}>
          <LayoutGrid />
          {t('nav.allServers')}
        </DropdownMenuItem>
        {servers.length ? <DropdownMenuSeparator /> : null}
        {servers.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => go(`/servers/${s.id}`)}>
            <ServerIcon
              id={s.id}
              software={s.software}
              hasIcon={s.hasIcon}
              className="size-6 rounded-[6px]"
            />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span
              aria-label={t(`states.${s.live.state}`)}
              className={cn(
                'size-2 shrink-0 rounded-full',
                s.live.state === 'running' && 'bg-success',
                ['starting', 'stopping', 'installing'].includes(s.live.state) && 'bg-warning',
                s.live.state === 'crashed' && 'bg-destructive',
                s.live.state === 'stopped' && 'bg-muted-foreground/50',
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ me }: { me: MeResponse }): ReactElement {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saveAccount = useMutation({
    mutationFn: (patch: { theme?: Theme; locale?: 'de' | 'en' }) =>
      api<MeResponse>('/api/account', { method: 'PATCH', body: patch }),
    onSuccess: (next) => queryClient.setQueryData(meQuery.queryKey, next),
  });
  const logout = useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      disconnect();
      queryClient.clear();
      navigate('/login');
    },
  });
  const resolved = useResolvedTheme();
  // One click switches between light and dark; the menu still offers "like the system".
  const toggleTheme = (): void => {
    const theme: Theme = resolved === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    saveAccount.mutate({ theme });
  };
  const ToggleIcon = resolved === 'dark' ? Sun : Moon;
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-secondary"
          >
            {/* The linked Minecraft account's head; without one a drawn face, never a stranger's skin. */}
            <PlayerHead
              name={me.user.minecraft?.name ?? me.user.username}
              skin={me.user.minecraft?.uuid ?? null}
              className="size-8 rounded-[8px]"
            />
            <span className="min-w-0 flex-1 text-[13px] leading-tight">
              <b className="block truncate">{me.user.displayName}</b>
              <span className="text-muted-foreground">
                {me.user.isAdmin ? t('nav.administrator') : t('nav.member')}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuItem onSelect={() => navigate('/account')}>
            <UserRound />
            {t('nav.account')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('nav.theme')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={me.user.theme}
            onValueChange={(value) => {
              const theme = value as Theme; // the radio values below are exactly the Theme members
              applyTheme(theme);
              saveAccount.mutate({ theme });
            }}
          >
            <DropdownMenuRadioItem value="dark">{t('theme.dark')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">{t('theme.light')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">{t('theme.system')}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={i18n.language}
            onValueChange={(value) => {
              const locale = value === 'en' ? 'en' : 'de';
              setLanguage(locale);
              saveAccount.mutate({ locale });
            }}
          >
            <DropdownMenuRadioItem value="de">Deutsch</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => logout.mutate()}>
            <LogOut />
            {t('nav.logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggleTheme}
        aria-label={resolved === 'dark' ? t('theme.toLight') : t('theme.toDark')}
        title={resolved === 'dark' ? t('theme.toLight') : t('theme.toDark')}
      >
        <ToggleIcon />
      </Button>
    </div>
  );
}

function Brand(): ReactElement {
  return (
    <NavLink to="/" className="flex items-center gap-2.5 px-2 text-[17px] font-extrabold tracking-[-0.01em]">
      <BrandMark />
      MorniHosting
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }): ReactElement {
  const { me } = useSession();
  return (
    <div className="flex h-full flex-col gap-[18px] px-3.5 py-5">
      <Brand />
      <ServerSwitcher onNavigate={onNavigate} />
      <NavList onNavigate={onNavigate} />
      <div className="mt-auto grid gap-2.5">
        {me.user.isAdmin ? <UpdateCard /> : null}
        <UserMenu me={me} />
        <VersionBadge onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export function AppShell(): ReactElement {
  const { t } = useTranslation();
  const connected = useLiveSync();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid min-h-dvh lg:grid-cols-[252px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh overflow-y-auto bg-sidebar lg:block">
        <SidebarContent />
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <div className="ml-auto" />
        <SheetPrimitive.Root open={open} onOpenChange={setOpen}>
          <SheetPrimitive.Trigger asChild>
            <Button variant="secondary" size="icon" aria-label={t('nav.menu')}>
              <Menu />
            </Button>
          </SheetPrimitive.Trigger>
          <SheetPrimitive.Portal>
            <SheetPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
            <SheetPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-[min(300px,85vw)] overflow-y-auto bg-sidebar shadow-float data-[state=open]:animate-in data-[state=open]:slide-in-from-left">
              <SheetPrimitive.Title className="sr-only">{t('nav.main')}</SheetPrimitive.Title>
              <SheetPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-3 top-4"
                  aria-label={t('common.close')}
                >
                  <X />
                </Button>
              </SheetPrimitive.Close>
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetPrimitive.Content>
          </SheetPrimitive.Portal>
        </SheetPrimitive.Root>
      </header>

      <main className="min-w-0">
        {!connected ? (
          <div
            className="flex items-center gap-2 bg-warning-soft px-4 py-2 text-sm text-foreground sm:px-8"
            role="status"
          >
            <WifiOff className="size-4 text-warning" />
            {t('common.connectionLost')}
          </div>
        ) : null}
        <div className="mx-auto grid max-w-[1440px] content-start gap-[22px] px-4 py-6 sm:px-8 sm:py-7">
          <Outlet />
        </div>
      </main>
      <ForcePasswordDialog />
    </div>
  );
}
