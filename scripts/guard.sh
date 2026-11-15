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
# Befehle: check (Standard) · status · dns (nur DNS prüfen) · netbird-api (nur NetBird-API prüfen) · install · uninstall
set -euo pipefail

COMMAND="${1:-check}"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
UNIT_DIR="/etc/systemd/system"
STATE_DIR="${MH_GUARD_STATE_DIR:-/var/lib/mornihosting}"
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
LOG_FILE="${MH_GUARD_LOG:-/var/log/mornihosting-guard.log}"
LOG_KEEP_LINES=500
# So oft hintereinander darf NetBird getrennt sein, bevor der Dienst neu startet (1 Prüfung = 1 Minute).
RESTART_AFTER="${NETBIRD_RESTART_AFTER:-2}"
UP_TIMEOUT_SECONDS=60
CHECK_TIMEOUT_SECONDS=8
FALLBACK_DNS=("1.1.1.1" "9.9.9.9")
RESOLV_CONF="${MH_RESOLV_CONF:-/etc/resolv.conf}"
# DNS gilt als kaputt, wenn keiner dieser Namen aufgelöst werden kann – ein einzelner langsamer Name ist kein Ausfall.
DNS_TEST_HOSTS=("github.com" "cloudflare.com" "google.com")
DNS_TIMEOUT_SECONDS=4
# So oft hintereinander (1 Prüfung = 1 Minute) muss DNS fehlen, bevor der Wächter eingreift.
DNS_FIX_AFTER=2
DNS_FAIL_FILE="${STATE_DIR}/dns-failures"
# Wird DNS so oft in so vielen Stunden zurückgesetzt, meldet der Wächter einmal das Dauerproblem statt jedes Mal "repariert".
DNS_FIXES_FILE="${STATE_DIR}/dns-fixes"
DNS_FLAP_LIMIT=3
DNS_FLAP_HOURS=6
DNS_DOWN_SENT="${STATE_DIR}/dns-down-sent"
DNS_FLAP_SENT="${STATE_DIR}/dns-flap-sent"
# Die NetBird-API (MH_NETBIRD_API in der .env): Das Panel braucht sie für Server-Adressen und „Hausanschluss
# verstecken“. Läuft alles über einen Ausgang, der auf dem NetBird-Server selbst sitzt, kommt das Panel dort oft
# nicht an (der NetBird-Dienst selbst nimmt einen eigenen Weg und bleibt verbunden). Dann leitet der Wächter nur
# die Verbindung zum NetBird-Server am Ausgang vorbei – der sieht deinen Anschluss ohnehin schon.
ENV_FILE="${INSTALL_DIR}/.env"
NETBIRD_API_FAIL_FILE="${STATE_DIR}/netbird-api-failures"
NETBIRD_API_FIX_AFTER=2
NETBIRD_API_SENT="${STATE_DIR}/netbird-api-sent"
NETBIRD_BYPASS_FILE="${STATE_DIR}/netbird-api-bypass"
# Internet-Prüfung: Jede Antwort zählt (auch 4xx), nur keine Antwort heißt "kein Internet". Mehrere Ziele ohne
# Abfrage-Grenze – vorher api.github.com: das erlaubt nur 60 Abfragen pro Stunde, nach einer Stunde kam "zu viele"
# und der Wächter schaltete den Ausgang ab (Hausanschluss jede Stunde sichtbar).
WEB_TEST_URLS=("https://1.1.1.1/cdn-cgi/trace" "https://www.google.com/generate_204" "https://9.9.9.9")
# So oft hintereinander (1 Prüfung = 1 Minute) muss das Internet über den Ausgang fehlen, bevor er abgewählt wird.
EXIT_DEAD_AFTER=3
EXIT_FAIL_FILE="${STATE_DIR}/exit-failures"
# Proxmox schreibt /etc/resolv.conf in Containern bei jedem Start neu – außer diese Datei existiert.
PVE_IGNORE_RESOLV="$(dirname "${RESOLV_CONF}")/.pve-ignore.$(basename "${RESOLV_CONF}")"

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

