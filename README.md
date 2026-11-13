<p align="center">
  <img src="docs/screenshots/banner.webp" alt="MorniHosting – dein eigenes Game-Hosting zu Hause" width="100%">
</p>

<p align="center">
  <b>Game-Server zu Hause – so einfach wie bei einem großen Hoster.</b><br>
  Minecraft, Factorio, Counter-Strike 2, Garry's Mod, Satisfactory, Euro Truck Simulator 2 und Hytale:
  anlegen, starten, Mods installieren, Backups machen – alles im Browser, ohne Fachwissen und ohne monatliche Kosten.
</p>

<p align="center">
  <a href="https://github.com/pmornhart/MorniHosting/actions/workflows/ci.yml"><img src="https://github.com/pmornhart/MorniHosting/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Lizenz-MIT-10b981" alt="Lizenz: MIT">
  <img src="https://img.shields.io/badge/Sprachen-DE%20%7C%20EN-10b981" alt="Sprachen: Deutsch und Englisch">
  <img src="https://img.shields.io/badge/Plattform-Proxmox%20%7C%20Linux%20%7C%20Docker-10b981" alt="Plattform: Proxmox, Linux, Docker">
  <img src="https://img.shields.io/badge/Minecraft-Java%20%26%20Bedrock-10b981" alt="Minecraft: Java und Bedrock">
  <img src="https://img.shields.io/badge/Spiele-7-10b981" alt="7 Spiele">
</p>

<p align="center">
  <a href="#installation"><b>Installation</b></a> ·
  <a href="#mehr-als-minecraft"><b>Spiele</b></a> ·
  <a href="#was-kann-mornihosting"><b>Funktionen</b></a> ·
  <a href="#deine-domain-und-passkeys"><b>Domain &amp; Passkeys</b></a> ·
  <a href="#eigene-domain-ohne-netbird"><b>Eigene Domain</b></a> ·
  <a href="#netbird-eigene-domain-ohne-portfreigabe"><b>NetBird</b></a> ·
  <a href="#updates"><b>Updates</b></a> ·
  <a href="#häufige-fragen"><b>Fragen</b></a>
</p>

MorniHosting ist ein Web-Panel für deine eigenen Game-Server – auf Proxmox, einem Mini-PC, einem Raspberry
Pi oder einem gemieteten Server. Es kann alles, was du für deine Server brauchst, und ist so aufgeräumt
wie die Panels von GGServers oder Nodecraft. Leitsatz: **Jede häufige Aufgabe in höchstens 3
Klicks – ohne Anleitung.**

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/landing.webp" alt="Startseite mit Anmelden und Konto anfragen"></td>
    <td width="50%"><img src="docs/screenshots/dashboard.webp" alt="Übersicht mit Minecraft- und anderen Spiele-Servern"></td>
  </tr>
  <tr>
    <td><b>Startseite wie bei einem Hoster</b><br>Anmelden oder „Konto anfragen“ – du gibst neue Leute frei.</td>
    <td><b>Alle Server auf einen Blick</b><br>Minecraft und andere Spiele nebeneinander, live mit RAM und CPU.</td>
  </tr>
</table>

## Mehr als Minecraft

<p align="center">
  <img src="docs/screenshots/order.webp" alt="Spielauswahl: Minecraft Java, Bedrock, Geyser und weitere Spiele wie Factorio, Counter-Strike 2 und Garry's Mod" width="100%">
</p>

| Spiel                         | Was dabei ist                                                              |
| ----------------------------- | -------------------------------------------------------------------------- |
| ⛏️ **Minecraft Java**         | Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Velocity – Plugins & Mods |
| 📱 **Minecraft Bedrock**      | Für Handy, Konsole und Windows; mit Geyser auch zusammen mit Java          |
| 🏭 **Factorio**               | Stabil oder neueste Version, Space Age, Konsole über RCON                  |
| 🔫 **Counter-Strike 2**       | Wettkampf, Deathmatch, Workshop-Karten                                     |
| 🧱 **Garry's Mod**            | Sandbox, Trouble in Terrorist Town, Workshop-Addons                        |
| 🏗️ **Satisfactory**           | Koop-Fabrikbau mit Freunden                                                |
| 🚚 **Euro Truck Simulator 2** | Konvoi-Server, Einrichtung per Upload-Assistent                            |
| 🗡️ **Hytale**                 | Mit offiziellem Downloader                                                 |

<p align="center">
  <img src="docs/screenshots/game-server.webp" alt="Factorio-Server im Panel mit Konsole" width="100%">
</p>

Jedes Spiel bekommt dieselbe Server-Seite: Adresse zum Kopieren, Live-Konsole, Einstellungen, Dateien, Backups
und Routinen. Ausführlich: [docs/spiele.md](docs/spiele.md).

## So legst du einen Server an

Wie bei einem Hoster, nur kostenlos: Spiel wählen (Java, Bedrock oder Crossplay), ein Paket mit Spielerzahl
(2 GB für etwa 4 Spieler bis 16 GB für etwa 100 – oder „Benutzerdefiniert“), Software und Version, den Namen unter
deiner Domain und Add-ons wie Bedrock-Spieler, Voice-Chat oder tägliche Backups. Rechts steht die Bestellübersicht
(0,00 €). Der Server startet sofort, und oben steht die Adresse für deine Freunde zum Kopieren.

