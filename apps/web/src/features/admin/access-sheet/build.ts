import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import QRCode from 'qrcode';
import logoUrl from '@/assets/logo.svg?url';

/**
 * The access sheet: one A4 page with the panel address, the login data and a short quick start, made in the
 * browser so the password never leaves this page again. Built with pdf-lib's standard fonts (no font files to
 * ship), so text is limited to the Latin-1 range; anything else is replaced.
 */

export interface AccessSheetTexts {
  readonly brandTag: string;
  readonly welcome: string;
  readonly intro: string;
  readonly dataTitle: string;
  readonly address: string;
  readonly username: string;
  readonly password: string;
  readonly email: string;
  readonly qrHint: string;
  readonly stepsTitle: string;
  readonly steps: readonly { readonly title: string; readonly text: string }[];
  readonly javaTitle: string;
  readonly javaText: string;
  readonly bedrockTitle: string;
  readonly bedrockText: string;
  readonly warning: string;
  readonly footer: string;
}

export interface AccessSheetInput {
  readonly address: string;
  readonly username: string;
  readonly password: string;
  readonly email: string | null;
  readonly texts: AccessSheetTexts;
}

const PAGE = { width: 595.28, height: 841.89, margin: 44 } as const;
const BAND = { height: 196, slices: 48, logo: 40 } as const;
const SIZE = {
  brand: 15,
  tag: 9,
  welcome: 26,
  intro: 11.5,
  title: 13.5,
  label: 8,
  value: 12.5,
  body: 10,
  small: 8.5,
} as const;
const LINE = 1.4;
const CARD = { radius: 12, pad: 20, rowGap: 34, qr: 112 } as const;
const STEP = { circle: 11, gap: 14, textIndent: 34 } as const;
const BOX_GAP = 14;
const QR_PIXELS = 512;
const LOGO_PIXELS = 256;
const BAND_DOTS = 0.12;
const PIXEL_SIZE = 14;

