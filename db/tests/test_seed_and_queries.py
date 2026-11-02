"""Seed data looks right, and every file in db/queries runs and returns its declared columns."""
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
import seed as seed_module
from nakhel_fake.schedule import WAKE_HOURS, wake_times
from conftest import HOST, connect

QUERIES = sorted((Path(__file__).resolve().parents[1] / 'queries').glob('*.sql'))
DUBAI = 'Asia/Dubai'
NOW = datetime.now(timezone.utc)

# Argument values to try, by parameter name.
ARGS = {
    'zone': 'Zone A', 'status': 'healthy', 'q': 'PLM', 'limit': 50, 'offset': 0, 'node_id': None,
    'from': NOW - timedelta(days=3), 'to': NOW + timedelta(hours=1), 'bucket': '1 hour',
    'label': 'healthy', 'min_conf': 0.0, 'sort': 'time_desc', 'severity': None,
    'acknowledged': None, 'include_mfcc': False, 'batch': 5,
}


def parse_header(path):
    text = path.read_text()
    params = re.search(r'^-- @params (.+)$', text, re.M)
    returns = re.search(r'^-- @returns (.+)$', text, re.M)
    assert returns, f'{path.name} has no @returns line'
    parsed = [p.split(':') for p in params.group(1).split()] if params else []
    return text, parsed, [c.strip() for c in returns.group(1).split(',')]


@pytest.fixture(scope='module')
def seeded():
    assert seed_module.main(['--days', '6', '--host', HOST]) == 0
    conn = connect('nakhel_owner')
    with conn.cursor() as cur:
        cur.execute("SELECT slug, org_id FROM organizations WHERE slug LIKE '%%-demo'")
        org_ids = dict(cur.fetchall())
        cur.execute('SELECT n.org_id, min(n.node_id) FROM nodes n GROUP BY 1')
        nodes = dict(cur.fetchall())
    conn.close()
    return {slug: (org_id, nodes[org_id]) for slug, org_id in org_ids.items()}


def run(cur, path, overrides=None):
    text, params, _ = parse_header(path)
    values = {**ARGS, **(overrides or {})}
    if params:
        types = ', '.join(t for _, t in params)
        cur.execute(f'PREPARE q({types}) AS {text.rstrip().rstrip(";")}')
        cur.execute(f'EXECUTE q({", ".join(["%s"] * len(params))})', [values[n] for n, _ in params])
    else:
        cur.execute(text)
    rows = cur.fetchall()
    columns = [d[0] for d in cur.description]
    if params:
        cur.execute('DEALLOCATE q')
    return columns, rows


def test_there_is_a_query_for_every_screen():
    names = {p.stem for p in QUERIES}
    assert {'summary_cards', 'tree_cards', 'map_nodes', 'map_clusters', 'energy_node',
            'energy_overview', 'classification_latest', 'alerts', 'historical_records',
            'node_health', 'cluster_health'} <= names


@pytest.mark.parametrize('path', QUERIES, ids=lambda p: p.stem)
def test_query_runs_and_returns_declared_columns(db, seeded, path):
    _, _, declared = parse_header(path)
    org_id, node_id = seeded['al-ain-demo']
    role = 'nakhel_worker' if path.stem.startswith('worker_') else 'nakhel_web'
    with db(role, org=org_id if role == 'nakhel_web' else None) as cur:
        columns, _ = run(cur, path, {'node_id': node_id})
    assert columns == declared


@pytest.mark.parametrize('path', [p for p in QUERIES if not p.stem.startswith('worker_')],
                         ids=lambda p: p.stem)
def test_query_returns_nothing_of_other_orgs(db, seeded, path):
    """Every dashboard query, with B's node ID, as A: no row may mention B."""
    org_a, _ = seeded['al-ain-demo']
    org_b, node_b = seeded['oasis-palm-demo']
    with db('nakhel_web', org=org_a) as cur:
        _, rows = run(cur, path, {'node_id': node_b, 'zone': None, 'status': None, 'q': None,
                                  'label': None, 'min_conf': None})
    if path.stem in ('tree_detail', 'energy_node'):
        assert rows == []
    assert not any(node_b in row for row in rows)
    assert not any(org_b in row for row in rows)


@pytest.mark.parametrize('path', [p for p in QUERIES if not p.stem.startswith('worker_')],
                         ids=lambda p: p.stem)
def test_query_returns_no_rows_without_an_org(db, seeded, path):
    with db('nakhel_web') as cur:
        _, rows = run(cur, path, {'zone': None, 'status': None, 'q': None, 'label': None,
                                  'min_conf': None})
    if path.stem in ('summary_cards', 'pipeline_latency', 'history_summary'):
        # Aggregates always produce one row; it must count nothing.
        assert rows[0][0] == 0
    else:
        assert rows == []


