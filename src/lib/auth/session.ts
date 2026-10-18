import "server-only";
import { cookies, headers } from "next/headers";
import { appendAudit, type AuditEntryInput } from "@/lib/audit";
import { decodeDevRole, DEV_ROLE_COOKIE } from "@/lib/auth/dev-role-cookie";
import { DEFAULT_DEV_ROLE, type Role } from "@/lib/auth/roles";
import { sourceFromHeaders } from "@/lib/auth/source-address";
import { getConfig, type AuthMode } from "@/lib/config";
import { getDb } from "@/lib/db";

export interface Session {
  actorId: string;
  role: Role;
  authMode: AuthMode;
}

/** いまの要求の利用者。AUTH_MODE=dev では cookie の役割を使う（local・oidc は起動の時に止めている） */
export async function getSession(): Promise<Session> {
  const config = getConfig();
  if (config.auth.mode !== "dev") {
    throw new Error(`AUTH_MODE=${config.auth.mode} はまだ無い`);
  }
  const jar = await cookies();
  const role = decodeDevRole(jar.get(DEV_ROLE_COOKIE)?.value, config.sessionSecret) ?? DEFAULT_DEV_ROLE;
  return { actorId: "dev", role, authMode: "dev" };
}

export type AuditFields = Omit<
  AuditEntryInput,
  "actorId" | "actorRole" | "authMode" | "sourceAddress" | "sourceAddressUnverified"
>;

/** いまの利用者で監査の記録に1行足す。接続元の分け方は src/lib/auth/source-address.ts */
export async function audit(session: Session, fields: AuditFields) {
  const db = await getDb();
  return appendAudit(db, {
    ...fields,
    actorId: session.actorId,
    actorRole: session.role,
    authMode: session.authMode,
    ...sourceFromHeaders(await headers()),
  });
}
