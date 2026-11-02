import { z } from "zod";
import { orgGet, orgWrite } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { withOrg } from "@/lib/db/withOrg";
import { sendEmail } from "@/lib/email";
import { errorResponse } from "@/lib/ingest/responses";
import { appBaseUrl, hashToken, newToken } from "@/lib/settings/tokens";

const INVITE_DAYS = 7;

export const GET = orgGet(noQuery, async ({ orgId }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query(
      `SELECT invite_id, email, role, created_at, expires_at FROM organization_invites
       WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [orgId],
    ),
  );
  return Response.json({ items: rows });
});

const inviteSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((e) => e.toLowerCase()),
});

export const POST = orgWrite(
  inviteSchema,
  async ({ orgId, input, context }) => {
    const token = newToken();
    const result = await withOrg(orgId, async (client) => {
      const member = await client.query(
        `SELECT 1 FROM organization_members m JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = $1 AND u.email = $2`,
        [orgId, input.email],
      );
      if (member.rowCount) return null;
      // A new invite replaces an older open one for the same person.
      await client.query(
        "DELETE FROM organization_invites WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL",
        [orgId, input.email],
      );
      const { rows } = await client.query(
        `INSERT INTO organization_invites (org_id, email, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING invite_id, expires_at`,
        [
          orgId,
          input.email,
          hashToken(token),
          context.user.user_id,
          INVITE_DAYS,
        ],
      );
      return rows[0];
    });
    if (!result)
      return errorResponse(409, "conflict", "That person is already a member");

    const link = `${appBaseUrl()}/invite/${token}`;
    const emailSent = await sendEmail(
      input.email,
      `You're invited to ${context.membership.name} on NAKHEL`,
      `${context.user.name} invited you to join ${context.membership.name} on NAKHEL.\n\nAccept the invite: ${link}\n\nThis link works once and expires in ${INVITE_DAYS} days.`,
    );
    return Response.json(
      { ...result, link, email_sent: emailSent },
      { status: 201 },
    );
  },
);
