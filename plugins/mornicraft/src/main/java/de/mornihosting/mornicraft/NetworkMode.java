package de.mornihosting.mornicraft;

import io.papermc.paper.event.player.AsyncChatEvent;
import java.util.List;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerToggleFlightEvent;
import org.bukkit.event.player.PlayerToggleSneakEvent;
import org.bukkit.metadata.FixedMetadataValue;

/**
 * MorniCraft in the MoinMorni network: every second the network's ranks, the streamer mode and the clan tags (for the
 * network chat),
 * and while something happens to a player (join, click, move, sneak …) MorniCraft speaks the player's language.
 * Only registered when the network plugin runs here.
 */
final class NetworkMode implements Listener {
  /** Read by the network plugin: the clan tag in front of the name in the network chat ("MC"), and its colour. */
  static final String TAG = "moinmorni:tag";
  static final String TAG_COLOUR = "moinmorni:tag-colour";
  private static final long EVERY_TICKS = 20;

  private final MorniCraft plugin;

  NetworkMode(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimer(plugin, this::tick, EVERY_TICKS, EVERY_TICKS);
  }

  private int ticks;

  private void tick() {
    plugin.ranks().watchNetwork();
    // The streamer mode is the network's (switched on any server): ● LIVE and the bar follow here.
    plugin.streamer().watchNetwork();
    for (Player p : Bukkit.getOnlinePlayers()) tag(p);
    if (++ticks % SUMMARY_EVERY == 0) {
      for (Player p : Bukkit.getOnlinePlayers()) summary(p.getUniqueId(), true);
    }
  }

  // ---------------------------------------------------------------- what the MoinMorni panel shows about a player

  /** Every few seconds (only what changed is written; the network plugin sends it to the hub). */
  private static final int SUMMARY_EVERY = 5;
  static final String SUMMARY_DIR = "summary";
  private static final int MAX_HOMES_SHOWN = 20;
  private static final int MAX_GRAVES_SHOWN = 10;
  private final java.util.Map<UUID, String> written = new java.util.HashMap<>();

