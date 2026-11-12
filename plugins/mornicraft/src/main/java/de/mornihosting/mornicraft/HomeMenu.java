package de.mornihosting.mornicraft;

import io.papermc.paper.event.player.AsyncChatEvent;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.ClickType;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

/**
 * /home and /homes: a small chest window with a bed per home. Left click = go there, right click twice = delete; an
 * empty grey bed = a free place – click it, type the name in the chat, and the home is set where you stand.
 */
final class HomeMenu implements Listener {
  /** Homes per row (the outer columns stay free, like a frame). */
  private static final int PER_ROW = 7;
  private static final int MAX_ROWS = 4;
  private static final int SLOTS_PER_ROW = 9;
  /** How long a "click again to delete" stays armed. */
  private static final long CONFIRM_MS = 5000;
  /** How long the chat waits for a new home's name. */
  private static final long NAME_WAIT_MS = 60_000;
  private static final Material[] BEDS = {
      Material.RED_BED, Material.LIME_BED, Material.LIGHT_BLUE_BED, Material.YELLOW_BED, Material.MAGENTA_BED,
      Material.ORANGE_BED, Material.CYAN_BED, Material.PINK_BED, Material.PURPLE_BED, Material.GREEN_BED,
      Material.BLUE_BED, Material.BROWN_BED, Material.WHITE_BED, Material.BLACK_BED};

  private final MorniCraft plugin;
  /** Who is typing a new home's name, and until when. */
  private final Map<UUID, Long> naming = new ConcurrentHashMap<>();
  /** A home armed for deletion by a first right click: player → home name and time. */
  private final Map<UUID, Map.Entry<String, Long>> deleting = new HashMap<>();

  HomeMenu(MorniCraft plugin) {
    this.plugin = plugin;
  }

  /** Our window, recognised by its holder: whose homes (the viewer's own, or a player's for the team). */
  private static final class Window implements InventoryHolder {
    private final List<String> homes;
    private final UUID owner;
    private final String ownerName;
    private Inventory inventory;

    Window(List<String> homes, UUID owner, String ownerName) {
      this.homes = homes;
      this.owner = owner;
      this.ownerName = ownerName;
    }

    @Override
    public Inventory getInventory() {
      return inventory;
    }
  }

  private Ui ui() {
    return plugin.ui();
  }

  private int places(Player p, int used) {
    if (p.hasPermission("mornicraft.unlimitedhomes")) return Math.min(PER_ROW * MAX_ROWS, used + 1);
    return Math.min(PER_ROW * MAX_ROWS, Math.max(used, plugin.settings().maxHomes()));
  }

  private static int slotOf(int index) {
    return (index / PER_ROW + 1) * SLOTS_PER_ROW + 1 + index % PER_ROW;
  }

  void open(Player p) {
    open(p, p.getUniqueId(), p.getName());
  }

  /** The window with someone's homes: the own ones (with free beds), or – for the team – another player's. */
  void open(Player p, UUID owner, String ownerName) {
    boolean own = owner.equals(p.getUniqueId());
    PlayerStore.Data d = plugin.store().get(owner);
    List<String> names = new ArrayList<>(d.homes.keySet());
    int places = own ? places(p, names.size()) : Math.max(1, Math.min(PER_ROW * MAX_ROWS, names.size()));
    int rows = Math.max(1, (places + PER_ROW - 1) / PER_ROW);
    Window w = new Window(names, owner, ownerName);
    String title = own ? ui().flat("home.title") : ui().flat("home.gui.of", Ui.v("name", ownerName));
    Inventory inv = Bukkit.createInventory(w, (rows + 2) * SLOTS_PER_ROW, Component.text(title, NamedTextColor.DARK_GREEN));
    w.inventory = inv;
    boolean hideCoords = plugin.streamer().hides(p, Streamer.COORDS);
    Map.Entry<String, Long> armed = deleting.get(p.getUniqueId());
    for (int i = 0; i < places; i++) {
      if (i < names.size()) {
        String name = names.get(i);
        PlayerStore.Home h = d.homes.get(name);
        boolean confirm = armed != null && armed.getKey().equals(name)
            && System.currentTimeMillis() - armed.getValue() < CONFIRM_MS;
        List<Component> lore = new ArrayList<>();
        lore.add(hideCoords ? line(ui().flat("home.gui.hidden"), Ui.DIM)
            : line(Math.round(h.x()) + " / " + Math.round(h.y()) + " / " + Math.round(h.z()) + " · " + h.world(), Ui.SOFT));
        lore.add(Component.empty());
        lore.add(line("➜ " + ui().flat("home.gui.go"), Ui.ACCENT));
        lore.add(confirm ? line("✖ " + ui().flat("home.gui.confirm"), Ui.BAD) : line("✖ " + ui().flat("home.gui.delete"), Ui.SOFT));
        inv.setItem(slotOf(i), item(confirm ? Material.BARRIER : BEDS[i % BEDS.length],
            Component.text("⌂ " + name, NamedTextColor.WHITE).decoration(TextDecoration.BOLD, true), lore));
      } else if (own) {
        inv.setItem(slotOf(i), item(Material.LIGHT_GRAY_BED, Component.text("+ " + ui().flat("home.gui.new"), Ui.ACCENT),
            List.of(line(ui().flat("home.gui.newhint"), Ui.SOFT))));
      }
    }
    int bottom = (rows + 1) * SLOTS_PER_ROW;
    inv.setItem(bottom + 4, item(Material.COMPASS,
        Component.text(ui().flat("home.gui.count", Ui.v("n", names.size()), Ui.v("max", places)), NamedTextColor.WHITE),
        List.of(line(ui().flat("home.gui.help"), Ui.SOFT))));
    inv.setItem(bottom + 8, item(Material.OAK_DOOR, Component.text(ui().flat("home.gui.close"), Ui.SOFT), List.of()));
    p.openInventory(inv);
  }

