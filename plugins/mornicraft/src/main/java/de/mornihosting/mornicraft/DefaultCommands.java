package de.mornihosting.mornicraft;

import java.util.List;

/**
 * The command list for /info when nothing else is configured (a server without MorniHosting). MorniHosting writes
 * the same list into config.yml ("groups"), in the panel's language.
 */
final class DefaultCommands {
  private DefaultCommands() {}

  private static Settings.Command c(boolean en, String use, String de, String english) {
    return new Settings.Command(use, en ? english : de, false);
  }

  private static Settings.Command op(boolean en, String use, String de, String english) {
    return new Settings.Command(use, en ? english : de, true);
  }

  static List<Settings.Group> groups(boolean en) {
    return List.of(
        new Settings.Group(en ? "Spawn & flying" : "Spawn & Fliegen", List.of(
            c(en, "/spawn", "Zurück zur Spawn-Insel", "Back to the spawn island"))),
        new Settings.Group(en ? "Home" : "Zuhause", List.of(
            c(en, "/sethome [name]", "Merkt sich, wo du gerade stehst", "Remembers where you stand"),
            c(en, "/home [name]", "Deine Zuhause als Betten – oder mit Namen direkt hin", "Your homes as beds – or straight there by name"),
            c(en, "/homes", "Deine Zuhause als Betten", "Your homes as beds"),
            c(en, "/delhome <name>", "Löscht ein Zuhause", "Deletes a home"),
            c(en, "/back", "Zurück zum letzten Ort – auch nach dem Tod", "Back to the last place – also after dying"))),
        new Settings.Group(en ? "Friends" : "Zu Freunden", List.of(
            c(en, "/tpa <spieler>", "Fragt, ob du zu jemandem darfst", "Asks to teleport to someone"),
            c(en, "/tpahere <spieler>", "Fragt, ob jemand zu dir kommt", "Asks someone to come to you"),
            c(en, "/tpaccept", "Anfrage annehmen", "Accept a request"),
            c(en, "/tpdeny", "Anfrage ablehnen", "Decline a request"))),
        new Settings.Group("Clan", List.of(
            c(en, "/clan", "Clan-Menü: gründen, Mitglieder, Basis", "Clan menu: found one, members, base"),
            c(en, "/clan create <name> [kürzel]", "Eigenen Clan gründen", "Found your own clan"),
            c(en, "/clan invite <spieler>", "Jemanden einladen", "Invite someone"),
            c(en, "/clan base", "Zur Clan-Basis", "To the clan base"),
            c(en, "/cc <text>", "Clan-Chat", "Clan chat"))),
        new Settings.Group("Chat", List.of(
            c(en, "/msg <spieler> <text>", "Private Nachricht", "Private message"),
            c(en, "/r <text>", "Auf die letzte Nachricht antworten", "Reply to the last message"),
            c(en, "/mail send <spieler> <text>", "Nachricht für später (auch offline)", "Message for later (also offline)"),
            c(en, "/mail read", "Deine Post lesen", "Read your mail"),
            c(en, "/ignore <spieler>", "Jemanden im Chat ausblenden", "Hide someone in the chat"),
            c(en, "/afk", "Zeigt allen, dass du kurz weg bist", "Tells everyone you're away"))),
        new Settings.Group("Infos", List.of(
            c(en, "/info", "Diese Liste", "This list"),
            c(en, "/seen <spieler>", "Wann jemand zuletzt da war", "When someone was last online"),
            c(en, "/near", "Wer in deiner Nähe ist", "Who is near you"),
            c(en, "/team", "Wer im Team ist (Ränge)", "Who is on the team (ranks)"),
            c(en, "/getpos", "Deine Koordinaten", "Your coordinates"),
            c(en, "/ping", "Deine Verbindung zum Server", "Your connection to the server"),
            c(en, "/rules", "Die Regeln", "The rules"),
            c(en, "/leiste", "Leiste rechts ein- oder ausblenden", "Show or hide the bar on the right"),
            c(en, "/streamer", "Streamer-Modus: IPs, Koordinaten, Nachrichten verstecken", "Streamer mode: hide IPs, coordinates, messages"))),
        new Settings.Group(en ? "Team (moderation)" : "Team (Moderation)", List.of(
            op(en, "/ansehen <spieler>", "Team-Menü (auch Ducken + Rechtsklick)", "Team menu (also sneak + right click)"),
            op(en, "/gefaengnis <spieler> [10m|1h|1d] [grund]", "Ins Gefängnis", "Send to jail"),
            op(en, "/frei <spieler>", "Aus dem Gefängnis holen", "Release from jail"),
            op(en, "/stumm <spieler> [10m|1h|1d]", "Stummschalten", "Mute"),
            op(en, "/entstummen <spieler>", "Wieder schreiben lassen", "Unmute"),
            op(en, "/einfrieren <spieler>", "Einfrieren / auftauen", "Freeze / unfreeze"),
            op(en, "/nether [weg]", "Netherportal am Spawn", "Nether portal at the spawn"),
            op(en, "/end [weg]", "Weg zum Endportal im Spawn", "Way to the end portal inside the spawn"))),
        new Settings.Group(en ? "Admins only (OP)" : "Nur für Admins (OP)", List.of(
            op(en, "/mornicraft reload", "Einstellungen neu laden", "Reload the settings"))));
  }
}
