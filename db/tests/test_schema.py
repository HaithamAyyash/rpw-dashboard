"""The database that the migrations build: tables, hypertables, retention, security wiring."""
EXPECTED_TABLES = {
    'organizations', 'users', 'organization_members', 'organization_invites', 'cluster_heads',
    'nodes', 'acoustic_features', 'node_health', 'cluster_health', 'classification_results',
    'alert_log', 'ingest_rejects', 'node_current', 'schema_migrations',
}
HYPERTABLES = {'acoustic_features', 'node_health', 'cluster_health', 'classification_results',
               'ingest_rejects'}
# Everything except organizations/users (organizations' key IS org_id) carries org_id directly.
NOT_INDEXED_BY_ORG = {
    # Not dashboard queries: uniqueness rules, or lookups before the org is known.
    'organizations_pkey', 'organizations_slug_key', 'users_pkey', 'users_email_key',
    'organization_members_user_idx', 'organization_invites_pkey',
    'organization_invites_token_hash_key', 'cluster_heads_pkey', 'cluster_heads_api_key_hash_key',
    'nodes_pkey', 'nodes_active_lora_uidx', 'node_current_node_id_key',
    'alert_log_unsent_idx', 'alert_log_pkey', 'schema_migrations_pkey',
    'acoustic_features_node_id_timestamp_key', 'acoustic_features_pending_idx',
    'node_health_node_id_timestamp_key', 'cluster_health_cluster_id_timestamp_key',
    'classification_results_node_id_timestamp_model_version_key',
}


def test_all_tables_exist(db):
    with db('postgres') as cur:
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        assert {r[0] for r in cur.fetchall()} == EXPECTED_TABLES


def test_all_migrations_recorded(db):
    with db('postgres') as cur:
        cur.execute('SELECT count(*) FROM schema_migrations')
        assert cur.fetchone()[0] == 12


def test_hypertables(db):
    with db('postgres') as cur:
        cur.execute('SELECT hypertable_name FROM timescaledb_information.hypertables')
        assert {r[0] for r in cur.fetchall()} == HYPERTABLES


def test_alert_log_is_a_regular_table(db):
    with db('postgres') as cur:
        cur.execute("SELECT count(*) FROM timescaledb_information.hypertables "
                    "WHERE hypertable_name = 'alert_log'")
        assert cur.fetchone()[0] == 0


def test_retention_policies(db):
    with db('postgres') as cur:
        cur.execute("SELECT hypertable_name, config->>'drop_after' FROM timescaledb_information.jobs "
                    "WHERE proc_name = 'policy_retention'")
        policies = dict(cur.fetchall())
    assert policies == {
        'acoustic_features': '1 year', 'classification_results': '1 year',
        'node_health': '1 year', 'cluster_health': '1 year', 'ingest_rejects': '90 days',
    }


def test_every_time_column_is_timestamptz(db):
    with db('postgres') as cur:
        cur.execute("SELECT table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'")
        assert cur.fetchall() == []


def test_every_table_with_org_id_has_rls_and_a_policy(db):
    """Catches a future table someone forgets to protect: RLS mistakes are otherwise silent."""
    with db('postgres') as cur:
        cur.execute("""
            SELECT c.relname, c.relrowsecurity,
                   (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
            FROM pg_class c
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'""")
        rows = cur.fetchall()
    assert len(rows) == 12  # all tenant tables except users
    for name, rls_on, policies in rows:
        assert rls_on, f'{name}: RLS is off'
        assert policies >= 1, f'{name}: no policy, so every row would be invisible'


def test_users_has_rls(db):
    with db('postgres') as cur:
        cur.execute("SELECT relrowsecurity FROM pg_class WHERE relname = 'users'")
        assert cur.fetchone()[0] is True


def test_dashboard_indexes_start_with_org_id(db):
    with db('postgres') as cur:
        cur.execute("""
            SELECT i.indexname, i.indexdef FROM pg_indexes i
            WHERE i.schemaname = 'public'""")
        indexes = cur.fetchall()
    for name, definition in indexes:
        if name in NOT_INDEXED_BY_ORG:
            continue
        columns = definition.split('(', 1)[1]
        assert columns.startswith('org_id'), f'{name} does not start with org_id: {definition}'


def test_definer_functions_are_pinned_and_not_public(db):
    """A SECURITY DEFINER function without a fixed search_path can be hijacked."""
    with db('postgres') as cur:
        cur.execute("""
            SELECT p.proname, p.proconfig, p.proacl::text FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef""")
        functions = {r[0]: r[1:] for r in cur.fetchall()}
    assert {'ingest_auth', 'auth_user_by_email', 'auth_memberships',
            'invite_by_token'} <= set(functions)
    for name, (config, acl) in functions.items():
        assert config and any(c.startswith('search_path=') for c in config), name
        if not name.startswith('organization'):
            # An empty grantee ("=X/...") in an ACL means PUBLIC.
            assert '{=' not in acl and ',=' not in acl, f'{name} is executable by PUBLIC: {acl}'


def test_only_expected_functions_bypass_rls(db):
    with db('postgres') as cur:
        cur.execute("""
            SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef""")
        assert {r[0] for r in cur.fetchall()} == {
            'ingest_auth', 'auth_user_by_email', 'auth_memberships', 'invite_by_token',
            'organization_members_keep_last_owner', 'organizations_require_owner',
            'node_current_refresh_classification', 'node_current_refresh_health',
            'node_current_on_classification', 'node_current_on_health', 'node_current_on_node'}
