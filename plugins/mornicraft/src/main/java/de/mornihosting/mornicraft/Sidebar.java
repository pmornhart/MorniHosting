package de.mornihosting.mornicraft;

import java.lang.reflect.Method;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

/**
 * The bar on the right: the server's name, the time (real and in the game), who is online, your ping and the most
 * important commands. Updated every second. Each player can hide it with /leiste; the admin switches it in the
 * dashboard. The red numbers of the scoreboard are hidden where the server can (Paper 1.20.4+).
 */
final class Sidebar implements Listener {
  private static final long EVERY_TICKS = 20;
  private static final int PLAIN_SPACE_PX = 4;
  private static final int BOLD_SPACE_PX = 5;
  /** Room between the longest label and the values. */
  private static final int COLUMN_GAP = 8;
  /** Room between the two command columns. */
  private static final int COMMAND_GAP = 12;
  private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm");
  private static final int TICKS_PER_DAY = 24000;
  private static final int TICKS_PER_HOUR = 1000;
  private static final int MORNING_HOUR = 6;
  private static final int NIGHT_FROM = 13000;
  private static final int NIGHT_TO = 23000;
  /** Invisible, different entries (colour codes) carry the lines; the text sits in a team prefix. */
  private static final String[] KEYS = {"§0", "§1", "§2", "§3", "§4", "§5", "§6", "§7", "§8", "§9", "§a", "§b", "§c", "§d", "§e"};

  private final MorniCraft plugin;
  private final Map<UUID, Scoreboard> boards = new HashMap<>();
  /** Kills and deaths in the tab list: what each viewer was last sent (only changes go out). */
  private final Map<UUID, Map<String, String>> statsShown = new HashMap<>();
  private static final String STATS = "mcstats";

  Sidebar(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimer(plugin, this::update, EVERY_TICKS, EVERY_TICKS);
  }

  private boolean wanted(Player p) {
    return plugin.settings().sidebar() && !plugin.store().get(p.getUniqueId()).hideSidebar;
  }

