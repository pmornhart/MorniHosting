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
    if (d.hideSidebar) hide(p);
    p.sendMessage(plugin.ui().ok(d.hideSidebar ? "sidebar.off" : "sidebar.on"));
    update();
  }

  private void hide(Player p) {
    if (boards.remove(p.getUniqueId()) != null) p.setScoreboard(Bukkit.getScoreboardManager().getMainScoreboard());
  }

  private Scoreboard board(Player p) {
    return boards.computeIfAbsent(p.getUniqueId(), id -> {
      Scoreboard b = Bukkit.getScoreboardManager().getNewScoreboard();
      Objective o = b.registerNewObjective("mornicraft", "dummy", Ui.gradient(plugin.settings().serverName(), true));
      o.setDisplaySlot(DisplaySlot.SIDEBAR);
      hideNumbers(o);
      for (int i = 0; i < KEYS.length; i++) b.registerNewTeam("mc" + i).addEntry(KEYS[i]);
      p.setScoreboard(b);
      return b;
    });
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
    lines.add(row("◷", Ui.ACCENT_2, ui.flat("sidebar.clock"), clock));
    lines.add(row(night ? "☾" : "☀", night ? Ui.MAIL : Ui.GOLD, ui.flat("sidebar.day", Ui.v("n", day)), gameTime));
    lines.add(row("●", Ui.ACCENT, ui.flat("sidebar.online"), Bukkit.getOnlinePlayers().size() + " / " + Bukkit.getMaxPlayers()));
    lines.add(row("◉", Ui.SOFT, ui.flat("sidebar.ping"), p.getPing() + " ms"));
    lines.add(Component.text(" "));
    lines.add(Component.text(ui.flat("sidebar.commands"), Ui.ACCENT));
    lines.add(cmds("/spawn", "/home"));
    lines.add(cmds("/tpa", "/msg"));
    lines.add(cmds("/info", plugin.bedrock().is(p) ? "" : "/leiste"));
    String page = plugin.commands().pageOf(p);
    if (page != null) {
      lines.add(Component.text("  "));
      lines.add(Component.text(host(page), Ui.DIM));
    }
    return lines;
  }

  private static Component row(String icon, net.kyori.adventure.text.format.TextColor color, String label, String value) {
    return Component.text(icon + " ", color).append(Component.text(label + " ", Ui.SOFT))
        .append(Component.text(value, NamedTextColor.WHITE));
  }

  private static Component cmds(String a, String b) {
    Component line = Component.text(" " + a, NamedTextColor.WHITE);
    return b.isEmpty() ? line : line.append(Component.text("  ·  ", Ui.DIM)).append(Component.text(b, NamedTextColor.WHITE));
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
      if (!wanted(p)) {
        hide(p);
        continue;
      }
      Scoreboard b = board(p);
      Objective o = b.getObjective("mornicraft");
      if (o == null) continue;
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

  /** After a reload (new server name, switched off …) the bars are built anew. */
  void rebuild() {
    for (Player p : Bukkit.getOnlinePlayers()) hide(p);
    update();
  }

  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    Bukkit.getScheduler().runTaskLater(plugin, this::update, 2L);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    boards.remove(e.getPlayer().getUniqueId());
  }
}
