package de.mornihosting.mornicraft;

import io.papermc.paper.event.player.AsyncChatEvent;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import net.kyori.adventure.audience.Audience;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerResourcePackStatusEvent;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

/**
 * Ranks like Owner, Moderator or Media: a symbol and a colour in front of the name – in the chat, in the tab
 * list and above the head – and the permissions that belong to the rank. Set in the dashboard (config.yml "ranks",
 * highest first); a rank marked "default" is everyone else's.
 */
final class Ranks implements Listener {
  /** At most this many ranks (teams sort the tab list by name: two digits). */
  static final int MAX = 20;
  private static final String TEAM = "mcr";
  /** Lower-case letters, digits, _ and -: "owner", "mod-2". */
  private static final Pattern ID = Pattern.compile("[a-z0-9_-]{1,24}");
  private static final int MAX_SYMBOL = 4;
  private static final int MAX_NAME = 20;
  /** The pack is offered a moment after joining (the game is busy loading the world before). */
  private static final long PACK_DELAY_TICKS = 40;

  record Member(UUID uuid, String name) {
    boolean is(Player p) {
      return uuid != null ? uuid.equals(p.getUniqueId()) : name.equalsIgnoreCase(p.getName());
    }

    String shown() {
      if (!name.isEmpty()) return name;
      OfflinePlayer o = uuid == null ? null : Bukkit.getOfflinePlayer(uuid);
      return o == null || o.getName() == null ? "?" : o.getName();
    }
  }

  record Rank(String id, String name, String symbol, TextColor color, List<String> permissions, List<Member> players,
      boolean fallback, String tag) {
    /** "♛ Owner" in the rank's colour (just the name when there is no symbol). */
    Component badge() {
      return Component.text(symbol.isEmpty() ? name : symbol + " " + name, color);
    }

    /** What goes in front of a player name: "♛ " – or nothing. */
    Component prefix() {
      return symbol.isEmpty() ? Component.empty() : Component.text(symbol + " ", color);
    }
  }

  private final MorniCraft plugin;
  private volatile List<Rank> ranks = List.of();
  private final Map<UUID, PermissionAttachment> granted = new HashMap<>();
  /** Players whose game has loaded the badges' resource pack (read by the chat thread too). */
  private final Set<UUID> withPack = ConcurrentHashMap.newKeySet();
  private volatile String packUrl = "";
  private volatile boolean packRequired = true;
  /** The server sends the pack itself (server.properties, required): the plugin doesn't send it again. */
  private volatile boolean packFromServer;
  /** What each player's game last said about the pack (for /abzeichen). */
  private final Map<UUID, String> lastStatus = new ConcurrentHashMap<>();
  /** How often the pack was sent again to each player since they joined. */
  private final Map<UUID, Integer> tries = new ConcurrentHashMap<>();
  /** Sent again at most this often per visit, waiting longer each time (10 s, 20 s, 40 s …). */
  private static final int PACK_MAX_TRIES = 5;
  private static final long PACK_RETRY_TICKS = 200;
  /** No answer from the game after this long: send it again. */
  private static final long PACK_ANSWER_TICKS = 1200;
  private volatile String packSha = "";
  /**
   * Ranks given in the game (/vip Steve): rank id, or "" for "back to everyone else's rank". They count before the
   * config. With MorniHosting the panel takes them over into the dashboard (rank-changes.json) and they drop out once
   * the new config says the same; without a panel they are kept in ranks-ingame.yml.
   */
  private final Map<UUID, String> given = new ConcurrentHashMap<>();
  private volatile boolean managed;

  Ranks(MorniCraft plugin) {
    this.plugin = plugin;
    readGiven();
  }

  List<Rank> all() {
    return ranks;
  }

