#!/usr/bin/env python3
"""Load realistic FAKE data into the NAKHEL database.

Default: 2 organizations (~30 nodes each, 30 days) that reuse the same LoRa IDs, plus one
user who belongs to both. --scale adds one large organization for testing query speed.
Connects as nakhel_owner, which is not subject to row-level security on its own tables.
Refuses to run twice unless --reset is given; --reset deletes only the organizations
this script creates.
"""
import argparse
import io
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

import numpy as np
import psycopg2
import psycopg2.extras
from argon2 import PasswordHasher

sys.path.insert(0, str(Path(__file__).resolve().parent))
# pylint: disable=wrong-import-position
from nakhel_fake.layout import grid_position, tree_label
from nakhel_fake.schedule import slot_offset_seconds, wake_times
from nakhel_fake.signals import SEND_RATE, confidence_curve, literal_pool

MODEL_VERSION = 'stub-0.1-FAKE'
LOW_BATTERY_MV = 3400
OFFLINE_DAYS = 4

ORGS = [
    {'name': 'Al Ain Demo Farms', 'slug': 'al-ain-demo', 'clusters': 2, 'nodes': 32,
     'origin': (24.2075, 55.7447)},
    {'name': 'Oasis Palm Demo Co', 'slug': 'oasis-palm-demo', 'clusters': 1, 'nodes': 28,
     'origin': (24.1300, 55.8010)},
]
SCALE_ORG = {'name': 'Scale Test Org', 'slug': 'scale-test', 'clusters': 8, 'nodes': 8000,
             'origin': (24.3000, 55.6000)}
ALL_SLUGS = [org['slug'] for org in ORGS] + [SCALE_ORG['slug']]
SHARED_USER_EMAIL = 'consultant@nakhel-demo.example'


def connect(host, dbname='nakhel'):
    return psycopg2.connect(host=host, port=5432, dbname=dbname, user='nakhel_owner',
                            password=os.environ['NAKHEL_OWNER_PASSWORD'])


def copy_rows(cur, table, columns, rows):
    """COPY tab-separated rows. None becomes NULL."""
    buf = io.StringIO()
    for row in rows:
        buf.write('\t'.join('\\N' if v is None else str(v) for v in row))
        buf.write('\n')
    buf.seek(0)
    cols = ', '.join(f'"{c}"' for c in columns)
    cur.copy_expert(f'COPY {table} ({cols}) FROM STDIN', buf)


def delete_orgs(cur, slugs):
    """Delete organizations and their data. Member rows go with the trigger off, because taking
    away an organization's last owner is exactly what that trigger exists to refuse."""
    cur.execute('SELECT org_id FROM organizations WHERE slug = ANY(%s)', (slugs,))
    org_ids = [row[0] for row in cur.fetchall()]
    if not org_ids:
        return
    for table in ('alert_log', 'classification_results', 'acoustic_features', 'node_health',
                  'cluster_health', 'ingest_rejects', 'node_current', 'nodes', 'cluster_heads',
                  'organization_invites'):
        cur.execute(f'DELETE FROM {table} WHERE org_id = ANY(%s::uuid[])', (org_ids,))
    cur.execute('ALTER TABLE organization_members DISABLE TRIGGER organization_members_last_owner')
    cur.execute('DELETE FROM organization_members WHERE org_id = ANY(%s::uuid[])', (org_ids,))
    cur.execute('ALTER TABLE organization_members ENABLE TRIGGER organization_members_last_owner')
    cur.execute('DELETE FROM organizations WHERE org_id = ANY(%s::uuid[])', (org_ids,))
    cur.execute('DELETE FROM users u WHERE (email LIKE %s OR email LIKE %s OR email LIKE %s) '
                'AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.user_id)',
                ('%-demo.example', '%@scale-test.example', '%@sim-%.example'))


def create_user(cur, email, name, password_hash):
    cur.execute('INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) '
                'ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING user_id',
                (email, name, password_hash))
    return cur.fetchone()[0]


def create_org(cur, spec, password_hash):
    cur.execute('INSERT INTO organizations (name, slug) VALUES (%s, %s) RETURNING org_id, timezone',
                (spec['name'], spec['slug']))
    org_id, tz_name = cur.fetchone()
    domain = 'scale-test.example' if spec is SCALE_ORG else f"{spec['slug']}.example"
    owner_id = create_user(cur, f'owner@{domain}', f"{spec['name']} Owner", password_hash)
    cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                (org_id, owner_id))
    return org_id, tz_name, owner_id


