package de.mornihosting.mornicraft;

import io.papermc.paper.event.player.AsyncChatEvent;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Statistic;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.SkullMeta;

/**
 * Tools for the team (permission mornicraft.moderate, operators always): the jail (/gefaengnis Name 10m – a small
 * floating cell, a bar counting down, nothing to break, no way out), muting (/stumm), freezing (/einfrieren) and a
 * window per player (/mod Name, or sneak + right click on someone): look at their homes, inventory and ender chest,
 * go to them or fetch them, heal, kick, jail and mute with a click.
 */
final class Moderation implements Listener {
  static final String PERMISSION = "mornicraft.moderate";
  private static final long SECOND_MS = 1000;
  private static final long MINUTE_MS = 60 * SECOND_MS;
  private static final long HOUR_MS = 60 * MINUTE_MS;
  private static final long DAY_MS = 24 * HOUR_MS;
  /** Longest jail or mute: 30 days. */
  private static final long MAX_MS = 30 * DAY_MS;
  private static final long DEFAULT_MS = 10 * MINUTE_MS;
  private static final long[] DURATIONS = {5 * MINUTE_MS, 10 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS, DAY_MS, 7 * DAY_MS};
  /**
   * A duration: "10m", "1h30m", "2d", "45s", "10" (minutes); also German units (min, std, t, tag, tage).
   * https://regex101.com/?flavor=java&regex=(%5Cd%2B)%5Cs*(tage%7Ctag%7Cstd%7Cmin%7Csek%7Cs%7Cm%7Ch%7Cd%7Ct%7Cw)%3F&testString=1h30m
   */
  private static final Pattern PART = Pattern.compile("(\\d+)\\s*(tage|tag|std|min|sek|s|m|h|d|t|w)?");
  /** Where the cell floats by default: away from the spawn island (x/z from the world spawn) and a bit higher. */
  private static final int CELL_DX = 140;
  private static final int CELL_DZ = 140;
  private static final int CELL_DY = 10;
  /** The cell: 7 × 7 inside, 4 high; the prisoner stays within this distance of the middle. */
  private static final int CELL_HALF = 3;
  private static final int CELL_HEIGHT = 4;
  private static final double KEEP_IN = 4.5;
  /** Commands a prisoner (or someone muted) may still use. */
  private static final Set<String> JAIL_OK = Set.of("msg", "tell", "w", "whisper", "r", "reply", "mail", "info",
      "befehle", "commands", "rules", "regeln", "ping", "streamer", "streamermodus", "leiste", "team");
  private static final Set<String> MUTE_BLOCKED = Set.of("msg", "tell", "w", "whisper", "r", "reply", "mail", "me",
      "say", "minecraft:msg", "minecraft:tell", "minecraft:w", "minecraft:me", "minecraft:say", "teammsg", "tm");

  private final MorniCraft plugin;
  private final File jailFile;
  private Location cell;
  private boolean barsChecked;
  private final Set<UUID> frozen = ConcurrentHashMap.newKeySet();
  private final Map<UUID, BossBar> bars = new HashMap<>();
  /** Inventories opened by someone who may only look (not take): viewer → nothing. */
  private final Set<UUID> lookOnly = new java.util.HashSet<>();

