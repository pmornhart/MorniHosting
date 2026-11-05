#!/usr/bin/env bash
# MorniHosting aktualisieren: neuen Code holen, neues Image laden (oder bauen), Panel neu starten.
# Die Minecraft-Server laufen dabei weiter; sie sind eigene Container.
#
#   update                              (nach install.sh, z. B. im Proxmox-Container)
#   sudo /opt/mornihosting/update.sh    (gleiche Wirkung)
#
# Der Update-Knopf im Panel legt die Datei update/request.json in den Datenordner;
# die systemd-Einheit mornihosting-update.path startet dann dieses Skript.
#
# Verfasst mit Claude 🤖

set -Eeuo pipefail

INSTALL_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
VOLUME_NAME="mornihosting-data"
PANEL_UID=1000

GN=$'\e[32m'
YW=$'\e[33m'
RD=$'\e[31m'
CL=$'\e[0m'

msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
  msg_error "Bitte als root starten (z. B. mit sudo)."
  exit 1
fi

VOLUME_DIR="$(docker volume inspect -f '{{ .Mountpoint }}' "${VOLUME_NAME}" 2>/dev/null || true)"
STATUS_FILE="${VOLUME_DIR:+${VOLUME_DIR}/update/status.json}"
LOG_FILE="${VOLUME_DIR:+${VOLUME_DIR}/update/log.txt}"
STEP="null"

# Für das Panel: Zustand (running/done/failed) und Schritt (pull/build/restart) in status.json.
write_status() {
  [[ -n "${STATUS_FILE}" ]] || return 0
  mkdir -p "$(dirname "${STATUS_FILE}")"
  printf '{"state":"%s","step":%s,"at":"%s"}\n' "$1" "${STEP}" "$(date -Iseconds)" >"${STATUS_FILE}"
  chown "${PANEL_UID}:${PANEL_UID}" "${STATUS_FILE}" 2>/dev/null || true
}
step() {
  STEP="\"$1\""
  write_status "running"
}

# Alles, was das Skript ausgibt, landet auch in log.txt – das Panel zeigt die letzten Zeilen an.
# Nach dem Neustart mit der neuen Fassung (MH_UPDATE_PULLED) läuft die Umleitung schon.
if [[ -n "${LOG_FILE}" && -z "${MH_UPDATE_PULLED:-}" ]]; then
  mkdir -p "$(dirname "${LOG_FILE}")"
  : >"${LOG_FILE}"
  chown "${PANEL_UID}:${PANEL_UID}" "${LOG_FILE}" 2>/dev/null || true
  exec > >(tee -a "${LOG_FILE}") 2>&1
fi

# Erst "läuft" melden, dann die Anfrage wegnehmen: Solange sie da ist, startet systemd das Skript immer wieder.
step "pull"
if [[ -n "${VOLUME_DIR}" ]]; then
  rm -f "${VOLUME_DIR}/update/request.json"
fi

trap 'write_status "failed"; msg_error "Update fehlgeschlagen in Zeile ${LINENO}. Das Panel läuft in der alten Version weiter."' ERR
cd "${INSTALL_DIR}"

if [[ -d .git && -z "${MH_UPDATE_PULLED:-}" ]]; then
  msg_info "Neuer Code wird geholt"
  git pull --ff-only --quiet
  msg_ok "Code aktuell ($(git describe --tags --always 2>/dev/null || echo dev))"
  # Weiter mit der eben geholten Fassung dieses Skripts, damit neue Schritte schon bei diesem Update laufen.
  MH_UPDATE_PULLED=1 exec bash "${INSTALL_DIR}/update.sh" "$@"
fi

if NB_API="$(bash scripts/netbird-env.sh)" && [[ -n "${NB_API}" ]]; then
  msg_ok "NetBird-Server dieses Rechners: ${NB_API}"
fi

# Solange das Update läuft, lässt der Wächter (scripts/guard.sh) das Panel in Ruhe – sonst starten beide es
# gleichzeitig neu und Docker meldet „container name … is already in use“.
UPDATE_LOCK="/run/mornihosting-update.lock"
touch "${UPDATE_LOCK}" 2>/dev/null || true
trap 'rm -f "${UPDATE_LOCK}"' EXIT

# Reste eines abgebrochenen Neustarts ("7d63457cd4e6_mornihosting") weg, damit Compose neu anlegen kann.
remove_leftovers() {
  docker ps -a --format '{{.Names}}' | grep -E '^[0-9a-f]{12}_mornihosting(-[a-z-]+)?$' | xargs -r docker rm -f >/dev/null 2>&1 || true
}

step "build"
# Das Panel folgt dem Stand von main: gebaut wird aus genau dem eben geholten Code. Ein fertiges Image
# (ghcr.io) nur, wenn in der .env ausdrücklich MH_IMAGE_TAG steht.
if grep -q '^MH_IMAGE_TAG=' .env 2>/dev/null; then
  msg_info "Neues Panel-Image wird geladen"
  docker compose pull --quiet panel
  step "restart"
  remove_leftovers
  docker compose up -d --quiet-pull >/dev/null || { remove_leftovers; docker compose up -d --quiet-pull >/dev/null; }
else
  msg_info "Neues Panel wird gebaut (dauert ein paar Minuten)"
  MH_BUILD_VERSION="$(git describe --tags --always 2>/dev/null || echo dev)" docker compose build --quiet panel
  # Hytale hat kein offizielles Image: das kleine Rezept aus images/hytale wird mitgebaut (Fehler stören das Update nicht).
  docker build --quiet -t ghcr.io/pmornhart/mornihosting-hytale:latest images/hytale >/dev/null || msg_info "Hytale-Image konnte nicht gebaut werden"
  msg_ok "Panel gebaut"
  step "restart"
  msg_info "Panel wird neu gestartet"
  remove_leftovers
  docker compose up -d >/dev/null || { remove_leftovers; docker compose up -d >/dev/null; }
fi
msg_ok "Panel neu gestartet"

# Reste aufräumen: alte Image-Versionen und der Build-Cache (sonst wächst er mit jedem Update um mehrere GB).
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true

# Neue oder geänderte systemd-Einheiten (DDoS-Schutz) mit einrichten; ein Fehler hier stoppt das Update nicht.
if [[ -f scripts/ddos-guard.sh ]]; then
  chmod +x scripts/ddos-guard.sh
  if scripts/ddos-guard.sh install >/dev/null; then
    msg_ok "DDoS-Schutz eingerichtet"
  else
    msg_error "DDoS-Schutz ließ sich nicht einrichten (Details: sudo ${INSTALL_DIR}/scripts/ddos-guard.sh install)"
  fi
fi
# MorniHosting-Wächter: prüft jede Minute NetBird, DNS, Docker, Panel und Platz und repariert selbst.
if [[ -f scripts/guard.sh ]]; then
  chmod +x scripts/guard.sh
  if scripts/guard.sh install >/dev/null; then
    msg_ok "Wächter eingerichtet (prüft jede Minute)"
  else
    msg_error "Wächter ließ sich nicht einrichten (Details: sudo ${INSTALL_DIR}/scripts/guard.sh install)"
  fi
fi
STEP="null"
write_status "done"
msg_ok "Fertig. Deine Minecraft-Server sind die ganze Zeit weitergelaufen."
