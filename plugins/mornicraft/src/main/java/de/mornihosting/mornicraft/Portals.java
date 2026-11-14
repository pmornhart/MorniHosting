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
    if (again && builtLayout(kind) < layout(kind)) {
      // Built the old way: put the old one back first, then build it new.
      restore(kind);
      again = false;
    }
    Map<Long, Block> plan = kind == Kind.NETHER ? nether() : end();
    if (!again && !remember(kind, plan)) {
      sender.sendMessage(ui().fail("portal.error"));
      return true;
    }
    build(kind, plan, "portal." + kind.id() + (again ? ".repaired" : ".built"));
    return true;
  }

  /** Which version of a build is the current one (the nether portal moved onto the islet with 2). */
  private static int layout(Kind kind) {
    return kind == Kind.NETHER ? 2 : 1;
  }

  /** The version a built portal has (files without the line are version 1). */
  private int builtLayout(Kind kind) {
    try {
      for (String line : Files.readAllLines(file(kind), StandardCharsets.UTF_8)) {
        if (line.startsWith("#layout ")) return Integer.parseInt(line.substring("#layout ".length()).trim());
      }
    } catch (IOException | NumberFormatException e) {
      return 1;
    }
    return 1;
  }

  /** After an update: a portal built the old way is taken away and built again the new way (at the server start). */
  void migrate() {
    for (Kind kind : Kind.values()) {
      if (!built(kind) || builtLayout(kind) >= layout(kind)) continue;
      restore(kind);
      Map<Long, Block> plan = kind == Kind.NETHER ? nether() : end();
      if (remember(kind, plan)) build(kind, plan, "portal." + kind.id() + ".moved");
    }
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

  /** What stands at a spot now (relative to the island's middle): the block's name without "minecraft:". */
  interface Look {
    String at(int x, int y, int z);
  }

  private static Look world(Plan p) {
    World w = SpawnArea.world();
    return (x, y, z) -> w.getBlockAt(p.ox + x, p.oy + y, p.oz + z).getType().name().toLowerCase(Locale.ROOT);
  }

  /**
   * The small island in the west-north-west (spawn.ts ISLETS: middle -48/-22, its top block 13 below the lawn,
   * radius 4.6, eight layers tapering down). The nether takes it over; a bridge leads down to it.
   */
  private static final int ISLE_X = -48;
  private static final int ISLE_Z = -22;
  private static final int ISLE_TOP = -13;
  private static final double ISLE_R = 4.6;
  private static final int ISLE_LAYERS = 7;
  /** The bridge: from the island's edge (x -23) down to the islet's edge (x -43), three wide round z -22. */
  private static final int BRIDGE_FROM = -23;
  private static final int BRIDGE_TO = -43;

  private static int hash(int x, int y, int z) {
    return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & Integer.MAX_VALUE;
  }

  /** Ground the nether can take over (not plants, leaves, wood or anything built). */
  private static boolean ground(String b) {
    return b.endsWith("_ore") || List.of("grass_block", "moss_block", "dirt", "coarse_dirt", "rooted_dirt", "podzol",
        "stone", "andesite", "diorite", "granite", "tuff", "deepslate", "cobblestone", "cobbled_deepslate", "gravel",
        "calcite", "mossy_cobblestone", "polished_andesite", "dripstone_block", "mud", "clay").contains(b);
  }

  private static boolean empty(String b) {
    return b.equals("air") || b.equals("cave_air") || b.equals("void_air");
  }

  /** The walking height on the bridge at x: from 0 on the lawn down to the islet's (-12) at its last block. */
  private static int walk(int x) {
    int drop = -(ISLE_TOP + 1);
    return (int) -Math.round(drop * (double) (BRIDGE_FROM - x) / (BRIDGE_FROM - (BRIDGE_TO + 1)));
  }

  /** Nether: a gate in the hedge in the north-west, a bridge down to the islet, which the nether has taken over. */
  static Map<Long, Block> nether() {
    Plan p = plan();
    return nether(p, world(p));
  }

  static Map<Long, Block> nether(Plan p, Look look) {
    infectIslet(p, look);
    bridge(p, look);
    netherIsletDecor(p);
    return p.blocks;
  }

  /** The islet: nylium and netherrack on top, netherrack, blackstone and ores below, weeping vines underneath. */
  private static void infectIslet(Plan p, Look look) {
    int reach = (int) Math.ceil(ISLE_R) + 3;
    // Everything growing on it goes (the oak, flowers) – a huge fungus comes instead.
    for (int y = ISLE_TOP + 1; y <= ISLE_TOP + 10; y++) {
      for (int dx = -reach; dx <= reach; dx++) {
        for (int dz = -reach; dz <= reach; dz++) {
          if (Math.hypot(dx, dz) <= reach && !empty(look.at(ISLE_X + dx, y, ISLE_Z + dz))) {
            p.set(ISLE_X + dx, y, ISLE_Z + dz, AIR);
          }
        }
      }
    }
    for (int d = 0; d <= ISLE_LAYERS; d++) {
      double rr = Math.max(0.6, ISLE_R - d * (ISLE_R / ISLE_LAYERS));
      int y = ISLE_TOP - d;
      for (int dx = -reach; dx <= reach; dx++) {
        for (int dz = -reach; dz <= reach; dz++) {
          int x = ISLE_X + dx;
          int z = ISLE_Z + dz;
          double dist = Math.hypot(dx, dz);
          String now = look.at(x, y, z);
          boolean inside = dist <= rr;
          if (!(inside && (empty(now) || ground(now))) && !(dist <= rr + 1.5 && ground(now))) continue;
          int h = hash(x, y, z) % 12;
          String block;
          if (d == 0) {
            block = h < 7 ? "crimson_nylium" : h < 9 ? "warped_nylium" : "netherrack";
          } else if (d == 1) {
            block = h < 9 ? "netherrack" : "soul_soil";
          } else {
            block = h < 6 ? "netherrack" : h < 9 ? "blackstone" : h < 11 ? "nether_quartz_ore" : "nether_gold_ore";
          }
          p.set(x, y, z, block);
          // Plants on the nylium (not on the path or where the portal stands).
          if (d == 0 && block.endsWith("nylium") && hash(z, x, y) % 3 == 0 && !(dz >= -1 && dz <= 1 && dx >= 0)
              && dx != 0) {
            boolean crimson = block.startsWith("crimson");
            int k = hash(x, z, y) % 3;
            String plant = crimson ? (k == 0 ? "crimson_fungus" : "crimson_roots") : (k == 0 ? "warped_fungus" : "nether_sprouts");
            p.set(x, y + 1, z, plant);
          }
          // The underside: weeping vines and a bit of glowstone where this is the lowest block of its column.
          double below = Math.max(0.6, ISLE_R - (d + 1) * (ISLE_R / ISLE_LAYERS));
          boolean lowest = d == ISLE_LAYERS || dist > below;
          if (lowest && d > 0) {
            int v = hash(x, z, d) % 7;
            if (v == 0) {
              p.set(x, y, z, "glowstone");
            } else if (v <= 2) {
              int len = 1 + hash(z, d, x) % 3;
              for (int i = 1; i < len; i++) p.set(x, y - i, z, "weeping_vines_plant");
              p.set(x, y - len, z, "weeping_vines");
            }
          }
        }
      }
    }
  }

  /** The gate in the hedge and the bridge down to the islet: nether bricks, railings, soul lanterns. */
  private static void bridge(Plan p, Look look) {
    // A path through the hedge, from the lawn to the edge.
    p.fill(BRIDGE_FROM, 0, -24, -17, 3, -20, AIR);
    p.fill(BRIDGE_FROM, -1, -23, -17, -1, -21, "nether_bricks");
    p.fill(BRIDGE_FROM, -1, -24, -17, -1, -24, "red_nether_bricks");
    p.fill(BRIDGE_FROM, -1, -20, -17, -1, -20, "red_nether_bricks");
    // The gate: two pillars, a lintel, soul lanterns.
    int gx = -21;
    for (int z : new int[] {-24, -20}) {
      p.fill(gx, 0, z, gx, 3, z, "red_nether_bricks");
      p.set(gx, 5, z, "soul_lantern");
    }
    p.fill(gx, 4, -24, gx, 4, -20, "nether_bricks");
    p.set(gx, 3, -22, "soul_lantern[hanging=true]");
    // The nether eats into the lawn round the gate.
    for (int dx = -5; dx <= 5; dx++) {
      for (int dz = -5; dz <= 5; dz++) {
        int x = gx + 1 + dx;
        int z = -22 + dz;
        if (Math.hypot(dx, dz) > 5 || hash(x, -1, z) % 5 > 1) continue;
        if (!look.at(x, -1, z).equals("grass_block") || (z >= -24 && z <= -20 && x <= -17)) continue;
        String now = look.at(x, 0, z);
        if (!empty(now) && ground(now)) continue;
        p.set(x, -1, z, hash(x, 0, z) % 2 == 0 ? "crimson_nylium" : "netherrack");
        p.set(x, 0, z, hash(z, 0, x) % 3 == 0 ? "crimson_roots" : AIR);
      }
    }
    // The bridge itself: one block down every so often, stairs where it drops.
    for (int x = BRIDGE_FROM - 1; x > BRIDGE_TO; x--) {
      int w = walk(x);
      boolean step = w < walk(x + 1);
      int top = step ? w : w - 1;
      p.fill(x, w - 3, -24, x, w + 3, -20, AIR);
      p.fill(x, w - 2, -23, x, w - 1, -21, "nether_bricks");
      if (step) p.fill(x, w, -23, x, w, -21, "nether_brick_stairs[facing=east]");
      for (int z : new int[] {-24, -20}) {
        p.fill(x, w - 2, z, x, top, z, "red_nether_bricks");
        boolean post = (BRIDGE_FROM - x) % 5 == 0;
        p.set(x, top + 1, z, post ? "red_nether_brick_wall" : "nether_brick_fence[east=true,west=true]");
        if (post) p.set(x, top + 2, z, "soul_lantern");
      }
      if ((BRIDGE_FROM - x) % 6 == 3) p.set(x, w - 3, -22, "soul_lantern[hanging=true]");
    }
  }

  /** On the islet: a path to the portal, the portal facing the bridge, lantern posts and a huge crimson fungus. */
  private static void netherIsletDecor(Plan p) {
    int t = ISLE_TOP;
    p.fill(BRIDGE_TO, t, -23, ISLE_X + 1, t, -21, "nether_bricks");
    p.fill(BRIDGE_TO, t + 1, -23, ISLE_X + 1, t + 6, -21, AIR);
    for (int z : new int[] {-25, -19}) {
      p.set(-45, t + 1, z, "red_nether_brick_wall");
      p.set(-45, t + 2, z, "soul_lantern");
    }
    // The huge fungus behind the portal.
    int fx = ISLE_X - 3;
    int fz = ISLE_Z;
    p.fill(fx, t + 1, fz, fx, t + 4, fz, "crimson_stem");
    for (int dx = -1; dx <= 1; dx++) {
      for (int dz = -1; dz <= 1; dz++) {
        boolean corner = dx != 0 && dz != 0;
        p.set(fx + dx, t + 5, fz + dz, corner ? "shroomlight" : "nether_wart_block");
      }
    }
    p.set(fx, t + 6, fz, "nether_wart_block");
    p.set(fx - 1, t + 6, fz, "nether_wart_block");
    p.set(fx + 1, t + 6, fz, "nether_wart_block");
    p.set(fx, t + 6, fz - 1, "nether_wart_block");
    p.set(fx, t + 6, fz + 1, "nether_wart_block");
    p.set(fx - 1, t + 4, fz + 1, "weeping_vines");
    p.set(fx + 1, t + 4, fz - 1, "weeping_vines");
    // The portal: obsidian facing the bridge, the corners crying, the portal last.
    p.fill(ISLE_X, t, -24, ISLE_X, t + 5, -20, "obsidian");
    for (int[] c : new int[][] {{t, -24}, {t, -20}, {t + 5, -24}, {t + 5, -20}}) p.set(ISLE_X, c[0], c[1], "crying_obsidian");
    p.set(ISLE_X, t + 6, -24, "soul_lantern");
    p.set(ISLE_X, t + 6, -20, "soul_lantern");
    p.fill(ISLE_X, t + 1, -23, ISLE_X, t + 4, -21, "nether_portal[axis=z]");
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
    StringBuilder out = new StringBuilder(w.getName()).append('\n').append("#layout ").append(layout(kind)).append('\n');
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
  private void build(Kind kind, Map<Long, Block> plan, String message) {
    World w = SpawnArea.world();
    List<Block> order = new ArrayList<>(plan.values());
    boolean isEnd = kind == Kind.END;
    order.sort(Comparator.comparingInt((Block b) -> b.data().startsWith("nether_portal") || b.data().equals("end_portal") ? 1 : 0)
        .thenComparingInt(b -> isEnd ? depthOrder(b) : -b.x())
        .thenComparingInt(Block::y));
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
        announce(message, isEnd ? END_SOUND : NETHER_SOUND);
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
