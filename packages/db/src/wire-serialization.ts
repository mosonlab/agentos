/**
 * Compile-time proof that a native projection JSON-serializes to exactly its
 * browser contract.
 *
 * A projecting route builds its response from Prisma rows, so it holds native
 * `Date` and `Prisma.Decimal` values, and hands the result to Hono, which
 * serializes it with `JSON.stringify`. The browser reads the same contract
 * instantiated with its wire defaults. Binding the projection with
 * `satisfies SomeContract<Date, Prisma.Decimal>` proves only the native half:
 * it cannot see a `Decimal` the contract declares as `string`, a nested `Date`
 * left where the browser expects a `string`, or a key the projection carries
 * and the contract does not name.
 *
 * `SerializesTo` names both sides at once, so the route's existing `satisfies`
 * carries the whole claim. Nothing here exists at runtime; the module is types
 * only, and Prisma is imported as a type.
 */

import type { Prisma } from "@prisma/client";

/**
 * What `JSON.stringify` makes of a native projection type.
 *
 * `Date` and `Prisma.Decimal` both define `toJSON` and reach the browser as
 * strings. Everything else is mapped through. The object mapping is
 * homomorphic, so optional and readonly modifiers, tuples, arrays and index
 * signatures survive it unchanged, and the conditional distributes over
 * unions, which keeps `Date | null` honest.
 */
export type JsonSerialized<T> = T extends Date | Prisma.Decimal
  ? string
  : T extends object
    ? { [Key in keyof T]: JsonSerialized<T[Key]> }
    : T;

/**
 * The same structural flattening with the native leaves left alone.
 *
 * Contracts are written both as plain object types and as an intersection with
 * a shared base. An intersection and the object type holding the same members
 * are the same wire shape but not the same *type*, so the comparison flattens
 * both sides. Leaving `Date` and `Prisma.Decimal` in place is the point: a
 * contract that still declares one is the mismatch being looked for.
 */
type Flattened<T> = T extends Date | Prisma.Decimal
  ? T
  : T extends object
    ? { [Key in keyof T]: Flattened<T[Key]> }
    : T;

/**
 * Type identity, not mutual assignability.
 *
 * Assignability in both directions accepts a surplus *optional* key on either
 * side and cannot separate `field?: string` from `field: string | undefined`.
 * Both are differences a browser sees. The two probe signatures are identical
 * only when TypeScript holds the two types to be the same type, at every depth.
 */
type Identical<Left, Right> =
  (<Probe>() => Probe extends Left ? 1 : 2) extends (<Probe>() => Probe extends Right ? 1 : 2)
    ? true
    : false;

/**
 * What `SerializesTo` resolves to when the proof fails. No projection can
 * satisfy it, so the failure is reported at the line that projects, naming
 * both the native shape and the contract it was claimed to serialize to.
 */
export type WireSerializationMismatch<Native, Wire> = {
  readonly wireSerializationMismatch:
    "this native projection does not JSON-serialize to exactly this browser contract";
  readonly native: Native;
  readonly wire: Wire;
};

/**
 * `Native` when JSON serialization turns it into exactly `Wire`, and an
 * unsatisfiable mismatch otherwise.
 *
 * Written as the projection's own type — `type FooResponse = SerializesTo<
 * FooContract<Date, Prisma.Decimal>, FooContract>` — so every `satisfies
 * FooResponse` in the route already carries the proof, and a contract that
 * needs no instantiation still proves it holds no unserialized value.
 */
export type SerializesTo<Native, Wire> =
  Identical<JsonSerialized<Native>, Flattened<Wire>> extends true
    ? Native
    : WireSerializationMismatch<Native, Wire>;
