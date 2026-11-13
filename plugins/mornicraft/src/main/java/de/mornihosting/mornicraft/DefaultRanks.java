package de.mornihosting.mornicraft;

import java.util.List;
import net.kyori.adventure.text.format.TextColor;

/** The ranks a server starts with when config.yml has none (the same as MorniHosting's DEFAULT_RANKS). */
final class DefaultRanks {
  private static final List<String> BUILD = List.of("mornicraft.build");
  private static final List<String> INSTANT = List.of("mornicraft.instant");
  private static final List<String> HOMES = List.of("mornicraft.unlimitedhomes");
  private static final List<String> KICK = List.of("minecraft.command.kick");
  private static final List<String> BAN = List.of("minecraft.command.ban", "minecraft.command.ban-ip",
      "minecraft.command.pardon", "minecraft.command.pardon-ip", "minecraft.command.banlist");
  private static final List<String> GAMEMODE = List.of("minecraft.command.gamemode");
  private static final List<String> TELEPORT = List.of("minecraft.command.teleport", "minecraft.command.tp");
  private static final List<String> WORLD = List.of("minecraft.command.time", "minecraft.command.weather");
  private static final List<String> WHITELIST = List.of("minecraft.command.whitelist");
  private static final List<String> RELOAD = List.of("mornicraft.admin", "mornicraft.ranks");
  private static final List<String> MODERATE = List.of("mornicraft.moderate");

  private DefaultRanks() {}

  @SafeVarargs
  private static List<String> all(List<String>... parts) {
    return java.util.Arrays.stream(parts).flatMap(List::stream).toList();
  }

  private static Ranks.Rank rank(String id, String name, String symbol, String hex, List<String> perms, boolean fallback) {
    return new Ranks.Rank(id, name, symbol, TextColor.fromHexString(hex), perms, List.of(), fallback, "");
  }

  static List<Ranks.Rank> ranks() {
    List<String> everything = all(BUILD, INSTANT, HOMES, KICK, BAN, MODERATE, GAMEMODE, TELEPORT, WORLD, WHITELIST, RELOAD);
    return List.of(
        rank("owner", "Owner", "♛", "#ff5555", everything, false),
        rank("moderator", "Moderator", "⚔", "#55aaff", all(INSTANT, KICK, BAN, MODERATE, TELEPORT), false),
        rank("builder", "Builder", "⚒", "#c08a5b", all(BUILD, GAMEMODE), false),
        rank("media", "Media", "▶", "#ff6ad5", HOMES, false),
        rank("vip", "VIP", "★", "#ffd23f", HOMES, false),
        rank("player", "Spieler", "", "#aaaaaa", List.of(), true));
  }
}
