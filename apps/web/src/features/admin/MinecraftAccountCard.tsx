import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Gamepad2, Link2, Unlink } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MeResponse, UserInfo } from '@mornihosting/shared';
import { PlayerHead } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { meQuery, useSession } from '@/features/auth/session';

const NAME_MAX = 16;

/** The user's own Minecraft (Java) account: their head in the panel, and OP on the servers they own. */
export function MinecraftAccountCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const linked = me.user.minecraft;
  const adopt = (user: UserInfo): void => {
    queryClient.setQueryData<MeResponse | null>(meQuery.queryKey, (prev) =>
      prev ? { ...prev, user } : prev,
    );
  };
  const link = useMutation({
    mutationFn: () =>
      api<{ user: UserInfo }>('/api/account/minecraft', { method: 'PUT', body: { name: name.trim() } }),
    onSuccess: ({ user }) => {
      adopt(user);
      setName('');
      toast.success(t('minecraftAccount.linked', { name: user.minecraft?.name }));
    },
  });
  const unlink = useMutation({
    mutationFn: () => api<{ user: UserInfo }>('/api/account/minecraft', { method: 'DELETE' }),
    onSuccess: ({ user }) => {
      adopt(user);
      toast.success(t('minecraftAccount.unlinked'));
    },
  });
  const error = link.error ?? unlink.error;

  return (
    <Card fold="account-minecraft" className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <Gamepad2 className="size-4 text-primary" aria-hidden />
          {t('minecraftAccount.title')}
          {linked ? <Pill tone="ok">{t('minecraftAccount.connected')}</Pill> : null}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('minecraftAccount.text')}</CardDescription>
      {linked ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-secondary px-3 py-2.5">
          <PlayerHead name={linked.name} skin={linked.uuid} className="size-10 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{linked.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{linked.uuid}</p>
          </div>
          <Button variant="ghost" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
            <Unlink />
            {t('minecraftAccount.unlink')}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            link.mutate();
          }}
        >
          <Field id="mc-name" label={t('minecraftAccount.name')} className="min-w-[220px] flex-1">
            <Input
              id="mc-name"
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              placeholder="Steve"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || link.isPending}>
            <Link2 />
            {link.isPending ? t('minecraftAccount.linking') : t('minecraftAccount.link')}
          </Button>
        </form>
      )}
      {error ? (
        <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{errorText(error)}</p>
      ) : null}
      <p className="text-[13px] text-muted-foreground">{t('minecraftAccount.note')}</p>
    </Card>
  );
}
