import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, keyLength) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [scheme, salt, storedKey] = passwordHash.split("$");

  if (scheme !== "scrypt" || !salt || !storedKey) {
    return false;
  }

  const stored = Buffer.from(storedKey, "base64url");
  const derived = await scrypt(password, salt, stored.length) as Buffer;

  return stored.length === derived.length && timingSafeEqual(stored, derived);
}
