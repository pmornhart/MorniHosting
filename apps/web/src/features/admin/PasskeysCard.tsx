import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { PasskeyEntry } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { statusQuery, useSession } from '@/features/auth/session';
import { addPasskey, deviceName, panelDomainMissing, passkeysUsable } from '@/features/auth/passkey';

const PASSKEY_NAME_MAX = 60;
const passkeysQuery = {
  queryKey: ['passkeys'],
  queryFn: () => api<PasskeyEntry[]>('/api/account/passkeys'),
} as const;

interface Blocker {
  readonly text: string;
  /** This HTTPS address only needs to be entered as the panel domain. */
  readonly adoptable: boolean;
}

/** Why passkeys cannot be used from this address, in plain words; null when they can. */
function useBlocker(): Blocker | null {
  const { t } = useTranslation();
  const { data: status } = useQuery(statusQuery);
  if (!status || passkeysUsable(status)) return null;
  if (panelDomainMissing(status))
    return { text: t('passkeys.proxyHint', { host: window.location.hostname }), adoptable: true };
  if (status.passkeys === 'wrong_host' && status.panelDomain)
    return { text: t('passkeys.wrongHost', { domain: status.panelDomain }), adoptable: false };
  return { text: t('passkeys.needsHttps'), adoptable: false };
}

/** One click for admins: the address this page runs on becomes the panel domain. */
function AdoptDomainButton(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const host = window.location.hostname;
  const adopt = useMutation({
    mutationFn: () => api('/api/settings', { method: 'PUT', body: { panelDomain: host } }),
    onSuccess: async () => {
      toast.success(t('passkeys.domainAdopted', { host }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['panel-settings'] }),
      ]);
    },
  });
  return (
    <Button type="button" variant="secondary" disabled={adopt.isPending} onClick={() => adopt.mutate()}>
      <Globe />
      {t('passkeys.adoptDomain', { host })}
    </Button>
  );
}

/** Sign in with fingerprint, face or device PIN instead of the password. */
export function PasskeysCard(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: passkeys = [] } = useQuery(passkeysQuery);
  const blocker = useBlocker();
  const { me } = useSession();
  const suggestedName = (): string => {
    const device = deviceName();
    return device ? t('passkeys.defaultName', { device }) : '';
  };
  const [name, setName] = useState(suggestedName);
  const [removing, setRemoving] = useState<PasskeyEntry | null>(null);
  const add = useMutation({
    mutationFn: () => addPasskey(name.trim()),
    onSuccess: (list) => {
      queryClient.setQueryData(passkeysQuery.queryKey, list);
      setName(suggestedName());
      toast.success(t('passkeys.added'));
    },
  });
  const remove = async (passkey: PasskeyEntry): Promise<void> => {
    await api(`/api/account/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    toast.success(t('passkeys.removed'));
  };

  return (
    <Card fold="account-passkeys" foldOpen className="grid gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-primary" aria-hidden />
          {t('passkeys.title')}
          {passkeys.length ? <Pill tone="ok">{t('passkeys.count', { count: passkeys.length })}</Pill> : null}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('passkeys.text')}</CardDescription>
      {passkeys.length ? (
        <ul className="grid gap-2">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-[12px] bg-secondary px-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {p.lastUsedAt
                    ? t('passkeys.lastUsed', { when: formatRelative(p.lastUsedAt) })
                    : t('passkeys.neverUsed', { when: formatRelative(p.createdAt) })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('passkeys.remove', { name: p.name })}
                onClick={() => setRemoving(p)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {blocker ? (
        <div className="grid gap-3 rounded-[12px] bg-secondary px-3 py-2.5 text-sm">
          <p className="text-muted-foreground">{blocker.text}</p>
          {blocker.adoptable && me.user.isAdmin ? (
            <div>
              <AdoptDomainButton />
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field id="passkey-name" label={t('passkeys.name')} className="min-w-[220px] flex-1">
            <Input
              id="passkey-name"
              value={name}
              maxLength={PASSKEY_NAME_MAX}
              placeholder={t('passkeys.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || add.isPending}>
            <Plus />
            {add.isPending ? t('passkeys.waiting') : t('passkeys.add')}
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={t('passkeys.removeTitle')}
        description={t('passkeys.removeText', { name: removing?.name ?? '' })}
        confirmLabel={t('passkeys.removeConfirm')}
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </Card>
  );
}
