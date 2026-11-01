#!/usr/bin/env python3
"""Fake cluster heads that call the ingestion API exactly as real Pis would.

  ./db.sh simulate --setup                 create the organizations, cluster heads and API keys
  ./db.sh simulate --days 2 --speed 0      send 2 days of history as fast as possible
  ./db.sh simulate --days 1 --speed 3600   one simulated hour per second
  ./db.sh simulate --days 1 --outage 6     last 6 h stay buffered, then flush with some duplicates
  ./db.sh simulate --days 0 --follow       keep going in real time
  ./db.sh simulate --teardown              remove what --setup created

Node IDs, schedule and retry rules are all those of a real cluster head. Nothing here is real data.
"""
import argparse
import heapq
import json
import os
import secrets
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

import numpy as np
import psycopg2
import psycopg2.extras
import requests
from argon2 import PasswordHasher

sys.path.insert(0, str(Path(__file__).resolve().parent))
# pylint: disable=wrong-import-position
import pi_client_example as client
from nakhel_fake.layout import grid_position, tree_label
from nakhel_fake.schedule import slot_offset_seconds, wake_times
from nakhel_fake.signals import C0_SPREAD, SEND_RATE, fake_mfcc
from seed import delete_orgs

DEFAULT_CONFIG = Path(__file__).resolve().parent / '.sim_config.json'
FIRST_LORA_ID = 1000
DUPLICATE_RATE = 0.1


@dataclass
class Event:
    when: datetime
    cluster_key: str
    lora_id: int
    condition: str


@dataclass
class Report:
    stored: int = 0
    duplicate: int = 0
    rejected: int = 0
    per_org: dict = field(default_factory=dict)

    def add(self, org, body, outcome):
        counts = self.per_org.setdefault(org, {'stored': 0, 'duplicate': 0, 'rejected': 0})
        if outcome is client.Outcome.REJECT:
            self.rejected += 1
            counts['rejected'] += 1
        elif body['status'] == 'stored':
            self.stored += 1
            counts['stored'] += 1
        else:
            self.duplicate += 1
            counts['duplicate'] += 1


def setup_config(host, orgs, clusters, nodes, infested, suspected, seed, slug_prefix='sim'):
    """Registers everything directly, as an administrator would. Only the API is simulated."""
    rng = np.random.default_rng(seed)
    password_hash = PasswordHasher().hash(os.environ.get('SEED_USER_PASSWORD', 'nakhel-dev-password'))
    config = {'orgs': []}
    conn = psycopg2.connect(host=host, dbname='nakhel', user='nakhel_owner',
                            password=os.environ['NAKHEL_OWNER_PASSWORD'])
    with conn, conn.cursor() as cur:
        for o_index in range(orgs):
            slug = f'{slug_prefix}-{chr(97 + o_index)}'
            name = f'Simulated Farms {chr(65 + o_index)}'
            cur.execute('INSERT INTO organizations (name, slug) VALUES (%s, %s) RETURNING org_id, timezone',
                        (name, slug))
            org_id, tz_name = cur.fetchone()
            owner_email = f'owner@{slug}.example'
            cur.execute('INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING user_id',
                        (owner_email, f'{name} Owner', password_hash))
            cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                        (org_id, cur.fetchone()[0]))
            org = {'slug': slug, 'org_id': str(org_id), 'timezone': tz_name, 'owner_email': owner_email,
                   'clusters': []}
            for c_index in range(clusters):
                key = f'nkh_{secrets.token_urlsafe(32)}'
                zone = f'Zone {chr(65 + c_index)}'
                origin = (24.2 + o_index * 0.05 + c_index * 0.01, 55.7)
                cur.execute('INSERT INTO cluster_heads (org_id, name, farm_zone, api_key_hash, uplink_type) '
                            "VALUES (%s, %s, %s, %s, 'wifi') RETURNING cluster_id",
                            (org_id, f'CH-{c_index + 1:02d}', zone, sha256(key.encode()).hexdigest()))
                cluster_id = cur.fetchone()[0]
                order = rng.permutation(nodes)
                conditions = {int(i): 'infested' for i in order[:infested]}
                conditions.update({int(i): 'suspected' for i in order[infested:infested + suspected]})
                sim_nodes = []
                for n_index in range(nodes):
                    lat, lon = grid_position(n_index, 6, origin)
                    # The same LoRa IDs in every organization, on purpose.
                    lora_id = FIRST_LORA_ID + n_index
                    label = f'{tree_label(n_index, 6)}{chr(65 + c_index)}'
                    cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, farm_zone, location_lat, '
                                'location_lon) VALUES (%s, %s, %s, %s, %s, %s, %s)',
                                (org_id, cluster_id, lora_id, label, zone, lat, lon))
                    sim_nodes.append({'lora_id': lora_id, 'condition': conditions.get(n_index, 'healthy'),
                                      'slot': n_index, 'label': label})
                org['clusters'].append({'name': f'CH-{c_index + 1:02d}', 'key': key, 'nodes': sim_nodes})
            config['orgs'].append(org)
    conn.close()
    return config


def teardown(host, slugs):
    conn = psycopg2.connect(host=host, dbname='nakhel', user='nakhel_owner',
                            password=os.environ['NAKHEL_OWNER_PASSWORD'])
    with conn, conn.cursor() as cur:
        delete_orgs(cur, slugs)
    conn.close()


