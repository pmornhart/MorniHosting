#!/usr/bin/env bash
# MorniHosting: diesen Rechner (meist den NetBird-Server, z. B. einen VPS) zum NetBird-Ausgang machen.
# Einmal als root ausführen – danach hält er sich selbst am Laufen:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-exit-node.sh)"
#
# Was passiert:
#   • NetBird-Agent da und verbunden? Sonst installieren bzw. "netbird up" (Setup-Key wird bei Bedarf gefragt)
#   • Weiterleiten erlaubt (ip_forward, IPv4 + IPv6, bleibt nach Neustart)
#   • Firewall: Verkehr aus NetBird darf ins Internet (auch wenn Docker die FORWARD-Kette sperrt), mit NAT
#   • ufw: weitergeleiteter Verkehr erlaubt
#   • systemd-Timer prüft alle 2 Minuten, dass alles noch stimmt (z. B. nach Docker-Neustart oder Update)
#
# Befehle: (ohne) einrichten · check (läuft per Timer) · status · uninstall
set -euo pipefail

COMMAND="${1:-setup}"
SCRIPT_URL="https://raw.githubusercontent.com/pmornhart/MorniHosting/main/scripts/netbird-exit-node.sh"
INSTALLED="/usr/local/sbin/mornihosting-exit-node"
UNIT_DIR="/etc/systemd/system"
SYSCTL_FILE="/etc/sysctl.d/99-mornihosting-exit.conf"
LOG_FILE="/var/log/mornihosting-exit-node.log"
NETBIRD_INSTALL_URL="https://pkgs.netbird.io/install.sh"
UP_TIMEOUT_SECONDS=90
CHECK_TIMEOUT_SECONDS=10
RULE_TAG="mornihosting-exit"

GN=$'\033[1;92m'
RD=$'\033[01;31m'
YW=$'\033[33m'
CL=$'\033[m'
msg_ok() { printf ' %s✔%s %s\n' "${GN}" "${CL}" "$1"; }
msg_info() { printf ' %s…%s %s\n' "${YW}" "${CL}" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "${RD}" "${CL}" "$1"; }
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${LOG_FILE}"; }

need_root() {
  [[ ${EUID} -eq 0 ]] || {
    msg_error "Bitte als root ausführen (sudo -i)."
    exit 1
  }
}

netbird_connected() {
  local out
  out="$(timeout "${CHECK_TIMEOUT_SECONDS}" netbird status 2>/dev/null || true)"
  grep -q '^Management: Connected' <<<"${out}" && grep -q '^Signal: Connected' <<<"${out}"
}

# Alle NetBird-Schnittstellen (wt0, wt9 …) und ihre Netze ("10.99.0.0/16").
netbird_ifaces() { ip -o link show 2>/dev/null | awk -F': ' '{ print $2 }' | cut -d@ -f1 | grep -E '^wt[0-9]+$' || true; }
netbird_nets() {
  local iface
  for iface in $(netbird_ifaces); do
    ip -4 route show dev "${iface}" proto kernel 2>/dev/null | awk '{ print $1 }'
  done | sort -u
}

ensure_netbird() {
  if ! command -v netbird >/dev/null 2>&1; then
    msg_info "NetBird wird installiert"
    curl -fsSL "${NETBIRD_INSTALL_URL}" | sh >/dev/null 2>&1
  fi
  systemctl enable netbird >/dev/null 2>&1 || true
  systemctl start netbird >/dev/null 2>&1 || true
  netbird_connected && return 0
  timeout "${UP_TIMEOUT_SECONDS}" netbird up >/dev/null 2>&1 || true
  netbird_connected && return 0
  # Noch nie verbunden: Setup-Key und (selbst betrieben) Management-Adresse fragen.
  [[ -t 0 || -e /dev/tty ]] || return 1
  local key url
  key="${NETBIRD_SETUP_KEY:-}"
  url="${NETBIRD_MANAGEMENT_URL:-}"
  [[ -n "${key}" ]] || read -r -p " NetBird-Setup-Key (aus dem NetBird-Dashboard → Setup Keys): " key </dev/tty
  [[ -n "${url}" ]] || read -r -p " Eigener NetBird-Server? Adresse (leer = NetBird Cloud): " url </dev/tty
  local args=(up --setup-key "${key}")
  [[ -n "${url}" ]] && args+=(--management-url "${url}")
  timeout "${UP_TIMEOUT_SECONDS}" netbird "${args[@]}" >/dev/null 2>&1 || true
  netbird_connected
}

ensure_forwarding() {
  printf 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\n' >"${SYSCTL_FILE}"
  sysctl -q -w net.ipv4.ip_forward=1 >/dev/null
  sysctl -q -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1 || true
}

# Eine iptables-Regel nur einfügen, wenn es sie noch nicht gibt (erkennbar am Kommentar).
add_rule() {
  local table="$1" chain="$2"
  shift 2
  iptables -t "${table}" -C "${chain}" "$@" -m comment --comment "${RULE_TAG}" 2>/dev/null ||
    iptables -t "${table}" -I "${chain}" 1 "$@" -m comment --comment "${RULE_TAG}"
}

