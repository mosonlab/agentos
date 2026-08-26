/** Drop the keys a partial request schema left absent, so a patch writes only
 *  the fields it named. */
export const withoutUndefined = (value: object): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);
