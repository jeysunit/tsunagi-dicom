import { createHmac, timingSafeEqual } from "node:crypto";
import { isRole, type Role } from "@/lib/auth/roles";

// 検証モード（AUTH_MODE=dev）の役割を覚える cookie。SESSION_SECRET の HMAC で署名し、手で書き換えた値は使わない。
export const DEV_ROLE_COOKIE = "tsunagi_dev_role";

function sign(role: Role, secret: string): string {
  return createHmac("sha256", secret).update(`dev-role:${role}`).digest("base64url");
}

export function encodeDevRole(role: Role, secret: string): string {
  return `${role}.${sign(role, secret)}`;
}

export function decodeDevRole(value: string | undefined, secret: string): Role | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const role = value.slice(0, dot);
  if (!isRole(role)) return null;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(role, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return role;
}
