package de.mornihosting.mornicraft;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.DragonBattle;
import org.bukkit.entity.AreaEffectCloud;
import org.bukkit.entity.ComplexEntityPart;
import org.bukkit.entity.EnderDragon;
import org.bukkit.entity.Entity;
import org.bukkit.entity.ExperienceOrb;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Phantom;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntitySpawnEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.persistence.PersistentDataType;

/**
 * The mighty ender dragon (switchable, "hard-dragon"): three times the health, harder hits (claws, fireballs and
 * breath), and at three quarters, half and a quarter of its health it calls its brood – phantoms that dive at the
 * players in the End. Beaten, it gives extra experience and everyone reads who fought it. Switched off, dragons go
 * back to normal (with the same share of health they had).
 */
final class HardDragon implements Listener {
  static final double HEALTH = 600;
  private static final double NORMAL = 200;
  private static final double HIT = 1.75;
  private static final double[] WAVES = {0.75, 0.5, 0.25};
  private static final int BONUS_ORBS = 12;
  private static final int BONUS_EACH = 250;
  private static final int CHECK_TICKS = 100;
  private static final int BROOD_HEIGHT = 14;
  private static final long WARN_DELAY = 100L;
  private static final Sound GROWL = Sound.sound(Key.key("entity.ender_dragon.growl"), Sound.Source.HOSTILE, 1f, 0.8f);

  private final MorniCraft plugin;
  private final NamespacedKey hard;
  private final NamespacedKey waves;
  private final NamespacedKey brood;
  private final Map<UUID, Set<String>> fighters = new ConcurrentHashMap<>();

  HardDragon(MorniCraft plugin) {
    this.plugin = plugin;
    this.hard = new NamespacedKey(plugin, "hard_dragon");
    this.waves = new NamespacedKey(plugin, "dragon_waves");
    this.brood = new NamespacedKey(plugin, "dragon_brood");
    Bukkit.getScheduler().runTaskTimer(plugin, this::check, 40L, CHECK_TICKS);
  }

  private boolean on() {
    return plugin.settings().hardDragon();
  }

  /** Every few seconds: make the End's dragons fit the switch (also dragons that were there before). */
  void check() {
    boolean on = on();
    for (World w : Bukkit.getWorlds()) {
      if (w.getEnvironment() != World.Environment.THE_END) continue;
      for (EnderDragon d : w.getEntitiesByClass(EnderDragon.class)) {
        if (d.isDead() || d.getHealth() <= 0) continue;
        if (on && !isHard(d)) strengthen(d);
        else if (!on && isHard(d)) weaken(d);
      }
    }
  }

  boolean isHard(Entity e) {
    return e.getPersistentDataContainer().has(hard, PersistentDataType.BYTE);
  }

  /** Full hearts: the attribute is MAX_HEALTH since Paper 1.21.3, GENERIC_MAX_HEALTH before. */
  static AttributeInstance maxHealth(LivingEntity e) {
    for (String name : new String[] {"MAX_HEALTH", "GENERIC_MAX_HEALTH"}) {
      try {
        AttributeInstance a = e.getAttribute((Attribute) Attribute.class.getField(name).get(null));
        if (a != null) return a;
      } catch (ReflectiveOperationException | RuntimeException | LinkageError other) {
        // Try the other name.
      }
    }
    return null;
  }

  private void resize(EnderDragon d, double to) {
    AttributeInstance a = maxHealth(d);
    if (a == null) return;
    double share = d.getHealth() / Math.max(1, a.getValue());
    a.setBaseValue(to);
    d.setHealth(Math.max(1, Math.min(to, share * to)));
  }

  void strengthen(EnderDragon d) {
    resize(d, HEALTH);
    d.getPersistentDataContainer().set(hard, PersistentDataType.BYTE, (byte) 1);
    d.customName(Component.text(plugin.ui().flat("dragon.name"), Ui.BAD).decoration(TextDecoration.BOLD, true));
    DragonBattle battle = d.getWorld().getEnderDragonBattle();
    if (battle != null && battle.getBossBar() != null) battle.getBossBar().setColor(BarColor.RED);
  }

  void weaken(EnderDragon d) {
    resize(d, NORMAL);
    d.getPersistentDataContainer().remove(hard);
    d.customName(null);
    DragonBattle battle = d.getWorld().getEnderDragonBattle();
    if (battle != null && battle.getBossBar() != null) battle.getBossBar().setColor(BarColor.PINK);
  }

  @EventHandler(ignoreCancelled = true)
  public void onSpawn(EntitySpawnEvent e) {
    if (e.getEntity() instanceof EnderDragon d && on()) {
      Bukkit.getScheduler().runTask(plugin, () -> {
        if (d.isValid() && !isHard(d)) strengthen(d);
      });
    }
  }

