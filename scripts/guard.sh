#!/usr/bin/env bash
# shellcheck disable=SC2015 # "a && b || c" ist hier gewollt: nur für die Anzeige im Status
# MorniHosting-Wächter: hält diesen Rechner (den MorniHosting-Container) am Laufen.
#
# Läuft jede Minute als root (systemd-Timer, eingerichtet mit "guard.sh install") und repariert selbst:
#   1. Internet weg, weil ein NetBird-Ausgang (Exit-Node) nicht antwortet → Ausgang abwählen
#   2. DNS kaputt (z. B. nach einem Neustart des Proxmox-Containers)  → feste DNS-Server eintragen
#   3. NetBird getrennt (Management/Signal)                          → Dienst neu starten, neu verbinden
#   4. Docker hängt oder ist aus                                      → Docker neu starten
#   5. Panel oder Socket-Proxy aus oder krank (3 Min.)                 → Container neu starten / neu anlegen
#   6. Festplatte fast voll                                           → alte Docker-Images und Reste löschen
# Docker läuft mit "live-restore": startet Docker neu, laufen die Spielserver weiter.
# Jeder Eingriff steht in /var/log/mornihosting-guard.log.
#
# Befehle: check (Standard) · status · install · uninstall
set -euo pipefail

COMMAND="${1:-check}"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
UNIT_DIR="/etc/systemd/system"
STATE_DIR="/var/lib/mornihosting"
FAIL_FILE="${STATE_DIR}/netbird-failures"
PANEL_FAIL_FILE="${STATE_DIR}/panel-failures"
INSTALL_DIR="${MH_INSTALL_DIR:-/opt/mornihosting}"
DOCKER_DAEMON_JSON="/etc/docker/daemon.json"
# So oft hintereinander darf das Panel nicht antworten, bevor es neu startet.
PANEL_RESTART_AFTER=3
# Unter so viel freiem Platz (MB) wird aufgeräumt.
DISK_CLEAN_BELOW_MB=3072
# So oft wird ein abgewählter NetBird-Ausgang wieder probiert, und so lange darf er sich einrichten.
EXIT_RETRY_MINUTES=5
# Meldungen ans Panel (Discord + Mail): erst hier gesammelt, dann ins Datenvolume des Panels.
PENDING_EVENTS="${STATE_DIR}/events-pending.jsonl"
VOLUME_NAME="mornihosting-data"
PANEL_UID=1000
EVENTS_MAX_BYTES=1048576
# So oft hintereinander darf NetBird scheitern, bevor du eine Meldung "du musst etwas tun" bekommst.
NETBIRD_GIVE_UP_AFTER=10
# shellcheck disable=SC2016 # der Befehl wird so, wie er ist, in die Meldung geschrieben
EXIT_FIX_COMMAND='bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-exit-node.sh)"'
EXIT_SETTLE_SECONDS=8
PANEL_EXIT_NAME="MorniHosting Ausgang"
EXIT_OURS="${STATE_DIR}/exit-deselected"
LOG_FILE="/var/log/mornihosting-guard.log"
LOG_KEEP_LINES=500
# So oft hintereinander darf NetBird getrennt sein, bevor der Dienst neu startet (1 Prüfung = 1 Minute).
RESTART_AFTER="${NETBIRD_RESTART_AFTER:-2}"
UP_TIMEOUT_SECONDS=60
CHECK_TIMEOUT_SECONDS=8
FALLBACK_DNS=("1.1.1.1" "9.9.9.9")
DNS_TEST_HOST="github.com"
# Internet-Prüfung: Jede Antwort zählt (auch 4xx), nur keine Antwort heißt "kein Internet". Mehrere Ziele ohne
# Abfrage-Grenze – vorher api.github.com: das erlaubt nur 60 Abfragen pro Stunde, nach einer Stunde kam "zu viele"
# und der Wächter schaltete den Ausgang ab (Hausanschluss jede Stunde sichtbar).
WEB_TEST_URLS=("https://1.1.1.1/cdn-cgi/trace" "https://www.google.com/generate_204" "https://9.9.9.9")
# So oft hintereinander (1 Prüfung = 1 Minute) muss das Internet über den Ausgang fehlen, bevor er abgewählt wird.
EXIT_DEAD_AFTER=3
EXIT_FAIL_FILE="${STATE_DIR}/exit-failures"
# Proxmox schreibt /etc/resolv.conf in Containern bei jedem Start neu – außer diese Datei existiert.
PVE_IGNORE_RESOLV="/etc/.pve-ignore.resolv.conf"

log() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${LOG_FILE}"
  local lines
  lines="$(wc -l <"${LOG_FILE}")"
  if ((lines > LOG_KEEP_LINES * 2)); then
    tail -n "${LOG_KEEP_LINES}" "${LOG_FILE}" >"${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
  fi
}

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }

# Eine Meldung fürs Panel: event <quelle> <schlüssel> <status fixed|fixing|action|ok> <titel> <was> [<du musst>] [<befehl>]
event() {
  local source="$1" key="$2" status="$3" title="$4" what="$5" action="${6:-}" command="${7:-}" line
  line="{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"${source}\",\"key\":\"$(json_str "${key}")\",\"status\":\"${status}\",\"title\":\"$(json_str "${title}")\",\"what\":\"$(json_str "${what}")\""
  [[ -n "${action}" ]] && line+=",\"action\":\"$(json_str "${action}")\""
  [[ -n "${command}" ]] && line+=",\"command\":\"$(json_str "${command}")\""
  mkdir -p "${STATE_DIR}"
  printf '%s}\n' "${line}" >>"${PENDING_EVENTS}"
  flush_events
}

# Gesammelte Meldungen ins Datenvolume des Panels (geht erst, wenn Docker läuft – bis dahin bleiben sie liegen).
flush_events() {
  [[ -s "${PENDING_EVENTS}" ]] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  local volume dir file
  volume="$(timeout 10 docker volume inspect -f '{{ .Mountpoint }}' "${VOLUME_NAME}" 2>/dev/null || true)"
  [[ -n "${volume}" && -d "${volume}" ]] || return 0
  dir="${volume}/guard"
  file="${dir}/events.jsonl"
  [[ -L "${dir}" || -L "${file}" ]] && return 0
  mkdir -p "${dir}"
  chown "${PANEL_UID}:${PANEL_UID}" "${dir}"
  if [[ -f "${file}" ]] && (($(stat -c %s "${file}") > EVENTS_MAX_BYTES)); then
    : >"${file}"
  fi
  cat "${PENDING_EVENTS}" >>"${file}"
  chown "${PANEL_UID}:${PANEL_UID}" "${file}"
  : >"${PENDING_EVENTS}"
}

dns_ok() { timeout "${CHECK_TIMEOUT_SECONDS}" getent hosts "${DNS_TEST_HOST}" >/dev/null 2>&1; }
web_ok() {
  local url
  for url in "${WEB_TEST_URLS[@]}"; do
    curl -sS -m "${CHECK_TIMEOUT_SECONDS}" -o /dev/null "${url}" >/dev/null 2>&1 && return 0
  done
  return 1
}

netbird_connected() {
  local out
  out="$(timeout "${CHECK_TIMEOUT_SECONDS}" netbird status 2>/dev/null || true)"
  grep -q '^Management: Connected' <<<"${out}" && grep -q '^Signal: Connected' <<<"${out}"
}

fix_dns() {
  dns_ok && return 0
  log "DNS geht nicht – trage ${FALLBACK_DNS[*]} fest ein"
  touch "${PVE_IGNORE_RESOLV}" 2>/dev/null || true
  {
    printf '# MorniHosting NetBird-Wächter: feste DNS-Server (Proxmox überschreibt sie nicht mehr)\n'
    printf 'nameserver %s\n' "${FALLBACK_DNS[@]}"
  } >/etc/resolv.conf
  event container dns fixed "DNS repariert" "Der Container konnte keine Adressen mehr auflösen. Der Wächter hat feste DNS-Server (${FALLBACK_DNS[*]}) eingetragen."
}

