import { Bold, Italic, RemoveFormatting, Strikethrough, Underline } from 'lucide-react';
import { useRef, type CSSProperties, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ServerIcon } from '@/components/server-visuals';
import { Textarea } from '@/components/ui/input';
import { Tip } from '@/components/ui/misc';
import type { SoftwareId } from '@mornihosting/shared';

/** The MOTD is the text under the server name in the multiplayer list. Colours use Minecraft's "§" codes. */

const MC_COLOURS: Readonly<Record<string, string>> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
};

const DEFAULT_COLOUR = '#AAAAAA';
/** Colours that would vanish on the dark preview: they get a light halo so you can still see what you typed. */
const DARK_COLOURS: ReadonlySet<string> = new Set([
  '#000000',
  '#0000AA',
  '#555555',
  '#AA0000',
  '#AA00AA',
  '#00AA00',
]);
/** Minecraft draws every letter with a small dark shadow. */
const MC_SHADOW = '1px 1px 0 rgb(0 0 0 / 0.55)';
const DARK_HALO = '0 0 2px rgb(255 255 255 / 0.7), 0 0 1px rgb(255 255 255 / 0.9)';
/** The server list shows two MOTD lines. */
const MOTD_LINES = 2;
/** "§" plus one code character. */
const CODE_LENGTH = 2;
const WEIGHT_BOLD = 700;
const WEIGHT_NORMAL = 400;
const FORMATS: readonly { code: string; icon: typeof Bold; key: string }[] = [
  { code: 'l', icon: Bold, key: 'bold' },
  { code: 'o', icon: Italic, key: 'italic' },
  { code: 'n', icon: Underline, key: 'underline' },
  { code: 'm', icon: Strikethrough, key: 'strike' },
  { code: 'r', icon: RemoveFormatting, key: 'reset' },
];

interface Style {
  readonly color: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
}

interface Segment {
  readonly text: string;
  readonly style: Style;
}

const PLAIN: Style = { color: DEFAULT_COLOUR, bold: false, italic: false, underline: false, strike: false };

const FORMAT_FLAGS: Readonly<Record<string, keyof Omit<Style, 'color'>>> = {
  l: 'bold',
  o: 'italic',
  n: 'underline',
  m: 'strike',
};

// A colour or format code and the text up to the next code: "§aHi §lyou" → ("a", "Hi "), ("l", "you").
// https://regex101.com/?regex=%C2%A7(%5B0-9a-fk-or%5D)(%5B%5E%C2%A7%5D*)&flags=gi&testString=%C2%A7aHi%20%C2%A7lyou
const CODE_RUN = /§([0-9a-fk-or])([^§]*)/gi;

function nextStyle(style: Style, code: string): Style {
  const colour = MC_COLOURS[code];
  if (colour) return { ...PLAIN, color: colour };
  if (code === 'r') return PLAIN;
  const flag = FORMAT_FLAGS[code];
  return flag ? { ...style, [flag]: true } : style;
}

/** Splits one MOTD line into styled pieces. Colour codes reset bold/italic, as in Minecraft. */
function motdSegments(line: string): Segment[] {
  const first = line.indexOf('§');
  const lead: Segment[] =
    first === 0 ? [] : [{ text: first < 0 ? line : line.slice(0, first), style: PLAIN }];
  const runs = [...line.matchAll(CODE_RUN)].reduce<{ style: Style; out: Segment[] }>(
    (acc, match) => {
      const style = nextStyle(acc.style, (match[1] ?? '').toLowerCase());
      return { style, out: match[2] ? [...acc.out, { text: match[2], style }] : acc.out };
    },
    { style: PLAIN, out: [] },
  );
  return [...lead, ...runs.out];
}

function cssOf(style: Style): CSSProperties {
  const lines = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean);
  return {
    color: style.color,
    fontWeight: style.bold ? WEIGHT_BOLD : WEIGHT_NORMAL,
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: lines.length ? lines.join(' ') : 'none',
    textShadow: DARK_COLOURS.has(style.color) ? DARK_HALO : MC_SHADOW,
  };
}

export function MotdPreview({
  motd,
  name,
  serverId,
  software,
  hasIcon,
  players,
}: {
  motd: string;
  name: string;
  serverId: string;
  software: SoftwareId;
  hasIcon: boolean;
  players: string;
}): ReactElement {
  const lines = motd.split('\n').slice(0, MOTD_LINES);
  return (
    <div
      className="flex gap-3 rounded-[10px] border border-black/40 p-2.5 font-mono text-[13px] leading-[1.35] shadow-inner"
      style={{ background: 'repeating-linear-gradient(45deg,#2b2b2b 0 6px,#262626 6px 12px)' }}
    >
      <ServerIcon
        id={serverId}
        software={software}
        hasIcon={hasIcon}
        className="size-14 shrink-0 rounded-[4px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2">
          <span className="truncate text-white">{name}</span>
          <span className="shrink-0 text-[#AAAAAA]">{players}</span>
        </div>
        {lines.map((line, i) => (
          <div key={i} className="truncate whitespace-pre">
            {motdSegments(line).map((seg, j) => (
              <span key={j} style={cssOf(seg.style)}>
                {seg.text}
              </span>
            ))}
            {line ? null : ' '}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Text field with colour buttons; inserts "§" codes at the cursor. */
export function MotdEditor({
  id,
  value,
  onChange,
  preview,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  preview: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (code: string): void => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}§${code}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + CODE_LENGTH, start + CODE_LENGTH);
    });
  };
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label={t('settings.motd.toolbar')}
      >
        {Object.entries(MC_COLOURS).map(([code, colour]) => (
          <Tip key={code} content={t(`settings.motd.colours.${code}`)}>
            <button
              type="button"
              aria-label={t(`settings.motd.colours.${code}`)}
              onClick={() => insert(code)}
              className="size-6 rounded-[6px] border border-black/30 shadow-sm transition-transform hover:scale-110"
              style={{ background: colour }}
            />
          </Tip>
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {FORMATS.map((f) => (
          <Tip key={f.code} content={t(`settings.motd.formats.${f.key}`)}>
            <button
              type="button"
              aria-label={t(`settings.motd.formats.${f.key}`)}
              onClick={() => insert(f.code)}
              className="grid size-7 place-items-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <f.icon className="size-4" />
            </button>
          </Tip>
        ))}
      </div>
      <Textarea
        id={id}
        ref={ref}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value.split('\n').slice(0, MOTD_LINES).join('\n'))}
        className="min-h-0 resize-none font-mono field-sizing-content"
        spellCheck={false}
      />
      {preview}
    </div>
  );
}
