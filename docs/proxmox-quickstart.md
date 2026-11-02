# MorniHosting auf Proxmox – Quick-Start

In fünf Minuten von „nichts“ zum eigenen Minecraft-Panel. Das Skript legt einen eigenen
Container (LXC) an, installiert darin Docker und MorniHosting und zeigt dir am Ende die Adresse.

## 1. Skript starten

Öffne in Proxmox den Host (z. B. `pve`) → **Shell** und füge diese Zeile ein:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/mornihosting.sh)"
```

Es erscheint eine Zusammenfassung mit den Standardwerten:

| Einstellung | Standard      | Wofür                                               |
| ----------- | ------------- | --------------------------------------------------- |
| CPU-Kerne   | 4             | Minecraft mag schnelle Kerne mehr als viele         |
| RAM         | 8192 MB       | Panel (~200 MB) plus alle Minecraft-Server zusammen |
| Festplatte  | 100 GB        | Welten, Plugins und Backups                         |
| Netzwerk    | `vmbr0`, DHCP | Der Container bekommt eine eigene IP im Heimnetz    |

Mit **Ja** geht es los, mit **Nein** kannst du jeden Wert ändern.

Danach fragt das Skript, ob es **NetBird** gleich mit einrichten soll. Wenn du deine Domain über NetBird
nutzt, sag **Ja** und füge deinen Setup-Key ein (NetBird-Dashboard → **Setup Keys → Create Setup Key**). Der
Container erscheint dann in NetBird unter seinem Namen (`mornihosting`). Das Netzwerk-Gerät, das NetBird im
Container braucht, richtet das Skript immer ein – du kannst NetBird also auch später noch nachinstallieren.

Ohne Rückfragen geht es auch, indem du die Werte vorher setzt:

```bash
CTID=210 RAM=12288 CORES=6 DISK=64 NETBIRD_SETUP_KEY=<KEY> bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/mornihosting.sh)"
```

## 2. Panel öffnen

Am Ende steht die Adresse, zum Beispiel `http://192.168.178.40:8080`. Öffne sie im Browser.
Der Einrichtungs-Assistent fragt nach Sprache und deinem Administrator-Konto. Danach kannst du
deinen ersten Server mit dem Assistenten anlegen.

## 3. Für Freunde aus dem Internet

Damit Freunde von außen spielen können, gib im Router diese Ports an die IP des Containers weiter:

| Port                          | Protokoll | Wofür                                                   |
| ----------------------------- | --------- | ------------------------------------------------------- |
| 25565 (bzw. dein Server-Port) | TCP       | Java-Server                                             |
| 19132                         | UDP       | Bedrock-Server oder Geyser („Bedrock-Spieler erlauben“) |
| 24454                         | UDP       | Voice-Chat (Simple Voice Chat)                          |

Das Panel selbst (Port 8080) solltest du **nicht** ins Internet freigeben. Für den Zugriff von
unterwegs nimm besser ein VPN (z. B. WireGuard oder Tailscale) oder einen Reverse-Proxy mit HTTPS
und setze dann in der `.env` `MH_TRUST_PROXY=true`.

**Mit NetBird** brauchst du gar keine Portfreigabe: Panel und Server bekommen Adressen unter deiner
Domain, das Panel sogar mit HTTPS. Die Anleitung mit deinen echten Werten steht im Panel unter
**Admin-Bereich → Domain → Reiter „NetBird“** (zum Nachlesen: [netbird.md](netbird.md)).

Die IP-Karte auf der Server-Seite prüft auf Knopfdruck, ob dein Server von außen erreichbar ist.

## Updates

- **Im Panel:** Im _Admin-Bereich → Updates_ erscheint ein Knopf, sobald es eine neue Version gibt.
- **Auf der Konsole:** im Proxmox-Host `pct enter <ID>` und dann `update`.

Deine Minecraft-Server laufen während des Updates weiter.

## Wo liegt was?

| Was                                | Wo (im Container)                           |
| ---------------------------------- | ------------------------------------------- |
| Panel-Dateien und `.env`           | `/opt/mornihosting`                         |
| Server, Welten, Backups, Datenbank | Docker-Volume `mornihosting-data`           |
| Updater                            | `systemctl status mornihosting-update.path` |

## Fragen

**Docker startet im Container nicht.** Der Container braucht die Optionen _Nesting_ und _keyctl_
(das Skript setzt beide). Auf ZFS-Speicher mit sehr alten Proxmox-Versionen hilft ein Update auf
Proxmox VE 8.

**Ich will lieber eine VM.** Dann in der VM (Debian 12 oder Ubuntu 24.04) einfach
`bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/install.sh)"` ausführen.

**Wie viel RAM brauche ich?** Pro Server: Vanilla oder Paper 2–4 GB, Modpacks 6–10 GB. Dazu
etwa 1 GB für das System. Das Panel warnt, wenn du mehr RAM verteilst, als frei ist.

---

<sub>Verfasst mit Claude 🤖</sub>

## Später mehr RAM oder Festplatte

Auf dem Proxmox-Host (Shell), `<ID>` ist die Nummer des Containers:

```bash
pct set <ID> --memory 65536     # RAM in MB, hier 64 GB
pct resize <ID> rootfs +200G    # Festplatte um 200 GB vergrößern
```

Der RAM gilt sofort, das Panel zeigt die neue Grenze beim nächsten Laden. Verkleinern geht bei der Festplatte nicht.
