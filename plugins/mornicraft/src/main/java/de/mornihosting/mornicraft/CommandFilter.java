package de.mornihosting.mornicraft;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandSendEvent;

/**
 * Only the commands that matter in the suggestions (Philip: "nur die notwendigen und die, die auf der Seite
 * stehen"): MorniCraft's commands from the command list (/info), the team and clan commands – no aliases (/tell,
 * /knast, /staff …) and no "mornicraft:…" twins. Minecraft's own commands and other plugins' stay; the server software's (/plugins, /version) only for OPs.
 * Hidden ones still work when typed.
 */
final class CommandFilter implements Listener {
  private static final String PREFIX = "mornicraft:";
  /** Always shown (where the player may use them): not on every list, but needed. */
  private static final Set<String> ALWAYS = Set.of("info", "rules", "clan", "cc", "team", "ansehen", "gefaengnis",
      "frei", "stumm", "entstummen", "einfrieren", "mornicraft", "homes", "leiste", "nether", "end");
  /** Server software's own commands (not Minecraft's): they tell players which plugins run – only for OPs. */
  private static final Set<String> SERVER = Set.of("?", "about", "ver", "version", "pl", "plugins", "icanhasbukkit");
  private static final String SERVER_PREFIX = "bukkit:";

  private final MorniCraft plugin;

  CommandFilter(MorniCraft plugin) {
    this.plugin = plugin;
  }

  /** The command names written on the command list ("/sethome [name]" → "sethome"). */
  private Set<String> listed() {
    Set<String> names = new HashSet<>(ALWAYS);
    for (Settings.Group g : plugin.settings().groups()) {
      for (Settings.Command c : g.commands()) {
        String use = c.use().trim();
        if (!use.startsWith("/")) continue;
        names.add(use.substring(1).split("\\s+")[0].toLowerCase(Locale.ROOT));
      }
    }
    if (!plugin.settings().clans()) names.removeAll(List.of("clan", "cc"));
    return names;
  }

  @EventHandler
  public void onSend(PlayerCommandSendEvent e) {
    Set<String> keep = listed();
    // Team tools only for the team (they say no anyway, but nobody else needs to see them).
    if (e.getPlayer().isOp() || e.getPlayer().hasPermission("mornicraft.ranks")) keep.add("rang");
    if (e.getPlayer().isOp() || e.getPlayer().hasPermission(Moderation.PERMISSION)) keep.add("teamdashboard");
    Set<String> hide = new HashSet<>();
    for (Map.Entry<String, Map<String, Object>> cmd : plugin.getDescription().getCommands().entrySet()) {
      String name = cmd.getKey().toLowerCase(Locale.ROOT);
      if (!keep.contains(name)) hide.add(name);
      if (cmd.getValue().get("aliases") instanceof List<?> aliases) {
        aliases.forEach(a -> hide.add(String.valueOf(a).toLowerCase(Locale.ROOT)));
      }
    }
    boolean op = e.getPlayer().isOp();
    e.getCommands().removeIf(c -> c.startsWith(PREFIX) || hide.contains(c.toLowerCase(Locale.ROOT))
        || (!op && (c.startsWith(SERVER_PREFIX) || SERVER.contains(c))));
  }

  /** After a reload (other list, clans on/off): everyone gets the new suggestions. */
  void refresh() {
    Bukkit.getOnlinePlayers().forEach(p -> p.updateCommands());
  }
}
