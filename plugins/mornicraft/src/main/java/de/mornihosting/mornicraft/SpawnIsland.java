package de.mornihosting.mornicraft;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Biome;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Score;

/**
 * The spawn island, built by MorniCraft itself (in the MoinMorni network – MorniHosting builds it on its own):
 * once, on the first start, the island floats at y 170 over a deep ocean near the world's middle. The datapack
 * (repo folder datapack/MorniCraft-Spawn, packed into the jar) goes into the world with the island's real place, so
 * its one-time repairs of later versions run where the island stands. "spawn-island" in config.yml: network
 * (default: only in the network), on (also alone), off.
 *
 * <p>Built = the datapack's own score "#built" in "mh_craftattack" (also set by an island MorniHosting built) – it
 * is never built twice. Where it stands is kept in spawn.yml.
 */
final class SpawnIsland {
  static final int Y = 170;
  private static final String PACK = "MorniCraft-Spawn";
  private static final String IN_JAR = "spawnpack/" + PACK + "/";
  private static final String SCORES = "mh_craftattack";
  /** /locate finds an ocean's edge: this far further out, away from the world's middle (as MorniHosting does). */
  private static final int OCEAN_INSET = 96;
  /** The island reaches this far from its middle: these chunks are loaded while it is built. */
  private static final int REACH = 64;
  private static final int SEARCH_RADIUS = 6400;
  /** The datapack is written for the island at 0/0 – these spots name the area and the middle there. */
  private static final String ORIGIN_AREA = "-64 -64 64 64";
  private static final String ORIGIN_MIDDLE = "0 170 0";

  record Spot(int x, int z) {}

  private final MorniCraft plugin;
  private final File file;

  SpawnIsland(MorniCraft plugin) {
    this.plugin = plugin;
    this.file = new File(plugin.getDataFolder(), "spawn.yml");
  }

  /** Wanted here? */
  private boolean wanted() {
    String mode = Settings.mode(plugin.getConfig(), "spawn-island", "network");
    if ("off".equalsIgnoreCase(mode) || plugin.getConfig().getBoolean("managed-by-panel", false)) return false;
    return "on".equalsIgnoreCase(mode) || plugin.network() != null;
  }