const hex = (value: string): RGB => {
  const n = Number.parseInt(value.slice(1), 16);
  // eslint-disable-next-line ts-patterns/no-magic-numbers -- splitting #rrggbb into its three bytes
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const COLOURS = {
  bandTop: hex('#022c22'),
  bandBottom: hex('#047857'),
  pixel: hex('#34d399'),
  white: hex('#ffffff'),
  mint: hex('#d1fae5'),
  ink: hex('#0f1f1a'),
  muted: hex('#5b6b65'),
  line: hex('#dbe7e1'),
  card: hex('#f4faf7'),
  accent: hex('#10b981'),
  accentDark: hex('#047857'),
  warnBg: hex('#fff7e6'),
  warnInk: hex('#8a5300'),
  warnLine: hex('#f5c46b'),
} as const;

/** Mixes two colours, t = 0 … 1. */
const mix = (a: RGB, b: RGB, t: number): RGB =>
  rgb(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t);

/** Keeps only characters the standard font can draw. */
function safeFor(font: PDFFont): (text: string) => string {
  const allowed = new Set(font.getCharacterSet());
  return (text) =>
    Array.from(text.normalize('NFC'))
      .map((ch) => (allowed.has(ch.codePointAt(0) ?? 0) ? ch : '?'))
      .join('');
}

/** Splits text into lines no wider than maxWidth. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  return text.split(' ').reduce<string[]>((lines, word) => {
    const last = lines.at(-1);
    const joined = last === undefined ? word : `${last} ${word}`;
    if (last !== undefined && font.widthOfTextAtSize(joined, size) > maxWidth) return [...lines, word];
    return [...lines.slice(0, -1), joined];
  }, []);
}

/** An SVG path for a rounded rectangle with its top-left corner at 0,0 (pdf-lib draws SVG paths y-down). */
const roundedRect = (w: number, h: number, r: number): string =>
  `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} ` +
  `A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;

async function svgToPng(url: string, pixels: number): Promise<Uint8Array> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.getContext('2d')?.drawImage(image, 0, 0, pixels, pixels);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await (blob ?? new Blob()).arrayBuffer());
}

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
  readonly safe: (text: string) => string;
}

function drawBand(page: PDFPage, fonts: Fonts, logo: PDFImage, texts: AccessSheetTexts): void {
  const slice = BAND.height / BAND.slices;
  Array.from({ length: BAND.slices }, (_, i) =>
    page.drawRectangle({
      x: 0,
      y: PAGE.height - (i + 1) * slice,
      width: PAGE.width,
      height: slice + 1,
      color: mix(COLOURS.bandTop, COLOURS.bandBottom, i / BAND.slices),
    }),
  );
  // A few block "pixels" fading out to the right, a nod to the game without using its art.
  const columns = 9;
  const rows = 6;
  Array.from({ length: columns * rows }, (_, i) => ({ col: i % columns, row: Math.floor(i / columns) }))
    .filter(({ col, row }) => (col * 7 + row * 3) % 5 < 2)
    .map(({ col, row }) =>
      page.drawRectangle({
        x: PAGE.width - (columns - col) * PIXEL_SIZE - PAGE.margin / 2,
        y: PAGE.height - (row + 1) * PIXEL_SIZE - PAGE.margin / 2,
        width: PIXEL_SIZE - 2,
        height: PIXEL_SIZE - 2,
        color: COLOURS.pixel,
        opacity: BAND_DOTS + (col / columns) * BAND_DOTS * 2,
      }),
    );
  const top = PAGE.height - PAGE.margin;
  page.drawImage(logo, { x: PAGE.margin, y: top - BAND.logo + 6, width: BAND.logo, height: BAND.logo });
  page.drawText('MorniHosting', {
    x: PAGE.margin + BAND.logo + 12,
    y: top - 14,
    size: SIZE.brand,
    font: fonts.bold,
    color: COLOURS.white,
  });
  page.drawText(fonts.safe(texts.brandTag).toUpperCase(), {
    x: PAGE.margin + BAND.logo + 12,
    y: top - 29,
    size: SIZE.tag,
    font: fonts.bold,
    color: COLOURS.mint,
  });
  const welcome = wrap(fonts.safe(texts.welcome), fonts.bold, SIZE.welcome, PAGE.width - PAGE.margin * 2);
  welcome.map((line, i) =>
    page.drawText(line, {
      x: PAGE.margin,
      y: top - 82 - i * SIZE.welcome * 1.15,
      size: SIZE.welcome,
      font: fonts.bold,
      color: COLOURS.white,
    }),
  );
  const introTop = top - 82 - welcome.length * SIZE.welcome * 1.15 - 6;
  wrap(fonts.safe(texts.intro), fonts.regular, SIZE.intro, PAGE.width - PAGE.margin * 2).map((line, i) =>
    page.drawText(line, {
      x: PAGE.margin,
      y: introTop - i * SIZE.intro * LINE,
      size: SIZE.intro,
      font: fonts.regular,
      color: COLOURS.mint,
    }),
  );
}

/** The login card; returns the y below it. */
function drawCard(page: PDFPage, fonts: Fonts, qr: PDFImage, input: AccessSheetInput, top: number): number {
  const { texts } = input;
  const width = PAGE.width - PAGE.margin * 2;
  const rows = [
    { label: texts.address, value: input.address, font: fonts.bold },
    { label: texts.username, value: input.username, font: fonts.mono },
    { label: texts.password, value: input.password, font: fonts.mono },
    ...(input.email ? [{ label: texts.email, value: input.email, font: fonts.regular }] : []),
  ];
  const height = Math.max(CARD.pad * 2 + 26 + rows.length * CARD.rowGap, CARD.qr + CARD.pad * 2 + 30);
  page.drawSvgPath(roundedRect(width, height, CARD.radius), {
    x: PAGE.margin,
    y: top,
    color: COLOURS.card,
    borderColor: COLOURS.line,
    borderWidth: 1,
  });
  page.drawRectangle({
    x: PAGE.margin,
    y: top - height + CARD.radius,
    width: 4,
    height: height - CARD.radius * 2,
    color: COLOURS.accent,
  });
  const left = PAGE.margin + CARD.pad + 4;
  page.drawText(fonts.safe(texts.dataTitle), {
    x: left,
    y: top - CARD.pad - SIZE.title,
    size: SIZE.title,
    font: fonts.bold,
    color: COLOURS.ink,
  });
  const valueWidth = width - CARD.pad * 3 - CARD.qr - 4;
  rows.map((row, i) => {
    const y = top - CARD.pad - 26 - i * CARD.rowGap;
    page.drawText(fonts.safe(row.label).toUpperCase(), {
      x: left,
      y: y - SIZE.label,
      size: SIZE.label,
      font: fonts.bold,
      color: COLOURS.muted,
    });
    const value = fonts.safe(row.value);
    const size = Math.min(
      SIZE.value,
      (SIZE.value * valueWidth) / Math.max(1, row.font.widthOfTextAtSize(value, SIZE.value)),
    );
    return page.drawText(value, {
      x: left,
      y: y - SIZE.label - 4 - size,
      size,
      font: row.font,
      color: COLOURS.ink,
    });
  });
  const qrX = PAGE.margin + width - CARD.pad - CARD.qr;
  const qrTop = top - CARD.pad;
  page.drawSvgPath(roundedRect(CARD.qr + 8, CARD.qr + 8, 8), {
    x: qrX - 4,
    y: qrTop + 4,
    color: COLOURS.white,
    borderColor: COLOURS.line,
    borderWidth: 1,
  });
  page.drawImage(qr, { x: qrX, y: qrTop - CARD.qr, width: CARD.qr, height: CARD.qr });
  const hint = fonts.safe(texts.qrHint);
  page.drawText(hint, {
    x: qrX + (CARD.qr - fonts.regular.widthOfTextAtSize(hint, SIZE.small)) / 2,
    y: qrTop - CARD.qr - 18,
    size: SIZE.small,
    font: fonts.regular,
    color: COLOURS.muted,
  });
  return top - height;
}

/** Numbered steps; returns the y below them. */
function drawSteps(page: PDFPage, fonts: Fonts, texts: AccessSheetTexts, top: number): number {
  page.drawText(fonts.safe(texts.stepsTitle), {
    x: PAGE.margin,
    y: top - SIZE.title,
    size: SIZE.title,
    font: fonts.bold,
    color: COLOURS.ink,
  });
  const textWidth = PAGE.width - PAGE.margin * 2 - STEP.textIndent;
  return texts.steps.reduce(
    (y, step, i) => {
      const cx = PAGE.margin + STEP.circle;
      const cy = y - STEP.circle;
      page.drawCircle({ x: cx, y: cy, size: STEP.circle, color: COLOURS.accent });
      const number = String(i + 1);
      page.drawText(number, {
        x: cx - fonts.bold.widthOfTextAtSize(number, SIZE.body + 1) / 2,
        y: cy - (SIZE.body + 1) / 2 + 1.5,
        size: SIZE.body + 1,
        font: fonts.bold,
        color: COLOURS.white,
      });
      const x = PAGE.margin + STEP.textIndent;
      page.drawText(fonts.safe(step.title), {
        x,
        y: y - SIZE.body - 2,
        size: SIZE.body + 1,
        font: fonts.bold,
        color: COLOURS.ink,
      });
      const lines = wrap(fonts.safe(step.text), fonts.regular, SIZE.body, textWidth);
      lines.map((line, n) =>
        page.drawText(line, {
          x,
          y: y - SIZE.body - 6 - (n + 1) * SIZE.body * LINE,
          size: SIZE.body,
          font: fonts.regular,
          color: COLOURS.muted,
        }),
      );
      return y - Math.max(STEP.circle * 2, SIZE.body + 6 + (lines.length + 1) * SIZE.body * LINE) - STEP.gap;
    },
    top - SIZE.title - 16,
  );
}

/** Two boxes side by side: how to join in Java and in Bedrock. Returns the y below them. */
function drawGameBoxes(page: PDFPage, fonts: Fonts, texts: AccessSheetTexts, top: number): number {
  const width = (PAGE.width - PAGE.margin * 2 - BOX_GAP) / 2;
  const inner = width - CARD.pad * 2;
  const boxes = [
    { title: texts.javaTitle, text: texts.javaText, colour: COLOURS.accentDark },
    { title: texts.bedrockTitle, text: texts.bedrockText, colour: hex('#2563eb') },
  ].map((box) => ({ ...box, lines: wrap(fonts.safe(box.text), fonts.regular, SIZE.body, inner) }));
  const height =
    CARD.pad * 2 + SIZE.body + 8 + Math.max(...boxes.map((b) => b.lines.length)) * SIZE.body * LINE;
  boxes.map((box, i) => {
    const x = PAGE.margin + i * (width + BOX_GAP);
    page.drawSvgPath(roundedRect(width, height, CARD.radius), {
      x,
      y: top,
      color: COLOURS.white,
      borderColor: COLOURS.line,
      borderWidth: 1,
    });
    page.drawSvgPath(roundedRect(width, 5, 2.5), { x, y: top, color: box.colour });
    page.drawText(fonts.safe(box.title), {
      x: x + CARD.pad,
      y: top - CARD.pad - SIZE.body,
      size: SIZE.body + 1,
      font: fonts.bold,
      color: COLOURS.ink,
    });
    return box.lines.map((line, n) =>
      page.drawText(line, {
        x: x + CARD.pad,
        y: top - CARD.pad - SIZE.body - 8 - (n + 1) * SIZE.body * LINE + 2,
        size: SIZE.body,
        font: fonts.regular,
        color: COLOURS.muted,
      }),
    );
  });
  return top - height;
}

function drawWarning(page: PDFPage, fonts: Fonts, texts: AccessSheetTexts, top: number): number {
  const width = PAGE.width - PAGE.margin * 2;
  const lines = wrap(fonts.safe(texts.warning), fonts.bold, SIZE.body, width - CARD.pad * 2 - 16);
  const height = 24 + lines.length * SIZE.body * LINE;
  page.drawSvgPath(roundedRect(width, height, 10), {
    x: PAGE.margin,
    y: top,
    color: COLOURS.warnBg,
    borderColor: COLOURS.warnLine,
    borderWidth: 1,
  });
  page.drawText('!', {
    x: PAGE.margin + 14,
    y: top - 12 - SIZE.body,
    size: SIZE.body + 3,
    font: fonts.bold,
    color: COLOURS.warnInk,
  });
  lines.map((line, n) =>
    page.drawText(line, {
      x: PAGE.margin + CARD.pad + 8,
      y: top - 12 - SIZE.body - n * SIZE.body * LINE + 1,
      size: SIZE.body,
      font: fonts.bold,
      color: COLOURS.warnInk,
    }),
  );
  return top - height;
}

/** Builds the PDF and returns its bytes. */
export async function buildAccessSheet(input: AccessSheetInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`MorniHosting – ${input.username}`);
  pdf.setCreator('MorniHosting');
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const fonts: Fonts = {
    regular,
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.CourierBold),
    safe: safeFor(regular),
  };
  const [logo, qr] = await Promise.all([
    svgToPng(logoUrl, LOGO_PIXELS).then((png) => pdf.embedPng(png)),
    QRCode.toDataURL(input.address, {
      width: QR_PIXELS,
      margin: 1,
      color: { dark: '#0f1f1a', light: '#ffffff' },
    }).then((url) => pdf.embedPng(url)),
  ]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: COLOURS.white });
  drawBand(page, fonts, logo, input.texts);
  const afterCard = drawCard(page, fonts, qr, input, PAGE.height - BAND.height - 26);
  const afterSteps = drawSteps(page, fonts, input.texts, afterCard - 28);
  const afterBoxes = drawGameBoxes(page, fonts, input.texts, afterSteps - 4);
  drawWarning(page, fonts, input.texts, afterBoxes - 18);
  const footer = fonts.safe(input.texts.footer);
  page.drawLine({
    start: { x: PAGE.margin, y: PAGE.margin - 2 },
    end: { x: PAGE.width - PAGE.margin, y: PAGE.margin - 2 },
    thickness: 0.5,
    color: COLOURS.line,
  });
  page.drawText(footer, {
    x: PAGE.margin,
    y: PAGE.margin - 16,
    size: SIZE.small,
    font: fonts.regular,
    color: COLOURS.muted,
  });
  return pdf.save();
}

/** Hands the PDF to the browser as a download. */
export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
