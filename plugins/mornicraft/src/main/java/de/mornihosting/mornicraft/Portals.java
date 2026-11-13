package de.mornihosting.mornicraft;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Particle;
import org.bukkit.World;
import org.bukkit.block.data.BlockData;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

/**
 * Portals at the spawn island, built by the team with /nether and /end (and taken away again with "weg"):
 *
 * <ul>
 *   <li>Nether: a working portal on a blackstone square on the lawn in the north-west, with soul lanterns and fungi.
 *   <li>End: a little gatehouse on the lawn in the west; inside, stairs lead down into the island to a domed chamber
 *       under the plaza with a working end portal (all twelve eyes set).
 * </ul>
 *
 * <p>Positions are relative to the island's middle: MorniHosting puts the world spawn 9 blocks south of it, at
 * walking height. Before building, every block that changes is written down (plugins/MorniCraft/portals/), so "weg"
 * puts the island back exactly as it was. Blocks are set without physics, so nothing drops or flows away.
 */
final class Portals {
  enum Kind {
    NETHER,
    END;

    String id() {
      return name().toLowerCase(Locale.ROOT);
    }
  }

  /** The world spawn lies this far south of the island's middle (spawn.ts SPAWN_Z). */
  private static final int SPAWN_Z = 9;
  /** Blocks set per tick while building – it rises up instead of popping in. */
  private static final int PER_TICK = 40;
  private static final Sound NETHER_SOUND = Sound.sound(Key.key("block.portal.trigger"), Sound.Source.BLOCK, 0.6f, 1f);
  private static final Sound END_SOUND = Sound.sound(Key.key("block.end_portal.spawn"), Sound.Source.BLOCK, 0.8f, 1f);
  private static final Sound GONE = Sound.sound(Key.key("entity.enderman.teleport"), Sound.Source.BLOCK, 0.7f, 0.7f);

  private final MorniCraft plugin;
  private final Path dir;
  private final Set<Kind> busy = ConcurrentHashMap.newKeySet();

  Portals(MorniCraft plugin) {
    this.plugin = plugin;
    this.dir = plugin.getDataFolder().toPath().resolve("portals");
  }

  private Ui ui() {
    return plugin.ui();
  }

  /** /nether [weg] and /end [weg] – only the team (permission in plugin.yml). */
  boolean command(CommandSender sender, Kind kind, String[] args) {
    if (busy.contains(kind)) {
      sender.sendMessage(ui().fail("portal.busy"));
      return true;
    }
    boolean remove = args.length > 0 && List.of("weg", "entfernen", "remove", "off", "aus").contains(args[0].toLowerCase(Locale.ROOT));
    if (remove) {
      if (!built(kind)) {
        sender.sendMessage(ui().fail("portal." + kind.id() + ".none"));
        return true;
      }
      restore(kind);
      announce("portal." + kind.id() + ".removed", GONE);
      return true;
    }
    boolean again = built(kind);
    Map<Long, Block> plan = kind == Kind.NETHER ? nether() : end();
    if (!again && !remember(kind, plan)) {
      sender.sendMessage(ui().fail("portal.error"));
      return true;
    }
    build(kind, plan, again);
    return true;
  }

  boolean built(Kind kind) {
    return Files.exists(file(kind));
  }

  private Path file(Kind kind) {
    return dir.resolve(kind.id() + ".txt");
  }

  // ---- building -------------------------------------------------------------------------------------------------

  /** One block of a plan, at absolute coordinates. */
  record Block(int x, int y, int z, String data) {}

  /** A plan: later blocks at the same spot win, so a structure can be filled solid first and hollowed out after. */
  static final class Plan {
    final Map<Long, Block> blocks = new LinkedHashMap<>();
    final int ox;
    final int oy;
    final int oz;

    Plan(int ox, int oy, int oz) {
      this.ox = ox;
      this.oy = oy;
      this.oz = oz;
    }

    void set(int x, int y, int z, String data) {
      int ax = ox + x;
      int ay = oy + y;
      int az = oz + z;
      long key = ((long) ax & 0x3FFFFFF) << 38 | ((long) az & 0x3FFFFFF) << 12 | ((long) ay & 0xFFF);
      blocks.remove(key);
      blocks.put(key, new Block(ax, ay, az, data));
    }

