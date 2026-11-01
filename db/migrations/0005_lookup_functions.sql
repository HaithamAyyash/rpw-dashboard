-- migrate:up

-- The lookups that must run before the organization is known. These are the ONLY paths in
-- the web app around row-level security. Each returns the minimum its caller needs.

-- API key hash -> (cluster head, organization). Revoked keys simply don't match.
CREATE FUNCTION ingest_auth(p_key_hash text)
  RETURNS TABLE (cluster_id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.cluster_id, c.org_id FROM cluster_heads c
    WHERE c.api_key_hash = p_key_hash AND NOT c.revoked
  $$;

-- Login: the only way the web role can read a password hash.
CREATE FUNCTION auth_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, name text, password_hash text, token_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.user_id, u.name, u.password_hash, u.token_version FROM users u
    WHERE u.email = lower(p_email)
  $$;

-- Which organizations does this user belong to (login, /auth/me, org switcher)?
CREATE FUNCTION auth_memberships(p_user_id uuid)
  RETURNS TABLE (org_id uuid, name text, slug text, timezone text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.org_id, o.name, o.slug, o.timezone, m.role
    FROM organization_members m JOIN organizations o USING (org_id)
    WHERE m.user_id = p_user_id
    ORDER BY o.name
  $$;

-- Open invite link -> invite. Only usable, unexpired invites match.
CREATE FUNCTION invite_by_token(p_token_hash text)
  RETURNS TABLE (invite_id uuid, org_id uuid, org_name text, email text, role text,
                 account_exists boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.invite_id, i.org_id, o.name, i.email, i.role,
           EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)
    FROM organization_invites i JOIN organizations o USING (org_id)
    WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now()
  $$;

REVOKE ALL ON FUNCTION ingest_auth(text), auth_user_by_email(text),
              auth_memberships(uuid), invite_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_auth(text), auth_user_by_email(text),
              auth_memberships(uuid), invite_by_token(text) TO nakhel_web;

-- migrate:down
DROP FUNCTION invite_by_token(text);
DROP FUNCTION auth_memberships(uuid);
DROP FUNCTION auth_user_by_email(text);
DROP FUNCTION ingest_auth(text);