ensure_firewall() {
  command -v iptables >/dev/null 2>&1 || return 0
  local iface net
  # Docker setzt FORWARD oft auf DROP; DOCKER-USER wird vor Dockers Regeln geprüft.
  local chains=(FORWARD)
  iptables -n -L DOCKER-USER >/dev/null 2>&1 && chains+=(DOCKER-USER)
  for iface in $(netbird_ifaces); do
    for chain in "${chains[@]}"; do
      add_rule filter "${chain}" -i "${iface}" -j ACCEPT
      add_rule filter "${chain}" -o "${iface}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    done
  done
  for net in $(netbird_nets); do
    for iface in $(netbird_ifaces); do
      add_rule nat POSTROUTING -s "${net}" ! -o "${iface}" -j MASQUERADE
    done
  done
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw default allow routed >/dev/null 2>&1 || true
  fi
}

check() {
  ensure_forwarding
  if ! netbird_connected; then
    log "NetBird getrennt – verbinde neu"
    systemctl restart netbird >/dev/null 2>&1 || true
    sleep 3
    timeout "${UP_TIMEOUT_SECONDS}" netbird up >/dev/null 2>&1 || log "netbird up hat nicht geantwortet"
  fi
  ensure_firewall
}

install_units() {
  if [[ -f "${BASH_SOURCE[0]:-}" && "$(readlink -f "${BASH_SOURCE[0]}")" != "${INSTALLED}" ]]; then
    install -m 755 "${BASH_SOURCE[0]}" "${INSTALLED}"
  else
    curl -fsSL "${SCRIPT_URL}" -o "${INSTALLED}.new" && install -m 755 "${INSTALLED}.new" "${INSTALLED}"
    rm -f "${INSTALLED}.new"
  fi
  cat >"${UNIT_DIR}/mornihosting-exit-node.service" <<UNIT
[Unit]
Description=MorniHosting: NetBird-Ausgang am Laufen halten
After=network-online.target netbird.service docker.service

[Service]
Type=oneshot
ExecStart=${INSTALLED} check
UNIT
  cat >"${UNIT_DIR}/mornihosting-exit-node.timer" <<UNIT
[Unit]
Description=MorniHosting: NetBird-Ausgang alle 2 Minuten prüfen

[Timer]
OnBootSec=30s
OnUnitActiveSec=120s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now mornihosting-exit-node.timer >/dev/null
}

status() {
  printf ' NetBird:        %s\n' "$(netbird_connected && echo verbunden || echo getrennt)"
  printf ' Weiterleiten:   %s\n' "$([[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" == 1 ]] && echo an || echo aus)"
  printf ' Schnittstellen: %s\n' "$(netbird_ifaces | tr '\n' ' ')"
  printf ' Netze:          %s\n' "$(netbird_nets | tr '\n' ' ')"
  printf ' Regeln:         %s\n' "$(iptables-save 2>/dev/null | grep -c "${RULE_TAG}" || echo 0)"
  printf ' Wächter:        %s\n' "$(systemctl is-active mornihosting-exit-node.timer 2>/dev/null || echo aus)"
}

case "${COMMAND}" in
  setup)
    need_root
    printf '\n %sMorniHosting: NetBird-Ausgang einrichten%s\n\n' "${GN}" "${CL}"
    if ensure_netbird; then
      msg_ok "NetBird verbunden"
    else
      msg_error "NetBird ist nicht verbunden. Setup-Key prüfen und das Skript noch einmal starten."
      exit 1
    fi
    ensure_forwarding
    msg_ok "Weiterleiten eingeschaltet (bleibt nach Neustart)"
    ensure_firewall
    msg_ok "Firewall lässt NetBird-Verkehr ins Internet (mit NAT)"
    install_units
    msg_ok "Wächter prüft alle 2 Minuten"
    printf '\n'
    status
    printf '\n %sFertig.%s Im Panel: Admin → NetBird → „Hausanschluss verstecken“ → „Neu prüfen“.\n\n' "${GN}" "${CL}"
    ;;
  check)
    need_root
    check
    ;;
  status) status ;;
  uninstall)
    need_root
    systemctl disable --now mornihosting-exit-node.timer >/dev/null 2>&1 || true
    rm -f "${UNIT_DIR}/mornihosting-exit-node.service" "${UNIT_DIR}/mornihosting-exit-node.timer" "${INSTALLED}"
    systemctl daemon-reload
    iptables-save | grep -v "${RULE_TAG}" | iptables-restore 2>/dev/null || true
    msg_ok "Entfernt"
    ;;
  *)
    msg_error "Unbekannter Befehl: ${COMMAND} (ohne Befehl einrichten, check, status, uninstall)"
    exit 2
    ;;
esac