  /**
   * A small read-only summary for the MoinMorni panel: homes, clan, graves, online/AFK, as
   * plugins/MorniCraft/summary/<uuid>.json – the network plugin hands it to the hub ("mode-player").
   */
  void summary(UUID id, boolean online) {
    PlayerStore.Data d = plugin.store().get(id);
    java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
    m.put("online", online);
    Player p = Bukkit.getPlayer(id);
    m.put("afk", online && p != null && plugin.social().isAway(p));
    java.util.List<java.util.Map<String, Object>> homes = new java.util.ArrayList<>();
    d.homes.forEach((name, h) -> {
      if (homes.size() >= MAX_HOMES_SHOWN) return;
      java.util.Map<String, Object> hm = new java.util.LinkedHashMap<>();
      hm.put("name", name);
      hm.put("world", h.world());
      hm.put("x", (int) Math.floor(h.x()));
      hm.put("y", (int) Math.floor(h.y()));
      hm.put("z", (int) Math.floor(h.z()));
      homes.add(hm);
    });
    m.put("homes", homes);
    Clans.Clan c = plugin.clans().of(id);
    if (c != null && plugin.settings().clans()) {
      java.util.Map<String, Object> cm = new java.util.LinkedHashMap<>();
      cm.put("name", c.name);
      cm.put("tag", c.tag);
      cm.put("colour", plugin.clans().tagColour(id));
      cm.put("leader", id.equals(c.leader));
      cm.put("members", c.members.size());
      m.put("clan", cm);
    } else {
      m.put("clan", null);
    }
    java.util.List<java.util.Map<String, Object>> graves = plugin.graves().summaryOf(id);
    m.put("graves", graves.size() > MAX_GRAVES_SHOWN ? graves.subList(0, MAX_GRAVES_SHOWN) : graves);
    String json = new com.google.gson.Gson().toJson(m);
    if (json.equals(written.get(id))) return;
    written.put(id, json);
    try {
      java.nio.file.Path dir = plugin.getDataFolder().toPath().resolve(SUMMARY_DIR);
      java.nio.file.Files.createDirectories(dir);
      java.nio.file.Path tmp = java.nio.file.Files.createTempFile(dir, "s", ".tmp");
      java.nio.file.Files.writeString(tmp, json, java.nio.charset.StandardCharsets.UTF_8);
      java.nio.file.Files.move(tmp, dir.resolve(id + ".json"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    } catch (java.io.IOException e) {
      plugin.getLogger().warning("Could not write the summary for the MoinMorni panel: " + e.getMessage());
    }
  }

  /** The clan tag as metadata on the player (the network plugin puts it into the chat line). */
  private void tag(Player p) {
    String tag = plugin.clans().tagText(p.getUniqueId());
    String shown = p.hasMetadata(TAG) && !p.getMetadata(TAG).isEmpty() ? p.getMetadata(TAG).get(0).asString() : "";
    if (tag.equals(shown)) return;
    if (tag.isEmpty()) {
      p.removeMetadata(TAG, plugin);
      p.removeMetadata(TAG_COLOUR, plugin);
      return;
    }
    p.setMetadata(TAG, new FixedMetadataValue(plugin, tag));
    p.setMetadata(TAG_COLOUR, new FixedMetadataValue(plugin, plugin.clans().tagColour(p.getUniqueId())));
  }

  /** On shutdown: no tags left behind. */
  void release() {
    for (Player p : Bukkit.getOnlinePlayers()) {
      p.removeMetadata(TAG, plugin);
      p.removeMetadata(TAG_COLOUR, plugin);
    }
  }

  // ---------------------------------------------------------------- the player's language while MorniCraft answers

  /** From now on the texts in this player's language (until the event is through, then the one before). */
  private void speak(Event e) {
    Player p = playerOf(e);
    Network net = plugin.network();
    Texts.enter(p != null && net != null ? net.language(p.getUniqueId()) : null);
  }

  private static Player playerOf(Event e) {
    if (e instanceof org.bukkit.event.player.PlayerEvent pe) return pe.getPlayer();
    if (e instanceof InventoryClickEvent ic && ic.getWhoClicked() instanceof Player p) return p;
    if (e instanceof PlayerDeathEvent pd) return pd.getEntity();
    if (e instanceof EntityDamageEvent ed && ed.getEntity() instanceof Player p) return p;
    if (e instanceof AsyncChatEvent ac) return ac.getPlayer();
    return null;
  }

  private static void done() {
    Texts.leave();
  }

  // Lowest: before every other MorniCraft listener; monitor: after all of them.
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerJoinEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerJoinEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerQuitEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerQuitEvent e) {
    summary(e.getPlayer().getUniqueId(), false);
    written.remove(e.getPlayer().getUniqueId());
    // The data was needed once more for the summary: out of the cache again (as Welcome does).
    plugin.store().forget(e.getPlayer().getUniqueId());
    done();
  }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(InventoryClickEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(InventoryClickEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerInteractEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerInteractEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerInteractEntityEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerInteractEntityEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerMoveEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerMoveEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerToggleSneakEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerToggleSneakEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerToggleFlightEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerToggleFlightEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerRespawnEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerRespawnEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(PlayerDeathEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(PlayerDeathEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(EntityDamageEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(EntityDamageEvent e) { done(); }
  @EventHandler(priority = EventPriority.LOWEST)
  public void a(AsyncChatEvent e) { speak(e); }
  @EventHandler(priority = EventPriority.MONITOR)
  public void z(AsyncChatEvent e) { done(); }

  /** The commands MorniCraft leaves to the network (they reach the server only through an alias). */
  static final List<String> NETWORK_COMMANDS = List.of("msg", "r", "gefaengnis", "frei", "stumm", "entstummen",
      "rang", "abzeichen");
}
