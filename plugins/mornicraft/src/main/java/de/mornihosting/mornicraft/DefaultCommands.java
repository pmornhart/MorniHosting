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
            c(en, "/home [name]", "Bringt dich nach Hause", "Takes you home"),
            c(en, "/homes", "Zeigt alle deine Zuhause", "Lists your homes"),
            c(en, "/delhome <name>", "Löscht ein Zuhause", "Deletes a home"),
            c(en, "/back", "Zurück zum letzten Ort – auch nach dem Tod", "Back to the last place – also after dying"))),
        new Settings.Group(en ? "Friends" : "Zu Freunden", List.of(
            c(en, "/tpa <spieler>", "Fragt, ob du zu jemandem darfst", "Asks to teleport to someone"),
            c(en, "/tpahere <spieler>", "Fragt, ob jemand zu dir kommt", "Asks someone to come to you"),
            c(en, "/tpaccept", "Anfrage annehmen", "Accept a request"),
            c(en, "/tpdeny", "Anfrage ablehnen", "Decline a request"))),
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
            c(en, "/getpos", "Deine Koordinaten", "Your coordinates"),
            c(en, "/ping", "Deine Verbindung zum Server", "Your connection to the server"),
            c(en, "/rules", "Die Regeln", "The rules"),
            c(en, "/leiste", "Leiste rechts ein- oder ausblenden", "Show or hide the bar on the right"))),
        new Settings.Group(en ? "Admins only (OP)" : "Nur für Admins (OP)", List.of(
            op(en, "/mornicraft reload", "Einstellungen neu laden", "Reload the settings"))));
  }
}
