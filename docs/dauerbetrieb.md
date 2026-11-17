# Dauerbetrieb – MorniHosting hält sich selbst am Laufen

Einmal auf dem **Proxmox-Host** (nicht im Container) ausführen:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/dauerbetrieb.sh)"
```

Anderer Container als 100 bzw. nicht „mornihosting“ genannt: `CTID=105 bash -c "$(curl …)"`.

## Was danach von selbst passiert

| Ebene                              | Schutz                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxmox-Host                       | Container startet mit dem Host (onboot, als Erster), RAM bis 32 GB (höchstens halber Host) + 4 GB Swap                                        |
| Host-Wächter (jede Minute)         | Container aus, ohne dass du ihn gestoppt hast → sofort starten. Hängt er 3 Minuten → neu starten. Stoppst du ihn über Proxmox, bleibt er aus. |
| Wächter im Container (jede Minute) | toter NetBird-Ausgang abwählen, DNS reparieren, NetBird neu verbinden, Docker neu starten, Panel neu starten, bei wenig Platz aufräumen       |
| Docker                             | live-restore: Spielserver laufen weiter, wenn Docker neu startet; Docker und NetBird starten mit dem Container                                |
| Panel                              | Spielserver mit „Automatisch starten“ starten nach Absturz oder Ausfall von selbst wieder (10 s, 30 s, 1 Min. … bis 30 Min. Abstand)          |
| Rechner-Schutz                     | Server starten nur, wenn RAM und Platz reichen; Spielserver ohne Swap, bei RAM-Not zuerst beendet                                             |

„Absichtlich gestoppt“ erkennt der Host-Wächter an den Proxmox-Aufgaben (`vzstop`, `vzshutdown` seit dem letzten Hochfahren).
Wird der ganze Host heruntergefahren, startet der Container beim nächsten Hochfahren wieder.
Startest du den Container über Proxmox neu oder läuft ein Backup, wartet der Host-Wächter, bis Proxmox fertig ist
(höchstens 10 Minuten), statt dazwischen zu starten.

Einmal am Tag gibt der Host-Wächter gelöschten Platz an Proxmox zurück (fstrim). Das läuft im Hintergrund und sperrt
den Container nicht. Ältere Fassungen nahmen dafür `pct fstrim`: Das sperrt den Container („CT is locked (fstrim)“),
und brach es ab, startete er nicht mehr. Findet der Host-Wächter so eine Sperre an einem ausgeschalteten Container,
bricht er das fstrim ab und startet den Container – der Start geht vor.

Bleibt NetBird getrennt, startet der Wächter im Container es in den ersten 10 Minuten jede Minute neu, danach alle
10 Minuten. Die Meldung nennt den Grund so, wie NetBird ihn angibt. Ist NetBird abgemeldet (Anmeldung abgelaufen),
startet er es nicht neu, sondern sagt dir, wie du es mit einem Setup-Key wieder anmeldest.

## Nachsehen

```bash
mornihosting-host-guard status          # auf dem Proxmox-Host: alles auf einen Blick
tail /var/log/mornihosting-host-guard.log
pct exec 100 -- tail /var/log/mornihosting-guard.log   # Eingriffe im Container
```

Entfernen: `mornihosting-host-guard uninstall` (Host) bzw. `bash /opt/mornihosting/scripts/guard.sh uninstall` (Container).

## Ein zweites Produkt auf demselben Host (z. B. MoinMorni)

Ein Produkt, das MorniHosting als Motor einbaut, bekommt seinen eigenen Host-Wächter – mit eigenem Namen, eigener
Konfiguration und eigenen Einheiten. Der von MorniHosting bleibt, wie er ist. MoinMorni richtet ihn beim
Proxmox-Einzeiler selbst ein; von Hand auf dem Proxmox-Host:

```bash
MH_GUARD_NAME=moinmorni MH_BRAND=MoinMorni MH_INSTALL_DIR=/opt/moinmorni \
  MH_CT_GUARD=/usr/local/sbin/moinmorni-guard MH_DATA_VOLUME=moinmorni-motor-data CTID=105 \
  bash dauerbetrieb.sh hostguard
```

| Variable         | Vorgabe                             | Wofür                                                 |
| ---------------- | ----------------------------------- | ----------------------------------------------------- |
| `MH_GUARD_NAME`  | `mornihosting`                      | Name: Skript, Einheiten, Konfiguration, Protokoll     |
| `MH_BRAND`       | `MorniHosting`                      | Name in den Meldungen („MoinMorni-Container hing“)    |
| `MH_INSTALL_DIR` | `/opt/<Name>`                       | Ordner im Container (für `update.sh`)                 |
| `MH_CT_GUARD`    | `bash /opt/<Name>/scripts/guard.sh` | Wächter im Container (Startskript des Produkts)       |
| `MH_DATA_VOLUME` | `<Name>-data`                       | Docker-Volume im Hinweis, wenn der Speicher voll wird |
| `CTID`           | Container mit dem Namen, sonst 100  | welcher Container                                     |

Daraus werden `/usr/local/sbin/<Name>-host-guard` (erkennt sein Produkt am eigenen Namen),
`/etc/<Name>-host-guard.conf`, `<Name>-host-guard.timer` und `/var/log/<Name>-host-guard.log`. Status:
`moinmorni-host-guard status`, entfernen: `moinmorni-host-guard uninstall`.

## Meldungen an dich (Discord + Mail)

Alles, was schiefgeht, kommt sofort als Discord-Nachricht an die Admins (und per Mail, wenn unter
Mein Konto → Benachrichtigungen eingeschaltet). Jede Meldung sagt: **was los ist**, **ob es sich von selbst behebt**
und – wenn nicht – **was du tun musst**, mit dem fertigen Befehl. Ist es wieder gut, kommt eine Entwarnung.

Gemeldet werden u. a.: Container neu gestartet oder hängt (Proxmox-Host), NetBird getrennt / verbindet sich nicht,
Hausanschluss nicht mehr versteckt, DNS repariert, Docker oder Panel neu gestartet, Festplatte fast voll, ein
Spielserver startet nicht wieder (z. B. zu wenig RAM), Backup fehlgeschlagen, NetBird von selbst repariert (neue
Rechner-ID übernommen, Reste gelöschter Server entfernt). Gleiche Meldungen kommen höchstens alle 30 Minuten.

Die Wächter schreiben ihre Ereignisse nach `<Datenvolume>/guard/events.jsonl`; das Panel liest sie alle 10 Sekunden
(auch die, die entstanden sind, während das Panel aus war).

## Hausanschluss verstecken – den Ausgang einrichten

Einmal auf dem NetBird-Server (dem Ausgang) als root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-exit-node.sh)"
```

Erlaubt das Weiterleiten, öffnet die Firewall für NetBird-Verkehr (auch wenn Docker die FORWARD-Kette sperrt), mit NAT,
und prüft das alle 2 Minuten. Der Wächter im MorniHosting-Container schaltet den Ausgang danach von selbst wieder ein
(alle 10 Minuten ein Versuch; kommt kein Internet durch, sofort wieder aus – fremde Ausgänge wie „Mailserver Ausgang“
fasst er nicht an).
