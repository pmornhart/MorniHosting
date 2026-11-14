package de.mornihosting.mornicraft;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Particle;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.block.Block;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.DragonBattle;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.AreaEffectCloud;
import org.bukkit.entity.ComplexEntityPart;
import org.bukkit.entity.EnderCrystal;
import org.bukkit.entity.EnderDragon;
import org.bukkit.entity.Enderman;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EvokerFangs;
import org.bukkit.entity.ExperienceOrb;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Phantom;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.entity.ShulkerBullet;
import org.bukkit.entity.SmallFireball;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntitySpawnEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.util.Vector;

/**
 * The mighty ender dragon (switch "hard-dragon", everything else under "dragon" – set in the dashboard): more health,
 * harder hits, and its own attacks every few seconds – lightning where players stand (sparks a moment before), a rain
 * of fireballs, fangs out of the ground (smoke a moment before), endermen that go for the players, homing shots that
 * make players float, a wing blast for whoever is too close. At ¾, ½ and ¼ of its health it calls its brood
 * (phantoms); low on health it rages: attacks twice as often and three end crystals stand on the pillars again.
 * Beaten, it gives extra experience, a dragon egg every time, and everyone reads who fought it. Switched off, dragons
 * go back to normal (with the same share of health they had).
 */
final class HardDragon implements Listener {
  enum Attack {
    LIGHTNING,
    FIREBALLS,
    FANGS,
    ENDERMEN,
    LEVITATION,
    SHOCKWAVE;

    String id() {
      return name().toLowerCase(Locale.ROOT);
    }
  }

  private static final double NORMAL = 200;
  /** Minecraft allows at most this much health; above it, hits on the dragon count less instead. */
  private static final double MAX_REAL_HEALTH = 1024;
  private static final double[] WAVES = {0.75, 0.5, 0.25};
  private static final double PERCENT = 100.0;
  private static final int MAX_ORBS = 12;
  private static final int CHECK_TICKS = 100;
  private static final long LOOP_TICKS = 20L;
  private static final int BROOD_HEIGHT = 14;
  private static final long WARN_DELAY = 100L;
  /** Players this far from the middle of the End take part in the fight. */
  private static final double ARENA = 200;
  /** Lightning and fangs: a warning this long before they hit. */
  private static final int WARNING_TICKS = 30;
  private static final int WARNING_STEP = 5;
  private static final double SHOCKWAVE_REACH = 20;
  private static final double SHOCKWAVE_PUSH = 2.2;
  private static final double SHOCKWAVE_LIFT = 0.9;
  private static final double SHOCKWAVE_HIT = 4;
  private static final int FIREBALLS = 5;
  private static final int FIREBALLS_RAGE = 8;
  private static final int ENDERMEN = 2;
  private static final double ENDERMEN_REACH = 32;
  private static final int CRYSTALS = 3;
  /** The ten obsidian pillars stand on a circle with this radius round the middle of the End. */
  private static final double PILLARS = 42;
  private static final int PILLAR_COUNT = 10;
  /** The death animation lasts about ten seconds; the egg comes when it is over. */
  private static final long EGG_DELAY = 220L;
  private static final Sound GROWL = Sound.sound(Key.key("entity.ender_dragon.growl"), Sound.Source.HOSTILE, 1f, 0.8f);
  private static final Sound FLAP = Sound.sound(Key.key("entity.ender_dragon.flap"), Sound.Source.HOSTILE, 1.4f, 0.6f);
  private static final Sound SHOOT = Sound.sound(Key.key("entity.blaze.shoot"), Sound.Source.HOSTILE, 1f, 0.8f);
  private static final Sound PREPARE = Sound.sound(Key.key("entity.evoker.prepare_attack"), Sound.Source.HOSTILE, 1f, 0.7f);
  private static final Sound SCREAM = Sound.sound(Key.key("entity.enderman.scream"), Sound.Source.HOSTILE, 1f, 0.8f);
  private static final Sound SHULKER = Sound.sound(Key.key("entity.shulker.shoot"), Sound.Source.HOSTILE, 1f, 0.8f);

  private final MorniCraft plugin;
  private final NamespacedKey hard;
  private final NamespacedKey applied;
  private final NamespacedKey waves;
  private final NamespacedKey rage;
  private final NamespacedKey brood;
  private final Map<UUID, Set<String>> fighters = new ConcurrentHashMap<>();
  private final Map<UUID, Long> nextAttack = new ConcurrentHashMap<>();