## Was kann MorniHosting?

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/server.webp" alt="Server-Seite mit Banner, Adresse und Live-Konsole"></td>
    <td width="50%"><img src="docs/screenshots/approvals.webp" alt="Server-Anfragen mit Spiel, Software und Version"></td>
  </tr>
  <tr>
    <td><b>Server-Seite</b><br>Adresse zum Kopieren, Live-Konsole mit Farben und Verlauf, alle Reiter auf einen Blick.</td>
    <td><b>Freigaben in Echtzeit</b><br>Neue Konten und Server-Anfragen erscheinen sofort – freigeben im Panel, per Mail oder per Discord-Knopf.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/console.webp" alt="Live-Konsole"></td>
    <td><img src="docs/screenshots/market.webp" alt="Plugin-Marktplatz"></td>
  </tr>
  <tr>
    <td><b>Live-Werte und Verlauf</b><br>Festplatte, Netzwerk, Prozessor und RAM live, dazu der Verlauf über Stunde, Tag oder Woche.</td>
    <td><b>Plugins und Mods mit einem Klick</b><br>Aus Modrinth, Hangar, SpigotMC und CurseForge – nur was zu deinem Server passt, Abhängigkeiten automatisch.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/plugins.webp" alt="Installierte Plugins mit An/Aus-Schalter"></td>
    <td><img src="docs/screenshots/files.webp" alt="Datei-Manager"></td>
  </tr>
  <tr>
    <td><b>Installierte Plugins</b><br>An/Aus-Schalter, Updates per Klick, eigene <code>.jar</code> per Drag &amp; Drop.</td>
    <td><b>Dateien</b><br>Ordnerbaum, Drag &amp; Drop, Editor mit Syntaxfarben, ZIP, Papierkorb für 7 Tage.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/backups.webp" alt="Backups"></td>
    <td><img src="docs/screenshots/schedules.webp" alt="Zeitpläne"></td>
  </tr>
  <tr>
    <td><b>Backups</b><br>Per Klick oder geplant, die Welt wird vorher gespeichert, Wiederherstellen legt eine Sicherheitskopie an.</td>
    <td><b>Zeitpläne ohne Cron</b><br>„Jeden Tag um 04:00 neu starten“ – mit Vorwarnung im Spiel-Chat.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/players.webp" alt="Spieler"></td>
    <td><img src="docs/screenshots/geyser.webp" alt="Bedrock-Spieler erlauben"></td>
  </tr>
  <tr>
    <td><b>Spieler</b><br>Online-Liste mit Köpfen, OP, Kick, Bann und Whitelist per Klick. Mit verbundenem Minecraft-Konto bist du auf deinen Servern automatisch OP.</td>
    <td><b>Netzwerk</b><br>Adresse für Freunde, Prüfung „Von außen erreichbar?“ und Bedrock-Spieler (Geyser) mit einem Schalter.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/admin.webp" alt="Admin-Bereich: Updates"></td>
    <td><img src="docs/screenshots/outbox.webp" alt="E-Mail mit Postausgang"></td>
  </tr>
  <tr>
    <td><b>Admin-Bereich</b><br>Domain, NetBird, Updates per Klick, DDoS-Schutz, E-Mail, Passwörter, Umzug – nach Themen sortiert.</td>
    <td><b>E-Mail mit Postausgang</b><br>Schnellstart mit zwei Angaben; jede Mail und Discord-Nachricht steht mit Ergebnis oder Grund im Postausgang.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/ddos.webp" alt="DDoS-Schutz"></td>
    <td><img src="docs/screenshots/move.webp" alt="Umzug per Code"></td>
  </tr>
  <tr>
    <td><b>DDoS-Schutz</b><br>Grenzen pro Absender für alle Server-Ports, mit einem Schalter.</td>
    <td><b>Umzug per Code</b><br>Alle Einstellungen und Verbindungen mit Passwort auf ein anderes Panel übertragen.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/voicechat.webp" alt="Voice-Chat mit einem Schalter"></td>
    <td><img src="docs/screenshots/netbird.webp" alt="NetBird-Anleitung im Admin-Bereich"></td>
  </tr>
  <tr>
    <td><b>Voice-Chat</b><br>Simple Voice Chat mit einem Schalter: Plugin, UDP-Port und Adresse für die Spieler richten sich selbst ein.</td>
    <td><b>Eigene Domain mit NetBird</b><br>Einmal verbinden, dann reicht pro Server ein Name: MorniHosting legt <code>minecraft.deine-domain.de</code> selbst in NetBird an.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="34%"><img src="docs/screenshots/phone-landing.webp" alt="Startseite auf dem Handy"></td>
    <td width="33%"><img src="docs/screenshots/phone.webp" alt="Übersicht auf dem Handy"></td>
    <td width="33%"><img src="docs/screenshots/phone-server.webp" alt="Server-Seite auf dem Handy"></td>
  </tr>
  <tr>
    <td colspan="3" align="center"><b>Am Computer oder auf dem Handy, hell oder dunkel.</b></td>
  </tr>
</table>

<details>
<summary><b>Alle Funktionen als Liste</b></summary>

