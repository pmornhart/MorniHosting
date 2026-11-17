package de.mornihosting.mornicraft;

import java.io.File;
import java.lang.reflect.Method;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.RegisteredServiceProvider;

/**
 * The MoinMorni network (moinmorni.net), when its plugin runs on this server: ranks, chat, punishments and the
 * player's language come from the network then, and the settings from the MoinMorni panel.
 *
 * <p>The network plugin needs Java 25 and Paper 26 – MorniCraft runs from Paper 1.17. So nothing of the network is
 * compiled in: its service ({@code de.moinmorni.api.MoinMorni}) is found by name and called by reflection. Without
 * the plugin (or with {@code network: off} in config.yml) MorniCraft stays exactly as it is alone or under
 * MorniHosting.
 *
 * <p>Since version 2 the interface also knows {@code playing} ("is in the middle of a game": then "/lobby" asks
 * first). An older network plugin doesn't have it: then it's simply missing here (null) and MorniCraft runs as
 * before.
 */
final class Network {
  private static final String SERVICE = "de.moinmorni.api.MoinMorni";
  private static final String PLUGIN = "MoinMorni";
  /** The settings the hub sends (MoinMorni panel → hub → network plugin writes this file → /mornicraft reload). */
  static final String SETTINGS_FILE = "network.json";

  /** A rank of the network: id ("owner"), symbol ("♛"), colour ("#ff5555"), position (0 = highest). */
  record Rank(String id, String symbol, String colour, int position) {}

  private final Object api;
  private final Method rank;
  private final Method hasRight;
  private final Method language;
  private final Method serverName;
  private final Method online;
  /** Since interface version 2 – null with an older network plugin. */
  private final Method playing;

  private Network(Object api, Class<?> type) throws NoSuchMethodException {
    this.api = api;
    this.rank = type.getMethod("rank", UUID.class);
    this.hasRight = type.getMethod("hasRight", UUID.class, String.class);
    this.language = type.getMethod("language", UUID.class);
    this.serverName = type.getMethod("serverName");
    this.online = type.getMethod("online");
    this.playing = optional(type, "playing", Player.class, boolean.class);
  }

  /** A method the network plugin may not have yet (older interface): null then. */
  private static Method optional(Class<?> type, String name, Class<?>... params) {
    try {
      return type.getMethod(name, params);
    } catch (NoSuchMethodException | LinkageError | RuntimeException e) {
      return null;
    }
  }

  /** The network, when its plugin runs here and config.yml doesn't say "network: off"; else null. */
  static Network find(MorniCraft plugin, FileConfiguration config) {
    if ("off".equals(Settings.mode(config, "network", "auto"))) return null;
    Plugin net = Bukkit.getPluginManager().getPlugin(PLUGIN);
    if (net == null || !net.isEnabled()) return null;
    try {
      for (Class<?> known : Bukkit.getServicesManager().getKnownServices()) {
        if (!known.getName().equals(SERVICE)) continue;
        RegisteredServiceProvider<?> r = Bukkit.getServicesManager().getRegistration(known);
        if (r == null) return null;
        return new Network(r.getProvider(), known);
      }
    } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
      plugin.getLogger().warning("MoinMorni found, but its interface doesn't fit (" + e + ") – running alone");
    }
    return null;
  }

  /** Is the hub connected right now (else chat and commands stay on this server). */
  boolean online() {
    Object v = call(online);
    return v instanceof Boolean b && b;
  }

  String serverName() {
    Object v = call(serverName);
    return v == null ? "mornicraft" : String.valueOf(v);
  }

  /** "de" or "en": what the player chose with /sprache or what their game is set to. */
  String language(UUID player) {
    Object v = call(language, player);
    return "en".equals(v) ? "en" : "de";
  }

  boolean hasRight(UUID player, String right) {
    Object v = call(hasRight, player, right);
    return v instanceof Boolean b && b;
  }

  /**
   * Is the player in the middle of something they would lose by leaving (a fight)? Then the network asks before
   * "/lobby". Older network plugin: nothing happens.
   */
  void playing(Player player, boolean playing) {
    if (this.playing != null) call(this.playing, player, playing);
  }

  /** The player's rank in the network (everyone without one: "player"). */
  Rank rank(UUID player) {
    Object r = call(rank, player);
    if (r == null) return new Rank("player", "", "#aaaaaa", Integer.MAX_VALUE / 2);
    try {
      Class<?> c = r.getClass();
      return new Rank(String.valueOf(c.getMethod("id").invoke(r)), String.valueOf(c.getMethod("symbol").invoke(r)),
          String.valueOf(c.getMethod("colour").invoke(r)), ((Number) c.getMethod("position").invoke(r)).intValue());
    } catch (ReflectiveOperationException | RuntimeException e) {
      return new Rank("player", "", "#aaaaaa", Integer.MAX_VALUE / 2);
    }
  }

  private Object call(Method m, Object... args) {
    try {
      return m.invoke(api, args);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- what network rights mean in MorniCraft

  /**
   * Network rights → MorniCraft's permissions: the team tools for whoever may jail or mute, teleports without
   * waiting for whoever may teleport, building at the spawn and creative for the build team, everything for admins.
   */
  static final Map<String, Set<String>> RIGHTS = Map.of(
      "jail", Set.of("mornicraft.moderate"),
      "mute", Set.of("mornicraft.moderate"),
      "inspect", Set.of("mornicraft.moderate"),
      "teleport", Set.of("mornicraft.instant", "minecraft.command.teleport", "minecraft.command.tp"),
      "build", Set.of("mornicraft.build"),
      "gamemode", Set.of("minecraft.command.gamemode"),
      "creative", Set.of("mornicraft.creative", "minecraft.command.gamemode"),
      "ranks", Set.of("mornicraft.admin"),
      "admin", Set.of("mornicraft.admin", "mornicraft.build", "mornicraft.unlimitedhomes", "mornicraft.instant",
          "mornicraft.moderate", "mornicraft.creative", "minecraft.command.gamemode"));

  /** Names of the network's standard ranks (the interface only knows id, symbol, colour, position). */
  private static final Map<String, String[]> NAMES = Map.of(
      "owner", new String[] {"Owner", "Owner"},
      "admin", new String[] {"Admin", "Admin"},
      "moderator", new String[] {"Moderator", "Moderator"},
      "builder", new String[] {"Builder", "Builder"},
      "media", new String[] {"Media", "Media"},
      "vip", new String[] {"VIP", "VIP"},
      "player", new String[] {"Spieler", "Player"});

  static String rankName(String id, boolean english) {
    String[] pair = NAMES.get(id);
    if (pair != null) return pair[english ? 1 : 0];
    return id.isEmpty() ? id : id.substring(0, 1).toUpperCase(Locale.ROOT) + id.substring(1);
  }

  // ---------------------------------------------------------------- settings from the MoinMorni panel

  /**
   * Lays the settings from the MoinMorni panel over config.yml (only in memory – the file stays as it is). The hub
   * sends them; the network plugin writes them to plugins/MorniCraft/network.json. JSON is YAML, Bukkit reads it.
   */
  static void overlay(MorniCraft plugin, FileConfiguration config) {
    File file = new File(plugin.getDataFolder(), SETTINGS_FILE);
    if (!file.isFile()) return;
    YamlConfiguration net = YamlConfiguration.loadConfiguration(file);
    for (String key : net.getKeys(true)) {
      if (net.get(key) instanceof ConfigurationSection) continue;
      config.set(key, net.get(key));
    }
  }
}
