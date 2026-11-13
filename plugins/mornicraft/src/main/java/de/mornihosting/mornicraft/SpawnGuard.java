package de.mornihosting.mornicraft;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.bukkit.NamespacedKey;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Directional;
import org.bukkit.entity.AreaEffectCloud;
import org.bukkit.entity.EnderDragon;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Flying;
import org.bukkit.entity.Hoglin;
import org.bukkit.entity.Mob;
import org.bukkit.entity.Monster;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.entity.Shulker;
import org.bukkit.entity.Slime;
import org.bukkit.entity.TNTPrimed;
import org.bukkit.entity.Tameable;
import org.bukkit.event.Cancellable;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockDispenseEvent;
import org.bukkit.event.block.BlockFertilizeEvent;
import org.bukkit.event.block.EntityBlockFormEvent;
import org.bukkit.event.block.SignChangeEvent;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.entity.EntityPlaceEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.block.BlockFromToEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPistonExtendEvent;
import org.bukkit.event.block.BlockPistonRetractEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.BlockSpreadEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.hanging.HangingBreakByEntityEvent;
import org.bukkit.event.hanging.HangingPlaceEvent;
import org.bukkit.event.player.PlayerArmorStandManipulateEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.persistence.PersistentDataType;

/**
 * The spawn island stays as it is: nobody but operators builds or breaks there, no explosions, fire or flowing
 * liquids reach it, nobody fights there, and nobody sleeps there (no bed respawn on the spawn island). No animals or
 * monsters spawn there either (wandering traders and their llamas, phantoms, animals, fish …).
 */
final class SpawnGuard implements Listener {
  /** At most one "can't do that" note per player per this many milliseconds. */
  private static final long NOTE_EVERY_MS = 2000;

  /** The island's shadow on the ground reaches a bit beyond its edge (blocks). */
  private static final int SHADOW_MARGIN = 8;
  /** How far one drifts sideways while falling off the island (blocks). */
  private static final int FALL_DRIFT = 24;

  /** How often (in ticks) mobs that are on the spawn anyway are cleared away: every 10 seconds. */
  private static final long SWEEP_EVERY_TICKS = 200;

  /**
   * Spawn reasons that stay allowed on the spawn: an operator's /summon, other plugins (NPCs …) and a parrot jumping
   * off a player's shoulder. Names instead of the enum, so older and newer servers both work.
   */
  private static final Set<String> ALLOWED_SPAWNS = Set.of("COMMAND", "CUSTOM", "SHOULDER_ENTITY");

  private final MorniCraft plugin;
  private final Map<UUID, Long> lastNote = new HashMap<>();
  /** Marks mobs that were put on the spawn on purpose (see {@link #ALLOWED_SPAWNS}), so the sweep leaves them. */
  private final NamespacedKey wanted;

  SpawnGuard(MorniCraft plugin) {
    this.plugin = plugin;
    this.wanted = new NamespacedKey(plugin, "spawn_allowed");
    plugin.getServer().getScheduler().runTaskTimer(plugin, this::sweep, SWEEP_EVERY_TICKS, SWEEP_EVERY_TICKS);
  }

  /** Inside the protected spawn area – only while protection is on. */
  private boolean guarded(Location l) {
    Settings s = plugin.settings();
    return (s.spawnProtection() && (near(l) || SpawnArea.inZone(l, s.zones()))) || plugin.moderation().inCell(l);
  }

  /** Inside the spawn area at all (sleeping and fighting have their own switches). */
  private boolean near(Location l) {
    return SpawnArea.inside(l, plugin.settings().spawnRadius());
  }

  private boolean guarded(Block b) {
    return guarded(b.getLocation());
  }