def create_devices(cur, org_id, spec, now):
    """Cluster heads and nodes. LoRa IDs restart at 1000 in every organization and every
    cluster head on purpose: they are only unique per cluster head."""
    clusters, nodes = [], []
    per_cluster = spec['nodes'] // spec['clusters']
    columns = max(6, int(per_cluster ** 0.5))
    for c_index in range(spec['clusters']):
        zone = f'Zone {chr(65 + c_index)}'
        count = per_cluster + (spec['nodes'] % spec['clusters'] if c_index == 0 else 0)
        origin = (spec['origin'][0] + c_index * 0.01, spec['origin'][1])
        center = grid_position(count // 2, columns, origin)
        # The raw key is thrown away, so seeded cluster heads can't call the API.
        # Use web/scripts/register-cluster.ts (M2) for a usable key.
        key_hash = sha256(uuid.uuid4().bytes).hexdigest()
        cur.execute(
            'INSERT INTO cluster_heads (org_id, name, farm_zone, install_date, location_lat, '
            'location_lon, uplink_type, api_key_hash) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) '
            'RETURNING cluster_id',
            (org_id, f'CH-{c_index + 1:02d}', zone, (now - timedelta(days=200)).date(),
             center[0], center[1], 'wifi' if c_index % 2 == 0 else '4g', key_hash))
        cluster_id = cur.fetchone()[0]
        clusters.append(cluster_id)
        rows = []
        for n_index in range(count):
            lat, lon = grid_position(n_index, columns, origin)
            prefix = '' if spec['clusters'] == 1 else f'{chr(65 + c_index)}'
            rows.append((org_id, cluster_id, 1000 + n_index,
                         f'{tree_label(n_index, columns)}{prefix}', zone,
                         (now - timedelta(days=180)).date(), lat, lon))
        psycopg2.extras.execute_values(
            cur,
            'INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, farm_zone, install_date, '
            'location_lat, location_lon) VALUES %s RETURNING node_id, cluster_id, lora_id, tree_label',
            rows, page_size=1000)
        nodes.extend(dict(zip(('node_id', 'cluster_id', 'lora_id', 'tree_label'), row),
                          slot=i) for i, row in enumerate(cur.fetchall()))
    return clusters, nodes


def assign_conditions(nodes, rng):
    """About 2% infested, 3% suspected, 3% low battery, 3% offline; at least a handful each."""
    order = rng.permutation(len(nodes))
    def take(start, fraction, minimum):
        size = max(minimum, int(len(nodes) * fraction))
        return order[start:start + size], start + size
    infested, pos = take(0, 0.02, 3)
    suspected, pos = take(pos, 0.03, 3)
    low_battery, pos = take(pos, 0.03, 2)
    offline, pos = take(pos, 0.03, 2)
    for node in nodes:
        node.update(condition='healthy', low_battery=False, offline=False)
    for i in infested:
        nodes[i]['condition'] = 'infested'
    for i in suspected:
        nodes[i]['condition'] = 'suspected'
    for i in low_battery:
        nodes[i]['low_battery'] = True
    for i in offline:
        nodes[i]['offline'] = True


def measurements_for_node(node, wakes, wake_seconds, now, end_seconds, pools, rng):
    """Yield the measurement and classification rows for one node over the window."""
    rate = SEND_RATE[node['condition']]
    infested_like = node['condition'] != 'healthy'
    onset = end_seconds - rng.uniform(5, 12) * 86400
    sends = np.nonzero(rng.random(len(wakes)) < rate)[0]
    cutoff = end_seconds - OFFLINE_DAYS * 86400 if node['offline'] else end_seconds
    slot = slot_offset_seconds(node['slot'])
    has_optional = rng.random() < 0.8  # some Pis send only the required fields
    for index in sends:
        ts_seconds = wake_seconds[index] + slot
        if ts_seconds >= cutoff or ts_seconds >= end_seconds:
            continue
        progress = max(0.0, (ts_seconds - onset) / (end_seconds - onset))
        ts = wakes[index] + timedelta(seconds=slot)
        ingested = ts + timedelta(seconds=float(rng.uniform(5, 40)))
        confidence = confidence_curve(node['condition'], progress, rng)
        pending = (now - ts) < timedelta(minutes=2)
        pool = pools[1] if infested_like and progress > 0.25 else pools[0]
        feature = (ts.isoformat(), node['org_id'], node['node_id'], node['cluster_id'],
                   pool[rng.integers(len(pool))],
                   round(float(rng.uniform(4.1, 14)), 2) if has_optional else None,
                   int(rng.integers(-118, -70)) if has_optional else None,
                   uuid.UUID(int=int(rng.integers(0, 2**63))) if has_optional else None,
                   (ts + timedelta(seconds=2)).isoformat() if has_optional else None,
                   ingested.isoformat(), 'pending' if pending else 'classified')
        classified = None
        if not pending:
            classified = (ts.isoformat(), node['org_id'], node['node_id'],
                          'infested' if confidence >= 0.5 else 'healthy',
                          round(confidence, 4), MODEL_VERSION,
                          round(float(rng.uniform(4, 30)), 1),
                          (ingested + timedelta(seconds=float(rng.uniform(1, 8)))).isoformat())
        yield feature, classified


FEATURE_COLS = ('timestamp', 'org_id', 'node_id', 'cluster_id', 'mfcc', 'snr_db', 'rssi_dbm',
                'msg_id', 'received_at', 'ingested_at', 'status')
CLASSIFICATION_COLS = ('timestamp', 'org_id', 'node_id', 'label', 'confidence', 'model_version',
                       'inference_ms', 'processed_at')


def infestation_alerts(node, results, thresholds):
    """Replay the alert rule: crossing a threshold on the last-3 average, with a 24 h cooldown."""
    suspect, alert = thresholds
    label = node['tree_label']
    rows, recent = [], []
    last_raised = {}
    for ts, confidence, processed in results:
        recent = (recent + [confidence])[-3:]
        average = sum(recent) / len(recent)
        if len(recent) < 3 or average < suspect:
            continue
        kind, severity = (('infestation_detected', 'critical') if average >= alert
                          else ('infestation_suspected', 'warning'))
        if kind in last_raised and ts - last_raised[kind] < timedelta(hours=24):
            continue
        last_raised[kind] = ts
        rows.append((node['org_id'], ts, processed, ts, node['node_id'], None, kind, severity,
                     round(average, 3), f'{label}: last-3 average confidence {average:.0%}'))
    return rows


def health_rows(node, now, tz_name, rng):
    """One heartbeat per night (the D2 proposal), with battery slowly falling."""
    start_mv = 3370 if node['low_battery'] else rng.uniform(3700, 4150)
    days = node['days']
    wakes = [w for w in wake_times(now - timedelta(days=days), now, tz_name) if
             w.astimezone(timezone.utc).hour == 22]  # 02:00 Asia/Dubai
    cutoff = now - timedelta(days=OFFLINE_DAYS) if node['offline'] else now
    for i, wake in enumerate(wakes):
        if wake >= cutoff:
            break
        battery = start_mv + (len(wakes) - i) * 1.5
        yield (wake.isoformat(), node['org_id'], node['node_id'], int(battery),
               int(rng.integers(-118, -70)), i * 86400 + 3600)


def seed_org(cur, spec, password_hash, shared_user_id, now, days, rng, pool_size):
    org_id, tz_name, owner_id = create_org(cur, spec, password_hash)
    if shared_user_id:
        cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                    (org_id, shared_user_id))
    clusters, nodes = create_devices(cur, org_id, spec, now)
    assign_conditions(nodes, rng)
    for node in nodes:
        node.update(org_id=org_id, days=days)

    start = now - timedelta(days=days)
    wakes = wake_times(start, now, tz_name)
    wake_seconds = np.array([w.timestamp() for w in wakes])
    end_seconds = now.timestamp()
    pools = (literal_pool(rng, False, pool_size), literal_pool(rng, True, pool_size))

    counts = {'measurements': 0, 'alerts': 0}
    features, classifications, health, alerts = [], [], [], []
    def flush():
        copy_rows(cur, 'acoustic_features', FEATURE_COLS, features)
        copy_rows(cur, 'classification_results', CLASSIFICATION_COLS, classifications)
        copy_rows(cur, 'node_health', ('timestamp', 'org_id', 'node_id', 'battery_mv',
                                       'rssi_dbm', 'uptime_s'), health)
        counts['measurements'] += len(features)
        features.clear()
        classifications.clear()
        health.clear()

    for index, node in enumerate(nodes):
        results = []
        for feature, classified in measurements_for_node(node, wakes, wake_seconds, now,
                                                         end_seconds, pools, rng):
            features.append(feature)
            if classified:
                classifications.append(classified)
                results.append((datetime.fromisoformat(classified[0]), classified[4],
                                datetime.fromisoformat(classified[7])))
        health.extend(health_rows(node, now, tz_name, rng))
        alerts.extend(infestation_alerts(node, results, (0.5, 0.8)))
        if node['low_battery']:
            alerts.append((org_id, now - timedelta(hours=8), now - timedelta(hours=8), None,
                           node['node_id'], None, 'low_battery', 'warning', None,
                           f"{node['tree_label']}: battery below {LOW_BATTERY_MV} mV"))
        if node['offline']:
            when = now - timedelta(days=OFFLINE_DAYS) + timedelta(hours=56)
            alerts.append((org_id, when, when, None, node['node_id'], None, 'node_offline',
                           'warning', None, f"{node['tree_label']}: 2 heartbeats missed"))
        if index % 200 == 199:
            flush()
    flush()

    psycopg2.extras.execute_values(
        cur,
        'INSERT INTO alert_log (org_id, "timestamp", created_at, measurement_ts, node_id, '
        'cluster_id, alert_type, severity, confidence, message, email_sent_at) VALUES %s',
        # Marked as sent, or the worker would email owners about fake history.
        [row + (now,) for row in alerts], page_size=1000)
    counts['alerts'] = len(alerts)
    # Older alerts have been dealt with; recent ones are still open.
    cur.execute('UPDATE alert_log SET acknowledged = true, acknowledged_by = %s, '
                "acknowledged_at = \"timestamp\" + INTERVAL '3 hours' "
                "WHERE org_id = %s AND \"timestamp\" < %s",
                (owner_id, org_id, now - timedelta(days=3)))

    rows = []
    for c_index, cluster_id in enumerate(clusters):
        sd_free = 900 if c_index == 1 else 18000  # second head is low on SD card space
        ts = start
        while ts < now:
            rows.append((ts.isoformat(), org_id, cluster_id,
                         int((ts - start).total_seconds()) + 86400, int(rng.integers(-90, -50)),
                         sd_free, 'wifi' if c_index % 2 == 0 else '4g',
                         int(rng.integers(0, 4))))
            ts += timedelta(minutes=10)
    copy_rows(cur, 'cluster_health', ('timestamp', 'org_id', 'cluster_id', 'uptime_s', 'rssi_dbm',
                                      'sd_free_mb', 'uplink_type', 'buffered_count'), rows)
    if len(clusters) > 1:
        cur.execute('INSERT INTO alert_log (org_id, "timestamp", cluster_id, alert_type, severity, '
                    'message, email_sent_at) VALUES (%s, %s, %s, %s, %s, %s, %s)',
                    (org_id, now - timedelta(hours=5), clusters[1], 'sd_low', 'warning',
                     'CH-02: SD card below 1,024 MB free', now))

    # The unknown node a Pi keeps reporting; the 422 row Settings will show later.
    lora_unknown = 60000
    copy_rows(cur, 'ingest_rejects', ('time', 'org_id', 'cluster_id', 'lora_id', 'http_status',
                                      'error_code', 'request_body'),
              [((now - timedelta(hours=h)).isoformat(), org_id, clusters[0], lora_unknown, 422,
                'unknown_node', f'{{"node_id": {lora_unknown}}}') for h in (1, 13, 25)])
    return org_id, counts, len(nodes)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scale', action='store_true', help='add the large organization')
    parser.add_argument('--nodes', type=int, default=8000, help='--scale: node count')
    parser.add_argument('--scale-days', type=int, default=90, help='--scale: days of history')
    parser.add_argument('--days', type=int, default=30, help='days of history, default organizations')
    parser.add_argument('--reset', action='store_true', help='first delete earlier seed data')
    parser.add_argument('--seed', type=int, default=490, help='random seed')
    parser.add_argument('--host', default=os.environ.get('NAKHEL_DB_HOST', 'db'))
    args = parser.parse_args(argv)

    rng = np.random.default_rng(args.seed)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    password = os.environ.get('SEED_USER_PASSWORD', 'nakhel-dev-password')
    password_hash = PasswordHasher().hash(password)  # argon2id, standard PHC string

    conn = connect(args.host)
    with conn, conn.cursor() as cur:
        if args.reset:
            delete_orgs(cur, ALL_SLUGS)
        cur.execute('SELECT slug FROM organizations WHERE slug = ANY(%s)', (ALL_SLUGS,))
        existing = {row[0] for row in cur.fetchall()}
        if args.scale:
            specs = [(dict(SCALE_ORG, nodes=args.nodes), args.scale_days, 500)]
        else:
            specs = [(org, args.days, 40) for org in ORGS]
        clash = existing & {spec[0]['slug'] for spec in specs}
        if clash:
            parser.error(f'{sorted(clash)} already seeded; use --reset to replace seed data')

        shared = None
        if not args.scale:
            shared = create_user(cur, SHARED_USER_EMAIL, 'Shared Consultant', password_hash)
        for spec, days, pool_size in specs:
            org_id, counts, node_count = seed_org(cur, spec, password_hash, shared, now, days,
                                                  rng, pool_size)
            print(f"{spec['slug']}: org {org_id}, {node_count} nodes, "
                  f"{counts['measurements']} measurements, {counts['alerts']} alerts")
    conn.close()
    if not args.scale:
        print(f'Log in with {SHARED_USER_EMAIL} or owner@<slug>.example, password: {password}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
