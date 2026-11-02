"""Brief section 11: organizations cannot see or touch each other's data."""
from datetime import timedelta
from psycopg2 import errors
import pytest
from conftest import HASH, NOW, connect, insert_feature, key_hash, lock_chunks, mfcc_matrix

TENANT_TABLES = ['organizations', 'organization_members', 'organization_invites', 'cluster_heads',
                 'nodes', 'acoustic_features', 'node_health', 'cluster_health',
                 'classification_results', 'alert_log', 'ingest_rejects', 'node_current']


@pytest.mark.parametrize('table', TENANT_TABLES + ['users'])
def test_unset_org_returns_zero_rows(db, orgs, table):
    with db('nakhel_web') as cur:
        cur.execute(f'SELECT count(*) FROM {table}')
        assert cur.fetchone()[0] == 0


def test_view_returns_zero_rows_when_unset(db, orgs):
    with db('nakhel_web') as cur:
        cur.execute('SELECT count(*) FROM node_status')
        assert cur.fetchone()[0] == 0


@pytest.mark.parametrize('table', TENANT_TABLES)
def test_reverted_setting_returns_zero_rows_not_an_error(orgs, table):
    """After SET LOCAL ends, the setting on a pooled connection is '' rather than NULL."""
    a, _ = orgs
    conn = connect('nakhel_web')
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.current_org', %s, true)", (str(a.org_id),))
        conn.commit()
        cur.execute("SELECT current_setting('app.current_org', true)")
        assert cur.fetchone()[0] == ''
        cur.execute(f'SELECT count(*) FROM {table}')
        assert cur.fetchone()[0] == 0
    conn.close()


@pytest.mark.parametrize('table', TENANT_TABLES)
def test_org_a_sees_only_org_a(db, orgs, table):
    a, b = orgs
    with db('nakhel_web', org=a.org_id) as cur:
        cur.execute(f'SELECT DISTINCT org_id FROM {table}')
        assert [r[0] for r in cur.fetchall()] == [a.org_id]
    with db('nakhel_web', org=b.org_id) as cur:
        cur.execute(f'SELECT DISTINCT org_id FROM {table}')
        assert [r[0] for r in cur.fetchall()] == [b.org_id]


def test_lookup_by_another_orgs_id_finds_nothing(db, orgs):
    a, b = orgs
    with db('nakhel_web', org=a.org_id) as cur:
        cur.execute('SELECT * FROM nodes WHERE node_id = %s', (b.node_id,))
        assert cur.fetchall() == []
        cur.execute('SELECT * FROM node_status WHERE node_id = %s', (b.node_id,))
        assert cur.fetchall() == []
        cur.execute('SELECT * FROM alert_log WHERE alert_id = %s', (b.alert_id,))
        assert cur.fetchall() == []


