"""Each role can do exactly what it should, and nothing more."""
from datetime import timedelta
from psycopg2 import errors
import pytest
from conftest import NOW, insert_feature, mfcc_matrix

ALL = {'SELECT', 'INSERT', 'UPDATE', 'DELETE'}
TABLES = ['organizations', 'users', 'organization_members', 'organization_invites', 'cluster_heads',
          'nodes', 'acoustic_features', 'node_health', 'cluster_health', 'classification_results',
          'alert_log', 'ingest_rejects', 'node_status', 'node_current', 'schema_migrations']

# For each role: table -> privileges held on at least one column. Everything else must be absent.
EXPECTED = {
    'nakhel_web': {
        'organizations': {'SELECT', 'UPDATE'},
        'users': {'SELECT', 'INSERT', 'UPDATE'},
        'organization_members': {'SELECT', 'INSERT', 'UPDATE', 'DELETE'},
        'organization_invites': {'SELECT', 'INSERT', 'UPDATE', 'DELETE'},
        'cluster_heads': {'SELECT', 'INSERT', 'UPDATE'},
        'nodes': {'SELECT', 'INSERT', 'UPDATE'},
        'acoustic_features': {'SELECT', 'INSERT'},
        'node_health': {'SELECT', 'INSERT'},
        'cluster_health': {'SELECT', 'INSERT'},
        'classification_results': {'SELECT'},
        'alert_log': {'SELECT', 'UPDATE'},
        'ingest_rejects': {'SELECT', 'INSERT'},
        'node_status': {'SELECT'},
        'node_current': {'SELECT'},
    },
    'nakhel_worker': {
        'organizations': {'SELECT'},
        'users': {'SELECT'},
        'organization_members': {'SELECT'},
        'cluster_heads': {'SELECT'},
        'nodes': {'SELECT'},
        'acoustic_features': {'SELECT', 'UPDATE'},
        'node_health': {'SELECT'},
        'cluster_health': {'SELECT'},
        'classification_results': {'SELECT', 'INSERT'},
        'alert_log': {'SELECT', 'INSERT', 'UPDATE'},
        'node_status': {'SELECT'},
        'node_current': {'SELECT'},
    },
}


@pytest.mark.parametrize('role', EXPECTED)
@pytest.mark.parametrize('table', TABLES)
def test_exact_privilege_matrix(db, role, table):
    with db('postgres') as cur:
        held = set()
        for privilege in ALL:
            if privilege != 'DELETE':  # DELETE has no column-level form
                cur.execute('SELECT has_any_column_privilege(%s, %s, %s)', (role, table, privilege))
                if cur.fetchone()[0]:
                    held.add(privilege)
            cur.execute('SELECT has_table_privilege(%s, %s, %s)', (role, table, privilege))
            if cur.fetchone()[0]:
                held.add(privilege)
    assert held == EXPECTED[role].get(table, set())


@pytest.mark.parametrize('role,bypass', [('nakhel_owner', False), ('nakhel_web', False), ('nakhel_worker', True)])
def test_role_attributes(db, role, bypass):
    with db('postgres') as cur:
        cur.execute('SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles '
                    'WHERE rolname = %s', (role,))
        assert cur.fetchone() == (False, False, False, bypass)


@pytest.mark.parametrize('role', ['nakhel_web', 'nakhel_worker'])
def test_app_roles_own_nothing_and_cannot_change_schema(db, role):
    with db(role) as cur:
        with pytest.raises(errors.InsufficientPrivilege):
            cur.execute('CREATE TABLE sneaky (id int)')
    with db(role) as cur:
        with pytest.raises(errors.InsufficientPrivilege):
            cur.execute('ALTER TABLE nodes DISABLE ROW LEVEL SECURITY')
    with db(role) as cur:
        with pytest.raises(errors.InsufficientPrivilege):
            cur.execute('TRUNCATE alert_log')
    with db('postgres') as cur:
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = %s", (role,))
        assert cur.fetchone()[0] == 0


