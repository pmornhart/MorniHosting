import { z } from 'zod';

/**
 * Server team ("Mitarbeiter"): people with their own panel account who get a role on one server. Admins and the
 * server's owners manage it; a person is found by user name or e-mail address.
 */

const WHO_MAX = 254;

export const teamAddSchema = z.object({
  /** User name or e-mail address of an existing account. */
  who: z.string().trim().min(1).max(WHO_MAX),
  roleId: z.number().int().positive(),
});
export type TeamAddInput = z.infer<typeof teamAddSchema>;

export const teamRoleSchema = z.object({ roleId: z.number().int().positive() });

export interface TeamMember {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: number;
  readonly roleName: string;
  /** "owner", "moderator", "viewer" for the built-in roles, null for own roles. */
  readonly builtIn: string | null;
  readonly you: boolean;
}

export interface TeamRoleOption {
  readonly id: number;
  readonly name: string;
  readonly builtIn: string | null;
  readonly permissions: readonly string[];
  /** Only admins may hand out the owner role (owners count towards the person's quota). */
  readonly assignable: boolean;
}

export interface TeamView {
  readonly members: readonly TeamMember[];
  readonly roles: readonly TeamRoleOption[];
  /** Admin or owner of this server: may add, change and remove people. */
  readonly canManage: boolean;
}
