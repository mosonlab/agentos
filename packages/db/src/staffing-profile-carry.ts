/**
 * Carrying staffing profiles across a canonical rollover.
 *
 * A rollover renames the old TaskTemplate row and writes the new graph into a
 * *new* row, so nothing follows the template automatically: profiles are rows
 * pointing at the old id. This module decides, purely, what the new row's
 * profiles should contain, and what could not be carried so the caller can say
 * so in its sync report instead of silently reassigning a step.
 *
 * Matching is on the exact `outputKind` first, because that is the key an
 * entry means (`foo` and `foo-v2` are distinct steps of a custom graph). The
 * `-vN` fallback exists only here, for the one case the exact key cannot
 * survive: a canonical step whose output protocol version moved between the
 * retired graph and the new one. The suffix rule is restated rather than taken
 * from `stepRole`, whose answer is a role or null and therefore says nothing
 * about a kind no canonical role owns.
 */

/** The `-vN` output-protocol suffix, matching `step-role.ts`'s rule. */
const VERSION_SUFFIX = /-(v[1-9]\d*)$/u;

export const staffingOutputKindBase = (outputKind: string): string =>
  outputKind.replace(VERSION_SUFFIX, "");

export type StaffingProfileCarryEntry = Readonly<{
  outputKind: string;
  assigneeAgentId: string | null;
  include: boolean | null;
}>;

export type StaffingProfileCarrySource = Readonly<{
  name: string;
  isDefault: boolean;
  entries: readonly StaffingProfileCarryEntry[];
}>;

export type StaffingProfileCarryDrop = Readonly<{
  profileName: string;
  outputKind: string;
  /** `unknown-kind`: the new graph declares no step for it, exactly or by base.
   *  `ambiguous-kind`: several new steps share its base kind, so a fallback
   *  would have to guess which one the operator meant. */
  reason: "unknown-kind" | "ambiguous-kind";
}>;

export type StaffingProfileCarryPlan = Readonly<{
  profiles: readonly StaffingProfileCarrySource[];
  dropped: readonly StaffingProfileCarryDrop[];
  /** One line per dropped entry, for the caller's sync report. */
  reportLines: readonly string[];
}>;

const dropLine = (drop: StaffingProfileCarryDrop): string => (
  drop.reason === "ambiguous-kind"
    ? `Staffing profile ${drop.profileName}: entry ${drop.outputKind} dropped; the new graph has several steps whose output kind reduces to ${staffingOutputKindBase(drop.outputKind)}`
    : `Staffing profile ${drop.profileName}: entry ${drop.outputKind} dropped; the new graph has no step producing it`
);

/**
 * Decide what each profile of a retired template row becomes on the new row.
 *
 * `targetOutputKinds` is the new graph's kinds, in step order. Entries that
 * match nothing are dropped and reported; profile names, default membership
 * and the surviving entries' opinions are carried unchanged.
 */
export const planStaffingProfileCarry = (
  profiles: readonly StaffingProfileCarrySource[],
  targetOutputKinds: readonly string[],
): StaffingProfileCarryPlan => {
  const targets = new Set(targetOutputKinds);
  const byBase = new Map<string, string[]>();
  for (const kind of targetOutputKinds) {
    const base = staffingOutputKindBase(kind);
    byBase.set(base, [...byBase.get(base) ?? [], kind]);
  }

  const carried: StaffingProfileCarrySource[] = [];
  const dropped: StaffingProfileCarryDrop[] = [];
  for (const profile of profiles) {
    const entries: StaffingProfileCarryEntry[] = [];
    // Exact matches are settled first for the whole profile: a normalised
    // fallback must never take a target another entry already owns by name.
    const claimed = new Set(
      profile.entries.map((entry) => entry.outputKind).filter((kind) => targets.has(kind)),
    );
    for (const entry of profile.entries) {
      if (targets.has(entry.outputKind)) {
        entries.push({ ...entry });
        continue;
      }
      const sameBase = byBase.get(staffingOutputKindBase(entry.outputKind)) ?? [];
      const candidates = sameBase.filter((kind) => !claimed.has(kind));
      if (candidates.length === 1) {
        claimed.add(candidates[0]!);
        entries.push({ ...entry, outputKind: candidates[0]! });
        continue;
      }
      dropped.push({
        profileName: profile.name,
        outputKind: entry.outputKind,
        reason: sameBase.length === 0 ? "unknown-kind" : "ambiguous-kind",
      });
    }
    carried.push({ name: profile.name, isDefault: profile.isDefault, entries });
  }

  return { profiles: carried, dropped, reportLines: dropped.map(dropLine) };
};