  /** Reads the ranks from the config (the built-in ones when there are none) and puts them on everyone online. */
  void load(FileConfiguration c) {
    ranks = c.isSet("ranks") ? parse(c.getMapList("ranks")) : DefaultRanks.ranks();
    managed = c.getBoolean("managed-by-panel", false);
    // What the new config already says needs no in-game entry any more.
    given.entrySet().removeIf(e -> {
      Rank configured = configured(e.getKey(), nameOf(e.getKey()));
      String want = e.getValue();
      return configured != null ? configured.id().equals(want) : want.isEmpty();
    });
    if (!managed) writeGiven();
    for (Player p : Bukkit.getOnlinePlayers()) apply(p);
    paintAll();
    // The badges' resource pack: a new one (other ranks, names, colours) is offered to everyone again.
    String url = c.getString("pack.url", "");
    String sha = c.getString("pack.sha1", "");
    packRequired = c.getBoolean("pack.required", true);
    packFromServer = c.getBoolean("pack.server", false);
    boolean changed = !sha.equals(packSha) || !url.equals(packUrl);
    packUrl = url;
    packSha = sha;
    if (changed) {
      withPack.clear();
      for (Player p : Bukkit.getOnlinePlayers()) offerPack(p);
    }
  }

  // ---------------------------------------------------------------- badges (a tiny resource pack)

  /** Asks the player's game to load the badges (never forced; Bedrock can't use Java packs). */
  private void offerPack(Player p) {
    if (packUrl.isEmpty() || packSha.isEmpty() || plugin.bedrock().is(p) || serverSendsIt()) return;
    try {
      // Required (default): the game loads it without a "no" button, so everyone sees the badges.
      p.setResourcePack(packUrl, packSha, packRequired, plugin.ui().bare(packRequired ? "pack.prompt.required" : "pack.prompt"));
      watchAnswer(p);
    } catch (RuntimeException | LinkageError e) {
      plugin.getLogger().warning("Could not offer the badge pack to " + p.getName() + ": " + e);
    }
  }

  /** /abzeichen: the pack once more, and what the game said last time. */
  void badgesCommand(Player p) {
    if (packUrl.isEmpty() || packSha.isEmpty()) {
      p.sendMessage(plugin.ui().note("ℹ", Ui.SOFT, "pack.none"));
      return;
    }
    if (plugin.bedrock().is(p)) {
      p.sendMessage(plugin.ui().note("ℹ", Ui.SOFT, "pack.bedrock"));
      return;
    }
    String last = lastStatus.getOrDefault(p.getUniqueId(), "–");
    p.sendMessage(plugin.ui().note("ℹ", Ui.SOFT, withPack.contains(p.getUniqueId()) ? "pack.status.ok" : "pack.status",
        Ui.v("status", last)));
    tries.remove(p.getUniqueId());
    offerPack(p);
  }