  HardDragon(MorniCraft plugin) {
    this.plugin = plugin;
    this.hard = new NamespacedKey(plugin, "hard_dragon");
    this.applied = new NamespacedKey(plugin, "dragon_health");
    this.waves = new NamespacedKey(plugin, "dragon_waves");
    this.rage = new NamespacedKey(plugin, "dragon_rage");
    this.brood = new NamespacedKey(plugin, "dragon_brood");
    Bukkit.getScheduler().runTaskTimer(plugin, this::check, 40L, CHECK_TICKS);
    Bukkit.getScheduler().runTaskTimer(plugin, this::attackLoop, 60L, LOOP_TICKS);
  }

  private boolean on() {
    return plugin.settings().hardDragon();
  }

  private Settings.Dragon cfg() {
    return plugin.settings().dragon();
  }

  private static List<EnderDragon> dragons() {
    List<EnderDragon> out = new ArrayList<>();
    for (World w : Bukkit.getWorlds()) {
      if (w.getEnvironment() != World.Environment.THE_END) continue;
      for (EnderDragon d : w.getEntitiesByClass(EnderDragon.class)) {
        if (!d.isDead() && d.getHealth() > 0) out.add(d);
      }
    }
    return out;
  }

  /** Every few seconds: make the End's dragons fit the settings (also dragons that were there before). */
  void check() {
    boolean on = on();
    for (EnderDragon d : dragons()) {
      Integer health = d.getPersistentDataContainer().get(applied, PersistentDataType.INTEGER);
      if (on && (!isHard(d) || health == null || health != cfg().health())) strengthen(d);
      else if (!on && isHard(d)) weaken(d);
    }
  }

  boolean isHard(Entity e) {
    return e.getPersistentDataContainer().has(hard, PersistentDataType.BYTE);
  }

  private boolean raging(Entity e) {
    return e.getPersistentDataContainer().has(rage, PersistentDataType.BYTE);
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

  private double share(EnderDragon d) {
    AttributeInstance a = maxHealth(d);
    return d.getHealth() / Math.max(1, a == null ? realHealth() : a.getValue());
  }

  /** The health it really gets (at most what Minecraft allows). */
  private double realHealth() {
    return Math.min(cfg().health(), MAX_REAL_HEALTH);
  }

  void strengthen(EnderDragon d) {
    resize(d, realHealth());
    d.getPersistentDataContainer().set(hard, PersistentDataType.BYTE, (byte) 1);
    d.getPersistentDataContainer().set(applied, PersistentDataType.INTEGER, cfg().health());
    rename(d);
  }

  void weaken(EnderDragon d) {
    resize(d, NORMAL);
    d.getPersistentDataContainer().remove(hard);
    d.getPersistentDataContainer().remove(applied);
    d.getPersistentDataContainer().remove(rage);
    d.customName(null);
    nextAttack.remove(d.getUniqueId());
    bar(d, BarColor.PINK);
  }

  private void rename(EnderDragon d) {
    String name = plugin.ui().flat(raging(d) ? "dragon.name.rage" : "dragon.name");
    d.customName(Component.text(name, raging(d) ? Ui.MAIL : Ui.BAD).decoration(TextDecoration.BOLD, true));
    bar(d, raging(d) ? BarColor.PURPLE : BarColor.RED);
  }

  private static void bar(EnderDragon d, BarColor color) {
    DragonBattle battle = d.getWorld().getEnderDragonBattle();
    if (battle != null && battle.getBossBar() != null) battle.getBossBar().setColor(color);
  }

  @EventHandler(ignoreCancelled = true)
  public void onSpawn(EntitySpawnEvent e) {
    if (e.getEntity() instanceof EnderDragon d && on()) {
      Bukkit.getScheduler().runTask(plugin, () -> {
        if (d.isValid() && !isHard(d)) strengthen(d);
      });
    }
  }

  /** The dragon behind a hit: itself, one of its parts, its fireball or shot, or the breath it left. */
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
    if (d != null && isHard(d)) e.setDamage(e.getDamage() * cfg().damagePercent() / PERCENT);
  }

  /** More health than Minecraft allows: every hit on the dragon counts that much less. */
  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onDragonHit(EntityDamageEvent e) {
    EnderDragon d = dragonOf(e.getEntity());
    if (d != null && isHard(d) && cfg().health() > MAX_REAL_HEALTH) {
      e.setDamage(e.getDamage() * MAX_REAL_HEALTH / cfg().health());
    }
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
    Bukkit.getScheduler().runTask(plugin, () -> marks(d));
  }

