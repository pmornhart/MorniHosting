package de.mornihosting.mornicraft;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;

/** All MorniCraft commands. */
final class Commands implements TabExecutor {
  private static final Pattern HOME_NAME = Pattern.compile("[A-Za-z0-9_-]{1,16}");
  private static final String DEFAULT_HOME = "home";
  private static final double NEAR = 200;
  private static final long MINUTE_MS = 60_000;
  private static final long HOURS_SHOWN_UP_TO = 48;

  private final MorniCraft plugin;

  Commands(MorniCraft plugin) {
    this.plugin = plugin;
  }

  private Ui ui() {
    return plugin.ui();
  }

  private Settings s() {
    return plugin.settings();
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    String name = command.getName().toLowerCase(Locale.ROOT);
    if (name.equals("mornicraft")) {
      if (args.length != 1 || !args[0].equalsIgnoreCase("reload")) {
        sender.sendMessage(ui().fail("usage", Ui.v("usage", "/mornicraft reload")));
        return true;
      }
      plugin.reload();
      sender.sendMessage(ui().ok("reload"));
      return true;
    }
    if (name.equals("info")) {
      info(sender);
      return true;
    }
    if (name.equals("rules")) {
      rules(sender);
      return true;
    }
    if (name.equals("seen")) {
      if (args.length < 1) return usage(sender, "/seen <spieler>");
      seen(sender, args[0]);
      return true;
    }
    if (name.equals("msg")) {
      if (args.length < 2) return usage(sender, "/msg <spieler> <text>");
      Player to = online(sender, args[0]);
      if (to != null) plugin.social().message(sender, to, join(args, 1));
      return true;
    }
    if (!(sender instanceof Player p)) {
      sender.sendMessage(ui().fail("only.players"));
      return true;
    }
    switch (name) {
      case "spawn" -> plugin.teleporter().teleport(p, ui().bare("dest.spawn"), SpawnArea::spawn, null);
      case "sethome" -> setHome(p, args.length > 0 ? args[0] : DEFAULT_HOME);
      case "home" -> home(p, args.length > 0 ? args[0] : null);
      case "homes" -> homes(p);
      case "delhome" -> {
        if (args.length < 1) return usage(p, "/delhome <name>");
        delHome(p, args[0]);
      }
      case "back" -> back(p);
      case "tpa", "tpahere" -> {
        if (!s().tpa()) return off(p);
        if (args.length < 1) return usage(p, "/" + name + " <spieler>");
        Player to = online(p, args[0]);
        if (to == null) return true;
        if (to.equals(p)) {
          p.sendMessage(ui().fail("player.self"));
          return true;
        }
        plugin.social().request(p, to, name.equals("tpahere"));
      }
      case "tpaccept" -> plugin.social().accept(p, args.length > 0 ? args[0] : null);
      case "tpdeny" -> plugin.social().deny(p, args.length > 0 ? args[0] : null);
      case "r" -> {
        if (args.length < 1) return usage(p, "/r <text>");
        plugin.social().reply(p, join(args, 0));
      }
      case "mail" -> mail(p, args);
      case "ignore" -> {
        if (args.length < 1) return usage(p, "/ignore <spieler>");
        OfflinePlayer other = known(p, args[0]);
        if (other != null && other.getUniqueId().equals(p.getUniqueId())) p.sendMessage(ui().fail("player.self"));
        else if (other != null) plugin.social().ignore(p, other);
      }
      case "afk" -> plugin.social().toggleAway(p);
      case "leiste" -> plugin.sidebar().toggle(p);
      case "near" -> near(p);
      case "getpos" -> getpos(p);
      case "ping" -> p.sendMessage(ui().note("◉", Ui.ACCENT_2, "ping", Ui.v("ms", p.getPing())));
      default -> {
        return false;
      }
    }
    return true;
  }

  private boolean usage(CommandSender to, String usage) {
    to.sendMessage(ui().fail("usage", Ui.v("usage", usage)));
    return true;
  }

  private boolean off(CommandSender to) {
    to.sendMessage(ui().fail("off"));
    return true;
  }

  private static String join(String[] args, int from) {
    return String.join(" ", Arrays.copyOfRange(args, from, args.length));
  }

