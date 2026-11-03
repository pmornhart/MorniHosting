import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, RotateCcw, UserPlus } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { PasswordResetResult, UserListEntry } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { AccessSheetButton } from './access-sheet/AccessSheetButton';
import { useSession } from '@/features/auth/session';

function ResetDialog({ user, onClose }: { user: UserListEntry; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const [removeSecondFactors, setRemoveSecondFactors] = useState(false);
  const name = user.displayName || user.username;
  const reset = useMutation({
    mutationFn: () =>
      api<PasswordResetResult>(`/api/users/${user.id}/reset-password`, {
        method: 'POST',
        body: { removeSecondFactors },
      }),
  });
  const password = reset.data?.password;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle>
          {password ? t('passwordReset.doneTitle') : t('passwordReset.title', { name })}
        </DialogTitle>
        <DialogDescription>
          {password ? t('passwordReset.doneText', { name }) : t('passwordReset.text', { name })}
        </DialogDescription>
        {password ? (
          <div className="flex items-center gap-2 rounded-[12px] bg-secondary px-4 py-3">
            <code className="min-w-0 flex-1 break-all font-mono text-lg font-semibold">{password}</code>
            <CopyButton text={password} />
          </div>
        ) : null}
        {password ? (
          <div className="grid gap-2 rounded-[12px] border border-border p-4">
            <b className="text-sm font-semibold">{t('accessSheet.sheetTitle')}</b>
            <span className="text-[13px] text-muted-foreground">{t('accessSheet.sheetText')}</span>
            <div className="pt-1">
              <AccessSheetButton person={user} password={password} lang={user.locale} />
            </div>
          </div>
        ) : (
          <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
            <Switch
              checked={removeSecondFactors}
              onCheckedChange={setRemoveSecondFactors}
              className="mt-0.5"
            />
            <span>
              <b className="block text-sm font-semibold">{t('passwordReset.removeSecondFactors')}</b>
              <span className="text-[13px] text-muted-foreground">
                {t('passwordReset.removeSecondFactorsHint')}
              </span>
            </span>
          </label>
        )}
        <DialogFooter>
          {password ? (
            <Button onClick={onClose}>{t('passwordReset.close')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => reset.mutate()} disabled={reset.isPending}>
                <RotateCcw />
                {t('passwordReset.confirm')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** For admins: a forgotten password gets a fresh one in two clicks; it is shown exactly once. */
export function PasswordResetCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserListEntry[]>('/api/users'),
  });
  const [target, setTarget] = useState<UserListEntry | null>(null);
  const others = users.filter((u) => u.id !== me.user.id);
  return (
    <Card fold="passwords" foldOpen id="passwords" className="grid min-w-0 scroll-mt-4 gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-primary" aria-hidden />
          {t('passwordReset.cardTitle')}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('passwordReset.cardText')}</CardDescription>
      {others.length ? (
        <ul className="grid gap-2">
          {others.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-3 rounded-[12px] bg-secondary px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{u.displayName || u.username}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  @{u.username}
                  {u.isAdmin ? <Pill tone="accent">{t('nav.administrator')}</Pill> : null}
                  {u.totpEnabled ? <Pill>{t('passwordReset.has2fa')}</Pill> : null}
                  {u.disabled ? <Pill tone="bad">{t('passwordReset.locked')}</Pill> : null}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setTarget(u)}>
                <RotateCcw />
                {t('passwordReset.button')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-secondary px-3 py-3 text-sm text-muted-foreground">
          <span className="flex-1">{t('passwordReset.nobody')}</span>
          <Button asChild variant="secondary" size="sm">
            <Link to="/users">
              <UserPlus />
              {t('passwordReset.addUser')}
            </Link>
          </Button>
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        {t('passwordReset.ownHint')}{' '}
        <Link to="/account" className="font-semibold text-primary hover:underline">
          {t('nav.account')}
        </Link>
      </p>
      {target ? <ResetDialog user={target} onClose={() => setTarget(null)} /> : null}
    </Card>
  );
}