  /** The dragon behind a hit: itself, one of its parts, its fireball or the breath it left. */
  private EnderDragon dragonOf(Entity e) {
    if (e instanceof EnderDragon d) return d;
    if (e instanceof ComplexEntityPart part && part.getParent() instanceof EnderDragon d) return d;
    if (e instanceof Projectile p && p.getShooter() instanceof EnderDragon d) return d;
    if (e instanceof AreaEffectCloud c && c.getSource() instanceof EnderDragon d) return d;
    return null;
  }

  private static Player playerOf(Entity e) {
    if (e instanceof Player p) return p;
    if (e instanceof Projectile pr && pr.getShooter() instanceof Player p) return p;
    return null;
  }

  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onHitPlayer(EntityDamageByEntityEvent e) {
    if (!(e.getEntity() instanceof Player)) return;
    EnderDragon d = dragonOf(e.getDamager());
    if (d != null && isHard(d)) e.setDamage(e.getDamage() * HIT);
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onHurt(EntityDamageEvent e) {
    EnderDragon d = dragonOf(e.getEntity());
    if (d == null || !isHard(d)) return;
    if (e instanceof EntityDamageByEntityEvent by) {
      Player p = playerOf(by.getDamager());
      if (p != null) fighters.computeIfAbsent(d.getUniqueId(), id -> new LinkedHashSet<>()).add(p.getName());
    }
    // After the hit: has it dropped below the next mark?
    Bukkit.getScheduler().runTask(plugin, () -> {
      if (!d.isValid() || d.getHealth() <= 0) return;
      AttributeInstance a = maxHealth(d);
      double share = d.getHealth() / (a == null ? HEALTH : a.getValue());
      Integer done = d.getPersistentDataContainer().get(waves, PersistentDataType.INTEGER);
      int n = done == null ? 0 : done;
      while (n < WAVES.length && share <= WAVES[n]) {
        n++;
        d.getPersistentDataContainer().set(waves, PersistentDataType.INTEGER, n);
        wave(d, n);
      }
    });
  }

  /** The brood: phantoms above the players in the End, more with every wave. */
  private void wave(EnderDragon d, int n) {
    List<Player> here = new ArrayList<>(d.getWorld().getPlayers());
    for (Player p : here) {
      p.sendMessage(plugin.ui().note("☠", Ui.BAD, "dragon.wave"));
      p.playSound(GROWL);
    }
    if (here.isEmpty()) return;
    int count = 2 + n * 2;
    for (int i = 0; i < count; i++) {
      Player target = here.get(i % here.size());
      Location at = target.getLocation().add((i % 3 - 1) * 4, BROOD_HEIGHT, (i % 2) * 4 - 2);
      d.getWorld().spawn(at, Phantom.class, ph -> {
        ph.setSize(2);
        ph.customName(Component.text(plugin.ui().flat("dragon.brood"), Ui.MAIL));
        ph.getPersistentDataContainer().set(brood, PersistentDataType.BYTE, (byte) 1);
        ph.setTarget(target);
      });
    }
  }

  @EventHandler
  public void onDeath(EntityDeathEvent e) {
    if (!(e.getEntity() instanceof EnderDragon d) || !isHard(d)) return;
    World w = d.getWorld();
    Location at = exit(w);
    for (int i = 0; i < BONUS_ORBS; i++) {
      w.spawn(at.clone().add((i % 4) - 1.5, 2 + i % 3, (i / 4) - 1), ExperienceOrb.class, o -> o.setExperience(BONUS_EACH));
    }
    for (Phantom ph : w.getEntitiesByClass(Phantom.class)) {
      if (ph.getPersistentDataContainer().has(brood, PersistentDataType.BYTE)) ph.remove();
    }
    Set<String> who = fighters.remove(d.getUniqueId());
    String names = who == null || who.isEmpty() ? "–" : String.join(", ", who);
    for (Player p : Bukkit.getOnlinePlayers()) {
      p.sendMessage(plugin.ui().note("★", Ui.GOLD, "dragon.dead", Ui.v("names", names)));
    }
  }

  /** Where the exit portal is (the dragon's experience lands there too). */
  private static Location exit(World w) {
    DragonBattle battle = w.getEnderDragonBattle();
    Location portal = battle == null ? null : battle.getEndPortalLocation();
    if (portal != null) return portal.clone().add(0.5, 1, 0.5);
    return w.getHighestBlockAt(0, 0).getLocation().add(0.5, 2, 0.5);
  }

  @EventHandler
  public void onEnterEnd(PlayerChangedWorldEvent e) {
    Player p = e.getPlayer();
    if (!on() || p.getWorld().getEnvironment() != World.Environment.THE_END) return;
    // On the first visit the dragon only appears a moment after the player.
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (!p.isOnline() || p.getWorld().getEnvironment() != World.Environment.THE_END) return;
      boolean alive = p.getWorld().getEntitiesByClass(EnderDragon.class).stream().anyMatch(d -> !d.isDead());
      if (alive) p.sendMessage(plugin.ui().note("☠", Ui.BAD, "dragon.warn"));
    }, WARN_DELAY);
  }
}