  /** An online player by name (exact, else the only one starting with it). */
  private Player online(CommandSender asker, String name) {
    Player exact = Bukkit.getPlayerExact(name);
    if (exact != null) return exact;
    List<Player> starts = Bukkit.getOnlinePlayers().stream()
        .filter(o -> o.getName().toLowerCase(Locale.ROOT).startsWith(name.toLowerCase(Locale.ROOT)))
        .map(o -> (Player) o).toList();
    if (starts.size() == 1) return starts.get(0);
    asker.sendMessage(ui().fail("player.offline", Ui.v("name", name)));
    return null;
  }

  /** A player who has been on the server (also offline). */
  private OfflinePlayer known(CommandSender asker, String name) {
    Player on = Bukkit.getPlayerExact(name);
    if (on != null) return on;
    OfflinePlayer off = Bukkit.getOfflinePlayerIfCached(name);
    if (off != null && off.hasPlayedBefore()) return off;
    asker.sendMessage(ui().fail("player.unknown", Ui.v("name", name)));
    return null;
  }

  // ── Homes ───────────────────────────────────────────────────────────────────────────

  private void setHome(Player p, String name) {
    if (!HOME_NAME.matcher(name).matches()) {
      p.sendMessage(ui().fail("home.badname"));
      return;
    }
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    // "Base" and "base" are the same home (/home finds them without caring about case, too).
    String same = d.homes.keySet().stream().filter(k -> k.equalsIgnoreCase(name)).findFirst().orElse(null);
    boolean exists = same != null;
    int max = s().maxHomes();
    if (!exists && d.homes.size() >= max && !p.hasPermission("mornicraft.unlimitedhomes")) {
      p.sendMessage(ui().fail("home.limit", Ui.v("max", max)));
      return;
    }
    if (same != null) d.homes.remove(same);
    d.homes.put(name, PlayerStore.Home.of(p.getLocation()));
    d.name = p.getName();
    plugin.store().save(p.getUniqueId(), d);
    p.sendMessage(ui().note("⌂", Ui.ACCENT, exists ? "home.moved" : "home.set", Ui.v("name", name)));
  }