| Bereich                   | Was du bekommst                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🖥️ **Server**             | Java (Vanilla, Paper, Purpur, Fabric, Forge, NeoForge), Velocity-Proxy und Bedrock. Bestellseite wie bei einem Hoster, bis 128 GB RAM pro Server.                                                                   |
| 🎮 **Weitere Spiele**     | Factorio, Counter-Strike 2, Garry's Mod, Satisfactory, Euro Truck Simulator 2 und Hytale – mit Einstellungen und Konsole im selben Panel.                                                                           |
| 📦 **Import**             | Vorhandenen Server als ZIP hochladen – Software und Version werden erkannt.                                                                                                                                         |
| 🔗 **Adresse**            | Oben auf jeder Server-Seite: Adresse zum Kopieren, öffentliche und lokale IP, Prüfung „Von außen erreichbar?“ mit Hilfe zur Portfreigabe.                                                                           |
| ⌨️ **Konsole**            | Live, mit Farben, Befehlsverlauf (↑/↓), Tab-Ergänzung, Suche und Kopieren.                                                                                                                                          |
| 🩺 **Absturz-Helfer**     | Erkennt typische Fehler (falsche Java-Version, zu wenig RAM, fehlende Abhängigkeit) und erklärt die Lösung mit einem Knopf.                                                                                         |
| 🧩 **Marktplatz**         | Plugins, Mods und Modpacks aus Modrinth, Hangar, SpigotMC und (mit eigenem Schlüssel) CurseForge. Nur passende Versionen, Abhängigkeiten automatisch.                                                               |
| 🔌 **Plugins**            | Liste mit An/Aus-Schalter, Updates per Klick, eigene `.jar` per Drag & Drop.                                                                                                                                        |
| 📁 **Dateien**            | Ordnerbaum, Drag & Drop, Editor mit Syntaxfarben, ZIP packen und entpacken, Papierkorb (7 Tage).                                                                                                                    |
| ⚙️ **Einstellungen**      | `server.properties` als Formular mit Erklärung zu jeder Einstellung, MOTD-Editor mit Farbvorschau, Server-Bild.                                                                                                     |
| 👥 **Spieler**            | Online-Liste mit Köpfen, OP, Kick, Bann und Whitelist per Klick – auch für Spieler, die gerade offline sind.                                                                                                        |
| 🌍 **Welten**             | Welt hochladen, wechseln oder neu erzeugen (mit Seed).                                                                                                                                                              |
| ✦ **MorniCraft**          | Fertiger Freunde-Server mit unserem eigenen Plugin ([auch einzeln](https://github.com/pmornhart/MorniCraft)): Spawn-Insel über dem Meer, /home, /tpa, Start-Elytra, Leiste rechts – alles im Dashboard einstellbar. |
| 🧑‍⚖️ **Team-Dashboard**     | `/teamdashboard` im Spiel: Webseite für Moderatoren und Owner mit allen Spielern, Inventar, Gefängnis, Stumm, Banns und Strafen-Verlauf – Knöpfe je nach Rolle, Regeln ändern für Owner.                            |
| 📱 **Bedrock-Spieler**    | Geyser und Floodgate mit einem Schalter: Freunde auf Handy, Konsole oder Windows spielen auf deinem Java-Server mit.                                                                                                |
| 💾 **Backups**            | Per Klick oder geplant, Welt wird vorher gespeichert, Aufbewahrung, Ausschlüsse, Download, Wiederherstellen mit Sicherheitskopie.                                                                                   |
| ⏰ **Zeitpläne**          | Neustart, Backup oder Befehl – „jeden Tag um 04:00“ statt Cron-Syntax, mit Vorwarnung im Spiel-Chat.                                                                                                                |
| 📊 **Statistik**          | CPU, RAM, TPS und Spieler über die letzte Stunde, 24 Stunden oder 7 Tage.                                                                                                                                           |
| 🔔 **Benachrichtigungen** | Discord, Slack, Microsoft Teams oder eigene Webhooks: Server gestartet oder abgestürzt, Backup fertig, Spieler beigetreten.                                                                                         |
| 🔐 **Benutzer & Rollen**  | Rollen pro Server (Besitzer, Moderator, Zuschauer oder eigene), Passkeys, 2FA per App, Protokoll aller Aktionen.                                                                                                    |
| 🛡️ **Admin-Bereich**      | Domain des Panels, Updates per Klick, Passwörter anderer zurücksetzen, Einstellungen für das ganze Panel.                                                                                                           |
| 🙋 **Freigaben**          | Registrierung auf der Startseite („Konto anfragen“) und Server-Anfragen – du gibst sie im Panel, per Mail oder per Discord-Knopf frei, in Echtzeit.                                                                 |
| 💬 **Discord-Bot**        | Private Nachrichten bei neuen Anfragen und Abstürzen, `/verbinden` mit einem Klick, Profilbild und Beschreibung stellt das Panel selbst ein.                                                                        |
| ✉️ **E-Mail**             | Willkommen, Bestätigung, „Passwort vergessen“, Bestellungen. Schnellstart mit zwei Angaben, **Postausgang** zeigt jede Mail und warum sie hängt.                                                                    |
| 🛡️ **DDoS-Schutz**        | Grenzen pro Absender für Verbindungen und Pakete auf allen Server-Ports, mit einem Schalter im Admin-Bereich.                                                                                                       |
| 📦 **Umzug**              | Alle Einstellungen und Verbindungen per Code (mit Passwort) auf ein anderes MorniHosting übertragen.                                                                                                                |
| ⬆️ **Updates**            | Das Panel zeigt neue Versionen an und aktualisiert sich per Knopfdruck. Deine Minecraft-Server laufen dabei weiter.                                                                                                 |
| 🌗 **Bedienung**          | Dunkel und hell, Deutsch und Englisch, auch auf dem Handy gut bedienbar.                                                                                                                                            |

</details>

## Installation

Du brauchst einen Rechner mit Linux und **mindestens 4 GB RAM** (besser 8 GB) – zum Beispiel einen
Proxmox-Server, einen Mini-PC oder eine VM. Wähle **einen** der drei Wege:

### A) Proxmox: ein Befehl, fertig (empfohlen)

In Proxmox den Host öffnen (z. B. `pve`) → **Shell** → diese Zeile einfügen:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/mornihosting.sh)"
```

| CPU     | RAM  | Platte | System    | Adresse danach             |
| ------- | ---- | ------ | --------- | -------------------------- |
| 4 Kerne | 8 GB | 100 GB | Debian 12 | `http://<IP des LXC>:8080` |

Das Skript legt einen eigenen Container an, installiert Docker und MorniHosting und zeigt dir am Ende die
Adresse. Alle Werte kannst du vorher ändern. Nutzt du [NetBird](#netbird-eigene-domain-ohne-portfreigabe), fragt
es nach deinem Setup-Key und nimmt den Container gleich in dein NetBird-Netz auf. Mehr dazu:
[Proxmox-Anleitung](docs/proxmox-quickstart.md).

**Dauerbetrieb** (schon installiert? Einmal auf dem Proxmox-Host): hält Container, Docker, Panel, NetBird und
Spielserver von selbst am Laufen – nur wenn du den Container über Proxmox stoppst, bleibt er aus.
[Mehr dazu](docs/dauerbetrieb.md).

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/dauerbetrieb.sh)"
```

### B) Debian oder Ubuntu (Server, VM, Mini-PC)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/install.sh)"
```

Installiert Docker (falls nötig), legt das Panel nach `/opt/mornihosting`, erzeugt eine `.env` mit zufälligem
Geheimnis und richtet den Update-Knopf ein.

### C) Von Hand mit Docker Compose (auch Windows mit Docker Desktop)

```bash
git clone https://github.com/pmornhart/MorniHosting.git
cd MorniHosting
cp .env.example .env
# In der .env bei MH_SECRET einen langen Zufallswert eintragen, z. B. aus: openssl rand -hex 32
docker compose up -d
```

Gibt es noch kein fertiges Image, baust du es mit `docker compose up -d --build` selbst (dauert beim ersten
Mal ein paar Minuten). Unter Windows läuft das in der PowerShell genauso; den Zufallswert bekommst du dort
z. B. mit `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`.

<details>
<summary>Alle Einstellungen in der <code>.env</code></summary>

| Name                | Pflicht | Bedeutung                                                                                                |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `MH_SECRET`         | ja      | Langer Zufallswert. Schützt Sitzungen und gespeicherte Schlüssel. Nie teilen.                            |
| `MH_PANEL_PORT`     | nein    | Port des Panels im Browser, Standard `8080`.                                                             |
| `MH_LAN_IP`         | nein    | IP des Rechners im Heimnetz, damit die Adress-Karte sie zeigen kann.                                     |
| `MH_PUBLIC_ADDRESS` | nein    | Domain oder DynDNS-Name für deine Freunde, z. B. `mc.example.de`.                                        |
| `TZ`                | nein    | Zeitzone für Zeitpläne, Standard `Europe/Berlin`.                                                        |
| `MH_TRUST_PROXY`    | nein    | `true`, wenn das Panel hinter einem Reverse-Proxy mit HTTPS läuft (Nginx Proxy Manager, Traefik, Caddy). |
| `MH_IMAGE_TAG`      | nein    | Bestimmte Panel-Version statt `latest`, z. B. `1.0.0`.                                                   |

</details>

## Erster Start

1. Öffne `http://<IP-deines-Rechners>:8080` im Browser.
2. Der **Einrichtungs-Assistent** fragt nach Sprache und deinem Administrator-Konto. Es gibt kein
   Standard-Passwort – du legst dein eigenes an.
3. Klicke auf **Neuer Server**, wähle Java oder Bedrock, die Software und die Version – fertig. Der Server
   startet sofort und die Adresse für deine Freunde steht oben auf der Seite.

## Freunde einladen

Im Heimnetz reicht die Adresse oben auf der Server-Seite. Für Freunde aus dem Internet gibst du im Router die
Ports an deinen Rechner weiter:

| Port                     | Protokoll | Wofür                                        |
| ------------------------ | --------- | -------------------------------------------- |
| 25565 (bzw. Server-Port) | TCP       | Java-Server                                  |
| 19132                    | UDP       | Bedrock-Server oder Geyser (Bedrock-Spieler) |
| 24454                    | UDP       | Voice-Chat (Simple Voice Chat)               |

Der Knopf **Jetzt prüfen** auf der Server-Seite sagt dir, ob es klappt. Kein Zugriff auf den Router? Dann hilft
ein Tunnel wie [playit.gg](https://playit.gg) – der Knopf dazu steht direkt daneben – oder
[NetBird](#netbird-eigene-domain-ohne-portfreigabe).

Nutzt der Tunnel oder Router nach außen einen anderen Port, trag ihn beim Server unter **Einstellungen →
Öffentlicher Port** ein (beim Voice-Chat im Voice-Chat-Kasten). Dann zeigt MorniHosting überall die Adresse, die
deine Freunde wirklich eintippen müssen.

## Deine Domain und Passkeys

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/account.webp" alt="Passkeys im Konto"></td>
    <td width="50%"><img src="docs/screenshots/reset.webp" alt="Neues Passwort für Lena"></td>
  </tr>
  <tr>
    <td><b>Passkeys</b> im Konto hinzufügen und entfernen.</td>
    <td><b>Passwort vergessen?</b> Der Admin erzeugt ein neues, es wird genau einmal angezeigt.</td>
  </tr>
</table>

Mit einer eigenen Domain erreichst du das Panel über `https://panel.deine-domain.de`, und die Anmeldung mit
**Passkey** (Fingerabdruck, Gesicht oder Geräte-PIN) funktioniert. Browser erlauben Passkeys nur über HTTPS.

1. **Domain auf dich zeigen lassen:** Beim Domain-Anbieter einen Eintrag (A-Record) auf deine öffentliche IP
   setzen – oder eine DynDNS-Adresse nutzen.
2. **HTTPS davorsetzen:** z. B. mit Nginx Proxy Manager oder Caddy. Ziel ist `http://<IP des Panels>:8080`.
3. **Panel Bescheid sagen:** In der `.env` `MH_TRUST_PROXY=true` setzen und neu starten (`update`). Dann im
   Panel unter **Admin-Bereich → Domain** die Adresse eintragen.
4. **Passkey anlegen:** Panel über die Domain öffnen → **Mein Konto → Passkeys → Passkey hinzufügen**. Ab
   jetzt reicht auf der Anmeldeseite ein Klick auf **Mit Passkey anmelden**.

Das Passwort bleibt als Rückfallebene erhalten. Wer sein Passwort vergessen hat, bekommt im **Admin-Bereich →
Passwörter** mit zwei Klicks ein neues.

## Eigene Domain ohne NetBird

Du hast eine Domain (z. B. `mornihosting.de`) und die Ports im Router freigegeben? Dann trägt MorniHosting die
Adressen selbst bei deinem DNS-Anbieter ein – **INWX**, **Cloudflare** (kostenlos, geht mit jeder Domain) oder
**IONOS**.

1. Zugang vorbereiten:
   - **INWX:** nichts extra – Benutzername und Passwort deines INWX-Kontos genügen. Mit Zwei-Faktor-Anmeldung
     zusätzlich den 2FA-Schlüssel (der Text hinter dem QR-Code), dann erzeugt das Panel die Codes selbst.
     Tipp: bei INWX einen eigenen Unterbenutzer nur für DNS anlegen.
   - **Cloudflare:** Domain bei Cloudflare hinzufügen und beim Domain-Anbieter die Nameserver von Cloudflare
     eintragen. Dann **Profil → API-Tokens → Token erstellen → Vorlage „DNS-Zone bearbeiten“**, Zone: deine Domain.
   - **IONOS:** auf [developer.hosting.ionos.de](https://developer.hosting.ionos.de) einen API-Schlüssel anlegen
     (Form `Präfix.Geheimnis`).
2. Im Panel **Admin-Bereich → Eigene Domain**: Anbieter wählen, Zugang eintragen, **Verbinden**, Domain wählen,
   **Speichern**. Die Domain selbst und `*.deine-domain` zeigen danach auf deine öffentliche IP.
3. Optional **HTTPS einschalten** (gleiche Karte): Das Panel startet einen kleinen Caddy-Container auf Port 80 und
   443 und holt die Zertifikate selbst. Dann öffnet `https://mornihosting.de` die Anmeldeseite, und jeder
   Server-Name (`https://reich.mornihosting.de`) führt auch dorthin. Dafür im Router TCP 80 und 443 auf den
   MorniHosting-Rechner freigeben.
4. Beim **Server bestellen** wählst du den Namen selbst (vorausgefüllt ist ein lustiger wie `wilder-axolotl`):
   MorniHosting legt `name.mornihosting.de` an (A-Eintrag auf deine öffentliche IP) und für Java einen SRV-Eintrag.
   - **Java:** Spieler tippen nur `name.mornihosting.de` – ohne Port.
   - **Bedrock:** Bedrock kennt keine SRV-Einträge. Spieler tragen `name.mornihosting.de` als Adresse und den Port
     ins eigene Port-Feld ein. Nur ein Bedrock-Server (bzw. Geyser) auf 19132 klappt ganz ohne Port-Angabe – der
     erste bekommt automatisch 19132.

Ändert sich deine öffentliche IP (Zwangstrennung), zieht das Panel alle Einträge innerhalb von 5 Minuten nach –
wie DynDNS. Pro Panel geht entweder NetBird oder die eigene Domain.

## NetBird: eigene Domain ohne Portfreigabe

Deine Domain liegt bei [NetBird](https://netbird.io)? Dann bekommst du HTTPS für das Panel und Adressen für
deine Minecraft-Server, ohne im Router etwas freizugeben.

### Automatisch: einmal verbinden, dann nur noch Namen vergeben

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/netbird-auto.webp" alt="NetBird im Admin-Bereich verbunden"></td>
    <td width="50%"><img src="docs/screenshots/netbird-server.webp" alt="Server-Adressen, die MorniHosting in NetBird angelegt hat"></td>
  </tr>
</table>

1. In NetBird einen API-Schlüssel anlegen: **Team → Service Users** → Service-User mit Rolle „Admin“ →
   **Create Token**.
2. Im Panel unter **Admin-Bereich → NetBird** den Schlüssel einfügen, **Verbinden**, deine Domain und den
   Rechner wählen (beim Proxmox-Einzeiler heißt er `mornihosting`), **Speichern**.
3. Optional **Adresse fürs Panel → Einrichten** (Name frei wählbar, z. B. `hosting`): Das Panel ist dann
   unter `https://hosting.deine-domain.de` erreichbar und die Domain für Passkeys ist gleich eingetragen.
   **Name leer lassen** = das Panel läuft direkt unter `https://deine-domain.de`. Dafür beim Domain-Anbieter
   die Hauptdomain per A-Eintrag auf die IP des NetBird-Proxys zeigen lassen (ein CNAME geht dort nicht).
4. Beim **Server anlegen** steht schon ein Name, z. B. `minecraft` – fertig. MorniHosting legt in NetBird
   `minecraft.deine-domain.de` an, bei Bedrock-Spielern (Geyser) `minecraft-bedrock…` und beim Voice-Chat
   `minecraft-voice…`. Ändern oder entfernen kannst du den Namen in den Server-Einstellungen.

<img src="docs/screenshots/netbird-wizard.webp" alt="Beim Anlegen nur noch den Namen eingeben" width="100%">

**Eine Resource pro Server:** Kennt das Panel die Heimnetz-Adresse des Rechners (**Admin-Bereich →
Einstellungen → LAN-IP**, z. B. `10.13.4.103`), legt es in NetBird unter **Networks** das Netzwerk
„MorniHosting“ an – mit dem Rechner als Routing-Peer – und für jeden Server und das Panel eine eigene
**Resource**. Die Domain-Dienste zeigen auf diese Resource, also immer auf die richtige Adresse im Heimnetz.
Wird ein Server gelöscht, verschwindet auch seine Resource.

Den Port nach außen vergibt NetBird Cloud selbst, die Adresse sieht also so aus:
`minecraft.deine-domain.de:31234`. MorniHosting zeigt sie überall fertig zum Kopieren an.

Betreibst du NetBird selbst, trägst du beim Verbinden unter **Eigener NetBird-Server?** die Adresse deines
NetBird-Dashboards ein. Läuft NetBird auf dem Rechner mit MorniHosting, übernimmt das Panel sie bei jedem
`update` selbst. Wichtig: Der Proxy eines selbst betriebenen NetBird lässt nur Port 443 durch. Erlaubt er eigene
Ports, nimmt MorniHosting nach außen denselben Port wie der Server (`minecraft.deine-domain.de` für 25565). Gib
die Ports dann einmal beim Dienst `netbird-proxy` in der `docker-compose.yml` deines NetBird-Servers und in dessen
Firewall frei, z. B. `25565-25575/tcp`, `19132-19140/udp` und `24454-24460/udp` – automatisch mit
`curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-proxy-ports.sh | sudo bash` auf dem NetBird-Server. Die genaue Liste steht im Panel
unter **Admin-Bereich → NetBird**.

### Von Hand

Die komplette Anleitung steht im Panel unter **Admin-Bereich → Domain → Reiter „NetBird“** – dort sind alle
Werte schon mit deinen Adressen und Ports ausgefüllt, du musst nur noch kopieren.

<img src="docs/screenshots/netbird-ports.webp" alt="NetBird-Anleitung: Panel und Minecraft-Server freigeben" width="100%">

Kurz gesagt:

1. NetBird auf dem Rechner mit MorniHosting installieren (`curl -fsSL https://pkgs.netbird.io/install.sh | sh`,
   dann `netbird up --setup-key <KEY>`).
2. In NetBird unter **Reverse Proxy → Custom Domains** deine Domain anlegen und beim Domain-Anbieter den
   CNAME-Eintrag `*.deine-domain.de → eu.proxy.netbird.io` setzen.
3. Einen **HTTP-Service** für das Panel anlegen (Ziel: IP des Panels, Port 8080) und **Pass Host Header**
   einschalten. Danach die Adresse im **Admin-Bereich** als Domain des Panels eintragen.
4. Für jeden Minecraft-Server einen **TCP-Service** (Java) bzw. **UDP-Service** (Bedrock, Geyser, Voice-Chat)
   anlegen und den Port, den NetBird vergibt, beim Server als **Öffentlicher Port** eintragen.

Ausführlich mit allen Feldern: [docs/netbird.md](docs/netbird.md).

## E-Mail einrichten (Schnellstart)

Das Panel verschickt Mails (Willkommen, Registrierung, „Passwort vergessen“, Bestellungen). Einrichten geht in einer Minute:

1. Ein Postfach fürs Panel anlegen, z. B. `noreply@deine-domain.de` (bei Stalwart, INWX, IONOS, Gmail …).
2. **Admin-Bereich → E-Mail → Schnellstart:** E-Mail-Adresse und Passwort eintragen.
3. Läuft der Mailserver bei dir zu Hause (z. B. Stalwart)? Schalter **„Mein Mailserver steht bei mir zu Hause“** an und seine IP eintragen, z. B. `192.168.178.116`.
4. **„Einrichten und Test-Mail senden“** klicken.

Das Panel sucht Mailserver, Port (465/587) und Verschlüsselung selbst heraus, prüft das Zertifikat und speichert, was funktioniert. Danach zeigt es Schritt für Schritt (DNS → Verbindung → TLS → Anmeldung → Versand), was geklappt hat, und bei einem Fehler, was zu tun ist.

👉 Ausführliche Schritt-für-Schritt-Anleitung: [docs/email-schnellstart.md](docs/email-schnellstart.md) · Profi-Einstellungen: [docs/email.md](docs/email.md)

## Freigaben und Discord-Benachrichtigungen

- **Registrierung mit Freigabe:** Auf der Startseite gibt es „Konto anfragen“ (E-Mail ist Pflicht). Sobald jemand absendet, bekommst du eine Mail und, wenn verbunden, eine Discord-DM mit den Knöpfen **Freigeben** und **Ablehnen** – schon bevor die Person ihre Adresse bestätigt hat. Im Panel steht die Anfrage sofort unter **Freigaben** (ohne Neuladen).
- **Server-Anfragen:** Wer keine Server selbst erstellen darf, fragt einen an. Du gibst ihn per Discord-Knopf, im Panel oder nach der Mail frei, dann wird er für die Person angelegt.
- **Discord-Bot, nur private Nachrichten:** Freigaben, Abstürze und Antworten auf Anfragen kommen per DM. Kein Discord-Server und kein offener Port nötig. Verbinden: in Discord `/verbinden` → **Jetzt verbinden** → im Panel **Ja, verbinden**.
- **Postausgang:** Unter **Admin-Bereich → E-Mail** und **Benachrichtigungen** steht jede Mail und Discord-Nachricht mit „angenommen/zugestellt“ oder dem Grund, warum sie nicht rausging.

👉 Einrichten in 4 Minuten: [docs/discord.md](docs/discord.md)

## Team-Dashboard für dein Server-Team

Auf MorniCraft-Servern tippen **Moderatoren und Owner** im Spiel `/teamdashboard` und bekommt einen persönlichen
Link (12 Stunden gültig, nur für sie). Die Seite zeigt alle Spieler online, wer gerade im Gefängnis sitzt, stumm
oder eingefroren ist, die Banns und den ganzen Strafen-Verlauf. Ein Klick auf einen Spieler zeigt Inventar,
Endertruhe, Leben, Ping und bisherige Strafen.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/team-dashboard.webp" alt="Team-Dashboard mit Spielern, Gefängnis, Stumm und Banns"></td>
    <td width="50%"><img src="docs/screenshots/team-player.webp" alt="Spieler im Team-Dashboard mit Inventar und Knöpfen"></td>
  </tr>
</table>

Jeder sieht nur, was zu seiner Rolle passt:

| Rolle                | Darf                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| Supporter, Moderator | Gefängnis, Freilassen, Stummschalten, Einfrieren – auch bei Offline-Spielern |
| mit Kick-/Bann-Recht | zusätzlich Rauswerfen, Bannen (auf Zeit oder für immer) und Entbannen        |
| Owner, Admin         | alles, dazu Koordinaten, Ränge vergeben und die Server-Regeln ändern         |

Die Seite braucht eine Panel-Domain (Admin-Bereich → Domain). Alles, was dort passiert, landet im Strafen-Verlauf.

## Umzug auf ein anderes Panel

**Admin-Bereich → Umzug:** Auf dem alten Panel ein Passwort wählen und **Code erstellen** (kopieren oder als
Datei speichern). Auf dem neuen Panel den Code einfügen, Passwort eingeben, **Einstellungen übernehmen** –
Domain, E-Mail, Discord-Bot, NetBird, DNS, HTTPS, DDoS-Schutz und Registrierung sind dann drüben. Server,
Benutzer und Dateien bleiben, wo sie sind.

## Updates

<img src="docs/screenshots/admin.webp" alt="Admin-Bereich mit Updates" width="100%">

MorniHosting folgt dem neuesten Stand von `main` auf GitHub – ein eigenes Release ist dafür nicht nötig.

- **Im Panel:** **Admin-Bereich → Updates** zeigt, welche Version läuft, was seitdem neu ist („Was ist neu?“)
  und hat den Knopf **Jetzt aktualisieren**. Danach siehst du live, was passiert: neuen Code holen, Panel bauen,
  Panel neu starten – mit den letzten Zeilen des Updaters. Ist das Update fertig, lädt die Seite von selbst neu.
  Unten links in der Seitenleiste erscheint ein Hinweis, sobald es Neues gibt.
- **Reagiert der Updater nicht** (z. B. weil er auf dem Rechner nicht eingerichtet ist), sagt das Panel das nach
  zwei Minuten und zeigt den Befehl für die Konsole.
- **Auf der Konsole:** `update` (nach Weg A oder B) bzw. `sudo /opt/mornihosting/update.sh`.
- **Weg C (von Hand):** `git pull` und danach `docker compose up -d --build`.

Gebaut wird immer aus dem eben geholten Code. Wer lieber das fertige Image von ghcr.io nimmt, trägt in der `.env`
`MH_IMAGE_TAG=latest` (oder eine Version) ein. Deine Minecraft-Server sind eigene Container und laufen während des
Updates einfach weiter.

## Sicherheit

- **Kein direkter Docker-Zugriff:** Das Panel spricht Docker nur über einen
  [Socket-Proxy](https://github.com/Tecnativa/docker-socket-proxy) mit minimalen Freigaben, in einem internen
  Netz ohne Internet.
- **Ohne Root:** Der Panel-Container läuft als normaler Benutzer, schreibgeschützt, mit `cap_drop: ALL` und
  `no-new-privileges`.
- **Keine Standard-Passwörter:** Das erste Konto legst du selbst an; Geheimnisse stehen nur in der `.env`.
- **Anmeldung:** Passwörter mit Argon2, Passkeys nach WebAuthn-Standard (an die Domain gebunden, daher sicher
  gegen nachgemachte Seiten), Sitzungs-Cookies (`httpOnly`, `SameSite`, bei HTTPS `Secure`), CSRF-Schutz,
  Rate-Limit beim Login, 2FA per Authenticator-App, API-Schlüssel nur als Hash gespeichert.
- **Dateien:** Jeder Pfad bleibt im Ordner des Servers (kein `../`), ZIPs werden auf „Zip-Slip“ geprüft,
  Uploads haben ein Größenlimit, im Plugin-Bereich sind nur `.jar` erlaubt.
- **Downloads:** Plugins und Mods kommen nur von Modrinth, Hangar, SpigotMC, CurseForge und (für Floodgate)
  GeyserMC – über HTTPS, jede Weiterleitung wird geprüft, die Prüfsumme wird verglichen, wenn die Quelle eine
  liefert.
- **Webhooks:** Adressen werden verschlüsselt gespeichert und dürfen nicht ins Heimnetz zeigen.

Das Panel selbst (Port 8080) gehört **nicht** ungeschützt ins Internet. Für unterwegs nimm ein VPN (WireGuard,
Tailscale) oder einen Reverse-Proxy mit HTTPS wie oben beschrieben.

Eine Sicherheitslücke gefunden? Bitte nicht als öffentliches Issue, sondern über
[GitHub Security Advisories](https://github.com/pmornhart/MorniHosting/security/advisories/new) melden.

## Häufige Fragen

<details>
<summary><b>Wie viel RAM brauche ich?</b></summary>

Pro Server: Vanilla oder Paper 2–4 GB, Modpacks 6–10 GB. Dazu etwa 1 GB für System und Panel. Der Assistent
schlägt dir einen Wert vor und warnt, wenn du mehr verteilst, als frei ist.

</details>

<details>
<summary><b>Freunde können nicht beitreten – was tun?</b></summary>

Öffne die Server-Seite und klicke auf **Jetzt prüfen**. Ist der Server von außen nicht erreichbar, fehlt meist
die Portfreigabe im Router (siehe [Freunde einladen](#freunde-einladen)). Manche Anbieter (DS-Lite, CGNAT)
erlauben keine Freigaben – dann hilft der playit.gg-Tunnel.

</details>

<details>
<summary><b>Können Bedrock-Spieler (Handy, Switch, Xbox) auf meinen Java-Server?</b></summary>

Ja. In den Server-Einstellungen **Bedrock-Spieler erlauben** einschalten. MorniHosting installiert Geyser und
Floodgate und öffnet einen UDP-Port (meist 19132). Das geht bei Paper, Purpur, Fabric, NeoForge und Velocity.

</details>

<details>
<summary><b>Wie bekomme ich Voice-Chat auf meinen Server?</b></summary>

In den Server-Einstellungen bei **Voice-Chat (Simple Voice Chat)** den Schalter umlegen. MorniHosting
installiert das Plugin bzw. die Mod von Modrinth, öffnet einen UDP-Port (meist 24454) und trägt die Adresse
für die Spieler ein. Das geht bei Paper, Purpur, Fabric, Forge und NeoForge. Jeder Spieler braucht die Mod
[Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat) im eigenen Minecraft.

</details>

<details>
<summary><b>Wie werde ich auf meinen Servern automatisch OP?</b></summary>

Unter **Mein Konto → Minecraft-Konto** deinen Minecraft-Namen (Java) eintragen und **Verbinden**. MorniHosting
holt die UUID bei Mojang und macht dich auf allen Java-Servern zum Operator, auf denen du Besitzer bist (Admins
sind überall Besitzer, sonst zählt die Rolle „Besitzer“ unter **Benutzer und Rollen**). Läuft ein Server,
passiert das sofort über die Konsole, sonst beim nächsten Start. Verlierst du die Rolle oder trennst du das
Konto, nimmt MorniHosting nur die OP-Rechte zurück, die es selbst vergeben hat. Unten links siehst du dann auch
deinen eigenen Kopf.

</details>

<details>
<summary><b>Warum sehe ich keinen Knopf „Mit Passkey anmelden“?</b></summary>

Passkeys gehen nur über HTTPS mit einer Domain (oder direkt am Rechner unter `localhost`). Über
`http://192.168.…` blendet MorniHosting den Knopf aus. Wie du HTTPS einrichtest, steht unter
[Deine Domain und Passkeys](#deine-domain-und-passkeys).

</details>

<details>
<summary><b>Kann ich meinen bisherigen Server mitnehmen?</b></summary>

Ja. Packe den Server-Ordner als ZIP und nutze **Server importieren** auf der Übersicht. Software und Version
werden erkannt, du kannst sie vor dem Import noch ändern.

</details>

<details>
<summary><b>Wo liegen meine Welten und Backups?</b></summary>

Im Docker-Volume `mornihosting-data` (unter Linux meist `/var/lib/docker/volumes/mornihosting-data/_data`).
Backups kannst du im Panel auch direkt herunterladen.

</details>

<details>
<summary><b>Ich habe mein Passwort vergessen oder mein Handy (2FA) verloren.</b></summary>

Ein anderer Administrator gibt dir im **Admin-Bereich → Passwörter** mit zwei Klicks ein neues Passwort und
kann dabei auch 2FA und Passkeys entfernen. Bist du der einzige Admin, setze es auf dem Rechner zurück (bei
Proxmox vorher `pct enter <ID>`):

```bash
docker exec mornihosting node /app/server/dist/cli.js reset-password <name>
```

Du bekommst ein neues Passwort angezeigt. Handy mit der 2FA-App verloren? Dann `reset-2fa <name>` statt
`reset-password <name>`. `list-users` zeigt alle Kontonamen.

</details>

<details>
<summary><b>Warum nicht einfach Pterodactyl oder AMP?</b></summary>

Die können viel, sind aber eher für Admins gemacht. MorniHosting richtet sich an alle, die einfach mit
Freunden spielen wollen: klare Sprache statt Fachbegriffen, Erklärungen direkt an jeder Einstellung und
trotzdem alles, was man für eigene Server braucht.

</details>

<details>
<summary><b>Läuft das auch auf dem Raspberry Pi?</b></summary>

Ja, das Image gibt es für `amd64` und `arm64`. Ein Pi 5 mit 8 GB reicht für einen kleinen Paper-Server.

</details>

## Für Entwickler

Voraussetzungen: Node.js 22 und pnpm 10.

```bash
pnpm install
# Panel ohne Docker ausprobieren (simulierte Server, Demo-Spieler):
MH_SECRET=$(openssl rand -hex 32) MH_DATA_DIR=./data MH_DEMO=true pnpm --filter @mornihosting/server dev
pnpm --filter @mornihosting/web dev
```

| Befehl                                       | Was es tut                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm lint`                                  | ESLint                                                                            |
| `pnpm typecheck`                             | TypeScript (strict) für alle Pakete und die Browser-Tests                         |
| `pnpm test`                                  | Vitest für die Backend-Logik                                                      |
| `pnpm build`                                 | Web-App und Server bauen                                                          |
| `pnpm test:e2e`                              | Playwright: Server anlegen, Plugin installieren, Backup wiederherstellen, Passkey |
| `pnpm --filter @mornihosting/web build:demo` | Klickbare Demo als eine HTML-Datei (`apps/web/dist-demo/mornihosting-demo.html`)  |

Die Demo ist die echte Oberfläche mit einem nachgebauten Server im Browser (`apps/web/src/demo/`): Anmelden
(`philip` / `minecraft1` oder Passkey), Server starten und stoppen, Konsole, Admin-Bereich und Updates
funktionieren, gespeichert wird nichts.

Aufbau: `apps/server` (Fastify, SQLite/Drizzle, Docker über den Socket-Proxy), `apps/web` (React, Vite,
Tailwind, Radix, TanStack Query), `packages/shared` (Typen, Schemas, Software-Katalog). Jeder Minecraft-Server
ist ein eigener Container auf Basis der [itzg-Images](https://github.com/itzg/docker-minecraft-server).

GitHub Actions prüft jeden Push (Lint, Typen, Tests, Playwright). Eine neue Version entsteht mit einem Tag
`v1.2.3`: Dann wird das Image `ghcr.io/pmornhart/mornihosting` für amd64 und arm64 gebaut und danach das
GitHub-Release angelegt – mit den Hinweisen aus `docs/releases/v1.2.3.md`, falls es die Datei gibt. Sobald das
Release da ist, bieten alle Panels das Update an. Den Weg dorthin zeigt die
[Fortschrittsseite](docs/progress.html).

## Lizenz

[MIT](LICENSE) – mach damit, was du willst. Minecraft ist eine Marke von Mojang/Microsoft; MorniHosting ist
ein unabhängiges Projekt.

---

<sub>Verfasst mit Claude 🤖</sub>