dns_ok() {
  local host
  for host in "${DNS_TEST_HOSTS[@]}"; do
    timeout "${DNS_TIMEOUT_SECONDS}" getent hosts "${host}" >/dev/null 2>&1 && return 0
  done
  return 1
}
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

# Die DNS-Server, die gerade eingetragen sind (durch Leerzeichen getrennt).
resolv_servers() { awk '/^nameserver/ { print $2 }' "${RESOLV_CONF}" 2>/dev/null | paste -sd' ' - || true; }

# Wer die Einstellung zuletzt geschrieben hat – steht im Text der Meldung, damit man die Ursache sieht.
resolv_writer() {
  local servers="$1"
  if grep -qi 'netbird' "${RESOLV_CONF}" 2>/dev/null || grep -qE '(^| )100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' <<<"${servers}"; then
    echo "NetBird"
  elif [[ -z "${servers}" ]]; then
    echo "niemand (leer)"
  else
    echo "Proxmox oder das System"
  fi
}

# Merkt sich, wann DNS repariert wurde, und sagt, wie oft in den letzten DNS_FLAP_HOURS Stunden.
count_dns_fixes() {
  local now since
  now="$(date +%s)"
  since=$((now - DNS_FLAP_HOURS * 3600))
  { [[ -f "${DNS_FIXES_FILE}" ]] && awk -v s="${since}" '$1 >= s' "${DNS_FIXES_FILE}"; echo "${now}"; } >"${DNS_FIXES_FILE}.tmp"
  mv "${DNS_FIXES_FILE}.tmp" "${DNS_FIXES_FILE}"
  wc -l <"${DNS_FIXES_FILE}" | tr -d ' '
}

# Eine Meldung höchstens einmal in DNS_FLAP_HOURS Stunden (Merkdatei mit Zeitstempel).
once_in_a_while() {
  local stamp="$1"
  [[ -n "$(find "${stamp}" -mmin -$((DNS_FLAP_HOURS * 60)) 2>/dev/null)" ]] && return 1
  touch "${stamp}"
}