  /** A player may not change the spawn: cancels and says why (now and then). */
  private void stop(Player p, Cancellable event, String key) {
    if (p != null && p.hasPermission("mornicraft.build") && !"spawn.nopvp".equals(key)) return;
    event.setCancelled(true);
    if (p == null) return;
    long now = System.currentTimeMillis();
    Long last = lastNote.get(p.getUniqueId());
    if (last != null && now - last < NOTE_EVERY_MS) return;
    lastNote.put(p.getUniqueId(), now);
    // In the jail cell it is the jail that stays as it is, not the spawn (Philip).
    String say = "spawn.protected".equals(key) && plugin.moderation().inCell(p.getLocation()) ? "jail.protected" : key;
    p.sendActionBar(plugin.ui().fail(say));
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBreak(BlockBreakEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPlace(BlockPlaceEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBucket(PlayerBucketEmptyEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBucketFill(PlayerBucketFillEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  /** Trampling farmland, taking flowers out of pots, stripping logs … – doors, buttons and signs stay usable. */
  @EventHandler(priority = EventPriority.LOW)
  public void onInteract(PlayerInteractEvent e) {
    Block b = e.getClickedBlock();
    if (b == null) return;
    // No sleeping (and no bed respawn point) at the spawn, for everyone – unless the admin allows it.
    if (e.getAction() == Action.RIGHT_CLICK_BLOCK && b.getType().name().endsWith("_BED")
        && !plugin.settings().sleepAtSpawn() && near(b.getLocation())) {
      e.setCancelled(true);
      e.getPlayer().sendActionBar(plugin.ui().fail("spawn.nosleep"));
      return;
    }
    if (!guarded(b)) return;
    if (e.getAction() == Action.PHYSICAL) {
      if (b.getType().name().equals("FARMLAND")) stop(e.getPlayer(), e, "spawn.protected");
      return;
    }
    if (e.getAction() != Action.RIGHT_CLICK_BLOCK) return;
    String type = b.getType().name();
    boolean changes = type.startsWith("POTTED_") || type.endsWith("_LOG") || type.endsWith("_WOOD")
        || type.equals("CAMPFIRE") || type.equals("COMPOSTER") || type.equals("FLOWER_POT")
        || type.equals("GRASS_BLOCK") || type.equals("DIRT") || type.endsWith("_CANDLE") || type.equals("CAKE")
        || type.equals("SWEET_BERRY_BUSH") || type.equals("CAVE_VINES") || type.equals("CAVE_VINES_PLANT")
        || type.equals("RESPAWN_ANCHOR") || type.equals("CANDLE") || type.endsWith("CANDLE_CAKE")
        || type.equals("SOUL_CAMPFIRE") || type.equals("COARSE_DIRT") || type.equals("ROOTED_DIRT")
        || type.contains("COPPER") || type.equals("PUMPKIN") || type.endsWith("_SIGN") || type.equals("LECTERN")
        || type.equals("CHISELED_BOOKSHELF") || type.equals("DECORATED_POT") || type.equals("BEEHIVE")
        || type.equals("BEE_NEST") || type.equals("JUKEBOX") || type.equals("MOSS_BLOCK");
    if (changes) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBed(PlayerBedEnterEvent e) {
    if (!plugin.settings().sleepAtSpawn() && near(e.getBed().getLocation())) {
      e.setCancelled(true);
      e.getPlayer().sendActionBar(plugin.ui().fail("spawn.nosleep"));
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onEntityInteract(PlayerInteractEntityEvent e) {
    String type = e.getRightClicked().getType().name();
    if ((type.contains("ITEM_FRAME") || type.equals("ARMOR_STAND")) && guarded(e.getRightClicked().getLocation())) {
      stop(e.getPlayer(), e, "spawn.protected");
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onArmorStand(PlayerArmorStandManipulateEvent e) {
    if (guarded(e.getRightClicked().getLocation())) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onHangingPlace(HangingPlaceEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onHangingBreak(HangingBreakByEntityEvent e) {
    if (!guarded(e.getEntity().getLocation())) return;
    Entity remover = e.getRemover();
    stop(remover instanceof Player p ? p : null, e, "spawn.protected");
  }

  /** Who is really behind a hit: the player, the archer, the owner of the wolf, whoever lit the TNT … */
  private static Player attackerOf(Entity damager) {
    if (damager instanceof Player p) return p;
    if (damager instanceof Projectile pr && pr.getShooter() instanceof Player p) return p;
    if (damager instanceof Tameable t && t.getOwner() instanceof Player p) return p;
    if (damager instanceof TNTPrimed tnt && tnt.getSource() instanceof Player p) return p;
    if (damager instanceof AreaEffectCloud cloud && cloud.getSource() instanceof Player p) return p;
    return null;
  }

  /** Monsters may always be fought, also those the game doesn't count as "Monster" (phantoms, slimes …). */
  private static boolean hostile(Entity e) {
    return e instanceof Monster || e instanceof Flying || e instanceof Slime || e instanceof Shulker
        || e instanceof Hoglin || e instanceof EnderDragon;
  }

  /**
   * No fighting on the spawn island: nobody hurts players there, and nobody standing there hurts players outside
   * (no shooting from the safe zone). Animals on the island are safe too; monsters are not.
   */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onDamage(EntityDamageByEntityEvent e) {
    Player attacker = attackerOf(e.getDamager());
    if (attacker == null) return;
    Entity victim = e.getEntity();
    if (victim instanceof Player) {
      if (victim.equals(attacker) || plugin.settings().pvpAtSpawn()) return;
      if (near(victim.getLocation()) || near(attacker.getLocation())) stop(attacker, e, "spawn.nopvp");
    } else if (guarded(victim.getLocation()) && !hostile(victim)) {
      stop(attacker, e, "spawn.protected");
    }
  }

  /** Nothing spawns on the spawn island or the small islands round it – no animals, no monsters, no traders. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onCreatureSpawn(CreatureSpawnEvent e) {
    if (!guarded(e.getLocation())) {
      // Under the island it is dark all day: no monsters spawn in its shadow down to the ground (animals still do).
      Settings s = plugin.settings();
      if (s.spawnProtection() && "NATURAL".equals(e.getSpawnReason().name()) && hostile(e.getEntity())
          && SpawnArea.below(e.getLocation(), s.spawnRadius(), s.zones(), SHADOW_MARGIN)) {
        e.setCancelled(true);
      }
      return;
    }
    if (ALLOWED_SPAWNS.contains(e.getSpawnReason().name())) {
      e.getEntity().getPersistentDataContainer().set(wanted, PersistentDataType.BYTE, (byte) 1);
    } else {
      e.setCancelled(true);
    }
  }

  /**
   * Clears away mobs that are on the spawn anyway: from before this rule, walked or flew in, or came with a trader.
   * Pets, named or leashed mobs, ridden mobs and those an operator put there stay.
   */
  void sweep() {
    if (!plugin.settings().spawnProtection()) return;
    for (Mob mob : SpawnArea.world().getEntitiesByClass(Mob.class)) {
      if (guarded(mob.getLocation()) && unwanted(mob)) mob.remove();
    }
  }

  private boolean unwanted(Mob mob) {
    if (mob.getPersistentDataContainer().has(wanted, PersistentDataType.BYTE)) return false;
    if (mob.customName() != null || mob.isLeashed() || mob.isInsideVehicle()) return false;
    if (mob instanceof Tameable t && t.isTamed()) return false;
    return mob.getPassengers().stream().noneMatch(p -> p instanceof Player);
  }

  /**
   * Falling off the spawn (or a small island) never hurts – also when landing far below, on the ground or on
   * something someone built there. The fall started up at the island: where the player is now plus how far they fell.
   */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onFall(org.bukkit.event.entity.EntityDamageEvent e) {
    if (e.getCause() != org.bukkit.event.entity.EntityDamageEvent.DamageCause.FALL || !(e.getEntity() instanceof Player p)) return;
    Settings s = plugin.settings();
    if (!s.spawnProtection()) return;
    Location l = p.getLocation();
    double from = l.getY() + p.getFallDistance();
    double island = SpawnArea.world().getSpawnLocation().getY() - SpawnArea.depth();
    if (from >= island && SpawnArea.below(l, s.spawnRadius(), s.zones(), FALL_DRIFT)) e.setCancelled(true);
  }

  /** Armor stands, boats, minecarts, end crystals … */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onEntityPlace(EntityPlaceEvent e) {
    if (guarded(e.getEntity().getLocation())) stop(e.getPlayer(), e, "spawn.protected");
  }

  /** Bone meal (moss and grass would spread over the island). */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onFertilize(BlockFertilizeEvent e) {
    if (guarded(e.getBlock()) || e.getBlocks().stream().anyMatch(st -> guarded(st.getLocation()))) {
      stop(e.getPlayer(), e, "spawn.protected");
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onSign(SignChangeEvent e) {
    if (guarded(e.getBlock())) stop(e.getPlayer(), e, "spawn.protected");
  }

  /** Frost walker boots don't freeze the fountain. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onFreeze(EntityBlockFormEvent e) {
    if (guarded(e.getBlock())) e.setCancelled(true);
  }

  /** A dispenser outside, facing in, doesn't pour, place or shoot anything onto the island. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onDispense(BlockDispenseEvent e) {
    Block b = e.getBlock();
    BlockData data = b.getBlockData();
    if (!(data instanceof Directional d) || guarded(b)) return;
    if (guarded(b.getRelative(d.getFacing()))) e.setCancelled(true);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    lastNote.remove(e.getPlayer().getUniqueId());
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onExplode(EntityExplodeEvent e) {
    e.blockList().removeIf(this::guarded);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBlockExplode(BlockExplodeEvent e) {
    e.blockList().removeIf(this::guarded);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onEntityChange(EntityChangeBlockEvent e) {
    // Endermen, ravagers, withers, falling sand from outside …; a player's own changes are handled above.
    if (!(e.getEntity() instanceof Player) && guarded(e.getBlock())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onBurn(BlockBurnEvent e) {
    if (guarded(e.getBlock())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onIgnite(BlockIgniteEvent e) {
    if (!guarded(e.getBlock())) return;
    if (e.getPlayer() != null) stop(e.getPlayer(), e, "spawn.protected");
    else e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onSpread(BlockSpreadEvent e) {
    if (guarded(e.getBlock()) && e.getNewState().getType().name().equals("FIRE")) e.setCancelled(true);
  }

  /** Water or lava poured outside does not flow onto the island. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onFlow(BlockFromToEvent e) {
    if (guarded(e.getToBlock()) && !guarded(e.getBlock())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPiston(BlockPistonExtendEvent e) {
    if (e.getBlocks().stream().anyMatch(b -> guarded(b) || guarded(b.getRelative(e.getDirection())))
        || guarded(e.getBlock().getRelative(e.getDirection()))) {
      e.setCancelled(true);
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPistonPull(BlockPistonRetractEvent e) {
    if (e.getBlocks().stream().anyMatch(this::guarded)) e.setCancelled(true);
  }
}
