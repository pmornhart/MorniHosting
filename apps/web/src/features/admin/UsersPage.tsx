import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, KeyRound, MoreHorizontal, Pencil, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { RoleEntry, UserListEntry } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, PageHeader } from '@/components/page';
import { ServerIcon } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/misc';
import { Pill, Tag } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { AccessSheetDone } from './access-sheet/AccessSheetDone';
import type { AccessSheetPerson } from './access-sheet/AccessSheetButton';
import { api } from '@/lib/api';
import { startPassword } from '@/lib/start-password';
import { formatRelative } from '@/lib/format';
import { Monogram } from '@/components/art';
import { cn } from '@/lib/utils';
import { useSession } from '@/features/auth/session';
import { serversQuery } from '@/features/servers/live';

const NO_ACCESS = 'none';
const PASSWORD_MIN = 10;

function roleLabel(role: RoleEntry, t: (key: string) => string): string {
  return role.builtIn ? t(`roles.builtin.${role.name}`) : role.name;
}

/* ---------- Users ---------- */

interface UserDraft {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly isAdmin: boolean;
  readonly canCreateServers: boolean;
}

function UserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserListEntry | null;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const empty: UserDraft = {
    username: '',
    displayName: '',
    email: '',
    password: '',
    isAdmin: false,
    canCreateServers: false,
  };
  const [draft, setDraft] = useState<UserDraft>(empty);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<{ person: AccessSheetPerson; password: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setDone(null);
    setShown(false);
    setDraft(
      user
        ? {
            username: user.username,
            displayName: user.displayName,
            email: user.email ?? '',
            password: '',
            isAdmin: user.isAdmin,
            canCreateServers: user.canCreateServers,
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open, user]);
  const save = useMutation({
    mutationFn: () =>
      user
        ? api<UserListEntry>(`/api/users/${user.id}`, {
            method: 'PATCH',
            body: {
              displayName: draft.displayName,
              email: draft.email.trim() || null,
              isAdmin: draft.isAdmin,
              canCreateServers: draft.canCreateServers,
              ...(draft.password ? { password: draft.password } : {}),
            },
          })
        : api<UserListEntry>('/api/users', {
            method: 'POST',
            body: {
              username: draft.username.trim(),
              displayName: draft.displayName.trim() || undefined,
              email: draft.email.trim() || undefined,
              password: draft.password,
              isAdmin: draft.isAdmin,
              canCreateServers: draft.canCreateServers,
            },
          }),
    onSuccess: async (saved) => {
      toast.success(t('users.saved', { name: saved.displayName || saved.username }));
      // While the password is still known, offer the access sheet; otherwise there is nothing left to show.
      if (draft.password) setDone({ person: saved, password: draft.password });
      else onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const set = (patch: Partial<UserDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const passwordOk = user
    ? !draft.password || draft.password.length >= PASSWORD_MIN
    : draft.password.length >= PASSWORD_MIN;
  const valid = (user !== null || draft.username.trim().length >= 3) && passwordOk; // eslint-disable-line ts-patterns/no-magic-numbers -- same minimum as the server's username rule
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) save.mutate();
  };
  if (done)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <AccessSheetDone
            person={done.person}
            password={done.password}
            onClose={() => onOpenChange(false)}
          />
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          {user ? t('users.editTitle', { name: user.username }) : t('users.newTitle')}
        </DialogTitle>
        <DialogDescription>{user ? t('users.editText') : t('users.newText')}</DialogDescription>
        <form onSubmit={submit} className="grid gap-4">
          {user ? null : (
            <Field id="u-name" label={t('users.username')} hint={t('users.usernameHint')}>
              <Input
                id="u-name"
                value={draft.username}
                autoComplete="off"
                onChange={(e) => set({ username: e.target.value })}
              />
            </Field>
          )}
          <Field id="u-display" label={t('users.displayName')}>
            <Input
              id="u-display"
              value={draft.displayName}
              maxLength={40}
              onChange={(e) => set({ displayName: e.target.value })}
            />
          </Field>
          <Field id="u-email" label={t('users.email')} hint={t('users.emailHint')}>
            <Input
              id="u-email"
              type="email"
              value={draft.email}
              autoComplete="off"
              onChange={(e) => set({ email: e.target.value })}
            />
          </Field>
          <Field
            id="u-password"
            label={user ? t('users.newPassword') : t('users.password')}
            hint={user ? t('users.newPasswordHint') : t('users.passwordHint')}
          >
            <div className="flex gap-2">
              <Input
                id="u-password"
                type={shown ? 'text' : 'password'}
                autoComplete="new-password"
                className={shown ? 'font-mono' : undefined}
                value={draft.password}
                onChange={(e) => set({ password: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  set({ password: startPassword() });
                  setShown(true);
                }}
              >
                <Dices aria-hidden />
                {t('users.generatePassword')}
              </Button>
            </div>
          </Field>
          <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
            <Switch
              checked={draft.isAdmin}
              onCheckedChange={(on) => set({ isAdmin: on })}
              className="mt-0.5"
            />
            <span>
              <b className="block text-sm font-semibold">{t('users.isAdmin')}</b>
              <span className="text-[13px] text-muted-foreground">{t('users.isAdminHint')}</span>
            </span>
          </label>
          {draft.isAdmin ? null : (
            <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
              <Switch
                checked={draft.canCreateServers}
                onCheckedChange={(on) => set({ canCreateServers: on })}
                className="mt-0.5"
              />
              <span>
                <b className="block text-sm font-semibold">{t('users.canCreate')}</b>
                <span className="text-[13px] text-muted-foreground">{t('users.canCreateHint')}</span>
              </span>
            </label>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {user ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({
  user,
  roles,
  onOpenChange,
}: {
  user: UserListEntry | null;
  roles: readonly RoleEntry[];
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: servers } = useQuery(serversQuery);
  const [access, setAccess] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (user) setAccess(Object.fromEntries(user.access.map((a) => [a.serverId, a.roleId])));
  }, [user]);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/users/${user?.id}/access`, {
        method: 'PUT',
        body: { access: Object.entries(access).map(([serverId, roleId]) => ({ serverId, roleId })) },
      }),
    onSuccess: async () => {
      toast.success(t('users.accessSaved'));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogTitle>{t('users.accessTitle', { name: user?.displayName || user?.username })}</DialogTitle>
        <DialogDescription>
          {user?.isAdmin ? t('users.accessAdmin') : t('users.accessText')}
        </DialogDescription>
        {(servers ?? []).length ? (
          <ul className="grid max-h-[50dvh] gap-2 overflow-y-auto">
            {(servers ?? []).map((server) => (
              <li
                key={server.id}
                className="flex flex-wrap items-center gap-3 rounded-[12px] border border-border px-3 py-2"
              >
                <ServerIcon
                  id={server.id}
                  software={server.software}
                  hasIcon={server.hasIcon}
                  className="size-9 rounded-[9px]"
                />
                <b className="min-w-0 flex-1 truncate text-sm font-semibold">{server.name}</b>
                <Select
                  value={String(access[server.id] ?? NO_ACCESS)}
                  onValueChange={(v) =>
                    setAccess((prev) =>
                      v === NO_ACCESS
                        ? Object.fromEntries(Object.entries(prev).filter(([id]) => id !== server.id))
                        : { ...prev, [server.id]: Number(v) },
                    )
                  }
                  disabled={user?.isAdmin}
                >
                  <SelectTrigger className="w-52" aria-label={t('users.roleFor', { server: server.name })}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ACCESS}>{t('users.noAccess')}</SelectItem>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {roleLabel(r, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('users.noServers')}</p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={save.isPending || user?.isAdmin} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UsersList({ roles }: { roles: readonly RoleEntry[] }): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ user: UserListEntry | null } | null>(null);
  const [accessFor, setAccessFor] = useState<UserListEntry | null>(null);
  const [deleting, setDeleting] = useState<UserListEntry | null>(null);
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserListEntry[]>('/api/users'),
  });
  const { data: servers } = useQuery(serversQuery);
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['users'] });
  const toggle = useMutation({
    mutationFn: ({ user, disabled }: { user: UserListEntry; disabled: boolean }) =>
      api(`/api/users/${user.id}`, { method: 'PATCH', body: { disabled } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (user: UserListEntry) => api(`/api/users/${user.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const roleName = (id: number): string => {
    const role = roles.find((r) => r.id === id);
    return role ? roleLabel(role, t) : '?';
  };
  const serverName = (id: string): string => servers?.find((s) => s.id === id)?.name ?? id;

  if (!users) return <Skeleton className="h-64 rounded-[16px]" />;
  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setEditing({ user: null })}>
          <UserPlus />
          {t('users.new')}
        </Button>
      </div>
      <Card className="divide-y divide-border overflow-hidden">
        {users.map((user) => (
          <div
            key={user.id}
            className={cn('flex flex-wrap items-center gap-3 px-4 py-3', user.disabled && 'opacity-60')}
          >
            <Monogram name={user.displayName || user.username} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <b className="truncate text-sm font-semibold">{user.displayName || user.username}</b>
                <span className="text-[13px] text-muted-foreground">@{user.username}</span>
                {user.isAdmin ? <Pill tone="accent">{t('nav.administrator')}</Pill> : null}
                {user.totpEnabled ? (
                  <Pill tone="ok" dot={false}>
                    <ShieldCheck className="size-3" aria-hidden />
                    2FA
                  </Pill>
                ) : null}
                {user.disabled ? <Pill tone="bad">{t('users.disabled')}</Pill> : null}
                {user.id === me.user.id ? <Tag>{t('users.you')}</Tag> : null}
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {user.isAdmin
                  ? t('users.allServers')
                  : user.access.map((a) => `${serverName(a.serverId)}: ${roleName(a.roleId)}`).join(' · ') ||
                    t('users.noServerAccess')}
                {user.lastLoginAt
                  ? ` · ${t('users.lastLogin', { when: formatRelative(user.lastLoginAt) })}`
                  : ''}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setAccessFor(user)} disabled={user.isAdmin}>
              <KeyRound />
              {t('users.access')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('files.actionsFor', { name: user.username })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing({ user })}>
                  <Pencil />
                  {t('common.edit')}
                </DropdownMenuItem>
                {user.id === me.user.id ? null : (
                  <DropdownMenuItem onSelect={() => toggle.mutate({ user, disabled: !user.disabled })}>
                    <ShieldCheck />
                    {user.disabled ? t('users.enable') : t('users.disable')}
                  </DropdownMenuItem>
                )}
                {user.id === me.user.id ? null : (
                  <DropdownMenuItem destructive onSelect={() => setDeleting(user)}>
                    <Trash2 />
                    {t('common.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </Card>
      <UserDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        user={editing?.user ?? null}
      />
      <AccessDialog user={accessFor} roles={roles} onOpenChange={(o) => !o && setAccessFor(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('users.deleteTitle', { name: deleting?.username ?? '' })}
        description={t('users.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </>
  );
}

/** People and their rights: who may do what on which server. */
export function UsersPage(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleEntry[]>('/api/roles'),
    enabled: me.user.isAdmin,
  });
  if (!me.user.isAdmin) return <EmptyState title={t('errors.admin_only')} />;
  return (
    <>
      <PageHeader title={t('nav.users')} subtitle={t('users.subtitle')} />
      {!roles ? <Skeleton className="h-64 rounded-[16px]" /> : null}
      {roles ? <UsersList roles={roles} /> : null}
    </>
  );
}
