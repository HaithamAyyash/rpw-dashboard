"""Every rule the database must enforce by itself, without trusting the API."""
from datetime import timedelta
from psycopg2 import errors
import pytest
from conftest import HASH, NOW, connect, insert_feature, key_hash, mfcc_matrix


def expect_rejected(db, error, sql, params):
    with db('nakhel_owner') as cur:
        with pytest.raises(error):
            cur.execute(sql, params)


ORG_SQL = ('INSERT INTO organizations (name, slug, suspect_threshold, alert_threshold, timezone) '
           'VALUES (%s, %s, %s, %s, %s)')


@pytest.mark.parametrize('suspect,alert', [(-0.1, 0.8), (0.5, 1.1), (0.8, 0.8), (0.9, 0.5)])
def test_thresholds(db, suspect, alert):
    expect_rejected(db, errors.CheckViolation, ORG_SQL, ('N', 'bad-thresholds', suspect, alert, 'UTC'))


@pytest.mark.parametrize('slug', ['Upper', 'has space', '-lead', 'trail-', 'api', 'login', 'invite', ''])
def test_bad_slugs(db, slug):
    expect_rejected(db, errors.CheckViolation, ORG_SQL, ('N', slug, 0.5, 0.8, 'UTC'))


def test_bad_timezone(db):
    expect_rejected(db, errors.CheckViolation, ORG_SQL, ('N', 'bad-tz', 0.5, 0.8, 'Mars/Olympus'))


def test_duplicate_slug(db, orgs):
    expect_rejected(db, errors.UniqueViolation, ORG_SQL, ('N', 'test-a', 0.5, 0.8, 'UTC'))


def test_organization_needs_an_owner_by_commit():
    conn = connect('nakhel_owner')
    with conn.cursor() as cur:
        cur.execute(ORG_SQL, ('N', 'no-owner', 0.5, 0.8, 'UTC'))
    with pytest.raises(errors.CheckViolation):
        conn.commit()
    conn.close()


USER_SQL = 'INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s)'


@pytest.mark.parametrize('email,password_hash', [
    ('Upper@x.test', HASH), ('not-an-email', HASH), ('ok@x.test', 'plaintext'),
    ('ok@x.test', '$2b$12$bcrypthash')])
def test_bad_users(db, email, password_hash):
    expect_rejected(db, errors.CheckViolation, USER_SQL, (email, 'N', password_hash))


def test_duplicate_email(db, orgs):
    expect_rejected(db, errors.UniqueViolation, USER_SQL, ('owner@test-a.test', 'N', HASH))