    void fill(int x1, int y1, int z1, int x2, int y2, int z2, String data) {
      for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (int y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) set(x, y, z, data);
        }
      }
    }
  }

  /** The island's middle at walking height (y 0 = standing on the lawn, the lawn itself is y -1). */
  private static Plan plan() {
    Location s = SpawnArea.world().getSpawnLocation();
    return new Plan(s.getBlockX(), s.getBlockY(), s.getBlockZ() - SPAWN_Z);
  }

  private static final String AIR = "air";

  /** Nether: on the lawn in the north-west, between the pavilion and the north path. */
  static Map<Long, Block> nether() {
    return nether(plan());
  }

  static Map<Long, Block> nether(Plan p) {
    // Clear the flowers above the square and the little path.
    p.fill(-15, 0, -26, -6, 7, -20, AIR);
    p.fill(-5, 0, -24, -3, 1, -22, AIR);
    // The square: polished blackstone bricks with a smooth rim, some cracked.
    p.fill(-15, -1, -26, -6, -1, -20, "polished_blackstone_bricks");
    p.fill(-15, -1, -26, -6, -1, -26, "polished_blackstone");
    p.fill(-15, -1, -20, -6, -1, -20, "polished_blackstone");
    p.fill(-15, -1, -26, -15, -1, -20, "polished_blackstone");
    p.fill(-6, -1, -26, -6, -1, -20, "polished_blackstone");
    for (int[] c : new int[][] {{-13, -25}, {-8, -21}, {-11, -21}, {-9, -25}, {-14, -22}}) {
      p.set(c[0], -1, c[1], "cracked_polished_blackstone_bricks");
    }
    // The path over to the north path.
    p.fill(-5, -1, -24, -3, -1, -22, "polished_blackstone_bricks");
    p.fill(-5, -1, -24, -3, -1, -24, "polished_blackstone");
    p.fill(-5, -1, -22, -3, -1, -22, "polished_blackstone");
    // Nether corners: nylium with fungi and roots.
    p.set(-14, -1, -25, "crimson_nylium");
    p.set(-14, 0, -25, "crimson_fungus");
    p.set(-14, -1, -21, "crimson_nylium");
    p.set(-14, 0, -21, "crimson_roots");
    p.set(-7, -1, -21, "warped_nylium");
    p.set(-7, 0, -21, "warped_fungus");
    p.set(-7, -1, -25, "warped_nylium");
    p.set(-7, 0, -25, "warped_roots");
    // Lantern posts at the corners.
    for (int[] c : new int[][] {{-15, -26}, {-15, -20}, {-6, -26}, {-6, -20}}) {
      p.fill(c[0], 0, c[1], c[0], 1, c[1], "polished_blackstone_wall");
      p.set(c[0], 2, c[1], "soul_lantern");
    }
    // The frame faces the north path: obsidian, the corners (not needed for the portal) crying.
    p.fill(-12, 0, -25, -12, 6, -21, "obsidian");
    for (int[] c : new int[][] {{0, -25}, {0, -21}, {6, -25}, {6, -21}}) p.set(-12, c[0], c[1], "crying_obsidian");
    // Pillars beside it with gilded feet and soul lanterns, a crown of slabs on top.
    for (int z : new int[] {-26, -20}) {
      p.set(-12, 0, z, "gilded_blackstone");
      p.fill(-12, 1, z, -12, 4, z, "polished_blackstone_wall");
      p.set(-12, 5, z, "soul_lantern");
    }
    p.fill(-12, 7, -24, -12, 7, -22, "polished_blackstone_brick_slab[type=bottom]");
    p.set(-12, 7, -25, "blackstone_slab[type=bottom]");
    p.set(-12, 7, -21, "blackstone_slab[type=bottom]");
    // A step up on both sides.
    p.fill(-11, 0, -24, -11, 0, -22, "polished_blackstone_brick_stairs[facing=west]");
    p.fill(-13, 0, -24, -13, 0, -22, "polished_blackstone_brick_stairs[facing=east]");
    // The portal itself last.
    p.fill(-12, 1, -24, -12, 5, -22, "nether_portal[axis=z]");
    return p.blocks;
  }

  private static final String WALL = "end_stone_bricks";
  /** End: chamber middle (relative x/z), floor height and size. */
  private static final int CX = 0;
  private static final int CZ = -6;
  private static final int FLOOR = -15;
  private static final double ROOM = 8.5;
  private static final double SHELL = 10.6;
  /** Stairs: from the landing (x -22) down to the chamber (x -9), the passage is z -7 … -5. */
  private static final int STAIR_TOP = -22;
  private static final int STAIR_BOTTOM = -9;
  private static final int HOUSE_EAST = -16;

  /** Air up to this height above the chamber floor at distance r from its middle (a dome, 7 high in the middle). */
  private static int dome(double r) {
    return FLOOR + 1 + (int) Math.round(6 * Math.sqrt(Math.max(0, 1 - (r / ROOM) * (r / ROOM))));
  }

  static Map<Long, Block> end() {
    return end(plan());
  }

  static Map<Long, Block> end(Plan p) {
    // 1. The chamber under the plaza: a solid shell first, then the dome hollowed out.
    for (int dx = -11; dx <= 11; dx++) {
      for (int dz = -11; dz <= 11; dz++) {
        double r = Math.hypot(dx, dz);
        int x = CX + dx;
        int z = CZ + dz;
        if (r > SHELL) continue;
        if (r >= ROOM) {
          p.fill(x, FLOOR - 1, z, x, dome(8) + 2, z, WALL);
          continue;
        }
        int top = dome(r);
        p.set(x, FLOOR - 1, z, WALL);
        String floor = r >= 3.5 && r < 4.5 ? "purpur_block" : r >= 7 ? WALL : "end_stone";
        p.set(x, FLOOR, z, floor);
        p.fill(x, FLOOR + 1, z, x, top, z, AIR);
        p.set(x, top + 1, z, WALL);
      }
    }
    // Pillars round the room, chorus flowers, lights.
    for (int[] c : new int[][] {{5, 5}, {5, -5}, {-5, 5}, {-5, -5}}) {
      p.fill(CX + c[0], FLOOR + 1, CZ + c[1], CX + c[0], dome(Math.hypot(c[0], c[1])), CZ + c[1], "purpur_pillar");
    }
    for (int[] c : new int[][] {{3, 3}, {3, -3}, {-3, 3}, {-3, -3}}) p.set(CX + c[0], FLOOR + 1, CZ + c[1], "end_rod[facing=up]");
    for (int[] c : new int[][] {{4, 6}, {4, -6}, {-4, 6}, {-4, -6}}) p.set(CX + c[0], FLOOR + 1, CZ + c[1], "chorus_flower[age=5]");
    p.set(CX, dome(0), CZ, "end_rod[facing=down]");
    // A purpur step round the portal and end rods hanging from the dome.
    for (int dx = -3; dx <= 3; dx++) {
      for (int dz = -3; dz <= 3; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) == 3 && Math.abs(dx) + Math.abs(dz) < 6) {
          p.set(CX + dx, FLOOR + 1, CZ + dz, "purpur_slab[type=bottom]");
        }
      }
    }
    for (int[] c : new int[][] {{4, 0}, {-4, 0}, {0, 4}, {0, -4}}) {
      p.set(CX + c[0], dome(4), CZ + c[1], "end_rod[facing=down]");
    }
    // A dragon head on a pillar, looking at the portal from the far side.
    p.set(CX + 6, FLOOR + 1, CZ, "purpur_pillar");
    p.set(CX + 6, FLOOR + 2, CZ, "dragon_head[rotation=4]");

    // 2. The portal: twelve frames with eyes round three by three portal blocks.
    int y = FLOOR + 1;
    for (int d = -1; d <= 1; d++) {
      p.set(CX + d, y, CZ - 2, "end_portal_frame[facing=south,eye=true]");
      p.set(CX + d, y, CZ + 2, "end_portal_frame[facing=north,eye=true]");
      p.set(CX - 2, y, CZ + d, "end_portal_frame[facing=east,eye=true]");
      p.set(CX + 2, y, CZ + d, "end_portal_frame[facing=west,eye=true]");
    }

    // 3. The gatehouse on the lawn in the west: end stone bricks, purpur corners and roof, a door to the west path.
    p.fill(-26, -1, -8, HOUSE_EAST, 4, -4, WALL);
    p.fill(-25, 0, -7, HOUSE_EAST - 1, 4, -5, AIR);
    for (int[] c : new int[][] {{-26, -8}, {-26, -4}, {HOUSE_EAST, -8}, {HOUSE_EAST, -4}}) {
      p.fill(c[0], 0, c[1], c[0], 5, c[1], "purpur_pillar");
      p.set(c[0], 6, c[1], "end_rod[facing=up]");
    }
    p.fill(-26, 5, -8, HOUSE_EAST, 5, -4, "purpur_block");
    p.fill(-25, 6, -7, HOUSE_EAST - 1, 6, -5, "purpur_slab[type=bottom]");
    p.fill(-24, 0, -4, -23, 2, -4, AIR);
    p.fill(-25, 3, -4, -22, 3, -4, "purpur_pillar[axis=x]");
    p.set(-25, 2, -3, "end_rod[facing=south]");
    p.set(-22, 2, -3, "end_rod[facing=south]");
    for (int x : new int[] {-22, -19}) p.fill(x, 1, -8, x, 2, -8, "purple_stained_glass_pane[east=true,west=true]");
    p.fill(-26, 1, -6, -26, 2, -6, "purple_stained_glass_pane[north=true,south=true]");
    p.set(-25, 3, -6, "end_rod[facing=east]");
    // A little beacon on the roof: obsidian, purple glass and a light – to be seen from afar.
    p.set(-21, 6, -6, "obsidian");
    p.set(-21, 7, -6, "purple_stained_glass");
    p.set(-21, 8, -6, "end_rod[facing=up]");

    // 4. The stairs down: one block down per step, walls with purpur pillars and end rods.
    for (int x = STAIR_TOP; x <= STAIR_BOTTOM; x++) {
      int s = -2 - (x - STAIR_TOP);
      int top = x < HOUSE_EAST ? 4 : s + 5;
      p.fill(x, s - 2, -7, x, s - 1, -5, WALL);
      p.fill(x, s, -7, x, s, -5, "end_stone_brick_stairs[facing=west]");
      p.fill(x, s + 1, -7, x, top, -5, AIR);
      String side = (x - STAIR_TOP) % 4 == 2 ? "purpur_pillar" : WALL;
      p.fill(x, s - 1, -8, x, top, -8, side);
      p.fill(x, s - 1, -4, x, top, -4, side);
      if (x >= HOUSE_EAST) p.fill(x, s + 6, -8, x, s + 6, -4, WALL);
      if ((x - STAIR_TOP) % 4 == 0) {
        p.set(x, s + 4, -7, "end_rod[facing=south]");
        p.set(x, s + 4, -5, "end_rod[facing=north]");
      }
    }
    // 5. Where the stairs meet the chamber: an opening with a purpur arch.
    p.fill(STAIR_BOTTOM + 1, FLOOR + 1, -7, STAIR_BOTTOM + 1, FLOOR + 4, -5, AIR);
    p.fill(STAIR_BOTTOM + 1, FLOOR, -7, STAIR_BOTTOM + 1, FLOOR, -5, WALL);
    p.fill(STAIR_BOTTOM + 1, FLOOR + 1, -8, STAIR_BOTTOM + 1, FLOOR + 4, -8, "purpur_pillar");
    p.fill(STAIR_BOTTOM + 1, FLOOR + 1, -4, STAIR_BOTTOM + 1, FLOOR + 4, -4, "purpur_pillar");
    p.fill(STAIR_BOTTOM + 1, FLOOR + 5, -8, STAIR_BOTTOM + 1, FLOOR + 5, -4, "purpur_block");

    // 6. The portal blocks themselves last.
    p.fill(CX - 1, y, CZ - 1, CX + 1, y, CZ + 1, "end_portal");
    return p.blocks;
  }

  /** Writes down what is there now, so "weg" can put it back. */
  private boolean remember(Kind kind, Map<Long, Block> plan) {
    World w = SpawnArea.world();
    StringBuilder out = new StringBuilder(w.getName()).append('\n');
    for (Block b : plan.values()) {
      out.append(b.x()).append(' ').append(b.y()).append(' ').append(b.z()).append(' ')
          .append(w.getBlockAt(b.x(), b.y(), b.z()).getBlockData().getAsString()).append('\n');
    }
    try {
      Files.createDirectories(dir);
      Path tmp = dir.resolve(kind.id() + ".tmp");
      Files.writeString(tmp, out, StandardCharsets.UTF_8);
      Files.move(tmp, file(kind), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      return true;
    } catch (IOException e) {
      plugin.getLogger().log(Level.WARNING, "Could not save what was there before the portal", e);
      return false;
    }
  }

  /** Block data by name; a block the server doesn't know (older version) is left out. */
  private BlockData data(String name) {
    try {
      return Bukkit.createBlockData(name.contains(":") ? name : "minecraft:" + name);
    } catch (IllegalArgumentException unknown) {
      return null;
    }
  }

  /** Sets the plan bit by bit, from the bottom up; the portal blocks come last. */
  private void build(Kind kind, Map<Long, Block> plan, boolean again) {
    World w = SpawnArea.world();
    List<Block> order = new ArrayList<>(plan.values());
    boolean isEnd = kind == Kind.END;
    order.sort(Comparator.comparingInt((Block b) -> b.data().startsWith("nether_portal") || b.data().equals("end_portal") ? 1 : 0)
        .thenComparingInt(b -> isEnd ? depthOrder(b) : b.y()));
    busy.add(kind);
    int[] at = {0};
    Bukkit.getScheduler().runTaskTimer(plugin, task -> {
      int end = Math.min(order.size(), at[0] + PER_TICK);
      for (int i = at[0]; i < end; i++) {
        Block b = order.get(i);
        BlockData d = data(b.data());
        if (d != null) w.getBlockAt(b.x(), b.y(), b.z()).setBlockData(d, false);
        if (i % 9 == 0 && !b.data().equals(AIR)) sparkle(w, b, isEnd);
      }
      at[0] = end;
      if (end >= order.size()) {
        task.cancel();
        busy.remove(kind);
        announce("portal." + kind.id() + (again ? ".repaired" : ".built"), isEnd ? END_SOUND : NETHER_SOUND);
      }
    }, 1L, 1L);
  }

  /** End: the gatehouse first, then down the stairs, the chamber last (from the outside in). */
  private int depthOrder(Block b) {
    Location s = SpawnArea.world().getSpawnLocation();
    int rx = b.x() - s.getBlockX();
    int rz = b.z() - (s.getBlockZ() - SPAWN_Z);
    if (rx <= STAIR_BOTTOM) return rx + 40;
    double r = Math.hypot(rx - CX, rz - CZ);
    return 100 - (int) Math.round(r * 4);
  }

  private static void sparkle(World w, Block b, boolean end) {
    String name = end ? "REVERSE_PORTAL" : "PORTAL";
    try {
      w.spawnParticle(Particle.valueOf(name), b.x() + 0.5, b.y() + 0.5, b.z() + 0.5, 6, 0.3, 0.3, 0.3, 0.05);
    } catch (IllegalArgumentException | NoSuchFieldError unknown) {
      // Older server without this particle: just build.
    }
  }

  /** Puts back what was there before. */
  private void restore(Kind kind) {
    List<String> lines;
    try {
      lines = Files.readAllLines(file(kind), StandardCharsets.UTF_8);
    } catch (IOException e) {
      plugin.getLogger().log(Level.WARNING, "Could not read what was there before the portal", e);
      return;
    }
    if (lines.isEmpty()) return;
    World w = Bukkit.getWorld(lines.get(0));
    if (w == null) w = SpawnArea.world();
    // Portal blocks first, so nothing tries to keep a half portal alive.
    List<String[]> rows = new ArrayList<>();
    for (String line : lines.subList(1, lines.size())) {
      String[] parts = line.split(" ", 4);
      if (parts.length == 4) rows.add(parts);
    }
    for (String[] r : rows) {
      BlockData d = data(r[3]);
      if (d == null) d = data(AIR);
      w.getBlockAt(Integer.parseInt(r[0]), Integer.parseInt(r[1]), Integer.parseInt(r[2])).setBlockData(d, false);
    }
    try {
      Files.deleteIfExists(file(kind));
    } catch (IOException e) {
      plugin.getLogger().log(Level.WARNING, "Could not delete " + file(kind), e);
    }
  }

  /** Everyone online hears and reads it. */
  private void announce(String key, Sound sound) {
    for (Player p : Bukkit.getOnlinePlayers()) {
      p.sendMessage(ui().note(key.startsWith("portal.end") ? "◈" : "◆", key.startsWith("portal.end") ? Ui.MAIL : Ui.BAD, key));
      p.playSound(sound);
    }
  }
}