  private void home(Player p, String name) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.homes.isEmpty()) {
      p.sendMessage(ui().note("⌂", Ui.SOFT, "home.none"));
      return;
    }
    String pick = name != null ? name : d.homes.size() == 1 ? d.homes.keySet().iterator().next()
        : d.homes.containsKey(DEFAULT_HOME) ? DEFAULT_HOME : null;
    if (pick == null) {
      homes(p);
      return;
    }
    String key = d.homes.keySet().stream().filter(k -> k.equalsIgnoreCase(pick)).findFirst().orElse(null);
    if (key == null) {
      p.sendMessage(ui().fail("home.unknown", Ui.v("name", pick)));
      return;
    }
    Location to = d.homes.get(key).location();
    if (to == null) {
      p.sendMessage(ui().fail("home.world"));
      return;
    }
    plugin.teleporter().teleport(p, ui().bare("dest.home", Ui.v("name", key)), () -> to, null);
  }

  private void homes(Player p) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.homes.isEmpty()) {
      p.sendMessage(ui().note("⌂", Ui.SOFT, "home.none"));
      return;
    }
    if (plugin.bedrock().menus(p)) {
      List<String> names = new ArrayList<>(d.homes.keySet());
      List<Runnable> go = names.stream().map(n -> (Runnable) () -> home(p, n)).toList();
      plugin.bedrock().menu(p, ui().flat("home.title"), "", names, go);
      return;
    }
    Component chips = Component.empty();
    for (var e : d.homes.entrySet()) {
      PlayerStore.Home h = e.getValue();
      String coords = Math.round(h.x()) + " / " + Math.round(h.y()) + " / " + Math.round(h.z()) + " · " + h.world();
      chips = chips.append(Ui.button(Component.text(e.getKey()), Ui.ACCENT, ui().bare("home.hover", Ui.v("coords", coords)),
          ClickEvent.runCommand("/home " + e.getKey()))).append(Component.text(" "));
    }
    ui().card(p, ui().flat("home.title"), List.of(chips));
  }

  private void delHome(Player p, String name) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    String key = d.homes.keySet().stream().filter(k -> k.equalsIgnoreCase(name)).findFirst().orElse(null);
    if (key == null) {
      p.sendMessage(ui().fail("home.unknown", Ui.v("name", name)));
      return;
    }
    d.homes.remove(key);
    plugin.store().save(p.getUniqueId(), d);
    p.sendMessage(ui().note("⌂", Ui.SOFT, "home.deleted", Ui.v("name", key)));
  }

  private void back(Player p) {
    if (!s().back()) {
      off(p);
      return;
    }
    Location to = plugin.teleporter().back(p);
    if (to == null) {
      p.sendMessage(ui().fail("back.none"));
      return;
    }
    plugin.teleporter().teleport(p, ui().bare("dest.back"), () -> to, null);
  }

  // ── Mail ────────────────────────────────────────────────────────────────────────────

  private void mail(Player p, String[] args) {
    String sub = args.length > 0 ? args[0].toLowerCase(Locale.ROOT) : "read";
    if (sub.equals("read")) {
      plugin.social().readMail(p);
    } else if (sub.equals("send") && args.length >= 3) {
      OfflinePlayer to = known(p, args[1]);
      if (to != null) plugin.social().mail(p, to, join(args, 2));
    } else {
      usage(p, "/mail send <spieler> <text> · /mail read");
    }
  }

  // ── Info ────────────────────────────────────────────────────────────────────────────

  private void seen(CommandSender to, String name) {
    Player on = Bukkit.getPlayerExact(name);
    if (on != null) {
      to.sendMessage(ui().note("●", Ui.ACCENT, "seen.online", Ui.v("name", on.getName())));
      return;
    }
    OfflinePlayer off = known(to, name);
    if (off == null) return;
    long ago = Math.max(0, System.currentTimeMillis() - off.getLastSeen());
    to.sendMessage(ui().note("◷", Ui.SOFT, "seen.ago", Ui.v("name", String.valueOf(off.getName())), Ui.c("ago", duration(ago))));
  }

  private Component duration(long ms) {
    long minutes = Math.max(1, ms / MINUTE_MS);
    long hours = minutes / 60;
    if (hours == 0) return ui().bare("time.minutes", Ui.v("n", minutes));
    if (hours <= HOURS_SHOWN_UP_TO) return ui().bare("time.hours", Ui.v("n", hours));
    return ui().bare("time.days", Ui.v("n", hours / 24));
  }

  private void near(Player p) {
    Location here = p.getLocation();
    List<Player> close = p.getWorld().getPlayers().stream()
        .filter(o -> !o.equals(p) && o.getLocation().distance(here) <= NEAR)
        .sorted(Comparator.comparingDouble(o -> o.getLocation().distance(here))).toList();
    if (close.isEmpty()) {
      p.sendMessage(ui().note("◎", Ui.SOFT, "near.none"));
      return;
    }
    List<Component> lines = new ArrayList<>();
    for (Player o : close) {
      lines.add(Component.text("● ", Ui.ACCENT).append(ui().words("near.line", Ui.v("name", o.getName()),
          Ui.v("dist", Math.round(o.getLocation().distance(here))))));
    }
    ui().card(p, ui().flat("near.title"), lines);
  }

  private void getpos(Player p) {
    Location l = p.getLocation();
    String coords = l.getBlockX() + " " + l.getBlockY() + " " + l.getBlockZ();
    Component line = ui().note("⌖", Ui.ACCENT_2, "getpos", Ui.v("x", l.getBlockX()), Ui.v("y", l.getBlockY()),
        Ui.v("z", l.getBlockZ()), Ui.v("world", l.getWorld().getName()))
        .hoverEvent(HoverEvent.showText(ui().bare("getpos.hover")))
        .clickEvent(ClickEvent.suggestCommand(coords));
    p.sendMessage(line);
  }

  /** The personal page of this player, or null without a panel domain. */
  String pageOf(CommandSender who) {
    String link = s().link();
    if (link == null || link.isBlank()) return null;
    return link.replace("{name}", URLEncoder.encode(who.getName(), StandardCharsets.UTF_8));
  }

  Component pageButton(CommandSender who, String key) {
    String page = pageOf(who);
    if (page == null) return null;
    return Ui.button(ui().bare(key), Ui.ACCENT_2, ui().bare("info.page.hover"), ClickEvent.openUrl(page));
  }

  /** All commands, one line per group: the command names are clickable, the explanation is on hover. */
  private void info(CommandSender to) {
    if (to instanceof Player p && plugin.bedrock().menus(p)) menu(p);
    boolean op = to.isOp();
    List<Component> lines = new ArrayList<>();
    // One line per group: its name, then the commands (short; hover shows how and what, click puts it in the chat).
    for (Settings.Group g : s().groups()) {
      Map<String, List<Settings.Command>> byBase = new LinkedHashMap<>();
      g.commands().stream().filter(c -> (op || !c.opOnly()) && c.use().startsWith("/"))
          .forEach(c -> byBase.computeIfAbsent(c.use().split(" ")[0], k -> new ArrayList<>()).add(c));
      if (byBase.isEmpty()) continue;
      List<Component> items = new ArrayList<>();
      items.add(Component.text(g.title(), Ui.ACCENT));
      byBase.forEach((base, uses) -> {
        Component hover = Component.empty();
        for (int i = 0; i < uses.size(); i++) {
          Settings.Command c = uses.get(i);
          if (i > 0) hover = hover.append(Component.newline());
          hover = hover.append(Component.text(c.use(), NamedTextColor.WHITE)).append(Component.text("  " + c.text(), Ui.SOFT));
        }
        boolean args = uses.stream().anyMatch(c -> c.use().contains(" "));
        items.add(Component.text(base, NamedTextColor.WHITE)
            .hoverEvent(HoverEvent.showText(hover.append(Component.newline()).append(ui().bare("info.click"))))
            .clickEvent(ClickEvent.suggestCommand(args ? base + " " : base)));
      });
      lines.addAll(Ui.rows(items, Component.text("  "), Ui.CARD_PX - 8));
    }
    if (s().elytra()) lines.add(Component.text("✦ ", Ui.ACCENT_2).append(ui().words("welcome.spawn")));
    Component page = pageButton(to, "info.page");
    if (page != null) lines.add(page);
    ui().card(to, ui().flat("info.title"), lines);
  }

  /** The Bedrock menu: the everyday things as buttons. */
  private void menu(Player p) {
    List<String> labels = new ArrayList<>(List.of(ui().flat("menu.spawn"), ui().flat("menu.home"),
        ui().flat("menu.homes"), ui().flat("menu.sethome"), ui().flat("menu.mail"), ui().flat("menu.rules")));
    List<Runnable> actions = new ArrayList<>(List.of(() -> p.performCommand("spawn"), () -> home(p, null),
        () -> homes(p), () -> setHome(p, DEFAULT_HOME), () -> plugin.social().readMail(p), () -> rules(p)));
    if (s().back()) {
      labels.add(ui().flat("menu.back"));
      actions.add(() -> back(p));
    }
    plugin.bedrock().menu(p, s().serverName(), ui().flat("menu.content"), labels, actions);
  }

  void rules(CommandSender to) {
    List<String> rules = s().rules();
    List<Component> lines = new ArrayList<>();
    if (rules.isEmpty()) lines.add(ui().words("rules.none"));
    for (int i = 0; i < rules.size(); i++) {
      lines.add(Component.text((i + 1) + "  ", Ui.ACCENT).append(Component.text(rules.get(i), Ui.SOFT)));
    }
    ui().card(to, ui().flat("rules.title"), lines);
  }

  // ── Tab completion ──────────────────────────────────────────────────────────────────

  @Override
  public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
    String name = command.getName().toLowerCase(Locale.ROOT);
    String last = args.length == 0 ? "" : args[args.length - 1].toLowerCase(Locale.ROOT);
    List<String> options = new ArrayList<>();
    if ((name.equals("home") || name.equals("delhome")) && args.length == 1 && sender instanceof Player p) {
      options.addAll(plugin.store().get(p.getUniqueId()).homes.keySet());
    } else if (name.equals("mail") && args.length == 1) {
      options.addAll(List.of("send", "read"));
    } else if (name.equals("mornicraft") && args.length == 1) {
      options.add("reload");
    } else if ((name.equals("tpaccept") || name.equals("tpdeny")) && args.length == 1 && sender instanceof Player p) {
      options.addAll(plugin.social().askers(p));
    } else if ((args.length == 1 && List.of("tpa", "tpahere", "msg", "ignore", "seen").contains(name))
        || (name.equals("mail") && args.length == 2)) {
      Bukkit.getOnlinePlayers().forEach(o -> options.add(o.getName()));
    }
    return options.stream().filter(o -> o.toLowerCase(Locale.ROOT).startsWith(last)).toList();
  }
}
