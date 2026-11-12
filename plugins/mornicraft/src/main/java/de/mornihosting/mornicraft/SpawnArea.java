package de.mornihosting.mornicraft;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;

/**
 * The spawn island around the world spawn (set by MorniHosting's datapack to the middle of the island). Its area is a
 * column: within the radius, from a bit below the island upwards – the ground or sea far below stays free.
 */
final class SpawnArea {
  /** How far below the spawn point the island reaches (its rock tapers down to about 60 blocks). */
  private static final int DEPTH = 70;

  private SpawnArea() {}

  static World world() {
    return Bukkit.getWorlds().get(0);
  }

  static Location spawn() {
    return world().getSpawnLocation().clone().add(0.5, 0, 0.5);
  }

  static boolean inside(Location l, int radius) {
    if (l == null || l.getWorld() == null || !l.getWorld().equals(world())) return false;
    Location c = world().getSpawnLocation();
    double dx = l.getX() - c.getX();
    double dz = l.getZ() - c.getZ();
    return dx * dx + dz * dz <= (double) radius * radius && l.getY() >= c.getY() - DEPTH;
  }
}
