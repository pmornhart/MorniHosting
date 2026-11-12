package de.mornihosting.mornicraft;

import java.util.Map;

/**
 * All words the players read, German and English. Only words – how they look (icons, colours, frames, buttons) is
 * in {@link Ui}. In the texts {@code <hl>…</hl>} marks the important part (a name, a number); values from players
 * are filled in as plain text by {@link Ui}, never as formatting.
 */
final class Texts {
  private static final Map<String, String[]> TEXTS = Map.ofEntries(
      // Teleports
      Map.entry("tp.bar", new String[] {"<dest> · noch <hl><sec></hl> s – nicht bewegen", "<dest> · <hl><sec></hl> s – don't move"}),
      Map.entry("tp.cancel", new String[] {"Abgebrochen – du hast dich bewegt", "Cancelled – you moved"}),
      Map.entry("dest.spawn", new String[] {"Spawn", "Spawn"}),
      Map.entry("dest.home", new String[] {"Zuhause <hl><name></hl>", "Home <hl><name></hl>"}),
      Map.entry("dest.back", new String[] {"Letzter Ort", "Last place"}),
      Map.entry("dest.player", new String[] {"Zu <hl><name></hl>", "To <hl><name></hl>"}),
      Map.entry("home.set", new String[] {
          "Zuhause <hl><name></hl> gespeichert – zurück mit <hl>/home <name></hl>",
          "Home <hl><name></hl> saved – come back with <hl>/home <name></hl>"}),
      Map.entry("home.moved", new String[] {
          "Zuhause <hl><name></hl> an diesen Ort verschoben", "Home <hl><name></hl> moved here"}),
      Map.entry("home.limit", new String[] {
          "Du hast schon <hl><max></hl> Zuhause – lösche eins mit <hl>/delhome</hl>",
          "You already have <hl><max></hl> homes – delete one with <hl>/delhome</hl>"}),
      Map.entry("home.none", new String[] {
          "Noch kein Zuhause – stell dich hin und tippe <hl>/sethome</hl>",
          "No home yet – stand somewhere and type <hl>/sethome</hl>"}),
      Map.entry("home.unknown", new String[] {"Kein Zuhause namens <hl><name></hl>", "No home called <hl><name></hl>"}),
      Map.entry("home.title", new String[] {"Deine Zuhause", "Your homes"}),
      Map.entry("home.hover", new String[] {"<coords>\nKlick: hinreisen", "<coords>\nClick: go there"}),
      Map.entry("home.deleted", new String[] {"Zuhause <hl><name></hl> gelöscht", "Home <hl><name></hl> deleted"}),
      Map.entry("home.badname", new String[] {
          "Namen bitte nur mit Buchstaben, Zahlen, - und _ (bis 16)",
          "Names only with letters, digits, - and _ (up to 16)"}),
      Map.entry("home.world", new String[] {"Die Welt dieses Zuhauses gibt es nicht mehr", "This home's world is gone"}),
      Map.entry("back.none", new String[] {"Noch kein Ort, zu dem du zurück kannst", "No place to go back to yet"}),
      Map.entry("off", new String[] {"Das ist auf diesem Server ausgeschaltet", "That is switched off on this server"}),
      // Players
      Map.entry("player.offline", new String[] {"<hl><name></hl> ist gerade nicht online", "<hl><name></hl> is not online"}),
      Map.entry("player.unknown", new String[] {"Einen Spieler <hl><name></hl> gab es hier noch nie", "No player <hl><name></hl> has been here"}),
      Map.entry("player.self", new String[] {"Das bist du selbst", "That's you"}),
      Map.entry("only.players", new String[] {"Nur im Spiel möglich", "Only possible in the game"}),
      Map.entry("usage", new String[] {"So geht's: <hl><usage></hl>", "Usage: <hl><usage></hl>"}),
      // Teleport requests
      Map.entry("tpa.title", new String[] {"Teleport-Anfrage", "Teleport request"}),
      Map.entry("tpa.sent", new String[] {
          "Anfrage an <hl><name></hl> geschickt – gilt 2 Minuten", "Request sent to <hl><name></hl> – valid for 2 minutes"}),
      Map.entry("tpa.got", new String[] {"<hl><name></hl> möchte zu dir kommen.", "<hl><name></hl> wants to come to you."}),
      Map.entry("tpahere.got", new String[] {"<hl><name></hl> möchte dich zu sich holen.", "<hl><name></hl> wants you to come over."}),
      Map.entry("tpa.accept", new String[] {"✔ Annehmen", "✔ Accept"}),
      Map.entry("tpa.deny", new String[] {"✖ Ablehnen", "✖ Decline"}),
      Map.entry("tpa.accept.hover", new String[] {"Klick: annehmen", "Click: accept"}),
      Map.entry("tpa.deny.hover", new String[] {"Klick: ablehnen", "Click: decline"}),
      Map.entry("tpa.accepted", new String[] {"<hl><name></hl> hat angenommen", "<hl><name></hl> accepted"}),
      Map.entry("tpa.youaccepted", new String[] {"Angenommen", "Accepted"}),
      Map.entry("tpa.denied", new String[] {"<hl><name></hl> hat abgelehnt", "<hl><name></hl> declined"}),
      Map.entry("tpa.youdenied", new String[] {"Abgelehnt", "Declined"}),
      Map.entry("tpa.none", new String[] {"Keine offene Anfrage", "No open request"}),
      Map.entry("tpa.blocked", new String[] {"<hl><name></hl> nimmt gerade nichts von dir an", "<hl><name></hl> isn't taking anything from you"}),
      // Messages
      Map.entry("msg.to", new String[] {"Du → <hl><name></hl>", "You → <hl><name></hl>"}),
      Map.entry("msg.from", new String[] {"<hl><name></hl> → dich", "<hl><name></hl> → you"}),
      Map.entry("msg.reply.hover", new String[] {"Klick: antworten", "Click: reply"}),
      Map.entry("msg.noreply", new String[] {"Du hast noch keine Nachricht bekommen", "You haven't received a message yet"}),
      Map.entry("mail.sent", new String[] {
          "Nachricht für <hl><name></hl> liegt bereit", "Message for <hl><name></hl> is waiting for them"}),
      Map.entry("mail.none", new String[] {"Keine neuen Nachrichten", "No new messages"}),
      Map.entry("mail.title", new String[] {"Deine Nachrichten", "Your messages"}),
      Map.entry("mail.waiting", new String[] {"<hl><count></hl> neue Nachrichten", "<hl><count></hl> new messages"}),
      Map.entry("mail.waiting.one", new String[] {"<hl>1</hl> neue Nachricht", "<hl>1</hl> new message"}),
      Map.entry("mail.read", new String[] {"✉ Lesen", "✉ Read"}),
      Map.entry("tpa.already", new String[] {"Du hast <hl><name></hl> schon gefragt – warte kurz auf die Antwort", "You already asked <hl><name></hl> – wait for the answer"}),
      Map.entry("afk.wait", new String[] {"Nicht so schnell – versuch es gleich nochmal", "Not so fast – try again in a moment"}),
      Map.entry("tp.failed", new String[] {"Das hat nicht geklappt – versuch es nochmal", "That didn't work – try again"}),
      Map.entry("tp.hurt", new String[] {"Abgebrochen – du hast Schaden bekommen", "Cancelled – you took damage"}),
      Map.entry("mail.full", new String[] {"Das Postfach von <hl><name></hl> ist voll", "<hl><name></hl>'s mailbox is full"}),
      Map.entry("ignore.on", new String[] {"Du blendest <hl><name></hl> jetzt aus", "You now ignore <hl><name></hl>"}),
      Map.entry("ignore.off", new String[] {"Du siehst <hl><name></hl> wieder", "You see <hl><name></hl> again"}),
      Map.entry("afk.on", new String[] {"<hl><name></hl> ist kurz weg", "<hl><name></hl> is away"}),
      Map.entry("afk.off", new String[] {"<hl><name></hl> ist wieder da", "<hl><name></hl> is back"}),
      // Info
      Map.entry("seen.online", new String[] {"<hl><name></hl> ist gerade online", "<hl><name></hl> is online right now"}),
      Map.entry("seen.ago", new String[] {"<hl><name></hl> war vor <hl><ago></hl> zuletzt da", "<hl><name></hl> was last here <hl><ago></hl> ago"}),
      Map.entry("near.none", new String[] {"Niemand in deiner Nähe (200 Blöcke)", "Nobody near you (200 blocks)"}),
      Map.entry("near.title", new String[] {"In deiner Nähe", "Near you"}),
      Map.entry("near.line", new String[] {"<hl><name></hl> · <dist> Blöcke", "<hl><name></hl> · <dist> blocks"}),
      Map.entry("getpos", new String[] {
          "x <hl><x></hl>  y <hl><y></hl>  z <hl><z></hl>  · <world>", "x <hl><x></hl>  y <hl><y></hl>  z <hl><z></hl>  · <world>"}),
      Map.entry("getpos.hover", new String[] {"Klick: Koordinaten in den Chat", "Click: put coordinates in the chat"}),
      Map.entry("ping", new String[] {"Dein Ping: <hl><ms> ms</hl>", "Your ping: <hl><ms> ms</hl>"}),
      Map.entry("info.title", new String[] {"Befehle", "Commands"}),
      Map.entry("info.click", new String[] {"Klick: in den Chat schreiben", "Click: put it in the chat"}),
      Map.entry("info.page", new String[] {"➜ Alles auf einer Seite", "➜ Everything on one page"}),
      Map.entry("info.page.hover", new String[] {"Öffnet deine persönliche Befehls-Seite", "Opens your personal command page"}),
      Map.entry("rules.title", new String[] {"Regeln", "Rules"}),
      Map.entry("rules.none", new String[] {"Sei nett zu allen und hab Spaß!", "Be nice to everyone and have fun!"}),
      Map.entry("welcome.title", new String[] {"Willkommen, <hl><name></hl>", "Welcome, <hl><name></hl>"}),
      Map.entry("welcome.first", new String[] {"Schön, dass du da bist, <hl><name></hl>!", "Great to have you here, <hl><name></hl>!"}),
      Map.entry("welcome.online", new String[] {"Gerade <hl><count></hl> online", "<hl><count></hl> online right now"}),
      Map.entry("welcome.spawn", new String[] {"Am Spawn: <hl>2× Leertaste</hl> zum Gleiten", "At the spawn: <hl>space twice</hl> to glide"}),
      Map.entry("btn.commands", new String[] {"✦ Befehle", "✦ Commands"}),
      Map.entry("btn.rules", new String[] {"⚑ Regeln", "⚑ Rules"}),
      Map.entry("btn.page", new String[] {"➜ Meine Seite", "➜ My page"}),
      Map.entry("btn.commands.hover", new String[] {"Alle Befehle anzeigen", "Show all commands"}),
      Map.entry("btn.rules.hover", new String[] {"Die Regeln anzeigen", "Show the rules"}),
      // Spawn
      Map.entry("spawn.protected", new String[] {"Der Spawn bleibt, wie er ist", "The spawn stays as it is"}),
      Map.entry("spawn.nosleep", new String[] {"Am Spawn kann man nicht schlafen", "You can't sleep at the spawn"}),
      Map.entry("spawn.nopvp", new String[] {"Am Spawn wird nicht gekämpft", "No fighting at the spawn"}),
      Map.entry("elytra.ready", new String[] {"Spring ab und drück <hl>2× Leertaste</hl> zum Gleiten", "Jump off and press <hl>space twice</hl> to glide"}),
      Map.entry("elytra.ready.bedrock", new String[] {"<hl>2× springen</hl>, dann in der Luft nochmal <hl>springen</hl> zum Gleiten", "<hl>Jump twice</hl>, then <hl>jump</hl> again in the air to glide"}),
      Map.entry("elytra.creative", new String[] {"Die Start-Elytra gibt es im <hl>Überlebensmodus</hl>", "The start elytra works in <hl>survival mode</hl>"}),
      Map.entry("elytra.item", new String[] {"Start-Elytra", "Start elytra"}),
      Map.entry("elytra.boost", new String[] {"<hl><key></hl> für einen Schub", "<hl><key></hl> for a boost"}),
      Map.entry("elytra.key.java", new String[] {"F", "F"}),
      Map.entry("elytra.key.bedrock", new String[] {"Schleichen", "Sneak"}),
      Map.entry("menu.content", new String[] {"Was möchtest du machen?", "What would you like to do?"}),
      Map.entry("menu.spawn", new String[] {"Zum Spawn", "To the spawn"}),
      Map.entry("menu.home", new String[] {"Nach Hause", "Go home"}),
      Map.entry("menu.homes", new String[] {"Meine Zuhause", "My homes"}),
      Map.entry("menu.sethome", new String[] {"Hier ein Zuhause speichern", "Save a home here"}),
      Map.entry("menu.mail", new String[] {"Nachrichten lesen", "Read messages"}),
      Map.entry("menu.rules", new String[] {"Regeln", "Rules"}),
      Map.entry("menu.back", new String[] {"Zurück zum letzten Ort", "Back to the last place"}),
      Map.entry("welcome.bedrock", new String[] {
          "Tippe <hl>/info</hl> – dann öffnet sich ein Menü mit allem", "Type <hl>/info</hl> – a menu with everything opens"}),
      Map.entry("team.title", new String[] {"Das Team", "The team"}),
      Map.entry("team.empty", new String[] {"Noch hat niemand einen Rang", "Nobody has a rank yet"}),
      Map.entry("sidebar.rank", new String[] {"Rang", "Rank"}),
      Map.entry("sidebar.clock", new String[] {"Uhrzeit", "Time"}),
      Map.entry("sidebar.day", new String[] {"Tag <n>", "Day <n>"}),
      Map.entry("sidebar.online", new String[] {"Online", "Online"}),
      Map.entry("sidebar.ping", new String[] {"Ping", "Ping"}),
      Map.entry("sidebar.commands", new String[] {"Befehle", "Commands"}),
      Map.entry("sidebar.on", new String[] {"Leiste rechts ist wieder da", "The bar on the right is back"}),
      Map.entry("sidebar.off", new String[] {"Leiste rechts ausgeblendet – zurück mit <hl>/leiste</hl>", "Bar on the right hidden – back with <hl>/leiste</hl>"}),
      Map.entry("update.available", new String[] {"MorniCraft <hl><version></hl> ist da", "MorniCraft <hl><version></hl> is out"}),
      Map.entry("update.open", new String[] {"Herunterladen", "Download"}),
      Map.entry("reload", new String[] {"Einstellungen neu geladen", "Settings reloaded"}),
      // Time
      Map.entry("time.minutes", new String[] {"<n> Min.", "<n> min"}),
      Map.entry("time.hours", new String[] {"<n> Std.", "<n> h"}),
      Map.entry("time.days", new String[] {"<n> Tagen", "<n> days"}));

  private final int lang;

  Texts(String language) {
    this.lang = "en".equalsIgnoreCase(language) ? 1 : 0;
  }

  String get(String key) {
    String[] pair = TEXTS.get(key);
    return pair == null ? key : pair[lang];
  }
}
