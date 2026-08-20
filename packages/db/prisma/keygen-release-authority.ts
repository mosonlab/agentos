/**
 * `npm run snapshot:authority-keygen -- <private-key-path>` — create the
 * signing key the release authority attestation is verified against.
 *
 * This is an operator action, run once. The private half is written outside the
 * repository, readable only by its owner; the public half is printed for the
 * operator to save as `release-authority.pub` and commit. Nothing here writes
 * into the repository: the trust anchor becomes trustworthy by going through
 * review and the merge gate like any other tracked file, and this script has no
 * business shortcutting that.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  publicKeyFingerprint,
  RELEASE_AUTHORITY_ALGORITHM,
  RELEASE_AUTHORITY_PUBLIC_KEY,
} from "../src/release-authority.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const stop = (detail: string): never => {
  console.error(`STOP release-authority-keygen ${detail}`);
  process.exit(1);
};

const target = process.argv[2];
if (!target) stop("name the file to write the private key to, outside this repository");
const path = isAbsolute(target as string) ? (target as string) : resolve(process.cwd(), target as string);
if (path.startsWith(`${repositoryRoot}/`)) stop(`refusing to write a private key inside the repository: ${path}`);
if (existsSync(path)) stop(`refusing to overwrite an existing key: ${path}`);

const { privateKey, publicKey } = generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM);
writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { encoding: "utf8", mode: 0o600 });

console.log(`release-authority-keygen wrote the private key to ${path} (mode 0600)`);
console.log(`release-authority-keygen fingerprint=${publicKeyFingerprint(publicKey)}`);
console.log(`release-authority-keygen save the following as ${RELEASE_AUTHORITY_PUBLIC_KEY} and commit it:`);
console.log("");
process.stdout.write(publicKey.export({ type: "spki", format: "pem" }) as string);