def plan_events(config, start, end, rng):
    """Every measurement the fake nodes would send: the TDMA schedule in each organization's local
    time, thinned by the SNR gate, so most healthy wake-ups send nothing. Sorted by time."""
    streams = []
    for org in config['orgs']:
        wakes = wake_times(start, end, org['timezone'])
        for cluster in org['clusters']:
            for node in cluster['nodes']:
                offset = timedelta(seconds=slot_offset_seconds(node['slot']))
                rate = SEND_RATE[node['condition']]
                sends = rng.random(len(wakes)) < rate
                streams.append([Event(wake + offset, cluster['key'], node['lora_id'], node['condition'])
                                for wake, send in zip(wakes, sends) if send and wake + offset < end])
    return list(heapq.merge(*streams, key=lambda event: event.when))


def to_body(event, rng, with_optional):
    """The JSON a Pi sends. Some cluster heads send only the required fields."""
    matrix = fake_mfcc(rng, event.condition != 'healthy', C0_SPREAD[event.condition])
    body = {
        'node_id': event.lora_id,
        'timestamp': event.when.isoformat().replace('+00:00', 'Z'),
        'mfcc': [[round(float(value), 3) for value in row] for row in matrix],
    }
    if with_optional:
        body.update({
            'msg_id': str(uuid.UUID(int=int(rng.integers(0, 2**63)), version=4)),
            'received_at': (event.when + timedelta(seconds=2)).isoformat().replace('+00:00', 'Z'),
            'snr_db': round(float(rng.uniform(4.1, 14)), 2),
            'rssi_dbm': int(rng.integers(-118, -70)),
        })
    return body


class Simulator:  # pylint: disable=too-many-instance-attributes
    def __init__(self, config, url, rng, speed=0.0, sleep=time.sleep, now=lambda: datetime.now(timezone.utc)):
        self.url = url
        self.rng = rng
        self.speed = speed
        self.sleep = sleep
        self.now = now
        self.report = Report()
        self.session = requests.Session()
        self.org_of_key = {c['key']: o['slug'] for o in config['orgs'] for c in o['clusters']}

    def send(self, key, body):
        """Same retry rules as the reference client. A refused key stops everything, as on a Pi."""
        outcome, response = client.deliver(self.session, self.url, key, body, sleep=self.sleep)
        if outcome is client.Outcome.STOP:
            raise SystemExit(f'API key refused for {self.org_of_key[key]}; run --setup again?')
        self.report.add(self.org_of_key[key], response, outcome)

    def pace(self, event, previous_when):
        """Fast-forward through the past; wait for real time when an event is in the future."""
        wait = (event.when - self.now()).total_seconds()
        if wait > 0:
            self.sleep(wait)
        elif self.speed > 0 and previous_when is not None:
            self.sleep((event.when - previous_when).total_seconds() / self.speed)

    def run(self, events, outage_start=None):
        """Events from outage_start on are buffered, as on the Pi's SD card, then flushed."""
        buffered = []
        previous = None
        for event in events:
            self.pace(event, previous)
            previous = event.when
            body = to_body(event, self.rng, with_optional=event.lora_id % 5 != 0)
            if outage_start is not None and event.when >= outage_start:
                buffered.append((event.cluster_key, body))
                continue
            self.send(event.cluster_key, body)
        self.flush(buffered)
        return self.report

    def flush(self, buffered):
        """Back online: the whole backlog, some of it twice, as after a lost acknowledgement."""
        for key, body in buffered:
            self.send(key, body)
            if self.rng.random() < DUPLICATE_RATE:
                self.send(key, body)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--setup', action='store_true', help='create organizations, cluster heads, keys')
    parser.add_argument('--teardown', action='store_true', help='remove everything --setup created')
    parser.add_argument('--orgs', type=int, default=2)
    parser.add_argument('--clusters', type=int, default=1, help='cluster heads per organization')
    parser.add_argument('--nodes', type=int, default=30, help='nodes per cluster head')
    parser.add_argument('--infested', type=int, default=2, help='infested nodes per cluster head')
    parser.add_argument('--suspected', type=int, default=2, help='suspected nodes per cluster head')
    parser.add_argument('--days', type=float, default=1, help='days of history to send, ending now')
    parser.add_argument('--speed', type=float, default=0, help='simulated seconds per real second; 0 = no waiting')
    parser.add_argument('--outage', type=float, default=0, help='buffer the last HOURS, then flush with duplicates')
    parser.add_argument('--follow', action='store_true', help='then keep sending in real time')
    parser.add_argument('--seed', type=int, default=490)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--url', default=os.environ.get('WEB_URL', 'http://web:3000'))
    parser.add_argument('--host', default=os.environ.get('NAKHEL_DB_HOST', 'db'))
    args = parser.parse_args(argv)

    if args.teardown:
        config = json.loads(args.config.read_text())
        teardown(args.host, [org['slug'] for org in config['orgs']])
        args.config.unlink()
        print('removed simulated organizations')
        return 0

    if args.setup:
        config = setup_config(args.host, args.orgs, args.clusters, args.nodes, args.infested, args.suspected,
                              args.seed)
        args.config.write_text(json.dumps(config, indent=1))
        args.config.chmod(0o600)
        for org in config['orgs']:
            print(f"{org['slug']}: log in as {org['owner_email']}")
        return 0

    config = json.loads(args.config.read_text())
    rng = np.random.default_rng(args.seed)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    start = now - timedelta(days=args.days)
    events = plan_events(config, start, now, rng)
    print(f'{len(events)} measurements to send')
    simulator = Simulator(config, args.url, rng, speed=args.speed)
    outage_start = now - timedelta(hours=args.outage) if args.outage else None
    report = simulator.run(events, outage_start)
    print(f'stored {report.stored}, duplicate {report.duplicate}, rejected {report.rejected}')
    for slug, counts in report.per_org.items():
        print(f'  {slug}: {counts}')
    while args.follow:
        upcoming = plan_events(config, now, now + timedelta(days=1), rng)
        simulator.run(upcoming)
        now += timedelta(days=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