# IDs der ausgewählten Standard-Routen (0.0.0.0/0, ::/0) aus "netbird networks ls" (ältere Versionen: "routes list").
exit_ids() {
  local want="$1" listing
  listing="$(timeout "${CHECK_TIMEOUT_SECONDS}" netbird networks ls 2>/dev/null ||
    timeout "${CHECK_TIMEOUT_SECONDS}" netbird routes list 2>/dev/null || true)"
  awk -v want="${want}" '
    /ID:/      { id = $0; sub(/.*ID:[ \t]*/, "", id); net = ""; next }
    /Network:/ { net = $0; sub(/.*Network:[ \t]*/, "", net); next }
    /Status:/  {
      if (net != "0.0.0.0/0" && net != "::/0") next
      selected = ($0 ~ /Selected/ && $0 !~ /Not/)
      if ((want == "selected" && selected) || (want == "unselected" && !selected)) print id
    }
  ' <<<"${listing}"
}
selected_exit_ids() { exit_ids selected; }

# Ein abgewählter Ausgang (Hausanschluss verstecken) wird alle 10 Minuten wieder probiert: kommt darüber
# Internet an, bleibt er an – sonst sofort wieder ab. So versteckt sich der Anschluss von selbst, sobald der
# Ausgangs-Rechner wieder geht, und das Internet fällt trotzdem nie aus.
retry_exit() {
  local stamp="${STATE_DIR}/exit-retry" ids
  mkdir -p "${STATE_DIR}"
  [[ -n "$(find "${stamp}" -mmin -"${EXIT_RETRY_MINUTES}" 2>/dev/null)" ]] && return 0
  # Nur der Ausgang des Panels ("MorniHosting Ausgang") und welche, die der Wächter selbst abgewählt hat –
  # fremde Ausgänge (z. B. "Mailserver Ausgang") bleiben, wie sie sind.
  ids="$(exit_ids unselected | while IFS= read -r id; do
    if [[ "${id}" == "${PANEL_EXIT_NAME}" ]] || grep -qxF "${id}" "${EXIT_OURS}" 2>/dev/null; then echo "${id}"; fi
  done)"
  [[ -n "${ids}" ]] || return 0
  touch "${stamp}"
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    netbird networks select "${id}" >/dev/null 2>&1 || netbird routes select "${id}" >/dev/null 2>&1 || continue
    sleep "${EXIT_SETTLE_SECONDS}"
    if web_ok; then
      log "NetBird-Ausgang ${id} geht wieder – Hausanschluss ist versteckt"
      event container netbird-exit ok "Hausanschluss wieder versteckt" "Der NetBird-Ausgang ${id} geht wieder."
    else
      netbird networks deselect "${id}" >/dev/null 2>&1 || netbird routes deselect "${id}" >/dev/null 2>&1 || true
      log "NetBird-Ausgang ${id} geht noch nicht (läuft der Wächter auf dem Ausgangs-Rechner?) – Internet bleibt direkt"
    fi
  done <<<"${ids}"
}

drop_dead_exit() {
  mkdir -p "${STATE_DIR}"
  if web_ok; then
    echo 0 >"${EXIT_FAIL_FILE}"
    return 0
  fi
  local ids failures=0
  ids="$(selected_exit_ids)"
  [[ -n "${ids}" ]] || return 0
  # Ein kurzer Aussetzer (eine Minute) ist kein Grund, den Hausanschluss offenzulegen.
  [[ -f "${EXIT_FAIL_FILE}" ]] && failures="$(cat "${EXIT_FAIL_FILE}")"
  failures=$((failures + 1))
  echo "${failures}" >"${EXIT_FAIL_FILE}"
  ((failures < EXIT_DEAD_AFTER)) && return 0
  echo 0 >"${EXIT_FAIL_FILE}"
  # Nicht gleich in derselben Minute wieder probieren.
  mkdir -p "${STATE_DIR}" && touch "${STATE_DIR}/exit-retry"
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    log "Internet weg über NetBird-Ausgang ${id} – Ausgang abgewählt, Internet geht wieder direkt"
    netbird networks deselect "${id}" >/dev/null 2>&1 || netbird routes deselect "${id}" >/dev/null 2>&1 || true
    grep -qxF "${id}" "${EXIT_OURS}" 2>/dev/null || echo "${id}" >>"${EXIT_OURS}"
    event container netbird-exit action "Hausanschluss nicht mehr versteckt" \
      "Über den NetBird-Ausgang ${id} kam kein Internet mehr. Der Wächter hat ihn abgewählt – alles läuft weiter, aber direkt über deinen Hausanschluss." \
      "Diesen Befehl als root auf dem NetBird-Server einfügen. Danach schaltet sich der Ausgang spätestens nach 10 Minuten von selbst wieder ein." \
      "${EXIT_FIX_COMMAND}"
  done <<<"${ids}"
}

