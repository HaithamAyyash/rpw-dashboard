"""Fixtures. Tests run as the real nakhel_worker role against the throwaway database."""
import json
import os
import random
import sys
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# pylint: disable=wrong-import-position
from nakhel_worker.config import Config

HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'
MAILPIT_API = os.environ.get('MAILPIT_API', 'http://mailpit:8025/api/v1')
NOW = datetime.now(timezone.utc)


@pytest.fixture(scope='session')
def owner():
    conn = psycopg2.connect(os.environ['DATABASE_URL_ADMIN'])
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def conn():
    connection = psycopg2.connect(os.environ['DATABASE_URL'])
    yield connection
    connection.close()


@pytest.fixture
def cfg():
    return Config(database_url=os.environ['DATABASE_URL'], smtp_host=os.environ.get('SMTP_HOST', 'mailpit'))


def matrix(c0_std, c0_mean=-300.0):
    rng = random.Random(int(c0_std * 1000))
    return [[rng.gauss(c0_mean, c0_std)] + [1.0] * 12 for _ in range(30)]


# Scores from StubClassifier: about 0.05, 0.5-ish, and about 0.99.
QUIET, MIDDLE, LOUD = 6.0, 15.0, 30.0


class Org:
    counter = 0

    def __init__(self, owner, suspect=0.5, alert=0.8, timezone_name='Asia/Dubai', owners=1):
        Org.counter += 1
        self.slug = f'w-{uuid.uuid4().hex[:8]}'
        self.owner = owner
        self.owner_emails = [f'owner{i}@{self.slug}.test' for i in range(owners)]
        with owner.cursor() as cur:
            cur.execute('BEGIN')
            cur.execute('INSERT INTO organizations (name, slug, suspect_threshold, alert_threshold, timezone) '
                        'VALUES (%s, %s, %s, %s, %s) RETURNING org_id',
                        (f'Org {self.slug}', self.slug, suspect, alert, timezone_name))
            self.org_id = cur.fetchone()[0]
            for email in self.owner_emails:
                cur.execute('INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING user_id',
                            (email, 'Owner', HASH))
                cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                            (self.org_id, cur.fetchone()[0]))
            cur.execute('INSERT INTO cluster_heads (org_id, name, farm_zone, api_key_hash) '
                        "VALUES (%s, 'CH-01', 'Zone A', %s) RETURNING cluster_id",
                        (self.org_id, sha256(self.slug.encode()).hexdigest()))
            self.cluster_id = cur.fetchone()[0]
            cur.execute('COMMIT')
        self.node_id = self.add_node(1000, 'T-1')
        self.minutes = 0

    def add_node(self, lora_id, label):
        with self.owner.cursor() as cur:
            cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, farm_zone) '
                        "VALUES (%s, %s, %s, %s, 'Zone A') RETURNING node_id",
                        (self.org_id, self.cluster_id, lora_id, label))
            return cur.fetchone()[0]

    def measure(self, c0_std, node_id=None, ts=None):
        """Insert one pending measurement, the way the API does."""
        self.minutes += 1
        ts = ts or NOW - timedelta(days=2) + timedelta(minutes=self.minutes)
        with self.owner.cursor() as cur:
            cur.execute('INSERT INTO acoustic_features ("timestamp", org_id, node_id, cluster_id, mfcc) '
                        'VALUES (%s, %s, %s, %s, %s::real[])',
                        (ts, self.org_id, node_id or self.node_id, self.cluster_id, matrix(c0_std)))
        return ts

    def alerts(self, alert_type=None):
        with self.owner.cursor() as cur:
            cur.execute('SELECT alert_type, severity, confidence, message, measurement_ts, email_sent_at, alert_id '
                        'FROM alert_log WHERE org_id = %s AND (%s::text IS NULL OR alert_type = %s) ORDER BY alert_id',
                        (self.org_id, alert_type, alert_type))
            return cur.fetchall()

    def status(self, node_id=None):
        with self.owner.cursor() as cur:
            cur.execute('SELECT status, avg_confidence FROM node_status WHERE node_id = %s',
                        (node_id or self.node_id,))
            return cur.fetchone()


@pytest.fixture
def make_org(owner):
    def factory(**kwargs):
        return Org(owner, **kwargs)
    return factory


@pytest.fixture
def org(make_org):
    return make_org()


@pytest.fixture(autouse=True)
def clean_queue(owner):
    """Each test starts with nothing pending, so the worker can only pick up its own rows."""
    with owner.cursor() as cur:
        cur.execute("UPDATE acoustic_features SET status = 'classified' WHERE status = 'pending'")
        cur.execute('UPDATE alert_log SET email_sent_at = now() WHERE email_sent_at IS NULL')
        cur.execute('UPDATE cluster_heads SET revoked = true WHERE NOT revoked')


def mailpit(path, method='GET'):
    request = urllib.request.Request(f'{MAILPIT_API}{path}', method=method)
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read()
    return json.loads(body) if body and method == 'GET' else None


@pytest.fixture
def inbox():
    mailpit('/messages', 'DELETE')

    def messages():
        return mailpit('/messages')['messages']
    return messages
