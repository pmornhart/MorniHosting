package de.mornihosting.mornicraft;

import io.papermc.paper.event.player.AsyncChatEvent;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** Everything between players: teleport requests, private messages, mail for later, ignoring, "away". */
final class Social implements Listener {
  private static final long REQUEST_MS = 120_000;
  /** One sender fills at most this many places in someone's mailbox (the rest stays free for others). */
  private static final int MAIL_PER_SENDER = 10;
  /** /afk tells everyone – at most this often per player. */
  private static final long AFK_EVERY_MS = 10_000;
  private static final Sound PING = Sound.sound(Key.key("block.note_block.pling"), Sound.Source.PLAYER, 0.6f, 1.6f);
  private static final Sound MESSAGE = Sound.sound(Key.key("entity.experience_orb.pickup"), Sound.Source.PLAYER, 0.4f, 1.4f);

  private record Request(UUID from, boolean here, long at) {}

  private final MorniCraft plugin;
  /** Open requests per target, oldest first. */
  private final Map<UUID, LinkedHashMap<UUID, Request>> requests = new HashMap<>();
  private final Map<UUID, UUID> lastFrom = new HashMap<>();
  /** Read by the chat thread too. */
  private final Set<UUID> away = ConcurrentHashMap.newKeySet();
  private final Map<UUID, Long> lastAfk = new HashMap<>();

  Social(MorniCraft plugin) {
    this.plugin = plugin;
  }

  private Ui ui() {
    return plugin.ui();
  }

  boolean ignores(UUID viewer, UUID sender) {
    return plugin.store().get(viewer).ignored.contains(sender.toString());
  }

  // ── Teleport requests ────────────────────────────────────────────────────────────────

  void request(Player from, Player to, boolean here) {
    if (ignores(to.getUniqueId(), from.getUniqueId())) {
      from.sendMessage(ui().fail("tpa.blocked", Ui.v("name", to.getName())));
      return;
    }
    // One open request per pair: a second one could swap /tpa for /tpahere behind the card already shown.
    LinkedHashMap<UUID, Request> open = requests.computeIfAbsent(to.getUniqueId(), k -> new LinkedHashMap<>());
    Request old = open.get(from.getUniqueId());
    if (old != null && System.currentTimeMillis() - old.at() <= REQUEST_MS) {
      from.sendMessage(ui().fail("tpa.already", Ui.v("name", to.getName())));
      return;
    }
    open.remove(from.getUniqueId());
    open.put(from.getUniqueId(), new Request(from.getUniqueId(), here, System.currentTimeMillis()));
    from.sendMessage(ui().ok("tpa.sent", Ui.v("name", to.getName())));
    Component accept = Ui.button(ui().bare("tpa.accept"), Ui.ACCENT, ui().bare("tpa.accept.hover"),
        ClickEvent.runCommand("/tpaccept " + from.getName()));
    Component deny = Ui.button(ui().bare("tpa.deny"), Ui.BAD, ui().bare("tpa.deny.hover"),
        ClickEvent.runCommand("/tpdeny " + from.getName()));
    ui().card(to, ui().flat("tpa.title"), List.of(
        ui().words(here ? "tpahere.got" : "tpa.got", Ui.v("name", from.getName())),
        accept.append(Ui.gap()).append(deny)));
    to.playSound(PING);
    if (plugin.bedrock().menus(to)) {
      String name = from.getName();
      plugin.bedrock().ask(to, ui().flat("tpa.title"), ui().flat(here ? "tpahere.got" : "tpa.got", Ui.v("name", name)),
          ui().flat("tpa.accept"), ui().flat("tpa.deny"), yes -> {
            if (yes) accept(to, name);
            else deny(to, name);
          });
    }
  }

  /** The newest open request for this player (or the one from `name`); expired ones are dropped. */
  private Request pick(Player target, String name) {
    LinkedHashMap<UUID, Request> open = requests.get(target.getUniqueId());
    if (open == null) return null;
    long now = System.currentTimeMillis();
    open.values().removeIf(r -> now - r.at() > REQUEST_MS || Bukkit.getPlayer(r.from()) == null);
    List<Request> list = new ArrayList<>(open.values());
    if (name != null) {
      return list.stream().filter(r -> name.equalsIgnoreCase(Bukkit.getPlayer(r.from()).getName())).findFirst().orElse(null);
    }
    return list.isEmpty() ? null : list.get(list.size() - 1);
  }

