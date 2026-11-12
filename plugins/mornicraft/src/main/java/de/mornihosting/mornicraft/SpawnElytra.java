package de.mornihosting.mornicraft;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityToggleGlideEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerSwapHandItemsEvent;
import org.bukkit.event.player.PlayerToggleFlightEvent;
import org.bukkit.event.player.PlayerToggleSneakEvent;
import org.bukkit.util.Vector;

/**
 * The start elytra: on the spawn island a double jump lifts you up and you glide like with an elytra – no elytra
 * needed, no fall damage. Once in the air, F (Bedrock: sneak) gives one boost forward. It only starts at the spawn;
 * the glide lasts until you land.
 */
final class SpawnElytra implements Listener {
  private static final long CHECK_TICKS = 2;
  /** Right after the launch the player is still near the ground: don't count that as landing. */
  private static final long LAUNCH_GRACE_MS = 600;
  /** Fall damage is also forgiven a moment after landing (the landing tick itself). */
  private static final long SOFT_LANDING_MS = 1500;
  private static final double LIFT = 0.9;
  private static final double BOOST = 1.7;
  private static final double BOOST_LIFT = 0.25;
  private static final Sound WHOOSH = Sound.sound(Key.key("entity.phantom.flap"), Sound.Source.PLAYER, 0.7f, 1.2f);
  private static final Sound ROCKET = Sound.sound(Key.key("entity.firework_rocket.launch"), Sound.Source.PLAYER, 0.8f, 1f);

  private final MorniCraft plugin;
  /** Players we allowed to "fly" (only to catch the double jump). */
  private final Set<UUID> armed = new HashSet<>();
  private final Map<UUID, Long> gliding = new HashMap<>();
  private final Set<UUID> boosted = new HashSet<>();
  private final Set<UUID> hinted = new HashSet<>();
  private final Map<UUID, Long> landed = new HashMap<>();

  SpawnElytra(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, CHECK_TICKS, CHECK_TICKS);
  }

  private static boolean survival(Player p) {
    return p.getGameMode() == GameMode.SURVIVAL || p.getGameMode() == GameMode.ADVENTURE;
  }


  private boolean atSpawn(Player p) {
    Settings s = plugin.settings();
    return s.elytra() && SpawnArea.inside(p.getLocation(), s.elytraRadius());
  }

  private void tick() {
    long now = System.currentTimeMillis();
    for (Player p : Bukkit.getOnlinePlayers()) {
      UUID id = p.getUniqueId();
      if (!survival(p)) {
        armed.remove(id);
        gliding.remove(id);
        continue;
      }
      Long since = gliding.get(id);
      if (since != null) {
        boolean down = (p.isOnGround() || p.isInWater() || p.isInLava()) && now - since > LAUNCH_GRACE_MS;
        if (down) {
          land(p);
        } else if (!p.isGliding()) {
          p.setGliding(true);
        }
        continue;
      }
      if (atSpawn(p)) {
        if (!p.getAllowFlight()) {
          p.setAllowFlight(true);
          armed.add(id);
        }
        if (p.isOnGround() && hinted.add(id)) p.sendActionBar(plugin.ui().words("elytra.ready"));
      } else {
        hinted.remove(id);
        if (armed.remove(id)) {
          p.setFlying(false);
          p.setAllowFlight(false);
        }
      }
    }
  }

  private void land(Player p) {
    UUID id = p.getUniqueId();
    gliding.remove(id);
    boosted.remove(id);
    landed.put(id, System.currentTimeMillis());
    p.setGliding(false);
  }

  /** The double jump: instead of flying, a lift and the glide. */
  @EventHandler(priority = EventPriority.HIGH)
  public void onDoubleJump(PlayerToggleFlightEvent e) {
    Player p = e.getPlayer();
    if (!e.isFlying() || !armed.contains(p.getUniqueId()) || !survival(p)) return;
    e.setCancelled(true);
    p.setFlying(false);
    p.setAllowFlight(false);
    armed.remove(p.getUniqueId());
    p.setVelocity(p.getVelocity().setY(LIFT));
    gliding.put(p.getUniqueId(), System.currentTimeMillis());
    Bukkit.getScheduler().runTaskLater(plugin, () -> p.setGliding(true), 2L);
    p.playSound(WHOOSH);
    if (plugin.settings().elytraBoost()) {
      String key = plugin.bedrock().is(p) ? "elytra.key.bedrock" : "elytra.key.java";
      p.sendActionBar(plugin.ui().words("elytra.boost", Ui.c("key", plugin.ui().bare(key))));
    }
  }

  /** Without an elytra the game would end the glide at once: keep it while in the air. */
  @EventHandler(priority = EventPriority.HIGH)
  public void onGlide(EntityToggleGlideEvent e) {
    if (e.getEntity() instanceof Player p && !e.isGliding() && gliding.containsKey(p.getUniqueId())
        && !p.isOnGround() && !p.isInWater()) {
      e.setCancelled(true);
    }
  }

  private boolean boost(Player p) {
    UUID id = p.getUniqueId();
    if (!gliding.containsKey(id) || !plugin.settings().elytraBoost() || !boosted.add(id)) return false;
    Vector dir = p.getLocation().getDirection().multiply(BOOST);
    p.setVelocity(dir.setY(dir.getY() + BOOST_LIFT));
    p.playSound(ROCKET);
    return true;
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onBoostJava(PlayerSwapHandItemsEvent e) {
    if (gliding.containsKey(e.getPlayer().getUniqueId()) && boost(e.getPlayer())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onBoostBedrock(PlayerToggleSneakEvent e) {
    if (e.isSneaking() && plugin.bedrock().is(e.getPlayer())) boost(e.getPlayer());
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onFall(EntityDamageEvent e) {
    if (!(e.getEntity() instanceof Player p)) return;
    EntityDamageEvent.DamageCause cause = e.getCause();
    if (cause != EntityDamageEvent.DamageCause.FALL && cause != EntityDamageEvent.DamageCause.FLY_INTO_WALL) return;
    Long at = landed.get(p.getUniqueId());
    boolean soft = gliding.containsKey(p.getUniqueId()) || (at != null && System.currentTimeMillis() - at < SOFT_LANDING_MS);
    if (soft) e.setCancelled(true);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    UUID id = e.getPlayer().getUniqueId();
    if (armed.remove(id)) e.getPlayer().setAllowFlight(false);
    gliding.remove(id);
    boosted.remove(id);
    hinted.remove(id);
    landed.remove(id);
  }

  /** On shutdown/reload nobody keeps the "allow flight" we handed out. */
  void release() {
    for (UUID id : armed) {
      Player p = Bukkit.getPlayer(id);
      if (p != null) p.setAllowFlight(false);
    }
    armed.clear();
  }
}