  Moderation(MorniCraft plugin) {
    this.plugin = plugin;
    this.jailFile = new File(plugin.getDataFolder(), "jail.yml");
    loadCell();
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 20, 20);
  }

  private Ui ui() {
    return plugin.ui();
  }

  // ---------------------------------------------------------------- durations

  /** "10m" → 600000; null when it isn't a duration. */
  static Long parse(String text) {
    String t = text.toLowerCase(Locale.ROOT).trim();
    if (t.isEmpty()) return null;
    Matcher m = PART.matcher(t);
    long total = 0;
    int at = 0;
    while (m.find()) {
      if (m.start() != at) return null;
      long n = Long.parseLong(m.group(1));
      String unit = m.group(2) == null ? "m" : m.group(2);
      long each = switch (unit) {
        case "s", "sek" -> SECOND_MS;
        case "h", "std" -> HOUR_MS;
        case "d", "t", "tag", "tage" -> DAY_MS;
        case "w" -> 7 * DAY_MS;
        default -> MINUTE_MS;
      };
      total += n * each;
      at = m.end();
    }
    if (at != t.length() || total <= 0) return null;
    return Math.min(total, MAX_MS);
  }

  /** "9:41", "2 Std. 5 Min.", "3 Tage". */
  String left(long ms) {
    boolean en = "en".equalsIgnoreCase(plugin.settings().language());
    long s = Math.max(0, ms / SECOND_MS);
    if (s < 3600) return String.format("%d:%02d", s / 60, s % 60);
    if (s < 86400) return (s / 3600) + (en ? " h " : " Std. ") + (s % 3600 / 60) + (en ? " min" : " Min.");
    long days = s / 86400;
    return days + (en ? (days == 1 ? " day" : " days") : (days == 1 ? " Tag" : " Tage"));
  }

  /** "10 Minuten", "1 Stunde", "7 Tage" for the buttons. */
  String span(long ms) {
    boolean en = "en".equalsIgnoreCase(plugin.settings().language());
    if (ms < HOUR_MS) return (ms / MINUTE_MS) + (en ? " minutes" : " Minuten");
    if (ms < DAY_MS) {
      long h = ms / HOUR_MS;
      return h + (en ? (h == 1 ? " hour" : " hours") : (h == 1 ? " Stunde" : " Stunden"));
    }
    long d = ms / DAY_MS;
    return d + (en ? (d == 1 ? " day" : " days") : (d == 1 ? " Tag" : " Tage"));
  }

  // ---------------------------------------------------------------- who may

  private static boolean staff(CommandSender s) {
    return s.isOp() || s.hasPermission(PERMISSION);
  }

  /** The team may not use this on operators (only operators may), nor on themselves. */
  private boolean mayTouch(CommandSender by, Player target) {
    if (by instanceof Player p && p.equals(target)) {
      by.sendMessage(ui().fail("mod.self"));
      return false;
    }
    if (target.isOp() && !by.isOp()) {
      by.sendMessage(ui().fail("mod.protected", Ui.v("name", target.getName())));
      return false;
    }
    return true;
  }

  /** Tells the whole team (and the console). */
  private void tellTeam(String key, Ui.Value... values) {
    Component line = Component.text("⚑ ", Ui.GOLD).append(ui().words(key, values));
    Bukkit.getOnlinePlayers().stream().filter(Moderation::staff).forEach(p -> p.sendMessage(line));
    Bukkit.getConsoleSender().sendMessage(line);
  }

  // ---------------------------------------------------------------- the cell

  private void loadCell() {
    if (!jailFile.exists()) return;
    YamlConfiguration y = YamlConfiguration.loadConfiguration(jailFile);
    World w = Bukkit.getWorld(y.getString("world", ""));
    if (w != null) cell = new Location(w, y.getDouble("x"), y.getDouble("y"), y.getDouble("z"), (float) y.getDouble("yaw"), 0);
  }

  private void saveCell() {
    YamlConfiguration y = new YamlConfiguration();
    y.set("world", cell.getWorld().getName());
    y.set("x", cell.getX());
    y.set("y", cell.getY());
    y.set("z", cell.getZ());
    y.set("yaw", cell.getYaw());
    try {
      y.save(jailFile);
    } catch (IOException e) {
      plugin.getLogger().warning("Could not save jail.yml: " + e);
    }
  }

  /** The cell's middle (standing place); built the first time it is needed. */
  Location cell() {
    if (cell == null) {
      Location spawn = SpawnArea.world().getSpawnLocation();
      Location at = new Location(spawn.getWorld(), spawn.getBlockX() + CELL_DX, spawn.getBlockY() + CELL_DY,
          spawn.getBlockZ() + CELL_DZ);
      build(at);
      cell = at.clone().add(0.5, 0, 0.5);
      cell.setYaw(180);
      saveCell();
    } else if (!barsChecked) {
      // Cells built by older versions: join their bars once per start (only where the plugin's own walls stand).
      joinBars(cell.getBlock().getLocation());
    }
    barsChecked = true;
    return cell.clone();
  }

  /** "/gefaengnis hier": the cell is where the admin stands (nothing is built – they built their own). */
  private void setCellHere(Player p) {
    cell = p.getLocation().getBlock().getLocation().add(0.5, 0, 0.5);
    cell.setYaw(p.getLocation().getYaw());
    saveCell();
    p.sendMessage(ui().ok("jail.cell.set"));
  }

  /**
   * A small floating cell: a stone-brick room on a rocky underside, iron bars all round so one can look out, a
   * lantern, a stool, a flower pot and a sign. The prisoner plays in adventure mode, so nothing in it breaks.
   */
  private static void build(Location floor) {
    World w = floor.getWorld();
    int x0 = floor.getBlockX();
    int y0 = floor.getBlockY();
    int z0 = floor.getBlockZ();
    int r = CELL_HALF + 1;
    for (int dx = -r; dx <= r; dx++) {
      for (int dz = -r; dz <= r; dz++) {
        boolean edge = Math.abs(dx) == r || Math.abs(dz) == r;
        boolean corner = Math.abs(dx) == r && Math.abs(dz) == r;
        // Floor and a rocky underside that gets narrower.
        set(w, x0 + dx, y0 - 1, z0 + dz, edge ? Material.STONE_BRICKS : Material.POLISHED_ANDESITE);
        if (Math.abs(dx) < r && Math.abs(dz) < r) set(w, x0 + dx, y0 - 2, z0 + dz, Material.COBBLESTONE);
        if (Math.abs(dx) < r - 1 && Math.abs(dz) < r - 1) set(w, x0 + dx, y0 - 3, z0 + dz, Material.MOSSY_COBBLESTONE);
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) set(w, x0 + dx, y0 - 4, z0 + dz, Material.COBBLESTONE);
        for (int dy = 0; dy < CELL_HEIGHT; dy++) {
          Material m;
          if (!edge) m = Material.AIR;
          else if (corner || dy == 0 || dy == CELL_HEIGHT - 1) m = Material.STONE_BRICKS;
          else m = Material.IRON_BARS;
          set(w, x0 + dx, y0 + dy, z0 + dz, m);
        }
        set(w, x0 + dx, y0 + CELL_HEIGHT, z0 + dz, edge ? Material.STONE_BRICK_SLAB : Material.STONE_BRICKS);
      }
    }
    joinBars(floor);
    // Inside: light, a stool, a flower, a sign.
    Block lantern = w.getBlockAt(x0, y0 + CELL_HEIGHT - 1, z0);
    lantern.setBlockData(Bukkit.createBlockData("minecraft:lantern[hanging=true]"));
    w.getBlockAt(x0 - 2, y0, z0 - 2).setBlockData(Bukkit.createBlockData("minecraft:oak_stairs[facing=south]"));
    set(w, x0 + 2, y0, z0 - 2, Material.POTTED_POPPY);
    set(w, x0 + 2, y0, z0 + 2, Material.CAULDRON);
    Block sign = w.getBlockAt(x0, y0 + 1, z0 - CELL_HALF);
    BlockData data = Bukkit.createBlockData("minecraft:oak_wall_sign[facing=south]");
    sign.setBlockData(data);
    if (sign.getState() instanceof org.bukkit.block.Sign s) {
      s.line(0, Component.text("⚑", NamedTextColor.DARK_RED));
      s.line(1, Component.text("Gefängnis", NamedTextColor.BLACK).decoration(TextDecoration.BOLD, true));
      s.line(2, Component.text("Zeit absitzen", NamedTextColor.DARK_GRAY));
      s.line(3, Component.text(":)", NamedTextColor.DARK_GRAY));
      s.update(true, false);
    }
  }

  /**
   * The bars of the cell's walls joined to each other, like a player places them – without that they stood as single
   * posts and one could walk out between them (Philip, 13.11.). Also repairs cells built before.
   */
  private static void joinBars(Location floor) {
    World w = floor.getWorld();
    int r = CELL_HALF + 1;
    BlockData alongZ = Bukkit.createBlockData("minecraft:iron_bars[north=true,south=true]");
    BlockData alongX = Bukkit.createBlockData("minecraft:iron_bars[east=true,west=true]");
    for (int d = -r + 1; d < r; d++) {
      for (int dy = 1; dy < CELL_HEIGHT - 1; dy++) {
        for (int side : new int[] {-r, r}) {
          Block onX = w.getBlockAt(floor.getBlockX() + side, floor.getBlockY() + dy, floor.getBlockZ() + d);
          if (onX.getType() == Material.IRON_BARS) onX.setBlockData(alongZ, false);
          Block onZ = w.getBlockAt(floor.getBlockX() + d, floor.getBlockY() + dy, floor.getBlockZ() + side);
          if (onZ.getType() == Material.IRON_BARS) onZ.setBlockData(alongX, false);
        }
      }
    }
  }

  private static void set(World w, int x, int y, int z, Material m) {
    w.getBlockAt(x, y, z).setType(m, false);
  }

  /** Inside the cell (its blocks are protected like the spawn). */
  boolean inCell(Location l) {
    if (cell == null || l == null || l.getWorld() == null || !l.getWorld().equals(cell.getWorld())) return false;
    double dx = Math.abs(l.getX() - cell.getX());
    double dz = Math.abs(l.getZ() - cell.getZ());
    double dy = l.getY() - cell.getY();
    return dx <= CELL_HALF + 2 && dz <= CELL_HALF + 2 && dy >= -6 && dy <= CELL_HEIGHT + 2;
  }

  // ---------------------------------------------------------------- jail

  boolean frozen(Player p) {
    return frozen.contains(p.getUniqueId());
  }

  boolean jailed(Player p) {
    return plugin.store().get(p.getUniqueId()).jailUntil > System.currentTimeMillis();
  }

  void jail(CommandSender by, Player target, long ms, String reason) {
    if (!mayTouch(by, target)) return;
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    boolean already = d.jailUntil > System.currentTimeMillis();
    if (!already) {
      d.jailReturn = PlayerStore.Home.of(target.getLocation());
      d.jailMode = target.getGameMode().name();
    }
    d.jailUntil = System.currentTimeMillis() + ms;
    d.jailFrom = System.currentTimeMillis();
    d.jailReason = reason == null ? "" : reason;
    plugin.store().save(target.getUniqueId(), d);
    lockIn(target);
    target.showTitle(Title.title(Component.text("⚑ " + ui().flat("jail.title"), NamedTextColor.RED),
        Component.text(ui().flat("jail.subtitle", Ui.v("time", span(ms))), Ui.SOFT)));
    target.sendMessage(ui().fail(d.jailReason.isEmpty() ? "jail.you" : "jail.you.reason", Ui.v("time", span(ms)),
        Ui.v("reason", d.jailReason)));
    plugin.history("jail", target.getName(), by.getName(), d.jailReason, ms);
    tellTeam("jail.team", Ui.v("by", by.getName()), Ui.v("name", target.getName()), Ui.v("time", span(ms)),
        Ui.v("reason", d.jailReason.isEmpty() ? "–" : d.jailReason));
  }

  /** Into the cell, adventure mode (nothing breaks), no flying. */
  private void lockIn(Player p) {
    p.setGameMode(GameMode.ADVENTURE);
    p.setFlying(false);
    p.setAllowFlight(false);
    // Jailed mid-fall: the fall height must not come along into the cell (else they die on landing there).
    p.setFallDistance(0);
    p.teleport(cell(), PlayerTeleportEvent.TeleportCause.PLUGIN);
    p.setFallDistance(0);
  }

  /** Nobody gets hurt or dies in the jail (no fall damage, no lava, no grave in the cell). */
  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onJailDamage(EntityDamageEvent e) {
    if (e.getEntity() instanceof Player p && jailed(p)) {
      e.setCancelled(true);
      p.setFallDistance(0);
    }
  }

  void release(CommandSender by, Player target, boolean early) {
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    if (d.jailUntil == 0) {
      if (by != null) by.sendMessage(ui().fail("jail.not", Ui.v("name", target.getName())));
      return;
    }
    d.jailUntil = 0;
    PlayerStore.Home back = d.jailReturn;
    String mode = d.jailMode;
    d.jailReturn = null;
    d.jailMode = null;
    d.jailReason = "";
    plugin.store().save(target.getUniqueId(), d);
    BossBar bar = bars.remove(target.getUniqueId());
    if (bar != null) target.hideBossBar(bar);
    try {
      target.setGameMode(mode == null ? Bukkit.getDefaultGameMode() : GameMode.valueOf(mode));
    } catch (IllegalArgumentException e) {
      target.setGameMode(Bukkit.getDefaultGameMode());
    }
    Location to = back == null ? null : back.location();
    target.setFallDistance(0);
    target.teleport(to != null ? to : SpawnArea.spawn(), PlayerTeleportEvent.TeleportCause.PLUGIN);
    target.showTitle(Title.title(Component.text("✔ " + ui().flat("jail.free.title"), Ui.ACCENT), Component.empty()));
    target.sendMessage(ui().ok("jail.free"));
    if (early && by != null) plugin.history("free", target.getName(), by.getName(), "", 0);
    if (early && by != null) tellTeam("jail.team.free", Ui.v("by", by.getName()), Ui.v("name", target.getName()));
  }

  /** Every second: the bars count down, time served = free. */
  private void tick() {
    long now = System.currentTimeMillis();
    for (Player p : Bukkit.getOnlinePlayers()) {
      PlayerStore.Data d = plugin.store().get(p.getUniqueId());
      if (d.jailUntil == 0) continue;
      if (d.jailUntil <= now) {
        release(null, p, false);
        continue;
      }
      long total = Math.max(1, d.jailTotal(now));
      float progress = Math.max(0f, Math.min(1f, (float) (d.jailUntil - now) / total));
      Component name = Component.text("⚑ " + ui().flat("jail.bar", Ui.v("time", left(d.jailUntil - now))), NamedTextColor.RED);
      BossBar bar = bars.get(p.getUniqueId());
      if (bar == null) {
        bar = BossBar.bossBar(name, progress, BossBar.Color.RED, BossBar.Overlay.NOTCHED_10);
        bars.put(p.getUniqueId(), bar);
        p.showBossBar(bar);
      } else {
        bar.name(name);
        bar.progress(progress);
      }
    }
  }

  // ---------------------------------------------------------------- mute and freeze

  boolean muted(Player p) {
    return plugin.store().get(p.getUniqueId()).muteUntil > System.currentTimeMillis();
  }

  void mute(CommandSender by, Player target, long ms, String reason) {
    if (!mayTouch(by, target)) return;
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    d.muteUntil = System.currentTimeMillis() + ms;
    plugin.store().save(target.getUniqueId(), d);
    target.sendMessage(ui().fail(reason == null || reason.isEmpty() ? "mute.you" : "mute.you.reason",
        Ui.v("time", span(ms)), Ui.v("reason", reason == null ? "" : reason)));
    plugin.history("mute", target.getName(), by.getName(), reason == null ? "" : reason, ms);
    tellTeam("mute.team", Ui.v("by", by.getName()), Ui.v("name", target.getName()), Ui.v("time", span(ms)));
  }

  void unmute(CommandSender by, Player target) {
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    if (d.muteUntil <= System.currentTimeMillis()) {
      by.sendMessage(ui().fail("mute.not", Ui.v("name", target.getName())));
      return;
    }
    d.muteUntil = 0;
    plugin.store().save(target.getUniqueId(), d);
    target.sendMessage(ui().ok("mute.free"));
    plugin.history("unmute", target.getName(), by.getName(), "", 0);
    tellTeam("mute.team.free", Ui.v("by", by.getName()), Ui.v("name", target.getName()));
  }

  void freeze(CommandSender by, Player target) {
    if (frozen.remove(target.getUniqueId())) {
      target.sendMessage(ui().ok("freeze.off"));
      target.clearTitle();
      plugin.history("unfreeze", target.getName(), by.getName(), "", 0);
      tellTeam("freeze.team.off", Ui.v("by", by.getName()), Ui.v("name", target.getName()));
      return;
    }
    if (!mayTouch(by, target)) return;
    frozen.add(target.getUniqueId());
    target.showTitle(Title.title(Component.text("❄ " + ui().flat("freeze.title"), NamedTextColor.AQUA),
        Component.text(ui().flat("freeze.subtitle"), Ui.SOFT)));
    plugin.history("freeze", target.getName(), by.getName(), "", 0);
    tellTeam("freeze.team", Ui.v("by", by.getName()), Ui.v("name", target.getName()));
  }

  // ---------------------------------------------------------------- events

  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onChat(AsyncChatEvent e) {
    Player p = e.getPlayer();
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.muteUntil > System.currentTimeMillis()) {
      e.setCancelled(true);
      p.sendMessage(ui().fail("mute.still", Ui.v("time", left(d.muteUntil - System.currentTimeMillis()))));
    }
  }

  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onCommand(PlayerCommandPreprocessEvent e) {
    Player p = e.getPlayer();
    if (staff(p)) return;
    String label = e.getMessage().substring(1).split(" ")[0].toLowerCase(Locale.ROOT);
    String bare = label.startsWith("mornicraft:") ? label.substring("mornicraft:".length()) : label;
    if (jailed(p) && !JAIL_OK.contains(bare)) {
      e.setCancelled(true);
      p.sendMessage(ui().fail("jail.nocommand"));
      return;
    }
    if (muted(p) && (MUTE_BLOCKED.contains(label) || MUTE_BLOCKED.contains(bare))) {
      e.setCancelled(true);
      long left = plugin.store().get(p.getUniqueId()).muteUntil - System.currentTimeMillis();
      p.sendMessage(ui().fail("mute.still", Ui.v("time", left(left))));
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onMove(PlayerMoveEvent e) {
    Player p = e.getPlayer();
    Location to = e.getTo();
    if (frozen.contains(p.getUniqueId())) {
      Location from = e.getFrom();
      if (from.getX() != to.getX() || from.getZ() != to.getZ() || to.getY() > from.getY()) {
        Location keep = from.clone();
        keep.setYaw(to.getYaw());
        keep.setPitch(to.getPitch());
        e.setTo(keep);
      }
      return;
    }
    if (cell == null || !jailed(p)) return;
    if (!to.getWorld().equals(cell.getWorld()) || to.distance(cell) > KEEP_IN + CELL_HEIGHT) e.setTo(cell());
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onTeleport(PlayerTeleportEvent e) {
    Player p = e.getPlayer();
    if (!jailed(p) || e.getCause() == PlayerTeleportEvent.TeleportCause.PLUGIN && inCell(e.getTo())) return;
    // Pearls, chorus fruit, /tpa from friends … – a prisoner stays put (the team can still fetch them via plugins).
    if (e.getCause() != PlayerTeleportEvent.TeleportCause.PLUGIN || !staffNearby(e.getTo())) e.setCancelled(true);
  }

  private static boolean staffNearby(Location l) {
    return l != null && Bukkit.getOnlinePlayers().stream().anyMatch(o -> staff(o) && o.getWorld().equals(l.getWorld())
        && o.getLocation().distanceSquared(l) < 4);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onRespawn(PlayerRespawnEvent e) {
    if (jailed(e.getPlayer())) e.setRespawnLocation(cell());
  }

  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    Player p = e.getPlayer();
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.jailUntil == 0) return;
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (!p.isOnline()) return;
      if (d.jailUntil <= System.currentTimeMillis()) release(null, p, false);
      else {
        lockIn(p);
        p.sendMessage(ui().fail("jail.still", Ui.v("time", left(d.jailUntil - System.currentTimeMillis()))));
      }
    }, 5L);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    BossBar bar = bars.remove(e.getPlayer().getUniqueId());
    if (bar != null) e.getPlayer().hideBossBar(bar);
    lookOnly.remove(e.getPlayer().getUniqueId());
  }

  /** Sneak + right click on a player: the team's window for them. */
  @EventHandler(priority = EventPriority.LOW)
  public void onClickPlayer(PlayerInteractEntityEvent e) {
    if (e.getHand() != EquipmentSlot.HAND || !(e.getRightClicked() instanceof Player target)) return;
    Player p = e.getPlayer();
    if (!p.isSneaking() || !staff(p) || !target.isOnline()) return;
    e.setCancelled(true);
    open(p, target);
  }

  // ---------------------------------------------------------------- the windows

  private enum Kind { PLAYER, JAIL, MUTE }

  private static final class Window implements InventoryHolder {
    private final Kind kind;
    private final UUID target;
    private Inventory inventory;

    Window(Kind kind, UUID target) {
      this.kind = kind;
      this.target = target;
    }

    @Override
    public Inventory getInventory() {
      return inventory;
    }
  }

  private static final int ROW = 9;
  private static final int HEAD = 4;
  private static final int GO = 19;
  private static final int FETCH = 20;
  private static final int HOMES = 21;
  private static final int INVENTORY = 22;
  private static final int ENDER = 23;
  private static final int HEAL = 24;
  private static final int FREEZE = 25;
  private static final int JAIL = 29;
  private static final int MUTE = 31;
  private static final int KICK = 33;
  private static final int CLOSE = 44;
  private static final int BACK = 22;

  void open(Player p, Player target) {
    Window w = new Window(Kind.PLAYER, target.getUniqueId());
    Inventory inv = Bukkit.createInventory(w, 5 * ROW, Component.text(ui().flat("mod.title", Ui.v("name", target.getName())), NamedTextColor.DARK_RED));
    w.inventory = inv;
    for (int i = 0; i < ROW; i++) inv.setItem(i, pane());
    inv.setItem(HEAD, head(p, target));
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    long now = System.currentTimeMillis();
    inv.setItem(GO, item(Material.ENDER_PEARL, ui().flat("mod.go"), ui().flat("mod.go.hint"), Ui.ACCENT_2));
    inv.setItem(FETCH, item(Material.LEAD, ui().flat("mod.fetch"), ui().flat("mod.fetch.hint"), Ui.ACCENT_2));
    inv.setItem(HOMES, item(Material.RED_BED, ui().flat("mod.homes", Ui.v("n", d.homes.size())), ui().flat("mod.homes.hint"), Ui.ACCENT));
    inv.setItem(INVENTORY, item(Material.CHEST, ui().flat("mod.inventory"), ui().flat(p.isOp() ? "mod.inventory.edit" : "mod.inventory.look"), Ui.ACCENT));
    inv.setItem(ENDER, item(Material.ENDER_CHEST, ui().flat("mod.ender"), ui().flat(p.isOp() ? "mod.inventory.edit" : "mod.inventory.look"), Ui.ACCENT));
    inv.setItem(HEAL, item(Material.GOLDEN_APPLE, ui().flat("mod.heal"), ui().flat("mod.heal.hint"), Ui.GOLD));
    boolean isFrozen = frozen.contains(target.getUniqueId());
    inv.setItem(FREEZE, item(isFrozen ? Material.MAGMA_BLOCK : Material.PACKED_ICE, ui().flat(isFrozen ? "mod.unfreeze" : "mod.freeze"),
        ui().flat("mod.freeze.hint"), NamedTextColor.AQUA));
    boolean inJail = d.jailUntil > now;
    inv.setItem(JAIL, item(inJail ? Material.IRON_DOOR : Material.IRON_BARS,
        inJail ? ui().flat("mod.unjail") : ui().flat("mod.jail"),
        inJail ? ui().flat("mod.jail.left", Ui.v("time", left(d.jailUntil - now))) : ui().flat("mod.jail.hint"), Ui.BAD));
    boolean isMuted = d.muteUntil > now;
    inv.setItem(MUTE, item(isMuted ? Material.NOTE_BLOCK : Material.WRITABLE_BOOK,
        isMuted ? ui().flat("mod.unmute") : ui().flat("mod.mute"),
        isMuted ? ui().flat("mod.mute.left", Ui.v("time", left(d.muteUntil - now))) : ui().flat("mod.mute.hint"), Ui.GOLD));
    inv.setItem(KICK, item(Material.OAK_DOOR, ui().flat("mod.kick"), ui().flat("mod.kick.hint"), Ui.BAD));
    inv.setItem(CLOSE, item(Material.BARRIER, ui().flat("home.gui.close"), "", Ui.SOFT));
    p.openInventory(inv);
  }

  /** Durations to pick for jail or mute. */
  private void openDurations(Player p, Player target, Kind kind) {
    Window w = new Window(kind, target.getUniqueId());
    String title = ui().flat(kind == Kind.JAIL ? "mod.jail.pick" : "mod.mute.pick", Ui.v("name", target.getName()));
    Inventory inv = Bukkit.createInventory(w, 3 * ROW, Component.text(title, NamedTextColor.DARK_RED));
    w.inventory = inv;
    for (int i = 0; i < DURATIONS.length; i++) {
      ItemStack clock = item(kind == Kind.JAIL ? Material.CLOCK : Material.PAPER, span(DURATIONS[i]), ui().flat("mod.pick.hint"), NamedTextColor.WHITE);
      clock.setAmount(Math.min(64, i + 1));
      inv.setItem(ROW + 1 + i, clock);
    }
    inv.setItem(2 * ROW + 4, item(Material.ARROW, ui().flat("mod.back"), "", Ui.SOFT));
    p.openInventory(inv);
  }

  private ItemStack head(Player viewer, Player target) {
    ItemStack stack = new ItemStack(Material.PLAYER_HEAD);
    SkullMeta meta = (SkullMeta) stack.getItemMeta();
    meta.setOwningPlayer(target);
    meta.displayName(Component.text(target.getName(), NamedTextColor.WHITE).decoration(TextDecoration.BOLD, true)
        .decoration(TextDecoration.ITALIC, false));
    List<Component> lore = new ArrayList<>();
    Ranks.Rank r = plugin.ranks().of(target);
    if (r != null) lore.add(line(ui().flat("mod.info.rank", Ui.v("rank", r.name())), r.color()));
    double max = maxHealth(target);
    lore.add(line(ui().flat("mod.info.health", Ui.v("hp", Math.round(target.getHealth())), Ui.v("max", Math.round(max)),
        Ui.v("food", target.getFoodLevel())), Ui.SOFT));
    lore.add(line(ui().flat("mod.info.mode", Ui.v("mode", target.getGameMode().name().toLowerCase(Locale.ROOT)),
        Ui.v("ping", target.getPing())), Ui.SOFT));
    Location l = target.getLocation();
    lore.add(plugin.streamer().hides(viewer, Streamer.COORDS) ? line(ui().flat("home.gui.hidden"), Ui.DIM)
        : line(l.getBlockX() + " / " + l.getBlockY() + " / " + l.getBlockZ() + " · " + l.getWorld().getName(), Ui.SOFT));
    long minutes = target.getStatistic(Statistic.PLAY_ONE_MINUTE) / 20 / 60;
    lore.add(line(ui().flat("mod.info.played", Ui.v("h", minutes / 60), Ui.v("m", minutes % 60)), Ui.SOFT));
    PlayerStore.Data d = plugin.store().get(target.getUniqueId());
    long now = System.currentTimeMillis();
    if (d.jailUntil > now) lore.add(line("⚑ " + ui().flat("mod.jail.left", Ui.v("time", left(d.jailUntil - now))), Ui.BAD));
    if (d.muteUntil > now) lore.add(line("✉ " + ui().flat("mod.mute.left", Ui.v("time", left(d.muteUntil - now))), Ui.GOLD));
    if (frozen.contains(target.getUniqueId())) lore.add(line("❄ " + ui().flat("freeze.title"), NamedTextColor.AQUA));
    meta.lore(lore);
    stack.setItemMeta(meta);
    return stack;
  }

  /** Full hearts: the attribute is MAX_HEALTH since Paper 1.21.3, GENERIC_MAX_HEALTH before. */
  private static double maxHealth(Player p) {
    for (String name : new String[] {"MAX_HEALTH", "GENERIC_MAX_HEALTH"}) {
      try {
        Attribute a = (Attribute) Attribute.class.getField(name).get(null);
        var value = p.getAttribute(a);
        if (value != null) return value.getValue();
      } catch (ReflectiveOperationException | RuntimeException | LinkageError other) {
        // Try the other name.
      }
    }
    return 20;
  }

  private static ItemStack pane() {
    ItemStack stack = new ItemStack(Material.RED_STAINED_GLASS_PANE);
    ItemMeta meta = stack.getItemMeta();
    meta.displayName(Component.text(" "));
    stack.setItemMeta(meta);
    return stack;
  }

  private static Component line(String text, TextColor color) {
    return Component.text(text, color).decoration(TextDecoration.ITALIC, false);
  }

  private static ItemStack item(Material m, String name, String hint, TextColor color) {
    ItemStack stack = new ItemStack(m);
    ItemMeta meta = stack.getItemMeta();
    meta.displayName(Component.text(name, color).decoration(TextDecoration.BOLD, true).decoration(TextDecoration.ITALIC, false));
    if (!hint.isEmpty()) meta.lore(List.of(line(hint, Ui.SOFT)));
    stack.setItemMeta(meta);
    return stack;
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onWindowClick(InventoryClickEvent e) {
    if (!(e.getWhoClicked() instanceof Player p)) return;
    // Someone else's inventory, opened to look at: hands off (operators may change it).
    if (lookOnly.contains(p.getUniqueId())) {
      e.setCancelled(true);
      return;
    }
    if (!(e.getInventory().getHolder() instanceof Window w)) return;
    e.setCancelled(true);
    if (e.getClickedInventory() != e.getInventory() || !staff(p)) return;
    Player target = Bukkit.getPlayer(w.target);
    int slot = e.getRawSlot();
    if (target == null) {
      later(p, p::closeInventory);
      p.sendMessage(ui().fail("player.offline", Ui.v("name", "?")));
      return;
    }
    if (w.kind != Kind.PLAYER) {
      if (slot == 2 * ROW + 4) {
        later(p, () -> open(p, target));
        return;
      }
      int i = slot - ROW - 1;
      if (i < 0 || i >= DURATIONS.length) return;
      long ms = DURATIONS[i];
      later(p, () -> {
        p.closeInventory();
        if (w.kind == Kind.JAIL) jail(p, target, ms, "");
        else mute(p, target, ms, "");
      });
      return;
    }
    switch (slot) {
      case GO -> later(p, () -> {
        p.closeInventory();
        p.teleport(target.getLocation(), PlayerTeleportEvent.TeleportCause.PLUGIN);
      });
      case FETCH -> later(p, () -> {
        p.closeInventory();
        if (mayTouch(p, target)) target.teleport(p.getLocation(), PlayerTeleportEvent.TeleportCause.PLUGIN);
      });
      case HOMES -> later(p, () -> plugin.homeMenu().open(p, target.getUniqueId(), target.getName()));
      case INVENTORY, ENDER -> later(p, () -> {
        Inventory other = slot == INVENTORY ? target.getInventory() : target.getEnderChest();
        if (!p.isOp()) lookOnly.add(p.getUniqueId());
        p.openInventory(other);
      });
      case HEAL -> later(p, () -> {
        target.setHealth(maxHealth(target));
        target.setFoodLevel(20);
        target.setSaturation(20);
        target.setFireTicks(0);
        target.sendMessage(ui().ok("mod.healed"));
        open(p, target);
      });
      case FREEZE -> later(p, () -> {
        freeze(p, target);
        open(p, target);
      });
      case JAIL -> later(p, () -> {
        if (jailed(target)) {
          release(p, target, true);
          open(p, target);
        } else if (mayTouch(p, target)) {
          openDurations(p, target, Kind.JAIL);
        }
      });
      case MUTE -> later(p, () -> {
        if (muted(target)) {
          unmute(p, target);
          open(p, target);
        } else if (mayTouch(p, target)) {
          openDurations(p, target, Kind.MUTE);
        }
      });
      case KICK -> later(p, () -> {
        p.closeInventory();
        if (!mayTouch(p, target)) return;
        target.kick(Component.text(ui().flat("mod.kicked"), NamedTextColor.RED));
        tellTeam("mod.team.kick", Ui.v("by", p.getName()), Ui.v("name", target.getName()));
      });
      case CLOSE -> later(p, p::closeInventory);
      default -> {
        // The glass and the head do nothing.
      }
    }
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onWindowDrag(InventoryDragEvent e) {
    if (e.getInventory().getHolder() instanceof Window || lookOnly.contains(e.getWhoClicked().getUniqueId())) e.setCancelled(true);
  }

  @EventHandler
  public void onWindowClose(InventoryCloseEvent e) {
    lookOnly.remove(e.getPlayer().getUniqueId());
  }

  private void later(Player p, Runnable r) {
    Bukkit.getScheduler().runTask(plugin, () -> {
      if (p.isOnline()) r.run();
    });
  }

  // ---------------------------------------------------------------- commands

  /** /gefaengnis, /frei, /stumm, /entstummen, /einfrieren, /mod. */
  boolean command(CommandSender sender, String name, String[] args) {
    if (!staff(sender)) {
      sender.sendMessage(ui().fail("mod.noperm"));
      return true;
    }
    if (name.equals("gefaengnis") && args.length == 1 && args[0].equalsIgnoreCase("hier") && sender instanceof Player p) {
      if (!p.isOp()) p.sendMessage(ui().fail("mod.noperm"));
      else setCellHere(p);
      return true;
    }
    if (args.length < 1) {
      sender.sendMessage(ui().fail("usage", Ui.v("usage", usage(name))));
      return true;
    }
    Player target = Bukkit.getPlayer(args[0]);
    if (target == null) {
      sender.sendMessage(ui().fail("player.offline", Ui.v("name", args[0])));
      return true;
    }
    switch (name) {
      case "gefaengnis", "stumm" -> {
        Long ms = args.length > 1 ? parse(args[1]) : Long.valueOf(DEFAULT_MS);
        int reasonFrom = args.length > 1 && ms != null ? 2 : 1;
        if (ms == null) ms = DEFAULT_MS;
        String reason = String.join(" ", java.util.Arrays.copyOfRange(args, reasonFrom, args.length));
        if (name.equals("gefaengnis")) jail(sender, target, ms, reason);
        else mute(sender, target, ms, reason);
      }
      case "frei" -> release(sender, target, true);
      case "entstummen" -> unmute(sender, target);
      case "einfrieren" -> freeze(sender, target);
      case "ansehen" -> {
        if (sender instanceof Player p) open(p, target);
        else sender.sendMessage(ui().fail("only.players"));
      }
      default -> {
        return false;
      }
    }
    return true;
  }

  private static String usage(String name) {
    return switch (name) {
      case "gefaengnis" -> "/gefaengnis <spieler> [10m|1h|1d] [grund]";
      case "stumm" -> "/stumm <spieler> [10m|1h|1d] [grund]";
      default -> "/" + name + " <spieler>";
    };
  }
}
