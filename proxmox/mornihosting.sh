#!/usr/bin/env bash
# MorniHosting – Proxmox-Quick-Start (Stil der community-scripts.org).
# Auf dem Proxmox-Host in der Shell ausführen:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/proxmox/mornihosting.sh)"
#
# Legt einen Debian-12-LXC-Container an (unprivilegiert, Nesting für Docker, Netzwerk-Gerät für
# NetBird), installiert darin MorniHosting mit install.sh und zeigt am Ende die Adresse des Panels.
# Alle Werte lassen sich vorher per Umgebungsvariable setzen, z. B. RAM=12288 CORES=6.
# Mit NETBIRD_SETUP_KEY=… wird der Container gleich in dein NetBird-Netz aufgenommen.
#
# Verfasst mit Claude 🤖

set -Eeuo pipefail

APP="MorniHosting"
INSTALL_URL="${MH_INSTALL_URL:-https://raw.githubusercontent.com/pmornhart/MorniHosting/main/install.sh}"

GN=$'\e[32m'
YW=$'\e[33m'
RD=$'\e[31m'
BL=$'\e[36m'
CL=$'\e[0m'

msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1" >&2; }

trap 'msg_error "Abgebrochen in Zeile ${LINENO}."' ERR

if ! command -v pct >/dev/null 2>&1 || ! command -v pveversion >/dev/null 2>&1; then
  msg_error "Dieses Skript läuft nur auf einem Proxmox-VE-Host."
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  msg_error "Bitte als root starten."
  exit 1
fi

default_storage() {
  pvesm status -content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1; exit }'
}

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-mornihosting}"
CORES="${CORES:-4}"
RAM="${RAM:-8192}"
DISK="${DISK:-100}"
STORAGE="${STORAGE:-$(default_storage)}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
NETBIRD_SETUP_KEY="${NETBIRD_SETUP_KEY:-}"
NETBIRD_INSTALL_URL="https://pkgs.netbird.io/install.sh"

ask() {
  local title="$1" text="$2" value="$3"
  if command -v whiptail >/dev/null 2>&1; then
    whiptail --backtitle "${APP}" --title "${title}" --inputbox "${text}" 10 64 "${value}" 3>&1 1>&2 2>&3
  else
    read -r -p " ${text} [${value}]: " answer
    printf '%s' "${answer:-${value}}"
  fi
}

printf '\n %s%s%s – Minecraft-Server-Panel als Proxmox-Container\n\n' "${BL}" "${APP}" "${CL}"
SUMMARY="Container-ID: ${CTID}\nName: ${CT_HOSTNAME}\nCPU-Kerne: ${CORES}\nRAM: ${RAM} MB\nFestplatte: ${DISK} GB auf ${STORAGE}\nNetz: ${BRIDGE} (DHCP)"
if command -v whiptail >/dev/null 2>&1; then
  if ! whiptail --backtitle "${APP}" --title "Einstellungen" --yesno \
    "Mit diesen Werten anlegen?\n\n${SUMMARY}\n\nMit Nein kannst du die Werte ändern." 18 64; then
    CTID="$(ask "Container-ID" "Freie Container-ID" "${CTID}")"
    CT_HOSTNAME="$(ask "Name" "Hostname des Containers" "${CT_HOSTNAME}")"
    CORES="$(ask "CPU" "CPU-Kerne" "${CORES}")"
    RAM="$(ask "Arbeitsspeicher" "RAM in MB (Panel + alle Minecraft-Server)" "${RAM}")"
    DISK="$(ask "Festplatte" "Größe in GB (Welten und Backups)" "${DISK}")"
    STORAGE="$(ask "Speicher" "Proxmox-Speicher für den Container" "${STORAGE}")"
    BRIDGE="$(ask "Netzwerk" "Netzwerk-Bridge" "${BRIDGE}")"
  fi
else
  printf "%b\n\n" "${SUMMARY}"
fi

if [[ -z "${NETBIRD_SETUP_KEY}" ]] && command -v whiptail >/dev/null 2>&1; then
  if whiptail --backtitle "${APP}" --title "NetBird" --defaultno --yesno \
    "NetBird gleich mit einrichten?\n\nDann erreichst du das Panel und deine Minecraft-Server über deine eigene Domain, ohne Portfreigabe im Router.\n\nDu brauchst dafür einen Setup-Key aus dem NetBird-Dashboard (Setup Keys → Create Setup Key). Das geht auch später." 16 70; then
    NETBIRD_SETUP_KEY="$(whiptail --backtitle "${APP}" --title "NetBird" --passwordbox \
      "Setup-Key aus dem NetBird-Dashboard:" 10 70 3>&1 1>&2 2>&3 || true)"
  fi
