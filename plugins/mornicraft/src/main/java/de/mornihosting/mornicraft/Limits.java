package de.mornihosting.mornicraft;

import java.util.ArrayList;
import java.util.List;
import org.bukkit.entity.Player;

/**
 * Limits on /spawn, /home, /tpa, /back (Philip, 13.11.): "once an hour", "three times a day" … Each use is kept in
 * the player's file, so leaving and coming back does not reset it. Operators and ranks that run the server
 * (mornicraft.admin: Owner, an own Admin rank) have no limit.
 */
final class Limits {
  private static final long HOUR_MS = 3_600_000L;
  private static final long MINUTE_MS = 60_000L;

  private final MorniCraft plugin;

  Limits(MorniCraft plugin) {
    this.plugin = plugin;
  }

  private Settings.Limit limitOf(String cmd) {
    return plugin.settings().limits().get(cmd);
  }

  private static boolean free(Player p) {
    return p.isOp() || p.hasPermission("mornicraft.admin");
  }

  /** Uses within the window (old ones are dropped). */
  private List<Long> recent(Player p, String cmd, Settings.Limit limit) {
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    long since = System.currentTimeMillis() - limit.hours() * HOUR_MS;
    List<Long> kept = new ArrayList<>();
    for (long at : d.uses.getOrDefault(cmd, List.of())) if (at > since) kept.add(at);
    d.uses.put(cmd, kept);
    return kept;
  }

  /** May the player use the command now? If not, says so (with when it works again) and returns false. */
  boolean allows(Player p, String cmd) {
    Settings.Limit limit = limitOf(cmd);
    if (limit == null || free(p)) return true;
    List<Long> used = recent(p, cmd, limit);
    if (used.size() < limit.uses()) return true;
    long next = used.stream().mapToLong(Long::longValue).min().orElse(0) + limit.hours() * HOUR_MS;
    p.sendMessage(plugin.ui().fail("limit.reached", Ui.v("cmd", "/" + cmd), Ui.v("uses", limit.uses()),
        Ui.v("per", per(limit.hours())), Ui.v("time", timeUntil(next - System.currentTimeMillis()))));
    return false;
  }

  /** Counts one use (after the teleport worked); tells how many are left. */
  void count(Player p, String cmd) {
    Settings.Limit limit = limitOf(cmd);
    if (limit == null || free(p)) return;
    List<Long> used = recent(p, cmd, limit);
    used.add(System.currentTimeMillis());
    PlayerStore.Data d = plugin.store().get(p.getUniqueId());
    plugin.store().save(p.getUniqueId(), d);
    int left = Math.max(0, limit.uses() - used.size());
    p.sendActionBar(plugin.ui().words("limit.left", Ui.v("cmd", "/" + cmd), Ui.v("left", left),
        Ui.v("per", per(limit.hours()))));
  }

  /** "Stunde", "Tag", "6 Stunden", "Woche". */
  private String per(int hours) {
    boolean en = "en".equalsIgnoreCase(plugin.settings().language());
    if (hours == 1) return en ? "hour" : "Stunde";
    if (hours == 24) return en ? "day" : "Tag";
    if (hours == 168) return en ? "week" : "Woche";
    if (hours % 24 == 0) return (hours / 24) + (en ? " days" : " Tage");
    return hours + (en ? " hours" : " Stunden");
  }

  private String timeUntil(long ms) {
    boolean en = "en".equalsIgnoreCase(plugin.settings().language());
    long minutes = Math.max(1, (ms + MINUTE_MS - 1) / MINUTE_MS);
    if (minutes < 60) return minutes + (en ? " min" : " Min.");
    long hours = minutes / 60;
    long rest = minutes % 60;
    return hours + (en ? " h" : " Std.") + (rest > 0 ? " " + rest + (en ? " min" : " Min.") : "");
  }
}
