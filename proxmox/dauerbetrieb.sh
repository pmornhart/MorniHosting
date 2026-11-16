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
# Ein anderes Produkt mit MorniHosting als Motor (z. B. MoinMorni, auch auf demselben Host): eigener Name, eigene
# Konfiguration und eigene Einheiten je Container –
#   MH_GUARD_NAME=moinmorni MH_BRAND=MoinMorni MH_INSTALL_DIR=/opt/moinmorni MH_CT_GUARD=/usr/local/sbin/moinmorni-guard \
#   MH_DATA_VOLUME=moinmorni-motor-data CTID=105 bash dauerbetrieb.sh hostguard
# Die Werte landen in /etc/<Name>-host-guard.conf; das Skript liegt als /usr/local/sbin/<Name>-host-guard bereit und
# erkennt sein Produkt am eigenen Namen.
# Host ohne Internet? Über den Container holen:
#   pct exec 100 -- curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/dauerbetrieb.sh > /root/dauerbetrieb.sh && bash /root/dauerbetrieb.sh
set -euo pipefail

COMMAND="${1:-setup}"
REPO_RAW="https://raw.githubusercontent.com/pmornhart/MorniHosting/main"
# Welches Produkt: aus der Umgebung, sonst aus dem eigenen Namen (/usr/local/sbin/<Name>-host-guard), sonst MorniHosting.
SELF_NAME="$(basename "${BASH_SOURCE[0]:-dauerbetrieb.sh}")"
DEFAULT_NAME="mornihosting"
[[ "${SELF_NAME}" == *-host-guard ]] && DEFAULT_NAME="${SELF_NAME%-host-guard}"
GUARD_NAME="${MH_GUARD_NAME:-${DEFAULT_NAME}}"
# Der Name steckt in Pfaden und Einheiten: nur "mornihosting", "moinmorni" und Ähnliches.
[[ "${GUARD_NAME}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || {
  printf 'Ungültiger Name für den Wächter: %s (nur a-z, 0-9 und -)\n' "${GUARD_NAME}" >&2
  exit 2
}
HOST_GUARD="${MH_WRAPPER_DIR:-/usr/local/sbin}/${GUARD_NAME}-host-guard"
UNIT_DIR="${MH_UNIT_DIR:-/etc/systemd/system}"
CONF_FILE="${MH_HOST_GUARD_CONF:-/etc/${GUARD_NAME}-host-guard.conf}"
# Einstellungen des Produkts, die "hostguard" in die Konfiguration schreibt (die Umgebung geht vor).
PRODUCT_SETTINGS=(MH_BRAND MH_INSTALL_DIR MH_CT_GUARD MH_DATA_VOLUME)
# Erlaubt: Namen und Pfade wie "MoinMorni" oder "/usr/local/sbin/moinmorni-guard" (keine Leerzeichen, Anführungszeichen, $).
SAFE_VALUE='^[A-Za-z0-9._/+-]+$'
load_product_settings() {
  [[ -f "${CONF_FILE}" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    [[ " ${PRODUCT_SETTINGS[*]} " == *" ${key} "* && "${value}" =~ ${SAFE_VALUE} ]] || continue
    [[ -n "${!key:-}" ]] || printf -v "${key}" '%s' "${value}"
  done <"${CONF_FILE}"
}
load_product_settings
BRAND="${MH_BRAND:-MorniHosting}"
STATE_DIR="${MH_HOST_GUARD_STATE_DIR:-/var/lib/${GUARD_NAME}-host-guard}"
LOG_FILE="${MH_HOST_GUARD_LOG:-/var/log/${GUARD_NAME}-host-guard.log}"
LOG_KEEP_LINES=500
PVE_TASK_DIR="${MH_PVE_TASK_DIR:-/var/log/pve/tasks}"
TASK_FILES=("${PVE_TASK_DIR}/active" "${PVE_TASK_DIR}/index")
# Läuft eine Proxmox-Aufgabe für den Container (Neustart, Start, Stopp …), wartet der Wächter so lange auf sie.
TASK_GRACE_SECONDS=600
INSTALL_DIR="${MH_INSTALL_DIR:-/opt/${GUARD_NAME}}"
DATA_VOLUME="${MH_DATA_VOLUME:-${GUARD_NAME}-data}"
# Der Wächter im Container: das Startskript des Produkts (legt "guard.sh install" mit seinen Werten an), sonst guard.sh.
if [[ -n "${MH_CT_GUARD:-}" ]]; then
  CT_GUARD=("${MH_CT_GUARD}")
else
  CT_GUARD=(bash "${INSTALL_DIR}/scripts/guard.sh")
fi
MAX_MEMORY_MB=32768
SWAP_MB=4096
HUNG_RESTART_AFTER=3
FSTRIM_EVERY_MINUTES=1440
FSTRIM_WAIT_SECONDS=1800
FSTRIM_TIMEOUT_SECONDS=1800
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
  [[ "$(id -u)" -eq 0 ]] || {
    msg_error "Bitte als root auf dem Proxmox-Host ausführen."
    exit 1
  }
  command -v pct >/dev/null 2>&1 || {
    msg_error "Kein Proxmox gefunden (pct fehlt). Das Skript gehört auf den Proxmox-Host, nicht in den Container."
    exit 1
  }
}

# Der Container des Produkts: CTID aus der Umgebung, sonst aus der Konfiguration, sonst der mit dem Namen des
# Produkts ("mornihosting", "moinmorni"), sonst 100.
find_ctid() {
  if [[ -n "${CTID:-}" ]]; then
    echo "${CTID}"
    return
  fi
  local found=""
  [[ -f "${CONF_FILE}" ]] && found="$(awk -F= '$1 == "CTID" && $2 ~ /^[0-9]+$/ { print $2; exit }' "${CONF_FILE}")"
  [[ -n "${found}" ]] ||
    found="$(pct list 2>/dev/null | awk -v name="${GUARD_NAME}" 'NR > 1 && index($NF, name) == 1 { print $1; exit }')"
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
    if ! timeout "${EXEC_TIMEOUT_SECONDS}" pct exec "${ctid}" -- "${CT_GUARD[@]}" event host "${args[@]}" >/dev/null 2>&1; then
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
      "Der Host gehört nicht in die Gruppe dieses Ausgangs. Im Panel bei NetBird als Rechner den ${BRAND}-Container (nicht den Host) wählen."
  done <<<"${ids}"
}

ct_lock() { pct config "$1" 2>/dev/null | awk '/^lock:/ { print $2; exit }'; }

# Läuft gerade eine Proxmox-Aufgabe für den Container (Neustart über die Oberfläche, Start, Stopp, Umzug …)
# oder ist er gesperrt (Backup, Snapshot …), funkt der Wächter nicht dazwischen – sonst startet er ihn mitten
# im Neustart oder im Backup ein zweites Mal. Eine Aufgabe, die länger als 10 Minuten läuft, gilt als hängend.
# Proxmox nennt den Prozess einer Aufgabe "task UPID:knoten:pid:pstart:startzeit:typ:id:benutzer:".
ct_busy() {
  local ctid="$1" lock pid age
  lock="$(ct_lock "${ctid}")"
  [[ -n "${lock}" && "${lock}" != "fstrim" ]] && return 0
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    age="$(ps -o etimes= -p "${pid}" 2>/dev/null | tr -d ' ')"
    [[ -n "${age}" ]] && ((age < TASK_GRACE_SECONDS)) && return 0
  done < <(pgrep -f "^task UPID:[^:]*:[0-9A-Fa-f]*:[0-9A-Fa-f]*:[0-9A-Fa-f]*:[a-z]*:${ctid}:" 2>/dev/null || true)
  return 1
}

# Ältere Fassungen dieses Wächters gaben Platz mit "pct fstrim" zurück. Das sperrt den Container ("lock: fstrim")
# und hängt sein Dateisystem auf dem Host ein. Bricht es ab, bleibt beides stehen – dann startet er nicht mehr
# ("CT is locked (fstrim)"). Läuft er, wird nur eine verwaiste Sperre gelöst.
release_stale_lock() {
  local ctid="$1"
  [[ "$(ct_lock "${ctid}")" == "fstrim" ]] || return 0
  pgrep -f "pct fstrim ${ctid}( |$)" >/dev/null 2>&1 && return 0
  pct unlock "${ctid}" >/dev/null 2>&1 && log "Hängende fstrim-Sperre von Container ${ctid} gelöst"
  return 0
}

# Der Container ist aus und soll laufen: Der Start geht vor. Ein noch laufendes fstrim wird abgebrochen, das dabei
# eingehängte Dateisystem ausgehängt und die Sperre gelöst. Platz kann später noch zurückgegeben werden.
clear_fstrim_lock() {
  local ctid="$1"
  [[ "$(ct_lock "${ctid}")" == "fstrim" ]] || return 0
  if pgrep -f "pct fstrim ${ctid}( |$)" >/dev/null 2>&1; then
    pkill -f "pct fstrim ${ctid}( |$)" >/dev/null 2>&1 || true
    pkill -f "fstrim -v /var/lib/lxc/${ctid}/rootfs" >/dev/null 2>&1 || true
    sleep 3
  fi
  pct unmount "${ctid}" >/dev/null 2>&1 || true
  pct unlock "${ctid}" >/dev/null 2>&1 || true
  log "fstrim-Sperre von Container ${ctid} gelöst – der Start geht vor"
}

# Was im laufenden Container getrimmt wird: das Dateisystem selbst und eigene Laufwerke (mp0, mp1 …), keine
# eingebundenen Host-Ordner und nichts Schreibgeschütztes. Über /proc/<pid>/root – ohne Sperre, ohne Einhängen.
trim_paths() {
  local ctid="$1" pid
  pid="$(lxc-info -n "${ctid}" -p -H 2>/dev/null || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  echo "/proc/${pid}/root/"
  pct config "${ctid}" 2>/dev/null | awk -v root="/proc/${pid}/root" '
    /^mp[0-9]+:/ {
      vol = $2; sub(/,.*/, "", vol)
      if (vol ~ /^\// || $0 ~ /,ro=1/) next
      path = $0; sub(/.*,mp=/, "", path); sub(/,.*/, "", path)
      print root path
    }'
}

# Gibt gelöschten Platz im Hintergrund zurück (eigene systemd-Einheit, niedrigste Priorität): Der Wächter prüft
# währenddessen weiter, und ein Neustart des Containers ist nie gesperrt.
trim_in_background() {
  local ctid="$1" unit="${GUARD_NAME}-fstrim-$1" paths=()
  systemctl is-active --quiet "${unit}" 2>/dev/null && return 0
  mapfile -t paths < <(trim_paths "${ctid}")
  ((${#paths[@]} > 0)) || return 1
  # shellcheck disable=SC2016 # $path wird erst in der Hintergrund-Shell aufgelöst
  systemd-run --unit="${unit}" --collect --quiet --nice=19 -p IOSchedulingClass=idle \
    timeout -k 30 "${FSTRIM_TIMEOUT_SECONDS}" sh -c 'for path; do fstrim -v "$path"; done' fstrim "${paths[@]}" \
    >/dev/null 2>&1
}

# Läuft gerade ein fstrim (Host-Wächter), ist der Container gesperrt und "pct set" scheitert mit
# "CT is locked (fstrim)". Die Einrichtung wartet darauf (höchstens 30 Min.) und löst eine hängende Sperre.
wait_for_fstrim() {
  local ctid="$1" waited=0
  while pct config "${ctid}" 2>/dev/null | grep -q '^lock: fstrim' && pgrep -f "pct fstrim ${ctid}( |$)" >/dev/null 2>&1; do
    ((waited == 0)) && msg_info "Proxmox gibt gerade freien Platz zurück (fstrim) – warte, bis das fertig ist …"
    ((waited >= FSTRIM_WAIT_SECONDS)) && break
    sleep 10
    waited=$((waited + 10))
  done
  release_stale_lock "${ctid}"
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
    trim_in_background "${ctid}" && log "Gelöschten Platz von Container ${ctid} zurückgeben (fstrim läuft im Hintergrund)"
  fi
  release_stale_lock "${ctid}"
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
      "pct exec ${ctid} -- bash -c 'du -xh --max-depth=1 /var/lib/docker/volumes/${DATA_VOLUME}/_data | sort -h | tail -8'"
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
  # Proxmox arbeitet gerade am Container (Neustart über die Oberfläche, Backup …): nicht dazwischenfunken.
  ct_busy "${ctid}" && return 0
  local hung_file="${STATE_DIR}/hung-${ctid}" failed_file="${STATE_DIR}/start-failed-${ctid}"
  if ! ct_running "${ctid}"; then
    echo 0 >"${hung_file}"
    if stopped_on_purpose "${ctid}"; then
      return 0
    fi
    log "Container ${ctid} ist aus, ohne dass ihn jemand gestoppt hat – starte ihn"
    clear_fstrim_lock "${ctid}"
    local out reason
    if out="$(pct start "${ctid}" 2>&1)"; then
      if [[ -f "${failed_file}" ]]; then
        rm -f "${failed_file}"
        host_event "${ctid}" container ok "${BRAND}-Container läuft wieder" \
          "Container ${ctid} ließ sich eine Weile nicht starten und läuft jetzt wieder."
      else
        host_event "${ctid}" container fixed "${BRAND}-Container neu gestartet" \
          "Container ${ctid} war aus, ohne dass ihn jemand gestoppt hat. Der Host-Wächter hat ihn sofort wieder gestartet."
      fi
    else
      # Der letzte Satz von Proxmox nennt den Grund, z. B. "CT is locked (backup)".
      reason="$(printf '%s\n' "${out}" | awk 'NF { line = $0 } END { print line }')"
      log "Start von ${ctid} ging nicht (${reason:-ohne Grund}) – nächster Versuch in einer Minute"
      # Einmal pro Ausfall melden, nicht jede Minute.
      if [[ ! -f "${failed_file}" ]]; then
        touch "${failed_file}"
        host_event "${ctid}" container action "${BRAND}-Container startet nicht" \
          "Container ${ctid} ist aus und lässt sich nicht starten (Proxmox sagt: ${reason:-nichts}). ${BRAND} und alle Server sind offline. Der Host-Wächter versucht es jede Minute weiter." \
          "In der Proxmox-Shell nachsehen, warum:" "pct start ${ctid} --debug"
      fi
    fi
    return 0
  fi
  rm -f "${failed_file}"
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
      host_event "${ctid}" container fixed "${BRAND}-Container hing" \
        "Container ${ctid} antwortete ${n} Minuten nicht mehr und wurde neu gestartet. Server mit Automatisch starten laufen gleich wieder."
      echo 0 >"${hung_file}"
      timeout 120 pct reboot "${ctid}" >/dev/null 2>&1 || {
        pct stop "${ctid}" --skiplock 1 >/dev/null 2>&1 || true
        clear_fstrim_lock "${ctid}"
        pct start "${ctid}" >/dev/null 2>&1 || true
      }
    fi
    return 0
  fi
  send_host_events "${ctid}"
  keep_storage "${ctid}"
  # Der Wächter im Container muss laufen; fehlt er (alte Installation), wird er eingerichtet.
  if ! pct exec "${ctid}" -- systemctl is-active --quiet "${GUARD_NAME}-guard.timer" 2>/dev/null; then
    if pct exec "${ctid}" -- test -f "${CT_GUARD[${#CT_GUARD[@]} - 1]}" 2>/dev/null; then
      log "Wächter im Container ${ctid} lief nicht – eingerichtet"
      pct exec "${ctid}" -- "${CT_GUARD[@]}" install >/dev/null 2>&1 || true
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
  write_conf "${ctid}"
  mkdir -p "${UNIT_DIR}"
  cat >"${UNIT_DIR}/${GUARD_NAME}-host-guard.service" <<UNIT
[Unit]
Description=${BRAND}: Container ${ctid} am Laufen halten
After=pve-guests.service

[Service]
Type=oneshot
Environment=MH_GUARD_NAME=${GUARD_NAME}
ExecStart=${HOST_GUARD} guard
UNIT
  cat >"${UNIT_DIR}/${GUARD_NAME}-host-guard.timer" <<UNIT
[Unit]
Description=${BRAND} Host-Wächter jede Minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "${GUARD_NAME}-host-guard.timer" >/dev/null
}

# Konfiguration des Host-Wächters: der Container und – für ein anderes Produkt – dessen Werte.
write_conf() {
  local ctid="$1" key lines
  lines="CTID=${ctid}"$'\n'
  for key in "${PRODUCT_SETTINGS[@]}"; do
    [[ -n "${!key:-}" ]] || continue
    [[ "${!key}" =~ ${SAFE_VALUE} ]] || {
      msg_error "${key} enthält Zeichen, die hier nicht gehen: ${!key}"
      exit 1
    }
    lines+="${key}=${!key}"$'\n'
  done
  mkdir -p "$(dirname "${CONF_FILE}")"
  printf '%s' "${lines}" >"${CONF_FILE}.tmp"
  mv "${CONF_FILE}.tmp" "${CONF_FILE}"
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
  printf '\n %s%s Dauerbetrieb%s für Container %s\n\n' "${GN}" "${BRAND}" "${CL}" "${ctid}"
  host_drop_dead_exit
  if host_internet_ok; then
    msg_ok "Host hat Internet"
  else
    msg_error "Host hat kein Internet – Dateien kommen über den Container"
  fi

  wait_for_fstrim "${ctid}"
  pct set "${ctid}" --onboot 1 --startup order=1,up=30 >/dev/null
  msg_ok "Startet mit dem Proxmox-Host (als Erster)"
  raise_resources "${ctid}"

  ct_running "${ctid}" || {
    msg_info "Container ist aus – starte ihn"
    pct start "${ctid}"
    sleep 10
  }

  msg_info "Panel wird aktualisiert und der Wächter im Container eingerichtet (dauert ein paar Minuten) …"
  if pct exec "${ctid}" -- bash -c "cd ${INSTALL_DIR} && bash update.sh" >"/tmp/${GUARD_NAME}-update.log" 2>&1; then
    msg_ok "Panel aktuell, Wächter im Container läuft"
  else
    msg_error "Update im Container hat nicht geklappt (Protokoll: /tmp/${GUARD_NAME}-update.log) – der Wächter wird trotzdem eingerichtet"
    pct exec "${ctid}" -- "${CT_GUARD[@]}" install >/dev/null 2>&1 || true
  fi
  pct exec "${ctid}" -- "${CT_GUARD[@]}" check >/dev/null 2>&1 || true

  install_host_guard "${ctid}"
  msg_ok "Host-Wächter läuft (jede Minute)"
  release_stale_lock "${ctid}"
  trim_in_background "${ctid}" && msg_ok "Gelöschter Platz wird im Hintergrund an Proxmox zurückgegeben"
  mkdir -p "${STATE_DIR}" && touch "${STATE_DIR}/fstrim-${ctid}"

  printf '\n'
  status_report "${ctid}"
  printf '\n %sFertig.%s Ab jetzt hält sich alles selbst am Laufen. Stoppst du den Container über Proxmox, bleibt er aus.\n' "${GN}" "${CL}"
  printf ' Status jederzeit: %s status\n\n' "${HOST_GUARD}"
}

status_report() {
  local ctid="$1"
  printf ' Container %s:  %s\n' "${ctid}" "$(pct status "${ctid}" 2>/dev/null | cut -d' ' -f2)"
  printf ' Host-Wächter:  %s\n' "$(systemctl is-active "${GUARD_NAME}-host-guard.timer" 2>/dev/null || echo aus)"
  printf ' Mit Host starten: %s\n' "$(pct config "${ctid}" | awk '/^onboot:/ { print ($2 == 1 ? "ja" : "nein") }')"
  if ct_running "${ctid}"; then
    printf '\n Im Container:\n'
    timeout "${EXEC_TIMEOUT_SECONDS}" pct exec "${ctid}" -- "${CT_GUARD[@]}" status 2>/dev/null |
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
    systemctl disable --now "${GUARD_NAME}-host-guard.timer" >/dev/null 2>&1 || true
    rm -f "${UNIT_DIR}/${GUARD_NAME}-host-guard.service" "${UNIT_DIR}/${GUARD_NAME}-host-guard.timer" "${HOST_GUARD}"
    systemctl daemon-reload
    msg_ok "Host-Wächter entfernt"
    ;;
  *)
    msg_error "Unbekannter Befehl: ${COMMAND} (ohne Befehl einrichten, status, guard, uninstall)"
    exit 2
    ;;
esac
