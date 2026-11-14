import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Crown,
  Feather,
  Flame,
  Home,
  LayoutPanelLeft,
  Save,
  Timer,
  Users,
  Shield,
  Skull,
  Sparkles,
  Swords,
} from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MorniCraftSettings, MorniCraftState, TeamSettings } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Slider } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { CommandGroups } from '@/features/public/command-groups';
import { api } from '@/lib/api';
import { MorniCraftRanks } from './MorniCraftRanks';

type BoolKey = {
  [K in keyof TeamSettings]: TeamSettings[K] extends boolean ? K : never;
}[keyof TeamSettings];
type NumberKey = {
  [K in keyof TeamSettings]: TeamSettings[K] extends number ? K : never;
}[keyof TeamSettings];

interface NumberSpec {
  readonly key: NumberKey;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Shown only while these switches are on (or these numbers above 0). */
  readonly when?: readonly (BoolKey | NumberKey)[];
  /** At 0 the value reads as this word (e.g. "no limit") instead of the unit. */
  readonly zero?: 'unlimited' | 'off';
}

/** The dashboard's sections: switches and numbers in the order the admin thinks of them. */
const SECTIONS: readonly {
  readonly id: string;
  readonly icon: typeof Home;
  readonly switches: readonly BoolKey[];
  readonly numbers: readonly NumberSpec[];
  /** The section's main switch: while it is off, only this switch shows. */
  readonly gate?: BoolKey;
}[] = [
  {
    id: 'teleport',
    icon: Home,
    switches: ['spawnCommand', 'homes', 'tpa', 'back'],
    numbers: [
      { key: 'teleportDelay', min: 0, max: 30, step: 1 },
      { key: 'maxHomes', min: 1, max: 50, step: 1, when: ['homes'] },
    ],
  },
  {
    id: 'limits',
    icon: Timer,
    switches: [],
    numbers: [
      { key: 'spawnLimit', min: 0, max: 20, step: 1, when: ['spawnCommand'], zero: 'unlimited' },
      { key: 'spawnLimitHours', min: 1, max: 168, step: 1, when: ['spawnCommand', 'spawnLimit'] },
      { key: 'homeLimit', min: 0, max: 20, step: 1, when: ['homes'], zero: 'unlimited' },
      { key: 'homeLimitHours', min: 1, max: 168, step: 1, when: ['homes', 'homeLimit'] },
      { key: 'tpaLimit', min: 0, max: 20, step: 1, when: ['tpa'], zero: 'unlimited' },
      { key: 'tpaLimitHours', min: 1, max: 168, step: 1, when: ['tpa', 'tpaLimit'] },
      { key: 'backLimit', min: 0, max: 20, step: 1, when: ['back'], zero: 'unlimited' },
      { key: 'backLimitHours', min: 1, max: 168, step: 1, when: ['back', 'backLimit'] },
    ],
  },
  {
    id: 'clans',
    icon: Users,
    switches: ['clans'],
    numbers: [{ key: 'clanMaxMembers', min: 2, max: 50, step: 1, when: ['clans'] }],
  },
  {
    id: 'spawn',
    icon: Shield,
    switches: ['spawnProtection', 'sleepAtSpawn', 'pvpAtSpawn'],
    numbers: [{ key: 'spawnRadius', min: 10, max: 200, step: 5 }],
  },
  {
    id: 'elytra',
    icon: Feather,
    switches: ['elytra', 'elytraBoost'],
    numbers: [{ key: 'elytraRadius', min: 10, max: 200, step: 5, when: ['elytra'] }],
  },
  {
    id: 'world',
    icon: Flame,
    switches: ['tnt', 'creeperDamage', 'fireSpread', 'endermanGrief', 'sit'],
    numbers: [],
  },
  {
    id: 'dragon',
    icon: Crown,
    gate: 'hardDragon',
    switches: ['hardDragon'],
    numbers: [
      { key: 'dragonHealth', min: 200, max: 3000, step: 50 },
      { key: 'dragonDamage', min: 100, max: 400, step: 25 },
      { key: 'dragonAttackSeconds', min: 5, max: 60, step: 1 },
      { key: 'dragonRagePercent', min: 0, max: 75, step: 5, zero: 'off' },
      { key: 'dragonXp', min: 0, max: 20000, step: 500, zero: 'off' },
    ],
  },
  {
    id: 'dragonAttacks',
    icon: Flame,
    gate: 'hardDragon',
    switches: [
      'dragonBrood',
      'dragonLightning',
      'dragonFireballs',
      'dragonFangs',
      'dragonEndermen',
      'dragonLevitation',
      'dragonShockwave',
      'dragonCrystals',
      'dragonEgg',
    ],
    numbers: [],
  },
  {
    id: 'show',
    icon: LayoutPanelLeft,
    switches: ['welcome', 'sidebar', 'showLink', 'tabStats'],
    numbers: [],
  },
  {
    id: 'combat',
    icon: Swords,
    switches: [],
    numbers: [{ key: 'combatSeconds', min: 0, max: 60, step: 5, zero: 'off' }],
  },
  {
    id: 'graves',
    icon: Skull,
    switches: ['graves'],
    numbers: [],
  },
];

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[12.5px] text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * The switches and sliders of MorniCraft (teleports, spawn, start elytra, world, display, combat, graves) – in the
 * panel and on the team dashboard, where owners and admins change them too.
 */