  private void marks(EnderDragon d) {
    if (!d.isValid() || d.getHealth() <= 0) return;
    double share = share(d);
    Integer done = d.getPersistentDataContainer().get(waves, PersistentDataType.INTEGER);
    int n = done == null ? 0 : done;
    while (n < WAVES.length && share <= WAVES[n]) {
      n++;
      d.getPersistentDataContainer().set(waves, PersistentDataType.INTEGER, n);
      if (cfg().brood()) wave(d, n);
    }
    if (cfg().ragePercent() > 0 && share <= cfg().ragePercent() / PERCENT && !raging(d)) enrage(d);
  }

  /** Low on health: it rages – attacks twice as often, and three end crystals stand on the pillars again. */
  void enrage(EnderDragon d) {
    d.getPersistentDataContainer().set(rage, PersistentDataType.BYTE, (byte) 1);
    rename(d);
    World w = d.getWorld();
    for (Player p : w.getPlayers()) {
      p.sendMessage(plugin.ui().note("☠", Ui.MAIL, "dragon.rage"));
      p.playSound(GROWL);
    }
    Location at = d.getLocation();
    for (int i = 0; i < 6; i++) {
      double a = Math.PI * 2 * i / 6;
      w.strikeLightningEffect(at.clone().add(Math.cos(a) * 8, 0, Math.sin(a) * 8));
    }
    if (cfg().crystals() && crystals(w, CRYSTALS) > 0) {
      for (Player p : w.getPlayers()) p.sendMessage(plugin.ui().note("✦", Ui.MAIL, "dragon.crystals"));
    }
    nextAttack.put(d.getUniqueId(), System.currentTimeMillis() + interval(d) / 2);
  }

  /** Brings back up to this many end crystals on pillars that lost theirs. */
  int crystals(World w, int count) {
    int made = 0;
    for (int i = 0; i < PILLAR_COUNT && made < count; i++) {
      double angle = 2 * (-Math.PI + Math.PI / PILLAR_COUNT * i);
      int x = (int) Math.floor(PILLARS * Math.cos(angle));
      int z = (int) Math.floor(PILLARS * Math.sin(angle));
      Block top = pillarTop(w, x, z);
      if (top == null) continue;
      Location at = top.getLocation().add(0.5, 1, 0.5);
      boolean has = !w.getNearbyEntities(at, 3, 3, 3, en -> en instanceof EnderCrystal).isEmpty();
      if (has) continue;
      w.spawn(at, EnderCrystal.class, c -> c.setShowingBottom(false));
      w.strikeLightningEffect(at);
      made++;
    }
    return made;
  }

  /** The top of a pillar: the highest obsidian or bedrock (above it maybe fire or an iron cage). */
  private static Block pillarTop(World w, int x, int z) {
    int y = w.getHighestBlockYAt(x, z);
    for (int dy = 0; dy < 8; dy++) {
      Block b = w.getBlockAt(x, y - dy, z);
      if (b.getType() == Material.OBSIDIAN || b.getType() == Material.BEDROCK) return b;
    }
    return null;
  }

  // ---- the attacks ----------------------------------------------------------------------------------------------

  private long interval(EnderDragon d) {
    long ms = cfg().attackSeconds() * 1000L;
    return raging(d) ? ms / 2 : ms;
  }

  /** Who takes part: players in the End round the middle, not in creative or spectator mode. */
  private static List<Player> fighters(World w) {
    List<Player> out = new ArrayList<>();
    for (Player p : w.getPlayers()) {
      GameMode m = p.getGameMode();
      if (m == GameMode.CREATIVE || m == GameMode.SPECTATOR || p.isDead()) continue;
      Location l = p.getLocation();
      if (l.getX() * l.getX() + l.getZ() * l.getZ() <= ARENA * ARENA) out.add(p);
    }
    return out;
  }

