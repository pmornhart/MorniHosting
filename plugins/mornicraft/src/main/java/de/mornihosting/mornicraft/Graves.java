package de.mornihosting.mornicraft;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.Color;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Sound;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.Skull;
import org.bukkit.block.TileState;
import org.bukkit.block.data.Rotatable;
import org.bukkit.block.data.type.Slab;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockFromToEvent;
import org.bukkit.event.block.BlockPistonExtendEvent;
import org.bukkit.event.block.BlockPistonRetractEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerArmorStandManipulateEvent;
import org.bukkit.event.player.PlayerInteractAtEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.SkullMeta;

/**
 * Graves: whoever dies gets a little grave where they fell – a patch of dark earth, a headstone, their head on top
 * with crossed-out eyes, their name above. Everything they carried and the experience they dropped is in it, plus
 * their head as a keepsake. Right click (or hit) the grave: everything back, the grave is gone and the ground as it
 * was. Only the owner for the first minutes, then anyone; the team always. Nothing can break it in the meantime.
 */
final class Graves implements Listener {
  /** How far up and down a place for the grave is looked for. */
  private static final int SEARCH = 12;
  /** How far to the side, when right there is no place. */
  private static final int SIDE = 3;
  /** The eyes: "x x" in the default font, sitting on the head's face (see the game's text display and skull models). */
  private static final double FACE = 0.276;
  private static final double EYES_UP = 0.106;
  private static final double FACE_SHIFT = 0.0125;
  private static final TextColor EYE_COLOR = TextColor.color(0x000000);

  /** One grave. */
  private static final class Grave {
    String id;
    UUID owner;
    String ownerName;
    long created;
    int xp;
    List<ItemStack> items = new ArrayList<>();
    /** Every block the grave changed, with what was there before (block data as text). */
    final Map<String, String> blocks = new LinkedHashMap<>();
    final List<UUID> entities = new ArrayList<>();
    String world;
  }

  private final MorniCraft plugin;
  private final File file;
  private final Map<String, Grave> graves = new LinkedHashMap<>();
  /** Block position ("world;x;y;z") → grave id. */
  private final Map<String, String> byBlock = new HashMap<>();
  /** Name tag / eyes entity → grave id. */
  private final Map<UUID, String> byEntity = new HashMap<>();

  Graves(MorniCraft plugin) {
    this.plugin = plugin;
    this.file = new File(plugin.getDataFolder(), "graves.yml");
    load();
  }

  private Ui ui() {
    return plugin.ui();
  }

  private static String key(Block b) {
    return b.getWorld().getName() + ";" + b.getX() + ";" + b.getY() + ";" + b.getZ();
  }