fix_dns() {
  mkdir -p "${STATE_DIR}"
  if dns_ok; then
    echo 0 >"${DNS_FAIL_FILE}"
    if [[ -f "${DNS_DOWN_SENT}" ]]; then
      rm -f "${DNS_DOWN_SENT}"
      event container dns:down ok "DNS geht wieder" "Der Container kann wieder Adressen auflösen."
    fi
    return 0
  fi
  local failures before writer
  failures="$(count_up "${DNS_FAIL_FILE}")"
  # Einmal keine Antwort ist noch kein Ausfall (Netz kurz weg, Ausgang wechselt gerade).
  if ((failures < DNS_FIX_AFTER)); then
    log "DNS antwortet gerade nicht – warte noch eine Prüfung ab"
    return 0
  fi
  before="$(resolv_servers)"
  writer="$(resolv_writer "${before}")"
  if [[ "${before}" == "${FALLBACK_DNS[*]}" ]]; then
    # Die festen Server stehen schon drin: neu schreiben ändert nichts, also auch nicht "repariert" melden.
    log "DNS geht seit ${failures} Prüfungen nicht, obwohl ${FALLBACK_DNS[*]} eingetragen sind"
    if [[ ! -f "${DNS_DOWN_SENT}" ]]; then
      touch "${DNS_DOWN_SENT}"
      event container dns:down action "DNS geht nicht" "Der Container kann seit ${failures} Minuten keine Adressen auflösen, obwohl die festen DNS-Server (${FALLBACK_DNS[*]}) eingetragen sind. Meist ist das Internet weg oder der NetBird-Ausgang lässt DNS nicht durch." \
        "Schau im Container nach, was los ist:" "bash ${SCRIPT_PATH} status"
    fi
    return 0
  fi
  log "DNS geht nicht (eingetragen war: ${before:-nichts}, von ${writer}) – trage ${FALLBACK_DNS[*]} fest ein"
  touch "${PVE_IGNORE_RESOLV}" 2>/dev/null || true
  {
    printf '# MorniHosting NetBird-Wächter: feste DNS-Server (Proxmox überschreibt sie nicht mehr)\n'
    printf 'nameserver %s\n' "${FALLBACK_DNS[@]}"
  } >"${RESOLV_CONF}"
  if ! dns_ok; then
    log "DNS geht auch mit ${FALLBACK_DNS[*]} nicht"
    if [[ ! -f "${DNS_DOWN_SENT}" ]]; then
      touch "${DNS_DOWN_SENT}"
      event container dns:down action "DNS geht nicht" "Der Container konnte keine Adressen auflösen (eingetragen war: ${before:-nichts}, von ${writer}). Auch mit festen DNS-Servern (${FALLBACK_DNS[*]}) kommt keine Antwort – meist ist das Internet weg oder der NetBird-Ausgang lässt DNS nicht durch." \
        "Schau im Container nach, was los ist:" "bash ${SCRIPT_PATH} status"
    fi
    return 0
  fi
  echo 0 >"${DNS_FAIL_FILE}"
  local fixes
  fixes="$(count_dns_fixes)"
  if ((fixes >= DNS_FLAP_LIMIT)); then
    # Immer wieder dasselbe: einmal das Dauerproblem melden statt jedes Mal "repariert".
    once_in_a_while "${DNS_FLAP_SENT}" || return 0
    if [[ "${writer}" == "NetBird" ]]; then
      event container dns:flapping action "DNS wird immer wieder umgestellt" "In den letzten ${DNS_FLAP_HOURS} Stunden musste der Wächter DNS ${fixes}-mal reparieren. Jedes Mal hatte NetBird seinen eigenen DNS-Server (${before}) eingetragen, der nicht antwortete. Der Wächter repariert es weiter selbst, meldet es aber erst in ${DNS_FLAP_HOURS} Stunden wieder." \
        "Damit es aufhört: NetBird die DNS-Verwaltung in diesem Container abnehmen (im NetBird-Dashboard unter DNS, oder im Container):" "netbird down && netbird up --disable-dns"
    else
      event container dns:flapping action "DNS wird immer wieder umgestellt" "In den letzten ${DNS_FLAP_HOURS} Stunden musste der Wächter DNS ${fixes}-mal reparieren (zuletzt stand ${before:-nichts} drin, von ${writer}). Der Wächter repariert es weiter selbst, meldet es aber erst in ${DNS_FLAP_HOURS} Stunden wieder." \
        "Schau im Container nach, wer die DNS-Einstellung zurücksetzt:" "bash ${SCRIPT_PATH} status"
    fi
    return 0
  fi
  rm -f "${DNS_DOWN_SENT}"
  event container dns fixed "DNS repariert" "Der Container konnte keine Adressen mehr auflösen (eingetragen war: ${before:-nichts}, von ${writer}). Der Wächter hat feste DNS-Server (${FALLBACK_DNS[*]}) eingetragen – jetzt geht es wieder."
}

netbird_api_url() {
  local url
  url="$(grep -E '^MH_NETBIRD_API=' "${ENV_FILE}" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' " || true)"
  printf '%s' "${url%/}"
}
url_host() {
  local host="${1#*://}"
  host="${host%%/*}"
  printf '%s' "${host%%:*}"
}
# Jede HTTP-Antwort zählt (ohne Schlüssel kommt 401) – dann ist der NetBird-Server da.
netbird_api_ok() { curl -sS -m "${CHECK_TIMEOUT_SECONDS}" -o /dev/null "$1/api/peers" >/dev/null 2>&1; }
# Der normale Weg ins Internet (ohne Ausgang): "<gateway> <gerät>".
main_gateway() {
  ip -4 route show table main default 2>/dev/null |
    awk '{ for (i = 1; i <= NF; i++) { if ($i == "via") g = $(i + 1); if ($i == "dev") d = $(i + 1) } if (g != "") { print g " " d; exit } }' || true
}
# Ein Ziel am Ausgang vorbei: eine Route nur für diese Adresse über den normalen Weg (gewinnt gegen den Ausgang).
bypass_ip() {
  local target="$1" gw dev
  read -r gw dev <<<"$(main_gateway)"
  [[ -n "${gw}" && -n "${dev}" ]] || return 1
  ip route replace "${target}/32" via "${gw}" dev "${dev}" 2>/dev/null
}
# Nach einem Neustart sind die Routen weg – die gemerkten jedes Mal wieder setzen.
reapply_bypass() {
  [[ -s "${NETBIRD_BYPASS_FILE}" ]] || return 0
  local target
  while IFS= read -r target; do
    [[ -n "${target}" ]] && { bypass_ip "${target}" || true; }
  done <"${NETBIRD_BYPASS_FILE}"
}