  private void attackLoop() {
    if (!on()) return;
    long now = System.currentTimeMillis();
    for (EnderDragon d : dragons()) {
      if (!isHard(d) || d.getPhase() == EnderDragon.Phase.DYING) continue;
      List<Player> players = fighters(d.getWorld());
      if (players.isEmpty()) continue;
      Long next = nextAttack.get(d.getUniqueId());
      if (next == null) {
        nextAttack.put(d.getUniqueId(), now + interval(d));
        continue;
      }
      // A shorter time set in the dashboard counts at once, not only after the next attack.
      if (next > now + interval(d)) next = now + interval(d);
      nextAttack.put(d.getUniqueId(), next);
      if (now < next) continue;
      nextAttack.put(d.getUniqueId(), now + interval(d));
      List<Attack> can = available(d, players);
      if (!can.isEmpty()) attack(d, can.get(ThreadLocalRandom.current().nextInt(can.size())), players);
    }
  }

  private List<Attack> available(EnderDragon d, List<Player> players) {
    Settings.Dragon c = cfg();
    List<Attack> out = new ArrayList<>();
    if (c.lightning()) out.add(Attack.LIGHTNING);
    if (c.fireballs()) out.add(Attack.FIREBALLS);
    if (c.fangs()) out.add(Attack.FANGS);
    if (c.endermen()) out.add(Attack.ENDERMEN);
    if (c.levitation()) out.add(Attack.LEVITATION);
    if (c.shockwave() && !near(d, players).isEmpty()) out.add(Attack.SHOCKWAVE);
    return out;
  }

  private static List<Player> near(EnderDragon d, List<Player> players) {
    Location at = d.getLocation();
    return players.stream().filter(p -> p.getLocation().distanceSquared(at) <= SHOCKWAVE_REACH * SHOCKWAVE_REACH).toList();
  }

  void attack(EnderDragon d, Attack a, List<Player> players) {
    for (Player p : d.getWorld().getPlayers()) {
      p.sendActionBar(plugin.ui().note("☠", Ui.BAD, "dragon.attack." + a.id()));
    }
    switch (a) {
      case LIGHTNING -> lightning(d, players);
      case FIREBALLS -> fireballs(d, players);
      case FANGS -> fangs(d, players);
      case ENDERMEN -> endermen(d, players);
      case LEVITATION -> levitation(d, players);
      case SHOCKWAVE -> shockwave(d, near(d, players));
      default -> { }
    }
  }

  /** Sparks where each player stands; a moment later lightning strikes there (in rage, round it too). */
  private void lightning(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    boolean angry = raging(d);
    List<Location> spots = new ArrayList<>();
    for (Player p : players) {
      Location at = p.getLocation().clone();
      spots.add(at);
      if (angry) {
        spots.add(at.clone().add(3, 0, 0));
        spots.add(at.clone().add(-3, 0, 0));
      }
    }
    warn(w, spots, () -> spots.forEach(w::strikeLightning), "ELECTRIC_SPARK", "CRIT");
  }

  /** Small fireballs fall from the sky round every player. */
  private void fireballs(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    int count = raging(d) ? FIREBALLS_RAGE : FIREBALLS;
    ThreadLocalRandom r = ThreadLocalRandom.current();
    for (Player p : players) {
      p.playSound(SHOOT);
      for (int i = 0; i < count; i++) {
        Location target = p.getLocation().clone().add(r.nextDouble(-4, 4), 0, r.nextDouble(-4, 4));
        Location from = target.clone().add(r.nextDouble(-3, 3), 20 + r.nextDouble(4), r.nextDouble(-3, 3));
        Vector dir = target.toVector().subtract(from.toVector()).normalize();
        w.spawn(from, SmallFireball.class, f -> {
          f.setShooter(d);
          f.setIsIncendiary(false);
          f.setDirection(dir.clone().multiply(0.1));
          f.setVelocity(dir.clone().multiply(1.2));
        });
      }
    }
  }

  /** Smoke rises in a ring round every player; a moment later fangs bite out of the ground there. */
  private void fangs(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    List<Location> spots = new ArrayList<>();
    for (Player p : players) {
      Location ground = ground(p.getLocation());
      if (ground == null) continue;
      p.playSound(PREPARE);
      spots.add(ground);
      for (int i = 0; i < 8; i++) {
        double a = Math.PI * 2 * i / 8;
        Location ring = ground(ground.clone().add(Math.cos(a) * 2, 1, Math.sin(a) * 2));
        if (ring != null) spots.add(ring);
      }
    }
    warn(w, spots, () -> spots.forEach(at -> w.spawn(at, EvokerFangs.class, f -> f.setOwner(d))),
        "LARGE_SMOKE", "SMOKE_LARGE", "SMOKE");
  }

