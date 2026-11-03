"""One measurement through the worker, as the real role, against real tables."""
import os
from datetime import timedelta

import psycopg2
import pytest
from conftest import LOUD, MIDDLE, NOW, QUIET, matrix
from nakhel_worker.classifier import Classifier, Prediction, StubClassifier
from nakhel_worker.__main__ import Worker
from nakhel_worker.pipeline import process_next
from nakhel_worker.status import band
from nakhel_worker.system_alerts import scan


def drain(conn, cfg, classifier=None):
    classifier = classifier or StubClassifier()
    handled = 0
    while process_next(conn, classifier, cfg):
        handled += 1
    return handled


def feed(org, conn, cfg, *levels, node_id=None):
    for level in levels:
        org.measure(level, node_id=node_id)
    assert drain(conn, cfg) == len(levels)


class TestClassification:
    def test_empty_queue(self, conn, cfg):
        assert process_next(conn, StubClassifier(), cfg) is False

    def test_stores_result_and_marks_classified(self, conn, cfg, org, owner):
        ts = org.measure(LOUD)
        assert process_next(conn, StubClassifier(), cfg) is True
        with owner.cursor() as cur:
            cur.execute('SELECT status FROM acoustic_features WHERE node_id = %s AND "timestamp" = %s',
                        (org.node_id, ts))
            assert cur.fetchone()[0] == 'classified'
            cur.execute('SELECT org_id, label, model_version, inference_ms IS NOT NULL, processed_at > %s '
                        'FROM classification_results WHERE node_id = %s AND "timestamp" = %s',
                        (ts, org.node_id, ts))
            assert cur.fetchone() == (org.org_id, 'infested', 'stub-0.1-FAKE', True, True)

    def test_org_id_comes_from_the_source_row(self, conn, cfg, make_org, owner):
        a, b = make_org(), make_org()
        feed(a, conn, cfg, QUIET)
        feed(b, conn, cfg, LOUD)
        with owner.cursor() as cur:
            cur.execute('SELECT DISTINCT org_id FROM classification_results WHERE node_id = %s', (a.node_id,))
            assert cur.fetchall() == [(a.org_id,)]
            cur.execute('SELECT DISTINCT org_id FROM classification_results WHERE node_id = %s', (b.node_id,))
            assert cur.fetchall() == [(b.org_id,)]

    def test_classifier_error_marks_failed_and_keeps_going(self, conn, cfg, org, owner):
        class Broken(Classifier):
            model_version = 'broken'

            def predict(self, mfcc):
                raise RuntimeError('model exploded')

        org.measure(QUIET)
        assert drain(conn, cfg, Broken()) == 1
        with owner.cursor() as cur:
            cur.execute('SELECT status FROM acoustic_features WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 'failed'
        feed(org, conn, cfg, QUIET)

    def test_result_the_database_refuses_marks_failed_and_keeps_going(self, conn, cfg, org, owner):
        """A confidence of 1.5 from a bad model must not jam the queue for every organization."""
        class OutOfRange(Classifier):
            model_version = 'out-of-range'

            def predict(self, mfcc):
                return Prediction('infested', 1.5)

        org.measure(QUIET)
        assert drain(conn, cfg, OutOfRange()) == 1
        with owner.cursor() as cur:
            cur.execute('SELECT status FROM acoustic_features WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 'failed'
            cur.execute('SELECT count(*) FROM classification_results WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 0
        feed(org, conn, cfg, QUIET)

    def test_error_before_claiming_propagates(self, conn, cfg, org, owner, monkeypatch):
        org.measure(QUIET)
        monkeypatch.setattr('nakhel_worker.pipeline.CLAIM_SQL', 'SELECT * FROM no_such_table')
        with pytest.raises(psycopg2.Error):
            process_next(conn, StubClassifier(), cfg)
        with owner.cursor() as cur:
            cur.execute('SELECT status FROM acoustic_features WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 'pending'

    def test_a_second_worker_skips_a_row_being_worked_on(self, conn, cfg, org):
        org.measure(QUIET)
        other = psycopg2.connect(os.environ['DATABASE_URL'])
        try:
            with other.cursor() as cur:
                cur.execute('SELECT 1 FROM acoustic_features WHERE node_id = %s FOR UPDATE', (org.node_id,))
                assert process_next(conn, StubClassifier(), cfg) is False  # locked, not waited for
            other.rollback()
            assert process_next(conn, StubClassifier(), cfg) is True
        finally:
            other.close()


class TestTreeStatus:
    def test_each_org_uses_its_own_thresholds(self, conn, cfg, make_org):
        strict = make_org(suspect=0.01, alert=0.02)
        lenient = make_org()
        feed(strict, conn, cfg, QUIET, QUIET, QUIET)
        feed(lenient, conn, cfg, QUIET, QUIET, QUIET)
        assert strict.status()[0] == 'alert'
        assert lenient.status()[0] == 'healthy'

    def test_last_3_average_recovers(self, conn, cfg, org):
        feed(org, conn, cfg, LOUD, LOUD, LOUD)
        assert org.status()[0] == 'alert'
        feed(org, conn, cfg, QUIET, QUIET, QUIET)
        assert org.status()[0] == 'healthy'

    @pytest.mark.parametrize('levels', [(QUIET,), (MIDDLE, MIDDLE), (LOUD, QUIET, LOUD), (LOUD,) * 3, (QUIET,) * 4])
    def test_python_band_always_agrees_with_the_view(self, conn, cfg, org, owner, levels):
        """Emails come from Python and screens from SQL, so they must never disagree."""
        feed(org, conn, cfg, *levels)
        status, average = org.status()
        with owner.cursor() as cur:
            cur.execute('SELECT suspect_threshold, alert_threshold FROM organizations WHERE org_id = %s',
                        (org.org_id,))
            assert band(average, *cur.fetchone()) == status


class TestInfestationAlerts:
    def test_quiet_tree_raises_nothing(self, conn, cfg, org):
        feed(org, conn, cfg, QUIET, QUIET, QUIET)
        assert org.alerts() == []

    def test_crossing_raises_once_and_cooldown_holds(self, conn, cfg, org):
        feed(org, conn, cfg, LOUD, LOUD, LOUD, LOUD, LOUD, LOUD)
        alerts = org.alerts('infestation_detected')
        assert len(alerts) == 1
        assert alerts[0][1] == 'critical'
        assert alerts[0][2] > 0.8
        assert 'T-1' in alerts[0][3]
        assert alerts[0][4] is not None

    def test_suspected_then_escalation(self, conn, cfg, org, owner):
        with owner.cursor() as cur:  # a wide suspected band, so the first result lands in it
            cur.execute('UPDATE organizations SET suspect_threshold = 0.01, alert_threshold = 0.9 '
                        'WHERE org_id = %s', (org.org_id,))
        feed(org, conn, cfg, QUIET)
        assert [a[0] for a in org.alerts()] == ['infestation_suspected']
        assert org.alerts()[0][1] == 'warning'
        feed(org, conn, cfg, LOUD, LOUD, LOUD)
        assert [a[0] for a in org.alerts()] == ['infestation_suspected', 'infestation_detected']

    def test_new_crossing_after_acknowledgement_raises_again(self, conn, cfg, org, owner):
        feed(org, conn, cfg, LOUD, LOUD, LOUD)
        with owner.cursor() as cur:
            cur.execute('UPDATE alert_log SET acknowledged = true, acknowledged_at = now(), acknowledged_by = '
                        '(SELECT user_id FROM organization_members WHERE org_id = %s LIMIT 1) WHERE org_id = %s',
                        (org.org_id, org.org_id))
        feed(org, conn, cfg, LOUD)  # still infested, acknowledged: stays quiet
        assert len(org.alerts()) == 1
        feed(org, conn, cfg, QUIET, QUIET, QUIET)
        feed(org, conn, cfg, LOUD, LOUD, LOUD)
        assert len(org.alerts('infestation_detected')) == 2

    def test_alert_goes_only_to_the_org_of_the_tree(self, conn, cfg, make_org):
        a, b = make_org(), make_org()
        feed(a, conn, cfg, LOUD, LOUD, LOUD)
        feed(b, conn, cfg, QUIET, QUIET, QUIET)
        assert len(a.alerts()) == 1
        assert b.alerts() == []

    def test_late_old_measurement_doesnt_trigger_on_stale_data(self, conn, cfg, org):
        feed(org, conn, cfg, QUIET, QUIET, QUIET)
        org.measure(LOUD, ts=NOW - timedelta(days=20))
        assert drain(conn, cfg) == 1
        assert org.status()[0] == 'healthy'
        assert org.alerts() == []

    def test_latency_can_be_measured(self, conn, cfg, org, owner):
        feed(org, conn, cfg, LOUD, LOUD, LOUD)
        with owner.cursor() as cur:
            cur.execute("""
                SELECT a.created_at - f.ingested_at FROM alert_log a
                JOIN acoustic_features f ON f.node_id = a.node_id AND f."timestamp" = a.measurement_ts
                WHERE a.org_id = %s""", (org.org_id,))
            latency = cur.fetchone()[0]
        assert timedelta(0) <= latency < timedelta(minutes=1)


class TestSystemAlerts:
    def enable_cluster(self, org, owner):
        with owner.cursor() as cur:
            cur.execute('UPDATE cluster_heads SET revoked = false WHERE cluster_id = %s', (org.cluster_id,))

    def heartbeat(self, org, owner, hours_ago, battery=3900):
        with owner.cursor() as cur:
            cur.execute('INSERT INTO node_health ("timestamp", org_id, node_id, battery_mv) VALUES (%s, %s, %s, %s)',
                        (NOW - timedelta(hours=hours_ago), org.org_id, org.node_id, battery))

    def cluster_report(self, org, owner, minutes_ago, sd_free=5000):
        self.enable_cluster(org, owner)
        with owner.cursor() as cur:
            cur.execute('INSERT INTO cluster_health ("timestamp", org_id, cluster_id, sd_free_mb) '
                        'VALUES (%s, %s, %s, %s)',
                        (NOW - timedelta(minutes=minutes_ago), org.org_id, org.cluster_id, sd_free))

    def test_node_without_health_data_raises_nothing(self, conn, cfg, org):
        feed(org, conn, cfg, QUIET)
        scan(conn, cfg)
        assert org.alerts() == []

    def test_offline_node(self, conn, cfg, org, owner):
        feed(org, conn, cfg, QUIET)
        self.heartbeat(org, owner, 60)
        scan(conn, cfg)
        assert [a[0] for a in org.alerts()] == ['node_offline']
        scan(conn, cfg)
        assert len(org.alerts()) == 1  # cooldown

    def test_low_battery(self, conn, cfg, org, owner):
        self.heartbeat(org, owner, 1, battery=3399)
        scan(conn, cfg)
        assert [(a[0], a[1]) for a in org.alerts()] == [('low_battery', 'warning')]

    def test_good_battery_and_recent_heartbeat_raise_nothing(self, conn, cfg, org, owner):
        self.heartbeat(org, owner, 1, battery=3400)
        scan(conn, cfg)
        assert org.alerts() == []

    def test_silent_cluster_head(self, conn, cfg, org, owner):
        self.cluster_report(org, owner, 16)
        scan(conn, cfg)
        assert [(a[0], a[1]) for a in org.alerts()] == [('cluster_offline', 'critical')]

    def test_healthy_cluster_head_raises_nothing(self, conn, cfg, org, owner):
        self.cluster_report(org, owner, 1)
        scan(conn, cfg)
        assert org.alerts() == []

    def test_cluster_head_that_never_reported_isnt_offline(self, conn, cfg, org, owner):
        self.enable_cluster(org, owner)
        scan(conn, cfg)
        assert org.alerts() == []

    def test_low_sd_card(self, conn, cfg, org, owner):
        self.cluster_report(org, owner, 1, sd_free=1023)
        scan(conn, cfg)
        assert [a[0] for a in org.alerts()] == ['sd_low']


def test_matrix_helper_is_30_by_13():
    data = matrix(1.0)
    assert len(data) == 30 and len(data[0]) == 13


class TestMainLoop:
    """The real loop, on its own real connection. Regression test: `with connect() as conn` around
    the loop crash-looped on the first measurement, which no test of the parts could see."""
    def test_classifies_alerts_and_emails_then_stops_cleanly(self, cfg, org, inbox, monkeypatch):
        for level in (LOUD, LOUD, LOUD):
            org.measure(level)
        worker = Worker(cfg, StubClassifier())

        def stop_when_idle(_seconds):
            worker.stop()
        monkeypatch.setattr('nakhel_worker.__main__.time.sleep', stop_when_idle)
        worker.run()

        assert org.status()[0] == 'alert'
        assert [a[0] for a in org.alerts()] == ['infestation_detected']
        assert len(inbox()) == 1

    def test_reconnects_after_losing_the_database(self, cfg, org, monkeypatch):
        org.measure(QUIET)
        worker = Worker(cfg, StubClassifier())
        real_connect = psycopg2.connect
        attempts = []

        def flaky(*args, **kwargs):
            attempts.append(1)
            if len(attempts) == 1:
                raise psycopg2.OperationalError('database restarting')
            return real_connect(*args, **kwargs)
        monkeypatch.setattr('nakhel_worker.__main__.psycopg2.connect', flaky)
        monkeypatch.setattr('nakhel_worker.__main__.time.sleep',
                            lambda _seconds: worker.stop() if len(attempts) > 1 else None)
        worker.run()

        assert len(attempts) == 2
        assert org.status()[0] == 'healthy'

    def test_mail_outage_doesnt_stop_classification(self, cfg, org, monkeypatch):
        org.measure(LOUD)
        worker = Worker(cfg, StubClassifier())
        monkeypatch.setattr('nakhel_worker.mailer.smtplib.SMTP', _refuse)
        monkeypatch.setattr('nakhel_worker.__main__.time.sleep', lambda _seconds: worker.stop())
        worker.run()
        assert org.status()[0] == 'alert'
        assert org.alerts()[0][5] is None  # still queued for later


def _refuse(*_args, **_kwargs):
    raise OSError('connection refused')


class _Refuses(Classifier):
    """Proves the server's model isn't used for a result that came from a node."""
    model_version = 'must-not-appear'

    def predict(self, mfcc):
        raise AssertionError('the classifier ran on a node result')


def node_result(org, owner, confidence, age_minutes=0, model='node-1.0'):
    ts = NOW - timedelta(minutes=5 - age_minutes)
    with owner.cursor() as cur:
        cur.execute('INSERT INTO acoustic_features '
                    '("timestamp", org_id, node_id, cluster_id, confidence, model_version) '
                    'VALUES (%s, %s, %s, %s, %s, %s)',
                    (ts, org.org_id, org.node_id, org.cluster_id, confidence, model))
    return ts


class TestResultsFromNodes:
    def test_stored_as_sent_without_running_the_classifier(self, conn, cfg, org, owner):
        ts = node_result(org, owner, 0.85)
        assert process_next(conn, _Refuses(), cfg) is True
        with owner.cursor() as cur:
            cur.execute('SELECT label, confidence, model_version, inference_ms FROM classification_results '
                        'WHERE node_id = %s AND "timestamp" = %s', (org.node_id, ts))
            label, confidence, model, inference_ms = cur.fetchone()
            assert (label, model, inference_ms) == ('infested', 'node-1.0', None)
            assert confidence == pytest.approx(0.85)
            cur.execute('SELECT status FROM acoustic_features WHERE node_id = %s AND "timestamp" = %s',
                        (org.node_id, ts))
            assert cur.fetchone()[0] == 'classified'

    @pytest.mark.parametrize('confidence,label', [(0.0, 'healthy'), (0.2, 'healthy'), (1.0, 'infested')])
    def test_label_follows_the_probability(self, conn, cfg, org, owner, confidence, label):
        ts = node_result(org, owner, confidence)
        process_next(conn, _Refuses(), cfg)
        with owner.cursor() as cur:
            cur.execute('SELECT label FROM classification_results WHERE node_id = %s AND "timestamp" = %s',
                        (org.node_id, ts))
            assert cur.fetchone()[0] == label

    def test_high_results_raise_an_alert_and_low_results_bring_the_tree_back(self, conn, cfg, org, owner):
        for age in range(3):
            node_result(org, owner, 0.95, age_minutes=age)
        drain(conn, cfg, _Refuses())
        with owner.cursor() as cur:
            cur.execute("SELECT count(*) FROM alert_log WHERE node_id = %s AND alert_type = 'infestation_detected'",
                        (org.node_id,))
            assert cur.fetchone()[0] == 1
            cur.execute('SELECT status FROM node_status WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 'alert'
        for age in range(3, 6):
            node_result(org, owner, 0.05, age_minutes=age)
        drain(conn, cfg, _Refuses())
        with owner.cursor() as cur:
            cur.execute('SELECT status FROM node_status WHERE node_id = %s', (org.node_id,))
            assert cur.fetchone()[0] == 'healthy'