  /** After the start (the worlds are there): build once, keep the datapack up to date. */
  void start() {
    if (!wanted()) return;
    World w = SpawnArea.world();
    Spot known = stored();
    if (built()) {
      // Already standing (built by us or by MorniHosting): only the datapack follows the plugin's version.
      if (known != null) install(w, known);
      return;
    }
    Spot spot = ocean(w);
    plugin.getLogger().info("Building the spawn island at x " + spot.x() + ", z " + spot.z() + " ...");
    install(w, spot);
    // The vanilla reload also takes up datapacks that are new in the folder.
    Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "minecraft:reload");
    // The chunks around it load in the background (the server keeps running), then the datapack builds.
    List<java.util.concurrent.CompletableFuture<Chunk>> loading = new ArrayList<>();
    for (int cx = (spot.x() - REACH) >> 4; cx <= (spot.x() + REACH) >> 4; cx++) {
      for (int cz = (spot.z() - REACH) >> 4; cz <= (spot.z() + REACH) >> 4; cz++) {
        loading.add(w.getChunkAtAsync(cx, cz));
      }
    }
    java.util.concurrent.CompletableFuture.allOf(loading.toArray(new java.util.concurrent.CompletableFuture[0]))
        .whenComplete((ok, err) -> Bukkit.getScheduler().runTask(plugin, () -> {
          List<Chunk> held = new ArrayList<>();
          for (java.util.concurrent.CompletableFuture<Chunk> f : loading) {
            Chunk c = f.getNow(null);
            if (c == null) continue;
            c.addPluginChunkTicket(plugin);
            held.add(c);
          }
          build(w, spot, held, 0);
        }));
  }

  private static final int BUILD_TRIES = 15;
  private static final long RETRY_TICKS = 40;

  /** Runs the datapack's "build" there – again a moment later while the reload isn't through yet. */
  private void build(World w, Spot spot, List<Chunk> held, int attempt) {
    String at = spot.x() + " " + Y + " " + spot.z();
    if (attempt > 0 || !built()) {
      Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "execute positioned " + at + " run function craftattack:build");
    }
    if (!built() && attempt < BUILD_TRIES) {
      Bukkit.getScheduler().runTaskLater(plugin, () -> build(w, spot, held, attempt + 1), RETRY_TICKS);
      return;
    }
    held.forEach(c -> c.removePluginChunkTicket(plugin));
    if (!built()) {
      plugin.getLogger().warning("Spawn island: the datapack did not run - see the log; next try at the next start");
      return;
    }
    store(spot);
    if (Bukkit.getPluginManager().isPluginEnabled("Chunky")) {
      Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "chunky center " + spot.x() + " " + spot.z());
    }
    plugin.getLogger().info("Spawn island built at x " + spot.x() + ", z " + spot.z());
  }

  /** The datapack's mark: the island stands. */
  static boolean built() {
    Objective o = Bukkit.getScoreboardManager().getMainScoreboard().getObjective(SCORES);
    if (o == null) return false;
    Score s = o.getScore("#built");
    return s.isScoreSet() && s.getScore() == 1;
  }

  private Spot stored() {
    if (!file.isFile()) return null;
    YamlConfiguration y = YamlConfiguration.loadConfiguration(file);
    return y.isSet("x") ? new Spot(y.getInt("x"), y.getInt("z")) : null;
  }

  private void store(Spot spot) {
    YamlConfiguration y = new YamlConfiguration();
    y.set("x", spot.x());
    y.set("z", spot.z());
    y.set("built-by", plugin.getDescription().getVersion());
    try {
      y.save(file);
    } catch (IOException e) {
      plugin.getLogger().warning("Could not save spawn.yml: " + e.getMessage());
    }
  }

  // ---------------------------------------------------------------- where: over a deep ocean

  /** The nearest deep ocean (else any ocean, else 0/0), a bit further out than its edge. */
  private Spot ocean(World w) {
    Location found = locate(w, "DEEP_OCEAN");
    if (found == null) found = locate(w, "OCEAN");
    if (found == null) {
      plugin.getLogger().info("No ocean found nearby – the spawn island floats over 0/0");
      return new Spot(0, 0);
    }
    double away = Math.hypot(found.getX(), found.getZ());
    if (away <= OCEAN_INSET) return new Spot(found.getBlockX(), found.getBlockZ());
    return new Spot((int) Math.round(found.getX() + found.getX() / away * OCEAN_INSET),
        (int) Math.round(found.getZ() + found.getZ() / away * OCEAN_INSET));
  }

  /** World#locateNearestBiome (Paper 1.19+; its result type changed over time) – null where it isn't there. */
  private Location locate(World w, String biome) {
    try {
      Biome b = (Biome) Biome.class.getField(biome).get(null);
      Biome[] wanted = (Biome[]) java.lang.reflect.Array.newInstance(Biome.class, 1);
      wanted[0] = b;
      Method m = World.class.getMethod("locateNearestBiome", Location.class, int.class, wanted.getClass());
      Object r = m.invoke(w, new Location(w, 0, 64, 0), SEARCH_RADIUS, wanted);
      if (r == null) return null;
      if (r instanceof Location l) return l;
      return (Location) r.getClass().getMethod("getLocation").invoke(r);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      return null;
    }
  }

  // ---------------------------------------------------------------- the datapack, at the island's place

  /** Copies the datapack from the jar into the world, its spots moved to where the island stands. */
  private void install(World w, Spot spot) {
    Path root = levelFolder(w).resolve("datapacks").resolve(PACK);
    String area = (spot.x() - REACH) + " " + (spot.z() - REACH) + " " + (spot.x() + REACH) + " " + (spot.z() + REACH);
    String middle = spot.x() + " " + Y + " " + spot.z();
    boolean newRules = newGameRules();
    try (JarFile jar = new JarFile(plugin.jarFile())) {
      Enumeration<JarEntry> entries = jar.entries();
      while (entries.hasMoreElements()) {
        JarEntry e = entries.nextElement();
        if (e.isDirectory() || !e.getName().startsWith(IN_JAR)) continue;
        String name = e.getName().substring(IN_JAR.length());
        // Only the game rule this version knows (the other one would put an error in the log at every start).
        if (name.endsWith((newRules ? "rules_old" : "rules_new") + ".mcfunction")) continue;
        String text;
        try (InputStream in = jar.getInputStream(e)) {
          text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        if (name.endsWith(".mcfunction")) text = text.replace(ORIGIN_AREA, area).replace(ORIGIN_MIDDLE, middle);
        if (name.endsWith("rules.json")) {
          text = "{\"values\":[{\"id\":\"craftattack:" + (newRules ? "rules_new" : "rules_old")
              + "\",\"required\":false}]}";
        }
        Path target = root.resolve(name);
        Files.createDirectories(target.getParent());
        Files.writeString(target, text, StandardCharsets.UTF_8);
      }
      for (String dir : new String[] {"function", "functions"}) {
        Files.deleteIfExists(root.resolve("data/craftattack/" + dir + "/" + (newRules ? "rules_old" : "rules_new") + ".mcfunction"));
      }
    } catch (IOException | RuntimeException e) {
      plugin.getLogger().warning("Could not put the spawn datapack into the world: " + e);
    }
  }

  /** The level's folder (with level.dat): the world's own folder up to 1.21, a parent of it on 26.x. */
  private static Path levelFolder(World w) {
    Path dir = w.getWorldFolder().toPath().toAbsolutePath();
    for (Path p = dir; p != null; p = p.getParent()) {
      if (Files.isRegularFile(p.resolve("level.dat"))) return p;
    }
    return dir;
  }

  /** "respawn_radius" since 1.21.11 (and 26.x), "spawnRadius" before. */
  private static boolean newGameRules() {
    String v;
    try {
      v = (String) Bukkit.class.getMethod("getMinecraftVersion").invoke(null);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
      v = Bukkit.getBukkitVersion().split("-")[0];
    }
    String[] p = v.split("\\.");
    try {
      int major = Integer.parseInt(p[0]);
      int minor = p.length > 1 ? Integer.parseInt(p[1]) : 0;
      int patch = p.length > 2 ? Integer.parseInt(p[2]) : 0;
      if (major != 1) return major > 1;
      return minor > 21 || (minor == 21 && patch >= 11);
    } catch (NumberFormatException e) {
      return true;
    }
  }
}
