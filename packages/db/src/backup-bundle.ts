/**
 * The OSS-D backup bundle, as `db:migrate:release --existing` must judge it.
 *
 * ## Why a bundle rather than an archive
 *
 * `--existing` migrates a database that already holds data. The only thing that
 * makes that reversible is a backup — and "a backup exists somewhere" is not a
 * property a program can check. What it can check is a bundle that says, in a
 * form it cannot have forged by accident, *which* server it was taken from,
 * *when*, and *what the archive's bytes are*. Anything less lets a migration
 * proceed beside an archive of a different database, of a different hour, or of
 * a file that has since been replaced.
 *
 * So `deploy/backup-postgres.sh` publishes a mode-0700 directory holding
 * exactly two mode-0600 regular files — `archive.dump` and `attestation.json` —
 * and this module decides whether that directory may authorise a migration.
 *
 * ## What binds a bundle to a target
 *
 * `targetFingerprint` is a one-way digest of the server's own identity: its
 * PostgreSQL system identifier, its database, and its role. It is deliberately
 * *not* computed from the connection — an address or a published port differs
 * between the backup (which reaches the server one way) and the migrator (which
 * reaches it another), and a binding that disagreed for that reason would have
 * to be relaxed until it meant nothing. The Compose half of "this is the right
 * target" is not attested here because it is not the backup's to attest: the
 * migrator proves it separately, before it ever opens a bundle, and refuses
 * first.
 *
 * `walFingerprint` is the write-ahead-log position immediately after the dump.
 * Equality with the position the migrator observes is what makes "nothing was
 * written since the backup" a checked statement rather than a hope. It is
 * checked by the caller after the exclusive lock is held, because a position
 * read before the lock could move a millisecond later.
 *
 * Every value here is a digest, a length, or a stable token. No URL, password,
 * database name, container id, or path is present in a bundle or in anything
 * this module returns.
 */

/** Bundle age. Older than this and the target has had time to drift. */
export const ATTESTATION_MAX_AGE_MS = 15 * 60 * 1_000;
/** Tolerated clock skew ahead of now, so a slightly fast clock is not fatal. */
export const ATTESTATION_MAX_SKEW_MS = 60 * 1_000;

export const ARCHIVE_MEMBER = "archive.dump";
export const ATTESTATION_MEMBER = "attestation.json";
/** The first five bytes of every PostgreSQL custom-format dump. */
export const CUSTOM_FORMAT_MAGIC = "PGDMP";
export const ATTESTATION_VERSION = 1;

export type BundleEntryKind = "file" | "directory" | "symlink" | "other";

export interface BundleEntry {
  name: string;
  kind: BundleEntryKind;
  /** Permission bits only (`mode & 0o7777`). */
  mode: number;
}

/**
 * What the filesystem says about a bundle. Gathered by the host so that every
 * refusal below is decidable without a disk.
 */
export interface BundleFacts {
  /** False when the path does not exist or is not a directory. */
  isDirectory: boolean;
  directoryMode: number;
  entries: readonly BundleEntry[];
  /** Null when `archive.dump` could not be read. */
  archive: { bytes: number; sha256: string; magic: string } | null;
  /** Null when `attestation.json` could not be read. */
  attestationText: string | null;
}

export interface BackupAttestation {
  version: number;
  createdAtMs: number;
  archiveBytes: number;
  archiveSha256: string;
  targetFingerprint: string;
  walFingerprint: string;
  quiescence: string;
}

export type BundleResolution =
  | { ok: true; attestation: BackupAttestation }
  | { ok: false; reason: string };

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_32 = /^[0-9a-f]{32}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the attestation without trusting any of it. Every field is checked for
 * the exact shape the producer writes; a bundle carrying an extra field is
 * accepted, but a bundle missing or mistyping one is not, because the missing
 * field is the one that would have refused this migration.
 */
