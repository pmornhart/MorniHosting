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
   übernimmt MorniHosting ihn und stellt ihn richtig ein. Bleibt der Name leer, läuft das Panel direkt unter
   `https://deine-domain.de` – dann legt es zusätzlich `www.deine-domain.de` an (gleiches Ziel, „Pass Host Header“),
   und wer `www.` tippt, landet per Weiterleitung (301, gleicher Pfad) auf der Domain. Der `www`-Dienst zieht mit,
   wenn sich die Adresse ändert, und verschwindet, wenn das Panel einen eigenen Namen bekommt oder NetBird getrennt
   wird. Bei einem Produkt mit Motor (MoinMorni) zeigt `www` auf dessen Webseite; die leitet selbst weiter.
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
    - '25565-25575:25565-25575/udp' # Voice-Chat am Velocity-Proxy (UDP auf dem Java-Port)
    - '19132-19140:19132-19140/udp' # Bedrock und Geyser
    - '19132-19140:19132-19140/tcp' # Bedrock seit 26.60 (findet den Server über TCP)
    - '24454-24460:24454-24460/udp' # Voice-Chat
```

Danach `docker compose up -d` und dieselben Ports in der Firewall des NetBird-Servers öffnen (Cloud-Panel des
Anbieters oder `ufw allow 25565:25575/tcp` und `ufw allow 25565:25575/udp`, für Bedrock `ufw allow 19132:19140/tcp` und `ufw allow 19132:19140/udp`). Alternativ den Proxy mit `network_mode: host` betreiben. Welche
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

## Spiel direkt auf der Domain

Ein Server kann direkt auf deiner Domain laufen: Spieler tippen nur `deine-domain.de` – ohne Namen davor. Einstellen
unter **Admin-Bereich → NetBird → Spiel direkt auf …** (Server wählen, **Übernehmen**) oder per API
`PUT /api/netbird/domain-server` mit `{ "serverId": "…" }` (`null` = keiner). Hat der Server noch keinen Namen,
bekommt er einen aus seinem eigenen.

Was NetBird erlaubt (geprüft im Quelltext von NetBird, `management/internals/modules/reverseproxy/service/manager`):

- **Ein Dienst pro Name.** HTTP und TCP/UDP können sich keinen Namen teilen („domain already taken“). Die Webseite
  bzw. das Panel bekommt darum die Domain selbst (HTTP, „Pass Host Header“), die Spiel-Dienste behalten eigene Namen
  (`<name>.deine-domain.de`, `<name>-bedrock…`, `<name>-voice…`).
- **TCP und UDP gehen nach dem Port**, nicht nach dem Namen: Der NetBird-Proxy schickt jede Verbindung auf Port 25565
  zum TCP-Dienst mit diesem Port, egal welcher Name eingetippt wurde. Zeigt `deine-domain.de` auf den Proxy (das tut
  sie für die Webseite ohnehin), landen Spieler mit `deine-domain.de` also auf dem Spiel.
- **Ein Dienst pro Port und Protokoll** auf einem Proxy. Der Server auf der Domain bittet darum um die Ports, die
  Spiele ohne Eingabe nehmen: Java 25565 (TCP), Bedrock/Geyser 19132 (UDP und TCP fürs Finden seit Bedrock 26.60),
  bei einem Velocity-Proxy mit Voice-Chat derselbe Port auch für UDP. Zusammengehörige Hälften (TCP + UDP) bekommen
  immer dieselbe Nummer.
- **NetBird Cloud** vergibt die Ports selbst und lehnt gewählte ab (auch beim Ändern). Dann steht die Portnummer in
  der Adresse (`deine-domain.de:31234`). Ohne Portnummer geht es nur mit einem selbst betriebenen NetBird, dessen
  Proxy eigene Ports erlaubt.

**Hat schon jemand den Port?** Zum Beispiel der Adress-Verteiler eines anderen Panels im selben NetBird-Konto (der
nimmt 25565 und 19132 über TCP). Dann wird ihm nichts weggenommen: Der Server bekommt die nächste Nummer, die in
beiden Protokollen frei ist (z. B. 25566), und seine Seite sagt, wer den gewünschten Port hat. Alle fünf Minuten
probiert das Panel, ob er frei geworden ist, und nimmt ihn dann von selbst. Für Java geht es bis dahin trotzdem ohne
Port, mit einem SRV-Eintrag bei deinem DNS-Anbieter (die Server-Seite nennt Name, Ziel und Port). Bedrock kennt kein
SRV – dort braucht es solange die Portnummer.

Läuft im selben Panel der Adress-Verteiler, schickt er die Domain selbst an den gewählten Server (Java ohne Port,
Bedrock mit 19132). Gehört der Verteiler zu einem anderen Panel auf demselben NetBird-Server, kann er die Domain
ebenfalls weiterreichen – siehe „Zwei Produkte auf einem NetBird-Server“ unten.

**Server hinter einem Proxy** (z. B. die Lobby eines Netzwerks) gehen hier nicht: Sie haben keine Ports nach außen und
nehmen keine direkten Anmeldungen an. Nimm den Proxy des Netzwerks – von dort kommen Spieler auf den Startserver. Das
Panel lehnt solche Server ab; war einer schon gewählt, zeigt die Karte eine Warnung mit „Proxy … nehmen“.

## Zwei Produkte in einem NetBird-Konto (MH_BRAND)

Alles, was das Panel in NetBird anlegt, trägt seinen Namen: das Netzwerk „MorniHosting“, die Gruppe, die Resources
„MorniHosting <Server>“ und „MorniHosting Panel“, der Ausgang „MorniHosting Ausgang“. Ein anderes Produkt, das
MorniHosting als unsichtbaren Motor einbaut (MoinMorni), setzt `MH_BRAND=MoinMorni` – dann heißt alles „MoinMorni …“,
auch in den Meldungen und in den eingebetteten Karten (`apps/web/src/embed.ts`). Aus der Marke wird auch der Name des
eigenen Rechners in NetBird abgeleitet („mornihosting“, „moinmorni“): Der Rechner, dessen Name ihn enthält, gilt als
der eigene (Vorschlag beim Verbinden, Ausgang, Selbstheilung).

So kommen sich zwei Panels in einem Konto nicht in die Quere. Jedes braucht aber **seine eigene Domain** in NetBird
(z. B. `mornihosting.de` und `moinmorni.net`): Dienste unter der eigenen Domain, die das Panel nicht kennt, hält es für
eigene Reste und räumt sie weg, wenn sie einen Port blockieren.

## Zwei Produkte auf einem NetBird-Server

Laufen zwei Produkte über denselben selbst betriebenen NetBird-Server – z. B. MorniHosting auf `mornihosting.de` und
MoinMorni auf `moinmorni.net` –, gibt es die Ports 25565 und 19132 dort nur einmal. NetBird leitet TCP und UDP nur nach
dem Port weiter, egal welcher Name eingetippt wurde, und beide Ports hält der Adress-Verteiler von MorniHosting.
MoinMorni bekommt darum die nächsten freien Ports (z. B. Java 25567, Bedrock 19134), und Spieler müssten
`moinmorni.net:25567` tippen.

Damit es auch dort ohne Port geht, nimmt der Verteiler weitere Domains mit: **Admin-Bereich → NetBird → Weitere Domains
über diesen Verteiler**. Dort die Domain des anderen Produkts und die Ports eintragen, die es in NetBird hat (MoinMorni
zeigt sie unter „Spiel direkt auf …“), z. B. `moinmorni.net`, Java-Port 25567, Bedrock-Port 19134. Per API (nur Admins):
`PUT /api/netbird/forwards` mit `{ "forwards": [{ "domain": "moinmorni.net", "javaPort": 25567, "bedrockPort": 19134 }] }`,
`GET /api/netbird/forwards?fresh=1` prüft neu.

- Der Verteiler liest den eingetippten Namen (Java: Handshake, Bedrock: Host-Zeile der Signaling-Anfrage). Steht er in
  der Liste, fragt er NetBird, wohin der TCP-Dienst mit diesem Außen-Port geht – zur Resource (Networks) oder zum
  NetBird-Rechner, der dort als Ziel steht –, und verbindet sich dorthin, bei MoinMorni zu dessen Container im Heimnetz.
  Die Bytes gehen unverändert durch.
- Die Antwort von NetBird merkt sich das Panel eine Minute lang. Die Liste zeigt je Port „gefunden: <Ziel>“ oder
  warum nicht.
- Das Bedrock-Spiel selbst läuft danach über den eigenen UDP-Port des anderen Produkts; dessen Geyser nennt ihn dem
  Gerät selbst.
- Weitergeleitet wird nur ins Heimnetz (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) oder zu NetBird-Rechnern
  (100.64.0.0/10), nie ins Internet und nie in die internen Docker-Netze des Panels (dort liegt der Zugang zu Docker).
  Ports, die dem Panel selbst gehören, gehen auch nicht (das wäre eine Schleife).
- Eigene Server gehen vor: Heißt ein eigener Server so wie der erste Teil der Domain (z. B. „moinmorni“), landen
  Spieler dort – die Liste warnt dann.
- Ist NetBird nicht verbunden oder das Ziel nicht zu finden, schließt der Verteiler die Verbindung und schreibt eine
  Zeile ins Protokoll („address router: no target for this domain“, höchstens einmal pro Minute und Domain).

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

**Zwei Produkte über denselben Ausgang** (z. B. MorniHosting und MoinMorni über den IONOS-Server): Jedes legt seine
eigene Gruppe „<Marke> Ausgang“ (nur sein Rechner) und seine eigene Route `0.0.0.0/0` über den Ausgang an. NetBird
nimmt mehrere solche Routen über einen Rechner an – seine Prüfung („… already has this route“) schaut seit vielen
Versionen (geprüft v0.25 bis heute) nur auf Rechner-Gruppen, nicht auf einzelne Rechner. Sollte ein NetBird das
einmal ablehnen, setzt das zweite Panel seine Gruppe in die schon vorhandene Route dazu (die Karte sagt dann
„fährt in der Route … mit“). Beim Ausschalten nimmt jedes Panel nur seine eigene Gruppe heraus; die Route verschwindet
erst, wenn niemand sie mehr nutzt. Gruppen anderer in einer Route bleiben immer erhalten.

## Wächter (hält alles stabil)

`install.sh`, `update.sh` und das Proxmox-Skript richten auf Rechnern mit NetBird den Wächter ein
(`scripts/guard.sh`, systemd-Timer `mornihosting-guard.timer`). Er prüft jede Minute und repariert selbst:

1. **Internet weg über einen NetBird-Ausgang** (Exit-Node antwortet nicht) → der Ausgang wird abgewählt, das Internet geht wieder direkt.
2. **DNS kaputt** (z. B. nach einem Neustart des Proxmox-Containers) → feste DNS-Server 1.1.1.1 und 9.9.9.9, Proxmox überschreibt sie nicht mehr.
3. **NetBird getrennt** (zwei Minuten am Stück) → Dienst neu starten und neu verbinden.

Status und letzte Eingriffe: `sudo /opt/mornihosting/scripts/guard.sh status`
(Protokoll: `/var/log/mornihosting-guard.log`). Sofort einrichten ohne Update:
`sudo bash /opt/mornihosting/scripts/guard.sh install`. Nur den Ausgang prüfen: `guard.sh exit`.

**Für ein anderes Produkt** (das MorniHosting als Motor einbaut) kommt alles aus der Umgebung beim `install`:

| Variable              | Vorgabe                      | Beispiel MoinMorni                                 |
| --------------------- | ---------------------------- | -------------------------------------------------- |
| `MH_BRAND`            | `MorniHosting`               | `MoinMorni` (Meldungen, „MoinMorni Ausgang“)       |
| `MH_GUARD_NAME`       | `mornihosting`               | `moinmorni` (Timer, Protokoll, Zustand)            |
| `MH_INSTALL_DIR`      | `/opt/<Name>`                | `/opt/moinmorni` (docker-compose.yml)              |
| `MH_ENV_FILE`         | `<Installationsordner>/.env` | – (liest `MH_NETBIRD_API`)                         |
| `MH_DATA_VOLUME`      | `<Name>-data`                | `moinmorni-motor-data` (Meldungen an den Motor)    |
| `MH_GUARD_CONTAINERS` | `<Name> <Name>-socket-proxy` | `moinmorni moinmorni-motor moinmorni-socket-proxy` |
| `MH_UPDATE_LOCK`      | `/run/<Name>-update.lock`    | – (legt das Update an, solange es läuft)           |

`install` schreibt die gesetzten Werte in ein eigenes Startskript `/usr/local/sbin/<Name>-guard`, das auch der Timer
`<Name>-guard.timer` aufruft. Status dann mit `sudo moinmorni-guard status`.

## Meldungen für ein Produkt mit Motor

Was das Panel an Admins meldet (Wächter, „Hausanschluss nicht mehr versteckt“, NetBird repariert, Server startet
nicht …), geht zusätzlich live über `/api/ws` raus: nach `{"type":"subscribe","channel":"alerts","after":"<letzte ID>"}`
kommt jede Meldung als `{"type":"alert","alert":{…}}` (Schlüssel, Art, Status `fixed|fixing|action|ok`, Titel, was los
ist, was zu tun ist, Befehl). Nur Admins bzw. Schlüssel mit dem Bereich `events`. Mit `after` kommen zuerst die
Meldungen, die seitdem kamen (die letzten 100 hebt das Panel auf) – so verpasst ein Produkt ohne eigenes Discord oder
eigene Mail (MoinMorni zeigt sie im Team-Log) nichts, wenn seine Verbindung kurz weg war.
