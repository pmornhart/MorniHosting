import fs from 'node:fs';
import path from 'node:path';

/**
 * The MorniCraft server icon (64 × 64 PNG, own pixel art): a shield of white-and-blue lozenges – a little Bavaria –
 * with an emerald badge and a white M. Shown in the server list of every player.
 */
const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACC0lEQVR42u2aMU4DMRBFvQjlAN4OcQMKKMgVcgAK6BGBOhegyAWoSVbpoaCk4ARIUEDBAZAQHTlAmqWLvlee7Di2IbB/qo3jtb2j/+wZ24UBs4fHtfnnNn++LfD3lum4dd4B2yj7+dmlt1J9sectL67f/lz9sm9qxIEIdB4BTSVJWqH1bTX2lpcVzNIChqnGY6kAOiAcgdBZV5L6+cNRa1+Tgf9dRCNqFaioADrAUQ0GQl9PN0Evl/2TtaUeapPBnbc8ZswMhIhAYxXQxdJ+2e9Od5bP9++PyQeK7X8MP/2SDsxlqAA6YI1cwAqyfD24Wj7vv4ySD9Rpfzry4sBcgAhkQgBje5S9Sq4ROGA7mtXBDMetuQNzASKwAgEpYGjKps1Q9qE4SPU1OGiDHyqADgjMBWxEBxoccgRR+C3MBYhAZCCUynLLnrkAEdhwBCQcchtzASLww7nAJhhzASKQMBeo4fgJ9+FxNyb3rC61j5uiuAvEXIAIKBHAm5PWmLpNTlaQn2azNJVpzgKcVaxxIkwF0AEw8Ut/aC5OSCfFvdNF8oEuZj1vOY7NQRXOMpqypwLoAAUCEg6S/FKhoZG6pq9VsqcC6IBABDRoaG5ySnLVzOpOv8oZngqgAzIjoFkpNPf/xTaFS9exsqcC6IAMCISuFGjSTdSUUqcC6IBfQkCzUuSa4akAOoDWat+6m+Qecg/vAwAAAABJRU5ErkJggg==';

/** Counts up when the picture changes: servers that got an older one get the new one once. */
export const MORNICRAFT_ICON_VERSION = 1;

export function writeMorniCraftIcon(serverDir: string): void {
  fs.writeFileSync(path.join(serverDir, 'server-icon.png'), Buffer.from(ICON_PNG_BASE64, 'base64'));
}
