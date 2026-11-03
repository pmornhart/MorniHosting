#!/usr/bin/env bash
# Gibt auf einem selbst betriebenen NetBird-Server die Ports für Minecraft frei, einmal ausführen:
#
#   curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-proxy-ports.sh | sudo bash
#
# Der netbird-proxy lässt von sich aus nur Port 443 durch. Das Skript findet den Container, legt neben seiner
# docker-compose.yml eine Ergänzung mit den Port-Bereichen an (die Datei selbst bleibt unverändert), öffnet die
# Ports in ufw oder firewalld, falls aktiv, und startet nur den Proxy neu.
# Andere Bereiche: MC_TCP=25565-25600 MC_UDP=19132-19150 MC_VOICE=24454-24470 … | sudo -E bash
#
# Verfasst mit Claude 🤖

set -Eeuo pipefail

MC_TCP="${MC_TCP:-25565-25575}"
MC_UDP="${MC_UDP:-19132-19140}"
MC_VOICE="${MC_VOICE:-24454-24460}"
MARKER="# Von MorniHosting angelegt"

GN=$'\e[32m'
YW=$'\e[33m'
RD=$'\e[31m'
CL=$'\e[0m'
msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1" >&2; }

[[ "${EUID}" -eq 0 ]] || {
  msg_error "Bitte als root starten (… | sudo bash)."
  exit 1
}
# Erlaubt: "25565" oder "25565-25575"
for range in "${MC_TCP}" "${MC_UDP}" "${MC_VOICE}"; do
  [[ "${range}" =~ ^[0-9]{1,5}(-[0-9]{1,5})?$ ]] || {
    msg_error "Ungültiger Port-Bereich: ${range}"
    exit 1
  }
done
command -v docker >/dev/null || {
  msg_error "Docker fehlt – läuft hier wirklich dein NetBird-Server?"
  exit 1
}

msg_info "Suche den NetBird-Proxy"
CONTAINER="$(docker ps -a --filter 'name=^netbird-proxy$' --format '{{.Names}}' | head -1)"
[[ -n "${CONTAINER}" ]] ||
  CONTAINER="$(docker ps -a --filter 'ancestor=netbirdio/reverse-proxy' --format '{{.Names}}' | head -1)"
[[ -n "${CONTAINER}" ]] || {
  msg_error "Kein netbird-proxy gefunden. Ist der Reverse Proxy in NetBird eingerichtet?"
  exit 1
}
label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "${CONTAINER}" 2>/dev/null || true; }
DIR="$(label com.docker.compose.project.working_dir)"
FILES="$(label com.docker.compose.project.config_files)"
SERVICE="$(label com.docker.compose.service)"
PROJECT="$(label com.docker.compose.project)"
[[ -n "${DIR}" && -n "${FILES}" && -n "${SERVICE}" ]] || {
  msg_error "${CONTAINER} wurde nicht mit Docker Compose gestartet – Ports bitte von Hand freigeben."
  exit 1
}
msg_ok "Gefunden: ${CONTAINER} (Dienst ${SERVICE} in ${DIR})"

if [[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "${CONTAINER}")" == "host" ]]; then
  msg_ok "Der Proxy läuft im Host-Netz – in Docker ist nichts freizugeben"
else
  OVERRIDE="${DIR}/mornihosting-ports.yml"
  if [[ -f "${OVERRIDE}" ]] && ! grep -q "^${MARKER}" "${OVERRIDE}"; then
    msg_error "${OVERRIDE} gibt es schon und stammt nicht von MorniHosting – bitte prüfen."
    exit 1
  fi
  cat >"${OVERRIDE}" <<YAML
${MARKER}: Minecraft-Ports für den NetBird-Proxy (scripts/netbird-proxy-ports.sh).
services:
  ${SERVICE}:
    ports:
      - "${MC_TCP}:${MC_TCP}/tcp" # Java-Server
      - "${MC_UDP}:${MC_UDP}/udp" # Bedrock und Geyser
      - "${MC_UDP}:${MC_UDP}/tcp" # Geyser seit Bedrock 26.60 (NetherNet sucht den Server über TCP)
      - "${MC_VOICE}:${MC_VOICE}/udp" # Voice-Chat
YAML
  msg_ok "Ports eingetragen in ${OVERRIDE}"

  # Wie zuvor gestartet, plus die Ergänzung. Damit ein späteres „docker compose up“ sie nicht vergisst,
  # merkt sich COMPOSE_FILE in der .env des Projekts alle Dateien.
  IFS=',' read -r -a CONFIGS <<<"${FILES}"
  ARGS=()
  for f in "${CONFIGS[@]}" "${OVERRIDE}"; do ARGS+=(-f "${f}"); done
  ENV_FILE="${DIR}/.env"
  JOINED="$(printf '%s:' "${CONFIGS[@]}")${OVERRIDE}"
  if ! grep -q "mornihosting-ports.yml" "${ENV_FILE}" 2>/dev/null; then
    if grep -q '^COMPOSE_FILE=' "${ENV_FILE}" 2>/dev/null; then
      sed -i "s|^COMPOSE_FILE=\(.*\)|COMPOSE_FILE=\1:${OVERRIDE}|" "${ENV_FILE}"
    else
      printf '\n%s\nCOMPOSE_FILE=%s\n' "${MARKER}: auch die Minecraft-Ports laden" "${JOINED}" >>"${ENV_FILE}"
    fi
  fi

  msg_info "Starte nur den Proxy neu (NetBird selbst läuft weiter)"
  if ! OUT="$(cd "${DIR}" && docker compose -p "${PROJECT}" "${ARGS[@]}" up -d --no-deps "${SERVICE}" 2>&1)"; then
    printf '%s\n' "${OUT}" >&2
    msg_error "Der Proxy ließ sich nicht neu starten. Rückgängig: ${OVERRIDE} löschen und die COMPOSE_FILE-Zeile in ${ENV_FILE} entfernen."
    exit 1
  fi
  msg_ok "Proxy läuft mit den Minecraft-Ports"
fi

ufw_range() { echo "${1/-/:}"; }
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$(ufw_range "${MC_TCP}")/tcp" >/dev/null
  ufw allow "$(ufw_range "${MC_UDP}")/udp" >/dev/null
  ufw allow "$(ufw_range "${MC_UDP}")/tcp" >/dev/null
  ufw allow "$(ufw_range "${MC_VOICE}")/udp" >/dev/null
  msg_ok "ufw: Ports geöffnet"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-port="${MC_TCP}/tcp" --add-port="${MC_UDP}/udp" --add-port="${MC_UDP}/tcp" --add-port="${MC_VOICE}/udp"
  firewall-cmd -q --reload
  msg_ok "firewalld: Ports geöffnet"
else
  msg_ok "Keine aktive Firewall auf dem Server"
fi

printf '\n %s🎉 Fertig.%s TCP %s, TCP+UDP %s und UDP %s sind freigegeben.\n' "${GN}" "${CL}" "${MC_TCP}" "${MC_UDP}" "${MC_VOICE}"
printf '    Hat dein Anbieter eine eigene Firewall im Kundenmenü (z. B. IONOS, Hetzner), dort dieselben Ports öffnen.\n\n'
