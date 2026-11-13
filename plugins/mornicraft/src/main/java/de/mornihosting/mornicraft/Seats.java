package de.mornihosting.mornicraft;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.Bisected;
import org.bukkit.block.data.type.Slab;
import org.bukkit.block.data.type.Stairs;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.EquipmentSlot;

/**
 * Sitting on stairs and slabs (Philip, 13.11.): right click with an empty hand on the lower half of a stair or a
 * bottom slab and you sit on it – on stairs looking away from the backrest. Sneaking stands you up again. The seat is
 * an invisible marker armor stand, tagged so leftovers (a crash) are cleaned up at the next start.
 */
final class Seats implements Listener {
  private static final String TAG = "mornicraft_seat";
  /** Seat height above the block's bottom: on a half block the player's bottom lands on its top. */
  private static final double SEAT_Y = 0.3;
  private static final double REACH = 3.0;
  private static final long CHECK_TICKS = 5L;
  private static final double UP = 0.6;

  private final MorniCraft plugin;
  /** Player → their seat. */
  private final Map<UUID, ArmorStand> seats = new HashMap<>();

  Seats(MorniCraft plugin) {
    this.plugin = plugin;
    for (World w : Bukkit.getWorlds()) {
      for (Entity e : w.getEntitiesByClass(ArmorStand.class)) {
        if (e.getScoreboardTags().contains(TAG)) e.remove();
      }
    }
    // Got off (sneaking, teleport, death): the empty seat goes and the player stands on top of the block.
    Bukkit.getScheduler().runTaskTimer(plugin, this::tidy, CHECK_TICKS, CHECK_TICKS);
  }

  private void tidy() {
    seats.entrySet().removeIf(entry -> {
      ArmorStand stand = entry.getValue();
      Player p = Bukkit.getPlayer(entry.getKey());
      if (stand.isValid() && p != null && stand.getPassengers().contains(p)) return false;
      Location top = stand.getLocation().clone().add(0, UP, 0);
      stand.remove();
      if (p != null && p.isOnline() && p.getVehicle() == null && p.getLocation().distanceSquared(top) < 2) {
        top.setYaw(p.getLocation().getYaw());
        top.setPitch(p.getLocation().getPitch());
        p.teleport(top, PlayerTeleportEvent.TeleportCause.PLUGIN);
      }
      return true;
    });
  }

  void release() {
    seats.values().forEach(s -> {
      s.eject();
      s.remove();
    });
    seats.clear();
  }

  /** Where one sits on this block, or null (not a seat: full blocks, upside-down stairs, top slabs). */
  private static Location seatOf(Block b) {
    Location at = b.getLocation().add(0.5, SEAT_Y, 0.5);
    if (b.getBlockData() instanceof Stairs stairs) {
      if (stairs.getHalf() != Bisected.Half.BOTTOM) return null;
      // The backrest is where the stair faces: sit looking the other way.
      BlockFace look = stairs.getFacing().getOppositeFace();
      at.setYaw(yawOf(look));
      return at;
    }
    if (b.getBlockData() instanceof Slab slab && slab.getType() == Slab.Type.BOTTOM) return at;
    return null;
  }

  private static float yawOf(BlockFace f) {
    return switch (f) {
      case SOUTH -> 0f;
      case WEST -> 90f;
      case NORTH -> 180f;
      default -> -90f;
    };
  }

  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = false)
  public void onClick(PlayerInteractEvent e) {
    if (!plugin.settings().sit() || e.getAction() != Action.RIGHT_CLICK_BLOCK || e.getHand() != EquipmentSlot.HAND)
      return;
    Player p = e.getPlayer();
    Block b = e.getClickedBlock();
    if (b == null || p.isSneaking() || p.isInsideVehicle() || p.getGameMode() == GameMode.SPECTATOR) return;
    if (!p.getInventory().getItemInMainHand().getType().isAir()) return;
    if (seats.containsKey(p.getUniqueId()) || !b.getRelative(BlockFace.UP).isPassable()) return;
    if (p.getLocation().distance(b.getLocation().add(0.5, 0.5, 0.5)) > REACH) return;
    Location seat = seatOf(b);
    if (seat == null || taken(b)) return;
    e.setCancelled(true);
    // Spawned, then set up (the spawn-with-callback method changed its parameter type over the versions).
    ArmorStand stand = b.getWorld().spawn(seat, ArmorStand.class);
    stand.setInvisible(true);
    stand.setMarker(true);
    stand.setGravity(false);
    stand.setInvulnerable(true);
    stand.setSilent(true);
    stand.setSmall(true);
    stand.setPersistent(false);
    stand.addScoreboardTag(TAG);
    if (!stand.addPassenger(p)) {
      stand.remove();
      return;
    }
    seats.put(p.getUniqueId(), stand);
    p.sendActionBar(plugin.ui().words("sit.hint"));
  }

  private boolean taken(Block b) {
    return seats.values().stream().anyMatch(s -> s.getLocation().getBlock().equals(b));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBreak(BlockBreakEvent e) {
    seats.values().stream().filter(s -> s.getLocation().getBlock().equals(e.getBlock())).forEach(Entity::eject);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    ArmorStand stand = seats.remove(e.getPlayer().getUniqueId());
    if (stand != null) {
      stand.eject();
      stand.remove();
    }
  }
}
