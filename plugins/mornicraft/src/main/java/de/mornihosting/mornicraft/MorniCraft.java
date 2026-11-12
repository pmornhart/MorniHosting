package de.mornihosting.mornicraft;

import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * MorniCraft – the panel's own plugin for MorniCraft servers (a friends' survival world): /spawn, homes, teleport
 * requests with a short wait, private messages and mail, the start elytra, a protected spawn island, a welcome and
 * the command list. MorniHosting writes config.yml from the dashboard and reloads it with /mornicraft reload.
 */
public final class MorniCraft extends JavaPlugin {
  private static final List<String> COMMANDS = List.of("spawn", "sethome", "home", "homes", "delhome", "back", "tpa",
      "tpahere", "tpaccept", "tpdeny", "msg", "r", "mail", "ignore", "afk", "seen", "near", "getpos", "ping", "info",
      "rules", "leiste", "team", "mornicraft");

  private Settings settings;
  private Ui ui;
  private PlayerStore store;
  private Teleporter teleporter;
  private Social social;
  private Commands commands;
  private SpawnElytra elytra;
  private Bedrock bedrock;
  private Sidebar sidebar;
  private Ranks ranks;

  @Override
  public void onEnable() {
    saveDefaultConfig();
    load();
    store = new PlayerStore(this);
    bedrock = new Bedrock(this);
    teleporter = new Teleporter(this);
    social = new Social(this);
    commands = new Commands(this);
    elytra = new SpawnElytra(this);
    ranks = new Ranks(this);
    ranks.load(getConfig());
    sidebar = new Sidebar(this);
    var pm = Bukkit.getPluginManager();
    pm.registerEvents(teleporter, this);
    pm.registerEvents(social, this);
    pm.registerEvents(elytra, this);
    pm.registerEvents(new SpawnGuard(this), this);
    pm.registerEvents(new Welcome(this), this);
    pm.registerEvents(new WorldRules(this), this);
    pm.registerEvents(sidebar, this);
    pm.registerEvents(ranks, this);
    pm.registerEvents(new UpdateCheck(this), this);
    for (String name : COMMANDS) {
      PluginCommand c = getCommand(name);
      if (c != null) {
        c.setExecutor(commands);
        c.setTabCompleter(commands);
      }
    }
  }

  @Override
  public void onDisable() {
    if (elytra != null) elytra.release();
    if (teleporter != null) teleporter.release();
    if (sidebar != null) sidebar.release();
    if (ranks != null) ranks.release();
  }

  private void load() {
    reloadConfig();
    settings = Settings.from(getConfig());
    ui = new Ui(new Texts(settings.language()), p -> bedrock != null && bedrock.is(p));
  }

  void reload() {
    load();
    if (ranks != null) ranks.load(getConfig());
    if (sidebar != null) sidebar.rebuild();
  }

  Ranks ranks() {
    return ranks;
  }

  Sidebar sidebar() {
    return sidebar;
  }

  Settings settings() {
    return settings;
  }

  Ui ui() {
    return ui;
  }

  PlayerStore store() {
    return store;
  }

  Teleporter teleporter() {
    return teleporter;
  }

  Social social() {
    return social;
  }

  Commands commands() {
    return commands;
  }

  Bedrock bedrock() {
    return bedrock;
  }
}