  void accept(Player target, String name) {
    Request r = pick(target, name);
    if (r == null) {
      target.sendMessage(ui().fail("tpa.none"));
      return;
    }
    requests.get(target.getUniqueId()).remove(r.from());
    Player from = Bukkit.getPlayer(r.from());
    target.sendMessage(ui().ok("tpa.youaccepted"));
    from.sendMessage(ui().ok("tpa.accepted", Ui.v("name", target.getName())));
    // Who travels has to stand still: the asker for /tpa, the asked one for /tpahere.
    Player traveller = r.here() ? target : from;
    Player host = r.here() ? from : target;
    plugin.teleporter().teleport(traveller, ui().bare("dest.player", Ui.v("name", host.getName())),
        () -> host.isOnline() ? host.getLocation() : null, null);
  }

  void deny(Player target, String name) {
    Request r = pick(target, name);
    if (r == null) {
      target.sendMessage(ui().fail("tpa.none"));
      return;
    }
    requests.get(target.getUniqueId()).remove(r.from());
    target.sendMessage(ui().note("✖", Ui.SOFT, "tpa.youdenied"));
    Player from = Bukkit.getPlayer(r.from());
    if (from != null) from.sendMessage(ui().note("✖", Ui.BAD, "tpa.denied", Ui.v("name", target.getName())));
  }

  // ── Messages ─────────────────────────────────────────────────────────────────────────

  void message(CommandSender from, Player to, String text) {
    UUID fromId = from instanceof Player p ? p.getUniqueId() : null;
    if (fromId != null && ignores(to.getUniqueId(), fromId)) {
      from.sendMessage(ui().fail("tpa.blocked", Ui.v("name", to.getName())));
      return;
    }
    Component body = Component.text(text, net.kyori.adventure.text.format.NamedTextColor.WHITE);
    from.sendMessage(Component.text("✉ ", Ui.MAIL).append(ui().words("msg.to", Ui.v("name", to.getName())))
        .append(Component.text(": ", Ui.SOFT)).append(body));
    Component sender = ui().words("msg.from", Ui.v("name", from.getName()))
        .hoverEvent(HoverEvent.showText(ui().bare("msg.reply.hover")))
        .clickEvent(ClickEvent.suggestCommand("/msg " + from.getName() + " "));
    to.sendMessage(Component.text("✉ ", Ui.MAIL).append(sender).append(Component.text(": ", Ui.SOFT)).append(body));
    to.playSound(MESSAGE);
    if (fromId != null) {
      lastFrom.put(to.getUniqueId(), fromId);
      lastFrom.put(fromId, to.getUniqueId());
    }
  }

  void reply(Player from, String text) {
    UUID to = lastFrom.get(from.getUniqueId());
    Player target = to == null ? null : Bukkit.getPlayer(to);
    if (target == null) {
      from.sendMessage(ui().fail("msg.noreply"));
      return;
    }
    message(from, target, text);
  }

  void mail(Player from, OfflinePlayer to, String text) {
    PlayerStore.Data d = plugin.store().get(to.getUniqueId());
    if (ignores(to.getUniqueId(), from.getUniqueId())) {
      from.sendMessage(ui().fail("tpa.blocked", Ui.v("name", String.valueOf(to.getName()))));
      return;
    }
    long fromThem = d.mail.stream().filter(m -> m.from().equals(from.getName())).count();
    if (d.mail.size() >= PlayerStore.MAX_MAIL || fromThem >= MAIL_PER_SENDER) {
      from.sendMessage(ui().fail("mail.full", Ui.v("name", String.valueOf(to.getName()))));
      return;
    }
    d.mail.add(new PlayerStore.Mail(from.getName(), System.currentTimeMillis(), text));
    plugin.store().save(to.getUniqueId(), d);
    from.sendMessage(ui().ok("mail.sent", Ui.v("name", String.valueOf(to.getName()))));
    Player online = to.getPlayer();
    if (online != null) waiting(online);
    else plugin.store().forget(to.getUniqueId()); // not kept in memory for players who are away
  }

  /** "2 new messages [ ✉ Read ]" – or nothing when there are none. */
  Component waitingLine(Player p) {
    int count = plugin.store().get(p.getUniqueId()).mail.size();
    if (count == 0) return null;
    Component read = Ui.button(ui().bare("mail.read"), Ui.MAIL, null, ClickEvent.runCommand("/mail read"));
    return Component.text("✉ ", Ui.MAIL).append(count == 1 ? ui().words("mail.waiting.one") : ui().words("mail.waiting", Ui.v("count", count))).append(Ui.gap()).append(read);
  }

