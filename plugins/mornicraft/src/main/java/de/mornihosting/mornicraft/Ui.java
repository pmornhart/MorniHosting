package de.mornihosting.mornicraft;

import java.lang.reflect.Method;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.audience.Audience;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.title.Title;
import org.bukkit.entity.Player;

/**
 * How MorniCraft looks in the chat: calm grey text, the important part in white, one small coloured icon in front,
 * cards with a soft frame and buttons you can click. Looks the same on Java and Bedrock (no strikethrough lines,
 * which Bedrock cannot show). Builds everything itself (no MiniMessage), so it runs on Paper 1.17 and newer.
 */
final class Ui {
  static final TextColor ACCENT = TextColor.color(0x34d399);
  static final TextColor ACCENT_2 = TextColor.color(0x22d3ee);
  static final TextColor SOFT = TextColor.color(0xb4c2bc);
  static final TextColor DIM = TextColor.color(0x4b5753);
  static final TextColor BAD = TextColor.color(0xf87171);
  static final TextColor MAIL = TextColor.color(0xc4b5fd);
  static final TextColor GOLD = TextColor.color(0xfbbf24);

  private static final String BAR = "▬";
  private static final int BEDROCK_SIDE = 6;
  private static final int BEDROCK_FULL = 20;
  /** Width of a card in the Java chat (pixels at GUI scale 1; the chat is 320 wide). */
  static final int CARD_PX = 296;
  private static final int SPACE_PX = 4;
  private static final int SYMBOL_PX = 9;
  /** Tags in the texts: <hl>…</hl> (highlight) and <name> (a value). */
  private static final Pattern TAG = Pattern.compile("<(/?)([a-z]+)>");

  /** A value for a <name> tag: as component and as plain text (for Bedrock menus and titles). */
  record Value(String name, Component component, String plain) {}

  private final Texts texts;
  private final Predicate<Player> bedrock;

  Ui(Texts texts, Predicate<Player> bedrock) {
    this.texts = texts;
    this.bedrock = bedrock;
  }

  // ── Widths of the Java chat font (advance in pixels incl. the 1-pixel gap; bold adds 1) ────────────

  /** Width of one character in Minecraft's default font. */
  static int charWidth(char ch) {
    switch (ch) {
      case ' ': return SPACE_PX;
      case '!': case '\'': case ',': case '.': case ':': case ';': case '|': case 'i': case '·': return 2;
      case 'l': case '`': return 3;
      case '"': case '(': case ')': case '*': case 'I': case '[': case ']': case 't': case '{': case '}': return 4;
      case '<': case '>': case 'f': case 'k': return 5;
      case '@': case '~': case '–': return 7;
      default: return ch < 0x250 ? 6 : SYMBOL_PX;
    }
  }

  /** Width of a component in the Java chat, following bold through its children. */
  static int width(Component c) {
    return width(c, false);
  }

  private static int width(Component c, boolean parentBold) {
    TextDecoration.State st = c.decoration(TextDecoration.BOLD);
    boolean bold = st == TextDecoration.State.TRUE || (st == TextDecoration.State.NOT_SET && parentBold);
    int w = 0;
    if (c instanceof TextComponent t) {
      for (char ch : t.content().toCharArray()) w += charWidth(ch) + (bold && ch != ' ' ? 1 : 0) + (bold && ch == ' ' ? 1 : 0);
    }
    for (Component child : c.children()) w += width(child, bold);
    return w;
  }

  /** Spaces in front, so the line sits in the middle of the card. */
  static Component center(Component line) {
    int pad = Math.max(0, (CARD_PX - width(line)) / 2 / SPACE_PX);
    return pad == 0 ? line : Component.text(" ".repeat(pad)).append(line);
  }

  /** Splits pieces into rows that fit the card (separated by `gap`). */
  static List<Component> rows(List<Component> pieces, Component gap, int maxPx) {
    List<Component> rows = new ArrayList<>();
    Component row = null;
    int w = 0;
    int gapW = width(gap);
    for (Component piece : pieces) {
      int pw = width(piece);
      if (row != null && w + gapW + pw > maxPx) {
        rows.add(row);
        row = null;
      }
      if (row == null) {
        row = piece;
        w = pw;
      } else {
        row = row.append(gap).append(piece);
        w += gapW + pw;
      }
    }
    if (row != null) rows.add(row);
    return rows;
  }

  boolean bedrock(Audience to) {
    return to instanceof Player p && bedrock.test(p);
  }

  /** A value typed by a player or an admin: shown as it is, never as formatting. */
  static Value v(String name, Object value) {
    String s = String.valueOf(value);
    return new Value(name, Component.text(s), s);
  }

  static Value c(String name, Component value) {
    return new Value(name, value, plain(value));
  }

  static String plain(Component c) {
    StringBuilder b = new StringBuilder();
    collect(c, b);
    return b.toString();
  }

  private static void collect(Component c, StringBuilder b) {
    if (c instanceof TextComponent t) b.append(t.content());
    c.children().forEach(child -> collect(child, b));
  }

  private static Value find(Value[] values, String name) {
    for (Value v : values) if (v.name().equals(name)) return v;
    return null;
  }

  /** The text with values filled in; <hl> parts in white, the rest in the given colour (or none). */
  private Component build(String key, TextColor base, Value... values) {
    String text = texts.get(key);
    TextComponent.Builder out = Component.text();
    if (base != null) out.color(base);
    Matcher m = TAG.matcher(text);
    int at = 0;
    boolean hl = false;
    while (m.find()) {
      if (m.start() > at) out.append(piece(text.substring(at, m.start()), hl));
      String name = m.group(2);
      if (name.equals("hl")) {
        hl = m.group(1).isEmpty();
      } else {
        Value v = find(values, name);
        out.append(v == null ? Component.text(m.group()) : hl ? v.component().colorIfAbsent(NamedTextColor.WHITE) : v.component());
      }
      at = m.end();
    }
    if (at < text.length()) out.append(piece(text.substring(at), hl));
    return out.build();
  }

