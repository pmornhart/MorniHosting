# MorniHosting mit NetBird: eigene Domain, HTTPS, keine Portfreigabe

Mit dem Reverse Proxy von [NetBird](https://netbird.io) erreichen deine Freunde das Panel und deine
Minecraft-Server über deine eigene Domain, ohne dass du im Router etwas freigibst. Das Panel bekommt
automatisch HTTPS, damit funktionieren auch **Passkeys**.

## Am einfachsten: MorniHosting richtet NetBird selbst ein

Hast du in NetBird schon eine eigene Domain (Schritt 2 unten) und läuft NetBird auf dem Rechner mit
MorniHosting (Schritt 1, beim Proxmox-Einzeiler per Setup-Key automatisch), dann musst du in NetBird sonst
nichts mehr anlegen:

1. **API-Schlüssel anlegen:** NetBird-Dashboard → **Team → Service Users** → **Create Service User** (Rolle
   „Admin“) → beim neuen Service-User **Create Token**. Den Schlüssel (`nbp_…`) kopieren.
2. **Im Panel verbinden:** **Admin-Bereich → NetBird** → Schlüssel einfügen → **Verbinden** → deine Domain und
   den Rechner wählen → **Speichern**. Der Schlüssel wird verschlüsselt gespeichert und nie angezeigt.
3. **Panel-Adresse (optional):** Unter **Adresse fürs Panel** z. B. `panel` eintragen → **Einrichten**. Das Panel
   ist dann unter `https://panel.deine-domain.de` erreichbar, mit „Pass Host Header“. Gibt es den Dienst schon,
   übernimmt MorniHosting ihn und stellt ihn richtig ein.
4. **Server:** Beim Anlegen nur noch den Namen eingeben (wird aus dem Server-Namen vorgeschlagen). Später
   änderst oder entfernst du ihn unter **Einstellungen → Allgemein → Adresse im Internet (NetBird)**.

| Was                       | Adresse in NetBird               | Modus     |
| ------------------------- | -------------------------------- | --------- |
| Java- oder Bedrock-Server | `<name>.deine-domain.de`         | TCP / UDP |
| Bedrock-Spieler (Geyser)  | `<name>-bedrock.deine-domain.de` | UDP       |
| Voice-Chat                | `<name>-voice.deine-domain.de`   | UDP       |

Den Port nach außen vergibt NetBird Cloud automatisch (z. B. `31234`). MorniHosting trägt ihn als
öffentlichen Port ein und zeigt die fertige Adresse auf der Server-Seite. Ändert sich ein Port im Panel,
schaltest du Geyser oder Voice-Chat an oder aus, benennst du den Server um oder löschst ihn, zieht
MorniHosting NetBird automatisch nach – der Port nach außen bleibt dabei gleich.

**NetBird selbst betrieben?** Dann gehört der Schlüssel zu deinem NetBird-Server, nicht zu NetBird Cloud. Trag
beim Verbinden unter **Eigener NetBird-Server?** die Adresse ein, unter der du dein NetBird-Dashboard öffnest
(z. B. `https://netbird.deine-domain.de`). Läuft NetBird auf dem Rechner mit MorniHosting, übernimmt das Panel
die Adresse bei der Installation und bei jedem `update` selbst (aus `netbird status`). Meldet das Panel
„… kennt diesen Schlüssel nicht“, ist genau das der Grund – oder der Schlüssel wurde in NetBird gelöscht.

**Ports beim selbst betriebenen Proxy – automatisch:** Einmal auf dem NetBird-Server ausführen:

```bash
curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-proxy-ports.sh | sudo bash
```

Das Skript findet den `netbird-proxy`, legt neben der `docker-compose.yml` die Datei `mornihosting-ports.yml` mit den
Port-Bereichen an (die eigene Datei bleibt unverändert), öffnet ufw/firewalld, falls aktiv, und startet nur den
Proxy neu. Eine Firewall im Kundenmenü des Anbieters (z. B. IONOS) muss man dort selbst öffnen.

**Ports beim selbst betriebenen Proxy – von Hand:** Der `netbird-proxy` lässt von sich aus nur Port 443 durch, jeder
TCP/UDP-Port für Minecraft muss freigegeben werden – sonst steht der Server in der Liste als „offline“. Erlaubt
dein Proxy eigene Ports (`supports_custom_ports`), nimmt MorniHosting nach außen denselben Port wie der Server.
Dann reicht einmal ein Bereich:

```yaml
netbird-proxy:
  ports:
    - '25565-25575:25565-25575/tcp' # Java-Server
    - '19132-19140:19132-19140/udp' # Bedrock und Geyser
    - '19132-19140:19132-19140/tcp' # Bedrock seit 26.60 (findet den Server über TCP)
    - '24454-24460:24454-24460/udp' # Voice-Chat
```

Danach `docker compose up -d` und dieselben Ports in der Firewall des NetBird-Servers öffnen (Cloud-Panel des
Anbieters oder `ufw allow 25565:25575/tcp`, für Bedrock `ufw allow 19132:19140/tcp` und `ufw allow 19132:19140/udp`). Alternativ den Proxy mit `network_mode: host` betreiben. Welche
Ports gerade gebraucht werden, zeigt das Panel unter **Admin-Bereich → NetBird**.

**Trennen** (Admin-Bereich → NetBird) löscht die Dienste der Server in NetBird wieder; die Panel-Adresse bleibt,
damit du dich nicht aussperrst.

## Ohne Port beitreten (Adress-Verteiler)

Bei einem selbst betriebenen NetBird (eigene Ports erlaubt) richtet das Panel zusätzlich einen Verteiler ein. Dann tippen alle Spieler nur noch den Namen ein:

- **Java:** `reich.mornihosting.de` (ohne `:25567`)
- **Bedrock** (Handy, Xbox, PlayStation, Switch, Windows, über Geyser): ebenfalls `reich.mornihosting.de`, Port bleibt 19132

So funktioniert es: NetBird schickt Port 25565 und 19132 (TCP) an das Panel. Java nennt beim Verbinden den eingetippten Namen, Bedrock (ab 26.60) ebenfalls, beim ersten Kontakt über TCP. Das Panel leitet die Verbindung an den passenden Server weiter. Das eigentliche Bedrock-Spiel läuft danach über den eigenen UDP-Port des Servers, den Geyser dem Handy selbst mitteilt. An der Fritzbox musst du nichts einstellen.

Die NetBird-Dienste dafür heißen `mh-router-java.<domain>` und `mh-router-bedrock.<domain>`. Der eigene Port eines Servers (z. B. `reich.mornihosting.de:25566`) geht weiterhin.

Auf dem NetBird-Server müssen 25565/tcp und 19132/tcp offen sein. Das erledigt `scripts/netbird-proxy-ports.sh` schon, wenn du es einmal ausgeführt hast.

## Von Hand

Lieber alles selbst eintragen? Öffne im Panel **Admin-Bereich → Domain → Reiter „NetBird“** und trag deine
Domain ein. Dort stehen alle Werte schon mit deiner IP, deinen Ports und Vorschlägen für die Subdomains – du
kopierst nur noch. Die Abschnitte unten erklären dasselbe zum Nachlesen.

<img src="screenshots/netbird-ports.webp" alt="NetBird-Anleitung im Admin-Bereich" width="100%">

In den Beispielen heißt deine Domain bei NetBird `mc.deine-domain.de` und der Rechner mit MorniHosting hat im
Heimnetz die IP `192.168.178.40`.

## 1. NetBird auf den Rechner mit MorniHosting

Installiere den NetBird-Client dort, wo MorniHosting läuft (z. B. im Proxmox-Container), und melde ihn mit
einem Setup-Key an. Den Key bekommst du im NetBird-Dashboard unter **Setup Keys → Create Setup Key**.

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
netbird up --setup-key <DEIN-SETUP-KEY>
```

**Proxmox-Container (LXC):** Hast du MorniHosting mit dem
[Proxmox-Einzeiler](proxmox-quickstart.md) installiert, ist alles vorbereitet – das Skript fragt sogar nach
deinem Setup-Key und erledigt diesen Schritt für dich. Hast du den Container selbst angelegt, braucht NetBird
dort ein Netzwerk-Gerät (TUN). Trag auf dem Proxmox-Host in `/etc/pve/lxc/<ID>.conf` diese zwei Zeilen ein und
starte den Container neu:

```text
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

**NetBird läuft schon auf einem anderen Gerät im Heimnetz** (als Router)? Dann musst du auf dem
MorniHosting-Rechner nichts installieren. Leg im NetBird-Dashboard unter **Networks** eine Ressource für
`192.168.178.40` an – die wählst du später als Ziel (Typ **Host**).

## 2. Deine Domain bei NetBird eintragen

1. Im NetBird-Dashboard: **Reverse Proxy → Custom Domains → Add Domain**. Trag `mc.deine-domain.de` ein (ohne
   `*`) und speichere.
2. Bei deinem Domain-Anbieter diesen Eintrag anlegen (den genauen Wert zeigt NetBird nach dem Speichern an):

   | Typ   | Name                   | Wert                  |
   | ----- | ---------------------- | --------------------- |
   | CNAME | `*.mc.deine-domain.de` | `eu.proxy.netbird.io` |

   Hast du bei der Domain einen CAA-Eintrag, muss er `sectigo.com` erlauben, sonst gibt es kein Zertifikat.

3. Zurück bei NetBird: **Verify Domain → Start Verification**. Steht dort **Active**, geht es weiter. Meist
   dauert das ein paar Minuten, höchstens 24 Stunden.

## 3. Das Panel mit HTTPS erreichbar machen

**Reverse Proxy → Services → Add Service**:

| Feld        | Wert                 |
| ----------- | -------------------- |
| Modus       | HTTP                 |
| Subdomain   | `panel`              |
| Base Domain | `mc.deine-domain.de` |

Dann **Add Target**: Als Ziel **Peer** und deinen MorniHosting-Rechner wählen – oder **Host** mit
`192.168.178.40`, wenn NetBird auf einem anderen Gerät läuft. **Protokoll** `HTTP`, **Port** `8080` (bzw. der
Port, unter dem du das Panel sonst öffnest).

- Unter **Settings** am besten **Pass Host Header** einschalten. Dann sieht das Panel deine Domain direkt.
  Anmelden und Passkeys gehen aber auch ohne – wichtig ist nur, dass die Adresse im **Admin-Bereich → Domain**
  eingetragen ist.
- **Authentication** kannst du leer lassen, MorniHosting hat eine eigene Anmeldung. Sollen nur Leute aus deinem
  NetBird-Netz das Panel sehen, wähle **NetBird-Only Access**.

Dein Panel ist danach unter `https://panel.mc.deine-domain.de` erreichbar. Trag genau diese Adresse im Panel
unter **Admin-Bereich → Domain → Adresse des Panels** ein (der Knopf **Als Adresse des Panels übernehmen** im
NetBird-Reiter macht das für dich) und speichere.

> Sobald die Adresse eingetragen ist, gehen Passkeys **nur noch** über diese Domain. Passwort-Anmeldung geht
> weiterhin auch über die IP im Heimnetz.

## 4. Die Minecraft-Server freigeben

Für jeden Server ein eigener Service, wieder über **Reverse Proxy → Services → Add Service**. Ziel wie in
Schritt 3 (Peer oder Host), dazu der passende Port:

| Dienst                   | Modus | Subdomain (Vorschlag) | Port (Ziel)                |
| ------------------------ | ----- | --------------------- | -------------------------- |
| Java-Server              | TCP   | `survival`            | Server-Port, z. B. `25565` |
| Bedrock-Server           | UDP   | `bedrock`             | Server-Port, z. B. `19132` |
| Geyser (Bedrock-Spieler) | UDP   | `survival-bedrock`    | Geyser-Port, z. B. `19133` |
| Voice-Chat               | UDP   | `survival-voice`      | Voice-Port, z. B. `24454`  |

Die echten Ports deiner Server zeigt der NetBird-Reiter im Panel. TCP- und UDP-Dienste brauchen kein HTTPS und
keine Anmeldung.

**Port von außen eintragen:** In der NetBird-Cloud vergibt NetBird den Port, über den deine Freunde kommen,
automatisch (z. B. `31000`). Du siehst ihn nach dem Speichern beim Service. Trag ihn im Panel ein:

- beim Server unter **Einstellungen → Allgemein → Öffentlicher Port**,
- beim Voice-Chat im Kasten **Voice-Chat → Öffentlicher Voice-Port**.

Dann zeigt MorniHosting auf der Server-Seite die richtige Adresse (z. B. `survival.mc.deine-domain.de:31000`),
und der Voice-Chat sagt den Mods der Spieler, wohin sie sich verbinden sollen.

> Unter **Admin-Bereich → Domain → Adresse für Minecraft** trägst du den Namen ein, den deine Freunde
> eintippen, z. B. `survival.mc.deine-domain.de`.

**Tipp für Java – ohne Port eintippen:** Leg bei deinem Domain-Anbieter einen SRV-Eintrag an:

| Typ | Name                                          | Ziel                          | Port             |
| --- | --------------------------------------------- | ----------------------------- | ---------------- |
| SRV | `_minecraft._tcp.survival.mc.deine-domain.de` | `survival.mc.deine-domain.de` | Port von NetBird |

Dann reicht in Minecraft `survival.mc.deine-domain.de`.

## 5. Fertig – Passkey einrichten

Öffne `https://panel.mc.deine-domain.de`, melde dich an und lege unter **Mein Konto → Passkeys** einen Passkey
an. Ab dann reicht auf der Anmeldeseite **Mit Passkey anmelden** und dein Fingerabdruck.

## Wenn etwas nicht klappt

<details>
<summary><b>„Passkeys gehen nur über die Domain des Panels“</b></summary>

Du hast das Panel über eine andere Adresse geöffnet als die eingetragene. Öffne genau die Adresse aus
**Admin-Bereich → Domain**. Steht dort noch etwas Altes, ändere es über die IP im Heimnetz.

</details>

<details>
<summary><b>Anmelden geht, aber Passkeys nicht / „Anfrage von einer fremden Seite abgelehnt“</b></summary>

Passkeys gehören zu genau einer Domain. Trag sie im Panel ein: **Admin-Bereich → Domain → Adresse des Panels**
(z. B. `hosting.deine-domain.de`) – oder unter **Mein Konto → Passkeys** auf **… als Domain des Panels
eintragen** klicken, wenn du das Panel schon über die Domain geöffnet hast. Danach gehen Passkeys auf dieser
Domain, auch wenn **Pass Host Header** in NetBird aus ist.

„Anfrage von einer fremden Seite abgelehnt“ und Passkeys ohne „Pass Host Header“ gibt es erst ab der Version vom
28.10. Ältere Version im Container? Auf dem Proxmox-Host `pct enter <ID>` und dann `update` eingeben.

</details>

<details>
<summary><b>Freunde kommen nicht auf den Minecraft-Server</b></summary>

- Ist beim Service der richtige **Modus** gewählt (Java: TCP, Bedrock/Geyser/Voice-Chat: UDP)?
- Stimmt der **Port beim Ziel** mit dem Port im Panel überein?
- Haben deine Freunde den **Port von NetBird** (nicht den internen) eingetippt? Mit dem öffentlichen Port im
  Panel zeigt die Server-Seite die richtige Adresse zum Kopieren.

</details>

<details>
<summary><b>Voice-Chat verbindet sich im Spiel nicht</b></summary>

Der UDP-Service für den Voice-Chat fehlt oder der öffentliche Voice-Port ist nicht eingetragen. Nach dem
Eintragen den Server einmal neu starten, damit Simple Voice Chat die neue Adresse liest.

</details>

---

Mehr zu NetBird: [docs.netbird.io – Reverse Proxy](https://docs.netbird.io/manage/reverse-proxy).

## Hausanschluss verstecken (Exit-Node)

Ziel: Weder Besucher noch Dienste, die MorniHosting aufruft (Modrinth, Mojang, Mailserver …), sehen die IP deines Hausanschlusses.

1. Auf dem NetBird-Server (z. B. bei IONOS) einmal den NetBird-Agent installieren und verbinden. Den Setup-Key gibt es im NetBird-Dashboard unter „Setup Keys“:
   ```bash
   curl -fsSL https://pkgs.netbird.io/install.sh | sh
   netbird up --management-url https://netbird.example.de --setup-key DEIN-SETUP-KEY
   ```
2. Im Panel: Admin → NetBird → **Hausanschluss verstecken** → den NetBird-Server als „Ausgang über“ wählen → **Anschluss verstecken**.
3. Das Panel legt in NetBird die Gruppe „MorniHosting Ausgang“ (nur der MorniHosting-Rechner) und die Route `0.0.0.0/0` über den NetBird-Server an (Exit-Node). Danach prüft es, mit welcher IP es ins Internet geht. Grün heißt: Es kommt beim NetBird-Server heraus.
4. Zeigt die Karte Adressen an, die noch auf deinen Hausanschluss zeigen, lösch die alten A-Einträge bei deinem DNS-Anbieter.

Die Heim-IP merkt sich das Panel einmal verschlüsselt, nur für diese Prüfung. Angezeigt oder verschickt wird sie nie. Am Router zu Hause sind danach keine Portfreigaben mehr nötig.

## Wächter (hält alles stabil)

`install.sh`, `update.sh` und das Proxmox-Skript richten auf Rechnern mit NetBird den Wächter ein
(`scripts/guard.sh`, systemd-Timer `mornihosting-guard.timer`). Er prüft jede Minute und repariert selbst:

1. **Internet weg über einen NetBird-Ausgang** (Exit-Node antwortet nicht) → der Ausgang wird abgewählt, das Internet geht wieder direkt.
2. **DNS kaputt** (z. B. nach einem Neustart des Proxmox-Containers) → feste DNS-Server 1.1.1.1 und 9.9.9.9, Proxmox überschreibt sie nicht mehr.
3. **NetBird getrennt** (zwei Minuten am Stück) → Dienst neu starten und neu verbinden.

Status und letzte Eingriffe: `sudo /opt/mornihosting/scripts/guard.sh status`
(Protokoll: `/var/log/mornihosting-guard.log`). Sofort einrichten ohne Update:
`sudo bash /opt/mornihosting/scripts/guard.sh install`.