# Der NetBird-Hintergrunddienst muss laufen, sonst sagt "netbird up" nur
# "dial unix /var/run/netbird.sock: no such file". Fehlt er (nie eingerichtet oder
# nach einem Update weg), wird er hier angelegt und gestartet.
ensure_netbird_service() {
  command -v netbird >/dev/null 2>&1 || return 0
  if ! systemctl cat netbird >/dev/null 2>&1; then
    log "NetBird-Dienst fehlt – richte ihn ein"
    netbird service install >/dev/null 2>&1 || true
  fi
  systemctl enable netbird >/dev/null 2>&1 || true
  systemctl is-active --quiet netbird || netbird service start >/dev/null 2>&1 || systemctl start netbird >/dev/null 2>&1 || true
}

reconnect() {
  local failures=0
  mkdir -p "${STATE_DIR}"
  [[ -f "${FAIL_FILE}" ]] && failures="$(cat "${FAIL_FILE}")"
  if netbird_connected; then
    if [[ "${failures}" != 0 ]]; then
      log "NetBird ist wieder verbunden"
      if ((failures >= RESTART_AFTER)); then
        event container netbird ok "NetBird wieder verbunden" "NetBird ist wieder verbunden, alle Adressen sind erreichbar."
      fi
    fi
    echo 0 >"${FAIL_FILE}"
    return 0
  fi
  failures=$((failures + 1))
  echo "${failures}" >"${FAIL_FILE}"
  ((failures < RESTART_AFTER)) && return 0
  log "NetBird seit ${failures} Prüfungen getrennt – starte den Dienst neu und verbinde"
  if ((failures >= NETBIRD_GIVE_UP_AFTER)); then
    event container netbird action "NetBird verbindet sich nicht" \
      "NetBird ist seit ${failures} Minuten getrennt, Neustarts helfen nicht. Deine Server sind über die Domain gerade nicht erreichbar (im Heimnetz schon)." \
      "Prüfe im NetBird-Dashboard, ob der Rechner noch da ist. Wurde er gelöscht: neuen Setup-Key erstellen und im Container (pct enter <ID>) einfügen:" \
      "netbird up --setup-key <DEIN-SETUP-KEY>"
  elif ((failures == RESTART_AFTER)); then
    event container netbird fixing "NetBird getrennt" "NetBird ist seit ${failures} Minuten getrennt. Der Wächter startet NetBird neu und verbindet es wieder."
  fi
  ensure_netbird_service
  systemctl restart netbird >/dev/null 2>&1 || true
  sleep 3
  timeout "${UP_TIMEOUT_SECONDS}" netbird up >/dev/null 2>&1 || log "netbird up hat nicht geantwortet – nächster Versuch in einer Minute"
  if netbird_connected; then
    log "NetBird ist wieder verbunden"
    echo 0 >"${FAIL_FILE}"
  fi
}

count_up() {
  local file="$1" n=0
  [[ -f "${file}" ]] && n="$(cat "${file}")"
  n=$((n + 1))
  echo "${n}" >"${file}"
  echo "${n}"
}

docker_ok() { timeout 20 docker info >/dev/null 2>&1; }

