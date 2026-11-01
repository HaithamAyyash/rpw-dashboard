-- migrate:up

-- The organization this transaction acts for. Set by the app with
-- set_config('app.current_org', <uuid>, true).
-- NULLIF matters: once a SET LOCAL ends, the setting reverts to '' (not NULL) on that
-- pooled connection, and ''::uuid would raise an error rather than return no rows.
CREATE FUNCTION current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

CREATE FUNCTION current_app_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

CREATE TABLE organizations (
  org_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  slug              text NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
                    -- A slug becomes the first URL segment, so it must not shadow a real route.
                    CHECK (slug NOT IN ('api', 'login', 'logout', 'invite', 'static', 'public')),
  timezone          text NOT NULL DEFAULT 'Asia/Dubai',
  suspect_threshold numeric(4,3) NOT NULL DEFAULT 0.5,
  alert_threshold   numeric(4,3) NOT NULL DEFAULT 0.8,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thresholds_valid CHECK (
    suspect_threshold >= 0 AND alert_threshold <= 1 AND suspect_threshold < alert_threshold
  )
);

-- A CHECK can't do this: the lookup isn't immutable.
CREATE FUNCTION organizations_check_timezone() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone: %', NEW.timezone USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER organizations_timezone_valid
  BEFORE INSERT OR UPDATE OF timezone ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_check_timezone();

CREATE TABLE users (
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lower-case so 'A@x.com' and 'a@x.com' can't become two accounts.
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  -- Raised on password change; sessions carrying an older value are refused.
  token_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login    timestamptz
);

CREATE TABLE organization_members (
  org_id     uuid NOT NULL REFERENCES organizations (org_id),
  user_id    uuid NOT NULL REFERENCES users (user_id),
  role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

-- "An organization must always have at least one owner" has two halves.
-- 1. Removing or demoting the last owner is refused. SECURITY DEFINER so the count isn't
--    narrowed by the caller's row-level security; the row lock serialises two owners
--    removing each other at the same moment.
CREATE FUNCTION organization_members_keep_last_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.org_id <> OLD.org_id) THEN
    PERFORM 1 FROM organizations WHERE org_id = OLD.org_id FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM organization_members
      WHERE org_id = OLD.org_id AND role = 'owner' AND user_id <> OLD.user_id
    ) THEN
      RAISE EXCEPTION 'organization % must keep at least one owner', OLD.org_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'last_owner';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER organization_members_last_owner
  BEFORE DELETE OR UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION organization_members_keep_last_owner();

-- 2. A new organization must have its owner by the end of the creating transaction.
CREATE FUNCTION organizations_require_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organization_members WHERE org_id = NEW.org_id AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'organization % was created without an owner', NEW.org_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'first_owner';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER organizations_first_owner
  AFTER INSERT ON organizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION organizations_require_owner();

CREATE TABLE organization_invites (
  invite_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (org_id),
  email       text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  role        text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by  uuid NOT NULL REFERENCES users (user_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE INDEX organization_invites_org_idx ON organization_invites (org_id, created_at DESC);

ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON organizations        USING (org_id = current_org_id());
CREATE POLICY org_isolation ON organization_members USING (org_id = current_org_id());
CREATE POLICY org_isolation ON organization_invites USING (org_id = current_org_id());

-- users has no org_id: you see yourself, plus members of the organization you're acting for.
CREATE POLICY users_visible ON users FOR SELECT USING (
  user_id = current_app_user_id()
  OR EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = users.user_id AND m.org_id = current_org_id()
  )
);
-- Accepting an invite creates the account, and the new user can only create themselves.
CREATE POLICY users_create_self ON users FOR INSERT WITH CHECK (user_id = current_app_user_id());
CREATE POLICY users_update_self ON users FOR UPDATE USING (user_id = current_app_user_id());

-- migrate:down
DROP POLICY users_visible ON users;
DROP TABLE organization_invites;
DROP TABLE organization_members;
DROP TABLE users;
DROP TABLE organizations;
DROP FUNCTION organizations_require_owner();
DROP FUNCTION organization_members_keep_last_owner();
DROP FUNCTION organizations_check_timezone();
DROP FUNCTION current_app_user_id();
DROP FUNCTION current_org_id();
