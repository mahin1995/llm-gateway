import { randomBytes } from "node:crypto";

export function createGatewayApiKey(): string {
  return `lgw_${randomBytes(32).toString("base64url")}`;
}