class TestSeed:
    def test_orgs_reuse_lora_ids_as_separate_nodes(self, db, seeded):
        org_a, _ = seeded['al-ain-demo']
        org_b, _ = seeded['oasis-palm-demo']
        with db('nakhel_owner') as cur:
            cur.execute('SELECT lora_id, count(DISTINCT org_id), count(DISTINCT node_id) FROM nodes '
                        'WHERE org_id = ANY(%s::uuid[]) GROUP BY 1 HAVING count(DISTINCT org_id) = 2',
                        ([str(org_a), str(org_b)],))
            shared = cur.fetchall()
        assert len(shared) >= 10
        assert all(nodes >= orgs for _, orgs, nodes in shared)

    def test_one_user_belongs_to_both(self, db, seeded):
        with db('nakhel_web') as cur:
            cur.execute('SELECT user_id FROM auth_user_by_email(%s)', (seed_module.SHARED_USER_EMAIL,))
            user_id = cur.fetchone()[0]
            cur.execute('SELECT slug FROM auth_memberships(%s)', (user_id,))
            assert {r[0] for r in cur.fetchall()} == {'al-ain-demo', 'oasis-palm-demo'}

    def test_real_password_hash_format(self, db, seeded):
        from argon2 import PasswordHasher
        with db('nakhel_web') as cur:
            cur.execute('SELECT password_hash FROM auth_user_by_email(%s)', (seed_module.SHARED_USER_EMAIL,))
            stored = cur.fetchone()[0]
        assert stored.startswith('$argon2id$')
        assert PasswordHasher().verify(stored, 'nakhel-dev-password')

    def test_every_status_and_alert_type_is_represented(self, db, seeded):
        org_id, _ = seeded['al-ain-demo']
        with db('nakhel_web', org=org_id) as cur:
            cur.execute('SELECT DISTINCT status FROM node_status')
            assert {'healthy', 'suspected', 'alert', 'offline'} <= {r[0] for r in cur.fetchall()}
            cur.execute('SELECT DISTINCT alert_type FROM alert_log')
            assert {'low_battery', 'node_offline', 'sd_low'} <= {r[0] for r in cur.fetchall()}

    def test_most_healthy_wakeups_send_nothing(self, db, seeded):
        org_id, _ = seeded['al-ain-demo']
        with db('nakhel_web', org=org_id) as cur:
            cur.execute('SELECT count(*), count(DISTINCT node_id) FROM acoustic_features')
            rows, nodes = cur.fetchone()
        assert rows < nodes * 12 * 6 * 0.5

    def test_sometimes_optional_fields_are_missing(self, db, seeded):
        org_id, _ = seeded['al-ain-demo']
        with db('nakhel_web', org=org_id) as cur:
            cur.execute('SELECT count(*) FILTER (WHERE snr_db IS NULL), count(*) FILTER (WHERE snr_db IS NOT NULL) '
                        'FROM acoustic_features')
            missing, present = cur.fetchone()
        assert missing > 0 and present > 0

    def test_refuses_to_seed_twice(self, seeded):
        with pytest.raises(SystemExit):
            seed_module.main(['--days', '6', '--host', HOST])


def test_reset_replaces_seed_data_and_leaves_other_orgs_alone(db, seeded, orgs):
    assert seed_module.main(['--days', '6', '--host', HOST, '--reset']) == 0
    with db('nakhel_owner') as cur:
        cur.execute("SELECT count(*) FROM organizations WHERE slug LIKE '%%-demo'")
        assert cur.fetchone()[0] == 2
        cur.execute('SELECT count(*) FROM nodes WHERE org_id = ANY(%s::uuid[])',
                    ([str(org.org_id) for org in orgs],))
        assert cur.fetchone()[0] >= 2
        cur.execute("SELECT count(*) FROM nodes n JOIN organizations o USING (org_id) "
                    "WHERE o.slug = 'al-ain-demo'")
        assert cur.fetchone()[0] == 32


class TestSchedule:
    def test_twelve_wakeups_per_local_day_at_the_right_hours(self):
        start = datetime(2026, 10, 1, tzinfo=ZoneInfo(DUBAI))
        wakes = wake_times(start, start + timedelta(days=1), DUBAI)
        assert len(wakes) == 12
        assert sorted(w.astimezone(ZoneInfo(DUBAI)).hour for w in wakes) == sorted(WAKE_HOURS)

    def test_tree_labels_never_collide_at_scale(self):
        from nakhel_fake.layout import tree_label
        labels = [tree_label(i, 90) for i in range(8000)]
        assert len(set(labels)) == 8000
