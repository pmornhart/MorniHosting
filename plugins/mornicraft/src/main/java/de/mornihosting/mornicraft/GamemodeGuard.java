package de.mornihosting.mornicraft;

import java.util.Locale;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;

/**
 * /gamemode for the team (Philip, 13.11.): ranks with the "game mode" switch may go to survival, adventure and
 * spectator; creative only with the extra switch (mornicraft.creative). Operators always.
 */
final class GamemodeGuard implements Listener {
  static final String CREATIVE = "mornicraft.creative";

  private final MorniCraft plugin;

  GamemodeGuard(MorniCraft plugin) {
    this.plugin = plugin;
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onCommand(PlayerCommandPreprocessEvent e) {
    Player p = e.getPlayer();
    if (p.isOp() || p.hasPermission(CREATIVE)) return;
    String[] parts = e.getMessage().substring(1).trim().toLowerCase(Locale.ROOT).split("\\s+");
    if (parts.length < 2) return;
    String label = parts[0].contains(":") ? parts[0].substring(parts[0].indexOf(':') + 1) : parts[0];
    if (!label.equals("gamemode")) return;
    String mode = parts[1];
    if (mode.equals("creative") || mode.equals("c") || mode.equals("1")) {
      e.setCancelled(true);
      p.sendMessage(plugin.ui().fail("gamemode.nocreative"));
    }
  }
}
