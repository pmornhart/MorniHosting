package de.mornihosting.mornicraft;

import java.util.List;
import java.util.Map;
import org.bukkit.configuration.file.FileConfiguration;

/**
 * What MorniHosting wrote into config.yml (the admin sets it in the dashboard; see the panel's
 * craftattack/mornicraft.ts). Read again on "/mornicraft reload".
 */
record Settings(
    String language,
    String serverName,
    String timezone,
    boolean sidebar,
    boolean updateCheck,
    String link,
    int teleportDelay,
    int maxHomes,
    boolean spawnProtection,
    int spawnRadius,
    boolean sleepAtSpawn,
    boolean pvpAtSpawn,
    boolean elytra,
    int elytraRadius,
    boolean elytraBoost,
    boolean tpa,
    boolean back,
    boolean welcome,
    boolean tnt,
    boolean creeperDamage,
    boolean fireSpread,
    boolean endermanGrief,
    List<String> rules,
    List<Group> groups,
    List<Zone> zones,
    List<String> streamerHide,
    boolean sit,
    boolean graves,
    int gravePrivateMinutes,
    boolean tabStats,
    int combatSeconds,
    String teamLink,
    boolean spawnCommand,
    boolean homes,
    Map<String, Limit> limits,
    boolean clans,
    int clanMaxMembers,
    boolean hardDragon) {

  /** "uses" times per "hours" (0 uses = no limit), e.g. 3 per 24 hours. */
  record Limit(int uses, int hours) {}

  /** The commands that can have a limit ("home" counts the clan base too). */
  static final List<String> LIMITED = List.of("spawn", "home", "tpa", "back");

  /** A round spot outside the spawn circle that is protected like it: x/z relative to the world spawn. */
  record Zone(int x, int z, int radius) {}

  record Command(String use, String text, boolean opOnly) {}

  record Group(String title, List<Command> commands) {}

  private static final int MAX_COMBAT_SECONDS = 120;

  static Settings from(FileConfiguration c) {
    List<Group> configured = c.getMapList("groups").stream().map(Settings::group).toList();
    // Without MorniHosting nobody writes the list: then the built-in one, in the server's language.
    List<Group> groups = configured.isEmpty()
        ? DefaultCommands.groups("en".equalsIgnoreCase(c.getString("language", "de")))
        : configured;
    return new Settings(
        c.getString("language", "de"),
        c.getString("server-name", "MorniCraft"),
        c.getString("timezone", "Europe/Berlin"),
        c.getBoolean("sidebar", true),
        c.getBoolean("update-check", true),
        c.getString("link", ""),
        Math.max(0, c.getInt("teleport-delay", 5)),
        Math.max(1, c.getInt("max-homes", 5)),
        c.getBoolean("spawn-protection", true),
        Math.max(0, c.getInt("spawn-radius", 55)),
        c.getBoolean("sleep-at-spawn", false),
        c.getBoolean("pvp-at-spawn", false),
        c.getBoolean("elytra", true),
        Math.max(0, c.getInt("elytra-radius", 45)),
        c.getBoolean("elytra-boost", true),
        c.getBoolean("tpa", true),
        c.getBoolean("back", true),
        c.getBoolean("welcome", true),
        c.getBoolean("tnt", true),
        c.getBoolean("creeper-damage", true),
        c.getBoolean("fire-spread", true),
        c.getBoolean("enderman-grief", true),
        c.getStringList("rules"),
        groups,
        c.getMapList("zones").stream().map(Settings::zone).filter(z -> z.radius() > 0).toList(),
        // The server's own names (panel domain, server address …): hidden in streamer mode.
        c.getStringList("streamer.hide"),
        c.getBoolean("sit", true),
        c.getBoolean("graves", true),
        Math.max(0, c.getInt("grave-private-minutes", 0)),
        c.getBoolean("tab-stats", true),
        // Combat log: seconds "in combat" after a hit between players; 0 = off.
        Math.max(0, Math.min(MAX_COMBAT_SECONDS, c.getInt("combat-seconds", 15))),
        // The team dashboard (MorniHosting writes the address; empty = no dashboard).
        c.getString("team-link", ""),
        c.getBoolean("spawn-command", true),
        c.getBoolean("homes", true),
        limits(c),
        c.getBoolean("clans.enabled", true),
        Math.max(2, c.getInt("clans.max-members", 10)),
        // The mighty ender dragon: three times the health, harder hits, a brood of phantoms.
        c.getBoolean("hard-dragon", true));
  }

  private static Map<String, Limit> limits(FileConfiguration c) {
    Map<String, Limit> out = new java.util.HashMap<>();
    for (String cmd : LIMITED) {
      int uses = Math.max(0, c.getInt("limits." + cmd + ".uses", 0));
      int hours = Math.max(1, c.getInt("limits." + cmd + ".hours", 24));
      if (uses > 0) out.put(cmd, new Limit(uses, hours));
    }
    return Map.copyOf(out);
  }

  private static int number(Object o) {
    return o instanceof Number n ? n.intValue() : 0;
  }

  private static Zone zone(Map<?, ?> raw) {
    return new Zone(number(raw.get("x")), number(raw.get("z")), number(raw.get("r")));
  }

  private static Group group(Map<?, ?> raw) {
    Object items = raw.get("commands");
    List<Command> commands = items instanceof List<?> list
        ? list.stream()
            .filter(Map.class::isInstance)
            .map(Map.class::cast)
            .map(m -> new Command(
                String.valueOf(m.get("use")),
                String.valueOf(m.get("text")),
                Boolean.TRUE.equals(m.get("op"))))
            .toList()
        : List.of();
    return new Group(String.valueOf(raw.get("title")), commands);
  }
}