keep_netbird_api() {
  local url host failures targets target
  url="$(netbird_api_url)"
  [[ -n "${url}" ]] || return 0
  mkdir -p "${STATE_DIR}"
  reapply_bypass
  host="$(url_host "${url}")"
  if netbird_api_ok "${url}"; then
    echo 0 >"${NETBIRD_API_FAIL_FILE}"
    if [[ -f "${NETBIRD_API_SENT}" ]]; then
      rm -f "${NETBIRD_API_SENT}"
      event container netbird:api ok "NetBird-API wieder erreichbar" "Das Panel erreicht den NetBird-Server (${host}) wieder."
    fi
    return 0
  fi
  failures="$(count_up "${NETBIRD_API_FAIL_FILE}")"
  ((failures < NETBIRD_API_FIX_AFTER)) && return 0
  if [[ -n "$(selected_exit_ids)" ]]; then
    targets="$(getent ahostsv4 "${host}" 2>/dev/null | awk '{ print $1 }' | sort -u || true)"
    while IFS= read -r target; do
      [[ -n "${target}" ]] || continue
      bypass_ip "${target}" || continue
      grep -qxF "${target}" "${NETBIRD_BYPASS_FILE}" 2>/dev/null || echo "${target}" >>"${NETBIRD_BYPASS_FILE}"
    done <<<"${targets}"
    if [[ -s "${NETBIRD_BYPASS_FILE}" ]] && netbird_api_ok "${url}"; then
      log "NetBird-API (${host}) über den Ausgang nicht erreichbar – Verbindung dorthin läuft jetzt am Ausgang vorbei"
      echo 0 >"${NETBIRD_API_FAIL_FILE}"
      rm -f "${NETBIRD_API_SENT}"
      event container netbird:api fixed "NetBird-Verbindung repariert" "Das Panel kam über den NetBird-Ausgang nicht zum NetBird-Server (${host}). Der Wächter lässt jetzt nur diese eine Verbindung direkt laufen – Spieler, Downloads und Mails gehen weiter über den Ausgang, dein Hausanschluss bleibt versteckt."
      return 0
    fi
  fi
  log "NetBird-API (${host}) seit ${failures} Prüfungen nicht erreichbar"
  if [[ ! -f "${NETBIRD_API_SENT}" ]]; then
    touch "${NETBIRD_API_SENT}"
    event container netbird:api action "NetBird-API nicht erreichbar" "Das Panel erreicht den NetBird-Server (${host}) seit ${failures} Minuten nicht. Server-Adressen und die Hausanschluss-Prüfung lassen sich so lange nicht ändern – die Spieler merken davon nichts." \
      "Prüf auf dem NetBird-Server, ob NetBird läuft:" "docker ps"
  fi
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
    keep_netbird_api
  else
    fix_dns
  fi
  keep_docker
  keep_panel
  keep_disk
}

status() {
  printf 'DNS:      %s (eingetragen: %s)\n' "$(dns_ok && echo ok || echo kaputt)" "$(resolv_servers)"
  printf 'Internet: %s\n' "$(web_ok && echo ok || echo weg)"
  local api
  api="$(netbird_api_url)"
  [[ -n "${api}" ]] && printf 'NetBird-API: %s (%s)\n' "$(netbird_api_ok "${api}" && echo ok || echo 'nicht erreichbar')" "$(url_host "${api}")"
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
  netbird-api)
    [[ ${EUID} -eq 0 || -n "${MH_GUARD_STATE_DIR:-}" ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
    keep_netbird_api
    ;;
  dns)
    # Ohne root nur mit eigener Datei (Tests).
    [[ ${EUID} -eq 0 || -n "${MH_RESOLV_CONF:-}" ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
    fix_dns
    ;;
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
