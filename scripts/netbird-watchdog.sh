#!/usr/bin/env bash
# MorniHosting NetBird-Wächter: hält NetBird und das Internet auf diesem Rechner stabil.
#
# Läuft jede Minute als root (systemd-Timer, eingerichtet mit "netbird-watchdog.sh install") und repariert selbst:
#   1. Internet weg, weil ein NetBird-Ausgang (Exit-Node) nicht antwortet → Ausgang abwählen
#   2. DNS kaputt (z. B. nach einem Neustart des Proxmox-Containers)  → feste DNS-Server eintragen
#   3. NetBird getrennt (Management/Signal)                          → Dienst neu starten, neu verbinden
# Jeder Eingriff steht in /var/log/mornihosting-netbird.log.
#
# Befehle: check (Standard) · status · install · uninstall
set -euo pipefail

COMMAND="${1:-check}"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
UNIT_DIR="/etc/systemd/system"
STATE_DIR="/var/lib/mornihosting"
FAIL_FILE="${STATE_DIR}/netbird-failures"
LOG_FILE="/var/log/mornihosting-netbird.log"
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

check() {
  command -v netbird >/dev/null 2>&1 || exit 0
  # Erst den toten Ausgang weg (der nimmt auch DNS mit), dann DNS, dann NetBird selbst.
  drop_dead_exit
  fix_dns
  reconnect
}

status() {
  printf 'DNS:      %s\n' "$(dns_ok && echo ok || echo kaputt)"
  printf 'Internet: %s\n' "$(web_ok && echo ok || echo weg)"
  printf 'NetBird:  %s\n' "$(netbird_connected && echo verbunden || echo getrennt)"
  printf 'Wächter:  %s\n' "$(systemctl is-active mornihosting-netbird.timer 2>/dev/null || echo aus)"
  [[ -f "${LOG_FILE}" ]] && {
    printf '\nLetzte Eingriffe:\n'
    tail -n 10 "${LOG_FILE}"
  }
  return 0
}

install_units() {
  cat >"${UNIT_DIR}/mornihosting-netbird.service" <<UNIT
[Unit]
Description=MorniHosting: NetBird und Internet prüfen und reparieren
After=network-online.target netbird.service

[Service]
Type=oneshot
ExecStart=${SCRIPT_PATH} check
UNIT
  cat >"${UNIT_DIR}/mornihosting-netbird.timer" <<UNIT
[Unit]
Description=MorniHosting: NetBird-Wächter jede Minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now mornihosting-netbird.timer >/dev/null
  # NetBird selbst soll nach jedem Neustart von allein wieder da sein.
  systemctl enable netbird >/dev/null 2>&1 || true
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
    echo "NetBird-Wächter läuft (jede Minute). Status: ${SCRIPT_PATH} status"
    ;;
  uninstall)
    systemctl disable --now mornihosting-netbird.timer >/dev/null 2>&1 || true
    rm -f "${UNIT_DIR}/mornihosting-netbird.service" "${UNIT_DIR}/mornihosting-netbird.timer"
    systemctl daemon-reload
    ;;
  *)
    echo "Unbekannter Befehl: ${COMMAND} (check, status, install, uninstall)" >&2
    exit 2
    ;;
esac
