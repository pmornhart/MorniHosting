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
      "rules", "leiste", "team", "streamer", "abzeichen", "gefaengnis", "frei", "stumm", "entstummen", "einfrieren", "ansehen", "rang", "teamdashboard", "mornicraft", "mcadmin", "clan", "cc", "nether", "end");

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
  private Streamer streamer;
  private HomeMenu homeMenu;
  private Moderation moderation;
  private Graves graves;
  private Combat combat;
  private RankCommands rankCommands;
  private Seats seats;
  private Limits limits;
  private Clans clans;
  private TeamBoard teamBoard;
  private Portals portals;
  private HardDragon dragon;

  /** The MoinMorni network, when its plugin runs here (else null: alone or under MorniHosting, as always). */
  private Network network;
  private NetworkMode networkMode;
  private SpawnIsland spawnIsland;

  /** The plugin's own jar (the spawn datapack is packed into it). */
  java.io.File jarFile() {
    return getFile();
  }

  @Override
  public void onEnable() {
    saveDefaultConfig();
    reloadConfig();
    network = Network.find(this, getConfig());
    if (network != null) getLogger().info("MoinMorni network found: ranks, chat, punishments and settings come from it");
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
    streamer = new Streamer(this);
    homeMenu = new HomeMenu(this);
    moderation = new Moderation(this);
    graves = new Graves(this);
    combat = new Combat(this);
    rankCommands = new RankCommands(this);
    teamBoard = new TeamBoard(this);
    var pm = Bukkit.getPluginManager();
    pm.registerEvents(teleporter, this);
    pm.registerEvents(social, this);
    pm.registerEvents(elytra, this);
    pm.registerEvents(new SpawnGuard(this), this);
    pm.registerEvents(new Welcome(this), this);
    pm.registerEvents(new WorldRules(this), this);
    pm.registerEvents(sidebar, this);
    pm.registerEvents(ranks, this);
    pm.registerEvents(homeMenu, this);
    pm.registerEvents(moderation, this);
    pm.registerEvents(graves, this);
    pm.registerEvents(combat, this);
    pm.registerEvents(rankCommands, this);
    pm.registerEvents(new GamemodeGuard(this), this);
    limits = new Limits(this);
    clans = new Clans(this);
    pm.registerEvents(clans, this);
    portals = new Portals(this);
    // The spawn island (in the network, or with "spawn-island: on"): built once, when the worlds are there.
    spawnIsland = new SpawnIsland(this);
    Bukkit.getScheduler().runTaskLater(this, spawnIsland::start, 20L);
    // Portals built the old way move to their new place once the worlds are there.
    Bukkit.getScheduler().runTaskLater(this, portals::migrate, 40L);
    dragon = new HardDragon(this);
    pm.registerEvents(dragon, this);
    seats = new Seats(this);
    pm.registerEvents(seats, this);
    if (network == null) pm.registerEvents(new UpdateCheck(this), this);
    if (network != null) {
      networkMode = new NetworkMode(this);
      pm.registerEvents(networkMode, this);
    }
    commandFilter = new CommandFilter(this);
    pm.registerEvents(commandFilter, this);
    // After the server finished loading: then the other plugins' commands are known and stay theirs.
    if (network == null) Bukkit.getScheduler().runTask(this, rankCommands::registerCommands);
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
    if (combat != null) combat.release();
    if (teleporter != null) teleporter.release();
    if (sidebar != null) sidebar.release();
    if (ranks != null) ranks.release();
    if (rankCommands != null) rankCommands.unregisterCommands();
    if (seats != null) seats.release();
    if (networkMode != null) networkMode.release();
  }

  private void load() {
    reloadConfig();
    if (network != null) Network.overlay(this, getConfig());
    settings = Settings.from(getConfig(), network != null);
    Ui.theme(network != null);
    ui = new Ui(new Texts(settings.language()), p -> bedrock != null && bedrock.is(p));
  }

  /** From now on (this thread) the texts in this player's network language; {@link #quiet} ends it. */
  void voice(org.bukkit.entity.Player p) {
    if (network != null && p != null) Texts.use(network.language(p.getUniqueId()));
  }

  void quiet() {
    if (network != null) Texts.use(null);
  }

  /** Builds and sends something in the receiver's language (in the network; alone: the server's). */
  void speak(org.bukkit.entity.Player to, Runnable r) {
    if (network == null || to == null) r.run();
    else Texts.as(network.language(to.getUniqueId()), r);
  }

  /** The MoinMorni network, or null (alone or under MorniHosting). */
  Network network() {
    return network;
  }

  NetworkMode networkMode() {
    return networkMode;
  }

  private CommandFilter commandFilter;

  void reload() {
    load();
    if (ranks != null) ranks.load(getConfig());
    if (rankCommands != null && network == null) rankCommands.registerCommands();
    if (streamer != null) streamer.load();
    if (sidebar != null) sidebar.rebuild();
    if (commandFilter != null) commandFilter.refresh();
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

  /** A punishment for the team dashboard's history (before the dashboard exists: nothing). */
  void history(String type, String target, String by, String reason, long ms) {
    if (teamBoard != null) teamBoard.record(type, target, by, reason, ms);
  }

  TeamBoard teamBoard() {
    return teamBoard;
  }

  Limits limits() {
    return limits;
  }

  HardDragon dragon() {
    return dragon;
  }

  Portals portals() {
    return portals;
  }

  Clans clans() {
    return clans;
  }

  RankCommands rankCommands() {
    return rankCommands;
  }

  Combat combat() {
    return combat;
  }

  SpawnElytra elytra() {
    return elytra;
  }

  /** The server is shutting down (players leaving now are not running away). Paper 1.17+ knows it. */
  boolean isStopping() {
    try {
      return (boolean) Bukkit.class.getMethod("isStopping").invoke(null);
    } catch (ReflectiveOperationException | RuntimeException | LinkageError older) {
      return false;
    }
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

  Streamer streamer() {
    return streamer;
  }

  HomeMenu homeMenu() {
    return homeMenu;
  }

  Graves graves() {
    return graves;
  }

  Moderation moderation() {
    return moderation;
  }
}
