#!/usr/bin/env bash
# MorniHosting Dauerbetrieb – einmal auf dem PROXMOX-HOST ausführen, danach läuft alles von selbst:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/dauerbetrieb.sh)"
#
# Was passiert:
#   Proxmox-Host
#     • Der MorniHosting-Container startet mit dem Host (onboot, als Erster)
#     • Genug RAM: wird auf bis zu 32 GB angehoben (höchstens die Hälfte des Hosts), dazu 4 GB Swap
#     • Host-Wächter (jede Minute): Ist der Container aus, OHNE dass du ihn gestoppt hast → sofort wieder starten.
#       Hängt er (antwortet 3 Minuten nicht) → neu starten. Stoppst du ihn über Proxmox, bleibt er aus.
#   Im Container
#     • Panel auf den neuesten Stand (update)
#     • Wächter (jede Minute): NetBird, DNS, toter NetBird-Ausgang, Docker, Panel, Speicherplatz
#     • Docker live-restore: startet Docker neu, laufen die Spielserver weiter
#     • Panel: Spielserver, die abstürzen, starten von selbst wieder (Dauerbetrieb)
#
# Befehle: (ohne) einrichten · status · guard (läuft per Timer) · hostguard (nur Host-Teil) · uninstall
# Anderer Container: CTID=105 bash -c "$(curl …)"
# Host ohne Internet? Über den Container holen:
#   pct exec 100 -- curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/dauerbetrieb.sh > /root/dauerbetrieb.sh && bash /root/dauerbetrieb.sh
set -euo pipefail

COMMAND="${1:-setup}"
REPO_RAW="https://raw.githubusercontent.com/pmornhart/MorniHosting/main"
HOST_GUARD="/usr/local/sbin/mornihosting-host-guard"
UNIT_DIR="/etc/systemd/system"
CONF_FILE="/etc/mornihosting-host-guard.conf"
STATE_DIR="/var/lib/mornihosting-host-guard"
LOG_FILE="/var/log/mornihosting-host-guard.log"
LOG_KEEP_LINES=500
TASK_FILES=("/var/log/pve/tasks/active" "/var/log/pve/tasks/index")
INSTALL_DIR="/opt/mornihosting"
MAX_MEMORY_MB=32768
SWAP_MB=4096
HUNG_RESTART_AFTER=3
FSTRIM_EVERY_MINUTES=1440
STORAGE_WARN_PERCENT=85
STORAGE_CLEAR_MARGIN=5
EXEC_TIMEOUT_SECONDS=30

GN=$'\033[1;92m'
RD=$'\033[01;31m'
YW=$'\033[33m'
CL=$'\033[m'
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1"; }

log() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${LOG_FILE}"
  local lines
  lines="$(wc -l <"${LOG_FILE}")"
  if ((lines > LOG_KEEP_LINES * 2)); then
    tail -n "${LOG_KEEP_LINES}" "${LOG_FILE}" >"${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
  fi
}

need_root_on_proxmox() {
  [[ ${EUID} -eq 0 ]] || {
    msg_error "Bitte als root auf dem Proxmox-Host ausführen."
    exit 1
  }
  command -v pct >/dev/null 2>&1 || {
    msg_error "Kein Proxmox gefunden (pct fehlt). Das Skript gehört auf den Proxmox-Host, nicht in den Container."
    exit 1
  }
}

# Der MorniHosting-Container: CTID aus der Umgebung, sonst der mit dem Namen "mornihosting", sonst 100.
find_ctid() {
  if [[ -n "${CTID:-}" ]]; then
    echo "${CTID}"
    return
  fi
  if [[ -f "${CONF_FILE}" ]]; then
    # shellcheck disable=SC1090 # eigene Konfigurationsdatei
    source "${CONF_FILE}"
    [[ -n "${CTID:-}" ]] && {
      echo "${CTID}"
      return
    }
  fi
  local found
  found="$(pct list 2>/dev/null | awk 'NR > 1 && $NF ~ /^mornihosting/ { print $1; exit }')"
  echo "${found:-100}"
}

# Meldung ans Panel (Discord + Mail) über den Wächter im Container. Geht das gerade nicht (Container startet noch),
# bleibt sie hier liegen und wird bei der nächsten Prüfung nachgeschickt.
host_event() {
  local ctid="$1"
  shift
  mkdir -p "${STATE_DIR}"
  printf '%q ' "$@" >>"${STATE_DIR}/pending-${ctid}"
  printf '\n' >>"${STATE_DIR}/pending-${ctid}"
  send_host_events "${ctid}"
}

