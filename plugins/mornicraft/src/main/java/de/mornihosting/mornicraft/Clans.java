package de.mornihosting.mornicraft;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.OfflinePlayer;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.SkullMeta;

/**
 * Clans (Philip, 13.11.): anyone may found one, invite friends, share a clan base (a home for everyone in the clan),
 * talk in the clan chat (/cc), carry a tag in the chat – and does not hurt clan mates (unless the leader switches
 * that on). /clan opens a menu; everything also works as a command. Kept in plugins/MorniCraft/clans.yml.
 */
final class Clans implements Listener {
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_äöüÄÖÜß-]{3,16}");
  private static final Pattern TAG = Pattern.compile("[A-Za-z0-9]{2,4}");
  private static final long INVITE_MS = 5 * 60_000L;
  private static final long CONFIRM_MS = 10_000L;
  private static final int SLOTS_PER_ROW = 9;
  private static final int MENU_ROWS = 5;
  private static final int MEMBER_SLOTS = 9;
  private static final TextColor CLAN = TextColor.color(0x7dd3fc);

  /** A colour the leader can give the clan's tag (Philip: "die Farbe einstellen können"). */
  private record Paint(String id, String de, String en, int rgb, Material wool) {}

  private static final List<Paint> PALETTE = List.of(
      new Paint("himmelblau", "Himmelblau", "sky blue", 0x7dd3fc, Material.LIGHT_BLUE_WOOL),
      new Paint("blau", "Blau", "blue", 0x3b82f6, Material.BLUE_WOOL),
      new Paint("tuerkis", "Türkis", "cyan", 0x22d3ee, Material.CYAN_WOOL),
      new Paint("gruen", "Grün", "green", 0x4ade80, Material.LIME_WOOL),
      new Paint("dunkelgruen", "Dunkelgrün", "dark green", 0x16a34a, Material.GREEN_WOOL),
      new Paint("gelb", "Gelb", "yellow", 0xfacc15, Material.YELLOW_WOOL),
      new Paint("gold", "Gold", "gold", 0xf59e0b, Material.ORANGE_WOOL),
      new Paint("orange", "Orange", "orange", 0xfb923c, Material.ORANGE_TERRACOTTA),
      new Paint("rot", "Rot", "red", 0xef4444, Material.RED_WOOL),
      new Paint("rosa", "Rosa", "pink", 0xf472b6, Material.PINK_WOOL),
      new Paint("lila", "Lila", "purple", 0xa855f7, Material.PURPLE_WOOL),
      new Paint("weiss", "Weiß", "white", 0xf5f5f5, Material.WHITE_WOOL),
      new Paint("grau", "Grau", "gray", 0x9ca3af, Material.LIGHT_GRAY_WOOL));
  private static final String DEFAULT_COLOR = "himmelblau";
  // A colour written as hex: "#ff8800" (also without "#"). Matches "#ff8800", "FF8800"; rejects "#ff88", "red".
  // https://regex101.com/?flavor=javascript&regex=%5E%23%3F%5B0-9a-fA-F%5D%7B6%7D%24&testString=%23ff8800%0AFF8800%0A%23ff88
  private static final Pattern HEX = Pattern.compile("^#?[0-9a-fA-F]{6}$");

  /** The colour names for tab completion. */
  static List<String> colorIds() {
    return PALETTE.stream().map(Paint::id).toList();
  }

  /** The palette entry for a name in German or English (also "grün", "weiß", "türkis"), or null. */
  private static Paint paintOf(String name) {
    String n = name.toLowerCase(Locale.ROOT).replace("ü", "ue").replace("ß", "ss").replace(" ", "");
    return PALETTE.stream()
        .filter(c -> c.id().equals(n) || c.en().replace(" ", "").equals(n)
            || c.de().toLowerCase(Locale.ROOT).replace("ü", "ue").replace("ß", "ss").equals(n))
        .findFirst().orElse(null);
  }

  private static TextColor colorOf(Clan c) {
    if (c.color != null && HEX.matcher(c.color).matches()) return TextColor.fromHexString(c.color.startsWith("#") ? c.color : "#" + c.color);
    Paint paint = c.color == null ? null : paintOf(c.color);
    return TextColor.color(paint == null ? PALETTE.get(0).rgb() : paint.rgb());
  }

  private String colorName(Clan c) {
    Paint paint = c.color == null ? null : paintOf(c.color);
    if (paint == null) return c.color == null ? "" : c.color.toUpperCase(Locale.ROOT);
    return plugin.settings().language().equalsIgnoreCase("en") ? paint.en() : paint.de();
  }

  /** One clan. Members include the leader. */
  static final class Clan {
    String name;
    String tag;
    UUID leader;
    final Set<UUID> members = new LinkedHashSet<>();
    final Map<UUID, String> names = new LinkedHashMap<>();
    PlayerStore.Home base;
    boolean pvp;
    long created;
    /** The tag's colour: a palette id ("rot") or "#rrggbb". */
    String color = DEFAULT_COLOR;

    String key() {
      return name.toLowerCase(Locale.ROOT);
    }
  }

  private record Invite(String clan, UUID from, long at) {}

  private final MorniCraft plugin;
  private final File file;
  private final Map<String, Clan> clans = new ConcurrentHashMap<>();
  /** Player → their clan's key (quick look-up, also from the chat thread). */
  private final Map<UUID, String> memberOf = new ConcurrentHashMap<>();
  private final Map<UUID, Invite> invites = new ConcurrentHashMap<>();
  /** "Click again / type again to confirm" for disbanding and leaving. */
  private final Map<UUID, Long> confirming = new ConcurrentHashMap<>();

  Clans(MorniCraft plugin) {
    this.plugin = plugin;
    this.file = new File(plugin.getDataFolder(), "clans.yml");
    load();
  }

  private Ui ui() {
    return plugin.ui();
  }

  private boolean on() {
    return plugin.settings().clans();
  }

  Clan of(UUID id) {
    String key = memberOf.get(id);
    return key == null ? null : clans.get(key);
  }

  /**
   * "[TAG] " in front of the name (chat, tab list, above the head), or nothing (Philip: "Tags bis zu 4 Buchstaben,
   * vor dem Namen"). Read from the chat thread.
   */
  Component tagFor(UUID id) {
    String t = tagText(id);
    Clan c = t.isEmpty() ? null : of(id);
    return c == null ? Component.empty() : Component.text("[" + t + "] ", colorOf(c));
  }

  /** The clan tag of this player ("MC"), or "" (no clan, clans off). */
  String tagText(UUID id) {
    if (!on()) return "";
    Clan c = of(id);
    return c == null ? "" : c.tag;
  }

  // ---------------------------------------------------------------- commands

  void command(Player p, String[] args) {
    if (!on()) {
      p.sendMessage(ui().fail("off"));
      return;
    }
    String sub = args.length > 0 ? args[0].toLowerCase(Locale.ROOT) : "";
    String arg = args.length > 1 ? args[1] : null;
    switch (sub) {
      case "" , "menu", "menü" -> menu(p);
      case "create", "gruenden", "gründen", "erstellen" -> {
        if (arg == null) usage(p, "/clan create <name> [kürzel]");
        else create(p, arg, args.length > 2 ? args[2] : null);
      }
      case "invite", "einladen" -> {
        if (arg == null) usage(p, "/clan invite <spieler>");
        else invite(p, arg);
      }
      case "accept", "annehmen", "join" -> accept(p, arg);
      case "deny", "ablehnen" -> deny(p);
      case "leave", "verlassen" -> leave(p);
      case "kick", "rauswerfen" -> {
        if (arg == null) usage(p, "/clan kick <spieler>");
        else kick(p, arg);
      }
      case "disband", "auflösen", "aufloesen" -> disband(p);
      case "setbase", "basesetzen" -> setBase(p);
      case "base", "basis" -> base(p);
      case "info" -> info(p, arg == null ? of(p.getUniqueId()) : clans.get(arg.toLowerCase(Locale.ROOT)));
      case "list", "liste" -> list(p);
      case "chat" -> chat(p, args.length > 1 ? String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length)) : "");
      case "tag", "kürzel", "kuerzel" -> {
        if (arg == null) usage(p, "/clan tag <kürzel>");
        else retag(p, arg);
      }
      case "pvp" -> pvp(p);
      case "farbe", "color", "colour" -> recolor(p, arg);
      case "leader", "anführer", "anfuehrer" -> {
        if (arg == null) usage(p, "/clan leader <spieler>");
        else handOver(p, arg);
      }
      default -> help(p);
    }
  }

  private void usage(Player p, String usage) {
    p.sendMessage(ui().fail("usage", Ui.v("usage", usage)));
  }

  private void help(Player p) {
    List<Component> lines = new ArrayList<>();
    for (String[] row : new String[][] {
        {"/clan", "clan.help.menu"}, {"/clan create <name> [kürzel]", "clan.help.create"},
        {"/clan invite <spieler>", "clan.help.invite"}, {"/clan accept", "clan.help.accept"},
        {"/clan base · /clan setbase", "clan.help.base"}, {"/cc <text>", "clan.help.chat"},
        {"/clan kick <spieler>", "clan.help.kick"}, {"/clan leave · /clan disband", "clan.help.leave"},
        {"/clan tag <kürzel> · /clan pvp", "clan.help.tag"}, {"/clan farbe <farbe>", "clan.help.color"}, {"/clan leader <spieler>", "clan.help.leader"}}) {
      lines.add(Component.text(row[0], Ui.ACCENT).append(Component.text(" – ", Ui.DIM)).append(ui().words(row[1])));
    }
    ui().card(p, ui().flat("clan.title"), lines, false);
  }

  void create(Player p, String name, String tag) {
    if (of(p.getUniqueId()) != null) {
      p.sendMessage(ui().fail("clan.already"));
      return;
    }
    if (!NAME.matcher(name).matches()) {
      p.sendMessage(ui().fail("clan.badname"));
      return;
    }
    if (clans.containsKey(name.toLowerCase(Locale.ROOT))) {
      p.sendMessage(ui().fail("clan.taken", Ui.v("name", name)));
      return;
    }
    // Without a tag: the first four letters of the name. A tag of one's own may have five.
    String t = tag == null ? name.replaceAll("[^A-Za-z0-9]", "") : tag;
    if (tag == null) t = t.substring(0, Math.min(t.length(), 4));
    t = t.toUpperCase(Locale.ROOT);
    if (!TAG.matcher(t).matches()) {
      p.sendMessage(ui().fail("clan.badtag"));
      return;
    }
    Clan c = new Clan();
    c.name = name;
    c.tag = t;
    c.leader = p.getUniqueId();
    c.created = System.currentTimeMillis();
    c.members.add(p.getUniqueId());
    c.names.put(p.getUniqueId(), p.getName());
    clans.put(c.key(), c);
    memberOf.put(p.getUniqueId(), c.key());
    invites.remove(p.getUniqueId());
    save();
    p.sendMessage(ui().ok("clan.created", Ui.v("name", c.name), Ui.v("tag", c.tag)));
    p.sendMessage(Ui.button(ui().bare("clan.open"), Ui.ACCENT, ui().bare("clan.open"), ClickEvent.runCommand("/clan")));
  }

  private Clan mine(Player p) {
    Clan c = of(p.getUniqueId());
    if (c == null) p.sendMessage(ui().fail("clan.none"));
    return c;
  }

  private boolean leads(Player p, Clan c) {
    if (c.leader.equals(p.getUniqueId())) return true;
    p.sendMessage(ui().fail("clan.leaderonly"));
    return false;
  }

  void invite(Player p, String who) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    Player to = Bukkit.getPlayerExact(who);
    if (to == null) {
      p.sendMessage(ui().fail("player.offline", Ui.v("name", who)));
      return;
    }
    if (of(to.getUniqueId()) != null) {
      p.sendMessage(ui().fail("clan.theyhave", Ui.v("name", to.getName())));
      return;
    }
    if (c.members.size() >= plugin.settings().clanMaxMembers()) {
      p.sendMessage(ui().fail("clan.full", Ui.v("max", plugin.settings().clanMaxMembers())));
      return;
    }
    invites.put(to.getUniqueId(), new Invite(c.key(), p.getUniqueId(), System.currentTimeMillis()));
    p.sendMessage(ui().ok("clan.invited", Ui.v("name", to.getName())));
    Component yes = Ui.button(ui().bare("clan.accept"), Ui.ACCENT, ui().bare("clan.accept"),
        ClickEvent.runCommand("/clan accept " + c.name));
    Component no = Ui.button(ui().bare("clan.deny"), Ui.BAD, ui().bare("clan.deny"), ClickEvent.runCommand("/clan deny"));
    ui().card(to, ui().flat("clan.title"), List.of(
        ui().words("clan.invite.got", Ui.v("name", p.getName()), Ui.v("clan", c.name), Ui.v("tag", c.tag)),
        yes.append(Ui.gap()).append(no)));
    if (plugin.bedrock().menus(to)) {
      plugin.bedrock().ask(to, ui().flat("clan.title"),
          ui().flat("clan.invite.got", Ui.v("name", p.getName()), Ui.v("clan", c.name), Ui.v("tag", c.tag)),
          ui().flat("clan.accept"), ui().flat("clan.deny"), ok -> {
            if (ok) accept(to, c.name);
            else deny(to);
          });
    }
  }

  void accept(Player p, String name) {
    Invite inv = invites.get(p.getUniqueId());
    if (inv == null || System.currentTimeMillis() - inv.at() > INVITE_MS
        || (name != null && !inv.clan().equalsIgnoreCase(name))) {
      p.sendMessage(ui().fail("clan.noinvite"));
      return;
    }
    Clan c = clans.get(inv.clan());
    if (c == null || of(p.getUniqueId()) != null) {
      invites.remove(p.getUniqueId());
      p.sendMessage(ui().fail("clan.noinvite"));
      return;
    }
    if (c.members.size() >= plugin.settings().clanMaxMembers()) {
      p.sendMessage(ui().fail("clan.full", Ui.v("max", plugin.settings().clanMaxMembers())));
      return;
    }
    invites.remove(p.getUniqueId());
    c.members.add(p.getUniqueId());
    c.names.put(p.getUniqueId(), p.getName());
    memberOf.put(p.getUniqueId(), c.key());
    save();
    tell(c, ui().note("⚑", CLAN, "clan.joined", Ui.v("name", p.getName()), Ui.v("clan", c.name)));
  }

  void deny(Player p) {
    Invite inv = invites.remove(p.getUniqueId());
    if (inv == null) {
      p.sendMessage(ui().fail("clan.noinvite"));
      return;
    }
    p.sendMessage(ui().ok("clan.denied"));
    Player from = Bukkit.getPlayer(inv.from());
    if (from != null) from.sendMessage(ui().fail("clan.theydenied", Ui.v("name", p.getName())));
  }

  private boolean confirmed(Player p, String key) {
    Long at = confirming.get(p.getUniqueId());
    if (at != null && System.currentTimeMillis() - at < CONFIRM_MS) {
      confirming.remove(p.getUniqueId());
      return true;
    }
    confirming.put(p.getUniqueId(), System.currentTimeMillis());
    p.sendMessage(ui().fail(key));
    return false;
  }

  void leave(Player p) {
    Clan c = mine(p);
    if (c == null) return;
    if (c.leader.equals(p.getUniqueId()) && c.members.size() > 1) {
      p.sendMessage(ui().fail("clan.leaderleave"));
      return;
    }
    if (!confirmed(p, c.members.size() == 1 ? "clan.confirm.disband" : "clan.confirm.leave")) return;
    if (c.members.size() == 1) {
      remove(c);
      p.sendMessage(ui().ok("clan.disbanded", Ui.v("clan", c.name)));
      return;
    }
    c.members.remove(p.getUniqueId());
    c.names.remove(p.getUniqueId());
    memberOf.remove(p.getUniqueId());
    save();
    p.sendMessage(ui().ok("clan.left", Ui.v("clan", c.name)));
    tell(c, ui().note("⚑", CLAN, "clan.memberleft", Ui.v("name", p.getName())));
  }

  void kick(Player p, String who) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    UUID target = c.names.entrySet().stream().filter(e -> e.getValue().equalsIgnoreCase(who))
        .map(Map.Entry::getKey).findFirst().orElse(null);
    if (target == null || target.equals(p.getUniqueId())) {
      p.sendMessage(ui().fail("clan.notmember", Ui.v("name", who)));
      return;
    }
    String name = c.names.get(target);
    c.members.remove(target);
    c.names.remove(target);
    memberOf.remove(target);
    save();
    tell(c, ui().note("⚑", CLAN, "clan.kicked", Ui.v("name", name)));
    Player gone = Bukkit.getPlayer(target);
    if (gone != null) gone.sendMessage(ui().fail("clan.youkicked", Ui.v("clan", c.name)));
  }

  void disband(Player p) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    if (!confirmed(p, "clan.confirm.disband")) return;
    tell(c, ui().fail("clan.disbanded", Ui.v("clan", c.name)));
    remove(c);
  }

  private void remove(Clan c) {
    clans.remove(c.key());
    c.members.forEach(memberOf::remove);
    invites.values().removeIf(i -> i.clan().equals(c.key()));
    save();
  }

  void setBase(Player p) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    c.base = PlayerStore.Home.of(p.getLocation());
    save();
    tell(c, ui().note("⌂", CLAN, "clan.baseset", Ui.v("name", p.getName())));
  }

  void base(Player p) {
    Clan c = mine(p);
    if (c == null) return;
    Location to = c.base == null ? null : c.base.location();
    if (to == null) {
      p.sendMessage(ui().fail("clan.nobase"));
      return;
    }
    // The clan base is a home for everybody in the clan: same switch, same limit as /home.
    if (!plugin.settings().homes()) {
      p.sendMessage(ui().fail("off"));
      return;
    }
    if (!plugin.limits().allows(p, "home")) return;
    plugin.teleporter().teleport(p, ui().bare("dest.clanbase", Ui.v("clan", c.name)), () -> to,
        () -> plugin.limits().count(p, "home"));
  }

  void retag(Player p, String tag) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    String t = tag.toUpperCase(Locale.ROOT);
    if (!TAG.matcher(t).matches()) {
      p.sendMessage(ui().fail("clan.badtag"));
      return;
    }
    c.tag = t;
    save();
    tell(c, ui().note("⚑", CLAN, "clan.newtag", Ui.v("tag", t)));
  }

  void pvp(Player p) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    c.pvp = !c.pvp;
    save();
    tell(c, ui().note("⚔", CLAN, c.pvp ? "clan.pvp.on" : "clan.pvp.off"));
  }

  /** "/clan farbe <farbe>": the tag's colour; without a colour the choice as buttons. */
  void recolor(Player p, String wanted) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    if (wanted == null) {
      Component row = Component.empty();
      for (Paint paint : PALETTE) {
        String label = plugin.settings().language().equalsIgnoreCase("en") ? paint.en() : paint.de();
        row = row.append(Component.text("■ " + label + "  ", TextColor.color(paint.rgb()))
            .clickEvent(ClickEvent.runCommand("/clan farbe " + paint.id())));
      }
      ui().card(p, ui().flat("clan.title"), List.of(ui().words("clan.color.pick"), row), false);
      return;
    }
    Paint paint = paintOf(wanted);
    if (paint == null && !HEX.matcher(wanted).matches()) {
      p.sendMessage(ui().fail("clan.badcolor"));
      return;
    }
    c.color = paint != null ? paint.id() : (wanted.startsWith("#") ? wanted : "#" + wanted).toLowerCase(Locale.ROOT);
    save();
    tell(c, Component.text("■ ", colorOf(c)).append(ui().words("clan.newcolor", Ui.v("color", colorName(c)), Ui.v("tag", c.tag))));
  }

  /** The next colour of the palette (the menu's wool button). */
  private void nextColor(Player p, Clan c) {
    int at = 0;
    for (int i = 0; i < PALETTE.size(); i++) if (PALETTE.get(i).id().equals(c.color)) at = i;
    recolor(p, PALETTE.get((at + 1) % PALETTE.size()).id());
  }

  void handOver(Player p, String who) {
    Clan c = mine(p);
    if (c == null || !leads(p, c)) return;
    UUID target = c.names.entrySet().stream().filter(e -> e.getValue().equalsIgnoreCase(who))
        .map(Map.Entry::getKey).findFirst().orElse(null);
    if (target == null || target.equals(p.getUniqueId())) {
      p.sendMessage(ui().fail("clan.notmember", Ui.v("name", who)));
      return;
    }
    c.leader = target;
    save();
    tell(c, ui().note("♛", CLAN, "clan.newleader", Ui.v("name", c.names.get(target))));
  }

  void chat(Player p, String text) {
    if (!on()) {
      p.sendMessage(ui().fail("off"));
      return;
    }
    Clan c = mine(p);
    if (c == null) return;
    if (text.isBlank()) {
      usage(p, "/cc <text>");
      return;
    }
    if (plugin.moderation().muted(p)) {
      p.sendMessage(ui().fail("clan.muted"));
      return;
    }
    Component line = Component.text("[" + c.tag + "] ", CLAN).decoration(TextDecoration.BOLD, true)
        .append(Component.text(p.getName(), NamedTextColor.WHITE).decoration(TextDecoration.BOLD, false))
        .append(Component.text(" » ", NamedTextColor.GRAY).decoration(TextDecoration.BOLD, false))
        .append(Component.text(text, CLAN).decoration(TextDecoration.BOLD, false));
    tell(c, line);
    plugin.getLogger().info("[Clan " + c.name + "] " + p.getName() + ": " + text);
  }

  void info(Player p, Clan c) {
    if (c == null) {
      p.sendMessage(ui().fail("clan.none"));
      return;
    }
    List<Component> lines = new ArrayList<>();
    lines.add(ui().words("clan.info.tag", Ui.v("tag", c.tag)));
    lines.add(ui().words("clan.info.leader", Ui.v("name", c.names.getOrDefault(c.leader, "?"))));
    lines.add(ui().words("clan.info.members", Ui.v("count", c.members.size()),
        Ui.v("max", plugin.settings().clanMaxMembers()), Ui.v("names", String.join(", ", c.names.values()))));
    lines.add(ui().words(c.base == null ? "clan.info.nobase" : "clan.info.base"));
    lines.add(ui().words(c.pvp ? "clan.pvp.on" : "clan.pvp.off"));
    ui().card(p, "⚑ " + c.name, lines, false);
  }

  void list(Player p) {
    if (clans.isEmpty()) {
      p.sendMessage(ui().note("⚑", CLAN, "clan.nonelist"));
      return;
    }
    List<Component> lines = new ArrayList<>();
    clans.values().stream().sorted(Comparator.comparingInt((Clan c) -> -c.members.size())).limit(15)
        .forEach(c -> lines.add(Component.text("[" + c.tag + "] ", CLAN).append(Component.text(c.name, NamedTextColor.WHITE))
            .append(Component.text(" · " + c.members.size(), Ui.SOFT))));
    ui().card(p, ui().flat("clan.list"), lines, false);
  }

  private void tell(Clan c, Component msg) {
    for (UUID id : c.members) {
      Player m = Bukkit.getPlayer(id);
      if (m != null) m.sendMessage(msg);
    }
  }

  // ---------------------------------------------------------------- the menu (/clan)

  private static final class Window implements InventoryHolder {
    private final Map<Integer, Runnable> actions = new java.util.HashMap<>();
    private Inventory inventory;

    @Override
    public Inventory getInventory() {
      return inventory;
    }
  }

  private static ItemStack item(Material m, Component name, List<Component> lore) {
    ItemStack it = new ItemStack(m);
    ItemMeta meta = it.getItemMeta();
    meta.displayName(name.decoration(TextDecoration.ITALIC, false));
    meta.lore(lore.stream().map(l -> l.decoration(TextDecoration.ITALIC, false)).toList());
    it.setItemMeta(meta);
    return it;
  }

  private Component line(String key, TextColor color, Ui.Value... values) {
    return Component.text(ui().flat(key, values), color);
  }

  private void put(Window w, int slot, ItemStack it, Runnable action) {
    w.inventory.setItem(slot, it);
    if (action != null) w.actions.put(slot, action);
  }

  void menu(Player p) {
    Clan c = of(p.getUniqueId());
    Window w = new Window();
    String title = c == null ? ui().flat("clan.title") : "⚑ " + c.name + " [" + c.tag + "]";
    w.inventory = Bukkit.createInventory(w, MENU_ROWS * SLOTS_PER_ROW, Component.text(title, NamedTextColor.DARK_AQUA));
    if (c == null) {
      Invite inv = invites.get(p.getUniqueId());
      put(w, 11, item(Material.WHITE_BANNER, Component.text("⚑ " + ui().flat("clan.menu.create"), Ui.ACCENT),
          List.of(line("clan.menu.create.hint", Ui.SOFT))), () -> {
            p.closeInventory();
            p.sendMessage(Ui.button(ui().bare("clan.menu.create"), Ui.ACCENT, ui().bare("clan.menu.create.hint"),
                ClickEvent.suggestCommand("/clan create ")));
          });
      if (inv != null && System.currentTimeMillis() - inv.at() <= INVITE_MS && clans.containsKey(inv.clan())) {
        Clan from = clans.get(inv.clan());
        put(w, 13, item(Material.WRITABLE_BOOK, Component.text("✉ " + from.name + " [" + from.tag + "]", CLAN),
            List.of(line("clan.menu.invite.accept", Ui.ACCENT))), () -> {
              p.closeInventory();
              accept(p, from.name);
            });
      }
      put(w, 15, item(Material.BOOK, Component.text("☰ " + ui().flat("clan.list"), NamedTextColor.WHITE),
          List.of(line("clan.menu.list.hint", Ui.SOFT))), () -> {
            p.closeInventory();
            list(p);
          });
      p.openInventory(w.inventory);
      return;
    }
    boolean leader = c.leader.equals(p.getUniqueId());
    // Top row: the clan's banner with its facts.
    put(w, 4, item(Material.CYAN_BANNER, Component.text("⚑ " + c.name, CLAN).decoration(TextDecoration.BOLD, true),
        List.of(Component.text("[" + c.tag + "] " + colorName(c), colorOf(c)).decoration(TextDecoration.ITALIC, false),
            line("clan.info.leader.plain", Ui.SOFT, Ui.v("name", c.names.getOrDefault(c.leader, "?"))),
            line("clan.info.count.plain", Ui.SOFT, Ui.v("count", c.members.size()),
                Ui.v("max", plugin.settings().clanMaxMembers())))), null);
    // Middle: the members' heads (online first).
    List<UUID> members = new ArrayList<>(c.members);
    members.sort(Comparator.comparing((UUID id) -> Bukkit.getPlayer(id) == null).thenComparing(id -> c.names.getOrDefault(id, "")));
    for (int i = 0; i < Math.min(MEMBER_SLOTS, members.size()); i++) {
      UUID id = members.get(i);
      String name = c.names.getOrDefault(id, "?");
      boolean online = Bukkit.getPlayer(id) != null;
      ItemStack head = new ItemStack(Material.PLAYER_HEAD);
      SkullMeta meta = (SkullMeta) head.getItemMeta();
      OfflinePlayer off = Bukkit.getOfflinePlayer(id);
      meta.setOwningPlayer(off);
      meta.displayName(Component.text((id.equals(c.leader) ? "♛ " : "") + name, online ? Ui.ACCENT : Ui.SOFT)
          .decoration(TextDecoration.ITALIC, false));
      List<Component> lore = new ArrayList<>();
      lore.add(line(online ? "clan.menu.online" : "clan.menu.offline", online ? Ui.ACCENT : Ui.DIM));
      if (leader && !id.equals(p.getUniqueId())) lore.add(line("clan.menu.kick.hint", Ui.BAD));
      meta.lore(lore.stream().map(l -> l.decoration(TextDecoration.ITALIC, false)).toList());
      head.setItemMeta(meta);
      boolean kickable = leader && !id.equals(p.getUniqueId());
      put(w, 18 + i, head, kickable ? () -> {
        p.closeInventory();
        p.sendMessage(Ui.button(ui().bare("clan.menu.kick", Ui.v("name", name)), Ui.BAD, ui().bare("clan.menu.kick.hint"),
            ClickEvent.suggestCommand("/clan kick " + name)));
      } : null);
    }
    // Bottom row: what one can do.
    put(w, 37, item(Material.RED_BED, Component.text("⌂ " + ui().flat("clan.menu.base"), Ui.ACCENT),
        List.of(line(c.base == null ? "clan.info.nobase.plain" : "clan.menu.base.hint", Ui.SOFT))), () -> {
          p.closeInventory();
          base(p);
        });
    put(w, 38, item(Material.OAK_SIGN, Component.text("✎ " + ui().flat("clan.menu.chat"), NamedTextColor.WHITE),
        List.of(line("clan.menu.chat.hint", Ui.SOFT))), () -> {
          p.closeInventory();
          p.sendMessage(Ui.button(ui().bare("clan.menu.chat"), CLAN, ui().bare("clan.menu.chat.hint"),
              ClickEvent.suggestCommand("/cc ")));
        });
    if (leader) {
      put(w, 39, item(Material.COMPASS, Component.text("⌂ " + ui().flat("clan.menu.setbase"), NamedTextColor.WHITE),
          List.of(line("clan.menu.setbase.hint", Ui.SOFT))), () -> {
            p.closeInventory();
            setBase(p);
          });
      put(w, 40, item(Material.WRITABLE_BOOK, Component.text("✉ " + ui().flat("clan.menu.invite"), Ui.ACCENT),
          List.of(line("clan.menu.invite.hint", Ui.SOFT))), () -> {
            p.closeInventory();
            p.sendMessage(Ui.button(ui().bare("clan.menu.invite"), Ui.ACCENT, ui().bare("clan.menu.invite.hint"),
                ClickEvent.suggestCommand("/clan invite ")));
          });
      put(w, 41, item(c.pvp ? Material.IRON_SWORD : Material.SHIELD,
          Component.text("⚔ " + ui().flat(c.pvp ? "clan.menu.pvp.on" : "clan.menu.pvp.off"), NamedTextColor.WHITE),
          List.of(line("clan.menu.pvp.hint", Ui.SOFT))), () -> {
            pvp(p);
            menu(p);
          });
      Paint now = paintOf(c.color == null ? "" : c.color);
      put(w, 42, item(now == null ? Material.WHITE_WOOL : now.wool(),
          Component.text("■ ", colorOf(c)).append(Component.text(ui().flat("clan.menu.color", Ui.v("color", colorName(c))), NamedTextColor.WHITE)),
          List.of(line("clan.menu.color.hint", Ui.SOFT))), () -> {
            nextColor(p, c);
            menu(p);
          });
      put(w, 43, item(Material.TNT, Component.text("✖ " + ui().flat("clan.menu.disband"), Ui.BAD),
          List.of(line("clan.menu.twice", Ui.SOFT))), () -> {
            p.closeInventory();
            disband(p);
          });
    } else {
      put(w, 43, item(Material.BARRIER, Component.text("✖ " + ui().flat("clan.menu.leave"), Ui.BAD),
          List.of(line("clan.menu.twice", Ui.SOFT))), () -> {
            p.closeInventory();
            leave(p);
          });
    }
    p.openInventory(w.inventory);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onClick(InventoryClickEvent e) {
    if (!(e.getInventory().getHolder() instanceof Window w)) return;
    e.setCancelled(true);
    if (e.getClickedInventory() == null || e.getClickedInventory() != e.getInventory()) return;
    Runnable action = w.actions.get(e.getRawSlot());
    if (action != null) Bukkit.getScheduler().runTask(plugin, action);
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onDrag(InventoryDragEvent e) {
    if (e.getInventory().getHolder() instanceof Window) e.setCancelled(true);
  }

  // ---------------------------------------------------------------- no friendly fire

  @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
  public void onHit(EntityDamageByEntityEvent e) {
    if (!on() || !(e.getEntity() instanceof Player victim)) return;
    Player by = e.getDamager() instanceof Player p ? p
        : e.getDamager() instanceof Projectile pr && pr.getShooter() instanceof Player p2 ? p2 : null;
    if (by == null || by.equals(victim)) return;
    Clan a = of(by.getUniqueId());
    if (a == null || a.pvp || !a.members.contains(victim.getUniqueId())) return;
    e.setCancelled(true);
  }

  // ---------------------------------------------------------------- storage

  private void load() {
    if (!file.exists()) return;
    YamlConfiguration y = new YamlConfiguration();
    try {
      y.load(file);
    } catch (IOException | InvalidConfigurationException e) {
      plugin.getLogger().log(Level.WARNING, "clans.yml is unreadable", e);
      return;
    }
    ConfigurationSection all = y.getConfigurationSection("clans");
    if (all == null) return;
    for (String key : all.getKeys(false)) {
      ConfigurationSection s = all.getConfigurationSection(key);
      if (s == null) continue;
      Clan c = new Clan();
      c.name = s.getString("name", key);
      c.tag = s.getString("tag", "CLAN");
      c.pvp = s.getBoolean("pvp", false);
      c.color = s.getString("color", DEFAULT_COLOR);
      c.created = s.getLong("created", 0);
      try {
        c.leader = UUID.fromString(s.getString("leader", ""));
      } catch (IllegalArgumentException bad) {
        continue;
      }
      ConfigurationSection m = s.getConfigurationSection("members");
      if (m != null) {
        for (String id : m.getKeys(false)) {
          try {
            UUID u = UUID.fromString(id);
            c.members.add(u);
            c.names.put(u, m.getString(id, "?"));
          } catch (IllegalArgumentException bad) {
            // skip
          }
        }
      }
      c.members.add(c.leader);
      ConfigurationSection b = s.getConfigurationSection("base");
      if (b != null) c.base = new PlayerStore.Home(b.getString("world", "world"), b.getDouble("x"), b.getDouble("y"),
          b.getDouble("z"), (float) b.getDouble("yaw"), (float) b.getDouble("pitch"));
      clans.put(c.key(), c);
      c.members.forEach(u -> memberOf.put(u, c.key()));
    }
  }

  private synchronized void save() {
    // Tags in the tab list and above the heads follow every change (found, joined, left, new tag …).
    if (Bukkit.isPrimaryThread()) plugin.ranks().paintAll();
    YamlConfiguration y = new YamlConfiguration();
    for (Clan c : clans.values()) {
      String p = "clans." + c.key() + ".";
      y.set(p + "name", c.name);
      y.set(p + "tag", c.tag);
      y.set(p + "color", c.color);
      y.set(p + "leader", c.leader.toString());
      y.set(p + "pvp", c.pvp);
      y.set(p + "created", c.created);
      c.names.forEach((id, name) -> y.set(p + "members." + id, name));
      if (c.base != null) {
        y.set(p + "base.world", c.base.world());
        y.set(p + "base.x", c.base.x());
        y.set(p + "base.y", c.base.y());
        y.set(p + "base.z", c.base.z());
        y.set(p + "base.yaw", c.base.yaw());
        y.set(p + "base.pitch", c.base.pitch());
      }
    }
    Path target = file.toPath();
    Path tmp = target.resolveSibling("clans.yml.tmp");
    try {
      Files.write(tmp, y.saveToString().getBytes(StandardCharsets.UTF_8));
      Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException e) {
      plugin.getLogger().log(Level.WARNING, "Could not save clans.yml", e);
    }
  }

  /** Names of the own clan's members (for the sidebar or /clan info). */
  Set<String> memberNames(Clan c) {
    return new LinkedHashSet<>(c.names.values());
  }

  @EventHandler
  public void onJoin(org.bukkit.event.player.PlayerJoinEvent e) {
    seen(e.getPlayer());
  }

  /** Keeps a member's name current (after a rename). */
  void seen(Player p) {
    Clan c = of(p.getUniqueId());
    if (c != null && !p.getName().equals(c.names.get(p.getUniqueId()))) {
      c.names.put(p.getUniqueId(), p.getName());
      save();
    }
  }

  static boolean validName(String name) {
    return NAME.matcher(name).matches();
  }

  Map<String, Clan> all() {
    return Map.copyOf(clans);
  }
}