fi

if [[ -z "${STORAGE}" ]]; then
  msg_error "Kein Speicher für Container gefunden. Setze STORAGE=… und starte neu."
  exit 1
fi

msg_info "Debian-12-Vorlage wird gesucht"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ { print $2 }' | sort -V | tail -n 1)"
if [[ -z "${TEMPLATE}" ]]; then
  msg_error "Keine Debian-12-Vorlage gefunden."
  exit 1
fi
if ! pveam list "${TEMPLATE_STORAGE}" | grep -q "${TEMPLATE}"; then
  pveam download "${TEMPLATE_STORAGE}" "${TEMPLATE}" >/dev/null
fi
msg_ok "Vorlage ${TEMPLATE}"

msg_info "Container ${CTID} wird angelegt"
pct create "${CTID}" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "${CT_HOSTNAME}" \
  --cores "${CORES}" \
  --memory "${RAM}" \
  --swap 1024 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --tags "minecraft;mornihosting" \
  --description "MorniHosting – Minecraft-Server-Panel. Update im Container: update" >/dev/null
# Netzwerk-Gerät (TUN) für NetBird oder andere VPNs im Container, damit es später ohne Umbau geht.
modprobe tun 2>/dev/null || true
if [[ -c /dev/net/tun ]]; then
  cat >>"/etc/pve/lxc/${CTID}.conf" <<'CONF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
CONF
fi
# Firewall-Module für den DDoS-Schutz: Ein LXC teilt den Kernel des Hosts und kann sie nicht selbst laden.
DDOS_MODULES=(xt_hashlimit xt_connlimit xt_conntrack xt_comment)
modprobe -a "${DDOS_MODULES[@]}" 2>/dev/null || true
printf '%s\n' "# MorniHosting DDoS-Schutz" "${DDOS_MODULES[@]}" >/etc/modules-load.d/mornihosting-ddos.conf
pct start "${CTID}"
msg_ok "Container ${CTID} läuft"

msg_info "Warte auf das Netzwerk"
IP=""
for _ in $(seq 1 60); do
  IP="$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "${IP}" ]] && pct exec "${CTID}" -- getent hosts github.com >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if [[ -z "${IP}" ]]; then
  msg_error "Der Container hat keine IP bekommen. Prüfe DHCP auf ${BRIDGE}."
  exit 1
fi
msg_ok "Container-IP: ${IP}"

msg_info "MorniHosting wird im Container installiert (ein paar Minuten)"
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y -qq curl >/dev/null && bash -c \"\$(curl -fsSL ${INSTALL_URL})\""
msg_ok "Installation abgeschlossen"

NETBIRD_OK=""
if [[ -n "${NETBIRD_SETUP_KEY}" ]]; then
  msg_info "NetBird wird im Container eingerichtet"
  if pct exec "${CTID}" -- bash -c "curl -fsSL ${NETBIRD_INSTALL_URL} | sh" >/dev/null 2>&1 &&
    pct exec "${CTID}" -- netbird up --setup-key "${NETBIRD_SETUP_KEY}" >/dev/null 2>&1; then
    NETBIRD_OK="yes"
    # Das Panel merkt sich, mit welchem NetBird-Server der Container verbunden ist (Cloud oder selbst betrieben).
    pct exec "${CTID}" -- bash -c "cd /opt/mornihosting && bash scripts/netbird-env.sh >/dev/null && docker compose up -d >/dev/null" || true
    pct exec "${CTID}" -- bash /opt/mornihosting/scripts/netbird-watchdog.sh install >/dev/null 2>&1 || true
    msg_ok "NetBird verbunden – im NetBird-Dashboard heißt dieser Rechner ${CT_HOSTNAME}"
  else
    msg_error "NetBird ließ sich nicht einrichten. Später im Container: netbird up --setup-key <KEY>"
  fi
fi

printf '\n %s🎉 %s ist bereit:%s %shttp://%s:8080%s\n' "${GN}" "${APP}" "${CL}" "${BL}" "${IP}" "${CL}"
printf '    Update später im Container: %spct enter %s%s und dann %supdate%s\n' "${YW}" "${CTID}" "${CL}" "${YW}" "${CL}"
if [[ -n "${NETBIRD_OK}" ]]; then
  printf '    Eigene Domain: im Panel %sAdmin-Bereich → Domain → Reiter „NetBird“%s\n' "${YW}" "${CL}"
fi
printf '\n'
