import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { meQuery, useSession } from './session';

const PASSWORD_MIN = 10;
const keepOpen = (e: Event): void => e.preventDefault();

/**
 * After signing in with a password an admin chose (new account or reset), this window stays until the person
 * sets their own. The start password is asked once more, so a forgotten open tab cannot be taken over.
 */
export function ForcePasswordDialog(): ReactElement | null {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const change = useMutation({
    mutationFn: () => api('/api/account/password', { method: 'POST', body: { current, next } }),
    onSuccess: async () => {
      toast.success(t('forcePassword.done'));
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
    onError: () => undefined,
  });
  const logout = useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => queryClient.setQueryData(meQuery.queryKey, null),
  });
  if (!me.user.mustChangePassword) return null;
  const mismatch = repeat.length > 0 && repeat !== next;
  const sameAsStart = next.length > 0 && next === current;
  const valid = current.length > 0 && next.length >= PASSWORD_MIN && next === repeat && !sameAsStart;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) change.mutate();
  };
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent closable={false} onEscapeKeyDown={keepOpen} onInteractOutside={keepOpen}>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden />
          {t('forcePassword.title', { name: me.user.displayName || me.user.username })}
        </DialogTitle>
        <DialogDescription>{t('forcePassword.text')}</DialogDescription>
        <form onSubmit={submit} className="grid gap-4">
          <Field id="fp-current" label={t('forcePassword.current')} hint={t('forcePassword.currentHint')}>
            <Input
              id="fp-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            id="fp-next"
            label={t('forcePassword.next')}
            hint={t('forcePassword.nextHint')}
            error={sameAsStart ? t('forcePassword.same') : undefined}
          >
            <Input
              id="fp-next"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field
            id="fp-repeat"
            label={t('account.repeat')}
            error={mismatch ? t('account.mismatch') : undefined}
          >
            <Input
              id="fp-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
          {change.error ? (
            <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              {errorText(change.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => logout.mutate()}>
              <LogOut aria-hidden />
              {t('forcePassword.logout')}
            </Button>
            <Button type="submit" disabled={!valid || change.isPending}>
              {t('forcePassword.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
