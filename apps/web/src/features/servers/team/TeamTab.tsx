import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, LogOut, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { TeamMember, TeamRoleOption, TeamView } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TabIntro } from '@/components/tab-intro';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { useServer } from '../ServerLayout';

const OWNER = 'owner';
const DEFAULT_ROLE = 'moderator';

/** Built-in roles have their name from the panel's texts, own roles keep the name their admin gave. */
function roleLabel(role: { builtIn: string | null; name: string }, t: (key: string) => string): string {
  return role.builtIn ? t(`team.roles.${role.builtIn}`) : role.name;
}

function RoleSelect({
  id,
  value,
  roles,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  className?: string;
  value: number;
  roles: readonly TeamRoleOption[];
  onChange: (roleId: number) => void;
  disabled?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r) => (
          <SelectItem key={r.id} value={String(r.id)} disabled={!r.assignable}>
            {roleLabel(r, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MemberRow({
  member,
  team,
  serverId,
}: {
  member: TeamMember;
  team: TeamView;
  serverId: string;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const key = ['team', serverId];
  const change = useMutation({
    mutationFn: (roleId: number) =>
      api<TeamView>(`/api/servers/${serverId}/team/${member.userId}`, { method: 'PUT', body: { roleId } }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/servers/${serverId}/team/${member.userId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      if (member.you) {
        await queryClient.invalidateQueries({ queryKey: ['servers'] });
        navigate('/');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const owner = member.builtIn === OWNER;
  const mayRemove =
    member.you || (team.canManage && (!owner || team.roles.some((r) => r.builtIn === OWNER && r.assignable)));
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3 rounded-[12px] bg-secondary px-3 py-2.5">
      <span className="grid min-w-0 flex-1 gap-0.5">
        <b className="flex min-w-0 items-center gap-1.5 font-semibold">
          {owner ? <Crown className="size-4 shrink-0 text-warning" aria-hidden /> : null}
          <span className="truncate">{member.displayName || member.username}</span>
          {member.you ? <Pill>{t('team.you')}</Pill> : null}
        </b>
        <span className="truncate text-[13px] text-muted-foreground">@{member.username}</span>
      </span>
      {team.canManage ? (
        <RoleSelect
          value={member.roleId}
          roles={team.roles}
          className="w-40 bg-background"
          onChange={(roleId) => change.mutate(roleId)}
          disabled={
            change.isPending || (owner && !team.roles.some((r) => r.builtIn === OWNER && r.assignable))
          }
        />
      ) : (
        <Pill tone={owner ? 'warn' : 'neutral'}>
          {roleLabel({ builtIn: member.builtIn, name: member.roleName }, t)}
        </Pill>
      )}
      {mayRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={member.you ? t('team.leave') : t('team.remove', { name: member.username })}
          title={member.you ? t('team.leave') : t('team.remove', { name: member.username })}
          onClick={() => setConfirm(true)}
        >
          {member.you ? <LogOut className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={member.you ? t('team.leaveTitle') : t('team.removeTitle', { name: member.username })}
        description={member.you ? t('team.leaveText') : t('team.removeText')}
        confirmLabel={member.you ? t('team.leave') : t('team.removeShort')}
        destructive
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

/** Server → Mitarbeiter: who may work on this server, with which role; owners and admins add people. */
export default function TeamTab(): ReactElement {
  const { t } = useTranslation();
  const { server } = useServer();
  const queryClient = useQueryClient();
  const key = ['team', server.id];
  const { data: team } = useQuery({
    queryKey: key,
    queryFn: () => api<TeamView>(`/api/servers/${server.id}/team`),
  });
  const [who, setWho] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const defaultRole =
    team?.roles.find((r) => r.builtIn === DEFAULT_ROLE) ?? team?.roles.find((r) => r.assignable);
  const roleId = picked ?? defaultRole?.id ?? 0;
  const add = useMutation({
    mutationFn: () =>
      api<TeamView>(`/api/servers/${server.id}/team`, { method: 'POST', body: { who: who.trim(), roleId } }),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      toast.success(t('team.added', { who: who.trim() }));
      setWho('');
    },
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (who.trim() && roleId) add.mutate();
  };
  return (
    <>
      <TabIntro title={t('team.title')} text={t('team.text')} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Card className="grid gap-3 p-5">
          <CardTitle>{t('team.members', { count: team?.members.length ?? 0 })}</CardTitle>
          {team && team.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('team.empty')}</p>
          ) : null}
          <ul className="grid gap-2">
            {team?.members.map((m) => (
              <MemberRow key={m.userId} member={m} team={team} serverId={server.id} />
            ))}
          </ul>
        </Card>
        {team?.canManage ? (
          <Card className="grid gap-3 p-5">
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="size-5 text-primary" aria-hidden />
              {t('team.addTitle')}
            </CardTitle>
            <CardDescription>{t('team.addText')}</CardDescription>
            <form onSubmit={submit} className="grid gap-3">
              <Field id="team-who" label={t('team.who')} hint={t('team.whoHint')}>
                <Input
                  id="team-who"
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                  placeholder={t('team.whoPlaceholder')}
                  autoComplete="off"
                />
              </Field>
              <Field id="team-role" label={t('team.role')} hint={t('team.roleHint')}>
                <RoleSelect id="team-role" value={roleId} roles={team.roles} onChange={setPicked} />
              </Field>
              <Button type="submit" className="w-fit" disabled={!who.trim() || !roleId || add.isPending}>
                <UserPlus className="size-4" aria-hidden />
                {t('team.add')}
              </Button>
            </form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
