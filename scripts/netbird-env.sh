#!/usr/bin/env bash
# Trägt die Adresse des NetBird-Servers, mit dem dieser Rechner verbunden ist, als MH_NETBIRD_API in die .env ein.
# Das Panel nimmt sie als Vorgabe für die NetBird-Automatik – wichtig, wenn du NetBird selbst betreibst.
# Ohne NetBird passiert nichts. Wird von install.sh, update.sh und dem Proxmox-Skript aufgerufen.
# Ein anderes Produkt, das MorniHosting als Motor einbaut (morni.net), nennt seine .env mit MH_ENV_FILE.
#
# Verfasst mit Claude 🤖

set -Eeuo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
ENV_FILE="${MH_ENV_FILE:-.env}"

command -v netbird >/dev/null 2>&1 || exit 0
[[ -f "${ENV_FILE}" ]] || exit 0

# Aus `netbird status --json` den Teil "management":{"url":"https://api.netbird.io:443","connected":true,…}
URL="$(netbird status --json 2>/dev/null | tr -d '\n' | grep -o '"management": *{[^}]*}' |
  grep -o '"url": *"[^"]*"' | cut -d'"' -f4 || true)"
[[ "${URL}" == https://* ]] || exit 0

# Nur Rechnername und Port. Die API liegt auf Port 443, auch wenn der Client über den alten Port 33073 spricht.
HOST="${URL#https://}"
HOST="${HOST%%/*}"
HOST="${HOST%:443}"
HOST="${HOST%:33073}"
# Erlaubt: "netbird.example.de", "api.netbird.io", "nb.example.de:8443"; alles andere wird ignoriert.
[[ "${HOST}" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || exit 0
API="https://${HOST}"

if grep -q '^MH_NETBIRD_API=' "${ENV_FILE}"; then
  sed -i "s|^MH_NETBIRD_API=.*|MH_NETBIRD_API=${API}|" "${ENV_FILE}"
else
  printf '\n# NetBird-Server dieses Rechners (übernimmt jedes Update aus „netbird status“)\nMH_NETBIRD_API=%s\n' \
    "${API}" >>"${ENV_FILE}"
fi
echo "${API}"
