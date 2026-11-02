"""Fixtures. Tests run against the throwaway db-test container, as the real roles."""
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

import psycopg2
import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))

HOST = os.environ.get('NAKHEL_DB_HOST', 'db-test')
PASSWORDS = {
    'postgres': 'POSTGRES_SUPERUSER_PASSWORD',
    'nakhel_owner': 'NAKHEL_OWNER_PASSWORD',
    'nakhel_web': 'NAKHEL_WEB_PASSWORD',
    'nakhel_worker': 'NAKHEL_WORKER_PASSWORD',
}
HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def connect(role):
    return psycopg2.connect(host=HOST, port=5432, dbname='nakhel', user=role,
                            password=os.environ[PASSWORDS[role]])


def key_hash(raw):
    return sha256(raw.encode()).hexdigest()


def mfcc_matrix(value=1.0):
    return [[value] * 13 for _ in range(30)]


def insert_feature(cur, org_id, node_id, cluster_id, ts=NOW, mfcc=None):
    cur.execute('INSERT INTO acoustic_features ("timestamp", org_id, node_id, cluster_id, mfcc) '
                'VALUES (%s, %s, %s, %s, %s::real[])',
                (ts, org_id, node_id, cluster_id, mfcc if mfcc is not None else mfcc_matrix()))


def lock_chunks(cur):
    """What the every-minute job does; tests call it rather than wait for the scheduler."""
    cur.execute("CALL lock_down_chunks(0, '{}'::jsonb)")


class Org:
    """One test organization: an owner, a cluster head, and a node with LoRa ID 100."""
    def __init__(self, cur, slug):
        self.owner = str(uuid.uuid4())
        self.raw_key = f'key-{slug}'
        cur.execute('INSERT INTO organizations (name, slug) VALUES (%s, %s) RETURNING org_id',
                    (slug.title(), slug))
        self.org_id = cur.fetchone()[0]
        cur.execute('INSERT INTO users (user_id, email, name, password_hash) VALUES (%s, %s, %s, %s)',
                    (self.owner, f'owner@{slug}.test', 'Owner', HASH))
        cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                    (self.org_id, self.owner))
        cur.execute('INSERT INTO cluster_heads (org_id, name, api_key_hash) VALUES (%s, %s, %s) '
                    'RETURNING cluster_id', (self.org_id, 'CH-01', key_hash(self.raw_key)))
        self.cluster_id = cur.fetchone()[0]
        cur.execute('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label) '
                    "VALUES (%s, %s, 100, 'T1') RETURNING node_id", (self.org_id, self.cluster_id))
        self.node_id = cur.fetchone()[0]
        insert_feature(cur, self.org_id, self.node_id, self.cluster_id)
        cur.execute('INSERT INTO node_health ("timestamp", org_id, node_id, battery_mv) '
                    'VALUES (%s, %s, %s, 3900)', (NOW, self.org_id, self.node_id))
        cur.execute('INSERT INTO cluster_health ("timestamp", org_id, cluster_id) VALUES (%s, %s, %s)',
                    (NOW, self.org_id, self.cluster_id))
        cur.execute('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                    "confidence, model_version) VALUES (%s, %s, %s, 'healthy', 0.1, 'test')",
                    (NOW, self.org_id, self.node_id))
        cur.execute('INSERT INTO ingest_rejects (org_id, cluster_id, http_status, error_code) '
                    "VALUES (%s, %s, 422, 'unknown_node')", (self.org_id, self.cluster_id))
        cur.execute('INSERT INTO alert_log (org_id, "timestamp", node_id, alert_type, severity, '
                    "message) VALUES (%s, %s, %s, 'low_battery', 'warning', 'x') RETURNING alert_id",
                    (self.org_id, NOW, self.node_id))
        self.alert_id = cur.fetchone()[0]
        cur.execute('INSERT INTO organization_invites (org_id, email, token_hash, invited_by, '
                    'expires_at) VALUES (%s, %s, %s, %s, %s) RETURNING invite_id',
                    (self.org_id, f'new@{slug}.test', key_hash(f'invite-{slug}'), self.owner,
                     NOW + timedelta(days=7)))
        self.invite_id = cur.fetchone()[0]


@pytest.fixture(scope='session')
def orgs():
    """Organizations A and B: same LoRa ID, same cluster-head name, same everything."""
    conn = connect('nakhel_owner')
    with conn, conn.cursor() as cur:
        result = Org(cur, 'test-a'), Org(cur, 'test-b')
        lock_chunks(cur)
    conn.close()
    return result


@pytest.fixture(scope='session')
def role_conns():
    conns = {role: connect(role) for role in PASSWORDS}
    yield conns
    for conn in conns.values():
        conn.close()


@pytest.fixture
def db(role_conns):
    """db('nakhel_web', org=<uuid>, user=<uuid>) opens a transaction that always rolls back."""
    @contextmanager
    def open_txn(role, org=None, user=None):
        conn = role_conns[role]
        conn.rollback()
        with conn.cursor() as cur:
            if org:
                cur.execute("SELECT set_config('app.current_org', %s, true)", (str(org),))
            if user:
                cur.execute("SELECT set_config('app.current_user_id', %s, true)", (str(user),))
            try:
                yield cur
            finally:
                conn.rollback()
    return open_txn