class TestWritesToAnotherOrg:
    """With organization A set, rows tagged with B are refused."""
    def test_measurement(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege, match='row-level security'):
                insert_feature(cur, b.org_id, b.node_id, b.cluster_id, NOW - timedelta(hours=1))

    def test_node(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label) '
                            "VALUES (%s, %s, 7, 'T')", (b.org_id, b.cluster_id))

    def test_node_health(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('INSERT INTO node_health ("timestamp", org_id, node_id) VALUES (%s, %s, %s)',
                            (NOW - timedelta(hours=1), b.org_id, b.node_id))

    def test_add_self_to_other_org(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                            (b.org_id, a.owner))

    def test_unset_org_cannot_write(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web') as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, NOW - timedelta(hours=1))

    @pytest.mark.parametrize('sql,idx', [
        ("UPDATE nodes SET tree_label = 'hacked' WHERE node_id = %s", 'node_id'),
        ("UPDATE alert_log SET message = 'x' WHERE alert_id = %s", 'alert_id'),
    ])
    def test_updates_reach_no_rows_or_are_denied(self, db, orgs, sql, idx):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            try:
                cur.execute(sql, (getattr(b, idx),))
                assert cur.rowcount == 0
            except errors.InsufficientPrivilege:
                pass

    def test_acknowledging_another_orgs_alert_changes_nothing(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute('UPDATE alert_log SET acknowledged = true, acknowledged_by = %s, '
                        'acknowledged_at = now() WHERE alert_id = %s', (a.owner, b.alert_id))
            assert cur.rowcount == 0

    def test_removing_another_orgs_member_changes_nothing(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute('DELETE FROM organization_members WHERE org_id = %s', (b.org_id,))
            assert cur.rowcount == 0

    def test_reading_settings_of_another_org(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute("UPDATE organizations SET name = 'x' WHERE org_id = %s", (b.org_id,))
            assert cur.rowcount == 0

    def test_org_id_cannot_be_moved(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('UPDATE nodes SET org_id = %s WHERE node_id = %s', (b.org_id, a.node_id))


class TestCompositeForeignKeys:
    """Even the owner role, which skips RLS, can't mix organizations."""
    def test_measurement_org_must_match_node(self, db, orgs):
        a, b = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.ForeignKeyViolation):
                insert_feature(cur, a.org_id, b.node_id, a.cluster_id, NOW - timedelta(hours=1))

    def test_measurement_org_must_match_cluster(self, db, orgs):
        a, b = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.ForeignKeyViolation):
                insert_feature(cur, a.org_id, a.node_id, b.cluster_id, NOW - timedelta(hours=1))

    def test_node_org_must_match_cluster(self, db, orgs):
        a, b = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.ForeignKeyViolation):
                cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label) '
                            "VALUES (%s, %s, 9, 'T')", (a.org_id, b.cluster_id))

    @pytest.mark.parametrize('sql', [
        'INSERT INTO node_health ("timestamp", org_id, node_id) VALUES (now(), %s, %s)',
        'INSERT INTO classification_results ("timestamp", org_id, node_id, label, confidence, '
        "model_version) VALUES (now(), %s, %s, 'healthy', 0.1, 'm')",
        'INSERT INTO alert_log ("timestamp", org_id, node_id, alert_type, severity, message) '
        "VALUES (now(), %s, %s, 'low_battery', 'info', 'm')",
    ])
    def test_node_reference_org_must_match(self, db, orgs, sql):
        a, b = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.ForeignKeyViolation):
                cur.execute(sql, (a.org_id, b.node_id))

    def test_cluster_health_org_must_match(self, db, orgs):
        a, b = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.ForeignKeyViolation):
                cur.execute('INSERT INTO cluster_health ("timestamp", org_id, cluster_id) '
                            'VALUES (now(), %s, %s)', (a.org_id, b.cluster_id))


def test_same_lora_id_in_two_orgs_stays_two_nodes(db, orgs):
    a, b = orgs
    assert a.node_id != b.node_id
    for org in (a, b):
        with db('nakhel_web', org=org.org_id) as cur:
            cur.execute('SELECT node_id FROM nodes WHERE cluster_id = %s AND lora_id = 100',
                        (org.cluster_id,))
            assert [r[0] for r in cur.fetchall()] == [org.node_id]