def test_unknown_role(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('INSERT INTO users (user_id, email, name, password_hash) VALUES '
                    "(gen_random_uuid(), 'x@x.test', 'X', %s) RETURNING user_id", (HASH,))
        user = cur.fetchone()[0]
        with pytest.raises(errors.CheckViolation):
            cur.execute("INSERT INTO organization_members VALUES (%s, %s, 'admin')", (a.org_id, user))


class TestLastOwner:
    def test_cannot_delete(self, db, orgs):
        a, _ = orgs
        with db('nakhel_web', org=a.org_id) as cur:
            with pytest.raises(errors.CheckViolation, match='at least one owner'):
                cur.execute('DELETE FROM organization_members WHERE user_id = %s', (a.owner,))

    def test_can_delete_when_another_owner_remains(self, db, orgs):
        a, _ = orgs
        with db('nakhel_owner') as cur:
            cur.execute(USER_SQL + ' RETURNING user_id', ('second@test-a.test', 'S', HASH))
            second = cur.fetchone()[0]
            cur.execute('INSERT INTO organization_members (org_id, user_id) VALUES (%s, %s)',
                        (a.org_id, second))
            cur.execute('DELETE FROM organization_members WHERE org_id = %s AND user_id = %s',
                        (a.org_id, a.owner))
            assert cur.rowcount == 1
            with pytest.raises(errors.CheckViolation):
                cur.execute('DELETE FROM organization_members WHERE org_id = %s AND user_id = %s',
                            (a.org_id, second))


NODE_SQL = ('INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, location_lat, location_lon) '
            'VALUES (%s, %s, %s, %s, %s, %s)')


@pytest.mark.parametrize('lora,lat,lon', [(-1, 24, 55), (256, 24, 55), (5, 91, 55), (5, -91, 55),
                                          (5, 24, 181), (5, 24, -181)])
def test_node_ranges(db, orgs, lora, lat, lon):
    a, _ = orgs
    expect_rejected(db, errors.CheckViolation, NODE_SQL, (a.org_id, a.cluster_id, lora, 'T', lat, lon))


@pytest.mark.parametrize('lora', [0, 255])
def test_lora_range_edges_allowed(db, orgs, lora):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute(NODE_SQL, (a.org_id, a.cluster_id, lora, 'T', 24, 55))


def test_lora_unique_per_cluster_head(db, orgs):
    a, _ = orgs
    expect_rejected(db, errors.UniqueViolation, NODE_SQL, (a.org_id, a.cluster_id, 100, 'T', 24, 55))


def test_lora_id_reusable_after_node_retired(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('UPDATE nodes SET active = false WHERE node_id = %s', (a.node_id,))
        cur.execute(NODE_SQL, (a.org_id, a.cluster_id, 100, 'Replacement', 24, 55))


def test_same_lora_id_on_two_cluster_heads_of_one_org(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute('INSERT INTO cluster_heads (org_id, name, api_key_hash) VALUES (%s, %s, %s) '
                    'RETURNING cluster_id', (a.org_id, 'CH-02', key_hash('other')))
        cur.execute(NODE_SQL, (a.org_id, cur.fetchone()[0], 100, 'T', 24, 55))


@pytest.mark.parametrize('name', ['CH-01'])
def test_cluster_name_unique_per_org(db, orgs, name):
    a, _ = orgs
    expect_rejected(db, errors.UniqueViolation,
                    'INSERT INTO cluster_heads (org_id, name, api_key_hash) VALUES (%s, %s, %s)',
                    (a.org_id, name, key_hash('another')))


def test_api_key_hash_must_look_like_sha256(db, orgs):
    a, _ = orgs
    expect_rejected(db, errors.CheckViolation,
                    'INSERT INTO cluster_heads (org_id, name, api_key_hash) VALUES (%s, %s, %s)',
                    (a.org_id, 'CH-9', 'raw-key-by-mistake'))


class TestMfccShape:
    @pytest.mark.parametrize('literal', [
        '{1,2,3}',                                      # one-dimensional
        '{' + ','.join(['{' + ','.join(['1'] * 13) + '}'] * 29) + '}',  # 29 frames
        '{' + ','.join(['{' + ','.join(['1'] * 13) + '}'] * 31) + '}',  # 31 frames
        '{' + ','.join(['{' + ','.join(['1'] * 12) + '}'] * 30) + '}',  # 12 coefficients
        '{' + ','.join(['{' + ','.join(['1'] * 14) + '}'] * 30) + '}',  # 14 coefficients
    ])
    def test_wrong_shape(self, db, orgs, literal):
        a, _ = orgs
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.CheckViolation):
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, NOW - timedelta(days=1), literal)

    @pytest.mark.parametrize('bad', ['NaN', 'Infinity', '-Infinity', 'NULL'])
    def test_non_finite_values(self, db, orgs, bad):
        a, _ = orgs
        rows = ['{' + ','.join(['1'] * 13) + '}'] * 29 + ['{' + bad + ',' + ','.join(['1'] * 12) + '}']
        with db('nakhel_owner') as cur:
            with pytest.raises(errors.CheckViolation):
                insert_feature(cur, a.org_id, a.node_id, a.cluster_id, NOW - timedelta(days=1),
                               '{' + ','.join(rows) + '}')

    def test_correct_shape_stores_energy(self, db, orgs):
        a, _ = orgs
        ts = NOW - timedelta(days=1)
        with db('nakhel_owner') as cur:
            insert_feature(cur, a.org_id, a.node_id, a.cluster_id, ts, mfcc_matrix(-312.5))
            cur.execute('SELECT energy, status, array_ndims(mfcc) FROM acoustic_features '
                        'WHERE node_id = %s AND "timestamp" = %s', (a.node_id, ts))
            assert cur.fetchone() == (-312.5, 'pending', 2)


def test_duplicate_measurement_rejected(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        with pytest.raises(errors.UniqueViolation):
            insert_feature(cur, a.org_id, a.node_id, a.cluster_id, NOW)


def test_duplicate_measurement_on_conflict_changes_nothing(db, orgs):
    """The exact statement the ingest handler will run."""
    a, _ = orgs
    with db('nakhel_web', org=a.org_id) as cur:
        cur.execute('INSERT INTO acoustic_features ("timestamp", org_id, node_id, cluster_id, mfcc) '
                    'VALUES (%s, %s, %s, %s, %s::real[]) ON CONFLICT (node_id, "timestamp") DO NOTHING',
                    (NOW, a.org_id, a.node_id, a.cluster_id, mfcc_matrix(5.0)))
        assert cur.rowcount == 0
        cur.execute('SELECT energy FROM acoustic_features WHERE node_id = %s', (a.node_id,))
        assert cur.fetchone()[0] == 1.0


def test_bad_feature_status(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        with pytest.raises(errors.CheckViolation):
            cur.execute('UPDATE acoustic_features SET status = %s WHERE node_id = %s',
                        ('done', a.node_id))


CLASSIFICATION_SQL = ('INSERT INTO classification_results ("timestamp", org_id, node_id, label, '
                      'confidence, model_version) VALUES (%s, %s, %s, %s, %s, %s)')


@pytest.mark.parametrize('label,confidence', [('healthy', -0.01), ('healthy', 1.01), ('sick', 0.5)])
def test_classification_values(db, orgs, label, confidence):
    a, _ = orgs
    expect_rejected(db, errors.CheckViolation, CLASSIFICATION_SQL,
                    (NOW - timedelta(days=1), a.org_id, a.node_id, label, confidence, 'm'))


def test_new_model_may_rescore_but_not_twice(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        cur.execute(CLASSIFICATION_SQL, (NOW, a.org_id, a.node_id, 'healthy', 0.1, 'other-model'))
        with pytest.raises(errors.UniqueViolation):
            cur.execute(CLASSIFICATION_SQL, (NOW, a.org_id, a.node_id, 'healthy', 0.1, 'other-model'))


ALERT_SQL = ('INSERT INTO alert_log (org_id, "timestamp", node_id, cluster_id, alert_type, severity, '
             'confidence, message) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)')


@pytest.mark.parametrize('alert_type,severity,confidence,target', [
    ('made_up', 'info', None, 'node'),
    ('low_battery', 'catastrophic', None, 'node'),
    ('infestation_detected', 'critical', 1.5, 'node'),
    ('infestation_detected', 'critical', 0.9, 'cluster'),   # needs a node
    ('cluster_offline', 'critical', None, 'node'),          # needs a cluster head
])
def test_alert_values(db, orgs, alert_type, severity, confidence, target):
    a, _ = orgs
    node = a.node_id if target == 'node' else None
    cluster = a.cluster_id if target == 'cluster' else None
    expect_rejected(db, errors.CheckViolation, ALERT_SQL,
                    (a.org_id, NOW, node, cluster, alert_type, severity, confidence, 'm'))


def test_acknowledgement_must_be_complete(db, orgs):
    a, _ = orgs
    with db('nakhel_owner') as cur:
        with pytest.raises(errors.CheckViolation):
            cur.execute('UPDATE alert_log SET acknowledged = true WHERE alert_id = %s', (a.alert_id,))


def test_health_values(db, orgs):
    a, _ = orgs
    expect_rejected(db, errors.CheckViolation,
                    'INSERT INTO node_health ("timestamp", org_id, node_id, battery_mv) VALUES (%s, %s, %s, -1)',
                    (NOW, a.org_id, a.node_id))
    expect_rejected(db, errors.CheckViolation,
                    'INSERT INTO cluster_health ("timestamp", org_id, cluster_id, uplink_type) '
                    "VALUES (%s, %s, %s, 'pigeon')", (NOW, a.org_id, a.cluster_id))


NODE_RESULT_SQL = ('INSERT INTO acoustic_features '
                   '("timestamp", org_id, node_id, cluster_id, mfcc, confidence, model_version) '
                   'VALUES (now(), %s, %s, %s, %s, %s, %s)')


def test_node_result_needs_no_matrix_and_has_no_energy(db, orgs):
    a, _ = orgs
    with db('nakhel_web', org=a.org_id) as cur:
        cur.execute(NODE_RESULT_SQL + ' RETURNING energy, status',
                    (a.org_id, a.node_id, a.cluster_id, None, 0.85, 'node-1.0'))
        assert cur.fetchone() == (None, 'pending')


@pytest.mark.parametrize('matrix,confidence,model', [
    (None, None, None),      # nothing at all
    (True, 0.5, 'node-1'),   # both
    (None, 0.5, None),       # a result that doesn't say which model
    (True, None, 'node-1'),  # a model version on a matrix
    (None, 1.5, 'node-1'),   # above 1
    (None, -0.1, 'node-1'),  # below 0
    (None, 0.5, ''),         # empty version
    (None, 0.5, 'a b'),      # unsafe version
])
def test_bad_payload_combinations(db, orgs, matrix, confidence, model):
    a, _ = orgs
    expect_rejected(db, errors.CheckViolation, NODE_RESULT_SQL,
                    (a.org_id, a.node_id, a.cluster_id, mfcc_matrix() if matrix else None, confidence, model))