keep_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  docker_ok && return 0
  log "Docker antwortet nicht – starte Docker neu (Spielserver laufen dank live-restore weiter)"
  systemctl restart docker >/dev/null 2>&1 || true
  sleep 5
  if docker_ok; then
    event container docker fixed "Docker neu gestartet" "Docker antwortete nicht und wurde neu gestartet. Die Spielserver liefen dank live-restore weiter."
  else
    log "Docker antwortet auch nach dem Neustart nicht – nächster Versuch in einer Minute"
    event container docker action "Docker startet nicht" "Docker antwortet auch nach einem Neustart nicht. Panel und Spielserver sind aus." \
      "Im Container (pct enter <ID>) nachsehen, was Docker meldet:" "journalctl -u docker -n 50 --no-pager"
  fi
}

# Läuft der Container und meldet Docker ihn nicht als krank?
container_ok() {
  local state
  state="$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true)"
  [[ "${state}" == "true" || "${state}" == "true healthy" || "${state}" == "true starting" ]]
}

keep_panel() {
  command -v docker >/dev/null 2>&1 || return 0
  [[ -f "${INSTALL_DIR}/docker-compose.yml" ]] || return 0
  docker_ok || return 0
  mkdir -p "${STATE_DIR}"
  if container_ok mornihosting && container_ok mornihosting-socket-proxy; then
    echo 0 >"${PANEL_FAIL_FILE}"
    return 0
  fi
  # Ein laufendes Update startet das Panel selbst neu – nicht dazwischenfunken (höchstens 30 Min. alt).
  if [[ -n "$(find /run/mornihosting-update.lock -mmin -30 2>/dev/null)" ]]; then
    return 0
  fi
  local failures
  failures="$(count_up "${PANEL_FAIL_FILE}")"
  ((failures < PANEL_RESTART_AFTER)) && return 0
  # Reste eines abgebrochenen Neustarts blockieren Compose ("name … is already in use").
  docker ps -a --format '{{.Names}}' | grep -E '^[0-9a-f]{12}_mornihosting(-[a-z-]+)?$' | xargs -r docker rm -f >/dev/null 2>&1 || true
  log "Panel seit ${failures} Prüfungen aus oder krank – starte es neu"
  (cd "${INSTALL_DIR}" && timeout 300 docker compose up -d >/dev/null 2>&1) || true
  container_ok mornihosting || docker restart mornihosting >/dev/null 2>&1 || true
  echo 0 >"${PANEL_FAIL_FILE}"
  event container panel fixed "Panel neu gestartet" "Das Panel war ${failures} Minuten aus oder antwortete nicht und wurde neu gestartet."
}

free_disk_mb() { df -Pm "${INSTALL_DIR}" 2>/dev/null | awk 'NR==2 { print $4 }'; }

keep_disk() {
  command -v docker >/dev/null 2>&1 || return 0
  local free
  free="$(free_disk_mb)"
  [[ -n "${free}" ]] || return 0
  ((free < DISK_CLEAN_BELOW_MB)) || return 0
  # Höchstens einmal pro Stunde aufräumen.
  local stamp="${STATE_DIR}/disk-cleaned"
  mkdir -p "${STATE_DIR}"
  [[ -n "$(find "${stamp}" -mmin -60 2>/dev/null)" ]] && return 0
  touch "${stamp}"
  log "Nur noch ${free} MB frei – räume alte Docker-Images und Reste auf"
  docker image prune -af --filter "until=72h" >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  local after
  after="$(free_disk_mb)"
  if ((after < DISK_CLEAN_BELOW_MB)); then
    event container disk action "Festplatte fast voll" "Nur noch ${after} MB frei, auch nach dem Aufräumen. Bald können Welten und Backups nicht mehr speichern." \
      "Alte Backups im Panel löschen oder dem Container mehr Platz geben (auf dem Proxmox-Host):" "pct resize <ID> rootfs +50G"
  else
    event container disk fixed "Speicherplatz aufgeräumt" "Es waren nur noch ${free} MB frei. Der Wächter hat alte Docker-Reste gelöscht, jetzt sind ${after} MB frei."
  fi
}

