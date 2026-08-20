import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decodeStrictBase64 } from "./base64.js";

const keyFromEnvironment = (): Buffer => {
  const encoded = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  if (!encoded) throw new Error("AGENTOS_SECRET_ENCRYPTION_KEY is required when a Run uses Secrets");
  // The same strict parser `startup-config.ts` judged this value with. Node's
  // own base64 decoder drops illegal characters, so a loose read here would
  // accept a key the startup gate refused — and the refusal would arrive at the
  // first Run that touches a Secret rather than at startup.
  const key = decodeStrictBase64(encoded);
  if (key === null || key.length !== 32) {
    throw new Error("AGENTOS_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
};

export const encryptSecret = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromEnvironment(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
};

export const decryptSecret = (encrypted: string, ciphertextVersion: number): string => {
  const [format, ivEncoded, tagEncoded, ciphertextEncoded] = encrypted.split(":");
  if (ciphertextVersion !== 1 || format !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error(`Unsupported secret ciphertext version: ${ciphertextVersion}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFromEnvironment(), Buffer.from(ivEncoded, "base64"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64")), decipher.final()]).toString("utf8");
};