  /** The ground below a spot (at most six blocks down), or null when there is none (flying, the void). */
  private static Location ground(Location from) {
    World w = from.getWorld();
    for (int dy = 0; dy <= 6; dy++) {
      Block b = w.getBlockAt(from.getBlockX(), from.getBlockY() - dy, from.getBlockZ());
      if (b.getType().isSolid()) return b.getLocation().add(0.5, 1, 0.5);
    }
    return null;
  }

  /** Endermen near every player go for them; when there are too few, new ones come. */
  private void endermen(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    ThreadLocalRandom r = ThreadLocalRandom.current();
    for (Player p : players) {
      p.playSound(SCREAM);
      List<Enderman> near = new ArrayList<>(w.getNearbyEntities(p.getLocation(), ENDERMEN_REACH, 16, ENDERMEN_REACH,
          e -> e instanceof Enderman).stream().map(Enderman.class::cast).toList());
      near.sort(Comparator.comparingDouble(e -> e.getLocation().distanceSquared(p.getLocation())));
      List<Enderman> chosen = new ArrayList<>(near.subList(0, Math.min(ENDERMEN, near.size())));
      while (chosen.size() < ENDERMEN) {
        double a = r.nextDouble(Math.PI * 2);
        Location spot = ground(p.getLocation().clone().add(Math.cos(a) * 7, 3, Math.sin(a) * 7));
        if (spot == null) spot = p.getLocation().clone().add(Math.cos(a) * 4, 0, Math.sin(a) * 4);
        chosen.add(w.spawn(spot, Enderman.class,
            e -> e.getPersistentDataContainer().set(brood, PersistentDataType.BYTE, (byte) 1)));
      }
      for (Enderman e : chosen) {
        e.setTarget(p);
        particle(w, e.getLocation().add(0, 1.5, 0), 20, 0.4, "PORTAL");
      }
    }
  }

  /** Homing shots from the dragon at every player (two in rage): whoever is hit floats up. */
  private void levitation(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    int each = raging(d) ? 2 : 1;
    for (Player p : players) {
      p.playSound(SHULKER);
      for (int i = 0; i < each; i++) {
        w.spawn(d.getLocation().add(0, 2 + i, 0), ShulkerBullet.class, b -> {
          b.setShooter(d);
          b.setTarget(p);
        });
      }
    }
  }

  /** A blast from its wings: players close by are thrown away and hurt a little. */
  private void shockwave(EnderDragon d, List<Player> players) {
    World w = d.getWorld();
    Location at = d.getLocation();
    particle(w, at, 6, 3, "EXPLOSION_EMITTER", "EXPLOSION_HUGE", "EXPLOSION");
    for (Player p : players) {
      p.playSound(FLAP);
      Vector away = p.getLocation().toVector().subtract(at.toVector()).setY(0);
      if (away.lengthSquared() < 0.01) away = new Vector(1, 0, 0);
      p.setVelocity(away.normalize().multiply(SHOCKWAVE_PUSH).setY(SHOCKWAVE_LIFT));
      p.damage(SHOCKWAVE_HIT, d);
    }
  }

  /** Particles on the spots for a moment, then the hit. */
  private void warn(World w, List<Location> spots, Runnable hit, String... particle) {
    int[] left = {WARNING_TICKS};
    Bukkit.getScheduler().runTaskTimer(plugin, task -> {
      if (left[0] <= 0) {
        task.cancel();
        hit.run();
        return;
      }
      for (Location at : spots) particle(w, at.clone().add(0, 0.2, 0), 8, 0.6, particle);
      left[0] -= WARNING_STEP;
    }, 0L, WARNING_STEP);
  }

  /** The first particle this server knows (names changed in 1.20.5). */
  private static void particle(World w, Location at, int count, double spread, String... names) {
    for (String name : names) {
      try {
        w.spawnParticle(Particle.valueOf(name), at, count, spread, spread * 0.3, spread, 0.02);
        return;
      } catch (IllegalArgumentException | NoSuchFieldError unknown) {
        // Try the next name.
      }
    }
  }

