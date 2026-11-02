/** The exact JSON text of a request, for endpoints that check a signature over it (Discord events). */
const rawBodies = new WeakMap<object, string>();

export const rememberRawBody = (request: object, body: string): void => {
  rawBodies.set(request, body);
};

export const rawBodyOf = (request: object): string => rawBodies.get(request) ?? '';