  private static Component piece(String s, boolean hl) {
    return hl ? Component.text(s, NamedTextColor.WHITE) : Component.text(s);
  }

  /** The words of a text in calm grey, with <hl> parts in white. */
  Component words(String key, Value... values) {
    return build(key, SOFT, values);
  }

  /** The words without a colour of their own (titles, buttons, hover texts). */
  Component bare(String key, Value... values) {
    return build(key, null, values);
  }

  /** Plain text without any formatting (Bedrock menus, frame titles). */
  String flat(String key, Value... values) {
    String text = texts.get(key);
    StringBuilder b = new StringBuilder();
    Matcher m = TAG.matcher(text);
    int at = 0;
    while (m.find()) {
      b.append(text, at, m.start());
      if (!m.group(2).equals("hl")) {
        Value v = find(values, m.group(2));
        b.append(v == null ? m.group() : v.plain());
      }
      at = m.end();
    }
    return b.append(text.substring(at)).toString();
  }

  private static Component icon(String icon, TextColor color) {
    return Component.text(icon + " ", color);
  }

  Component ok(String key, Value... values) {
    return icon("✔", ACCENT).append(words(key, values));
  }

  Component fail(String key, Value... values) {
    return icon("✖", BAD).append(words(key, values));
  }

  Component note(String symbol, TextColor color, String key, Value... values) {
    return icon(symbol, color).append(words(key, values));
  }

  /** Text in the MorniCraft colours, from green to blue, letter by letter. */
  static Component gradient(String text, boolean bold) {
    TextComponent.Builder b = Component.text();
    int n = Math.max(1, text.length() - 1);
    for (int i = 0; i < text.length(); i++) {
      float t = (float) i / n;
      TextColor col = TextColor.color(
          (int) (ACCENT.red() + (ACCENT_2.red() - ACCENT.red()) * t),
          (int) (ACCENT.green() + (ACCENT_2.green() - ACCENT.green()) * t),
          (int) (ACCENT.blue() + (ACCENT_2.blue() - ACCENT.blue()) * t));
      b.append(Component.text(text.charAt(i), col));
    }
    return bold ? b.decoration(TextDecoration.BOLD, true).build() : b.build();
  }

  /**
   * The top of a card: a fine line, the title in the middle in the MorniCraft colours, a fine line – exactly as
   * wide as the closing line. Bedrock cannot draw struck-through spaces: it gets "▬" bars.
   */
  Component header(Audience to, String title) {
    Component name = Component.text(" ").append(gradient(title, true)).append(Component.text(" "));
    if (bedrock(to)) {
      Component bars = Component.text(BAR.repeat(BEDROCK_SIDE), DIM);
      return Component.text().append(bars).append(name).append(bars).build();
    }
    int side = Math.max(1, (CARD_PX - width(name)) / 2 / SPACE_PX);
    return Component.text().append(line(side)).append(name).append(line(side)).build();
  }

  Component footer(Audience to) {
    if (bedrock(to)) return Component.text(BAR.repeat(BEDROCK_FULL), DIM);
    return line(CARD_PX / SPACE_PX);
  }

  private static Component line(int spaces) {
    return Component.text(" ".repeat(spaces), DIM).decoration(TextDecoration.STRIKETHROUGH, true);
  }

  /** A card with every line in the middle (Bedrock: left, its chat font differs). */
  void card(Audience to, String title, List<Component> lines) {
    card(to, title, lines, true);
  }

  void card(Audience to, String title, List<Component> lines, boolean centered) {
    boolean mid = centered && !bedrock(to);
    to.sendMessage(header(to, title));
    lines.forEach(l -> to.sendMessage(l == Component.empty() ? l : mid ? center(l) : Component.text(" ").append(l)));
    to.sendMessage(footer(to));
  }

  /** A button: "[ label ]" in its colour, a hint when the mouse is on it, an action on click. */
  static Component button(Component label, TextColor color, Component hover, ClickEvent click) {
    TextComponent.Builder b = Component.text().color(color).decoration(TextDecoration.BOLD, true)
        .append(Component.text("[ ")).append(label).append(Component.text(" ]"));
    if (hover != null) b.hoverEvent(HoverEvent.showText(hover));
    if (click != null) b.clickEvent(click);
    return b.build();
  }

  /**
   * A title with fade in, stay and fade out. Adventure named the factory "of" (Paper 1.17 … 1.21) and "times"
   * (newer, Paper 26 has only that one): whichever exists is used, so the plugin runs on all of them.
   */
  static Title title(Component main, Component sub, Duration in, Duration stay, Duration out) {
    Title.Times times = TITLE_TIMES == null ? null : timesOf(in, stay, out);
    return times == null ? Title.title(main, sub) : Title.title(main, sub, times);
  }

  private static final Method TITLE_TIMES = findTitleTimes();

  private static Method findTitleTimes() {
    for (String name : new String[] {"times", "of"}) {
      try {
        return Title.Times.class.getMethod(name, Duration.class, Duration.class, Duration.class);
      } catch (NoSuchMethodException | RuntimeException missing) {
        // try the other name
      }
    }
    return null;
  }

  private static Title.Times timesOf(Duration in, Duration stay, Duration out) {
    try {
      return (Title.Times) TITLE_TIMES.invoke(null, in, stay, out);
    } catch (ReflectiveOperationException | RuntimeException e) {
      return null;
    }
  }

  static Component gap() {
    return Component.text("   ");
  }
}
