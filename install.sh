#!/usr/bin/env bash
# MorniHosting – Installation auf Debian/Ubuntu (auch im Proxmox-LXC oder in einer VM).
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/install.sh)"
#
# Was passiert: Docker wird installiert (falls nötig), das Panel landet in /opt/mornihosting,
# eine .env mit zufälligem Geheimnis wird angelegt, das Panel startet, und der Host-Updater
# wird eingerichtet (Update-Knopf im Panel, Befehl `update` auf der Konsole).
#
# Verfasst mit Claude 🤖

set -Eeuo pipefail

INSTALL_DIR="${MH_INSTALL_DIR:-/opt/mornihosting}"
REPO_URL="${MH_REPO_URL:-https://github.com/pmornhart/MorniHosting.git}"
BRANCH="${MH_BRANCH:-main}"
VOLUME_NAME="mornihosting-data"
PANEL_UID=1000

GN=$'\e[32m'
YW=$'\e[33m'
RD=$'\e[31m'
BL=$'\e[36m'
CL=$'\e[0m'

msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1" >&2; }

trap 'msg_error "Abgebrochen in Zeile ${LINENO}. Details stehen oben."' ERR

if [[ "${EUID}" -ne 0 ]]; then
  msg_error "Bitte als root starten (z. B. mit sudo)."
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  msg_error "Dieses Skript ist für Debian und Ubuntu. Auf anderen Systemen: siehe README (Docker Compose)."
  exit 1
fi

printf '\n %sMorniHosting%s – Minecraft-Server einfach selbst hosten\n\n' "${BL}" "${CL}"

msg_info "Pakete werden installiert"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates openssl >/dev/null
msg_ok "Pakete installiert"

if ! command -v docker >/dev/null 2>&1; then
  msg_info "Docker wird installiert (offizielles Skript von get.docker.com)"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  msg_ok "Docker installiert"
else
  msg_ok "Docker ist schon da"
fi
if ! docker compose version >/dev/null 2>&1; then
  msg_info "Docker-Compose-Plugin wird installiert"
  apt-get install -y -qq docker-compose-plugin >/dev/null
  msg_ok "Docker Compose installiert"
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  msg_info "Vorhandene Installation wird aktualisiert"
  git -C "${INSTALL_DIR}" pull --ff-only --quiet
else
  msg_info "MorniHosting wird nach ${INSTALL_DIR} geladen"
  git clone --quiet --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
fi
msg_ok "Dateien liegen in ${INSTALL_DIR}"
cd "${INSTALL_DIR}"

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ ! -f .env ]]; then
  msg_info "Einstellungen (.env) werden angelegt"
  TIMEZONE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  cp .env.example .env
  sed -i "s|^MH_SECRET=.*|MH_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^MH_LAN_IP=.*|MH_LAN_IP=${LAN_IP}|" .env
  sed -i "s|^TZ=.*|TZ=${TIMEZONE:-Europe/Berlin}|" .env
  chmod 600 .env
  msg_ok ".env angelegt (mit zufälligem Geheimnis)"
else
  msg_ok ".env ist schon da und bleibt unverändert"
fi
if NB_API="$(bash scripts/netbird-env.sh)" && [[ -n "${NB_API}" ]]; then
  msg_ok "NetBird-Server dieses Rechners: ${NB_API}"
fi

msg_info "Panel wird gestartet (das erste Mal dauert es etwas)"
# Gebaut wird aus dem geladenen Code (main), damit Updates genau diesem Stand folgen. Ein fertiges Image
# (ghcr.io) nur, wenn in der .env ausdrücklich MH_IMAGE_TAG steht.
if grep -q '^MH_IMAGE_TAG=' .env; then
  docker compose pull --quiet panel
  docker compose up -d --quiet-pull >/dev/null
else
  MH_BUILD_VERSION="$(git describe --tags --always 2>/dev/null || echo dev)" docker compose up -d --build >/dev/null
  # Hytale hat kein offizielles Image: das kleine Rezept aus images/hytale wird mitgebaut.
  docker build --quiet -t ghcr.io/pmornhart/mornihosting-hytale:latest images/hytale >/dev/null || true
fi
msg_ok "Panel läuft"

msg_info "Host-Updater wird eingerichtet"
VOLUME_DIR="$(docker volume inspect -f '{{ .Mountpoint }}' "${VOLUME_NAME}")"
mkdir -p "${VOLUME_DIR}/update"
printf '{"installedAt":"%s","installDir":"%s"}\n' "$(date -Iseconds)" "${INSTALL_DIR}" >"${VOLUME_DIR}/update/agent.json"
chown -R "${PANEL_UID}:${PANEL_UID}" "${VOLUME_DIR}/update"

cat >/etc/systemd/system/mornihosting-update.path <<UNIT
[Unit]
Description=MorniHosting: Update starten, wenn das Panel darum bittet

[Path]
PathExists=${VOLUME_DIR}/update/request.json
Unit=mornihosting-update.service

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/mornihosting-update.service <<UNIT
[Unit]
Description=MorniHosting aktualisieren
After=docker.service

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/update.sh --from-panel
UNIT

systemctl daemon-reload
systemctl enable --now mornihosting-update.path >/dev/null 2>&1
chmod +x "${INSTALL_DIR}/update.sh"
if [[ ! -e /usr/bin/update || -L /usr/bin/update ]]; then
  ln -sf "${INSTALL_DIR}/update.sh" /usr/bin/update
fi
msg_ok "Updates per Knopf im Panel oder mit dem Befehl: update"

# DDoS-Schutz: Das Panel schreibt nur an/aus, die Firewall-Regeln setzt scripts/ddos-guard.sh als root.
msg_info "DDoS-Schutz wird eingerichtet (eingeschaltet wird er im Panel)"
chmod +x "${INSTALL_DIR}/scripts/ddos-guard.sh"
"${INSTALL_DIR}/scripts/ddos-guard.sh" install >/dev/null
msg_ok "DDoS-Schutz bereit: Admin-Bereich → DDoS-Schutz"

# NetBird-Wächter: prüft jede Minute NetBird, DNS und Internet und repariert selbst (nur mit NetBird).
if command -v netbird >/dev/null 2>&1; then
  chmod +x "${INSTALL_DIR}/scripts/netbird-watchdog.sh"
  "${INSTALL_DIR}/scripts/netbird-watchdog.sh" install >/dev/null && msg_ok "NetBird-Wächter läuft"
fi

PORT="$(grep -E '^MH_PANEL_PORT=' .env | cut -d= -f2)"
printf '\n %s🎉 Fertig!%s Öffne im Browser: %shttp://%s:%s%s\n' "${GN}" "${CL}" "${BL}" "${LAN_IP:-<IP>}" "${PORT:-8080}" "${CL}"
printf '    Der Einrichtungs-Assistent führt dich durch die ersten Schritte.\n\n'
