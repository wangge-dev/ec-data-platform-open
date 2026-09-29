import { sql } from "../db/client.js";
import type { AuthPayload } from "./auth.js";

/**
 * Resolve a signed identity against the current users table.
 *
 * JWT claims are only proof of the original login. Authorization always uses
 * this row so deleting a user or changing their administrator flag takes
 * effect on the next request rather than after the seven-day token expires.
 */
export async function resolveCurrentAuthUser(
  payload: AuthPayload,
): Promise<AuthPayload | null> {
  const rows = await sql.unsafe<
    Array<{
      uid: number | string;
      username: string;
      isAdmin: boolean;
      tokenVersion: number | string;
    }>
  >(
    `SELECT id AS uid, username, is_admin AS "isAdmin", token_version AS "tokenVersion"
     FROM public.users
     WHERE id = $1
     LIMIT 1`,
    [payload.uid],
  );
  const row = rows[0];
  if (!row) return null;

  const uid = Number(row.uid);
  const tokenVersion = Number(row.tokenVersion);
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(tokenVersion) ||
    tokenVersion < 0 ||
    tokenVersion !== payload.tokenVersion
  ) {
    return null;
  }
  return {
    uid,
    username: row.username,
    isAdmin: row.isAdmin === true,
    tokenVersion,
  };
}
