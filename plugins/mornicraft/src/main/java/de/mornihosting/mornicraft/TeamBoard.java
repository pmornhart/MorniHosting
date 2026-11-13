package de.mornihosting.mornicraft;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.OfflinePlayer;
import org.bukkit.Statistic;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;

/**
 * The team dashboard (/teamdashboard): a web page in MorniHosting for the team (Moderator, Owner) – who is online,
 * who sits in the jail, who is muted or frozen, with buttons for what their rank may do. The plugin writes what the
 * page shows (team/state.json), hands out personal links (a random key, only its hash is kept in team/links/, valid
 * 12 hours) and carries out what the page asks for (team/actions/, written by the panel after checking the key).
 */
final class TeamBoard {
  private static final long STATE_TICKS = 100;
  private static final long ACTION_TICKS = 20;
  /** The jailed/muted players who are offline: their files are read again at most this often. */
  private static final long OFFLINE_SCAN_MS = 30_000;
  private static final long LINK_MS = 12L * 60 * 60 * 1000;
  private static final int KEY_BYTES = 24;
  private static final int MAX_MINUTES = 30 * 24 * 60;
  private static final int MAX_REASON = 120;
  private static final int HISTORY_KEEP = 500;
  private static final int HISTORY_SHOWN = 200;
  /** A key's hash as a file name: 64 hex characters. */
  private static final Pattern HEX = Pattern.compile("[0-9a-f]{64}");
  /** "key": "value" or "key": 123 in the small JSON files the panel writes. */
  private static final Pattern FIELD = Pattern.compile("\"(\\w+)\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|(-?\\d+)|(true|false))");

  private final MorniCraft plugin;
  private final File dir;
  private final SecureRandom random = new SecureRandom();
  private List<Map<String, Object>> offlineJailed = List.of();
  private List<Map<String, Object>> offlineMuted = List.of();
  private long scannedAt;

  TeamBoard(MorniCraft plugin) {
    this.plugin = plugin;
    this.dir = new File(plugin.getDataFolder(), "team");
    Bukkit.getScheduler().runTaskTimer(plugin, this::writeState, 40, STATE_TICKS);
    Bukkit.getScheduler().runTaskTimer(plugin, this::runActions, 40, ACTION_TICKS);
  }

  // ---------------------------------------------------------------- who may and what

  static boolean team(CommandSender s) {
    return s.isOp() || s.hasPermission(Moderation.PERMISSION);
  }

  /** What this team member may do on the page (the panel shows only those buttons and checks them again). */
  private List<String> abilities(Player p) {
    List<String> out = new ArrayList<>();
    out.add("moderate");
    if (p.isOp() || p.hasPermission("minecraft.command.kick")) out.add("kick");
    if (p.isOp() || p.hasPermission("minecraft.command.ban")) out.add("ban");
    if (p.isOp() || p.hasPermission("minecraft.command.teleport")) out.add("locate");
    if (RankCommands.allowed(p)) {
      out.add("ranks");
      out.add("rules");
    }
    return out;
  }

  // ---------------------------------------------------------------- /teamdashboard