  /** /leiste: show or hide for oneself. */
  void toggle(Player p) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    d.hideSidebar = !d.hideSidebar;
    plugin.store().save(p.getUniqueId(), d);
    p.sendMessage(plugin.ui().ok(d.hideSidebar ? "sidebar.off" : "sidebar.on"));
    update();
  }

  private void hide(Player p) {
    statsShown.remove(p.getUniqueId());
    if (boards.remove(p.getUniqueId()) != null) p.setScoreboard(Bukkit.getScoreboardManager().getMainScoreboard());
  }

  private Scoreboard board(Player p) {
    return boards.computeIfAbsent(p.getUniqueId(), id -> {
      Scoreboard b = Bukkit.getScoreboardManager().getNewScoreboard();
      Objective o = b.registerNewObjective("mornicraft", "dummy", Ui.gradient(plugin.settings().serverName(), true));
      o.setDisplaySlot(DisplaySlot.SIDEBAR);
      hideNumbers(o);
      for (int i = 0; i < KEYS.length; i++) b.registerNewTeam("mc" + i).addEntry(KEYS[i]);
      // Kills and deaths next to every name in the tab list.
      Objective stats = b.registerNewObjective(STATS, "dummy", Component.text("⚔ / ☠"));
      if (plugin.settings().tabStats()) stats.setDisplaySlot(DisplaySlot.PLAYER_LIST);
      // The rank symbols above the heads live in teams: every player's own board needs them too.
      plugin.ranks().paint(b, p);
      p.setScoreboard(b);
      return b;
    });
  }

  /** Every second: "⚔ 3  ☠ 1" behind each name in the tab list (older servers: the kills as a number). */
  private void stats(Player viewer, Scoreboard b) {
    Objective o = b.getObjective(STATS);
    if (o == null) return;
    if (!plugin.settings().tabStats()) {
      if (o.getDisplaySlot() != null) o.setDisplaySlot(null);
      return;
    }
    if (o.getDisplaySlot() != DisplaySlot.PLAYER_LIST) o.setDisplaySlot(DisplaySlot.PLAYER_LIST);
    Map<String, String> shown = statsShown.computeIfAbsent(viewer.getUniqueId(), k -> new HashMap<>());
    for (Player other : Bukkit.getOnlinePlayers()) {
      int kills = other.getStatistic(org.bukkit.Statistic.PLAYER_KILLS);
      int deaths = other.getStatistic(org.bukkit.Statistic.DEATHS);
      String text = kills + "/" + deaths;
      if (text.equals(shown.get(other.getName()))) continue;
      shown.put(other.getName(), text);
      org.bukkit.scoreboard.Score score = o.getScore(other.getName());
      score.setScore(kills);
      fixed(score, Component.text("⚔ " + kills, Ui.GOLD).append(Component.text("  ☠ " + deaths, Ui.SOFT)));
    }
  }

  /** Paper 1.20.4+: a score shows a text instead of its number. */
  private static void fixed(org.bukkit.scoreboard.Score score, Component text) {
    try {
      Class<?> format = Class.forName("io.papermc.paper.scoreboard.numbers.NumberFormat");
      Object fixed = format.getMethod("fixed", net.kyori.adventure.text.ComponentLike.class).invoke(null, text);
      score.getClass().getMethod("numberFormat", format).invoke(score, fixed);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      // An older server: the number (kills) stays.
    }
  }

  /** Paper 1.20.4+: no red numbers on the right. Older servers simply show them. */
  private static void hideNumbers(Objective o) {
    try {
      Class<?> format = Class.forName("io.papermc.paper.scoreboard.numbers.NumberFormat");
      Object blank = format.getMethod("blank").invoke(null);
      Method set = o.getClass().getMethod("numberFormat", format);
      set.invoke(o, blank);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      // An older server: the numbers stay.
    }
  }

  private List<Component> lines(Player p) {
    Ui ui = plugin.ui();
    World w = SpawnArea.world();
    long time = w.getTime();
    long hour = (time / TICKS_PER_HOUR + MORNING_HOUR) % 24;
    long minute = (time % TICKS_PER_HOUR) * 60 / TICKS_PER_HOUR;
    boolean night = time >= NIGHT_FROM && time < NIGHT_TO;
    String gameTime = String.format("%02d:%02d", hour, minute);
    long day = w.getFullTime() / TICKS_PER_DAY + 1;
    String clock = ZonedDateTime.now(zone()).format(CLOCK);
    List<Component> lines = new ArrayList<>();
    lines.add(Component.empty());
    // At the top what matters right now (in combat, live), with room below it.
    boolean status = false;
    if (plugin.combat().inCombat(p)) {
      lines.add(Component.text("⚔ " + ui.flat("sidebar.combat", Ui.v("sec", plugin.combat().left(p))), NamedTextColor.RED)
          .decoration(TextDecoration.BOLD, true));
      status = true;
    }
    if (plugin.streamer().on(p)) {
      lines.add(Component.text("● " + ui.flat("sidebar.live"), NamedTextColor.RED));
      status = true;
    }
    if (status) lines.add(Component.text("  "));
    // Every row starts with the same dot (only its colour differs), so the labels start in one column; the values
    // start in one column too (measured with Minecraft's character widths). Symbols of other widths (☀ ☾) only
    // ever stand at the end of a line, where they can't push anything.
    List<Component[]> rows = new ArrayList<>();
    Ranks.Rank rank = plugin.ranks().of(p);
    if (rank != null && !rank.fallback()) {
      boolean picture = !rank.tag().isEmpty() && plugin.ranks().seesBadges(p);
      rows.add(new Component[] {dot(rank.color()), Component.text(ui.flat("sidebar.rank"), Ui.SOFT),
          picture ? plugin.ranks().label(rank, p) : Component.text(rank.name(), rank.color())});
    }
    rows.add(row(Ui.ACCENT_2, ui.flat("sidebar.clock"), Component.text(clock, NamedTextColor.WHITE)));
    rows.add(row(night ? Ui.MAIL : Ui.GOLD, ui.flat("sidebar.day", Ui.v("n", day)),
        Component.text(gameTime + " ", NamedTextColor.WHITE).append(Component.text(night ? "☾" : "☀", night ? Ui.MAIL : Ui.GOLD))));
    rows.add(row(Ui.ACCENT, ui.flat("sidebar.online"),
        Component.text(Bukkit.getOnlinePlayers().size() + " / " + Bukkit.getMaxPlayers(), NamedTextColor.WHITE)));
    rows.add(row(Ui.SOFT, ui.flat("sidebar.ping"), Component.text(p.getPing() + " ms", NamedTextColor.WHITE)));
    int column = rows.stream().mapToInt(r -> Ui.width(r[1])).max().orElse(0) + COLUMN_GAP;
    rows.forEach(r -> lines.add(r[0].append(r[1]).append(pad(column - Ui.width(r[1]))).append(r[2])));
    lines.add(Component.text(" "));
    lines.add(Component.text(ui.flat("sidebar.commands"), Ui.ACCENT).decoration(TextDecoration.BOLD, true));
    List<String[]> commands = new ArrayList<>(List.of(new String[] {"/spawn", "/home"}, new String[] {"/tpa", "/msg"},
        new String[] {"/info", plugin.bedrock().is(p) ? "" : "/leiste"}));
    int first = commands.stream().mapToInt(c -> Ui.width(Component.text(c[0]))).max().orElse(0);
    commands.forEach(c -> lines.add(cmds(c[0], c[1], first)));
    String page = plugin.commands().pageOf(p);
    if (page != null && !plugin.streamer().hides(p, Streamer.IP)) {
      lines.add(Component.text("   "));
      lines.add(Component.text(host(page), Ui.DIM));
    }
    // A sidebar shows at most 15 lines: the address at the bottom goes first.
    while (lines.size() > KEYS.length) lines.remove(lines.size() - 1);
    return lines;
  }

  /** The dot in front of every row: the same character everywhere, so all rows are equally wide up to the label. */
  private static Component dot(net.kyori.adventure.text.format.TextColor color) {
    return Component.text("● ", color);
  }

  private static Component[] row(net.kyori.adventure.text.format.TextColor color, String label, Component value) {
    return new Component[] {dot(color), Component.text(label, Ui.SOFT), value};
  }

  /** Two command columns: the second always starts at the same place. */
  private static Component cmds(String a, String b, int firstWidth) {
    Component line = Component.text(" " + a, NamedTextColor.WHITE);
    if (b.isEmpty()) return line;
    return line.append(pad(firstWidth - Ui.width(Component.text(a)) + COMMAND_GAP))
        .append(Component.text(b, NamedTextColor.WHITE));
  }

  /** Space of exactly this many pixels where possible: plain spaces are 4 wide, bold ones 5. */
  private static Component pad(int px) {
    if (px <= 0) return Component.empty();
    for (int bold = 0; bold < 4; bold++) {
      int rest = px - bold * BOLD_SPACE_PX;
      if (rest >= 0 && rest % PLAIN_SPACE_PX == 0) {
        return Component.text(" ".repeat(rest / PLAIN_SPACE_PX))
            .append(Component.text(" ".repeat(bold)).decoration(TextDecoration.BOLD, true));
      }
    }
    return Component.text(" ".repeat(Math.max(1, Math.round(px / (float) PLAIN_SPACE_PX))));
  }

  private static String host(String url) {
    String rest = url.replaceFirst("^https?://", "");
    int slash = rest.indexOf('/');
    return slash < 0 ? rest : rest.substring(0, slash);
  }

  private ZoneId zone() {
    try {
      return ZoneId.of(plugin.settings().timezone());
    } catch (RuntimeException e) {
      return ZoneId.systemDefault();
    }
  }

  void update() {
    for (Player p : Bukkit.getOnlinePlayers()) {
      // Everyone keeps a board of their own (the rank badges in the tab list are per player); hidden = no sidebar.
      Scoreboard b = board(p);
      stats(p, b);
      Objective o = b.getObjective("mornicraft");
      if (o == null) continue;
      if (!wanted(p)) {
        if (o.getDisplaySlot() != null) o.setDisplaySlot(null);
        continue;
      }
      if (o.getDisplaySlot() != DisplaySlot.SIDEBAR) o.setDisplaySlot(DisplaySlot.SIDEBAR);
      List<Component> lines = lines(p);
      for (int i = 0; i < KEYS.length; i++) {
        Team t = b.getTeam("mc" + i);
        if (t == null) continue;
        if (i < lines.size()) {
          t.prefix(lines.get(i));
          o.getScore(KEYS[i]).setScore(lines.size() - i);
        } else {
          b.resetScores(KEYS[i]);
        }
      }
    }
  }

  /** On shutdown/reload everyone gets the normal scoreboard back. */
  void release() {
    for (Player p : Bukkit.getOnlinePlayers()) hide(p);
  }

  /** After a reload (new server name, switched off …) the bars are built anew. */
  void rebuild() {
    for (Player p : Bukkit.getOnlinePlayers()) hide(p);
    update();
  }

  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    // The own board right away (badges in the tab list), the lines a moment later.
    board(e.getPlayer());
    Bukkit.getScheduler().runTaskLater(plugin, this::update, 2L);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    boards.remove(e.getPlayer().getUniqueId());
    statsShown.remove(e.getPlayer().getUniqueId());
    // The one who left: off every other tab list (the scores would stay otherwise).
    for (Scoreboard b : boards.values()) b.resetScores(e.getPlayer().getName());
    statsShown.values().forEach(m -> m.remove(e.getPlayer().getName()));
  }
}