  private static Component line(String text, TextColor color) {
    return Component.text(text, color).decoration(TextDecoration.ITALIC, false);
  }

  private static ItemStack item(Material material, Component name, List<Component> lore) {
    ItemStack stack = new ItemStack(material);
    ItemMeta meta = stack.getItemMeta();
    meta.displayName(name.decoration(TextDecoration.ITALIC, false));
    meta.lore(lore);
    stack.setItemMeta(meta);
    return stack;
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onClick(InventoryClickEvent e) {
    if (!(e.getInventory().getHolder() instanceof Window w) || !(e.getWhoClicked() instanceof Player p)) return;
    e.setCancelled(true);
    if (e.getClickedInventory() != e.getInventory()) return;
    int slot = e.getRawSlot();
    int rows = e.getInventory().getSize() / SLOTS_PER_ROW - 2;
    if (slot == (rows + 1) * SLOTS_PER_ROW + 8) {
      p.closeInventory();
      return;
    }
    int row = slot / SLOTS_PER_ROW - 1;
    int col = slot % SLOTS_PER_ROW - 1;
    if (row < 0 || row >= rows || col < 0 || col >= PER_ROW) return;
    int index = row * PER_ROW + col;
    ItemStack clicked = e.getCurrentItem();
    if (clicked == null || clicked.getType() == Material.AIR) return;
    boolean own = w.owner.equals(p.getUniqueId());
    // Someone else's homes: only for the team.
    if (!own && !p.hasPermission(Moderation.PERMISSION)) return;
    if (index >= w.homes.size()) {
      if (own) later(p, () -> askName(p));
      return;
    }
    String name = w.homes.get(index);
    boolean remove = e.getClick() == ClickType.RIGHT || e.getClick() == ClickType.SHIFT_RIGHT;
    if (!remove) {
      deleting.remove(p.getUniqueId());
      later(p, () -> {
        p.closeInventory();
        if (own) {
          plugin.commands().home(p, name);
        } else {
          PlayerStore.Home h = plugin.store().get(w.owner).homes.get(name);
          org.bukkit.Location to = h == null ? null : h.location();
          if (to != null) plugin.teleporter().teleport(p, ui().bare("dest.home", Ui.v("name", name)), () -> to, null);
        }
      });
      return;
    }
    Map.Entry<String, Long> armed = deleting.get(p.getUniqueId());
    if (armed != null && armed.getKey().equals(name) && System.currentTimeMillis() - armed.getValue() < CONFIRM_MS) {
      deleting.remove(p.getUniqueId());
      if (own) {
        plugin.commands().delHome(p, name);
      } else {
        PlayerStore.Data d = plugin.store().get(w.owner);
        d.homes.remove(name);
        plugin.store().save(w.owner, d);
        p.sendMessage(ui().note("⌂", Ui.SOFT, "home.gui.deletedOf", Ui.v("name", name), Ui.v("player", w.ownerName)));
        plugin.getLogger().info(p.getName() + " deleted home '" + name + "' of " + w.ownerName);
      }
    } else {
      deleting.put(p.getUniqueId(), Map.entry(name, System.currentTimeMillis()));
    }
    // Drawn again on the next tick (not while the click is handled).
    later(p, () -> open(p, w.owner, w.ownerName));
  }

  /** Next tick: windows are not opened or closed while a click is being handled. */
  private void later(Player p, Runnable r) {
    Bukkit.getScheduler().runTask(plugin, () -> {
      if (p.isOnline()) r.run();
    });
  }

  @EventHandler(priority = EventPriority.LOW)
  public void onDrag(InventoryDragEvent e) {
    if (e.getInventory().getHolder() instanceof Window) e.setCancelled(true);
  }

  private void askName(Player p) {
    p.closeInventory();
    naming.put(p.getUniqueId(), System.currentTimeMillis() + NAME_WAIT_MS);
    p.sendMessage(ui().note("⌂", Ui.ACCENT, "home.gui.ask"));
  }

  /** The name of a new home comes as a chat line – it is not sent to the others. */
  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onChat(AsyncChatEvent e) {
    Player p = e.getPlayer();
    Long until = naming.remove(p.getUniqueId());
    if (until == null || System.currentTimeMillis() > until) return;
    e.setCancelled(true);
    String text = PlainTextComponentSerializer.plainText().serialize(e.message()).trim();
    Bukkit.getScheduler().runTask(plugin, () -> {
      if (!p.isOnline()) return;
      if (text.equalsIgnoreCase("abbrechen") || text.equalsIgnoreCase("cancel")) {
        p.sendMessage(ui().note("✖", Ui.SOFT, "home.gui.cancelled"));
        return;
      }
      plugin.commands().setHome(p, text);
      open(p);
    });
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    naming.remove(e.getPlayer().getUniqueId());
    deleting.remove(e.getPlayer().getUniqueId());
  }
}
