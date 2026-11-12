package de.mornihosting.mornicraft;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;

/**
 * Looks on GitHub for a newer MorniCraft (at the start and every six hours) and tells operators when they join.
 * Servers run by MorniHosting get updates from the panel itself and switch this off ("update-check: false").
 */
final class UpdateCheck implements Listener {
  static final String RELEASES = "https://github.com/pmornhart/MorniCraft/releases/latest";
  private static final String API = "https://api.github.com/repos/pmornhart/MorniCraft/releases/latest";
  private static final long EVERY_TICKS = 20L * 60 * 60 * 6;
  private static final long FIRST_TICKS = 20L * 30;
  private static final Pattern TAG = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?([0-9][^\"]*)\"");

  private final MorniCraft plugin;
  private volatile String newer;

  UpdateCheck(MorniCraft plugin) {
    this.plugin = plugin;
    Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, this::check, FIRST_TICKS, EVERY_TICKS);
  }

  private void check() {
    if (!plugin.settings().updateCheck()) return;
    try {
      HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
      HttpRequest req = HttpRequest.newBuilder(URI.create(API)).timeout(Duration.ofSeconds(15))
          .header("Accept", "application/vnd.github+json").header("User-Agent", "MorniCraft").build();
      String body = http.send(req, HttpResponse.BodyHandlers.ofString()).body();
      Matcher m = TAG.matcher(body);
      if (!m.find()) return;
      String latest = m.group(1);
      if (isNewer(latest, plugin.getDescription().getVersion())) {
        if (!latest.equals(newer)) plugin.getLogger().info("Neue Version verfügbar: " + latest + " – " + RELEASES);
        newer = latest;
      }
    } catch (Exception e) {
      // No internet or GitHub not reachable: try again later.
    }
  }

  /** "1.2.0" newer than "1.1.9"? Compares the numbers one by one. */
  static boolean isNewer(String latest, String current) {
    String[] a = latest.split("[.-]");
    String[] b = current.split("[.-]");
    for (int i = 0; i < Math.max(a.length, b.length); i++) {
      int x = i < a.length ? number(a[i]) : 0;
      int y = i < b.length ? number(b[i]) : 0;
      if (x != y) return x > y;
    }
    return false;
  }

  private static int number(String s) {
    try {
      return Integer.parseInt(s);
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  @EventHandler
  public void onJoin(PlayerJoinEvent e) {
    Player p = e.getPlayer();
    String version = newer;
    if (version == null || !p.isOp()) return;
    Bukkit.getScheduler().runTaskLater(plugin, () -> p.sendMessage(plugin.ui().note("⬆", Ui.GOLD, "update.available",
        Ui.v("version", version)).clickEvent(ClickEvent.openUrl(RELEASES))
        .append(Component.text(" ")).append(Ui.button(plugin.ui().bare("update.open"), Ui.GOLD, null,
            ClickEvent.openUrl(RELEASES)))), 60L);
  }
}
