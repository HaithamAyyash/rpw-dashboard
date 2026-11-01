"""Preprocessing, the stub, status bands and alert rules. No database."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import numpy as np
import pytest
from conftest import LOUD, MIDDLE, QUIET, matrix
from nakhel_worker.classifier import StubClassifier
from nakhel_worker.preprocess import BadMeasurement, preprocess
from nakhel_worker.rules import LastAlert, should_raise_infestation, should_raise_system
from nakhel_worker.status import ALERT, HEALTHY, SUSPECTED, band

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def ago(hours):
    return NOW - timedelta(hours=hours)


class TestPreprocess:
    def test_passes_a_good_matrix_through(self):
        out = preprocess(matrix(5.0))
        assert out.shape == (30, 13) and out.dtype == np.float32

    @pytest.mark.parametrize('bad', [[[1.0] * 13] * 29, [[1.0] * 12] * 30, [1.0] * 30, []])
    def test_refuses_wrong_shapes(self, bad):
        with pytest.raises(BadMeasurement):
            preprocess(bad)

    def test_refuses_nan(self):
        bad = [[float('nan')] * 13] * 30
        with pytest.raises(BadMeasurement):
            preprocess(bad)

    def test_normalizes_per_coefficient(self):
        stats = {'mean': [1.0] * 13, 'std': [2.0] * 13}
        out = preprocess([[3.0] * 13] * 30, stats)
        assert out[0][0] == pytest.approx(1.0)

    def test_refuses_zero_std(self):
        with pytest.raises(BadMeasurement):
            preprocess([[3.0] * 13] * 30, {'mean': [1.0] * 13, 'std': [0.0] * 13})


class TestStub:
    def test_is_labelled_fake(self):
        assert 'FAKE' in StubClassifier.model_version

    def test_deterministic(self):
        data = preprocess(matrix(9.0))
        assert StubClassifier().predict(data) == StubClassifier().predict(data)

    def test_confidence_is_probability_of_infested_for_either_label(self):
        quiet = StubClassifier().predict(preprocess(matrix(QUIET)))
        loud = StubClassifier().predict(preprocess(matrix(LOUD)))
        assert quiet.label == 'healthy' and quiet.confidence < 0.2
        assert loud.label == 'infested' and loud.confidence > 0.9
        assert 0.2 < StubClassifier().predict(preprocess(matrix(MIDDLE))).confidence < 0.8


class TestBand:
    @pytest.mark.parametrize('average,expected', [
        (None, HEALTHY), (Decimal('0.499'), HEALTHY), (Decimal('0.5'), SUSPECTED),
        (Decimal('0.799'), SUSPECTED), (Decimal('0.8'), ALERT), (Decimal('1'), ALERT),
    ])
    def test_edges_are_inclusive(self, average, expected):
        assert band(average, Decimal('0.5'), Decimal('0.8')) == expected

    def test_uses_the_given_thresholds(self):
        assert band(Decimal('0.6'), Decimal('0.2'), Decimal('0.3')) == ALERT
        assert band(Decimal('0.6'), Decimal('0.7'), Decimal('0.9')) == HEALTHY


class TestInfestationRule:
    @staticmethod
    def decide(previous, current, last=None):
        return should_raise_infestation(previous, current, last, NOW, 24)

    def test_healthy_never_alerts(self):
        assert not self.decide(ALERT, HEALTHY)
        assert not self.decide(HEALTHY, HEALTHY)

    def test_first_crossing_alerts(self):
        assert self.decide(HEALTHY, SUSPECTED)
        assert self.decide(HEALTHY, ALERT)

    def test_escalation_alerts_even_with_recent_suspected(self):
        # last is the latest of the NEW type, so an open "suspected" doesn't block "detected".
        assert self.decide(SUSPECTED, ALERT, None)

    def test_cooldown_blocks_a_repeat_crossing_within_24_h(self):
        assert not self.decide(HEALTHY, ALERT, LastAlert(ago(23), False))

    def test_staying_in_alert_stays_quiet_during_cooldown(self):
        assert not self.decide(ALERT, ALERT, LastAlert(ago(1), False))

    def test_ignored_alert_is_repeated_after_cooldown(self):
        assert self.decide(ALERT, ALERT, LastAlert(ago(24), False))

    def test_acknowledged_tree_staying_infested_stays_quiet(self):
        assert not self.decide(ALERT, ALERT, LastAlert(ago(1), True))
        assert not self.decide(ALERT, ALERT, LastAlert(ago(500), True))

    def test_new_crossing_after_acknowledgement_alerts_at_once(self):
        assert self.decide(HEALTHY, ALERT, LastAlert(ago(1), True))

    def test_improving_doesnt_alert(self):
        assert not self.decide(ALERT, SUSPECTED, None)

    def test_never_told_tree_alerts_even_without_crossing(self):
        """E.g. an owner lowered the threshold under a tree that was already there."""
        assert self.decide(SUSPECTED, SUSPECTED, None)


class TestSystemRule:
    @staticmethod
    def decide(last):
        return should_raise_system(last, NOW, 24, 7)

    def test_first_time_raises(self):
        assert self.decide(None)

    def test_unacknowledged_repeats_daily(self):
        assert not self.decide(LastAlert(ago(23), False))
        assert self.decide(LastAlert(ago(24), False))

    def test_acknowledged_stays_quiet_for_a_week(self):
        assert not self.decide(LastAlert(ago(24 * 6), True))
        assert self.decide(LastAlert(ago(24 * 7), True))
