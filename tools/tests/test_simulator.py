"""The simulator's planning and outage behaviour, with a fake API."""
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# pylint: disable=wrong-import-position
import pi_client_example as client
import simulate_cluster as sim

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def config(nodes=30):
    def cluster(key, condition_of):
        return {'name': 'CH-01', 'key': key,
                'nodes': [{'lora_id': 1000 + i, 'condition': condition_of(i), 'slot': i, 'label': f'T{i}'}
                          for i in range(nodes)]}
    return {'orgs': [
        {'slug': 'a', 'timezone': 'Asia/Dubai',
         'clusters': [cluster('key-a', lambda i: 'infested' if i < 2 else 'healthy')]},
        {'slug': 'b', 'timezone': 'Asia/Dubai', 'clusters': [cluster('key-b', lambda i: 'healthy')]},
    ]}


def rng():
    return np.random.default_rng(1)


def plan(days=20):
    return sim.plan_events(config(), NOW - timedelta(days=days), NOW, rng())


def test_events_are_in_time_order_and_inside_the_window():
    events = plan()
    assert events == sorted(events, key=lambda e: e.when)
    assert all(NOW - timedelta(days=20) <= e.when < NOW for e in events)


def test_most_healthy_wakeups_send_nothing_and_infested_ones_mostly_send():
    counts = Counter((e.cluster_key, e.lora_id) for e in plan())
    wakeups = 12 * 20
    assert counts[('key-a', 1000)] > wakeups * 0.8
    healthy = [counts[('key-a', 1000 + i)] for i in range(2, 30)]
    assert sum(healthy) / len(healthy) < wakeups * 0.2


def test_organizations_reuse_lora_ids():
    ids = {key: {e.lora_id for e in plan() if e.cluster_key == key} for key in ('key-a', 'key-b')}
    assert len(ids['key-a'] & ids['key-b']) > 20


def test_schedule_is_local_time():
    hours = {e.when.astimezone(timezone(timedelta(hours=4))).hour for e in plan()}
    assert hours == {0, 1, 2, 3, 4, 5, 6, 10, 14, 18, 22, 23}


def test_body_matches_the_contract():
    event = sim.Event(NOW, 'k', 1000, 'infested')
    body = sim.to_body(event, rng(), with_optional=True)
    assert body['timestamp'].endswith('Z') and body['node_id'] == 1000
    assert len(body['mfcc']) == 30 and all(len(row) == 13 for row in body['mfcc'])
    assert {'msg_id', 'received_at', 'snr_db', 'rssi_dbm'} <= set(body)
    assert set(sim.to_body(event, rng(), with_optional=False)) == {'node_id', 'timestamp', 'mfcc'}


def test_infested_matrices_are_clearly_different():
    spread = {condition: np.std(np.array(sim.to_body(sim.Event(NOW, 'k', 1, condition), rng(), False)['mfcc'])[:, 0])
              for condition in ('healthy', 'suspected', 'infested')}
    assert spread['healthy'] < spread['suspected'] < spread['infested']


class FakeApi(sim.Simulator):
    """Records what would have been sent, in order."""
    def __init__(self):
        super().__init__(config(), 'http://unused', rng(), now=lambda: NOW)
        self.sent = []

    def send(self, key, body):
        identity = (key, body['node_id'], body['timestamp'])
        status = 'duplicate' if identity in self.sent else 'stored'
        self.sent.append(identity)
        self.report.add('a', {'status': status}, client.Outcome.DELETE)


def test_outage_buffers_then_flushes_everything_with_some_duplicates():
    events = plan(days=2)
    start = NOW - timedelta(hours=12)
    during = [e for e in events if e.when >= start]
    api = FakeApi()
    report = api.run(events, outage_start=start)
    assert report.stored == len(events)
    assert report.duplicate > 0
    assert len(api.sent) == len(events) + report.duplicate
    # The buffered ones are sent after everything before the outage, keeping their own timestamps.
    flushed = {identity[2] for identity in api.sent[len(events) - len(during):]}
    assert flushed >= {e.when.isoformat().replace('+00:00', 'Z') for e in during}


def test_future_events_wait_for_real_time():
    waits = []
    api = sim.Simulator(config(), 'http://unused', rng(), sleep=waits.append, now=lambda: NOW)
    api.pace(sim.Event(NOW + timedelta(seconds=30), 'k', 1, 'healthy'), None)
    assert waits == [30.0]


def test_speed_compresses_the_past():
    waits = []
    api = sim.Simulator(config(), 'http://unused', rng(), speed=3600, sleep=waits.append, now=lambda: NOW)
    api.pace(sim.Event(NOW - timedelta(hours=1), 'k', 1, 'healthy'), NOW - timedelta(hours=2))
    assert waits == [1.0]