class TestWeb:
    def test_can_set_only_allowed_measurement_columns(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            insert_feature(cur, a.org_id, a.node_id, a.cluster_id, NOW - timedelta(hours=2))
            cur.execute('SELECT status, ingested_at IS NOT NULL FROM acoustic_features '
                        'WHERE "timestamp" = %s AND node_id = %s',
                        (NOW - timedelta(hours=2), a.node_id))
            assert cur.fetchone() == ('pending', True)
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('INSERT INTO acoustic_features ("timestamp", org_id, node_id, cluster_id, '
                            "mfcc, status) VALUES (now(), %s, %s, %s, %s::real[], 'classified')",
                            (a.org_id, a.node_id, a.cluster_id, mfcc_matrix()))

    def test_cannot_write_classifications(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                            "confidence, model_version) VALUES (now(), %s, %s, 'healthy', 0, 'm')",
                            (a.org_id, a.node_id))

    def test_cannot_edit_or_delete_measurements(self, db, orgs):
        a, _ = orgs
        for sql in ("UPDATE acoustic_features SET status = 'classified'", 'DELETE FROM acoustic_features'):
            with db('nakhel_web', org=a.org_id) as cur:
                with pytest.raises(errors.InsufficientPrivilege):
                    cur.execute(sql)

    def test_can_acknowledge_but_not_rewrite_alerts(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute('UPDATE alert_log SET acknowledged = true, acknowledged_by = %s, '
                        'acknowledged_at = now() WHERE alert_id = %s', (a.owner, a.alert_id))
            assert cur.rowcount == 1
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute("UPDATE alert_log SET message = 'x'")

    def test_cannot_read_api_key_hashes(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('SELECT api_key_hash FROM cluster_heads')

    def test_manages_settings(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute('UPDATE organizations SET alert_threshold = 0.9 WHERE org_id = %s', (a.org_id,))
            assert cur.rowcount == 1
            cur.execute('UPDATE cluster_heads SET revoked = true WHERE cluster_id = %s', (a.cluster_id,))
            assert cur.rowcount == 1
            cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label) '
                        "VALUES (%s, %s, 77, 'New')", (a.org_id, a.cluster_id))

    def test_cannot_change_slug_or_create_org(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute("UPDATE organizations SET slug = 'x'")
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute("INSERT INTO organizations (name, slug) VALUES ('x', 'x')")

    def test_lookup_functions_closed_to_worker(self, db):
        with db('nakhel_worker') as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute("SELECT * FROM auth_user_by_email('a@b.c')")


class TestWorker:
    def test_full_cycle_for_a_pending_row(self, db, orgs):
        """Claim -> classify -> mark done -> alert -> email stamp, without setting an org."""
        a, _ = orgs
        ts = NOW - timedelta(hours=3)
        with db('nakhel_owner') as cur:
            insert_feature(cur, a.org_id, a.node_id, a.cluster_id, ts)
            cur.connection.commit()
        with db('nakhel_worker') as cur:
            cur.execute('SELECT "timestamp", org_id, node_id FROM acoustic_features '
                        "WHERE status = 'pending' AND node_id = %s AND \"timestamp\" = %s "
                        'FOR UPDATE SKIP LOCKED', (a.node_id, ts))
            assert cur.fetchone()[1] == a.org_id
            cur.execute('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                        "confidence, model_version) VALUES (%s, %s, %s, 'infested', 0.9, 'w')",
                        (ts, a.org_id, a.node_id))
            cur.execute("UPDATE acoustic_features SET status = 'classified' "
                        'WHERE node_id = %s AND "timestamp" = %s', (a.node_id, ts))
            assert cur.rowcount == 1
            cur.execute('INSERT INTO alert_log (org_id, "timestamp", node_id, alert_type, severity, '
                        "message) VALUES (%s, %s, %s, 'infestation_detected', 'critical', 'x') "
                        'RETURNING alert_id', (a.org_id, ts, a.node_id))
            alert_id = cur.fetchone()[0]
            cur.execute('UPDATE alert_log SET email_sent_at = now() WHERE alert_id = %s', (alert_id,))
        with db('nakhel_owner') as cur:
            cur.execute('DELETE FROM acoustic_features WHERE node_id = %s AND "timestamp" = %s',
                        (a.node_id, ts))
            cur.connection.commit()

    def test_can_find_each_orgs_owners(self, db, orgs):
        _, b = orgs
        with db('nakhel_worker') as cur:
            cur.execute("SELECT u.email FROM organization_members m JOIN users u USING (user_id) "
                        "WHERE m.org_id = %s AND m.role = 'owner'", (b.org_id,))
            assert 'owner@test-b.test' in [r[0] for r in cur.fetchall()]

    @pytest.mark.parametrize('sql', [
        'SELECT password_hash FROM users',
        'SELECT api_key_hash FROM cluster_heads',
        'SELECT token_hash FROM organization_invites',
        "UPDATE acoustic_features SET snr_db = 1",
        'DELETE FROM classification_results',
        "UPDATE alert_log SET message = 'x'",
        "UPDATE nodes SET tree_label = 'x'",
        "UPDATE organizations SET name = 'x'",
    ])
    def test_denied(self, db, sql):
        with db('nakhel_worker') as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute(sql)
