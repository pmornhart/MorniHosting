import { Feather, Home, Info, Lock, MessageCircle, ShieldCheck, Users } from 'lucide-react';
import type { ReactElement } from 'react';
import { CRAFT_ATTACK_COMMANDS, type CraftAttackCommandGroup } from '@mornihosting/shared';
import { cn } from '@/lib/utils';

const ICONS: Readonly<Record<CraftAttackCommandGroup['id'], typeof Home>> = {
  spawn: Feather,
  home: Home,
  teleport: Users,
  chat: MessageCircle,
  info: Info,
  op: ShieldCheck,
};

/**
 * The Craft Attack commands as cards, one per group. `allowed` decides per command; a command that is not allowed
 * stays visible, greyed out with a lock, so players see what an admin could do.
 */
export function CommandGroups({
  lang,
  allowed = () => true,
  showOp = true,
  bedrock = false,
}: {
  readonly lang: 'de' | 'en';
  readonly allowed?: (opOnly: boolean) => boolean;
  readonly showOp?: boolean;
  readonly bedrock?: boolean;
}): ReactElement {
  const groups = CRAFT_ATTACK_COMMANDS.filter((g) => showOp || g.id !== 'op');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((group) => {
        const Icon = ICONS[group.id];
        return (
          <section
            key={group.id}
            className="grid content-start gap-2 rounded-[12px] border bg-secondary/30 p-3"
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Icon className="size-4 text-primary" aria-hidden />
              {group.title[lang]}
            </h3>
            <ul className="grid gap-1.5">
              {group.commands.map((command) => {
                const ok = allowed(Boolean(command.opOnly));
                // Bedrock players boost by sneaking: show only their key.
                const use =
                  bedrock && command.use.de.startsWith('F ')
                    ? lang === 'de'
                      ? 'Schleichen'
                      : 'Sneak'
                    : command.use[lang];
                return (
                  <li key={command.use.de} className={cn('grid gap-0.5 text-[13px]', !ok && 'opacity-45')}>
                    <code className="flex w-fit items-center gap-1 rounded-[6px] bg-background px-1.5 py-0.5 font-mono text-[12.5px] text-primary">
                      {ok ? null : <Lock className="size-3" aria-hidden />}
                      {use}
                    </code>
                    <span className="text-muted-foreground">{command.text[lang]}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
