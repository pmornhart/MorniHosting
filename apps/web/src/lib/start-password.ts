/**
 * A start password someone can read off a sheet and type without mix-ups: three groups of four, letters and
 * digits that cannot be confused (no 0/O, 1/l/I), e.g. "Kt7m-qX3a-Wp9e". About 70 bits from crypto.getRandomValues.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LENGTH = 4;

export function startPassword(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(GROUPS * GROUP_LENGTH));
  const chars = Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length] ?? '');
  return Array.from({ length: GROUPS }, (_, g) =>
    chars.slice(g * GROUP_LENGTH, (g + 1) * GROUP_LENGTH).join(''),
  ).join('-');
}