  void waiting(Player p) {
    Component line = waitingLine(p);
    if (line != null) {
      p.sendMessage(line);
      p.playSound(MESSAGE);
    }
  }

  void readMail(Player p) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.mail.isEmpty()) {
      p.sendMessage(ui().note("✉", Ui.MAIL, "mail.none"));
      return;
    }
    List<Component> lines = new ArrayList<>();
    DateTimeFormatter when = DateTimeFormatter.ofPattern("dd.MM. HH:mm").withZone(zone());
    for (PlayerStore.Mail m : d.mail) {
      lines.add(Component.text(when.format(Instant.ofEpochMilli(m.at())) + "  ", Ui.DIM)
          .append(Component.text(m.from(), net.kyori.adventure.text.format.NamedTextColor.WHITE))
          .append(Component.text(": ", Ui.SOFT))
          .append(Component.text(m.text(), Ui.SOFT)));
    }
    ui().card(p, ui().flat("mail.title"), lines);
    d.mail.clear();
    plugin.store().save(p.getUniqueId(), d);
  }

  void ignore(Player p, OfflinePlayer other) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    String id = other.getUniqueId().toString();
    String name = String.valueOf(other.getName());
    if (d.ignored.remove(id)) {
      p.sendMessage(ui().ok("ignore.off", Ui.v("name", name)));
    } else {
      d.ignored.add(id);
      p.sendMessage(ui().ok("ignore.on", Ui.v("name", name)));
    }
    plugin.store().save(p.getUniqueId(), d);
  }

  // ── Away ─────────────────────────────────────────────────────────────────────────────

  private ZoneId zone() {
    try {
      return ZoneId.of(plugin.settings().timezone());
    } catch (RuntimeException e) {
      return ZoneId.systemDefault();
    }
  }

  void toggleAway(Player p) {
    long now = System.currentTimeMillis();
    Long last = lastAfk.get(p.getUniqueId());
    if (last != null && now - last < AFK_EVERY_MS) {
      p.sendMessage(ui().fail("afk.wait"));
      return;
    }
    lastAfk.put(p.getUniqueId(), now);
    if (away.remove(p.getUniqueId())) {
      Bukkit.broadcast(ui().note("☀", Ui.GOLD, "afk.off", Ui.v("name", p.getName())));
    } else {
      away.add(p.getUniqueId());
      Bukkit.broadcast(ui().note("☾", Ui.SOFT, "afk.on", Ui.v("name", p.getName())));
    }
  }

  private void backAgain(Player p) {
    if (away.remove(p.getUniqueId())) Bukkit.broadcast(ui().note("☀", Ui.GOLD, "afk.off", Ui.v("name", p.getName())));
  }

  @EventHandler(ignoreCancelled = true)
  public void onMove(PlayerMoveEvent e) {
    if (away.contains(e.getPlayer().getUniqueId()) && e.hasChangedBlock()) backAgain(e.getPlayer());
  }

  /** Chat: players someone ignores don't reach them; whoever writes is no longer away. */
  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onChat(AsyncChatEvent e) {
    UUID sender = e.getPlayer().getUniqueId();
    e.viewers().removeIf(v -> v instanceof Player viewer && ignores(viewer.getUniqueId(), sender));
    if (away.contains(sender)) Bukkit.getScheduler().runTask(plugin, () -> backAgain(e.getPlayer()));
  }

  /** Load the player's data now, on the main thread – not later from the chat thread. */
  @EventHandler(priority = EventPriority.LOWEST)
  public void onJoin(PlayerJoinEvent e) {
    plugin.store().get(e.getPlayer().getUniqueId());
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    UUID id = e.getPlayer().getUniqueId();
    away.remove(id);
    requests.remove(id);
    lastFrom.remove(id);
    lastAfk.remove(id);
  }

  /** Who may still answer `target` with /tpaccept (for the tab list). */
  List<String> askers(Player target) {
    LinkedHashMap<UUID, Request> open = requests.get(target.getUniqueId());
    if (open == null) return List.of();
    List<String> names = new ArrayList<>();
    for (Request r : open.values()) {
      Player p = Bukkit.getPlayer(r.from());
      if (p != null && System.currentTimeMillis() - r.at() <= REQUEST_MS) names.add(p.getName());
    }
    return names;
  }
}
