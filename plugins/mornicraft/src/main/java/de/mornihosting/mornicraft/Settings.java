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
    List<Group> groups) {

  record Command(String use, String text, boolean opOnly) {}

  record Group(String title, List<Command> commands) {}

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
        groups);
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
