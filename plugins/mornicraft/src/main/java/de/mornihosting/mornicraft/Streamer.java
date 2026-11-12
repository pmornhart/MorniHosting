package de.mornihosting.mornicraft;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import net.kyori.adventure.audience.Audience;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextReplacementConfig;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

/**
 * The streamer mode (/streamer): for players who stream or record. What could give the server away or should not be
 * on stream is hidden for them – IP addresses and the server's addresses (chat, bar, /info), coordinates (/getpos,
 * homes), private messages (readable with the mouse) – and the others see "● LIVE" in front of their name in the
 * chat. Each part can be switched off on its own; all of it is only what this player sees.
 */
final class Streamer {
  /** Hide IP and server addresses. */
  static final String IP = "ip";
  /** Hide coordinates. */
  static final String COORDS = "coords";
  /** Cover private messages and mail (readable with the mouse). */
  static final String MESSAGES = "msg";
  /** Show "● LIVE" to the others. */
  static final String LIVE = "live";
  static final List<String> OPTIONS = List.of(IP, COORDS, MESSAGES, LIVE);
  /** Words that also work after /streamer (German and English). */
  private static final Map<String, String> WORDS = Map.of(
      "ip", IP, "adressen", IP, "addresses", IP,
      "koordinaten", COORDS, "coords", COORDS,
      "nachrichten", MESSAGES, "msg", MESSAGES, "messages", MESSAGES,
      "live", LIVE);

  private static final String MASK = "•••";
  /**
   * IPv4, also with a port: "85.215.54.143", "10.0.0.5:25565" – not "1.21.11" (three parts).
   * https://regex101.com/?flavor=java&regex=%5Cb(%3F%3A%5Cd%7B1%2C3%7D%5C.)%7B3%7D%5Cd%7B1%2C3%7D(%3F%3A%3A%5Cd%7B1%2C5%7D)%3F%5Cb&testString=85.215.54.143%201.21.11
   */
  private static final Pattern IPV4 = Pattern.compile("\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b");
  /**
   * IPv6, full ("2001:db8:0:0:0:0:0:1") or shortened with "::" ("2001:db8::1") – not a time like "12:30:45".
   * https://regex101.com/?flavor=java&regex=(%3Fi)%5Cb(%3F%3A%5B0-9a-f%5D%7B1%2C4%7D%3A)%7B7%7D%5B0-9a-f%5D%7B1%2C4%7D%5Cb%7C%5Cb%5B0-9a-f%5D%7B1%2C4%7D(%3F%3A%3A%5B0-9a-f%5D%7B1%2C4%7D)*%3A%3A(%3F%3A%5B0-9a-f%5D%7B1%2C4%7D(%3F%3A%3A%5B0-9a-f%5D%7B1%2C4%7D)*)%3F&testString=2001%3Adb8%3A%3A1%2012%3A30%3A45
   */
  private static final Pattern IPV6 = Pattern.compile(
      "(?i)\\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\\b|\\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?");

  private final MorniCraft plugin;
  /** The server's own names (written by MorniHosting), with any subdomain and port; null when there are none. */
  private volatile Pattern hosts;

  Streamer(MorniCraft plugin) {
    this.plugin = plugin;
    load();
  }

  /** Reads the server's names again (after /mornicraft reload). */
  void load() {
    List<String> names = plugin.settings().streamerHide().stream().map(String::trim)
        .filter(n -> !n.isEmpty()).map(n -> n.toLowerCase(Locale.ROOT)).distinct().toList();
    hosts = names.isEmpty() ? null : Pattern.compile("(?i)(?:[a-z0-9-]+\\.)*(?:"
        + names.stream().map(Pattern::quote).collect(Collectors.joining("|")) + ")(?::\\d{1,5})?");
  }

  private PlayerStore.Data data(Player p) {
    return plugin.store().get(p.getUniqueId());
  }

  boolean on(Player p) {
    return data(p).streamer;
  }

  /** True when this viewer streams and wants that part hidden. */
  boolean hides(Audience viewer, String option) {
    if (!(viewer instanceof Player p)) return false;
    PlayerStore.Data d = data(p);
    return d.streamer && !d.streamerOff.contains(option);
  }

  /** The others see "● LIVE" in front of this player's name. */
  boolean showsLive(Player p) {
    return hides(p, LIVE);
  }

  Component liveMark() {
    return Component.text("● LIVE ", NamedTextColor.RED);
  }