send_host_events() {
  local ctid="$1"
  local file="${STATE_DIR}/pending-${ctid}" line rest="" args
  [[ -s "${file}" ]] || return 0
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    eval "args=(${line})"
    if ! timeout "${EXEC_TIMEOUT_SECONDS}" pct exec "${ctid}" -- bash "${INSTALL_DIR}/scripts/guard.sh" event host "${args[@]}" >/dev/null 2>&1; then
      rest+="${line}"$'\n'
    fi
  done <"${file}"
  printf '%s' "${rest}" >"${file}"
}

ct_running() { [[ "$(pct status "$1" 2>/dev/null)" == "status: running" ]]; }

# Hat zuletzt ein Mensch (oder Proxmox auf Wunsch) den Container gestoppt? Dann bleibt er aus.
# Proxmox schreibt jeden Start/Stopp als Aufgabe: "UPID:knoten:pid:pstart:STARTZEIT:vzstop:100:root@pam: …".
stopped_on_purpose() {
  local ctid="$1" newest=0 newest_type="" line type start_hex start
  for file in "${TASK_FILES[@]}"; do
    [[ -f "${file}" ]] || continue
    while IFS= read -r line; do
      IFS=':' read -r _ _ _ _ start_hex type _ <<<"${line}"
      start=$((16#${start_hex}))
      if ((start >= newest)); then
        newest="${start}"
        newest_type="${type}"
      fi
    done < <(grep -E ":vz(start|stop|shutdown|reboot):${ctid}:" "${file}" 2>/dev/null || true)
  done
  # Ein Stopp vor dem letzten Hochfahren des Hosts war das Herunterfahren des Hosts: danach soll er wieder laufen.
  local boot
  boot="$(awk '/^btime/ { print $2 }' /proc/stat)"
  ((newest >= boot)) && [[ "${newest_type}" == "vzstop" || "${newest_type}" == "vzshutdown" ]]
}

# Der Host selbst: Geht sein Internet über einen NetBird-Ausgang (Exit-Node), der nicht antwortet, wird der
# Ausgang abgewählt – sonst wäre der Host offline (keine Updates, kein Proxmox-Repository, kein Wächter-Update).
# Jede Antwort zählt; mehrere Ziele ohne Abfrage-Grenze (api.github.com erlaubt nur 60 pro Stunde).
host_internet_ok() {
  local url
  for url in https://1.1.1.1/cdn-cgi/trace https://www.google.com/generate_204 https://9.9.9.9; do
    curl -sS -m 8 -o /dev/null "${url}" >/dev/null 2>&1 && return 0
  done
  return 1
}
host_drop_dead_exit() {
  command -v netbird >/dev/null 2>&1 || return 0
  local fails_file="${STATE_DIR}/host-exit-failures" fails=0
  mkdir -p "${STATE_DIR}"
  if host_internet_ok; then
    echo 0 >"${fails_file}"
    return 0
  fi
  # Erst nach 3 Minuten ohne Internet abwählen, nicht bei einem kurzen Aussetzer.
  [[ -f "${fails_file}" ]] && fails="$(cat "${fails_file}")"
  fails=$((fails + 1))
  echo "${fails}" >"${fails_file}"
  ((fails < 3)) && return 0
  echo 0 >"${fails_file}"
  local listing ids id
  listing="$(timeout 10 netbird networks ls 2>/dev/null || timeout 10 netbird routes list 2>/dev/null || true)"
  ids="$(awk '
    /ID:/      { id = $0; sub(/.*ID:[ \t]*/, "", id); net = ""; next }
    /Network:/ { net = $0; sub(/.*Network:[ \t]*/, "", net); next }
    /Status:/  { if ((net == "0.0.0.0/0" || net == "::/0") && $0 ~ /Selected/ && $0 !~ /Not/) print id }
  ' <<<"${listing}")"
  [[ -n "${ids}" ]] || return 0
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    netbird networks deselect "${id}" >/dev/null 2>&1 || netbird routes deselect "${id}" >/dev/null 2>&1 || true
    log "Host ohne Internet über NetBird-Ausgang ${id} – Ausgang auf dem Host abgewählt"
    host_event "$(find_ctid)" host-exit action "Proxmox-Host war offline" \
      "Der Proxmox-Host ging über den NetBird-Ausgang ${id} ins Internet, der nicht antwortet. Der Host-Wächter hat ihn auf dem Host abgewählt – der Host hat wieder Internet." \
      "Der Host gehört nicht in die Gruppe dieses Ausgangs. Im Panel unter Admin → NetBird als Rechner den MorniHosting-Container (nicht den Host) wählen."
  done <<<"${ids}"
}

# Bricht "pct fstrim" ab (Zeitlimit, Neustart des Hosts), bleibt die Sperre "lock: fstrim" stehen – dann
# startet der Container nicht mehr ("CT is locked (fstrim)"). Läuft kein fstrim mehr, wird sie hier gelöst.
release_stale_lock() {
  local ctid="$1"
  pct config "${ctid}" 2>/dev/null | grep -q '^lock: fstrim' || return 0
  pgrep -f "pct fstrim ${ctid}" >/dev/null 2>&1 && return 0
  pct unlock "${ctid}" >/dev/null 2>&1 && log "Hängende fstrim-Sperre von Container ${ctid} gelöst"
  return 0
}

# Speicher von Proxmox: Gelöschtes im Container belegt im LVM-Thin-Speicher weiter Platz, bis es zurückgegeben
# wird (fstrim) – das passiert einmal am Tag. Ist der Speicher trotzdem über 85 % voll, kommt eine Meldung:
# läuft er ganz voll, bleiben alle Container auf dem Host stehen.
keep_storage() {
  local ctid="$1"
  local stamp="${STATE_DIR}/fstrim-${ctid}" warned="${STATE_DIR}/storage-warned" storage used
  mkdir -p "${STATE_DIR}"
  if [[ -z "$(find "${stamp}" -mmin -"${FSTRIM_EVERY_MINUTES}" 2>/dev/null)" ]]; then
    touch "${stamp}"
    timeout 1800 pct fstrim "${ctid}" >/dev/null 2>&1 && log "Gelöschten Platz von Container ${ctid} zurückgegeben (fstrim)"
    release_stale_lock "${ctid}"
  fi
  storage="$(pct config "${ctid}" | awk -F'[ :,]+' '/^rootfs:/ { print $2 }')"
  [[ -n "${storage}" ]] || return 0
  used="$(pvesm status --storage "${storage}" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $NF); print int($NF) }')"
  [[ -n "${used}" ]] || return 0
  if ((used >= STORAGE_WARN_PERCENT)); then
    # Höchstens einmal pro Stunde melden.
    [[ -n "$(find "${warned}" -mmin -60 2>/dev/null)" ]] && return 0
    touch "${warned}"
    host_event "${ctid}" storage action "Proxmox-Speicher fast voll" \
      "Der Speicher ${storage} auf dem Proxmox-Host ist zu ${used} % belegt. Läuft er voll, bleiben alle Container stehen." \
      "Alte Backups und Server im Panel löschen. Was im Container Platz braucht, zeigt dieser Befehl auf dem Proxmox-Host:" \
      "pct exec ${ctid} -- bash -c 'du -xh --max-depth=1 /var/lib/docker/volumes/mornihosting-data/_data | sort -h | tail -8'"
  elif ((used < STORAGE_WARN_PERCENT - STORAGE_CLEAR_MARGIN)) && [[ -f "${warned}" ]]; then
    rm -f "${warned}"
    host_event "${ctid}" storage ok "Proxmox-Speicher wieder in Ordnung" "Der Speicher ${storage} ist nur noch zu ${used} % belegt."
  fi
  return 0
}

guard() {
  local ctid
  ctid="$(find_ctid)"
  mkdir -p "${STATE_DIR}"
  host_drop_dead_exit
  local hung_file="${STATE_DIR}/hung-${ctid}"
  if ! ct_running "${ctid}"; then
    echo 0 >"${hung_file}"
    if stopped_on_purpose "${ctid}"; then
      return 0
    fi
    log "Container ${ctid} ist aus, ohne dass ihn jemand gestoppt hat – starte ihn"
    release_stale_lock "${ctid}"
    if pct start "${ctid}" >/dev/null 2>&1; then
      host_event "${ctid}" container fixed "MorniHosting-Container neu gestartet" \
        "Container ${ctid} war aus, ohne dass ihn jemand gestoppt hat. Der Host-Wächter hat ihn sofort wieder gestartet."
    else
      log "Start von ${ctid} ging nicht – nächster Versuch in einer Minute"
      host_event "${ctid}" container action "MorniHosting-Container startet nicht" \
        "Container ${ctid} ist aus und lässt sich nicht starten. Panel und alle Server sind offline." \
        "In der Proxmox-Shell nachsehen, warum:" "pct start ${ctid} --debug"
    fi
    return 0
  fi
  # Läuft er, antwortet aber nicht mehr (hängt)? Nach 3 Minuten wird er neu gestartet.
  if timeout "${EXEC_TIMEOUT_SECONDS}" pct exec "${ctid}" -- true >/dev/null 2>&1; then
    echo 0 >"${hung_file}"
  else
    local n=0
    [[ -f "${hung_file}" ]] && n="$(cat "${hung_file}")"
    n=$((n + 1))
    echo "${n}" >"${hung_file}"
    if ((n >= HUNG_RESTART_AFTER)); then
      log "Container ${ctid} hängt seit ${n} Minuten – starte ihn neu"
      host_event "${ctid}" container fixed "MorniHosting-Container hing" \
        "Container ${ctid} antwortete ${n} Minuten nicht mehr und wurde neu gestartet. Server mit Automatisch starten laufen gleich wieder."
      echo 0 >"${hung_file}"
      timeout 120 pct reboot "${ctid}" >/dev/null 2>&1 || {
        pct stop "${ctid}" --skiplock 1 >/dev/null 2>&1 || true
        release_stale_lock "${ctid}"
        pct start "${ctid}" >/dev/null 2>&1 || true
      }
    fi
    return 0
  fi
  send_host_events "${ctid}"
  keep_storage "${ctid}"
  # Der Wächter im Container muss laufen; fehlt er (alte Installation), wird er eingerichtet.
  if ! pct exec "${ctid}" -- systemctl is-active --quiet mornihosting-guard.timer 2>/dev/null; then
    if pct exec "${ctid}" -- test -f "${INSTALL_DIR}/scripts/guard.sh" 2>/dev/null; then
      log "Wächter im Container ${ctid} lief nicht – eingerichtet"
      pct exec "${ctid}" -- bash "${INSTALL_DIR}/scripts/guard.sh" install >/dev/null 2>&1 || true
    fi
  fi
}

install_host_guard() {
  local ctid="$1"
  # Das Skript selbst holen: als Datei gestartet → kopieren; sonst von GitHub, und hat der Host kein Internet,
  # über den Container (der hat meist welches).
  if [[ -f "${BASH_SOURCE[0]:-}" && "$(readlink -f "${BASH_SOURCE[0]}")" != "${HOST_GUARD}" ]]; then
    install -m 755 "${BASH_SOURCE[0]}" "${HOST_GUARD}"
  elif curl -fsSL -m 20 "${REPO_RAW}/proxmox/dauerbetrieb.sh" -o "${HOST_GUARD}.new" ||
    pct exec "${ctid}" -- curl -fsSL -m 20 "${REPO_RAW}/proxmox/dauerbetrieb.sh" >"${HOST_GUARD}.new"; then
    install -m 755 "${HOST_GUARD}.new" "${HOST_GUARD}"
  fi
  rm -f "${HOST_GUARD}.new"
  printf 'CTID=%s\n' "${ctid}" >"${CONF_FILE}"
  cat >"${UNIT_DIR}/mornihosting-host-guard.service" <<UNIT
[Unit]
Description=MorniHosting: Container ${ctid} am Laufen halten
After=pve-guests.service

[Service]
Type=oneshot
ExecStart=${HOST_GUARD} guard
UNIT
  cat >"${UNIT_DIR}/mornihosting-host-guard.timer" <<UNIT
[Unit]
Description=MorniHosting Host-Wächter jede Minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now mornihosting-host-guard.timer >/dev/null
}

raise_resources() {
  local ctid="$1" host_mb current target swap
  host_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  current="$(pct config "${ctid}" | awk '/^memory:/ { print $2 }')"
  swap="$(pct config "${ctid}" | awk '/^swap:/ { print $2 }')"
  target=$((host_mb / 2))
  ((target > MAX_MEMORY_MB)) && target="${MAX_MEMORY_MB}"
  if [[ -n "${current}" ]] && ((current < target)); then
    pct set "${ctid}" --memory "${target}" >/dev/null
    msg_ok "RAM des Containers: ${current} MB → ${target} MB"
  else
    msg_ok "RAM des Containers: ${current:-?} MB (passt)"
  fi
  if [[ -z "${swap}" ]] || ((swap < SWAP_MB)); then
    pct set "${ctid}" --swap "${SWAP_MB}" >/dev/null
    msg_ok "Swap: ${SWAP_MB} MB"
  fi
}

setup() {
  need_root_on_proxmox
  local ctid
  ctid="$(find_ctid)"
  pct config "${ctid}" >/dev/null 2>&1 || {
    msg_error "Container ${ctid} gibt es nicht. Mit anderer Nummer: CTID=<Nummer> bash -c \"\$(curl …)\""
    exit 1
  }
  printf '\n %sMorniHosting Dauerbetrieb%s für Container %s\n\n' "${GN}" "${CL}" "${ctid}"
  host_drop_dead_exit
  if host_internet_ok; then
    msg_ok "Host hat Internet"
  else
    msg_error "Host hat kein Internet – Dateien kommen über den Container"
  fi

  pct set "${ctid}" --onboot 1 --startup order=1,up=30 >/dev/null
  msg_ok "Startet mit dem Proxmox-Host (als Erster)"
  raise_resources "${ctid}"

  ct_running "${ctid}" || {
    msg_info "Container ist aus – starte ihn"
    pct start "${ctid}"
    sleep 10
  }

  msg_info "Panel wird aktualisiert und der Wächter im Container eingerichtet (dauert ein paar Minuten) …"
  if pct exec "${ctid}" -- bash -c "cd ${INSTALL_DIR} && bash update.sh" >/tmp/mornihosting-update.log 2>&1; then
    msg_ok "Panel aktuell, Wächter im Container läuft"
  else
    msg_error "Update im Container hat nicht geklappt (Protokoll: /tmp/mornihosting-update.log) – der Wächter wird trotzdem eingerichtet"
    pct exec "${ctid}" -- bash "${INSTALL_DIR}/scripts/guard.sh" install >/dev/null 2>&1 || true
  fi
  pct exec "${ctid}" -- bash "${INSTALL_DIR}/scripts/guard.sh" check >/dev/null 2>&1 || true

  install_host_guard "${ctid}"
  msg_ok "Host-Wächter läuft (jede Minute)"
  msg_info "Gelöschten Platz an Proxmox zurückgeben (fstrim, kann ein paar Minuten dauern) …"
  timeout 1800 pct fstrim "${ctid}" >/dev/null 2>&1 && msg_ok "Platz zurückgegeben"
  release_stale_lock "${ctid}"
  mkdir -p "${STATE_DIR}" && touch "${STATE_DIR}/fstrim-${ctid}"

  printf '\n'
  status_report "${ctid}"
  printf '\n %sFertig.%s Ab jetzt hält sich alles selbst am Laufen. Stoppst du den Container über Proxmox, bleibt er aus.\n' "${GN}" "${CL}"
  printf ' Status jederzeit: %s status\n\n' "${HOST_GUARD}"
}

status_report() {
  local ctid="$1"
  printf ' Container %s:  %s\n' "${ctid}" "$(pct status "${ctid}" 2>/dev/null | cut -d' ' -f2)"
  printf ' Host-Wächter:  %s\n' "$(systemctl is-active mornihosting-host-guard.timer 2>/dev/null || echo aus)"
  printf ' Mit Host starten: %s\n' "$(pct config "${ctid}" | awk '/^onboot:/ { print ($2 == 1 ? "ja" : "nein") }')"
  if ct_running "${ctid}"; then
    printf '\n Im Container:\n'
    timeout "${EXEC_TIMEOUT_SECONDS}" pct exec "${ctid}" -- bash "${INSTALL_DIR}/scripts/guard.sh" status 2>/dev/null |
      sed 's/^/   /' || true
  fi
  if [[ -f "${LOG_FILE}" ]]; then
    printf '\n Letzte Eingriffe auf dem Host:\n'
    tail -n 5 "${LOG_FILE}" | sed 's/^/   /'
  fi
}

case "${COMMAND}" in
  setup) setup ;;
  guard)
    need_root_on_proxmox
    guard
    ;;
  hostguard)
    # Nur den Host-Teil (vom Proxmox-Installationsskript direkt nach dem Anlegen aufgerufen).
    need_root_on_proxmox
    pct set "$(find_ctid)" --onboot 1 --startup order=1,up=30 >/dev/null
    install_host_guard "$(find_ctid)"
    msg_ok "Host-Wächter läuft (jede Minute)"
    ;;
  status)
    need_root_on_proxmox
    status_report "$(find_ctid)"
    ;;
  uninstall)
    systemctl disable --now mornihosting-host-guard.timer >/dev/null 2>&1 || true
    rm -f "${UNIT_DIR}/mornihosting-host-guard.service" "${UNIT_DIR}/mornihosting-host-guard.timer" "${HOST_GUARD}"
    systemctl daemon-reload
    msg_ok "Host-Wächter entfernt"
    ;;
  *)
    msg_error "Unbekannter Befehl: ${COMMAND} (ohne Befehl einrichten, status, guard, uninstall)"
    exit 2
    ;;
esac
