import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

interface SessionPayload {
  sub: string;
  exp: number;
}

const sessionPrefix = "lgw_session";
const sessionTtlSeconds = 60 * 60 * 12;

export function createSessionToken(userId: string): string {
  const payload: SessionPayload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload);
  return `${sessionPrefix}.${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const [prefix, encodedPayload, signature] = token.split(".");

  if (prefix !== sessionPrefix || !encodedPayload || !signature) {
    return null;
  }

  if (!safeSignatureEqual(signature, sign(encodedPayload))) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;

  if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function sign(value: string): string {
  return createHmac("sha256", config.SESSION_SECRET).update(value).digest("base64url");
}

function safeSignatureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
