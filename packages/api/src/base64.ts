/**
 * Strict base64, because Node's decoder is not one.
 *
 * `Buffer.from(value, "base64")` silently discards every character outside the
 * alphabet and stops at the first padding it likes. That is forgiving in the
 * worst possible place: `Buffer.from("!!!!" + key, "base64")` returns the same
 * 32 bytes as `key`, so any check written as "decodes to 32 bytes" accepts a
 * value that is not base64 at all. A configuration checker that uses it reports
 * a malformed key as well-formed, which is the one answer it exists to avoid.
 *
 * Two properties, both required:
 *
 *   1. The syntax is canonical: alphabet, group length and padding.
 *   2. The value round-trips. This is what catches an input whose final group
 *      sets bits the decoder throws away — `"AAAB"` and `"AAAA"` decode to the
 *      same three bytes, and only one of them is the encoding of them.
 *
 * `startup-config.ts` and `secrets.ts` both go through here, so the verdict the
 * control plane gives at startup and the rule it applies when a Run first opens
 * a Secret cannot drift apart.
 */

/** Alphabet, groups of four, and at most one padded final group. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** The bytes `value` encodes, or `null` if `value` is not canonical base64.
 *  Never throws, and never reports the value it rejected. */
export const decodeStrictBase64 = (value: string): Buffer | null => {
  if (value === "" || !CANONICAL_BASE64.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded;
};
