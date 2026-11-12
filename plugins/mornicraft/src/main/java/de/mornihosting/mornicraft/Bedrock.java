package de.mornihosting.mornicraft;

import java.util.List;
import java.util.function.Consumer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

/**
 * Bedrock players (via Geyser + Floodgate) cannot click in the chat. With Floodgate they get real Bedrock menus
 * instead ({@link FloodgateMenus}, only loaded when Floodgate is there); without it the chat says what to type.
 */
final class Bedrock {
  private static final String FLOODGATE_UUID = "00000000-0000-0000-";

  private final FloodgateMenus menus;

  Bedrock(MorniCraft plugin) {
    FloodgateMenus found = null;
    if (Bukkit.getPluginManager().isPluginEnabled("floodgate")) {
      try {
        found = new FloodgateMenus(plugin);
      } catch (LinkageError | RuntimeException e) {
        plugin.getLogger().warning("Floodgate found, but its menus are not usable: " + e);
      }
    }
    this.menus = found;
  }

  /** A Bedrock player: by Floodgate if it runs, else by Floodgate's typical UUID. */
  boolean is(Player p) {
    if (menus != null) return menus.isBedrock(p);
    return p.getUniqueId().toString().startsWith(FLOODGATE_UUID);
  }

  /** True when this player gets menus. */
  boolean menus(Player p) {
    return menus != null && menus.isBedrock(p);
  }

  void ask(Player p, String title, String content, String yes, String no, Consumer<Boolean> answer) {
    menus.ask(p, title, content, yes, no, answer);
  }

  void menu(Player p, String title, String content, List<String> buttons, List<Runnable> actions) {
    menus.menu(p, title, content, buttons, actions);
  }
}
