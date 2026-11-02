import { z } from 'zod';

/** Moving the panel's settings and connections to another MorniHosting with one code. */

export const TRANSFER_PASSWORD_MIN = 8;
const TRANSFER_PASSWORD_MAX = 200;
const TRANSFER_CODE_MAX = 200_000;

const password = z.string().min(TRANSFER_PASSWORD_MIN).max(TRANSFER_PASSWORD_MAX);

export const transferExportSchema = z.object({ password });
export const transferImportSchema = z.object({
  code: z.string().trim().min(1).max(TRANSFER_CODE_MAX),
  password,
});

export interface TransferCode {
  readonly code: string;
  /** Which parts the code carries, e.g. "mail", "discord". */
  readonly parts: readonly string[];
}

export interface TransferResult {
  readonly parts: readonly string[];
  /** Where the code was made (its panel domain), if it had one. */
  readonly from: string;
  /** True when the panel restarts by itself to use the new settings. */
  readonly restarting: boolean;
}
