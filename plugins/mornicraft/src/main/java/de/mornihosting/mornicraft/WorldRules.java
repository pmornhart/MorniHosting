package de.mornihosting.mornicraft;

import org.bukkit.entity.EntityType;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockSpreadEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.ExplosionPrimeEvent;

/**
 * Switches for the whole world, set in the dashboard: TNT, creepers breaking blocks, fire spreading, endermen
 * taking blocks. Off means: TNT fizzles (no damage, no holes), creepers still hurt but leave the ground whole,
 * fire stays where it was lit, endermen leave blocks alone.
 */
final class WorldRules implements Listener {
  private final MorniCraft plugin;

  WorldRules(MorniCraft plugin) {
    this.plugin = plugin;
  }

  private Settings s() {
    return plugin.settings();
  }

  private static boolean tnt(EntityType type) {
    String name = type.name();
    return name.equals("TNT") || name.equals("PRIMED_TNT") || name.equals("TNT_MINECART") || name.equals("MINECART_TNT");
  }

  /** TNT fizzles before it blows up – later would be too late, players would already be hurt. */
  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onPrime(ExplosionPrimeEvent e) {
    if (!s().tnt() && tnt(e.getEntityType())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onExplode(EntityExplodeEvent e) {
    if (!s().tnt() && tnt(e.getEntityType())) {
      e.setCancelled(true);
    } else if (!s().creeperDamage() && e.getEntityType() == EntityType.CREEPER) {
      e.blockList().clear();
    }
  }

  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onSpread(BlockSpreadEvent e) {
    if (!s().fireSpread() && e.getNewState().getType().name().equals("FIRE")) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onBurn(BlockBurnEvent e) {
    if (!s().fireSpread()) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onIgnite(BlockIgniteEvent e) {
    // Lava and lightning setting things alight count as spreading; a player's flint and steel does not.
    BlockIgniteEvent.IgniteCause cause = e.getCause();
    boolean natural = cause == BlockIgniteEvent.IgniteCause.SPREAD || cause == BlockIgniteEvent.IgniteCause.LAVA
        || cause == BlockIgniteEvent.IgniteCause.LIGHTNING;
    if (!s().fireSpread() && natural) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
  public void onEnderman(EntityChangeBlockEvent e) {
    if (!s().endermanGrief() && e.getEntityType() == EntityType.ENDERMAN) e.setCancelled(true);
  }
}
