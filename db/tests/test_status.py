"""The node_status view: last-3 average, per-organization thresholds, offline override."""
from datetime import timedelta
import pytest
from psycopg2 import errors
from conftest import NOW


def add_runs(cur, org, confidences):
    for hours, confidence in enumerate(confidences):
        cur.execute('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                    "confidence, model_version) VALUES (%s, %s, %s, 'healthy', %s, 'status-test')",
                    (NOW + timedelta(seconds=hours + 1), org.org_id, org.node_id, confidence))


def status_of(cur, org):
    cur.execute('SELECT status, avg_confidence::float, classified_runs, last_runs '
                'FROM node_status WHERE org_id = %s AND node_id = %s', (org.org_id, org.node_id))
    return cur.fetchone()


def test_average_uses_only_the_latest_three(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        add_runs(cur, a, [0.99, 0.1, 0.2, 0.3])
        result = status_of(cur, a)
    assert result[0] == 'healthy'
    assert result[1] == 0.2
    assert result[2] == 3
    assert [round(v, 1) for v in result[3]] == [0.3, 0.2, 0.1]  # newest first


def test_status_bands_are_inclusive_at_the_threshold(db, orgs):
    a, _ = orgs
    for confidence, expected in ((0.49, 'healthy'), (0.5, 'suspected'), (0.79, 'suspected'), (0.8, 'alert')):
        with db('nakhel_owner') as cur:
            add_runs(cur, a, [confidence] * 3)
            assert status_of(cur, a)[0] == expected, confidence


def test_each_org_uses_its_own_thresholds(db, orgs):
    a, b = orgs
    with db('nakhel_owner') as cur:
        add_runs(cur, a, [0.6] * 3)
        add_runs(cur, b, [0.6] * 3)
        cur.execute('UPDATE organizations SET alert_threshold = 0.55, suspect_threshold = 0.4 '
                    'WHERE org_id = %s', (a.org_id,))
        assert status_of(cur, a)[0] == 'alert'
        assert status_of(cur, b)[0] == 'suspected'


def test_no_classifications_is_unknown(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('DELETE FROM classification_results WHERE node_id = %s', (a.node_id,))
        assert status_of(cur, a)[0] == 'unknown'


def test_no_health_data_is_never_offline(db, orgs):
    """D2: without heartbeats, silence proves nothing."""
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('DELETE FROM node_health WHERE node_id = %s', (a.node_id,))
        add_runs(cur, a, [0.1] * 3)
        assert status_of(cur, a)[0] == 'healthy'


def test_stale_heartbeat_overrides_to_offline(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        add_runs(cur, a, [0.95] * 3)
        cur.execute('DELETE FROM node_health WHERE node_id = %s', (a.node_id,))
        cur.execute('INSERT INTO node_health ("timestamp", org_id, node_id) VALUES (%s, %s, %s)',
                    (NOW - timedelta(hours=57), a.org_id, a.node_id))
        assert status_of(cur, a)[0] == 'offline'


def test_recent_heartbeat_is_not_offline(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        add_runs(cur, a, [0.95] * 3)
        cur.execute('DELETE FROM node_health WHERE node_id = %s', (a.node_id,))
        cur.execute('INSERT INTO node_health ("timestamp", org_id, node_id) VALUES (%s, %s, %s)',
                    (NOW - timedelta(hours=55), a.org_id, a.node_id))
        assert status_of(cur, a)[0] == 'alert'


def test_retired_nodes_are_not_monitored(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('UPDATE nodes SET active = false WHERE node_id = %s', (a.node_id,))
        assert status_of(cur, a) is None


class TestNodeCurrentStaysCorrect:
    """node_current is a cache written by triggers, so it must match a recompute from source."""
    def test_new_node_gets_a_row(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            cur.execute("INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label) "
                        "VALUES (%s, %s, 4242, 'New') RETURNING node_id", (a.org_id, a.cluster_id))
            node_id = cur.fetchone()[0]
            cur.execute('SELECT status FROM node_status WHERE node_id = %s', (node_id,))
            assert cur.fetchone()[0] == 'unknown'

    def test_late_arriving_old_result_does_not_displace_newer_ones(self, db, orgs):
        """A store-and-forward flush can deliver an older measurement after newer ones."""
        a, _ = orgs
        with db('nakhel_owner') as cur:
            add_runs(cur, a, [0.1, 0.1, 0.1])
            cur.execute('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                        "confidence, model_version) VALUES (%s, %s, %s, 'infested', 0.99, 'late')",
                        (NOW - timedelta(days=2), a.org_id, a.node_id))
            result = status_of(cur, a)
        assert result[0] == 'healthy' and result[1] == 0.1

    def test_written_through_the_worker_role(self, db, orgs):
        """The worker has no write access to node_current; the trigger must still update it."""
        a, _ = orgs
        with db('nakhel_worker') as cur:
            add_runs(cur, a, [0.9, 0.9, 0.9])
            cur.execute('SELECT status FROM node_status WHERE node_id = %s', (a.node_id,))
            assert cur.fetchone()[0] == 'alert'

    def test_app_roles_cannot_write_it(self, db, orgs):
        a, _ = orgs
        for role in ('nakhel_web', 'nakhel_worker'):
            with db(role, org=a.org_id) as cur:
                with pytest.raises(errors.InsufficientPrivilege):
                    cur.execute('UPDATE node_current SET avg_confidence = 0')

    def test_triggers_cannot_be_called_to_recompute_by_app_roles(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute('SELECT node_current_refresh_health(%s)', (a.node_id,))

    def test_matches_a_full_recompute_on_seed_data(self, db, orgs):
        with db('nakhel_owner') as cur:
            cur.execute("""
                SELECT nc.node_id FROM node_current nc
                CROSS JOIN LATERAL (
                  SELECT avg(l.confidence)::numeric(4,3) AS a, count(*)::int AS n FROM (
                    SELECT c.confidence FROM classification_results c
                    WHERE c.node_id = nc.node_id
                    ORDER BY c."timestamp" DESC, c.processed_at DESC LIMIT 3) l
                ) r
                WHERE nc.avg_confidence IS DISTINCT FROM r.a OR nc.classified_runs <> r.n""")
            assert cur.fetchall() == []