export function MorniCraftSections({
  draft,
  set,
}: {
  draft: TeamSettings;
  set: (patch: Partial<TeamSettings>) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {SECTIONS.map((section) => (
        <section
          key={section.id}
          hidden={
            (section.gate !== undefined &&
              !section.switches.includes(section.gate) &&
              !draft[section.gate]) ||
            (section.switches.length === 0 &&
              !section.numbers.some((n) => (n.when ?? []).every((w) => Boolean(draft[w]))))
          }
          className="grid content-start rounded-[12px] border bg-secondary/30 px-4 py-3"
        >
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <section.icon className="size-4 text-primary" aria-hidden />
            {t(`mornicraft.sections.${section.id}`)}
          </h3>
          <div className="divide-y divide-border/60">
            {section.switches
              .filter((k) => !section.gate || k === section.gate || draft[section.gate])
              .map((k) => (
                <Row key={k} label={t(`mornicraft.fields.${k}`)} hint={t(`mornicraft.hints.${k}`)}>
                  <Switch
                    checked={draft[k]}
                    onCheckedChange={(v) => set({ [k]: v })}
                    aria-label={t(`mornicraft.fields.${k}`)}
                  />
                </Row>
              ))}
            {section.numbers
              .filter(() => !section.gate || draft[section.gate])
              .filter((n) => (n.when ?? []).every((w) => Boolean(draft[w])))
              .map((n) => (
                <div key={n.key} className="grid gap-2 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{t(`mornicraft.fields.${n.key}`)}</span>
                    <b className="text-sm tabular-nums">
                      {n.zero && draft[n.key] === 0
                        ? t(`mornicraft.units.${n.zero}`)
                        : t(`mornicraft.units.${n.key}`, { n: draft[n.key] })}
                    </b>
                  </div>
                  <Slider
                    min={n.min}
                    max={n.max}
                    step={n.step}
                    value={[draft[n.key]]}
                    onValueChange={([v]) => set({ [n.key]: v ?? n.min })}
                    aria-label={t(`mornicraft.fields.${n.key}`)}
                  />
                  <span className="text-[12.5px] text-muted-foreground">
                    {t(`mornicraft.hints.${n.key}`)}
                  </span>
                </div>
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * MorniCraft: the panel's own plugin on this server. Everything the admin can set – teleport wait, homes, spawn
 * protection, sleeping and fighting at the spawn, start elytra, TNT and other world rules, welcome, sidebar, rules.
 * Saving applies it at once (the plugin reloads its settings).
 */
export function MorniCraftCard({ serverId }: { serverId: string }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('en') ? 'en' : 'de';
  const queryClient = useQueryClient();
  const key = ['mornicraft', serverId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<MorniCraftState>(`/api/servers/${serverId}/mornicraft`),
  });
  const [draft, setDraft] = useState<MorniCraftSettings | null>(null);
  const [rules, setRules] = useState('');
  useEffect(() => {
    if (data) {
      setDraft(data.settings);
      setRules(data.settings.rules.join('\n'));
    }
  }, [data]);
  const save = useMutation({
    mutationFn: (settings: MorniCraftSettings) =>
      api<MorniCraftState>(`/api/servers/${serverId}/mornicraft`, { method: 'PUT', body: settings }),
    onSuccess: (state) => {
      queryClient.setQueryData(key, state);
      toast.success(t('mornicraft.saved'));
    },
  });
  if (!data?.active || !draft) return null;
  const set = <K extends keyof MorniCraftSettings>(k: K, v: MorniCraftSettings[K]): void =>
    setDraft({ ...draft, [k]: v });
  const ruleList = rules
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  const next: MorniCraftSettings = { ...draft, rules: ruleList };
  const dirty = JSON.stringify(next) !== JSON.stringify(data.settings);
  const page = `${window.location.origin}/befehle/${data.slug ?? ''}/`;

  return (
    <Card fold="mornicraft" foldOpen className="grid gap-4 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/12 text-primary">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle>{t('mornicraft.title')}</CardTitle>
          <CardDescription>{t('mornicraft.text')}</CardDescription>
        </div>
      </div>
      {data.pluginAvailable ? null : (
        <p className="rounded-[10px] border border-warning/40 bg-warning-soft px-3 py-2 text-[13px]">
          {t('mornicraft.noPlugin')}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <MorniCraftSections draft={draft} set={(patch) => setDraft({ ...draft, ...patch })} />
        <section className="grid content-start gap-2 rounded-[12px] border bg-secondary/30 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <BookOpen className="size-4 text-primary" aria-hidden />
            {t('mornicraft.sections.rules')}
          </h3>
          <Textarea
            rows={5}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            aria-label={t('mornicraft.sections.rules')}
          />
          <span className="text-[12.5px] text-muted-foreground">{t('mornicraft.rulesHint')}</span>
        </section>
      </div>
      <MorniCraftRanks
        serverId={serverId}
        ranks={draft.ranks}
        panelMembers={data.panelMembers}
        badges={draft.badges}
        badgesReady={data.badgePackUrl !== null}
        onBadges={(on) => set('badges', on)}
        badgesRequired={draft.badgesRequired}
        onBadgesRequired={(on) => set('badgesRequired', on)}
        badgeText={draft.badgeText}
        onBadgeText={(on) => set('badgeText', on)}
        onChange={(ranks) => set('ranks', ranks)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12.5px] text-muted-foreground">{t('mornicraft.live')}</span>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(next)}>
          <Save aria-hidden />
          {t('mornicraft.save')}
        </Button>
      </div>
      <details className="rounded-[12px] border px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('mornicraft.commands')}</summary>
        <div className="mt-3 grid gap-3">
          <p className="text-[13px] text-muted-foreground">
            {t('mornicraft.personal')}{' '}
            <code className="break-all font-mono text-primary">
              {page}
              {t('mornicraft.playerName')}
            </code>
          </p>
          <CommandGroups lang={lang} />
        </div>
      </details>
    </Card>
  );
}
