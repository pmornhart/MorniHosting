package de.mornihosting.mornicraft;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.entity.AreaEffectCloud;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.entity.TNTPrimed;
import org.bukkit.entity.Tameable;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerKickEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/**
 * Combat log: whoever hits another player, or is hit by one, is "in combat" for a few seconds (a red bar counts
 * down; every new hit starts it again). Meanwhile no teleports (/spawn, /home, /tpa, /back), no start elytra and
 * only chat commands. Logging out in combat costs your life: you die where you stood (everything goes into your
 * grave), everyone is told, and you hear why when you come back. A server stop or a kick by the team doesn't count.
 */
final class Combat implements Listener {
  private static final long SECOND_MS = 1000;
  private static final long TICK = 20;
  /** Commands that still work in combat (talking only). */
  private static final Set<String> ALLOWED = Set.of("msg", "tell", "w", "whisper", "r", "reply", "mail", "ping",
      "info", "befehle", "commands", "rules", "regeln", "streamer", "leiste", "team", "abzeichen");

  private final MorniCraft plugin;
  /** In combat until (ms). Read by the command check too. */
  private final Map<UUID, Long> until = new ConcurrentHashMap<>();
  /** Who hit whom last (for the message when someone logs out). */
  private final Map<UUID, UUID> opponent = new ConcurrentHashMap<>();
  private final Map<UUID, BossBar> bars = new HashMap<>();
  /** Players who left on purpose by the server (kick by the team, shutdown): not punished. */
  private final Set<UUID> excused = ConcurrentHashMap.newKeySet();

