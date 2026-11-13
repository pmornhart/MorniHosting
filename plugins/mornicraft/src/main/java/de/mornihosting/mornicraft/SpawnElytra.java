package de.mornihosting.mornicraft;

import com.destroystokyo.paper.event.player.PlayerElytraBoostEvent;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Level;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityToggleGlideEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerGameModeChangeEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerSwapHandItemsEvent;
import org.bukkit.event.player.PlayerToggleFlightEvent;
import org.bukkit.event.player.PlayerToggleSneakEvent;
import org.bukkit.inventory.ItemFlag;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.util.Vector;

/**
 * The start elytra: on the spawn island a double jump puts wings on and you glide (no lift – jump off the edge) – no
 * elytra of your own needed, no fall damage. Once in the air, F (Bedrock: sneak) gives one boost forward. The glide lasts until you land.
 *
 * <p>For the flight the player wears a real elytra (marked, unbreakable, cursed so it can't be taken off and vanishes
 * on death): since Minecraft 1.21.2 the game only lets you glide with a glider on, and Bedrock never glides without
 * one. Whatever was on the chest goes back when you land – it is also written to disk first, so a crash mid-flight
 * never costs a chestplate (checked again on the next join).
 */
final class SpawnElytra implements Listener {
  private static final long CHECK_TICKS = 2;
  /** Right after the launch the player is still near the ground: don't count that as landing. */
  private static final long LAUNCH_GRACE_MS = 600;
  /** Fall damage is also forgiven a moment after landing (the landing tick itself). */
  private static final long SOFT_LANDING_MS = 1500;
  /** Nobody glides forever (stuck somewhere without ever touching ground): the wings go after this. */
  private static final long MAX_GLIDE_MS = 5 * 60 * 1000;
  private static final long GLIDE_START_TICKS = 2;
  private static final double BOOST = 1.7;
  private static final double BOOST_LIFT = 0.25;
  private static final Sound WHOOSH = Sound.sound(Key.key("entity.phantom.flap"), Sound.Source.PLAYER, 0.7f, 1.2f);
  private static final Sound ROCKET = Sound.sound(Key.key("entity.firework_rocket.launch"), Sound.Source.PLAYER, 0.8f, 1f);
  /** Marks a backup of "nothing on the chest". */
  private static final String EMPTY = "";

  /** The vanilla advancement for getting an elytra ("end/elytra"). */
  private static final String ELYTRA_ADVANCEMENT = "end/elytra";

  private final MorniCraft plugin;
  private final NamespacedKey mark;
  /** Players we allowed to "fly" (only to catch the double jump). */
  private final Set<UUID> armed = new HashSet<>();
  private final Map<UUID, Long> gliding = new HashMap<>();
  private final Set<UUID> boosted = new HashSet<>();
  private final Set<UUID> hinted = new HashSet<>();
  private final Set<UUID> creativeHinted = new HashSet<>();
  private final Map<UUID, Long> landed = new HashMap<>();

