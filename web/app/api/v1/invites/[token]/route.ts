import { pool } from "@/lib/db/pool";
import { errorResponse } from "@/lib/ingest/responses";
import { hashToken } from "@/lib/settings/tokens";

type Params = { params: Promise<{ token: string }> };

/** Public: what the invite page shows. The token itself is the credential. */
export async function GET(
  _request: Request,
  { params }: Params,
): Promise<Response> {
  try {
    const { token } = await params;
    const { rows } = await pool().query(
      "SELECT org_name, email, account_exists FROM invite_by_token($1)",
      [hashToken(token)],
    );
    return rows[0]
      ? Response.json(rows[0])
      : errorResponse(
          404,
          "not_found",
          "This invite has expired or was already used",
        );
  } catch (error) {
    console.error("invite lookup failed", error);
    return errorResponse(500, "server_error", "Something went wrong");
  }
}
