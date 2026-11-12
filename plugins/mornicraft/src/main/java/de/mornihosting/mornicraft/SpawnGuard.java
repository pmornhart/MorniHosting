package de.mornihosting.mornicraft;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.Cancellable;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
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

/**
 * The spawn island stays as it is: nobody but operators builds or breaks there, no explosions, fire or flowing
 * liquids reach it, nobody fights there, and nobody sleeps there (no bed respawn on the spawn island).
 */
final class SpawnGuard implements Listener {
  /** At most one "can't do that" note per player per this many milliseconds. */
  private static final long NOTE_EVERY_MS = 2000;

  private final MorniCraft plugin;
  private final Map<UUID, Long> lastNote = new HashMap<>();

  SpawnGuard(MorniCraft plugin) {
    this.plugin = plugin;
  }

  /** Inside the protected spawn area – only while protection is on. */
  private boolean guarded(Location l) {
    return plugin.settings().spawnProtection() && near(l);
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
    p.sendActionBar(plugin.ui().fail(key));
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
        || type.equals("RESPAWN_ANCHOR");
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

  /** No fighting on the spawn island: players (also with arrows) can't hurt players or the animals there. */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onDamage(EntityDamageByEntityEvent e) {
    Player attacker = e.getDamager() instanceof Player p ? p
        : e.getDamager() instanceof Projectile pr && pr.getShooter() instanceof Player p2 ? p2 : null;
    if (attacker == null || !near(e.getEntity().getLocation())) return;
    if (e.getEntity() instanceof Player) {
      if (!plugin.settings().pvpAtSpawn()) stop(attacker, e, "spawn.nopvp");
    } else if (guarded(e.getEntity().getLocation()) && !(e.getEntity() instanceof org.bukkit.entity.Monster)) {
      stop(attacker, e, "spawn.protected");
    }
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
    if (e.getBlocks().stream().anyMatch(this::guarded)
        || guarded(e.getBlock().getRelative(e.getDirection()))) {
      e.setCancelled(true);
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onPistonPull(BlockPistonRetractEvent e) {
    if (e.getBlocks().stream().anyMatch(this::guarded)) e.setCancelled(true);
  }
}