  SpawnElytra(MorniCraft plugin) {
    this.plugin = plugin;
    this.mark = new NamespacedKey(plugin, "start_elytra");
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, CHECK_TICKS, CHECK_TICKS);
    // After a reload the players are already online: anyone still wearing wings gets their chest back.
    for (Player p : Bukkit.getOnlinePlayers()) cleanUp(p);
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
        armed.remove(id); // creative and spectator fly anyway: leave their flight alone
        if (gliding.containsKey(id)) land(p);
        if (atSpawn(p) && p.getGameMode() == GameMode.CREATIVE && creativeHinted.add(id)) {
          p.sendActionBar(plugin.ui().words("elytra.creative"));
        }
        continue;
      }
      Long since = gliding.get(id);
      if (since != null) {
        boolean down = (p.isOnGround() || p.isInWater() || p.isInLava()) && now - since > LAUNCH_GRACE_MS;
        if (down || now - since > MAX_GLIDE_MS || p.isInsideVehicle()) {
          land(p);
        } else if (!p.isGliding()) {
          p.setGliding(true);
        }
        continue;
      }
      // Not flying (any more) but still wearing the wings – whatever went wrong, the chest piece comes back.
      if (p.isOnGround() && isStartElytra(p.getInventory().getChestplate())) takeOff(p);
      if (atSpawn(p)) {
        if (!p.getAllowFlight()) {
          p.setAllowFlight(true);
          armed.add(id);
        }
        if (p.isOnGround() && hinted.add(id)) {
          p.sendActionBar(plugin.ui().words(plugin.bedrock().is(p) ? "elytra.ready.bedrock" : "elytra.ready"));
        }
      } else {
        hinted.remove(id);
        disarm(p);
      }
    }
  }

  private void disarm(Player p) {
    if (armed.remove(p.getUniqueId())) {
      p.setFlying(false);
      p.setAllowFlight(false);
    }
  }

  private void land(Player p) {
    UUID id = p.getUniqueId();
    gliding.remove(id);
    boosted.remove(id);
    landed.put(id, System.currentTimeMillis());
    p.setGliding(false);
    takeOff(p);
  }

  /** The double jump: instead of flying, the wings and the glide – no lift, the player keeps their own swing. */
  @EventHandler(priority = EventPriority.HIGH)
  public void onDoubleJump(PlayerToggleFlightEvent e) {
    Player p = e.getPlayer();
    UUID id = p.getUniqueId();
    if (!e.isFlying() || !armed.contains(id) || !survival(p)) return;
    e.setCancelled(true);
    if (plugin.combat().inCombat(p)) {
      // In a fight there is no flying away.
      p.setFlying(false);
      p.sendActionBar(plugin.ui().fail("combat.noelytra"));
      return;
    }
    p.setFlying(false);
    p.setAllowFlight(false);
    armed.remove(id);
    putOn(p);
    // No push upwards (Philip): the glide simply goes on with the swing the player has – best jumping off the edge.
    gliding.put(id, System.currentTimeMillis());
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (p.isOnline() && gliding.containsKey(id)) p.setGliding(true);
    }, GLIDE_START_TICKS);
    p.playSound(WHOOSH);
    if (plugin.settings().elytraBoost()) {
      String key = plugin.bedrock().is(p) ? "elytra.key.bedrock" : "elytra.key.java";
      p.sendActionBar(plugin.ui().words("elytra.boost", Ui.c("key", plugin.ui().bare(key))));
    }
  }

  // ---------------------------------------------------------------- the wings

  /**
   * The start elytra is not a real elytra: putting it on must not count as "Sky's the limit" (Hinterm Horizont geht's
   * weiter). The advancement only comes with a real elytra somewhere in the inventory.
   */
  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onAdvancement(com.destroystokyo.paper.event.player.PlayerAdvancementCriterionGrantEvent e) {
    if (!ELYTRA_ADVANCEMENT.equals(e.getAdvancement().getKey().getKey())) return;
    Player p = e.getPlayer();
    boolean real = java.util.Arrays.stream(p.getInventory().getContents())
        .anyMatch(i -> i != null && i.getType() == Material.ELYTRA && !isStartElytra(i));
    if (!real) e.setCancelled(true);
  }

  boolean isStartElytra(ItemStack item) {
    if (item == null || item.getType() != Material.ELYTRA || !item.hasItemMeta()) return false;
    return item.getItemMeta().getPersistentDataContainer().has(mark, PersistentDataType.BYTE);
  }

  private ItemStack startElytra() {
    ItemStack wings = new ItemStack(Material.ELYTRA);
    ItemMeta meta = wings.getItemMeta();
    meta.displayName(Component.text(plugin.ui().flat("elytra.item"), NamedTextColor.AQUA)
        .decoration(TextDecoration.ITALIC, false));
    meta.setUnbreakable(true);
    meta.addEnchant(Enchantment.BINDING_CURSE, 1, true);
    meta.addEnchant(Enchantment.VANISHING_CURSE, 1, true);
    meta.addItemFlags(ItemFlag.HIDE_ENCHANTS, ItemFlag.HIDE_UNBREAKABLE);
    meta.getPersistentDataContainer().set(mark, PersistentDataType.BYTE, (byte) 1);
    wings.setItemMeta(meta);
    return wings;
  }

  /** A fight started: no take-off from the ground any more (already in the air keeps gliding). */
  void landNow(Player p) {
    if (armed.remove(p.getUniqueId()) && survival(p)) {
      p.setAllowFlight(false);
      p.setFlying(false);
    }
  }

  /** Wings on; whatever was on the chest is kept (on disk first). An own elytra stays where it is. */
  private void putOn(Player p) {
    PlayerInventory inv = p.getInventory();
    ItemStack chest = inv.getChestplate();
    if (chest != null && chest.getType() == Material.ELYTRA) return;
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    d.elytraBackup = chest == null || chest.getType().isAir()
        ? EMPTY
        : Base64.getEncoder().encodeToString(chest.serializeAsBytes());
    plugin.store().save(p.getUniqueId(), d);
    inv.setChestplate(startElytra());
  }

  /**
   * Wings off (wherever they are), the old chest piece back. Only when the wings were really there: after a crash the
   * game may load an older inventory in which the chest piece never left – then the backup is just dropped (giving
   * it back would make two of them).
   */
  private void takeOff(Player p) {
    PlayerInventory inv = p.getInventory();
    boolean wore = isStartElytra(inv.getChestplate());
    boolean found = wore;
    for (int slot = 0; slot < inv.getSize(); slot++) {
      if (isStartElytra(inv.getItem(slot))) {
        inv.setItem(slot, null);
        found = true;
      }
    }
    if (isStartElytra(p.getItemOnCursor())) {
      p.setItemOnCursor(null);
      found = true;
    }
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (d.elytraBackup == null) return;
    if (found) {
      ItemStack back = restore(p, d.elytraBackup);
      if (back == null && !d.elytraBackup.isEmpty()) return; // unreadable: keep the backup, never lose it
      if (back != null) {
        ItemStack chest = inv.getChestplate();
        if (wore || chest == null || chest.getType().isAir()) {
          inv.setChestplate(back);
        } else {
          inv.addItem(back).values().forEach(left -> p.getWorld().dropItemNaturally(p.getLocation(), left));
        }
      }
    }
    d.elytraBackup = null;
    plugin.store().save(p.getUniqueId(), d);
  }

  private ItemStack restore(Player p, String backup) {
    if (backup.isEmpty()) return null;
    try {
      return ItemStack.deserializeBytes(Base64.getDecoder().decode(backup));
    } catch (RuntimeException ex) {
      plugin.getLogger().log(Level.WARNING, "Could not give " + p.getName() + " their chest item back", ex);
      return null;
    }
  }

  private void cleanUp(Player p) {
    UUID id = p.getUniqueId();
    if (gliding.containsKey(id)) p.setGliding(false);
    gliding.remove(id);
    boosted.remove(id);
    takeOff(p);
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onJoin(PlayerJoinEvent e) {
    cleanUp(e.getPlayer());
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onQuit(PlayerQuitEvent e) {
    Player p = e.getPlayer();
    UUID id = p.getUniqueId();
    if (armed.remove(id)) p.setAllowFlight(false);
    cleanUp(p);
    hinted.remove(id);
    creativeHinted.remove(id);
    landed.remove(id);
  }

  @EventHandler(priority = EventPriority.HIGHEST)
  public void onDeath(PlayerDeathEvent e) {
    Player p = e.getEntity();
    boolean wore = e.getDrops().removeIf(this::isStartElytra) || isStartElytra(p.getInventory().getChestplate());
    gliding.remove(p.getUniqueId());
    boosted.remove(p.getUniqueId());
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    if (e.getKeepInventory() || d.elytraBackup == null || !wore) {
      takeOff(p);
      return;
    }
    // The inventory drops: the old chest piece drops with it, the wings just vanish.
    ItemStack back = restore(p, d.elytraBackup);
    if (back == null && !d.elytraBackup.isEmpty()) return;
    if (back != null) e.getDrops().add(back);
    d.elytraBackup = null;
    plugin.store().save(p.getUniqueId(), d);
  }

  @EventHandler
  public void onGameMode(PlayerGameModeChangeEvent e) {
    GameMode mode = e.getNewGameMode();
    if (mode == GameMode.CREATIVE || mode == GameMode.SPECTATOR) {
      Player p = e.getPlayer();
      Bukkit.getScheduler().runTask(plugin, () -> {
        if (p.isOnline()) cleanUp(p);
      });
    } else {
      creativeHinted.remove(e.getPlayer().getUniqueId());
    }
  }

  /** The wings can't be moved, dropped or swapped. */
  @EventHandler(priority = EventPriority.HIGH)
  public void onClick(InventoryClickEvent e) {
    boolean hotbar = e.getHotbarButton() >= 0
        && isStartElytra(e.getWhoClicked().getInventory().getItem(e.getHotbarButton()));
    if (isStartElytra(e.getCurrentItem()) || isStartElytra(e.getCursor()) || hotbar) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onDrag(InventoryDragEvent e) {
    if (isStartElytra(e.getOldCursor())) e.setCancelled(true);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onDrop(PlayerDropItemEvent e) {
    if (isStartElytra(e.getItemDrop().getItemStack())) e.getItemDrop().remove();
  }

  /** No rockets with the borrowed wings – they are for the way down from the spawn, not for touring the world. */
  @EventHandler(priority = EventPriority.HIGH)
  public void onRocket(PlayerElytraBoostEvent e) {
    if (isStartElytra(e.getPlayer().getInventory().getChestplate())) e.setCancelled(true);
  }

  /** Keep the glide while in the air (the game might end it, e.g. after touching a wall). */
  @EventHandler(priority = EventPriority.HIGH)
  public void onGlide(EntityToggleGlideEvent e) {
    if (e.getEntity() instanceof Player p && !e.isGliding() && gliding.containsKey(p.getUniqueId())
        && !p.isOnGround() && !p.isInWater()) {
      e.setCancelled(true);
    }
  }

  // ---------------------------------------------------------------- boost and soft landing

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

  /** On shutdown/reload nobody keeps the "allow flight" we handed out, and everyone gets their chest back. */
  void release() {
    for (UUID id : armed) {
      Player p = Bukkit.getPlayer(id);
      if (p != null) p.setAllowFlight(false);
    }
    armed.clear();
    for (Player p : Bukkit.getOnlinePlayers()) cleanUp(p);
  }
}