# Docker so einstellen, dass ein Neustart von Docker die Spielserver nicht beendet.
ensure_live_restore() {
  command -v docker >/dev/null 2>&1 || return 0
  mkdir -p "$(dirname "${DOCKER_DAEMON_JSON}")"
  if [[ ! -s "${DOCKER_DAEMON_JSON}" ]]; then
    printf '{\n  "live-restore": true\n}\n' >"${DOCKER_DAEMON_JSON}"
  elif ! grep -q '"live-restore"' "${DOCKER_DAEMON_JSON}"; then
    # Vorhandene Einstellungen bleiben: die neue Zeile kommt direkt hinter die erste geschweifte Klammer.
    sed -i '0,/{/s//{\n  "live-restore": true,/' "${DOCKER_DAEMON_JSON}"
  else
    return 0
  fi
  log "Docker live-restore eingeschaltet"
  systemctl reload docker >/dev/null 2>&1 || true
}

check() {
  flush_events
  if command -v netbird >/dev/null 2>&1; then
    # Erst den toten Ausgang weg (der nimmt auch DNS mit), dann DNS, dann NetBird selbst.
    drop_dead_exit
    fix_dns
    reconnect
    retry_exit
  else
    fix_dns
  fi
  keep_docker
  keep_panel
  keep_disk
}

status() {
  printf 'DNS:      %s\n' "$(dns_ok && echo ok || echo kaputt)"
  printf 'Internet: %s\n' "$(web_ok && echo ok || echo weg)"
  printf 'NetBird:  %s\n' "$(command -v netbird >/dev/null 2>&1 && { netbird_connected && echo verbunden || echo getrennt; } || echo 'nicht installiert')"
  printf 'Docker:   %s\n' "$(docker_ok && echo ok || echo 'antwortet nicht')"
  printf 'Panel:    %s\n' "$(container_ok mornihosting && echo läuft || echo aus)"
  printf 'Platz:    %s MB frei\n' "$(free_disk_mb)"
  printf 'Wächter:  %s\n' "$(systemctl is-active mornihosting-guard.timer 2>/dev/null || echo aus)"
  [[ -f "${LOG_FILE}" ]] && {
    printf '\nLetzte Eingriffe:\n'
    tail -n 10 "${LOG_FILE}"
  }
  return 0
}

install_units() {
  cat >"${UNIT_DIR}/mornihosting-guard.service" <<UNIT
[Unit]
Description=MorniHosting: Rechner prüfen und reparieren (NetBird, DNS, Docker, Panel, Platz)
After=network-online.target netbird.service

[Service]
Type=oneshot
ExecStart=${SCRIPT_PATH} check
UNIT
  cat >"${UNIT_DIR}/mornihosting-guard.timer" <<UNIT
[Unit]
Description=MorniHosting-Wächter jede Minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
  # Den Vorgänger (nur NetBird) ablösen.
  systemctl disable --now mornihosting-netbird.timer >/dev/null 2>&1 || true
  rm -f "${UNIT_DIR}/mornihosting-netbird.service" "${UNIT_DIR}/mornihosting-netbird.timer"
  systemctl daemon-reload
  systemctl enable --now mornihosting-guard.timer >/dev/null
  # Docker und NetBird sollen nach jedem Neustart von allein wieder da sein.
  systemctl enable docker containerd >/dev/null 2>&1 || true
  ensure_netbird_service
  ensure_live_restore
}

case "${COMMAND}" in
  check)
    [[ ${EUID} -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
    check
    ;;
  status) status ;;
  event)
    # Vom Host-Wächter: guard.sh event <quelle> <schlüssel> <status> <titel> <was> [<du musst>] [<befehl>]
    shift
    event "$@"
    ;;
  install)
    [[ ${EUID} -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
    command -v systemctl >/dev/null 2>&1 || { echo "Kein systemd – Wächter nicht eingerichtet." >&2; exit 0; }
    install_units
    echo "MorniHosting-Wächter läuft (jede Minute). Status: ${SCRIPT_PATH} status"
    ;;
  uninstall)
    systemctl disable --now mornihosting-guard.timer >/dev/null 2>&1 || true
    rm -f "${UNIT_DIR}/mornihosting-guard.service" "${UNIT_DIR}/mornihosting-guard.timer"
    systemctl daemon-reload
    ;;
  *)
    echo "Unbekannter Befehl: ${COMMAND} (check, status, install, uninstall)" >&2
    exit 2
    ;;
esac