class TestApiKeyLookup:
    def test_key_resolves_to_its_own_org(self, db, orgs):
        a, b = orgs
        for org in (a, b):
            with db('nakhel_web') as cur:
                cur.execute('SELECT cluster_id, org_id FROM ingest_auth(%s)', (key_hash(org.raw_key),))
                assert cur.fetchall() == [(org.cluster_id, org.org_id)]

    def test_key_from_a_cannot_write_to_b(self, db, orgs):
        """The whole ingest path: A's key sets org A, and B's node then can't be reached."""
        a, b = orgs
        with db('nakhel_web') as cur:
            cur.execute('SELECT cluster_id, org_id FROM ingest_auth(%s)', (key_hash(a.raw_key),))
            cluster_id, org_id = cur.fetchone()
            cur.execute("SELECT set_config('app.current_org', %s, true)", (str(org_id),))
            cur.execute('SELECT count(*) FROM nodes WHERE cluster_id = %s AND lora_id = 100',
                        (b.cluster_id,))
            assert cur.fetchone()[0] == 0
            with pytest.raises(errors.InsufficientPrivilege):
                insert_feature(cur, b.org_id, b.node_id, b.cluster_id, NOW - timedelta(hours=1))
            assert cluster_id == a.cluster_id

    def test_unknown_and_revoked_keys_match_nothing(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web') as cur:
            cur.execute('SELECT * FROM ingest_auth(%s)', (key_hash('nonsense'),))
            assert cur.fetchall() == []
        with db('nakhel_owner') as cur:
            cur.execute('UPDATE cluster_heads SET revoked = true WHERE cluster_id = %s', (a.cluster_id,))
            cur.execute('SELECT * FROM ingest_auth(%s)', (key_hash(a.raw_key),))
            assert cur.fetchall() == []


class TestUsersVisibility:
    def test_sees_own_org_members_only(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute('SELECT user_id::text FROM users')
            seen = {r[0] for r in cur.fetchall()}
        assert a.owner in seen and b.owner not in seen

    def test_cannot_read_password_hash(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('SELECT password_hash FROM users')

    def test_login_lookup_returns_the_hash_only_through_the_function(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web') as cur:
            cur.execute('SELECT user_id::text, password_hash FROM auth_user_by_email(%s)',
                        ('OWNER@test-a.test',))
            assert cur.fetchone() == (a.owner, HASH)

    def test_cannot_change_another_user(self, db, orgs):
        a, b = orgs
        with db('nakhel_web', org=a.org_id, user=a.owner) as cur:
            cur.execute("UPDATE users SET name = 'x' WHERE user_id = %s", (b.owner,))
            assert cur.rowcount == 0
            cur.execute("UPDATE users SET name = 'Me' WHERE user_id = %s", (a.owner,))
            assert cur.rowcount == 1

    def test_cannot_create_someone_else(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', user=a.owner) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute("INSERT INTO users (user_id, email, name, password_hash) VALUES "
                            "(gen_random_uuid(), 'z@z.test', 'Z', %s)", (HASH,))

    def test_memberships_lookup_is_per_user(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web') as cur:
            cur.execute('SELECT org_id FROM auth_memberships(%s)', (a.owner,))
            assert [r[0] for r in cur.fetchall()] == [a.org_id]

    def test_user_can_belong_to_several_orgs(self, db, orgs):
        a, b = orgs
        with db('nakhel_owner') as cur:
            cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                        (b.org_id, a.owner))
            cur.execute('SELECT count(*) FROM auth_memberships(%s)', (a.owner,))
            assert cur.fetchone()[0] == 2


class TestInviteFlow:
    def test_open_invite_is_found_and_says_who_it_is_for(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web') as cur:
            cur.execute('SELECT org_id, email, account_exists FROM invite_by_token(%s)',
                        (key_hash('invite-test-a'),))
            assert cur.fetchone() == (a.org_id, 'new@test-a.test', False)

    def test_used_and_expired_invites_are_not_found(self, db, orgs):
        a, _ = orgs
        token = key_hash('invite-test-a')
        with db('nakhel_owner') as cur:
            cur.execute('UPDATE organization_invites SET accepted_at = now() WHERE invite_id = %s',
                        (a.invite_id,))
            cur.execute('SELECT count(*) FROM invite_by_token(%s)', (token,))
            assert cur.fetchone()[0] == 0
        with db('nakhel_owner') as cur:
            cur.execute("UPDATE organization_invites SET expires_at = now() - INTERVAL '1 second' "
                        'WHERE invite_id = %s', (a.invite_id,))
            cur.execute('SELECT count(*) FROM invite_by_token(%s)', (token,))
            assert cur.fetchone()[0] == 0

    def test_accepting_works_under_rls(self, db, orgs):
        """New account joins: everything through nakhel_web with org and user set."""
        a, _ = orgs
        new_user = '00000000-0000-4000-8000-000000000001'
        with db('nakhel_web', org=a.org_id, user=new_user) as cur:
            cur.execute('INSERT INTO users (user_id, email, name, password_hash) VALUES (%s, %s, %s, %s)',
                        (new_user, 'new@test-a.test', 'New', HASH))
            cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                        (a.org_id, new_user))
            cur.execute('UPDATE organization_invites SET accepted_at = now() WHERE invite_id = %s',
                        (a.invite_id,))
            assert cur.rowcount == 1
            cur.execute('SELECT count(*) FROM users WHERE user_id = %s', (new_user,))
            assert cur.fetchone()[0] == 1


class TestChunksCannotBypassRls:
    """TimescaleDB copies a hypertable's GRANTs onto each chunk but not its RLS, so without
    lock_down_chunks() nakhel_web could read every organization's rows by naming a chunk."""
    HYPERTABLES = ['acoustic_features', 'node_health', 'cluster_health',
                   'classification_results', 'ingest_rejects']

    @pytest.mark.parametrize('role', ['nakhel_web', 'nakhel_worker'])
    @pytest.mark.parametrize('table', HYPERTABLES)
    def test_direct_chunk_read_is_denied(self, db, orgs, role, table):
        with db('postgres') as cur:
            cur.execute('SELECT chunk_schema, chunk_name FROM timescaledb_information.chunks '
                        'WHERE hypertable_name = %s LIMIT 1', (table,))
            schema, chunk = cur.fetchone()
        with db(role) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute(f'SELECT * FROM "{schema}"."{chunk}"')

    def test_no_chunk_keeps_any_app_role_privilege(self, db, orgs):
        with db('postgres') as cur:
            cur.execute("""
                SELECT ch.chunk_name, r.role
                FROM timescaledb_information.chunks ch
                CROSS JOIN (VALUES ('nakhel_web'), ('nakhel_worker')) AS r(role)
                CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) AS p(priv)
                WHERE has_any_column_privilege(
                        r.role, format('%I.%I', ch.chunk_schema, ch.chunk_name), p.priv)""")
            assert cur.fetchall() == []

    def test_job_is_scheduled_every_minute(self, db):
        with db('postgres') as cur:
            cur.execute("SELECT schedule_interval, scheduled FROM timescaledb_information.jobs "
                        "WHERE proc_name = 'lock_down_chunks'")
            assert cur.fetchone() == (timedelta(minutes=1), True)

    def test_new_chunk_is_usable_then_locked_then_still_usable(self, orgs):
        """A store-and-forward flush can land in a time range with no chunk yet."""
        a, _ = orgs
        first, second = NOW - timedelta(days=200), NOW - timedelta(days=200, hours=1)
        web = connect('nakhel_web')
        owner = connect('nakhel_owner')
        try:
            with web, web.cursor() as cur:   # creates the chunk
                cur.execute("SELECT set_config('app.current_org', %s, true)", (str(a.org_id),))
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, first)
            with owner, owner.cursor() as cur:
                lock_chunks(cur)
            with web, web.cursor() as cur:   # the same chunk, now locked
                cur.execute("SELECT set_config('app.current_org', %s, true)", (str(a.org_id),))
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, second)
                cur.execute('INSERT INTO acoustic_features ("timestamp", org_id, node_id, cluster_id, mfcc) '
                            'VALUES (%s, %s, %s, %s, %s::real[]) '
                            'ON CONFLICT (node_id, "timestamp") DO NOTHING',
                            (first, a.org_id, a.node_id, a.cluster_id, mfcc_matrix()))
                assert cur.rowcount == 0
                cur.execute('SELECT count(*) FROM acoustic_features WHERE "timestamp" IN (%s, %s)',
                            (first, second))
                assert cur.fetchone()[0] == 2
        finally:
            with owner, owner.cursor() as cur:
                cur.execute('DELETE FROM acoustic_features WHERE "timestamp" IN (%s, %s)', (first, second))
            web.close()
            owner.close()

    def test_worker_can_lock_and_update_rows_in_a_locked_chunk(self, orgs):
        a, _ = orgs
        ts = NOW - timedelta(days=201)
        owner, worker = connect('nakhel_owner'), connect('nakhel_worker')
        try:
            with owner, owner.cursor() as cur:
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, ts)
                lock_chunks(cur)
            with worker, worker.cursor() as cur:
                cur.execute("SELECT node_id FROM acoustic_features WHERE status = 'pending' "
                            'AND "timestamp" = %s FOR UPDATE SKIP LOCKED', (ts,))
                assert cur.fetchone()[0] == a.node_id
                cur.execute("UPDATE acoustic_features SET status = 'classified' "
                            'WHERE node_id = %s AND "timestamp" = %s', (a.node_id, ts))
                assert cur.rowcount == 1
        finally:
            with owner, owner.cursor() as cur:
                cur.execute('DELETE FROM acoustic_features WHERE "timestamp" = %s', (ts,))
            owner.close()
            worker.close()


def test_retention_job_really_drops_old_data(orgs):
    """Runs the actual policy, with the schema closed and row-level security on."""
    a, _ = orgs
    old, kept = NOW - timedelta(days=500), NOW - timedelta(days=100)
    conn = connect('nakhel_owner')
    with conn, conn.cursor() as cur:
        insert_feature(cur, a.org_id, a.node_id, a.cluster_id, old)
        insert_feature(cur, a.org_id, a.node_id, a.cluster_id, kept)
        cur.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention' "
                    "AND hypertable_name = 'acoustic_features'")
        job_id = cur.fetchone()[0]
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute('CALL run_job(%s)', (job_id,))
        cur.execute('SELECT "timestamp" FROM acoustic_features WHERE "timestamp" IN (%s, %s)', (old, kept))
        remaining = [r[0] for r in cur.fetchall()]
        cur.execute('DELETE FROM acoustic_features WHERE "timestamp" = %s', (kept,))
    conn.close()
    assert remaining == [kept]


def test_worker_sees_every_org_and_copies_org_id(db, orgs):
    a, b = orgs
    with db('nakhel_worker') as cur:
        cur.execute('SELECT DISTINCT org_id FROM nodes WHERE node_id = ANY(%s)',
                    ([a.node_id, b.node_id],))
        assert {r[0] for r in cur.fetchall()} == {a.org_id, b.org_id}