  /** The brood: phantoms above the players in the End, more with every wave. */
  private void wave(EnderDragon d, int n) {
    List<Player> here = fighters(d.getWorld());
    for (Player p : d.getWorld().getPlayers()) {
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
    nextAttack.remove(d.getUniqueId());
    Location at = exit(w);
    int xp = cfg().xp();
    int orbs = Math.min(MAX_ORBS, Math.max(1, xp / 100));
    for (int i = 0; xp > 0 && i < orbs; i++) {
      int each = xp / orbs + (i < xp % orbs ? 1 : 0);
      w.spawn(at.clone().add((i % 4) - 1.5, 2 + i % 3, (i / 4) - 1), ExperienceOrb.class, o -> o.setExperience(each));
    }
    for (Entity helper : w.getEntities()) {
      if ((helper instanceof Phantom || helper instanceof Enderman)
          && helper.getPersistentDataContainer().has(brood, PersistentDataType.BYTE)) helper.remove();
    }
    // The egg: normally only at the first victory – then the game puts it there itself.
    DragonBattle battle = w.getEnderDragonBattle();
    if (cfg().egg() && battle != null && battle.hasBeenPreviouslyKilled()) {
      Bukkit.getScheduler().runTaskLater(plugin, () -> egg(w), EGG_DELAY);
    }
    Set<String> who = fighters.remove(d.getUniqueId());
    String names = who == null || who.isEmpty() ? "–" : String.join(", ", who);
    for (Player p : Bukkit.getOnlinePlayers()) {
      p.sendMessage(plugin.ui().note("★", Ui.GOLD, "dragon.dead", Ui.v("names", names)));
    }
  }

  /**
   * A dragon egg on top of the exit portal's pillar (where the first one lies too), or as an item when that spot is
   * taken. The pillar is found from the portal itself – the height map is not reliable while nobody is near.
   */
  private static void egg(World w) {
    DragonBattle battle = w.getEnderDragonBattle();
    Location portal = battle == null ? null : battle.getEndPortalLocation();
    int x = portal == null ? 0 : portal.getBlockX();
    int z = portal == null ? 0 : portal.getBlockZ();
    w.getChunkAt(x >> 4, z >> 4);
    Block b = portal == null ? w.getHighestBlockAt(x, z).getRelative(0, 1, 0) : w.getBlockAt(x, portal.getBlockY(), z);
    for (int i = 0; i < 16 && !b.getType().isAir(); i++) b = b.getRelative(0, 1, 0);
    if (b.getType().isAir() && b.getRelative(0, -1, 0).getType() == Material.BEDROCK) {
      b.setType(Material.DRAGON_EGG);
    } else {
      w.dropItemNaturally(b.getLocation().add(0.5, 0.5, 0.5), new ItemStack(Material.DRAGON_EGG));
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

  /** "/mornicraft drache <angriff|wut|kristalle>" (admins): starts an attack at once – to try it out. */
  void command(CommandSender sender, String what) {
    List<EnderDragon> all = dragons().stream().filter(this::isHard).toList();
    if (all.isEmpty()) {
      sender.sendMessage(plugin.ui().fail("dragon.none"));
      return;
    }
    EnderDragon d = all.get(0);
    String w = what.toLowerCase(Locale.ROOT);
    if (w.equals("wut") || w.equals("rage")) {
      enrage(d);
    } else if (w.equals("kristalle") || w.equals("crystals")) {
      crystals(d.getWorld(), CRYSTALS);
    } else if (w.equals("brut") || w.equals("brood")) {
      wave(d, 1);
    } else {
      Attack a = attackNamed(w);
      if (a == null) {
        sender.sendMessage(plugin.ui().fail("usage", Ui.v("usage", "/mornicraft drache <" + String.join("|", ATTACK_NAMES) + ">")));
        return;
      }
      List<Player> players = a == Attack.SHOCKWAVE ? near(d, fighters(d.getWorld())) : fighters(d.getWorld());
      attack(d, a, players);
    }
    sender.sendMessage(plugin.ui().ok("dragon.done"));
  }

  /** German and English names for the attacks (for the command). */
  static final List<String> ATTACK_NAMES = List.of("blitze", "feuerregen", "zaehne", "endermen", "schweben", "fluegel",
      "brut", "wut", "kristalle");

  private static Attack attackNamed(String w) {
    return switch (w) {
      case "blitze", "lightning" -> Attack.LIGHTNING;
      case "feuerregen", "fireballs" -> Attack.FIREBALLS;
      case "zaehne", "zähne", "fangs" -> Attack.FANGS;
      case "endermen" -> Attack.ENDERMEN;
      case "schweben", "levitation" -> Attack.LEVITATION;
      case "fluegel", "flügel", "shockwave" -> Attack.SHOCKWAVE;
      default -> null;
    };
  }
}
