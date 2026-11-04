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

## Nachsehen

```bash
mornihosting-host-guard status          # auf dem Proxmox-Host: alles auf einen Blick
tail /var/log/mornihosting-host-guard.log
pct exec 100 -- tail /var/log/mornihosting-guard.log   # Eingriffe im Container
```

Entfernen: `mornihosting-host-guard uninstall` (Host) bzw. `bash /opt/mornihosting/scripts/guard.sh uninstall` (Container).

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
