"""The whole system on the running stack: simulator -> ingestion API -> worker -> database ->
dashboard API, and an email in Mailpit. Run with: ./db.sh integration"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import psycopg2
import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# pylint: disable=wrong-import-position
import simulate_cluster as sim

HOST = os.environ.get('NAKHEL_DB_HOST', 'db')
WEB = os.environ.get('WEB_URL', 'http://web:3000')
MAILPIT = os.environ.get('MAILPIT_API', 'http://mailpit:8025/api/v1')
ORIGIN = os.environ.get('APP_ORIGIN_FIRST', 'http://127.0.0.1:3100')
PASSWORD = os.environ.get('SEED_USER_PASSWORD', 'nakhel-dev-password')
PREFIX = f'it{int(time.time()) % 100000}'
WAIT_SECONDS = 120


def owner_query(sql, params=()):
    conn = psycopg2.connect(host=HOST, dbname='nakhel', user='nakhel_owner',
                            password=os.environ['NAKHEL_OWNER_PASSWORD'])
    with conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    conn.close()
    return rows


def wait_for(condition, what):
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        result = condition()
        if result:
            return result
        time.sleep(1)
    return pytest.fail(f'timed out waiting for {what}')


def mail_for(address):
    url = f"{MAILPIT}/search?query={urllib.request.quote(f'to:{address}')}"
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())['messages']


def dashboard_session(org):
    session = requests.Session()
    response = session.post(f'{WEB}/api/v1/auth/login', headers={'Origin': ORIGIN},
                            json={'email': org['owner_email'], 'password': PASSWORD}, timeout=15)
    assert response.status_code == 200
    return session


def stored_rows(org):
    return owner_query('SELECT count(*), count(*) FILTER (WHERE status = %s) FROM acoustic_features WHERE org_id = %s',
                       ('pending', org['org_id']))[0]


@pytest.fixture(scope='module')
def world():
    config = sim.setup_config(HOST, orgs=2, clusters=1, nodes=12, infested=1, suspected=0, seed=7, slug_prefix=PREFIX)
    a, b = config['orgs']  # pylint: disable=unbalanced-tuple-unpacking
    # Organization B has no infested trees at all.
    for node in b['clusters'][0]['nodes']:
        node['condition'] = 'healthy'
    now = datetime.now(timezone.utc).replace(microsecond=0)
    rng = np.random.default_rng(7)
    events = sim.plan_events(config, now - timedelta(days=3), now, rng)
    outage_start = now - timedelta(hours=24)  # always includes wake-ups, whatever the time of day
    # Every buffered message twice, so the duplicate check can't pass or fail by chance.
    report = sim.Simulator(config, WEB, rng, duplicate_rate=1.0).run(events, outage_start)
    yield {'config': config, 'a': a, 'b': b, 'events': events, 'report': report}
    # The worker may still be busy if a run stops early, and it would block deleting these rows.
    for org in (a, b):
        wait_for(lambda org=org: stored_rows(org)[1] == 0, 'worker to finish before cleanup')
    sim.teardown(HOST, [org['slug'] for org in config['orgs']])


def test_every_planned_measurement_arrived_and_duplicates_changed_nothing(world):
    report = world['report']
    assert report.stored == len(world['events'])
    assert report.duplicate > 0
    assert report.rejected == 0
    total = sum(stored_rows(world[key])[0] for key in ('a', 'b'))
    assert total == len(world['events'])


def test_worker_classifies_everything(world):
    for key in ('a', 'b'):
        wait_for(lambda org=world[key]: stored_rows(org)[1] == 0, f'worker to finish {key}')
    rows = owner_query('SELECT DISTINCT model_version FROM classification_results WHERE org_id = %s',
                       (world['a']['org_id'],))
    assert rows == [('stub-0.1-FAKE',)]


def infested_node(org):
    return next(n for n in org['clusters'][0]['nodes'] if n['condition'] == 'infested')


def test_dashboard_api_shows_the_infested_tree_only_to_its_org(world):
    a, b = world['a'], world['b']
    label = infested_node(a)['label']
    session = dashboard_session(a)
    trees = session.get(f"{WEB}/api/v1/orgs/{a['org_id']}/trees?status=alert", timeout=15).json()
    assert [tree['tree_label'] for tree in trees['items']] == [label]

    summary = session.get(f"{WEB}/api/v1/orgs/{a['org_id']}/summary", timeout=15).json()
    assert summary['alerts'] == 1 and summary['total_nodes'] == 12

    assert session.get(f"{WEB}/api/v1/orgs/{b['org_id']}/trees", timeout=15).status_code == 404
    other = dashboard_session(b)
    assert other.get(f"{WEB}/api/v1/orgs/{b['org_id']}/trees?status=alert", timeout=15).json()['items'] == []


def test_same_lora_id_stays_separate_between_organizations(world):
    rows = owner_query("""SELECT count(DISTINCT n.node_id) FROM nodes n JOIN organizations o USING (org_id)
                          WHERE o.slug = ANY(%s) AND n.lora_id = 1""",
                       ([world['a']['slug'], world['b']['slug']],))
    assert rows == [(2,)]


def test_alert_raised_once_and_emailed_only_to_that_orgs_owner(world):
    a, b = world['a'], world['b']
    label = infested_node(a)['label']
    alerts = owner_query('SELECT alert_type, severity, message FROM alert_log WHERE org_id = %s', (a['org_id'],))
    assert len([row for row in alerts if row[0] == 'infestation_detected']) == 1, alerts
    assert owner_query('SELECT count(*) FROM alert_log WHERE org_id = %s', (b['org_id'],)) == [(0,)]

    messages = wait_for(lambda: mail_for(a['owner_email']), 'the alert email')
    assert label in messages[0]['Subject']
    assert mail_for(b['owner_email']) == []


def test_latency_is_recorded_for_the_report(world):
    rows = owner_query("""SELECT a.created_at - f.ingested_at FROM alert_log a
                          JOIN acoustic_features f ON f.node_id = a.node_id AND f."timestamp" = a.measurement_ts
                          WHERE a.org_id = %s""", (world['a']['org_id'],))
    assert rows and all(row[0] >= timedelta(0) for row in rows)
