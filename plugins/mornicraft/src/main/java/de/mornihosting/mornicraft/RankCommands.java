package de.mornihosting.mornicraft;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.server.ServerCommandEvent;

/**
 * Ranks straight from the chat: "/vip Steve" gives Steve the VIP rank, "/mod Steve" makes him a moderator, "/vip Steve
 * weg" takes it away again – for OPs and ranks that may manage the server (Owner, Admin: mornicraft.admin). The rank
 * is found by its id, its name or the start of it ("mod" → Moderator). Also "/rang Steve vip". Nobody gives a rank
 * above their own (except OPs and the console).
 */
final class RankCommands implements Listener {
  /** Hand out ranks (Owner, Admin by default); mornicraft.admin (settings) counts too. */
  static final String PERMISSION = "mornicraft.ranks";
  /** Shortest start of a rank's name that counts ("mod", "sup", "vip"). */
  private static final int MIN_PREFIX = 3;
  private static final List<String> REMOVE = List.of("weg", "entfernen", "remove", "raus", "off");

  private final MorniCraft plugin;

  RankCommands(MorniCraft plugin) {
    this.plugin = plugin;
  }

  static boolean allowed(CommandSender s) {
    return s.isOp() || s.hasPermission(PERMISSION) || s.hasPermission("mornicraft.admin");
  }

  private static String plain(String s) {
    return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9äöü]", "");
  }

  /** The rank a word means: id or name exactly, else the only one whose id or name starts with it. */
  Ranks.Rank find(String word) {
    String w = plain(word);
    if (w.isEmpty()) return null;
    List<Ranks.Rank> all = plugin.ranks().all();
    for (Ranks.Rank r : all) {
      if (plain(r.id()).equals(w) || plain(r.name()).equals(w)) return r;
    }
    if (w.length() < MIN_PREFIX) return null;
    List<Ranks.Rank> starts = all.stream()
        .filter(r -> plain(r.id()).startsWith(w) || plain(r.name()).startsWith(w)).toList();
    return starts.size() == 1 ? starts.get(0) : null;
  }

  /** "/vip Steve" from a player: handled here when it is a rank and the player may hand out ranks. */
  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onCommand(PlayerCommandPreprocessEvent e) {
    if (handle(e.getPlayer(), e.getMessage().substring(1))) e.setCancelled(true);
  }

  /** The same from the server console ("vip Steve"). */
  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onConsole(ServerCommandEvent e) {
    if (handle(e.getSender(), e.getCommand().startsWith("/") ? e.getCommand().substring(1) : e.getCommand()))
      e.setCancelled(true);
  }

  private boolean handle(CommandSender sender, String line) {
    String[] parts = line.trim().split("\\s+");
    if (parts.length < 2 || !allowed(sender)) return false;
    String label = parts[0].toLowerCase(Locale.ROOT);
    if (label.contains(":")) label = label.substring(label.indexOf(':') + 1);
    // Commands that are no rank: never taken over (and /team keeps passing words on to Minecraft's /team).
    if (label.equals("team") || label.equals("rang") || label.equals("rank")) return false;
    Ranks.Rank rank = find(label);
    if (rank == null) return false;
    boolean remove = parts.length > 2 && REMOVE.contains(parts[2].toLowerCase(Locale.ROOT));
    set(sender, parts[1], rank, remove);
    return true;
  }

  /** "/rang <spieler> <rang> [weg]". */
  void command(CommandSender sender, String[] args) {
    Ui ui = plugin.ui();
    if (!allowed(sender)) {
      sender.sendMessage(ui.fail("rank.noperm"));
      return;
    }
    if (args.length < 2) {
      sender.sendMessage(ui.fail("usage", Ui.v("usage", "/rang <spieler> <rang> [weg]")));
      return;
    }
    Ranks.Rank rank = find(args[1]);
    if (rank == null) {
      sender.sendMessage(ui.fail("rank.unknown", Ui.v("rank", args[1]), Ui.v("ranks", names())));
      return;
    }
    set(sender, args[0], rank, args.length > 2 && REMOVE.contains(args[2].toLowerCase(Locale.ROOT)));
  }

  private String names() {
    return String.join(", ", plugin.ranks().all().stream().map(Ranks.Rank::name).toList());
  }

  private void set(CommandSender sender, String who, Ranks.Rank rank, boolean remove) {
    Ui ui = plugin.ui();
    OfflinePlayer target = targetOf(who);
    if (target == null || target.getName() == null) {
      sender.sendMessage(ui.fail("rank.noplayer", Ui.v("name", who)));
      return;
    }
    UUID id = target.getUniqueId();
    String name = target.getName();
    Ranks ranks = plugin.ranks();
    Ranks.Rank current = target.getPlayer() != null ? ranks.of(target.getPlayer()) : null;
    // Nobody hands out (or takes away) a rank above their own – OPs and the console may.
    if (sender instanceof Player p && !p.isOp()) {
      Ranks.Rank own = ranks.of(p);
      int ownAt = own == null ? Integer.MAX_VALUE : ranks.all().indexOf(own);
      boolean above = ranks.all().indexOf(rank) < ownAt
          || (current != null && ranks.all().indexOf(current) < ownAt);
      if (above) {
        sender.sendMessage(ui.fail("rank.above"));
        return;
      }
    }
    Ranks.Rank fallback = ranks.fallbackRank();
    if (remove || rank == fallback) {
      ranks.give(id, name, "");
      Ranks.Rank now = fallback;
      sender.sendMessage(ui.ok("rank.removed", Ui.v("name", name),
          Ui.v("rank", now == null ? "–" : now.name())));
      Player online = target.getPlayer();
      if (online != null && online != sender) online.sendMessage(ui.note("ℹ", Ui.SOFT, "rank.yours.removed"));
      return;
    }
    ranks.give(id, name, rank.id());
    sender.sendMessage(ui.ok("rank.given", Ui.v("name", name), Ui.v("rank", rank.name())));
    Player online = target.getPlayer();
    if (online != null && online != sender) {
      online.sendMessage(ui.ok("rank.yours", Ui.v("rank", rank.name())));
    }
    plugin.getLogger().info(sender.getName() + " gave " + name + " the rank " + rank.id());
  }

  /** Online by name, else someone who was here before (no lookup on the internet). */
  private static OfflinePlayer targetOf(String name) {
    Player online = Bukkit.getPlayerExact(name);
    if (online != null) return online;
    OfflinePlayer cached = Bukkit.getOfflinePlayerIfCached(name);
    return cached != null && cached.hasPlayedBefore() ? cached : null;
  }
}
