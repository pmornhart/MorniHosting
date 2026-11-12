package de.mornihosting.mornicraft;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.sound.Sound;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** The welcome: the server name softly in the middle of the screen, a small card with buttons in the chat. */
final class Welcome implements Listener {
  private static final long AFTER_JOIN_TICKS = 30;
  private static final Duration FADE_IN = Duration.ofMillis(500);
  private static final Duration STAY = Duration.ofMillis(2500);
  private static final Duration FADE_OUT = Duration.ofMillis(800);
  private static final Sound CHIME = Sound.sound(Key.key("block.amethyst_block.chime"), Sound.Source.PLAYER, 0.8f, 1.1f);

  private final MorniCraft plugin;

  Welcome(MorniCraft plugin) {
    this.plugin = plugin;
  }

  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    Player p = e.getPlayer();
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    // The big welcome comes once per player – the first time on this server; afterwards only new mail is shown.
    boolean greet = plugin.settings().welcome() && !d.welcomed;
    if (!p.getName().equals(d.name) || greet) {
      d.name = p.getName();
      d.welcomed = d.welcomed || greet;
      plugin.store().save(p.getUniqueId(), d);
    }
    Bukkit.getScheduler().runTaskLater(plugin, () -> {
      if (!p.isOnline()) return;
      if (greet) greet(p);
      else plugin.social().waiting(p);
    }, AFTER_JOIN_TICKS);
  }

  private void greet(Player p) {
    Ui ui = plugin.ui();
    String server = plugin.settings().serverName();
    p.showTitle(Ui.title(Ui.gradient(server, true),
        ui.bare("welcome.title", Ui.v("name", p.getName())).colorIfAbsent(Ui.SOFT), FADE_IN, STAY, FADE_OUT));
    p.playSound(CHIME);

    List<Component> lines = new ArrayList<>();
    lines.add(ui.words("welcome.first", Ui.v("name", p.getName())));
    lines.add(Component.text("● ", Ui.ACCENT).append(ui.words("welcome.online", Ui.v("count", Bukkit.getOnlinePlayers().size()))));
    if (plugin.settings().elytra()) lines.add(Component.text("✦ ", Ui.ACCENT_2).append(ui.words("welcome.spawn")));
    Component mail = plugin.social().waitingLine(p);
    if (mail != null) lines.add(mail);
    lines.add(Component.empty());
    if (plugin.bedrock().is(p)) {
      lines.add(ui.note("✦", Ui.ACCENT, "welcome.bedrock"));
      p.sendMessage(Component.empty());
      ui.card(p, server, lines);
      return;
    }
    List<Component> buttons = new ArrayList<>(List.of(
        Ui.button(ui.bare("btn.commands"), Ui.ACCENT, ui.bare("btn.commands.hover"), ClickEvent.runCommand("/info")),
        Ui.button(ui.bare("btn.rules"), Ui.GOLD, ui.bare("btn.rules.hover"), ClickEvent.runCommand("/rules"))));
    Component page = plugin.commands().pageButton(p, "btn.page");
    if (page != null) buttons.add(page);
    lines.addAll(Ui.rows(buttons, Component.text("  "), Ui.CARD_PX));
    p.sendMessage(Component.empty());
    ui.card(p, server, lines);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    plugin.store().forget(e.getPlayer().getUniqueId());
  }
}