  /** Text as this viewer may see it: IPs and the server's addresses become "•••" for streamers. */
  Component forViewer(Audience viewer, Component text) {
    if (!hides(viewer, IP)) return text;
    Component out = mask(text, IPV4);
    out = mask(out, IPV6);
    Pattern own = hosts;
    return own == null ? out : mask(out, own);
  }

  private static Component mask(Component text, Pattern pattern) {
    return text.replaceText(TextReplacementConfig.builder().match(pattern).replacement(MASK).build());
  }

  // ---------------------------------------------------------------- /streamer

  void command(Player p, String[] args) {
    PlayerStore.Data d = data(p);
    if (args.length > 0) {
      String word = args[0].toLowerCase(Locale.ROOT);
      if (List.of("an", "on", "ein").contains(word)) set(p, true);
      else if (List.of("aus", "off").contains(word)) set(p, false);
      else if (WORDS.containsKey(word)) {
        String option = WORDS.get(word);
        if (!d.streamerOff.remove(option)) d.streamerOff.add(option);
        plugin.store().save(p.getUniqueId(), d);
      } else {
        p.sendMessage(plugin.ui().fail("usage", Ui.v("usage", "/streamer [an|aus|ip|koordinaten|nachrichten|live]")));
        return;
      }
    }
    menu(p);
  }

  /** Switches the mode; going live is announced to the others (when the LIVE sign is wanted). */
  void set(Player p, boolean on) {
    PlayerStore.Data d = data(p);
    if (d.streamer == on) return;
    d.streamer = on;
    plugin.store().save(p.getUniqueId(), d);
    p.sendMessage(on ? plugin.ui().ok("streamer.now.on") : plugin.ui().note("○", Ui.SOFT, "streamer.now.off"));
    if (on && showsLive(p)) {
      Component note = liveMark().append(plugin.ui().words("streamer.broadcast", Ui.v("name", p.getName())));
      Bukkit.getOnlinePlayers().stream().filter(o -> !o.equals(p)).forEach(o -> o.sendMessage(note));
    }
    plugin.sidebar().update();
  }

  /** The menu: the main switch and each part, all clickable (Bedrock: a form with buttons). */
  void menu(Player p) {
    PlayerStore.Data d = data(p);
    Ui ui = plugin.ui();
    if (plugin.bedrock().menus(p)) {
      List<String> labels = new ArrayList<>();
      List<Runnable> actions = new ArrayList<>();
      labels.add(ui.flat(d.streamer ? "streamer.turn.off" : "streamer.turn.on"));
      actions.add(() -> set(p, !d.streamer));
      for (String o : OPTIONS) {
        labels.add((d.streamerOff.contains(o) ? "✖ " : "✔ ") + ui.flat("streamer.opt." + o));
        actions.add(() -> command(p, new String[] {o}));
      }
      String state = ui.flat("streamer.state", Ui.v("state", ui.flat(d.streamer ? "streamer.on" : "streamer.off")));
      plugin.bedrock().menu(p, ui.flat("streamer.title"), state + "\n\n" + ui.flat("streamer.tip"), labels, actions);
      return;
    }
    List<Component> lines = new ArrayList<>();
    Component state = d.streamer
        ? Component.text("● ", NamedTextColor.RED).append(ui.words("streamer.state", Ui.v("state", ui.flat("streamer.on"))))
        : Component.text("○ ", Ui.SOFT).append(ui.words("streamer.state", Ui.v("state", ui.flat("streamer.off"))));
    lines.add(state.append(Ui.gap()).append(Ui.button(ui.bare(d.streamer ? "streamer.turn.off" : "streamer.turn.on"),
        d.streamer ? Ui.BAD : Ui.ACCENT, null, ClickEvent.runCommand("/streamer " + (d.streamer ? "aus" : "an")))));
    lines.add(Component.empty());
    for (String o : OPTIONS) {
      boolean active = !d.streamerOff.contains(o);
      Component mark = Component.text(active ? "✔ " : "✖ ", active ? Ui.ACCENT : Ui.DIM);
      lines.add(mark.append(Component.text(ui.flat("streamer.opt." + o), active ? NamedTextColor.WHITE : Ui.DIM))
          .hoverEvent(HoverEvent.showText(ui.bare("streamer.opt." + o + ".hover").append(Component.newline())
              .append(ui.bare("streamer.click"))))
          .clickEvent(ClickEvent.runCommand("/streamer " + o)));
    }
    lines.add(Component.empty());
    lines.add(Component.text("ℹ ", Ui.SOFT).append(ui.words("streamer.tip")));
    ui.card(p, ui.flat("streamer.title"), lines, false);
  }
}
