package de.mornihosting.mornicraft;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;

/**
 * What MorniCraft keeps per player in plugins/MorniCraft/players/&lt;uuid&gt;.yml: homes, who they ignore, mail.
 * The panel reads the homes from there for the personal command page.
 *
 * <p>Homes of servers that ran EssentialsX before are taken over once (plugins/Essentials/userdata/&lt;uuid&gt;.yml).
 */
final class PlayerStore {
  static final int MAX_MAIL = 50;

  /** One stored message for later. */
  record Mail(String from, long at, String text) {}

  /** A home: the world by name, so the file stays readable. */
  record Home(String world, double x, double y, double z, float yaw, float pitch) {
    Location location() {
      World w = Bukkit.getWorld(world);
      return w == null ? null : new Location(w, x, y, z, yaw, pitch);
    }

    static Home of(Location l) {
      return new Home(l.getWorld().getName(), l.getX(), l.getY(), l.getZ(), l.getYaw(), l.getPitch());
    }
  }

  static final class Data {
    final Map<String, Home> homes = new LinkedHashMap<>();
    final List<String> ignored = new CopyOnWriteArrayList<>();
    final List<Mail> mail = new ArrayList<>();
    String name = "";
    /** Saw the big welcome (only once per player and server). */
    boolean welcomed;
    /** Hid the bar on the right with /leiste. */
    boolean hideSidebar;
    /**
     * What the player wore on the chest before the start elytra took its place (Base64, "" = nothing). Kept on disk
     * so a crash mid-flight never costs a chestplate; null when no start elytra is on.
     */
    String elytraBackup;
    /** Streamer mode on (/streamer). Read by the chat thread too. */
    volatile boolean streamer;
    /** Parts of the streamer mode switched off (see {@link Streamer#OPTIONS}). */
    final Set<String> streamerOff = ConcurrentHashMap.newKeySet();
    /** In the jail until then (ms, 0 = free); where they were and their game mode before. */
    volatile long jailUntil;
    long jailFrom;
    String jailReason = "";
    Home jailReturn;
    String jailMode;
    /** Muted until then (ms, 0 = not). Read by the chat thread. */
    volatile long muteUntil;

    /** How long the whole jail time is (for the bar). */
    long jailTotal(long now) {
      return jailUntil - (jailFrom > 0 ? jailFrom : now);
    }
  }

  private final MorniCraft plugin;
  private final File folder;
  /** Chat runs on its own thread (ignore lists): a map that may be read from there. */
  private final Map<UUID, Data> cache = new ConcurrentHashMap<>();

  PlayerStore(MorniCraft plugin) {
    this.plugin = plugin;
    this.folder = new File(plugin.getDataFolder(), "players");
    folder.mkdirs();
  }

  Data get(UUID id) {
    return cache.computeIfAbsent(id, this::load);
  }

  void forget(UUID id) {
    cache.remove(id);
  }

  private File file(UUID id) {
    return new File(folder, id + ".yml");
  }

  private Data load(UUID id) {
    File f = file(id);
    Data d = new Data();
    if (!f.exists()) {
      if (fromEssentials(id, d)) save(id, d);
      return d;
    }
    YamlConfiguration y = new YamlConfiguration();
    try {
      y.load(f);
    } catch (IOException | InvalidConfigurationException e) {
      // A broken file is kept aside (never overwritten), the player starts fresh.
      File broken = new File(folder, id + ".broken-" + System.currentTimeMillis() + ".yml");
      plugin.getLogger().log(Level.WARNING, "Player data " + f.getName() + " is unreadable, kept as " + broken.getName(), e);
      if (!f.renameTo(broken)) plugin.getLogger().warning("Could not move " + f.getName() + " aside");
      return d;
    }
    d.name = y.getString("name", "");
    d.welcomed = y.getBoolean("welcomed", false);
    d.hideSidebar = y.getBoolean("hide-sidebar", false);
    d.elytraBackup = y.getString("elytra-backup", null);
    d.streamer = y.getBoolean("streamer", false);
    d.streamerOff.addAll(y.getStringList("streamer-off"));
    d.jailUntil = y.getLong("jail.until", 0);
    d.jailFrom = y.getLong("jail.from", 0);
    d.jailReason = y.getString("jail.reason", "");
    d.jailMode = y.getString("jail.mode", null);
    ConfigurationSection back = y.getConfigurationSection("jail.return");
    if (back != null) d.jailReturn = new Home(back.getString("world", "world"), back.getDouble("x"), back.getDouble("y"),
        back.getDouble("z"), (float) back.getDouble("yaw"), (float) back.getDouble("pitch"));
    d.muteUntil = y.getLong("mute.until", 0);
    ConfigurationSection homes = y.getConfigurationSection("homes");
    if (homes != null) {
      for (String key : homes.getKeys(false)) {
        ConfigurationSection h = homes.getConfigurationSection(key);
        if (h == null) continue;
        d.homes.put(key, new Home(h.getString("world", "world"), h.getDouble("x"), h.getDouble("y"),
            h.getDouble("z"), (float) h.getDouble("yaw"), (float) h.getDouble("pitch")));
      }
    }
    d.ignored.addAll(y.getStringList("ignored"));
    for (Map<?, ?> m : y.getMapList("mail")) {
      Object at = m.get("at");
      d.mail.add(new Mail(String.valueOf(m.get("from")), at instanceof Number n ? n.longValue() : 0L,
          String.valueOf(m.get("text"))));
    }
    return d;
  }