export const parseAttestation = (text: string): { ok: true; attestation: BackupAttestation } | { ok: false; reason: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "attestation-is-not-json" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "attestation-is-not-json" };

  if (parsed["version"] !== ATTESTATION_VERSION) return { ok: false, reason: "attestation-version-is-unsupported" };

  const createdAt = parsed["createdAt"];
  if (typeof createdAt !== "string") return { ok: false, reason: "attestation-is-malformed" };
  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) return { ok: false, reason: "attestation-created-at-is-unparsable" };

  const archive = parsed["archive"];
  if (!isRecord(archive)) return { ok: false, reason: "attestation-is-malformed" };
  const bytes = archive["bytes"];
  const sha256 = archive["sha256"];
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return { ok: false, reason: "attestation-is-malformed" };
  }
  if (typeof sha256 !== "string" || !HEX_64.test(sha256)) return { ok: false, reason: "attestation-is-malformed" };

  const targetFingerprint = parsed["targetFingerprint"];
  const walFingerprint = parsed["walFingerprint"];
  const quiescence = parsed["quiescence"];
  if (typeof targetFingerprint !== "string" || !HEX_32.test(targetFingerprint)) {
    return { ok: false, reason: "attestation-is-malformed" };
  }
  if (typeof walFingerprint !== "string" || !HEX_32.test(walFingerprint)) {
    return { ok: false, reason: "attestation-is-malformed" };
  }
  if (typeof quiescence !== "string" || quiescence === "") return { ok: false, reason: "attestation-is-malformed" };

  return {
    ok: true,
    attestation: {
      version: ATTESTATION_VERSION,
      createdAtMs,
      archiveBytes: bytes,
      archiveSha256: sha256,
      targetFingerprint,
      walFingerprint,
      quiescence,
    },
  };
};

export interface BundleExpectations {
  /** Wall clock at the moment of judgement, in epoch milliseconds. */
  nowMs: number;
  /** The fingerprint this target answers with right now. */
  targetFingerprint: string;
}

/**
 * The whole judgement, in the order that refuses on the cheapest evidence
 * first: shape, then modes, then contents, then time, then identity. Each stop
 * is a stable token; none of them names a path or a value.
 */
export const validateBackupBundle = (facts: BundleFacts, expected: BundleExpectations): BundleResolution => {
  if (!facts.isDirectory) return { ok: false, reason: "bundle-is-not-a-directory" };
  if ((facts.directoryMode & 0o7777) !== 0o700) return { ok: false, reason: "bundle-directory-mode-is-not-0700" };

  const names = [...facts.entries].map((entry) => entry.name).sort();
  const expectedNames = [ARCHIVE_MEMBER, ATTESTATION_MEMBER].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    return { ok: false, reason: "bundle-members-are-not-exactly-archive-dump-and-attestation-json" };
  }
  for (const entry of facts.entries) {
    // A symlink pointing at a valid archive is a bundle whose contents can be
    // changed after it was judged, which is the one thing the digest cannot
    // catch on its own.
    if (entry.kind !== "file") return { ok: false, reason: "bundle-member-is-not-a-regular-file" };
    if ((entry.mode & 0o7777) !== 0o600) return { ok: false, reason: "bundle-member-mode-is-not-0600" };
  }

  if (facts.attestationText === null) return { ok: false, reason: "attestation-is-unreadable" };
  if (facts.archive === null) return { ok: false, reason: "archive-is-unreadable" };

  const parsed = parseAttestation(facts.attestationText);
  if (!parsed.ok) return parsed;
  const attestation = parsed.attestation;

  if (facts.archive.magic !== CUSTOM_FORMAT_MAGIC) {
    return { ok: false, reason: "archive-is-not-a-postgresql-custom-format-dump" };
  }
  if (facts.archive.bytes !== attestation.archiveBytes) {
    return { ok: false, reason: "archive-length-disagrees-with-the-attestation" };
  }
  if (facts.archive.sha256 !== attestation.archiveSha256) {
    return { ok: false, reason: "archive-digest-disagrees-with-the-attestation" };
  }

  const age = expected.nowMs - attestation.createdAtMs;
  if (age > ATTESTATION_MAX_AGE_MS) return { ok: false, reason: "attestation-is-older-than-fifteen-minutes" };
  if (age < -ATTESTATION_MAX_SKEW_MS) return { ok: false, reason: "attestation-is-more-than-sixty-seconds-in-the-future" };

  if (attestation.targetFingerprint !== expected.targetFingerprint) {
    return { ok: false, reason: "attestation-describes-a-different-target" };
  }

  return { ok: true, attestation };
};