  /**
   * The pack once more, a little later, while the player is here and hasn't loaded it (failed download, no answer).
   * False when it was tried often enough this visit.
   */
  private boolean retryLater(Player p) {
    UUID id = p.getUniqueId();
    int n = tries.merge(id, 1, Integer::sum);
    if (n > PACK_MAX_TRIES) return false;
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (sameVisit(p) && !withPack.contains(id)) offerPack(p);
    }, PACK_RETRY_TICKS << (n - 1));
    return true;
  }

  /** Still the same visit (not a later one after leaving and coming back). */
  private static boolean sameVisit(Player p) {
    return p.isOnline() && Bukkit.getPlayer(p.getUniqueId()) == p;
  }

  /** After each offer: no "loaded" within a minute (and not declined) → try again. */
  private void watchAnswer(Player p) {
    UUID id = p.getUniqueId();
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (!sameVisit(p) || withPack.contains(id) || "DECLINED".equals(lastStatus.get(id))) return;
      plugin.getLogger().info("Badge pack for " + p.getName() + ": no answer, sending again");
      retryLater(p);
    }, PACK_ANSWER_TICKS);
  }

  /**
   * The server sends this very pack itself (server.properties). Right after switching "required" on that only
   * happens from the next start – until then the plugin sends it (also required).
   */
  private boolean serverSendsIt() {
    if (!packFromServer) return false;
    try {
      // Server#getResourcePack (newer than the API this is built against).
      Object own = org.bukkit.Server.class.getMethod("getResourcePack").invoke(Bukkit.getServer());
      return own instanceof String url && !url.isEmpty() && url.equals(packUrl);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      return false;
    }
  }

  /** True when this viewer sees the badge pictures (others get the symbols). */
  boolean seesBadges(Audience viewer) {
    if (!(viewer instanceof Player p)) return false;
    // Required pack: every Java player has it (the game doesn't let them in without) – always the badges.
    if (packRequired && !packUrl.isEmpty() && !plugin.bedrock().is(p)) return true;
    return withPack.contains(p.getUniqueId());
  }

  /** The rank in front of a name, as this viewer can see it: the badge picture, or "♛ Owner" in colour. */
  Component label(Rank r, Audience viewer) {
    if (!r.tag().isEmpty() && seesBadges(viewer)) return Component.text(r.tag(), NamedTextColor.WHITE);
    return r.badge();
  }

  @EventHandler
  public void onPack(PlayerResourcePackStatusEvent e) {
    Player p = e.getPlayer();
    String status = e.getStatus().name();
    UUID id = p.getUniqueId();
    plugin.getLogger().info("Badge pack for " + p.getName() + ": " + status);
    lastStatus.put(id, status);
    if (status.equals("ACCEPTED") || status.equals("DOWNLOADED")) return;
    if (status.equals("SUCCESSFULLY_LOADED")) {
      withPack.add(id);
    } else {
      withPack.remove(id);
      // Say why the badges don't show: turned off in the server list, or the download didn't work.
      if (status.equals("DECLINED")) {
        p.sendMessage(plugin.ui().note("ℹ", Ui.SOFT, "pack.declined"));
      } else if (!retryLater(p)) {
        p.sendMessage(plugin.ui().fail("pack.failed", Ui.v("why", status)));
      }
    }
    Scoreboard own = p.getScoreboard();
    if (own != Bukkit.getScoreboardManager().getMainScoreboard()) paint(own, p);
  }

  static List<Rank> parse(List<Map<?, ?>> raw) {
    List<Rank> out = new ArrayList<>();
    for (Map<?, ?> m : raw) {
      if (out.size() >= MAX) break;
      String id = String.valueOf(m.get("id")).toLowerCase(Locale.ROOT);
      if (!ID.matcher(id).matches() || out.stream().anyMatch(r -> r.id().equals(id))) continue;
      String name = cut(text(m.get("name"), id), MAX_NAME);
      String symbol = cut(text(m.get("symbol"), ""), MAX_SYMBOL);
      out.add(new Rank(id, name, symbol, color(text(m.get("color"), "")), strings(m.get("permissions")),
          members(m.get("players")), Boolean.TRUE.equals(m.get("default")), text(m.get("badge"), "")));
    }
    return List.copyOf(out);
  }

  private static String text(Object o, String fallback) {
    return o == null ? fallback : String.valueOf(o).trim();
  }

  private static String cut(String s, int max) {
    return s.codePointCount(0, s.length()) <= max ? s : s.substring(0, s.offsetByCodePoints(0, max));
  }

  /** "#ff5555" or a Minecraft colour name ("gold"); grey when neither. */
  static TextColor color(String raw) {
    TextColor hex = raw.startsWith("#") ? TextColor.fromHexString(raw) : null;
    if (hex != null) return hex;
    NamedTextColor named = NamedTextColor.NAMES.value(raw.toLowerCase(Locale.ROOT));
    return named != null ? named : NamedTextColor.GRAY;
  }

  private static List<String> strings(Object o) {
    if (!(o instanceof List<?> list)) return List.of();
    return list.stream().map(String::valueOf).map(String::trim).filter(s -> !s.isEmpty()).toList();
  }

  /** Players as "Name", "uuid" or {name, uuid}. */
  private static List<Member> members(Object o) {
    if (!(o instanceof List<?> list)) return List.of();
    List<Member> out = new ArrayList<>();
    for (Object item : list) {
      if (item instanceof Map<?, ?> m) {
        out.add(new Member(uuid(text(m.get("uuid"), "")), text(m.get("name"), "")));
      } else if (item != null) {
        String s = String.valueOf(item).trim();
        UUID id = uuid(s);
        out.add(id != null ? new Member(id, "") : new Member(null, s));
      }
    }
    return out.stream().filter(m -> m.uuid() != null || !m.name().isEmpty()).toList();
  }

  private static UUID uuid(String s) {
    try {
      return s.length() == 36 ? UUID.fromString(s) : null;
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  /** The player's rank: given in the game, else the first (highest) that lists them, else the default one. */
  Rank of(Player p) {
    String own = given.get(p.getUniqueId());
    if (own != null) {
      Rank r = byId(own);
      if (r != null) return r;
      if (own.isEmpty()) return fallbackRank();
    }
    Rank configured = configured(p.getUniqueId(), p.getName());
    return configured != null ? configured : fallbackRank();
  }

  /** The rank the config lists this player in (not the default one). */
  private Rank configured(UUID id, String name) {
    for (Rank r : ranks) {
      boolean listed = r.players().stream().anyMatch(m -> m.uuid() != null ? m.uuid().equals(id)
          : name != null && m.name().equalsIgnoreCase(name));
      if (listed) return r;
    }
    return null;
  }

  /** Who has this rank: from the config (unless moved in the game) and given in the game. */
  List<Member> members(Rank r) {
    List<Member> out = new ArrayList<>();
    for (Member m : r.players()) {
      String moved = m.uuid() != null ? given.get(m.uuid()) : null;
      if (moved == null || moved.equals(r.id())) out.add(m);
    }
    given.forEach((id, rank) -> {
      if (rank.equals(r.id()) && out.stream().noneMatch(m -> id.equals(m.uuid()))) {
        String name = nameOf(id);
        out.add(new Member(id, name == null ? "" : name));
      }
    });
    return out;
  }

  Rank fallbackRank() {
    return ranks.stream().filter(Rank::fallback).findFirst().orElse(null);
  }

  Rank byId(String id) {
    return ranks.stream().filter(r -> r.id().equals(id)).findFirst().orElse(null);
  }

  private static String nameOf(UUID id) {
    OfflinePlayer o = Bukkit.getOfflinePlayer(id);
    return o.getName();
  }

  /**
   * Gives a player a rank in the game ("" = back to everyone else's rank): counts at once, the panel takes it over.
   */
  void give(UUID id, String name, String rankId) {
    given.put(id, rankId);
    Player online = Bukkit.getPlayer(id);
    if (online != null) apply(online);
    paintAll();
    plugin.sidebar().update();
    if (managed) tellPanel(id, name, rankId);
    else writeGiven();
  }

  // ---------------------------------------------------------------- ranks given in the game, kept on disk

  private java.io.File givenFile() {
    return new java.io.File(plugin.getDataFolder(), "ranks-ingame.yml");
  }

  private void readGiven() {
    java.io.File f = givenFile();
    if (!f.exists()) return;
    org.bukkit.configuration.file.YamlConfiguration y = org.bukkit.configuration.file.YamlConfiguration.loadConfiguration(f);
    for (String key : y.getKeys(false)) {
      UUID id = uuid(key);
      if (id != null) given.put(id, y.getString(key, ""));
    }
  }

  private void writeGiven() {
    org.bukkit.configuration.file.YamlConfiguration y = new org.bukkit.configuration.file.YamlConfiguration();
    given.forEach((id, rank) -> y.set(id.toString(), rank));
    try {
      plugin.getDataFolder().mkdirs();
      if (given.isEmpty()) java.nio.file.Files.deleteIfExists(givenFile().toPath());
      else y.save(givenFile());
    } catch (java.io.IOException e) {
      plugin.getLogger().warning("Could not save ranks-ingame.yml: " + e.getMessage());
    }
  }

  /** For MorniHosting: one line per change in rank-changes.json (the panel reads, applies and removes it). */
  private synchronized void tellPanel(UUID id, String name, String rankId) {
    java.io.File f = new java.io.File(plugin.getDataFolder(), "rank-changes.json");
    String line = "{\"uuid\":\"" + id + "\",\"name\":\"" + name.replaceAll("[^A-Za-z0-9_.]", "")
        + "\",\"rank\":\"" + rankId + "\"}\n";
    try {
      plugin.getDataFolder().mkdirs();
      java.nio.file.Files.writeString(f.toPath(), line, java.nio.charset.StandardCharsets.UTF_8,
          java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
    } catch (java.io.IOException e) {
      plugin.getLogger().warning("Could not tell the panel about a rank: " + e.getMessage());
    }
  }

  /** "♛ Morni" for chat, tab list and messages. */
  Component name(Player p) {
    Rank r = of(p);
    if (r == null) return Component.text(p.getName());
    return r.prefix().append(Component.text(p.getName(), r.color()));
  }

  // ---------------------------------------------------------------- permissions and the tab list

  private void apply(Player p) {
    PermissionAttachment old = granted.remove(p.getUniqueId());
    if (old != null) p.removeAttachment(old);
    Rank r = of(p);
    if (r != null && !r.permissions().isEmpty()) {
      PermissionAttachment a = p.addAttachment(plugin);
      r.permissions().forEach(node -> a.setPermission(node, true));
      granted.put(p.getUniqueId(), a);
    }
    // The tab list shows the rank through the teams (per viewer: badge or symbol), so no fixed list name.
    p.playerListName(null);
    listOrder(p, r == null ? 0 : ranks.size() - ranks.indexOf(r));
    p.updateCommands();
  }

  /** Paper 1.21.2+: higher ranks further up in the tab list. Older servers sort by the team names (mcr00, mcr01 …). */
  private static void listOrder(Player p, int order) {
    try {
      Player.class.getMethod("setPlayerListOrder", int.class).invoke(p, order);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      // Sorted by team name.
    }
  }

  /** In front of a name in the tab list and above the head: the badge for viewers with the pack, else "♛ ". */
  private Component teamPrefix(Rank r, Player viewer) {
    if (viewer != null && !r.tag().isEmpty() && seesBadges(viewer)) return Component.text(r.tag() + " ", NamedTextColor.WHITE);
    return r.prefix();
  }

  /**
   * The rank teams on a scoreboard: badge or symbol before the name in the tab list and above the head, sorted by
   * rank. Every player has a board of their own (see {@link Sidebar}), so each sees it as their game can show it.
   */
  void paint(Scoreboard board, Player viewer) {
    List<Rank> list = ranks;
    for (Team t : board.getTeams()) {
      String n = t.getName();
      if (n.startsWith(TEAM) && n.length() == TEAM.length() + 2 && indexOf(n) >= list.size()) t.unregister();
      // A streamer's own team ("mcr03L1a2b3c4d") goes when they stop or leave.
      if (n.startsWith(TEAM) && n.length() > TEAM.length() + 2 && n.charAt(TEAM.length() + 2) == LIVE_MARK
          && !liveTeamWanted(n)) t.unregister();
    }
    for (int i = 0; i < list.size(); i++) {
      Rank r = list.get(i);
      String n = TEAM + String.format("%02d", i);
      Team t = board.getTeam(n);
      if (t == null) t = board.registerNewTeam(n);
      t.prefix(teamPrefix(r, viewer));
      t.color(NamedTextColor.nearestTo(r.color()));
    }
    for (Player p : Bukkit.getOnlinePlayers()) {
      Rank r = of(p);
      int i = r == null ? -1 : list.indexOf(r);
      if (i < 0) {
        Team t = board.getEntryTeam(p.getName());
        if (t != null && t.getName().startsWith(TEAM)) t.removeEntry(p.getName());
        continue;
      }
      Team t;
      if (plugin.streamer().showsLive(p)) {
        // Streamers: an own team (sorted with their rank), "● LIVE" behind the name in the tab list and above the head.
        String n = liveTeam(i, p);
        t = board.getTeam(n);
        if (t == null) t = board.registerNewTeam(n);
        t.prefix(teamPrefix(r, viewer));
        t.color(NamedTextColor.nearestTo(r.color()));
        t.suffix(Component.text(" ● LIVE", NamedTextColor.RED));
      } else {
        t = board.getTeam(TEAM + String.format("%02d", i));
      }
      if (t != null && !t.hasEntry(p.getName())) t.addEntry(p.getName());
    }
  }

  private static final char LIVE_MARK = 'L';
  private static final int LIVE_ID_CHARS = 8;

  private static String liveTeam(int rankIndex, Player p) {
    return TEAM + String.format("%02d", rankIndex) + LIVE_MARK + p.getUniqueId().toString().substring(0, LIVE_ID_CHARS);
  }

  /** Still someone streaming with this team name (same rank). */
  private boolean liveTeamWanted(String team) {
    return Bukkit.getOnlinePlayers().stream().anyMatch(p -> {
      Rank r = of(p);
      int i = r == null ? -1 : ranks.indexOf(r);
      return i >= 0 && plugin.streamer().showsLive(p) && liveTeam(i, p).equals(team);
    });
  }

  private static int indexOf(String team) {
    try {
      return Integer.parseInt(team.substring(TEAM.length()));
    } catch (NumberFormatException e) {
      return Integer.MAX_VALUE;
    }
  }

  /** The main scoreboard and every player's own one (the bar on the right). */
  void paintAll() {
    Scoreboard main = Bukkit.getScoreboardManager().getMainScoreboard();
    paint(main, null);
    for (Player p : Bukkit.getOnlinePlayers()) {
      if (p.getScoreboard() != main) paint(p.getScoreboard(), p);
    }
  }

  void release() {
    granted.forEach((id, a) -> {
      Player p = Bukkit.getPlayer(id);
      if (p != null) p.removeAttachment(a);
    });
    granted.clear();
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onJoin(PlayerJoinEvent e) {
    apply(e.getPlayer());
    paintAll();
    Player p = e.getPlayer();
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (p.isOnline()) offerPack(p);
    }, PACK_DELAY_TICKS);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    granted.remove(e.getPlayer().getUniqueId());
    withPack.remove(e.getPlayer().getUniqueId());
    lastStatus.remove(e.getPlayer().getUniqueId());
    tries.remove(e.getPlayer().getUniqueId());
    String name = e.getPlayer().getName();
    Scoreboard main = Bukkit.getScoreboardManager().getMainScoreboard();
    Team t = main.getEntryTeam(name);
    if (t != null && t.getName().startsWith(TEAM)) t.removeEntry(name);
  }

  /** "♛ Owner · Morni » hello" – or "Morni » hello" without a rank. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onChat(AsyncChatEvent e) {
    e.renderer((source, displayName, message, viewer) -> {
      Rank r = of(source);
      Component name = Component.text(source.getName(), r == null ? NamedTextColor.WHITE : r.color());
      Streamer streamer = plugin.streamer();
      Component text = streamer.forViewer(viewer, message.colorIfAbsent(NamedTextColor.WHITE));
      Component who = name;
      if (r != null && !r.tag().isEmpty() && seesBadges(viewer)) {
        // With the badge pack: "[♛ OWNER] Morni" (every rank with a badge, also plain players).
        who = label(r, viewer).append(Component.text(" ")).append(name);
      } else if (r != null && !r.symbol().isEmpty()) {
        // Without: "♛ Owner · Morni".
        who = r.badge().append(Component.text(" · ", NamedTextColor.GRAY)).append(name);
      }
      if (streamer.showsLive(source)) who = streamer.liveMark().append(who);
      who = who.append(plugin.clans().tagFor(source.getUniqueId()));
      return who.append(Component.text(" » ", NamedTextColor.GRAY)).append(text);
    });
  }
}
