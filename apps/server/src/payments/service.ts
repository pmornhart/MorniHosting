import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  couponOf,
  formatEuro,
  type ChargeView,
  type CouponCheck,
  type PaymentsView,
} from '@mornihosting/shared';
import type { AppContext } from '../context.js';
import { chargePayments, charges, servers, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import type { NotifyService } from '../notify/service.js';

/**
 * Servers ordered with a paid voucher ("MORNI"). The panel records who owes the owner how much a month and which
 * months the owner marked as paid. It does not take or move money.
 */

const MONTH_LENGTH = 7;
const MONTHS_PER_YEAR = 12;
const DISCORD_GOLD = 0xf5c542;

export interface PaymentsService {
  readonly check: (code: string) => CouponCheck;
  readonly view: () => PaymentsView;
  readonly mine: (userId: number) => PaymentsView;
  readonly mark: (chargeId: number, month: string, paid: boolean, by: string) => PaymentsView;
}

/** "2026-09" … "2026-11": every month from the first to the last, newest first. */
function monthsBetween(from: string, to: string): string[] {
  const [fromYear = 0, fromMonth = 1] = from.split('-').map(Number);
  const [toYear = 0, toMonth = 1] = to.split('-').map(Number);
  const count = (toYear - fromYear) * MONTHS_PER_YEAR + (toMonth - fromMonth) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const index = fromYear * MONTHS_PER_YEAR + (fromMonth - 1) + i;
    return `${Math.floor(index / MONTHS_PER_YEAR)}-${String((index % MONTHS_PER_YEAR) + 1).padStart(2, '0')}`;
  }).reverse();
}

export function createPaymentsService(ctx: AppContext, notify: NotifyService): PaymentsService {
  const { db } = ctx;

  const payee = (): string => {
    const owner = db.select().from(users).where(eq(users.isAdmin, true)).orderBy(asc(users.id)).get();
    return owner ? owner.displayName || owner.username : 'Admin';
  };

  const check: PaymentsService['check'] = (code) => {
    const coupon = couponOf(code);
    if (!coupon) throw notFound('coupon_unknown');
    return { ...coupon, payee: payee() };
  };

  const build = (rows: (typeof charges.$inferSelect)[]): PaymentsView => {
    const now = new Date().toISOString().slice(0, MONTH_LENGTH);
    const list: ChargeView[] = rows.map((c) => {
      const paid = new Map(
        db
          .select()
          .from(chargePayments)
          .where(eq(chargePayments.chargeId, c.id))
          .all()
          .map((p) => [p.month, p.paidAt]),
      );
      const last = c.endedAt ? c.endedAt.slice(0, MONTH_LENGTH) : now;
      const months = monthsBetween(c.startedAt.slice(0, MONTH_LENGTH), last).map((month) => ({
        month,
        paidAt: paid.get(month) ?? null,
      }));
      return {
        ...c,
        months,
        openCents: months.filter((m) => !m.paidAt).length * c.monthlyCents,
      };
    });
    const total = (pick: (c: ChargeView) => number) => list.reduce((sum, c) => sum + pick(c), 0);
    return {
      charges: list,
      openCents: total((c) => c.openCents),
      paidCents: total((c) => c.months.filter((m) => m.paidAt).length * c.monthlyCents),
    };
  };

  const view: PaymentsService['view'] = () =>
    build(db.select().from(charges).orderBy(asc(charges.startedAt)).all());
  const mine: PaymentsService['mine'] = (userId) =>
    build(db.select().from(charges).where(eq(charges.userId, userId)).orderBy(asc(charges.startedAt)).all());

  const mark: PaymentsService['mark'] = (chargeId, month, paid, by) => {
    const charge = db.select().from(charges).where(eq(charges.id, chargeId)).get();
    if (!charge) throw notFound('charge_unknown');
    const where = and(eq(chargePayments.chargeId, chargeId), eq(chargePayments.month, month));
    if (paid) db.insert(chargePayments).values({ chargeId, month, markedBy: by }).onConflictDoNothing().run();
    else db.delete(chargePayments).where(where).run();
    return view();
  };

  ctx.events.on('server.created', ({ serverId, userId, coupon }) => {
    const found = couponOf(coupon);
    if (!found) return;
    const server = db.select().from(servers).where(eq(servers.id, serverId)).get();
    const person = db.select().from(users).where(eq(users.id, userId)).get();
    const userName = person ? person.displayName || person.username : '?';
    const serverName = server?.name ?? serverId;
    db.insert(charges)
      .values({ serverId, serverName, userId, userName, code: found.code, monthlyCents: found.monthlyCents })
      .run();
    const price = formatEuro(found.monthlyCents);
    notify.tell(
      notify.admins(),
      'approvals',
      () => ({
        discord: {
          title: `💸 Gutschein ${found.code} eingelöst`,
          text: `${userName} zahlt dir ab jetzt ${price} im Monat für „${serverName}“. Unter Admin-Bereich → Zahlungen hakst du bezahlte Monate ab.`,
          colour: DISCORD_GOLD,
        },
      }),
      'payment',
    );
  });
  ctx.events.on('server.deleted', ({ serverId }) => {
    db.update(charges)
      .set({ endedAt: new Date().toISOString() })
      .where(and(eq(charges.serverId, serverId), isNull(charges.endedAt)))
      .run();
  });

  return { check, view, mine, mark };
}
