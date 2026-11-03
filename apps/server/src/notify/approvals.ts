import { and, desc, eq } from 'drizzle-orm';
import {
  SOFTWARE,
  type ApprovalsView,
  type CreateServerInput,
  type ServerRequestView,
  gameName,
  isMinecraft,
} from '@mornihosting/shared';
import type { UserRow } from '../auth/context.js';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { serverRequests, users } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import type { MailService } from '../mail/service.js';
import type { ServerService } from '../servers/service.js';
import type { DiscordMessage } from './discord.js';
import { COLOUR_DECLINED, COLOUR_DONE, COLOUR_INFO, type NotifyService } from './service.js';

/**
 * Admins decide who gets in and who gets a server. Each decision can be made in the panel or with the buttons of
 * the Discord message; whichever comes first counts, the other one then reports "already done".
 */

const MB_PER_GB = 1024;
const plan = (memoryMb: number): string =>
  memoryMb >= MB_PER_GB ? `${Number((memoryMb / MB_PER_GB).toFixed(1))} GB RAM` : `${memoryMb} MB RAM`;

export interface ApprovalService {
  readonly view: () => ApprovalsView;
  readonly approveUser: (userId: number, by: Actor) => DiscordMessage;
  readonly rejectUser: (userId: number, note: string, by: Actor) => DiscordMessage;
  readonly request: (input: CreateServerInput, user: UserRow) => ServerRequestView;
  readonly mine: (user: UserRow) => ServerRequestView[];
  readonly approveRequest: (id: string, by: Actor) => Promise<DiscordMessage>;
  readonly rejectRequest: (id: string, note: string, by: Actor) => DiscordMessage;
}

