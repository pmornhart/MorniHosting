import { z } from 'zod';

/**
 * Voucher codes on the order page. Servers are free – except with "MORNI": then the person pays the panel's
 * owner 9.999,99 € a month. The panel only keeps track of who owes what and which months are paid; no money
 * moves through it.
 */
export const COUPONS: Readonly<Record<string, { readonly monthlyCents: number }>> = {
  MORNI: { monthlyCents: 999_999 },
};
const COUPON_MAX = 32;
export const couponSchema = z.string().trim().max(COUPON_MAX);

/** "morni" → the MORNI voucher (case does not matter); null for unknown codes. */
export function couponOf(code: string | null | undefined): { code: string; monthlyCents: number } | null {
  const key = (code ?? '').trim().toUpperCase();
  const found = COUPONS[key];
  return found ? { code: key, ...found } : null;
}

/** 999999 → "9.999,99 €" (de) or "€9,999.99" (en). */
export function formatEuro(cents: number, locale = 'de-DE'): string {
  const CENTS = 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / CENTS);
}

export interface CouponCheck {
  readonly code: string;
  readonly monthlyCents: number;
  /** Who gets the money: the panel's first admin. */
  readonly payee: string;
}

export interface ChargeMonth {
  /** "2026-11" */
  readonly month: string;
  readonly paidAt: string | null;
}

export interface ChargeView {
  readonly id: number;
  readonly serverId: string;
  readonly serverName: string;
  readonly userId: number | null;
  readonly userName: string;
  readonly code: string;
  readonly monthlyCents: number;
  readonly startedAt: string;
  /** Set when the server was deleted; later months are not owed. */
  readonly endedAt: string | null;
  /** Every month from the start until now (or the end), newest first. */
  readonly months: readonly ChargeMonth[];
  readonly openCents: number;
}

export interface PaymentsView {
  readonly charges: readonly ChargeView[];
  readonly openCents: number;
  readonly paidCents: number;
}

// A month like "2026-11"; months are counted from the order date. Matches "2026-11"; rejects "2026-13", "26-11".
// https://regex101.com/?flavor=javascript&regex=%5E%5Cd%7B4%7D-(0%5B1-9%5D%7C1%5B0-2%5D)%24&testString=2026-11%0A2026-13%0A26-11
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthSchema = z.string().regex(MONTH);
export const markPaidSchema = z.object({ month: monthSchema, paid: z.boolean() });
