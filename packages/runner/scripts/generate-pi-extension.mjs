#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi loads `assets/pi-agentos-extension.ts` with its own loader, so the asset
 * cannot import runner code: `src` is absent from a release and `dist` is
 * absent from a checkout. The delivery receipt writer therefore has one source
 * — the region below in `task-output-receipt.ts` — copied verbatim into the
 * asset by this script. `generate-pi-extension.test.mjs` fails when the copy
 * in git drifts from that source, so the checked-in asset is always the
 * generated one and the build needs no generation step.
 */
const BEGIN = "// AGENT-WRITER-BEGIN";
const END = "// AGENT-WRITER-END";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RECEIPT_MODULE = resolve(packageRoot, "src/task-output-receipt.ts");
export const PI_EXTENSION = resolve(packageRoot, "assets/pi-agentos-extension.ts");

const region = (source, label) => {
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`generate-pi-extension: ${label} has no ${BEGIN}/${END} region`);
  }
  return { before: source.slice(0, begin + BEGIN.length), body: source.slice(begin + BEGIN.length, end), after: source.slice(end) };
};

/** The asset text this repository should have, given the current module. */
export const generatedPiExtension = () => {
  const writer = region(readFileSync(RECEIPT_MODULE, "utf8"), "src/task-output-receipt.ts").body;
  const asset = region(readFileSync(PI_EXTENSION, "utf8"), "assets/pi-agentos-extension.ts");
  return `${asset.before}${writer}${asset.after}`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PI_EXTENSION, generatedPiExtension());
}
