import { randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

export function getRandomBytes(byteCount: number) {
  return new Uint8Array(randomBytes(byteCount));
}

export async function getRandomBytesAsync(byteCount: number) {
  return getRandomBytes(byteCount);
}

export function randomUUID() {
  return nodeRandomUUID();
}