  private static Block blockOf(String key) {
    String[] p = key.split(";");
    World w = Bukkit.getWorld(p[0]);
    return w == null ? null : w.getBlockAt(Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3]));
  }

  // ---------------------------------------------------------------- saving

  private void load() {
    if (!file.exists()) return;
    YamlConfiguration y = YamlConfiguration.loadConfiguration(file);
    for (String id : y.getKeys(false)) {
      ConfigurationSection s = y.getConfigurationSection(id);
      if (s == null) continue;
      Grave g = new Grave();
      g.id = id;
      try {
        g.owner = UUID.fromString(s.getString("owner", ""));
      } catch (IllegalArgumentException e) {
        continue;
      }
      g.ownerName = s.getString("name", "?");
      g.created = s.getLong("created");
      g.xp = s.getInt("xp");
      g.world = s.getString("world", "world");
      for (Object o : s.getList("items", List.of())) if (o instanceof ItemStack i) g.items.add(i);
      ConfigurationSection blocks = s.getConfigurationSection("blocks");
      if (blocks != null) for (String k : blocks.getKeys(false)) g.blocks.put(k.replace('_', ';'), blocks.getString(k));
      for (String e : s.getStringList("entities")) g.entities.add(UUID.fromString(e));
      index(g);
    }
  }

  private void save() {
    YamlConfiguration y = new YamlConfiguration();
    for (Grave g : graves.values()) {
      ConfigurationSection s = y.createSection(g.id);
      s.set("owner", g.owner.toString());
      s.set("name", g.ownerName);
      s.set("created", g.created);
      s.set("xp", g.xp);
      s.set("world", g.world);
      s.set("items", g.items);
      ConfigurationSection blocks = s.createSection("blocks");
      g.blocks.forEach((k, v) -> blocks.set(k.replace(';', '_'), v));
      s.set("entities", g.entities.stream().map(UUID::toString).toList());
    }
    try {
      y.save(file);
    } catch (IOException e) {
      plugin.getLogger().warning("Could not save graves.yml: " + e);
    }
  }

  private void index(Grave g) {
    graves.put(g.id, g);
    g.blocks.keySet().forEach(k -> byBlock.put(k, g.id));
    g.entities.forEach(e -> byEntity.put(e, g.id));
  }

  // ---------------------------------------------------------------- dying

  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onDeath(PlayerDeathEvent e) {
    if (!plugin.settings().graves() || e.getKeepInventory()) return;
    Player p = e.getEntity();
    List<ItemStack> items = new ArrayList<>(e.getDrops());
    items.add(headOf(p));
    Grave g = build(p, items, e.getDroppedExp());
    if (g == null) return; // no place anywhere near (the void): the items drop as usual
    e.getDrops().clear();
    e.setDroppedExp(0);
    Block at = blockOf(g.blocks.keySet().iterator().next());
    Component where = at == null || plugin.streamer().hides(p, Streamer.COORDS)
        ? ui().words("grave.made.hidden")
        : ui().words("grave.made", Ui.v("x", at.getX()), Ui.v("y", at.getY()), Ui.v("z", at.getZ()));
    // Told after the respawn screen, when the chat can be read again.
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (p.isOnline()) p.sendMessage(Component.text("☠ ", NamedTextColor.GRAY).append(where));
    }, 20L);
  }

  /** The player's head as an item: "Kopf von Morni". */
  private ItemStack headOf(Player p) {
    ItemStack head = new ItemStack(Material.PLAYER_HEAD);
    SkullMeta meta = (SkullMeta) head.getItemMeta();
    meta.setOwningPlayer(p);
    meta.displayName(Component.text(ui().flat("grave.head", Ui.v("name", p.getName())), NamedTextColor.YELLOW)
        .decoration(TextDecoration.ITALIC, false));
    head.setItemMeta(meta);
    return head;
  }

  /** Air, water, grass, flowers, snow – something the grave may stand in (put back afterwards). */
  private static boolean free(Block b) {
    Material m = b.getType();
    if (m.isAir() || m == Material.WATER || m == Material.SNOW) return true;
    return !m.isSolid() && !m.isInteractable() && m != Material.LAVA && !m.name().contains("PORTAL")
        && !(b.getState() instanceof TileState);
  }

  /** Solid, plain ground (no chest, no bedrock …) – the grave's earth goes there. */
  private static boolean ground(Block b) {
    Material m = b.getType();
    return m.isSolid() && m.isOccluding() && m != Material.BEDROCK && m != Material.BARRIER
        && !(b.getState() instanceof TileState);
  }

  /** A spot: ground with two free blocks above it. */
  private boolean spot(Block g) {
    return !byBlock.containsKey(key(g)) && ground(g) && free(g.getRelative(BlockFace.UP)) && free(g.getRelative(0, 2, 0));
  }

  private Block findGround(Location death) {
    World w = death.getWorld();
    int min = w.getMinHeight();
    int max = w.getMaxHeight() - 3;
    int bx = death.getBlockX();
    int bz = death.getBlockZ();
    int by = Math.max(min, Math.min(max, death.getBlockY()));
    for (int r = 0; r <= SIDE; r++) {
      for (int dx = -r; dx <= r; dx++) {
        for (int dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) != r) continue;
          for (int d = 0; d <= SEARCH; d++) {
            for (int sign : new int[] {-1, 1}) {
              int y = by - 1 + sign * d;
              if (y < min || y > max) continue;
              Block g = w.getBlockAt(bx + dx, y, bz + dz);
              if (spot(g)) return g;
            }
          }
        }
      }
    }
    return null;
  }

  private static final BlockFace[] SIDES = {BlockFace.SOUTH, BlockFace.WEST, BlockFace.NORTH, BlockFace.EAST};

  private static BlockFace facing(float yaw) {
    return SIDES[Math.floorMod(Math.round(yaw / 90f), 4)];
  }

  private static BlockFace left(BlockFace f) {
    return switch (f) {
      case SOUTH -> BlockFace.EAST;
      case WEST -> BlockFace.SOUTH;
      case NORTH -> BlockFace.WEST;
      default -> BlockFace.NORTH;
    };
  }

  private Grave build(Player p, List<ItemStack> items, int xp) {
    Block g0 = findGround(p.getLocation());
    if (g0 == null) return null;
    Grave g = new Grave();
    g.id = Long.toString(System.currentTimeMillis(), 36) + "-" + p.getUniqueId().toString().substring(0, 8);
    g.owner = p.getUniqueId();
    g.ownerName = p.getName();
    g.created = System.currentTimeMillis();
    g.xp = xp;
    g.items = items;
    g.world = g0.getWorld().getName();
    // The grave lies the way the player looked: headstone behind, feet in front.
    BlockFace foot = facing(p.getLocation().getYaw());
    Block stoneGround = g0.getRelative(foot.getOppositeFace());
    if (!spot(stoneGround)) {
      foot = foot.getOppositeFace();
      stoneGround = g0.getRelative(foot.getOppositeFace());
    }
    // The earth: the head end, and the foot end where there is ground at the same height.
    change(g, g0, Material.PODZOL);
    Block g1 = g0.getRelative(foot);
    if (spot(g1)) change(g, g1, Material.PODZOL);
    // A stone cross at the head end: made of small stone pieces (displays, 1.19.4+), else of stone-brick walls.
    if (spot(stoneGround)) {
      List<Entity> cross = cross(stoneGround.getRelative(BlockFace.UP).getLocation(), foot);
      if (!cross.isEmpty()) {
        cross.forEach(e -> g.entities.add(e.getUniqueId()));
        // The cross stands in that block: nothing else goes there, and clicking it opens the grave.
        change(g, stoneGround.getRelative(BlockFace.UP), Material.BARRIER);
      } else {
        Block post = stoneGround.getRelative(BlockFace.UP);
        change(g, post, Material.MOSSY_STONE_BRICK_WALL);
        change(g, post.getRelative(BlockFace.UP), Material.STONE_BRICK_WALL);
        if (free(post.getRelative(0, 2, 0))) change(g, post.getRelative(0, 2, 0), Material.STONE_BRICK_WALL);
        for (BlockFace side : new BlockFace[] {left(foot), left(foot).getOppositeFace()}) {
          Block arm = post.getRelative(BlockFace.UP).getRelative(side);
          if (free(arm)) change(g, arm, Material.STONE_BRICK_WALL);
        }
        // Walls connect only after a neighbour update: let them join up.
        g.blocks.keySet().forEach(k -> {
          Block b = blockOf(k);
          if (b != null && b.getType().name().endsWith("_WALL")) b.getState().update(true, true);
        });
      }
    }
    Block head = g0.getRelative(BlockFace.UP);
    // Minecraft 1.19.4+: the head lies half in the earth, a little crooked, only the face peeking out (displays).
    List<Entity> sunk = sunkHead(p, g0.getLocation().add(0.5, 1, 0.5), foot);
    if (!sunk.isEmpty()) {
      sunk.forEach(e -> g.entities.add(e.getUniqueId()));
      Entity area = clickArea(g0.getLocation().add(0.5, 1, 0.5), HEAD_AREA, HEAD_AREA_HEIGHT);
      if (area != null) g.entities.add(area.getUniqueId());
    } else {
      // Older servers: the head as a block on the earth, looking towards the foot, eyes crossed out where possible.
      change(g, head, Material.PLAYER_HEAD);
      if (head.getBlockData() instanceof Rotatable rot) {
        rot.setRotation(foot);
        head.setBlockData(rot, false);
      }
      if (head.getState() instanceof Skull skull) {
        skull.setOwningPlayer(p);
        skull.update(true, false);
      }
      // Bold "x x" is half a pixel wider on the right: the text sits that much to the left (seen from the front).
      BlockFace leftOfFace = left(foot).getOppositeFace();
      Location face = head.getLocation().add(0.5 + foot.getModX() * FACE + leftOfFace.getModX() * FACE_SHIFT, EYES_UP,
          0.5 + foot.getModZ() * FACE + leftOfFace.getModZ() * FACE_SHIFT);
      face.setYaw(yawOf(foot));
      Entity eyes = eyes(face);
      if (eyes != null) g.entities.add(eyes.getUniqueId());
    }
    Location tag = (spot(stoneGround) || g.blocks.containsKey(key(stoneGround.getRelative(BlockFace.UP)))
        ? stoneGround.getRelative(BlockFace.UP) : head).getLocation().add(0.5, 1.2, 0.5);
    g.entities.add(nameTag(tag, Component.text("☠ " + p.getName(), NamedTextColor.GRAY)).getUniqueId());
    index(g);
    save();
    p.getWorld().playSound(head.getLocation(), Sound.BLOCK_GRAVEL_PLACE, 1f, 0.8f);
    return g;
  }

  // ---------------------------------------------------------------- the stone cross (block displays, 1.19.4+)

  /** One stone piece: block, then where it sits in the cross's block (x across the grave, y up, z along). */
  private record Piece(Material block, float x0, float y0, float z0, float x1, float y1, float z1) {}

  /** A slim cross on a low mossy plinth, all in one block (0…1); x is across the grave. */
  private static final List<Piece> CROSS = List.of(
      new Piece(Material.MOSSY_STONE_BRICKS, 0.18f, 0f, 0.28f, 0.82f, 0.16f, 0.72f),
      new Piece(Material.POLISHED_ANDESITE, 0.39f, 0.16f, 0.39f, 0.61f, 1.45f, 0.61f),
      new Piece(Material.POLISHED_ANDESITE, 0.06f, 0.92f, 0.39f, 0.94f, 1.14f, 0.61f),
      new Piece(Material.MOSS_BLOCK, 0.36f, 0.16f, 0.36f, 0.64f, 0.22f, 0.64f));

  /** The cross and a click area round it (and the head), made of display entities; empty on older servers. */
  private List<Entity> cross(Location blockCorner, BlockFace foot) {
    List<Entity> made = new ArrayList<>();
    try {
      Class<? extends Entity> blockType = Class.forName("org.bukkit.entity.BlockDisplay").asSubclass(Entity.class);
      boolean alongX = foot == BlockFace.EAST || foot == BlockFace.WEST;
      for (Piece piece : CROSS) {
        Entity e = blockCorner.getWorld().spawn(blockCorner.clone(), blockType);
        made.add(e);
        blockType.getMethod("setBlock", org.bukkit.block.data.BlockData.class).invoke(e, piece.block().createBlockData());
        // "Across the grave" is x when the grave runs north–south, else z.
        float ax0 = alongX ? piece.z0() : piece.x0();
        float az0 = alongX ? piece.x0() : piece.z0();
        float sx = alongX ? piece.z1() - piece.z0() : piece.x1() - piece.x0();
        float sz = alongX ? piece.x1() - piece.x0() : piece.z1() - piece.z0();
        transformScaled(e, new float[] {ax0, piece.y0(), az0}, new float[] {sx, piece.y1() - piece.y0(), sz});
        e.setPersistent(true);
      }
      return made;
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      made.forEach(Entity::remove);
      return List.of();
    }
  }

  /** Display#setTransformation: moved and stretched, not turned. */
  private static void transformScaled(Entity e, float[] t, float[] scale) throws ReflectiveOperationException {
    Class<?> vec = Class.forName("org.joml.Vector3f");
    Class<?> quat = Class.forName("org.joml.Quaternionf");
    Class<?> tr = Class.forName("org.bukkit.util.Transformation");
    Object translation = vec.getConstructor(float.class, float.class, float.class).newInstance(t[0], t[1], t[2]);
    Object size = vec.getConstructor(float.class, float.class, float.class).newInstance(scale[0], scale[1], scale[2]);
    Object none = quat.getConstructor().newInstance();
    Object transformation = tr.getConstructor(vec, quat, vec, quat).newInstance(translation, none, size, quat.getConstructor().newInstance());
    e.getClass().getMethod("setTransformation", tr).invoke(e, transformation);
  }

  /** A click area (interaction entity, 1.19.4+) so the head on the earth opens the grave too. */
  private static Entity clickArea(Location at, float width, float height) {
    try {
      Class<? extends Entity> type = Class.forName("org.bukkit.entity.Interaction").asSubclass(Entity.class);
      Entity e = at.getWorld().spawn(at, type);
      type.getMethod("setInteractionWidth", float.class).invoke(e, width);
      type.getMethod("setInteractionHeight", float.class).invoke(e, height);
      e.setPersistent(true);
      return e;
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      return null;
    }
  }

  private static float yawOf(BlockFace f) {
    return switch (f) {
      case SOUTH -> 0f;
      case WEST -> 90f;
      case NORTH -> 180f;
      default -> -90f;
    };
  }

  private static void change(Grave g, Block b, Material m) {
    g.blocks.put(key(b), b.getBlockData().getAsString());
    b.setType(m, false);
  }

  private static Entity nameTag(Location at, Component name) {
    // Set up right after spawning (in the same tick, before anyone sees it); no Consumer – its type changed in Paper.
    ArmorStand a = at.getWorld().spawn(at, ArmorStand.class);
    a.setMarker(true);
    a.setInvisible(true);
    a.setGravity(false);
    a.setSmall(true);
    a.customName(name);
    a.setCustomNameVisible(true);
    a.setInvulnerable(true);
    a.setPersistent(true);
    return a;
  }

  // ---------------------------------------------------------------- the sunken head (displays, 1.19.4+)
  //
  // Geometry from the game (26.3 client): an item display draws a player head 0.5 big, centred on its position with the
  // top at the position, face towards local -z; a text display draws its text upwards from its position, readable from
  // local +z, 0.025 blocks per pixel. Both turn by their yaw, then by their transformation (around their position).
  // Everything below is worked out for a grave facing south (face towards +z), then each entity takes its yaw.

  private static final float HEAD_AREA = 0.7f;
  private static final float HEAD_AREA_HEIGHT = 0.45f;
  /** The head's centre above the earth's surface (half of it is in the ground). */
  private static final float CENTER_UP = 0.07f;
  /** Leaning to one side and looking up a bit (radians). */
  private static final float ROLL = (float) Math.toRadians(16);
  private static final float PITCH = (float) Math.toRadians(-24);
  private static final float HALF = 0.25f;
  /** The eyes' text from the head's centre (facing south): half a pixel left, 0.144 down, on the face. */
  private static final float[] EYES_FROM_CENTER = {(float) -FACE_SHIFT, (float) EYES_UP - HALF, (float) FACE};

  /** Rotation Rz(roll)·Rx(pitch) of a vector. */
  private static float[] turn(float[] v, float roll, float pitch) {
    double cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
    double y1 = v[1] * cx - v[2] * sx;
    double z1 = v[1] * sx + v[2] * cx;
    double x2 = v[0] * cz - y1 * sz;
    double y2 = v[0] * sz + y1 * cz;
    return new float[] {(float) x2, (float) y2, (float) z1};
  }

  /** The head (item display) and its crossed-out eyes (text display), sunk into the earth at the surface point. */
  private List<Entity> sunkHead(Player p, Location surface, BlockFace foot) {
    List<Entity> made = new ArrayList<>();
    try {
      Class<? extends Entity> itemType = Class.forName("org.bukkit.entity.ItemDisplay").asSubclass(Entity.class);
      Location at = surface.clone();
      at.setYaw(yawOf(foot) + 180f);
      Entity head = surface.getWorld().spawn(at, itemType);
      made.add(head);
      ItemStack item = new ItemStack(Material.PLAYER_HEAD);
      SkullMeta meta = (SkullMeta) item.getItemMeta();
      meta.setOwningPlayer(p);
      item.setItemMeta(meta);
      itemType.getMethod("setItemStack", ItemStack.class).invoke(head, item);
      head.setRotation(yawOf(foot) + 180f, 0);
      // Centre at CENTER_UP, turned about the centre; the display itself turned half round (its face is local -z).
      float[] centreTurned = turn(new float[] {0, -HALF, 0}, ROLL, PITCH);
      float[] t = {-(0 - centreTurned[0]), CENTER_UP - centreTurned[1], -(0 - centreTurned[2])};
      transform(head, t, -ROLL, -PITCH);
      head.setPersistent(true);
      Location eyesAt = surface.clone();
      eyesAt.setYaw(yawOf(foot));
      Entity eyes = eyes(eyesAt);
      if (eyes != null) {
        made.add(eyes);
        float[] e = turn(EYES_FROM_CENTER, ROLL, PITCH);
        transform(eyes, new float[] {e[0], CENTER_UP + e[1], e[2]}, ROLL, PITCH);
      }
      return made;
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      made.forEach(Entity::remove);
      return List.of();
    }
  }

  /** Display#setTransformation with a translation and the rotation Rz(roll)·Rx(pitch) (JOML via reflection). */
  private static void transform(Entity e, float[] t, float roll, float pitch) throws ReflectiveOperationException {
    Class<?> vec = Class.forName("org.joml.Vector3f");
    Class<?> quat = Class.forName("org.joml.Quaternionf");
    Class<?> tr = Class.forName("org.bukkit.util.Transformation");
    Object q = quat.getConstructor().newInstance();
    q = quat.getMethod("rotateZ", float.class).invoke(q, roll);
    q = quat.getMethod("rotateX", float.class).invoke(q, pitch);
    Object translation = vec.getConstructor(float.class, float.class, float.class).newInstance(t[0], t[1], t[2]);
    Object scale = vec.getConstructor(float.class, float.class, float.class).newInstance(1f, 1f, 1f);
    Object none = quat.getConstructor().newInstance();
    Object transformation = tr.getConstructor(vec, quat, vec, quat).newInstance(translation, q, scale, none);
    e.getClass().getMethod("setTransformation", tr).invoke(e, transformation);
  }

  /** "x x" on the head's face – a text display (Paper 1.19.4+); older servers: no eyes. */
  private static Entity eyes(Location at) {
    try {
      Class<? extends Entity> type = Class.forName("org.bukkit.entity.TextDisplay").asSubclass(Entity.class);
      Entity e = at.getWorld().spawn(at, type);
      // Bold x's (thicker), a plain space between: they sit right on the eyes of the skin.
      Component x = Component.text("x", EYE_COLOR).decoration(TextDecoration.BOLD, true);
      type.getMethod("text", Component.class).invoke(e, x.append(Component.text(" ").decoration(TextDecoration.BOLD, false)).append(x));
      @SuppressWarnings({"unchecked", "rawtypes"})
      Class<Enum> billboard = (Class<Enum>) Class.forName("org.bukkit.entity.Display$Billboard");
      @SuppressWarnings("unchecked")
      Object fixed = Enum.valueOf(billboard, "FIXED");
      type.getMethod("setBillboard", billboard).invoke(e, fixed);
      // Clear background (Color.fromARGB is newer than the API this is built against).
      Object clear = Color.class.getMethod("fromARGB", int.class, int.class, int.class, int.class).invoke(null, 0, 0, 0, 0);
      type.getMethod("setBackgroundColor", Color.class).invoke(e, clear);
      type.getMethod("setShadowed", boolean.class).invoke(e, false);
      e.setRotation(at.getYaw(), 0);
      e.setPersistent(true);
      return e;
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      return null;
    }
  }

  // ---------------------------------------------------------------- opening

  private boolean mayOpen(Player p, Grave g) {
    if (p.getUniqueId().equals(g.owner) || p.hasPermission(Moderation.PERMISSION)) return true;
    long open = plugin.settings().gravePrivateMinutes() * 60_000L;
    return System.currentTimeMillis() - g.created >= open;
  }

  private void open(Player p, Grave g) {
    if (!mayOpen(p, g)) {
      long left = plugin.settings().gravePrivateMinutes() * 60_000L - (System.currentTimeMillis() - g.created);
      p.sendActionBar(ui().fail("grave.private", Ui.v("name", g.ownerName), Ui.v("min", Math.max(1, (left + 59_999) / 60_000))));
      return;
    }
    graves.remove(g.id);
    g.blocks.keySet().forEach(byBlock::remove);
    g.entities.forEach(byEntity::remove);
    // Everything back: armour onto the body where it is free, the rest into the bag, what doesn't fit at the feet.
    PlayerInventory inv = p.getInventory();
    for (ItemStack item : g.items) {
      if (item == null || item.getType().isAir()) continue;
      if (!wear(inv, item)) inv.addItem(item).values().forEach(rest -> p.getWorld().dropItemNaturally(p.getLocation(), rest));
    }
    if (g.xp > 0) p.giveExp(g.xp);
    // The ground as it was (backwards, so the head goes before the earth below it).
    List<String> keys = new ArrayList<>(g.blocks.keySet());
    java.util.Collections.reverse(keys);
    for (String k : keys) {
      Block b = blockOf(k);
      if (b != null) b.setBlockData(Bukkit.createBlockData(g.blocks.get(k)), false);
    }
    for (UUID id : g.entities) {
      Entity e = Bukkit.getEntity(id);
      if (e != null) e.remove();
    }
    save();
    p.playSound(p.getLocation(), Sound.ENTITY_PLAYER_LEVELUP, 0.7f, 1.2f);
    if (p.getUniqueId().equals(g.owner)) {
      p.sendMessage(ui().ok("grave.back"));
    } else {
      p.sendMessage(ui().ok("grave.looted", Ui.v("name", g.ownerName)));
      Player owner = Bukkit.getPlayer(g.owner);
      if (owner != null) owner.sendMessage(ui().note("☠", Ui.SOFT, "grave.taken", Ui.v("name", p.getName())));
    }
  }

  private static boolean wear(PlayerInventory inv, ItemStack item) {
    String n = item.getType().name();
    if ((n.endsWith("_HELMET") || n.equals("TURTLE_HELMET")) && empty(inv.getHelmet())) inv.setHelmet(item);
    else if ((n.endsWith("_CHESTPLATE") || n.equals("ELYTRA")) && empty(inv.getChestplate())) inv.setChestplate(item);
    else if (n.endsWith("_LEGGINGS") && empty(inv.getLeggings())) inv.setLeggings(item);
    else if (n.endsWith("_BOOTS") && empty(inv.getBoots())) inv.setBoots(item);
    else return false;
    return true;
  }

  private static boolean empty(ItemStack i) {
    return i == null || i.getType().isAir();
  }

  private Grave at(Block b) {
    String id = b == null ? null : byBlock.get(key(b));
    return id == null ? null : graves.get(id);
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onClick(PlayerInteractEvent e) {
    if (e.getHand() != EquipmentSlot.HAND || e.getClickedBlock() == null) return;
    if (e.getAction() != Action.RIGHT_CLICK_BLOCK && e.getAction() != Action.LEFT_CLICK_BLOCK) return;
    Grave g = at(e.getClickedBlock());
    if (g == null) return;
    e.setCancelled(true);
    open(e.getPlayer(), g);
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onClickTag(PlayerInteractAtEntityEvent e) {
    String id = byEntity.get(e.getRightClicked().getUniqueId());
    if (id == null || e.getHand() != EquipmentSlot.HAND) return;
    e.setCancelled(true);
    Grave g = graves.get(id);
    if (g != null) open(e.getPlayer(), g);
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onStand(PlayerArmorStandManipulateEvent e) {
    if (byEntity.containsKey(e.getRightClicked().getUniqueId())) e.setCancelled(true);
  }

  /** Nothing breaks a grave – hitting it opens it (see above), the rest is stopped. */
  @EventHandler(priority = EventPriority.LOWEST)
  public void onBreak(BlockBreakEvent e) {
    Grave g = at(e.getBlock());
    if (g == null) return;
    e.setCancelled(true);
    open(e.getPlayer(), g);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onExplode(EntityExplodeEvent e) {
    e.blockList().removeIf(b -> at(b) != null);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBlockExplode(BlockExplodeEvent e) {
    e.blockList().removeIf(b -> at(b) != null);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onFlow(BlockFromToEvent e) {
    if (at(e.getToBlock()) != null) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPiston(BlockPistonExtendEvent e) {
    if (e.getBlocks().stream().anyMatch(b -> at(b) != null || at(b.getRelative(e.getDirection())) != null)
        || at(e.getBlock().getRelative(e.getDirection())) != null) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPistonPull(BlockPistonRetractEvent e) {
    if (e.getBlocks().stream().anyMatch(b -> at(b) != null)) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onChange(EntityChangeBlockEvent e) {
    if (at(e.getBlock()) != null) e.setCancelled(true);
  }

  /** For /mod: how many graves someone has lying around. */
  long countOf(UUID owner) {
    return graves.values().stream().filter(g -> g.owner.equals(owner)).count();
  }

  /** Hover text with where the graves are (or nothing). */
  Component list(UUID owner) {
    Component out = Component.empty();
    for (Grave g : graves.values()) {
      if (!g.owner.equals(owner)) continue;
      Block b = blockOf(g.blocks.keySet().iterator().next());
      if (b != null) out = out.append(Component.text(b.getX() + " / " + b.getY() + " / " + b.getZ() + "\n"));
    }
    return out;
  }
}
