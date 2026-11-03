"""The firmware's ARQ engine against the real API and database, with network faults injected.
Run with: ./db.sh test-firmware"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import psycopg2
import pytest
import requests

sys.path.insert(0, '/repo/tools')
# pylint: disable=wrong-import-position
import simulate_cluster as sim

HOST = os.environ.get('NAKHEL_DB_HOST', 'db')
BINARY = Path(__file__).resolve().parents[1] / 'host' / 'uplink_host.bin'
PREFIX = f'fw{int(time.time()) % 100000}'
NODES = 12


def query(sql, params=()):
    conn = psycopg2.connect(host=HOST, dbname='nakhel', user='nakhel_owner',
                            password=os.environ['NAKHEL_OWNER_PASSWORD'])
    with conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    conn.close()
    return rows


def run(key, base, pattern, nodes):
    args = [str(BINARY), 'web', '3000', key, str(base), pattern, *[str(n) for n in nodes]]
    done = subprocess.run(args, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(done.stdout)


def rows_at(org_id, base, count):
    return query(
        '''SELECT n.lora_id, a.snr_db, a.rssi_dbm, a.confidence, a.model_version, a.mfcc, a.received_at IS NOT NULL
           FROM acoustic_features a JOIN nodes n USING (node_id)
           WHERE a.org_id = %s AND a."timestamp" >= to_timestamp(%s) AND a."timestamp" < to_timestamp(%s)
           ORDER BY a."timestamp"''', (org_id, base, base + count))


@pytest.fixture(scope='module')
def world():
    config = sim.setup_config(HOST, orgs=1, clusters=1, nodes=NODES, infested=0, suspected=0, seed=11, slug_prefix=PREFIX)
    org = config['orgs'][0]
    cluster = org['clusters'][0]
    cluster_id = query('SELECT cluster_id FROM cluster_heads WHERE org_id = %s', (org['org_id'],))[0][0]
    yield {
        'org_id': org['org_id'], 'key': cluster['key'], 'cluster_id': cluster_id, 'owner': org['owner_email'],
        'nodes': [node['lora_id'] for node in cluster['nodes']],
    }
    deadline = time.time() + 120
    while time.time() < deadline:
        if query("SELECT count(*) FROM acoustic_features WHERE org_id = %s AND status = 'pending'", (org['org_id'],))[0][0] == 0:
            break
        time.sleep(1)
    sim.teardown(HOST, [org['slug']])


def test_clean_run_stores_every_field_correctly(world):
    base = int(time.time()) - 1000
    nodes = world['nodes'][:3]
    result = run(world['key'], base, '-', nodes)
    assert result == {'left': 0, 'stored': 3, 'duplicates': 0, 'rejected': 0, 'retries': 0, 'health_sent': 1, 'key_refused': False}
    rows = rows_at(world['org_id'], base, 3)
    assert [row[0] for row in rows] == nodes
    for node, snr, rssi, confidence, model, mfcc, has_received_at in rows:
        assert (snr, rssi, model, mfcc, has_received_at) == (7.5, -101, 'node-test-1.0', None, True)
        assert confidence == pytest.approx((node % 40) / 100, rel=1e-5)


def test_the_worker_files_the_nodes_result_unchanged(world):
    base = int(time.time()) - 1500
    node = world['nodes'][3]
    assert run(world['key'], base, '-', [node])['stored'] == 1
    rows = []
    deadline = time.time() + 60
    while not rows and time.time() < deadline:
        rows = query('''SELECT c.label, c.confidence, c.model_version, c.inference_ms FROM classification_results c
                        JOIN acoustic_features f USING (node_id, "timestamp")
                        WHERE f.org_id = %s AND f."timestamp" = to_timestamp(%s)''', (world['org_id'], base))
        time.sleep(0.5)
    assert rows, 'the worker never classified it'
    label, confidence, model, inference_ms = rows[0]
    assert (label, model, inference_ms) == ('healthy', 'node-test-1.0', None)
    assert confidence == pytest.approx((node % 40) / 100, rel=1e-5)

    # What the History screen and the energy charts ask for.
    web = os.environ.get('WEB_URL', 'http://web:3000')
    session = requests.Session()
    login = session.post(f'{web}/api/v1/auth/login', timeout=15, headers={'Origin': os.environ['APP_ORIGIN_FIRST']},
                         json={'email': world['owner'], 'password': os.environ['SEED_USER_PASSWORD']})
    assert login.status_code == 200
    history = session.get(f"{web}/api/v1/orgs/{world['org_id']}/history", timeout=15)
    assert history.status_code == 200
    item = next(i for i in history.json()['items'] if i['lora_id'] == node)
    assert item['energy'] is None
    assert item['model_version'] == 'node-test-1.0'
    assert session.get(f"{web}/api/v1/orgs/{world['org_id']}/energy/overview", timeout=15).status_code == 200


@pytest.mark.parametrize('pattern', ['lo', 'dlo', 'c5dlo', 'lllo'])
def test_faults_lose_nothing_and_store_nothing_twice(world, pattern):
    base = int(time.time()) - 2000 - 100 * len(pattern) * ord(pattern[0])
    nodes = world['nodes'][:6]
    result = run(world['key'], base, pattern, nodes)
    assert result['left'] == 0
    assert result['rejected'] == 0
    # Every record's first copy reached the server with its answer lost, so only duplicates are seen.
    assert result['duplicates'] == 6
    assert result['stored'] == 0
    assert result['retries'] >= 6
    assert [row[0] for row in rows_at(world['org_id'], base, 6)] == nodes


def test_unknown_node_is_refused_and_the_queue_moves_on(world):
    base = int(time.time()) - 5000
    good = world['nodes'][0]
    unknown = next(n for n in range(255, 0, -1) if n not in world['nodes'])
    result = run(world['key'], base, '-', [unknown, good])
    assert (result['rejected'], result['stored'], result['left'], result['retries']) == (1, 1, 0, 0)
    assert [row[0] for row in rows_at(world['org_id'], base, 2)] == [good]
    assert query("SELECT count(*) FROM ingest_rejects WHERE org_id = %s AND lora_id = %s AND error_code = 'unknown_node'",
                 (world['org_id'], unknown))[0][0] == 1


def test_bad_key_stops_sending_and_keeps_the_buffer(world):
    base = int(time.time()) - 6000
    result = run('nkh_not_a_real_key', base, '-', world['nodes'][:4])
    assert result['key_refused'] is True
    assert result['left'] == 4
    assert result['stored'] == 0
    assert rows_at(world['org_id'], base, 4) == []


def test_cluster_health_reaches_the_server(world):
    rows = query('SELECT uptime_s, rssi_dbm, uplink_type, buffered_count FROM cluster_health WHERE cluster_id = %s', (world['cluster_id'],))
    assert rows
    assert rows[0][:3] == (123, -55, 'wifi')