export function createApprovalService(
  ctx: AppContext,
  mail: MailService,
  notify: NotifyService,
  serverService: ServerService,
): ApprovalService {
  const { db } = ctx;
  const link = (path: string): string | null => {
    const base = mail.panelUrl();
    return base ? `${base}${path}` : null;
  };
  const linkButton = (path: string): DiscordMessage['buttons'] => {
    const url = link(path);
    return url ? [{ label: 'Im Panel ansehen', url }] : [];
  };
  const userRow = (id: number): UserRow | undefined => db.select().from(users).where(eq(users.id, id)).get();

  const toView = (row: typeof serverRequests.$inferSelect): ServerRequestView => {
    const owner = userRow(row.userId);
    const { eula: _eula, ...input } = row.input;
    return {
      id: row.id,
      user: {
        id: row.userId,
        username: owner?.username ?? '?',
        displayName: owner?.displayName || owner?.username || '?',
      },
      input,
      status: row.status,
      note: row.note,
      serverId: row.serverId,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    };
  };

  const requestRow = (id: string): typeof serverRequests.$inferSelect => {
    const row = db.select().from(serverRequests).where(eq(serverRequests.id, id)).get();
    if (!row) throw notFound('request_not_found');
    return row;
  };

  const done = (title: string, text: string, colour = COLOUR_DONE): DiscordMessage => ({
    title,
    text,
    colour,
  });

  /* ---------- Accounts ---------- */

  const pendingUser = (userId: number): UserRow | null => {
    const user = userRow(userId);
    return user?.approvalPending ? user : null;
  };

  const approveUser: ApprovalService['approveUser'] = (userId, by) => {
    const user = pendingUser(userId);
    if (!user)
      return done('Schon erledigt', 'Über diese Registrierung wurde schon entschieden.', COLOUR_INFO);
    db.update(users).set({ approvalPending: false }).where(eq(users.id, user.id)).run();
    ctx.events.emit('approvals.changed', { userId: user.id });
    ctx.audit.record(by, 'user.approved', null, { username: user.username });
    notify.tell([user], 'decisions', () => ({
      mail: { kind: 'account_approved', vars: { link: link('/login') } },
      discord: {
        title: '✅ Du bist freigeschaltet',
        text: 'Du kannst dich jetzt bei MorniHosting anmelden.',
      },
    }));
    return done(
      '✅ Freigegeben',
      `${user.username} kann sich jetzt anmelden (freigegeben von ${by.username ?? '?'}).`,
    );
  };

  const rejectUser: ApprovalService['rejectUser'] = (userId, note, by) => {
    const user = pendingUser(userId);
    if (!user)
      return done('Schon erledigt', 'Über diese Registrierung wurde schon entschieden.', COLOUR_INFO);
    // The mail goes out before the account (and its address) is gone.
    if (user.email) mail.deliver(user.email, 'account_rejected', user.locale, { name: user.username, note });
    db.delete(users).where(eq(users.id, user.id)).run();
    ctx.events.emit('approvals.changed', { userId: null });
    ctx.audit.record(by, 'user.rejected', null, { username: user.username });
    return done(
      '❌ Abgelehnt',
      `Die Registrierung von ${user.username} wurde abgelehnt und gelöscht.`,
      COLOUR_DECLINED,
    );
  };

  /* ---------- Server requests ---------- */

  const request: ApprovalService['request'] = (input, user) => {
    // Too big for the person's quota: say so now, not only when an admin tries to approve it.
    serverService.checkNewServer(user, input.memoryMb);
    const id = serverService.newId();
    db.insert(serverRequests).values({ id, userId: user.id, input }).run();
    ctx.audit.record({ userId: user.id, username: user.username, ip: null }, 'server.requested', null, {
      name: input.name,
    });
    ctx.events.emit('server.requested', { requestId: id });
    ctx.events.emit('approvals.changed', { userId: user.id });
    return toView(requestRow(id));
  };

  const decide = (
    id: string,
    status: 'approved' | 'rejected',
    note: string,
    by: Actor,
    serverId: string | null,
  ) => {
    db.update(serverRequests)
      .set({ status, note, serverId, decidedBy: by.username, decidedAt: new Date().toISOString() })
      .where(and(eq(serverRequests.id, id), eq(serverRequests.status, 'pending')))
      .run();
    ctx.events.emit('approvals.changed', { userId: requestRow(id).userId });
  };

  const alreadyDecided = (row: typeof serverRequests.$inferSelect): DiscordMessage =>
    done(
      'Schon erledigt',
      `Diese Anfrage wurde schon ${row.status === 'approved' ? 'angenommen' : 'abgelehnt'} (von ${row.decidedBy ?? '?'}).`,
      COLOUR_INFO,
    );

  const approveRequest: ApprovalService['approveRequest'] = async (id, by) => {
    const row = requestRow(id);
    if (row.status !== 'pending') return alreadyDecided(row);
    const owner = userRow(row.userId);
    if (!owner || owner.disabled) throw conflict('request_user_gone');
    // The asked-for port may be taken by now: then the next free one.
    const port = serverService.freePort(row.input.port, SOFTWARE[row.input.software].protocol, '');
    const summary = await serverService.create({ ...row.input, port }, by, owner);
    decide(id, 'approved', '', by, summary.id);
    ctx.audit.record(by, 'server.request_approved', summary.id, { name: row.input.name });
    // The order mail (server.created) tells the person by mail; Discord gets its own message.
    notify.tell([owner], 'decisions', () => ({
      discord: {
        title: '🚀 Server freigegeben',
        text: `Dein Server „${row.input.name}“ wurde freigegeben und wird jetzt angelegt.`,
        colour: COLOUR_DONE,
        buttons: linkButton(`/servers/${summary.id}`),
      },
    }));
    return done(
      '✅ Angenommen',
      `„${row.input.name}“ für ${owner.username} wird angelegt (von ${by.username ?? '?'}).`,
    );
  };

  const rejectRequest: ApprovalService['rejectRequest'] = (id, note, by) => {
    const row = requestRow(id);
    if (row.status !== 'pending') return alreadyDecided(row);
    decide(id, 'rejected', note, by, null);
    ctx.audit.record(by, 'server.request_rejected', null, { name: row.input.name });
    const owner = userRow(row.userId);
    if (owner)
      notify.tell([owner], 'decisions', () => ({
        mail: { kind: 'request_rejected', vars: { server: row.input.name, note } },
        discord: {
          title: 'Anfrage abgelehnt',
          text: `Deine Anfrage für „${row.input.name}“ wurde abgelehnt.${note ? ` Begründung: ${note}` : ''}`,
          colour: COLOUR_DECLINED,
        },
      }));
    return done(
      '❌ Abgelehnt',
      `Die Anfrage „${row.input.name}“ von ${owner?.username ?? '?'} wurde abgelehnt.`,
      COLOUR_DECLINED,
    );
  };

  /* ---------- Telling the admins, and their buttons ---------- */

  ctx.events.on('user.awaiting_approval', ({ userId }) => {
    const user = userRow(userId);
    if (!user) return;
    notify.tell(notify.admins(), 'approvals', () => ({
      mail: {
        kind: 'approval_needed',
        vars: { who: user.username, email: user.email, link: link('/approvals') },
      },
      discord: {
        title: '🙋 Neue Registrierung',
        text: `**${user.username}** möchte bei MorniHosting mitmachen. Erst nach deiner Freigabe kann sich die Person anmelden.`,
        colour: COLOUR_INFO,
        fields: [
          {
            name: 'E-Mail',
            value: `${user.email ?? '–'}${user.signupPending ? ' (noch nicht bestätigt)' : ''}`,
          },
        ],
        buttons: [
          { label: 'Freigeben', id: notify.actionId('approve-user', String(user.id)), style: 'approve' },
          { label: 'Ablehnen', id: notify.actionId('reject-user', String(user.id)), style: 'reject' },
          ...(linkButton('/approvals') ?? []),
        ],
      },
    }));
  });

  ctx.events.on('server.requested', ({ requestId }) => {
    const row = db.select().from(serverRequests).where(eq(serverRequests.id, requestId)).get();
    const owner = row ? userRow(row.userId) : undefined;
    if (!row || !owner) return;
    const game = gameName(row.input.edition);
    const minecraft = isMinecraft(row.input.edition);
    const software = minecraft
      ? `${game} · ${SOFTWARE[row.input.software].label} ${row.input.version}`
      : `${game} ${row.input.version}`;
    notify.tell(notify.admins(), 'approvals', () => ({
      mail: {
        kind: 'request_new',
        vars: {
          who: owner.username,
          server: row.input.name,
          software,
          plan: plan(row.input.memoryMb),
          link: link('/approvals'),
        },
      },
      discord: {
        title: '🖥️ Neue Server-Anfrage',
        text: `**${owner.username}** möchte einen Server.`,
        colour: COLOUR_INFO,
        fields: [
          { name: 'Name', value: row.input.name },
          { name: 'Spiel', value: game },
          ...(minecraft ? [{ name: 'Software', value: SOFTWARE[row.input.software].label }] : []),
          { name: 'Version', value: row.input.version },
          { name: 'Paket', value: plan(row.input.memoryMb) },
        ],
        buttons: [
          { label: 'Freigeben', id: notify.actionId('approve-req', row.id), style: 'approve' },
          { label: 'Ablehnen', id: notify.actionId('reject-req', row.id), style: 'reject' },
          ...(linkButton('/approvals') ?? []),
        ],
      },
    }));
  });

  const actorFor = (user: UserRow): Actor => ({ userId: user.id, username: user.username, ip: null });
  const adminOnly = (user: UserRow): void => {
    if (!user.isAdmin) throw forbidden('admin_only');
  };
  notify.onAction('approve-user', async (target, by) => {
    adminOnly(by);
    return approveUser(Number(target), actorFor(by));
  });
  notify.onAction('reject-user', async (target, by) => {
    adminOnly(by);
    return rejectUser(Number(target), '', actorFor(by));
  });
  notify.onAction('approve-req', async (target, by) => {
    adminOnly(by);
    return approveRequest(target, actorFor(by));
  });
  notify.onAction('reject-req', async (target, by) => {
    adminOnly(by);
    return rejectRequest(target, '', actorFor(by));
  });

  return {
    view: () => ({
      users: db
        .select()
        .from(users)
        .where(eq(users.approvalPending, true))
        .all()
        .map((u) => ({
          id: u.id,
          username: u.username,
          email: u.email,
          emailConfirmed: !u.signupPending,
          createdAt: u.createdAt,
        })),
      requests: db.select().from(serverRequests).orderBy(desc(serverRequests.createdAt)).all().map(toView),
    }),
    approveUser,
    rejectUser,
    request,
    mine: (user) =>
      db
        .select()
        .from(serverRequests)
        .where(eq(serverRequests.userId, user.id))
        .orderBy(desc(serverRequests.createdAt))
        .all()
        .map(toView),
    approveRequest,
    rejectRequest,
  };
}
