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
LOG_FILE="/var/log/mornihosting-guard.log"
LOG_KEEP_LINES=500
# So oft hintereinander darf NetBird getrennt sein, bevor der Dienst neu startet (1 Prüfung = 1 Minute).
RESTART_AFTER="${NETBIRD_RESTART_AFTER:-2}"
UP_TIMEOUT_SECONDS=60
CHECK_TIMEOUT_SECONDS=8
FALLBACK_DNS=("1.1.1.1" "9.9.9.9")
DNS_TEST_HOST="github.com"
WEB_TEST_URL="https://api.github.com"
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

dns_ok() { timeout "${CHECK_TIMEOUT_SECONDS}" getent hosts "${DNS_TEST_HOST}" >/dev/null 2>&1; }
web_ok() { curl -fsS -m "${CHECK_TIMEOUT_SECONDS}" -o /dev/null "${WEB_TEST_URL}" >/dev/null 2>&1; }

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
}

# IDs der ausgewählten Standard-Routen (0.0.0.0/0, ::/0) aus "netbird networks ls" (ältere Versionen: "routes list").
selected_exit_ids() {
  local listing
  listing="$(timeout "${CHECK_TIMEOUT_SECONDS}" netbird networks ls 2>/dev/null ||
    timeout "${CHECK_TIMEOUT_SECONDS}" netbird routes list 2>/dev/null || true)"
  awk '
    /ID:/      { id = $0; sub(/.*ID:[ \t]*/, "", id); net = ""; next }
    /Network:/ { net = $0; sub(/.*Network:[ \t]*/, "", net); next }
    /Status:/  { if ((net == "0.0.0.0/0" || net == "::/0") && $0 ~ /Selected/ && $0 !~ /Not/) print id }
  ' <<<"${listing}"
}

drop_dead_exit() {
  web_ok && return 0
  local ids
  ids="$(selected_exit_ids)"
  [[ -n "${ids}" ]] || return 0
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    log "Internet weg über NetBird-Ausgang ${id} – Ausgang abgewählt, Internet geht wieder direkt"
    netbird networks deselect "${id}" >/dev/null 2>&1 || netbird routes deselect "${id}" >/dev/null 2>&1 || true
  done <<<"${ids}"
}

reconnect() {
  local failures=0
  mkdir -p "${STATE_DIR}"
  [[ -f "${FAIL_FILE}" ]] && failures="$(cat "${FAIL_FILE}")"
  if netbird_connected; then
    [[ "${failures}" != 0 ]] && log "NetBird ist wieder verbunden"
    echo 0 >"${FAIL_FILE}"
    return 0
  fi
  failures=$((failures + 1))
  echo "${failures}" >"${FAIL_FILE}"
  ((failures < RESTART_AFTER)) && return 0
  log "NetBird seit ${failures} Prüfungen getrennt – starte den Dienst neu und verbinde"
  systemctl enable netbird >/dev/null 2>&1 || true
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
  docker_ok || log "Docker antwortet auch nach dem Neustart nicht – nächster Versuch in einer Minute"
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
  local failures
  failures="$(count_up "${PANEL_FAIL_FILE}")"
  ((failures < PANEL_RESTART_AFTER)) && return 0
  log "Panel seit ${failures} Prüfungen aus oder krank – starte es neu"
  (cd "${INSTALL_DIR}" && timeout 300 docker compose up -d >/dev/null 2>&1) || true
  container_ok mornihosting || docker restart mornihosting >/dev/null 2>&1 || true
  echo 0 >"${PANEL_FAIL_FILE}"
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
  if command -v netbird >/dev/null 2>&1; then
    # Erst den toten Ausgang weg (der nimmt auch DNS mit), dann DNS, dann NetBird selbst.
    drop_dead_exit
    fix_dns
    reconnect
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
  systemctl enable netbird >/dev/null 2>&1 || true
  ensure_live_restore
}

case "${COMMAND}" in
  check)
    [[ ${EUID} -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
    check
    ;;
  status) status ;;
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