  void command(CommandSender sender) {
    Ui ui = plugin.ui();
    if (!(sender instanceof Player p)) {
      sender.sendMessage(ui.fail("only.players"));
      return;
    }
    if (!team(p)) {
      sender.sendMessage(ui.fail("teamboard.noperm"));
      return;
    }
    String base = plugin.settings().teamLink();
    if (base.isEmpty()) {
      p.sendMessage(ui.fail("teamboard.nopanel"));
      return;
    }
    byte[] raw = new byte[KEY_BYTES];
    random.nextBytes(raw);
    String key = HexFormat.of().formatHex(raw);
    Ranks.Rank rank = plugin.ranks().of(p);
    Map<String, Object> link = new LinkedHashMap<>();
    link.put("uuid", p.getUniqueId().toString());
    link.put("name", p.getName());
    link.put("rank", rank == null ? "" : rank.name());
    link.put("rankColor", rank == null ? "" : rank.color().asHexString());
    link.put("op", p.isOp());
    link.put("abilities", abilities(p));
    link.put("until", System.currentTimeMillis() + LINK_MS);
    File links = new File(dir, "links");
    links.mkdirs();
    // One link per person: an older one stops working.
    File[] old = links.listFiles((d, n) -> n.endsWith(".json"));
    if (old != null) {
      for (File f : old) {
        try {
          if (Files.readString(f.toPath()).contains("\"uuid\": \"" + p.getUniqueId() + "\"")) Files.deleteIfExists(f.toPath());
        } catch (IOException ignored) {
          // Unreadable: it simply stays until it runs out.
        }
      }
    }
    write(new File(links, sha256(key) + ".json"), json(link));
    String url = base + "#" + key;
    p.sendMessage(ui.ok("teamboard.link"));
    p.sendMessage(Component.text("  ➜ " + ui.flat("teamboard.open"), Ui.ACCENT)
        .hoverEvent(HoverEvent.showText(Component.text(ui.flat("teamboard.hover"), Ui.SOFT)))
        .clickEvent(ClickEvent.openUrl(url)));
  }

  // ---------------------------------------------------------------- what the page shows