  Combat(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, TICK, TICK / 4);
  }

  private Ui ui() {
    return plugin.ui();
  }

  private boolean enabled() {
    return plugin.settings().combatSeconds() > 0;
  }

  boolean inCombat(Player p) {
    Long t = until.get(p.getUniqueId());
    return t != null && t > System.currentTimeMillis();
  }

  /** Seconds left (rounded up). */
  int left(Player p) {
    Long t = until.get(p.getUniqueId());
    return t == null ? 0 : (int) Math.max(0, (t - System.currentTimeMillis() + SECOND_MS - 1) / SECOND_MS);
  }

  /** Who is really behind a hit: the player, the archer, the owner of the wolf, whoever lit the TNT … */
  private static Player attackerOf(Entity damager) {
    if (damager instanceof Player p) return p;
    if (damager instanceof Projectile pr && pr.getShooter() instanceof Player p) return p;
    if (damager instanceof Tameable t && t.getOwner() instanceof Player p) return p;
    if (damager instanceof TNTPrimed tnt && tnt.getSource() instanceof Player p) return p;
    if (damager instanceof AreaEffectCloud cloud && cloud.getSource() instanceof Player p) return p;
    return null;
  }

  private static boolean fighter(Player p) {
    return p.getGameMode() == GameMode.SURVIVAL || p.getGameMode() == GameMode.ADVENTURE;
  }

  /** A real hit between two players (after the spawn and other protections said yes). */
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onHit(EntityDamageByEntityEvent e) {
    if (!enabled() || !(e.getEntity() instanceof Player victim)) return;
    Player attacker = attackerOf(e.getDamager());
    if (attacker == null || attacker.equals(victim) || !fighter(attacker) || !fighter(victim)) return;
    tag(attacker, victim);
    tag(victim, attacker);
  }

  private void tag(Player p, Player other) {
    boolean fresh = !inCombat(p);
    until.put(p.getUniqueId(), System.currentTimeMillis() + plugin.settings().combatSeconds() * SECOND_MS);
    opponent.put(p.getUniqueId(), other.getUniqueId());
    if (fresh) {
      p.sendActionBar(ui().fail("combat.start", Ui.v("name", other.getName()), Ui.v("sec", plugin.settings().combatSeconds())));
      plugin.teleporter().cancel(p);
      plugin.elytra().landNow(p);
    }
  }

  /** Every quarter second: the bars count down; time up = out of combat. */
  private void tick() {
    long now = System.currentTimeMillis();
    for (Player p : Bukkit.getOnlinePlayers()) {
      UUID id = p.getUniqueId();
      Long t = until.get(id);
      BossBar bar = bars.get(id);
      if (t == null || t <= now) {
        if (t != null) {
          until.remove(id);
          opponent.remove(id);
          p.sendActionBar(ui().ok("combat.over"));
        }
        if (bar != null) {
          p.hideBossBar(bar);
          bars.remove(id);
        }
        continue;
      }
      float progress = Math.min(1f, (float) (t - now) / (plugin.settings().combatSeconds() * SECOND_MS));
      Component name = Component.text("⚔ ", NamedTextColor.RED).append(ui().bare("combat.bar", Ui.v("sec", left(p))));
      if (bar == null) {
        bar = BossBar.bossBar(name, progress, BossBar.Color.RED, BossBar.Overlay.PROGRESS);
        bars.put(id, bar);
        p.showBossBar(bar);
      } else {
        bar.name(name);
        bar.progress(progress);
      }
    }
  }

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onCommand(PlayerCommandPreprocessEvent e) {
    Player p = e.getPlayer();
    if (!inCombat(p) || p.hasPermission(Moderation.PERMISSION)) return;
    String label = e.getMessage().substring(1).split(" ")[0].toLowerCase(Locale.ROOT);
    String bare = label.contains(":") ? label.substring(label.indexOf(':') + 1) : label;
    if (ALLOWED.contains(bare)) return;
    e.setCancelled(true);
    p.sendMessage(ui().fail("combat.nocommand", Ui.v("sec", left(p))));
  }

  /** Killed: the fight is over for both. */
  @EventHandler(priority = EventPriority.MONITOR)
  public void onDeath(PlayerDeathEvent e) {
    clear(e.getEntity());
  }

  private void clear(Player p) {
    until.remove(p.getUniqueId());
    opponent.remove(p.getUniqueId());
    BossBar bar = bars.remove(p.getUniqueId());
    if (bar != null) p.hideBossBar(bar);
  }

  /** Kicked by the team or the server: that's not running away. */
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onKick(PlayerKickEvent e) {
    excused.add(e.getPlayer().getUniqueId());
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onQuit(PlayerQuitEvent e) {
    Player p = e.getPlayer();
    UUID id = p.getUniqueId();
    boolean fled = inCombat(p) && !excused.remove(id) && !plugin.isStopping();
    UUID other = opponent.get(id);
    clear(p);
    if (!fled) return;
    // Running away costs the life: died where they stood – their things go into the grave like any death.
    PlayerStore.Data d = plugin.store().get(id);
    d.combatLogged = true;
    plugin.store().save(id, d);
    Player foe = other == null ? null : Bukkit.getPlayer(other);
    if (foe != null) {
      Bukkit.getScheduler().runTask(plugin, () -> clear(foe));
    }
    p.setHealth(0);
    String foeName = foe == null ? "?" : foe.getName();
    Component line = Component.text("⚔ ", NamedTextColor.RED)
        .append(ui().words("combat.logged", Ui.v("name", p.getName()), Ui.v("foe", foeName)));
    Bukkit.getOnlinePlayers().stream().filter(o -> !o.equals(p)).forEach(o -> o.sendMessage(line));
    plugin.getLogger().info(p.getName() + " logged out in combat with " + foeName + " – killed");
  }

  /** Back after running away: they hear why they are at the spawn without their things. */
  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    Player p = e.getPlayer();
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    excused.remove(p.getUniqueId());
    if (!d.combatLogged) return;
    d.combatLogged = false;
    plugin.store().save(p.getUniqueId(), d);
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (p.isOnline()) p.sendMessage(ui().fail("combat.youlogged"));
    }, TICK * 2);
  }

  void release() {
    bars.forEach((id, bar) -> {
      Player p = Bukkit.getPlayer(id);
      if (p != null) p.hideBossBar(bar);
    });
    bars.clear();
  }
}
