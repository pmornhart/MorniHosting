package de.mornihosting.mornicraft;

import java.time.Duration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerTeleportEvent;

/**
 * Teleports with a wait: a bar at the top runs down while the player stands still; moving cancels it (the bar turns
 * red). Operators go at once. On arrival the destination shows up softly in the middle of the screen.
 * Also remembers where a player was before a teleport or where they died, for /back.
 */
final class Teleporter implements Listener {
  private static final long CHECK_TICKS = 2;
  private static final int TICKS_PER_SECOND = 20;
  private static final long RED_BAR_TICKS = 30;
  /** Moving less than this (blocks, squared) is standing still: looking around and tiny slips are fine. */
  private static final double STILL = 0.3 * 0.3;
  private static final Sound TICK = Sound.sound(Key.key("block.note_block.hat"), Sound.Source.PLAYER, 0.35f, 1.6f);
  private static final Sound GONE = Sound.sound(Key.key("entity.enderman.teleport"), Sound.Source.PLAYER, 0.5f, 1.3f);
  private static final Sound STOP = Sound.sound(Key.key("block.note_block.bass"), Sound.Source.PLAYER, 0.6f, 0.6f);
  private static final Duration FADE_IN = Duration.ofMillis(200);
  private static final Duration STAY = Duration.ofMillis(1200);
  private static final Duration FADE_OUT = Duration.ofMillis(500);

  private record Pending(Location start, Component dest, Supplier<Location> target, Runnable done, int total, int left, BossBar bar) {}

  private final MorniCraft plugin;
  private final Map<UUID, Pending> pending = new HashMap<>();
  private final Map<UUID, Location> back = new HashMap<>();

  Teleporter(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, CHECK_TICKS, CHECK_TICKS);
  }

  /** Sends the player to the target after the wait; `done` runs once they arrived. */
  void teleport(Player p, Component dest, Supplier<Location> target, Runnable done) {
    Pending old = pending.remove(p.getUniqueId());
    if (old != null) p.hideBossBar(old.bar());
    int delay = plugin.settings().teleportDelay();
    if (delay == 0 || p.hasPermission("mornicraft.instant")) {
      go(p, dest, target, done);
      return;
    }
    int ticks = delay * TICKS_PER_SECOND;
    BossBar bar = BossBar.bossBar(barText(dest, delay), 1f, BossBar.Color.GREEN, BossBar.Overlay.PROGRESS);
    p.showBossBar(bar);
    pending.put(p.getUniqueId(), new Pending(p.getLocation(), dest, target, done, ticks, ticks, bar));
  }

  Location back(Player p) {
    return back.get(p.getUniqueId());
  }

  private Component barText(Component dest, int seconds) {
    return plugin.ui().bare("tp.bar", Ui.c("dest", dest), Ui.v("sec", seconds));
  }

  private void go(Player p, Component dest, Supplier<Location> target, Runnable done) {
    Location to = target.get();
    if (to == null) {
      p.sendMessage(plugin.ui().fail("tp.failed"));
      return;
    }
    p.teleportAsync(to, PlayerTeleportEvent.TeleportCause.PLUGIN).thenAccept(ok -> {
      if (!ok) {
        p.sendMessage(plugin.ui().fail("tp.failed"));
        return;
      }
      p.playSound(GONE);
      p.showTitle(Ui.title(Component.empty(), Component.text("➜ ", Ui.ACCENT).append(dest.colorIfAbsent(Ui.ACCENT)),
          FADE_IN, STAY, FADE_OUT));
      if (done != null) done.run();
    });
  }

  private void tick() {
    Iterator<Map.Entry<UUID, Pending>> it = pending.entrySet().iterator();
    while (it.hasNext()) {
      Map.Entry<UUID, Pending> e = it.next();
      Player p = Bukkit.getPlayer(e.getKey());
      Pending w = e.getValue();
      if (p == null) {
        it.remove();
        continue;
      }
      Location now = p.getLocation();
      if (!now.getWorld().equals(w.start().getWorld()) || now.distanceSquared(w.start()) > STILL) {
        it.remove();
        abort(p, w, "tp.cancel");
        continue;
      }
      int left = w.left() - (int) CHECK_TICKS;
      if (left <= 0) {
        it.remove();
        p.hideBossBar(w.bar());
        go(p, w.dest(), w.target(), w.done());
        continue;
      }
      int secondsBefore = (w.left() + TICKS_PER_SECOND - 1) / TICKS_PER_SECOND;
      int seconds = (left + TICKS_PER_SECOND - 1) / TICKS_PER_SECOND;
      w.bar().progress(Math.max(0f, (float) left / w.total()));
      if (seconds != secondsBefore) {
        w.bar().name(barText(w.dest(), seconds));
        p.playSound(TICK);
      }
      e.setValue(new Pending(w.start(), w.dest(), w.target(), w.done(), w.total(), left, w.bar()));
    }
  }

  /** The bar turns red and says why, then goes. */
  private void abort(Player p, Pending w, String why) {
    w.bar().color(BossBar.Color.RED).progress(1f).name(plugin.ui().bare(why));
    p.playSound(STOP);
    Bukkit.getScheduler().runTaskLater(plugin, () -> p.hideBossBar(w.bar()), RED_BAR_TICKS);
  }

  /** Taking damage cancels: no /home out of a fight. */
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onHurt(EntityDamageEvent event) {
    if (!(event.getEntity() instanceof Player p) || event.getFinalDamage() <= 0) return;
    Pending w = pending.remove(p.getUniqueId());
    if (w != null) abort(p, w, "tp.hurt");
  }

  /** On shutdown/reload no bar stays stuck on the screen. */
  void release() {
    pending.forEach((id, w) -> {
      Player p = Bukkit.getPlayer(id);
      if (p != null) p.hideBossBar(w.bar());
    });
    pending.clear();
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onTeleport(PlayerTeleportEvent event) {
    PlayerTeleportEvent.TeleportCause cause = event.getCause();
    if (cause == PlayerTeleportEvent.TeleportCause.PLUGIN || cause == PlayerTeleportEvent.TeleportCause.COMMAND) {
      back.put(event.getPlayer().getUniqueId(), event.getFrom());
    }
  }

  @EventHandler(priority = EventPriority.MONITOR)
  public void onDeath(PlayerDeathEvent event) {
    back.put(event.getPlayer().getUniqueId(), event.getPlayer().getLocation());
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent event) {
    Pending w = pending.remove(event.getPlayer().getUniqueId());
    if (w != null) event.getPlayer().hideBossBar(w.bar());
  }
}