  private void writeState() {
    if (plugin.settings().teamLink().isEmpty()) return;
    long now = System.currentTimeMillis();
    Moderation mod = plugin.moderation();
    List<Map<String, Object>> online = new ArrayList<>();
    for (Player p : Bukkit.getOnlinePlayers()) {
      PlayerStore.Data d = plugin.store().get(p.getUniqueId());
      Ranks.Rank rank = plugin.ranks().of(p);
      Location l = p.getLocation();
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("uuid", p.getUniqueId().toString());
      m.put("name", p.getName());
      m.put("rank", rank == null ? "" : rank.name());
      m.put("rankId", rank == null ? "" : rank.id());
      m.put("rankColor", rank == null ? "" : rank.color().asHexString());
      m.put("rankOrder", rank == null ? 99 : plugin.ranks().all().indexOf(rank));
      m.put("team", team(p));
      m.put("ping", p.getPing());
      m.put("world", l.getWorld() == null ? "" : l.getWorld().getName());
      m.put("x", l.getBlockX());
      m.put("y", l.getBlockY());
      m.put("z", l.getBlockZ());
      m.put("health", Math.round(p.getHealth()));
      m.put("food", p.getFoodLevel());
      m.put("gamemode", p.getGameMode().name().toLowerCase(Locale.ROOT));
      m.put("afk", plugin.social().isAway(p));
      m.put("live", plugin.streamer().showsLive(p));
      m.put("combat", plugin.combat().inCombat(p));
      m.put("frozen", mod.frozen(p));
      m.put("jailedUntil", d.jailUntil > now ? d.jailUntil : 0);
      m.put("jailReason", d.jailUntil > now ? d.jailReason : "");
      m.put("mutedUntil", d.muteUntil > now ? d.muteUntil : 0);
      m.put("bedrock", plugin.bedrock().is(p));
      m.put("playMinutes", p.getStatistic(Statistic.PLAY_ONE_MINUTE) / 20 / 60);
      m.put("inventory", items(p.getInventory().getContents()));
      m.put("ender", items(p.getEnderChest().getContents()));
      online.add(m);
    }
    if (now - scannedAt > OFFLINE_SCAN_MS) scanOffline(now);
    List<Map<String, Object>> ranks = new ArrayList<>();
    for (Ranks.Rank r : plugin.ranks().all()) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", r.id());
      m.put("name", r.name());
      m.put("color", r.color().asHexString());
      m.put("symbol", r.symbol());
      m.put("default", r.fallback());
      ranks.add(m);
    }
    Map<String, Object> state = new LinkedHashMap<>();
    state.put("at", now);
    state.put("server", plugin.settings().serverName());
    state.put("max", Bukkit.getMaxPlayers());
    state.put("online", online);
    state.put("jailedOffline", offlineJailed);
    state.put("mutedOffline", offlineMuted);
    state.put("ranks", ranks);
    state.put("bans", bans());
    state.put("history", recent());
    String text = json(state);
    Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> write(new File(dir, "state.json"), text));
  }

  /** Jailed or muted players who are not online right now (read from their files). */
  private void scanOffline(long now) {
    scannedAt = now;
    List<Map<String, Object>> jailed = new ArrayList<>();
    List<Map<String, Object>> muted = new ArrayList<>();
    File[] files = new File(plugin.getDataFolder(), "players").listFiles((d, n) -> n.endsWith(".yml"));
    if (files != null) {
      for (File f : files) {
        UUID id;
        try {
          id = UUID.fromString(f.getName().substring(0, f.getName().length() - ".yml".length()));
        } catch (IllegalArgumentException e) {
          continue;
        }
        if (Bukkit.getPlayer(id) != null) continue;
        YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
        long jail = y.getLong("jail.until", 0);
        long mute = y.getLong("mute.until", 0);
        if (jail <= now && mute <= now) continue;
        OfflinePlayer o = Bukkit.getOfflinePlayer(id);
        String name = o.getName() == null ? id.toString().substring(0, 8) : o.getName();
        if (jail > now) jailed.add(entry(id, name, jail, y.getString("jail.reason", "")));
        if (mute > now) muted.add(entry(id, name, mute, ""));
      }
    }
    offlineJailed = jailed;
    offlineMuted = muted;
  }

  private static Map<String, Object> entry(UUID id, String name, long until, String reason) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("uuid", id.toString());
    m.put("name", name);
    m.put("until", until);
    m.put("reason", reason);
    return m;
  }

  // ---------------------------------------------------------------- what the page asks for

  /** Requests from the page (the panel checked the key and what the person may do): carried out in the game. */
  private void runActions() {
    File[] files = new File(dir, "actions").listFiles((d, n) -> n.endsWith(".json"));
    if (files == null || files.length == 0) return;
    for (File f : files) {
      String text;
      try {
        text = Files.readString(f.toPath(), StandardCharsets.UTF_8);
        Files.deleteIfExists(f.toPath());
      } catch (IOException e) {
        continue;
      }
      try {
        act(fields(text));
      } catch (RuntimeException e) {
        plugin.getLogger().warning("Team dashboard: could not carry out " + f.getName() + ": " + e.getMessage());
      }
    }
    writeState();
  }

  private void act(Map<String, String> a) {
    String what = a.getOrDefault("action", "");
    String by = a.getOrDefault("by", "?");
    Player staff = Bukkit.getPlayerExact(by);
    CommandSender sender = staff != null ? staff : Bukkit.getConsoleSender();
    Player target = Bukkit.getPlayerExact(a.getOrDefault("target", ""));
    String reason = a.getOrDefault("reason", "");
    if (reason.length() > MAX_REASON) reason = reason.substring(0, MAX_REASON);
    long minutes = Math.max(1, Math.min(MAX_MINUTES, parseLong(a.get("minutes"), 10)));
    Moderation mod = plugin.moderation();
    plugin.getLogger().info("Team dashboard: " + by + " → " + what + " " + a.getOrDefault("target", ""));
    switch (what) {
      case "jail" -> {
        if (target != null) mod.jail(sender, target, minutes * 60_000L, reason);
        else offlinePunish("jail", a.getOrDefault("target", ""), by, minutes, reason);
      }
      case "mute" -> {
        if (target != null) mod.mute(sender, target, minutes * 60_000L, reason);
        else offlinePunish("mute", a.getOrDefault("target", ""), by, minutes, reason);
      }
      case "free" -> freeAnyone(sender, a.getOrDefault("target", ""));
      case "unmute" -> unmuteAnyone(sender, a.getOrDefault("target", ""));
      case "freeze" -> {
        if (target != null) mod.freeze(sender, target);
      }
      case "kick" -> {
        if (target != null) {
          target.kick(Component.text(reason.isEmpty() ? plugin.ui().flat("teamboard.kicked") : reason));
          record("kick", target.getName(), by, reason, 0);
        }
      }
      case "ban" -> ban(sender, a.getOrDefault("target", ""), reason, parseLong(a.get("minutes"), 0));
      case "unban" -> {
        Bukkit.getBanList(BanList.Type.NAME).pardon(a.getOrDefault("target", ""));
        record("unban", a.getOrDefault("target", ""), by, "", 0);
      }
      case "rank" -> {
        Ranks.Rank rank = plugin.rankCommands().find(a.getOrDefault("rank", ""));
        if (rank != null) plugin.rankCommands().setFrom(sender, a.getOrDefault("target", ""), rank);
      }
      default -> plugin.getLogger().warning("Team dashboard: unknown action " + what);
    }
  }

  // ---------------------------------------------------------------- bans

  /** Banned by name, for some minutes or (0) for good; online they leave at once. */
  @SuppressWarnings("deprecation")
  private void ban(CommandSender by, String name, String reason, long minutes) {
    java.util.Date until = minutes > 0 ? new java.util.Date(System.currentTimeMillis() + minutes * 60_000L) : null;
    String why = reason.isEmpty() ? plugin.ui().flat("teamboard.banned") : reason;
    Bukkit.getBanList(BanList.Type.NAME).addBan(name, why, until, by.getName());
    Player online = Bukkit.getPlayerExact(name);
    if (online != null) online.kick(Component.text(why));
    record("ban", name, by.getName(), reason, minutes * 60_000L);
  }

  @SuppressWarnings("deprecation")
  private List<Map<String, Object>> bans() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (org.bukkit.BanEntry e : Bukkit.getBanList(BanList.Type.NAME).getBanEntries()) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("name", e.getTarget());
      m.put("reason", e.getReason() == null ? "" : e.getReason());
      m.put("by", e.getSource());
      m.put("since", e.getCreated() == null ? 0 : e.getCreated().getTime());
      m.put("until", e.getExpiration() == null ? 0 : e.getExpiration().getTime());
      out.add(m);
    }
    return out;
  }

  // ---------------------------------------------------------------- inventories

  private static List<Map<String, Object>> items(org.bukkit.inventory.ItemStack[] contents) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (int slot = 0; slot < contents.length; slot++) {
      org.bukkit.inventory.ItemStack it = contents[slot];
      if (it == null || it.getType().isAir()) continue;
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("slot", slot);
      m.put("id", it.getType().getKey().getKey());
      m.put("count", it.getAmount());
      m.put("enchanted", !it.getEnchantments().isEmpty());
      out.add(m);
    }
    return out;
  }

  // ---------------------------------------------------------------- history of punishments

  /** One line per punishment (jail, mute, freeze, kick, ban …) in team/history.jsonl; the newest 500 stay. */
  void record(String type, String target, String by, String reason, long ms) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("at", System.currentTimeMillis());
    m.put("type", type);
    m.put("target", target);
    m.put("by", by);
    m.put("reason", reason == null ? "" : reason);
    m.put("minutes", ms / 60_000L);
    String line = json(m);
    Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> appendHistory(line));
  }

  private synchronized void appendHistory(String line) {
    File f = new File(dir, "history.jsonl");
    try {
      dir.mkdirs();
      List<String> lines = f.exists() ? new ArrayList<>(Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) : new ArrayList<>();
      lines.add(line);
      if (lines.size() > HISTORY_KEEP) lines = new ArrayList<>(lines.subList(lines.size() - HISTORY_KEEP, lines.size()));
      write(f, String.join("\n", lines) + "\n");
    } catch (IOException e) {
      plugin.getLogger().warning("Team dashboard: could not write the history: " + e.getMessage());
    }
  }

  /** The newest punishments for the page (as raw JSON lines, newest first). */
  private List<Object> recent() {
    File f = new File(dir, "history.jsonl");
    if (!f.exists()) return List.of();
    try {
      List<String> lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
      List<Object> out = new ArrayList<>();
      for (int i = lines.size() - 1; i >= 0 && out.size() < HISTORY_SHOWN; i--) {
        if (!lines.get(i).isBlank()) out.add(new Raw(lines.get(i)));
      }
      return out;
    } catch (IOException e) {
      return List.of();
    }
  }

  /** Already JSON (a history line). */
  private record Raw(String json) {}

  /** Jail or mute someone who is not online: it starts now and counts when they come back. */
  private void offlinePunish(String what, String name, String by, long minutes, String reason) {
    UUID id = offlineId(name);
    if (id == null) return;
    long now = System.currentTimeMillis();
    PlayerStore.Data d = plugin.store().get(id);
    if (what.equals("jail")) {
      d.jailUntil = now + minutes * 60_000L;
      d.jailFrom = now;
      d.jailReason = reason;
    } else {
      d.muteUntil = now + minutes * 60_000L;
    }
    plugin.store().save(id, d);
    record(what, name, by, reason, minutes * 60_000L);
    scannedAt = 0;
  }

  /** Release from the jail – online with the usual way back, offline the time simply ends. */
  private void freeAnyone(CommandSender by, String name) {
    Player online = Bukkit.getPlayerExact(name);
    if (online != null) {
      plugin.moderation().release(by, online, true);
      return;
    }
    UUID id = offlineId(name);
    if (id == null) return;
    PlayerStore.Data d = plugin.store().get(id);
    d.jailUntil = System.currentTimeMillis();
    plugin.store().save(id, d);
    scannedAt = 0;
  }

  private void unmuteAnyone(CommandSender by, String name) {
    Player online = Bukkit.getPlayerExact(name);
    if (online != null) {
      plugin.moderation().unmute(by, online);
      return;
    }
    UUID id = offlineId(name);
    if (id == null) return;
    PlayerStore.Data d = plugin.store().get(id);
    d.muteUntil = 0;
    plugin.store().save(id, d);
    scannedAt = 0;
  }

  private static UUID offlineId(String name) {
    OfflinePlayer o = Bukkit.getOfflinePlayerIfCached(name);
    return o == null ? null : o.getUniqueId();
  }

  private static long parseLong(String s, long fallback) {
    try {
      return s == null ? fallback : Long.parseLong(s);
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  static Map<String, String> fields(String text) {
    Map<String, String> out = new LinkedHashMap<>();
    Matcher m = FIELD.matcher(text);
    while (m.find()) {
      String value = m.group(2) != null ? m.group(2).replace("\\\"", "\"").replace("\\\\", "\\")
          : m.group(3) != null ? m.group(3) : m.group(4);
      out.put(m.group(1), value);
    }
    return out;
  }

  static boolean validKeyHash(String s) {
    return HEX.matcher(s).matches();
  }

  // ---------------------------------------------------------------- small helpers

  private static String sha256(String text) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Written next to the file first and then moved: the panel never reads half a file. */
  private void write(File f, String text) {
    try {
      f.getParentFile().mkdirs();
      File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
      Files.writeString(tmp.toPath(), text, StandardCharsets.UTF_8);
      Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException e) {
      plugin.getLogger().warning("Team dashboard: could not write " + f.getName() + ": " + e.getMessage());
    }
  }

  /** JSON for maps, lists, strings, numbers and booleans (all this needs). */
  static String json(Object o) {
    if (o == null) return "null";
    if (o instanceof Raw r) return r.json();
    if (o instanceof String s) return quote(s);
    if (o instanceof Number || o instanceof Boolean) return String.valueOf(o);
    if (o instanceof Map<?, ?> m) {
      StringBuilder b = new StringBuilder("{");
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) b.append(", ");
        b.append(quote(String.valueOf(e.getKey()))).append(": ").append(json(e.getValue()));
        first = false;
      }
      return b.append('}').toString();
    }
    if (o instanceof List<?> l) {
      StringBuilder b = new StringBuilder("[");
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) b.append(", ");
        b.append(json(l.get(i)));
      }
      return b.append(']').toString();
    }
    return quote(String.valueOf(o));
  }

  private static String quote(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        default -> {
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
        }
      }
    }
    return b.append('"').toString();
  }
}
