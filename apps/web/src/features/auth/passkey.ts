import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { LoginResponse, PasskeyEntry, SystemStatus } from '@mornihosting/shared';
import { api } from '@/lib/api';

const HTTPS = 'https:';

/** Passkeys need WebAuthn and a secure page (HTTPS or localhost). */
function passkeysInBrowser(): boolean {
  return window.isSecureContext && browserSupportsWebAuthn();
}

/**
 * The page is the panel domain over HTTPS. Passkeys work here even when a proxy (NetBird without
 * "Pass Host Header") hides the address from the panel: the ceremony goes by the browser's origin.
 */
function onPanelDomain(status: SystemStatus): boolean {
  return status.panelDomain === window.location.hostname && window.location.protocol === HTTPS;
}

/** Whether this page can add and use passkeys. */
export function passkeysUsable(status: SystemStatus): boolean {
  return (status.passkeys === 'ok' || onPanelDomain(status)) && passkeysInBrowser();
}

/** HTTPS page, but no panel domain entered yet: once this address is entered, passkeys work here. */
export function panelDomainMissing(status: SystemStatus): boolean {
  return !status.panelDomain && status.passkeys !== 'ok' && window.location.protocol === HTTPS;
}

export async function signInWithPasskey(): Promise<LoginResponse> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/options', {
    method: 'POST',
  });
  const response = await startAuthentication({ optionsJSON });
  return api<LoginResponse>('/api/auth/passkey/login', { method: 'POST', body: { response } });
}

export async function addPasskey(name: string): Promise<PasskeyEntry[]> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('/api/account/passkeys/options', {
    method: 'POST',
  });
  const response = await startRegistration({ optionsJSON });
  return api<PasskeyEntry[]>('/api/account/passkeys', { method: 'POST', body: { name, response } });
}

const DEVICE_HINTS: readonly (readonly [string, string])[] = [
  ['iPhone', 'iPhone'],
  ['iPad', 'iPad'],
  ['Android', 'Android'],
  ['Macintosh', 'Mac'],
  ['Windows', 'Windows'],
  ['Linux', 'Linux'],
];

/** A friendly default name for a new passkey, from the browser's description of the device. */
export function deviceName(userAgent: string = navigator.userAgent): string | null {
  return DEVICE_HINTS.find(([needle]) => userAgent.includes(needle))?.[1] ?? null;
}
