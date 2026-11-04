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