  void save(UUID id, Data d) {
    YamlConfiguration y = new YamlConfiguration();
    y.set("name", d.name);
    y.set("welcomed", d.welcomed);
    y.set("hide-sidebar", d.hideSidebar);
    if (d.elytraBackup != null) y.set("elytra-backup", d.elytraBackup);
    y.set("streamer", d.streamer);
    y.set("streamer-off", new ArrayList<>(d.streamerOff));
    if (d.jailUntil > 0) {
      y.set("jail.until", d.jailUntil);
      y.set("jail.from", d.jailFrom);
      y.set("jail.reason", d.jailReason);
      if (d.jailMode != null) y.set("jail.mode", d.jailMode);
      if (d.jailReturn != null) {
        Home h = d.jailReturn;
        y.set("jail.return.world", h.world());
        y.set("jail.return.x", h.x());
        y.set("jail.return.y", h.y());
        y.set("jail.return.z", h.z());
        y.set("jail.return.yaw", h.yaw());
        y.set("jail.return.pitch", h.pitch());
      }
    }
    if (d.muteUntil > System.currentTimeMillis()) y.set("mute.until", d.muteUntil);
    d.homes.forEach((key, h) -> {
      String p = "homes." + key + ".";
      y.set(p + "world", h.world());
      y.set(p + "x", h.x());
      y.set(p + "y", h.y());
      y.set(p + "z", h.z());
      y.set(p + "yaw", h.yaw());
      y.set(p + "pitch", h.pitch());
    });
    y.set("ignored", d.ignored);
    List<Map<String, Object>> mail = new ArrayList<>();
    for (Mail m : d.mail) mail.add(Map.of("from", m.from(), "at", m.at(), "text", m.text()));
    y.set("mail", mail);
    // Written next to it first, then moved over in one step: a full disk or a crash never leaves half a file.
    Path target = file(id).toPath();
    Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
    try {
      Files.write(tmp, y.saveToString().getBytes(StandardCharsets.UTF_8));
      try {
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } catch (IOException atomicNotPossible) {
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
      }
    } catch (IOException e) {
      plugin.getLogger().log(Level.WARNING, "Could not save player data " + id, e);
    }
  }

  /** EssentialsX keeps homes under "homes.<name>" with world (name or uuid), x, y, z, yaw, pitch. */
  private boolean fromEssentials(UUID id, Data d) {
    File f = new File(plugin.getDataFolder().getParentFile(), "Essentials/userdata/" + id + ".yml");
    if (!f.exists()) return false;
    ConfigurationSection homes = YamlConfiguration.loadConfiguration(f).getConfigurationSection("homes");
    if (homes == null) return false;
    for (String key : homes.getKeys(false)) {
      ConfigurationSection h = homes.getConfigurationSection(key);
      if (h == null) continue;
      String world = worldName(h.getString("world-name", ""), h.getString("world", ""));
      if (world == null) continue;
      d.homes.put(key, new Home(world, h.getDouble("x"), h.getDouble("y"), h.getDouble("z"),
          (float) h.getDouble("yaw"), (float) h.getDouble("pitch")));
    }
    if (!d.homes.isEmpty()) plugin.getLogger().info("Took over " + d.homes.size() + " home(s) of " + id + " from EssentialsX");
    return !d.homes.isEmpty();
  }

  private static String worldName(String name, String world) {
    if (!name.isEmpty()) return name;
    if (world.isEmpty()) return null;
    try {
      World w = Bukkit.getWorld(UUID.fromString(world));
      return w == null ? null : w.getName();
    } catch (IllegalArgumentException notUuid) {
      return world;
    }
  }
}
