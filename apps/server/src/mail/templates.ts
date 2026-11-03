import type { Locale } from '@mornihosting/shared';

/**
 * The mails the panel sends. Every dynamic value is escaped for HTML and stripped of line breaks, no images are
 * loaded from outside, and the colours are the panel's emerald.
 */

export interface MailMessage {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface Body {
  readonly subject: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly rows?: readonly (readonly [label: string, value: string])[];
  readonly button?: { readonly label: string; readonly url: string };
  readonly note?: string;
  /** One value that matters most (the server address), shown large in its own box. */
  readonly highlight?: { readonly label: string; readonly value: string };
}

export interface MailVars {
  readonly name: string;
  readonly link: string | null;
  readonly host: string | null;
  readonly [key: string]: string | null | undefined;
}

export type MailKind =
  | 'test'
  | 'welcome'
  | 'register'
  | 'already_registered'
  | 'email_change'
  | 'password_reset'
  | 'server_ordered'
  | 'server_crashed'
  | 'approval_needed'
  | 'account_approved'
  | 'account_rejected'
  | 'request_new'
  | 'request_approved'
  | 'request_rejected';

const EMERALD = '#10b981';
const EMERALD_DEEP = '#065f46';
const EMERALD_SOFT = '#ecfdf5';
const INK = '#0f1f1a';
const MUTED = '#5b6b65';
const PAPER = '#eef4f1';
const LINE = '#e1eae6';
const BOX = '#f6faf8';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const PREHEADER_MAX = 140;

/** The symbol in the circle at the top of each mail, and whether it is good news or a warning. */
const LOOK: Readonly<Record<MailKind, { readonly icon: string; readonly warn?: boolean }>> = {
  test: { icon: '🎉' },
  welcome: { icon: '👑' },
  register: { icon: '📬' },
  already_registered: { icon: '🔐' },
  email_change: { icon: '✉️' },
  password_reset: { icon: '🔑' },
  server_ordered: { icon: '🎮' },
  server_crashed: { icon: '⚠️', warn: true },
  approval_needed: { icon: '🙋' },
  account_approved: { icon: '✅' },
  account_rejected: { icon: '🚫', warn: true },
  request_new: { icon: '🖥️' },
  request_approved: { icon: '🚀' },
  request_rejected: { icon: '🚫', warn: true },
};

/** Mail apps that know dark mode (Apple Mail, Outlook app) switch colours through these classes. */
const DARK_STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.mh-bg{background:#0b1210!important}
.mh-card{background:#131d1a!important;border-color:#22312c!important}
.mh-ink{color:#e7f0ec!important}
.mh-muted{color:#93a59e!important}
.mh-box{background:#18241f!important;border-color:#22312c!important}
.mh-line{border-color:#22312c!important}
.mh-hl{background:#0f2a21!important;border-color:#1f4d3d!important}
.mh-hl-v{color:#6ee7b7!important}
.mh-icon{background:#0f2a21!important;border-color:#131d1a!important}
.mh-link{color:#6ee7b7!important}
}
@media (max-width:520px){.mh-pad{padding-left:20px!important;padding-right:20px!important}}
</style>`;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
// Characters that matter in HTML text and attributes. Matches "&", "<", "'"; rejects "a".
// https://regex101.com/?flavor=javascript&regex=%5B%26%3C%3E%22'%5D&flags=gm&testString=%26%0A%3C%0A'%0Aa
const HTML_SPECIAL = /[&<>"']/g;
// Control characters including line breaks: they never belong into a subject or a name. Matches "a\nb"; rejects "ab".
// https://regex101.com/?flavor=javascript&regex=%5B%5Cx00-%5Cx1f%5Cx7f%5D%2B&flags=gm&testString=ab%0Aa%09b
const CONTROL = /[\x00-\x1f\x7f]+/g; // eslint-disable-line no-control-regex -- the point is to strip them

const escapeHtml = (value: string): string => value.replace(HTML_SPECIAL, (c) => ESCAPES[c] ?? c);
/** One line of plain text: no line breaks, so a name can never add a header. */
export const oneLine = (value: string): string => value.replace(CONTROL, ' ').trim();

const dateFormat = (locale: Locale): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const formatWhen = (locale: Locale, date: Date): string => dateFormat(locale).format(date);

const FOOTER: Readonly<Record<Locale, { readonly why: string; readonly fallback: string }>> = {
  de: {
    why: 'Diese Mail hat dein MorniHosting-Panel automatisch verschickt.',
    fallback: 'Klappt der Knopf nicht? Kopiere diesen Link in deinen Browser:',
  },
  en: {
    why: 'Your MorniHosting panel sent this mail automatically.',
    fallback: 'Button not working? Copy this link into your browser:',
  },
};

const rowsHtml = (rows: Body['rows']): string => {
  const list = rows ?? [];
  if (list.length === 0) return '';
  const cells = list
    .map(
      ([label, value], index) =>
        `<tr><td class="mh-line" style="padding:12px 16px;${index ? `border-top:1px solid ${LINE};` : ''}">
<div class="mh-muted" style="font-size:12px;line-height:1.4;color:${MUTED};letter-spacing:.3px">${escapeHtml(label)}</div>
<div class="mh-ink" style="font-size:15px;line-height:1.45;color:${INK};font-weight:600;word-break:break-word">${escapeHtml(value)}</div>
</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mh-box" style="margin:20px 0 0;background:${BOX};border:1px solid ${LINE};border-radius:14px;border-collapse:separate">${cells}</table>`;
};

const highlightHtml = (highlight: Body['highlight']): string =>
  highlight
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mh-hl" style="margin:20px 0 0;background:${EMERALD_SOFT};border:1px dashed #6ee7b7;border-radius:14px;border-collapse:separate"><tr><td align="center" style="padding:16px 14px">
<div class="mh-muted" style="font-size:12px;color:${MUTED};letter-spacing:.3px">${escapeHtml(highlight.label)}</div>
<div class="mh-hl-v" style="margin-top:4px;font-family:${MONO};font-size:20px;line-height:1.35;font-weight:700;color:${EMERALD_DEEP};word-break:break-all">${escapeHtml(highlight.value)}</div>
</td></tr></table>`
    : '';

/** A "bulletproof" button: a coloured table cell, so it looks like a button even in Outlook. */
const buttonHtml = (button: Body['button'], locale: Locale): string =>
  button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:28px auto 0"><tr><td align="center" bgcolor="${EMERALD}" style="border-radius:12px;background:${EMERALD}">
<a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:12px">${escapeHtml(button.label)} &rarr;</a>
</td></tr></table>
<p class="mh-muted" style="margin:18px 0 0;font-size:12px;line-height:1.5;color:${MUTED};text-align:center">${escapeHtml(FOOTER[locale].fallback)}<br><span class="mh-link" style="word-break:break-all;color:${EMERALD_DEEP}">${escapeHtml(button.url)}</span></p>`
    : '';

const shell = (kind: MailKind, body: Body, locale: Locale, host: string | null): MailMessage => {
  const look = LOOK[kind];
  const iconBg = look.warn ? '#fef3c7' : EMERALD_SOFT;
  const iconLine = look.warn ? '#fcd34d' : '#a7f3d0';
  const preheader = (body.paragraphs[1] ?? body.paragraphs[0] ?? '').slice(0, PREHEADER_MAX);
  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(body.subject)}</title>${DARK_STYLE}</head>
<body class="mh-bg" style="margin:0;padding:0;background:${PAPER};font-family:${FONT};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mh-bg" style="background:${PAPER}"><tr><td align="center" style="padding:28px 12px 36px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
<tr><td bgcolor="${EMERALD_DEEP}" style="background:${EMERALD_DEEP};background-image:linear-gradient(135deg,#064e3b 0%,${EMERALD_DEEP} 45%,${EMERALD} 100%);border-radius:20px 20px 0 0;padding:26px 32px 58px" class="mh-pad">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" width="40" style="width:40px;height:40px;background:#10b981;background-image:linear-gradient(135deg,#34d399 0%,#047857 100%);border:1px solid rgba(255,255,255,.3);border-radius:10px;text-align:center;vertical-align:middle">
<div style="font-size:19px;font-weight:900;line-height:20px;color:#ffffff;padding-top:4px">M</div>
<div style="width:22px;height:5px;margin:3px auto 0;background:#ffffff;border-radius:2px;text-align:left;line-height:5px;font-size:0"><span style="display:inline-block;width:3px;height:3px;margin:1px 0 0 3px;background:#10b981;border-radius:50%"></span></div>
</td>
<td valign="middle" style="padding-left:12px"><div style="font-size:19px;font-weight:800;letter-spacing:.2px;color:#ffffff;line-height:1.1">MorniHosting</div>
<div style="font-size:12px;color:#a7f3d0;line-height:1.4;margin-top:2px">${locale === 'de' ? 'Dein Game-Server' : 'Your game server'}</div></td>
</tr></table></td></tr>
<tr><td class="mh-card mh-pad" style="background:#ffffff;border:1px solid ${LINE};border-top:0;border-radius:0 0 20px 20px;padding:0 32px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-top:0">
<div class="mh-icon" style="display:inline-block;width:72px;height:72px;margin-top:-36px;background:${iconBg};border:4px solid #ffffff;outline:1px solid ${iconLine};border-radius:50%;font-size:32px;line-height:72px;text-align:center">${look.icon}</div>
</td></tr></table>
<h1 class="mh-ink" style="margin:18px 0 18px;font-size:24px;line-height:1.3;font-weight:800;color:${INK};text-align:center;letter-spacing:-.2px">${escapeHtml(body.heading)}</h1>
${body.paragraphs.map((p) => `<p class="mh-ink" style="margin:0 0 12px;font-size:15px;line-height:1.65;color:${INK}">${escapeHtml(p)}</p>`).join('\n')}
${highlightHtml(body.highlight)}
${rowsHtml(body.rows)}
${buttonHtml(body.button, locale)}
${body.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0"><tr><td class="mh-box mh-muted" style="padding:12px 14px;background:${BOX};border-left:3px solid ${look.warn ? '#f59e0b' : EMERALD};border-radius:8px;font-size:13px;line-height:1.55;color:${MUTED}">${escapeHtml(body.note)}</td></tr></table>` : ''}
</td></tr>
<tr><td align="center" class="mh-muted" style="padding:22px 24px 0;font-size:12px;line-height:1.6;color:${MUTED}">
<b class="mh-link" style="color:${EMERALD_DEEP}">MorniHosting</b>${host ? ` &middot; ${escapeHtml(host)}` : ''}<br>${escapeHtml(FOOTER[locale].why)}
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    body.heading,
    '',
    ...body.paragraphs,
    ...(body.highlight ? ['', `${body.highlight.label}: ${body.highlight.value}`] : []),
    ...(body.rows ?? []).map(([label, value]) => `${label}: ${value}`),
    ...(body.button ? ['', `${body.button.label}: ${body.button.url}`] : []),
    ...(body.note ? ['', body.note] : []),
    '',
    '-- ',
    FOOTER[locale].why + (host ? ` (${host})` : ''),
  ].join('\n');
  return { subject: oneLine(body.subject), html, text };
};

type Copy = (vars: MailVars) => Body;

const hi: Readonly<Record<Locale, (name: string) => string>> = {
  de: (name) => `Hallo ${name},`,
  en: (name) => `Hi ${name},`,
};

const COPY: Readonly<Record<Locale, Readonly<Record<MailKind, Copy>>>> = {
  de: {
    test: () => ({
      subject: 'Test-Mail von MorniHosting',
      heading: 'Es funktioniert!',
      paragraphs: ['Diese Test-Mail ist angekommen. Dein Panel kann ab jetzt E-Mails verschicken.'],
    }),
    welcome: (v) => ({
      subject: 'Glückwunsch, du bist auserwählt 👑',
      heading: 'Du bist drin. Natürlich bist du drin.',
      paragraphs: [
        `Ey ${v.name},`,
        'halt dich fest: Von acht Milliarden Menschen auf diesem Planeten bist du einer der ganz wenigen besonderen Drecksäcke, die Zugriff auf MorniHosting bekommen. Nicht jeder. Nicht dein Nachbar. Nicht mal dein Lieblings-Streamer. Du.',
        'Und das hier ist kein 08/15-Hoster für das gemeine Volk. Das ist der richtig geile Scheiß: Server mit einem Klick, eigene Adresse, Backups, Mods, Live-Konsole – auf eigener Hardware, handverlesen, streng limitiert. Andere zahlen dafür monatlich und kriegen weniger.',
        'Also: Benimm dich wie ein VIP, bau was Legendäres und erzähl allen davon, die NICHT reindürfen. Machama, hippie hoppa! 🚀',
      ],
      rows: [
        ['Dein Benutzername', v['username'] ?? ''],
        ['Status', 'Auserwählt. Elite. Unantastbar.'],
      ],
      ...(v.link ? { button: { label: 'Ab in den VIP-Bereich', url: v.link } } : {}),
      note: 'Dein Passwort steht natürlich nicht in dieser Mail – das bekommst du persönlich überreicht. VIP-Behandlung eben.',
    }),
    register: (v) => ({
      subject: v.link ? 'Deine Anfrage ist raus – bitte E-Mail bestätigen' : 'Deine Anfrage ist raus',
      heading: 'Deine Anfrage ist raus 📬',
      paragraphs: [
        hi.de(v.name),
        v.link
          ? 'danke für deine Anfrage bei MorniHosting, sie ist angekommen. Bestätige bitte noch kurz deine E-Mail-Adresse. Der Link gilt 24 Stunden.'
          : 'danke für deine Anfrage bei MorniHosting, sie ist angekommen.',
        'Muss ein Admin dein Konto erst freigeben, bekommst du danach noch eine Mail, sobald es so weit ist.',
      ],
      ...(v.link ? { button: { label: 'E-Mail bestätigen', url: v.link } } : {}),
      note: 'Wenn du dich nicht angemeldet hast, kannst du diese Mail einfach löschen. Ohne Klick passiert nichts.',
    }),
    already_registered: (v) => ({
      subject: 'Du hast schon einen Zugang',
      heading: 'Zu dieser Adresse gibt es schon ein Konto',
      paragraphs: [
        hi.de(v.name),
        'jemand (vielleicht du) wollte sich mit dieser E-Mail-Adresse bei MorniHosting anmelden. Sie gehört aber schon zu einem Konto. Wenn du dein Passwort vergessen hast, kannst du dir auf der Anmeldeseite einen Link zum Zurücksetzen schicken lassen.',
      ],
      ...(v.link ? { button: { label: 'Zur Anmeldung', url: v.link } } : {}),
    }),
    email_change: (v) => ({
      subject: 'Bestätige deine neue E-Mail-Adresse',
      heading: 'Neue E-Mail-Adresse bestätigen',
      paragraphs: [
        hi.de(v.name),
        'du möchtest diese Adresse für dein MorniHosting-Konto verwenden. Bestätige das bitte mit einem Klick. Der Link gilt 24 Stunden.',
      ],
      ...(v.link ? { button: { label: 'Adresse bestätigen', url: v.link } } : {}),
      note: 'Wenn du das nicht warst, ignoriere diese Mail. Deine bisherige Adresse bleibt dann bestehen.',
    }),
    password_reset: (v) => ({
      subject: 'Passwort zurücksetzen',
      heading: 'Neues Passwort festlegen',
      paragraphs: [
        hi.de(v.name),
        'wir haben eine Anfrage bekommen, dein Passwort zurückzusetzen. Mit dem Knopf legst du ein neues fest. Der Link gilt 1 Stunde und lässt sich nur einmal benutzen.',
      ],
      ...(v.link ? { button: { label: 'Neues Passwort festlegen', url: v.link } } : {}),
      note: 'Wenn du das nicht warst, kannst du diese Mail löschen – dein Passwort bleibt, wie es ist.',
    }),
    server_ordered: (v) => ({
      subject: `Dein Server „${v['server'] ?? ''}“ ist bestellt`,
      heading: 'Dein Server ist bereit',
      paragraphs: [
        hi.de(v.name),
        'danke für deine Bestellung! So sieht dein neuer Server aus. Die Adresse gibst du deinen Freunden, damit sie beitreten können.',
      ],
      highlight: {
        label: 'Adresse für dich und deine Freunde',
        value: v['address'] ?? 'noch nicht festgelegt',
      },
      rows: [
        ['Name', v['server'] ?? ''],
        ['Paket', v['plan'] ?? ''],
        ['Software', v['software'] ?? ''],
        ['Bestellt am', v['when'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'Server öffnen', url: v.link } } : {}),
    }),
    server_crashed: (v) => ({
      subject: `Server „${v['server'] ?? ''}“ ist abgestürzt`,
      heading: 'Ein Server ist abgestürzt',
      paragraphs: [
        hi.de(v.name),
        `Der Server „${v['server'] ?? ''}“ ist abgestürzt.`,
        v['reason'] ?? '',
      ].filter(Boolean),
      rows: [['Zeitpunkt', v['when'] ?? '']],
      ...(v.link ? { button: { label: 'Server ansehen', url: v.link } } : {}),
    }),
    approval_needed: (v) => ({
      subject: `${v['who'] ?? ''} möchte bei MorniHosting mitmachen`,
      heading: 'Neue Registrierung wartet auf dich',
      paragraphs: [
        hi.de(v.name),
        `${v['who'] ?? ''} hat sich registriert und die E-Mail-Adresse bestätigt. Erst wenn du zustimmst, kann sich die Person anmelden.`,
      ],
      rows: [
        ['Benutzername', v['who'] ?? ''],
        ['E-Mail', v['email'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'Im Panel freigeben', url: v.link } } : {}),
      note: 'Freigeben oder ablehnen kannst du im Panel unter Benutzer oder, wenn verbunden, direkt in Discord.',
    }),
    account_approved: (v) => ({
      subject: 'Du bist freigeschaltet 🎉',
      heading: 'Willkommen bei MorniHosting',
      paragraphs: [hi.de(v.name), 'dein Konto wurde freigegeben. Du kannst dich ab sofort anmelden.'],
      ...(v.link ? { button: { label: 'Jetzt anmelden', url: v.link } } : {}),
    }),
    account_rejected: (v) => ({
      subject: 'Deine Registrierung bei MorniHosting',
      heading: 'Leider keine Freigabe',
      paragraphs: [
        hi.de(v.name),
        'deine Registrierung wurde nicht freigegeben. Dein Konto und deine Daten wurden gelöscht.',
        v['note'] ? `Begründung: ${v['note']}` : '',
      ].filter(Boolean),
    }),
    request_new: (v) => ({
      subject: `${v['who'] ?? ''} fragt einen Server an`,
      heading: 'Neue Server-Anfrage',
      paragraphs: [hi.de(v.name), `${v['who'] ?? ''} möchte einen Server. Bitte gib ihn frei oder lehne ab.`],
      rows: [
        ['Name', v['server'] ?? ''],
        ['Spiel', v['software'] ?? ''],
        ['Paket', v['plan'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'Anfrage ansehen', url: v.link } } : {}),
      note: 'Freigeben kannst du im Panel unter Server-Anfragen oder, wenn verbunden, direkt in Discord.',
    }),
    request_approved: (v) => ({
      subject: `Dein Server „${v['server'] ?? ''}“ wurde freigegeben`,
      heading: 'Anfrage angenommen 🚀',
      paragraphs: [
        hi.de(v.name),
        `dein Server „${v['server'] ?? ''}“ wurde freigegeben und wird jetzt angelegt.`,
      ],
      ...(v.link ? { button: { label: 'Server öffnen', url: v.link } } : {}),
    }),
    request_rejected: (v) => ({
      subject: `Deine Anfrage für „${v['server'] ?? ''}“`,
      heading: 'Anfrage abgelehnt',
      paragraphs: [
        hi.de(v.name),
        `deine Anfrage für den Server „${v['server'] ?? ''}“ wurde leider abgelehnt.`,
        v['note'] ? `Begründung: ${v['note']}` : '',
      ].filter(Boolean),
    }),
  },
  en: {
    test: () => ({
      subject: 'Test mail from MorniHosting',
      heading: 'It works!',
      paragraphs: ['This test mail arrived. Your panel can send e-mails from now on.'],
    }),
    welcome: (v) => ({
      subject: 'Congratulations, you have been chosen 👑',
      heading: 'You are in. Of course you are in.',
      paragraphs: [
        `Yo ${v.name},`,
        'brace yourself: out of eight billion people on this planet, you are one of the very few special bastards who get access to MorniHosting. Not everyone. Not your neighbour. Not even your favourite streamer. You.',
        'And this is no run-of-the-mill hoster for the common folk. This is the really good stuff: servers in one click, your own address, backups, mods, live console – on private hardware, hand-picked, strictly limited. Other people pay monthly for less.',
        'So: act like a VIP, build something legendary and tell everyone who is NOT allowed in. Machama, hippie hoppa! 🚀',
      ],
      rows: [
        ['Your username', v['username'] ?? ''],
        ['Status', 'Chosen. Elite. Untouchable.'],
      ],
      ...(v.link ? { button: { label: 'Enter the VIP area', url: v.link } } : {}),
      note: 'Your password is of course not in this mail – you get it handed over in person. VIP treatment.',
    }),
    register: (v) => ({
      subject: v.link ? 'Your request is in – please confirm your e-mail' : 'Your request is in',
      heading: 'Your request is in 📬',
      paragraphs: [
        hi.en(v.name),
        v.link
          ? 'thanks for your request at MorniHosting, it has arrived. Please confirm your e-mail address. The link is valid for 24 hours.'
          : 'thanks for your request at MorniHosting, it has arrived.',
        'If an admin has to approve your account first, you get another mail as soon as that happens.',
      ],
      ...(v.link ? { button: { label: 'Confirm e-mail', url: v.link } } : {}),
      note: 'If you did not sign up, just delete this mail. Nothing happens without the click.',
    }),
    already_registered: (v) => ({
      subject: 'You already have an account',
      heading: 'This address already has an account',
      paragraphs: [
        hi.en(v.name),
        'someone (maybe you) tried to sign up at MorniHosting with this e-mail address, but it already belongs to an account. If you forgot your password, you can get a reset link on the login page.',
      ],
      ...(v.link ? { button: { label: 'Go to login', url: v.link } } : {}),
    }),
    email_change: (v) => ({
      subject: 'Confirm your new e-mail address',
      heading: 'Confirm your new e-mail address',
      paragraphs: [
        hi.en(v.name),
        'you want to use this address for your MorniHosting account. Please confirm with one click. The link is valid for 24 hours.',
      ],
      ...(v.link ? { button: { label: 'Confirm address', url: v.link } } : {}),
      note: 'If this was not you, ignore this mail. Your current address stays as it is.',
    }),
    password_reset: (v) => ({
      subject: 'Reset your password',
      heading: 'Choose a new password',
      paragraphs: [
        hi.en(v.name),
        'we got a request to reset your password. Use the button to choose a new one. The link is valid for 1 hour and works only once.',
      ],
      ...(v.link ? { button: { label: 'Choose a new password', url: v.link } } : {}),
      note: 'If this was not you, delete this mail – your password stays as it is.',
    }),
    server_ordered: (v) => ({
      subject: `Your server “${v['server'] ?? ''}” is ordered`,
      heading: 'Your server is ready',
      paragraphs: [
        hi.en(v.name),
        'thanks for your order! This is your new server. Give the address to your friends so they can join.',
      ],
      highlight: { label: 'Address for you and your friends', value: v['address'] ?? 'not set yet' },
      rows: [
        ['Name', v['server'] ?? ''],
        ['Plan', v['plan'] ?? ''],
        ['Software', v['software'] ?? ''],
        ['Ordered on', v['when'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'Open server', url: v.link } } : {}),
    }),
    server_crashed: (v) => ({
      subject: `Server “${v['server'] ?? ''}” crashed`,
      heading: 'A server crashed',
      paragraphs: [hi.en(v.name), `The server “${v['server'] ?? ''}” crashed.`, v['reason'] ?? ''].filter(
        Boolean,
      ),
      rows: [['Time', v['when'] ?? '']],
      ...(v.link ? { button: { label: 'View server', url: v.link } } : {}),
    }),
    approval_needed: (v) => ({
      subject: `${v['who'] ?? ''} wants to join MorniHosting`,
      heading: 'A new sign-up is waiting for you',
      paragraphs: [
        hi.en(v.name),
        `${v['who'] ?? ''} signed up and confirmed the e-mail address. They can only log in once you agree.`,
      ],
      rows: [
        ['Username', v['who'] ?? ''],
        ['E-mail', v['email'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'Approve in the panel', url: v.link } } : {}),
      note: 'Approve or decline in the panel under Users or, if linked, right in Discord.',
    }),
    account_approved: (v) => ({
      subject: 'You are in 🎉',
      heading: 'Welcome to MorniHosting',
      paragraphs: [hi.en(v.name), 'your account was approved. You can log in now.'],
      ...(v.link ? { button: { label: 'Log in now', url: v.link } } : {}),
    }),
    account_rejected: (v) => ({
      subject: 'Your sign-up at MorniHosting',
      heading: 'Not approved',
      paragraphs: [
        hi.en(v.name),
        'your sign-up was not approved. Your account and data were deleted.',
        v['note'] ? `Reason: ${v['note']}` : '',
      ].filter(Boolean),
    }),
    request_new: (v) => ({
      subject: `${v['who'] ?? ''} asks for a server`,
      heading: 'New server request',
      paragraphs: [hi.en(v.name), `${v['who'] ?? ''} would like a server. Please approve or decline.`],
      rows: [
        ['Name', v['server'] ?? ''],
        ['Game', v['software'] ?? ''],
        ['Plan', v['plan'] ?? ''],
      ],
      ...(v.link ? { button: { label: 'View request', url: v.link } } : {}),
      note: 'Approve in the panel under Server requests or, if linked, right in Discord.',
    }),
    request_approved: (v) => ({
      subject: `Your server “${v['server'] ?? ''}” was approved`,
      heading: 'Request approved 🚀',
      paragraphs: [hi.en(v.name), `your server “${v['server'] ?? ''}” was approved and is being set up now.`],
      ...(v.link ? { button: { label: 'Open server', url: v.link } } : {}),
    }),
    request_rejected: (v) => ({
      subject: `Your request for “${v['server'] ?? ''}”`,
      heading: 'Request declined',
      paragraphs: [
        hi.en(v.name),
        `your request for the server “${v['server'] ?? ''}” was declined.`,
        v['note'] ? `Reason: ${v['note']}` : '',
      ].filter(Boolean),
    }),
  },
};

/** Renders one mail. Values from users are made single-line first; HTML escaping happens in the shell. */
export function renderMail(kind: MailKind, locale: Locale, vars: MailVars): MailMessage {
  const clean = Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [key, typeof value === 'string' ? oneLine(value) : value]),
  ) as MailVars;
  return shell(kind, COPY[locale][kind](clean), locale, clean.host);
}
