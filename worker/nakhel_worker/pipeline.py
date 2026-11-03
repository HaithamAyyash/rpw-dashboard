"""One measurement through classify -> status -> alert, in one transaction."""
import logging
from datetime import datetime, timezone
from time import perf_counter

import psycopg2

from .classifier.base import prediction_from_probability
from .preprocess import preprocess
from .rules import INFESTATION_TYPES, LastAlert, should_raise_infestation
from .status import band

log = logging.getLogger(__name__)

# SKIP LOCKED: a second worker could run alongside this one and never take the same row.
CLAIM_SQL = """
    SELECT f."timestamp", f.org_id, f.node_id, f.mfcc, f.confidence, f.model_version
    FROM acoustic_features f
    WHERE f.status = 'pending'
    ORDER BY f.ingested_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED"""

NODE_STATE_SQL = """
    SELECT nc.avg_confidence, o.suspect_threshold, o.alert_threshold, n.tree_label
    FROM node_current nc
    JOIN organizations o ON o.org_id = nc.org_id
    JOIN nodes n ON n.node_id = nc.node_id
    WHERE nc.node_id = %s"""

LAST_ALERT_SQL = """
    SELECT created_at, acknowledged FROM alert_log
    WHERE org_id = %s AND node_id = %s AND alert_type = %s
    ORDER BY "timestamp" DESC, alert_id DESC LIMIT 1"""

# clock_timestamp(), because now() in Postgres is when the transaction began and these two
# columns are the latency measurements for the report.
INSERT_RESULT_SQL = """
    INSERT INTO classification_results
      ("timestamp", org_id, node_id, label, confidence, model_version, inference_ms, processed_at)
    VALUES (%s, %s, %s, %s, %s, %s, %s, clock_timestamp())
    ON CONFLICT (node_id, "timestamp", model_version) DO NOTHING"""

INSERT_ALERT_SQL = """
    INSERT INTO alert_log (org_id, "timestamp", created_at, measurement_ts, node_id, alert_type,
                           severity, confidence, message)
    VALUES (%s, %s, clock_timestamp(), %s, %s, %s, %s, %s, %s)"""

MARK_SQL = 'UPDATE acoustic_features SET status = %s WHERE node_id = %s AND "timestamp" = %s'


def infestation_message(tree_label, average):
    return f'{tree_label}: last-3 average infestation confidence {float(average):.0%}'


def raise_infestation_alert(cur, cfg, org_id, node_id, measurement_ts, previous_average, now):
    """Compare the tree's band before and after this result. org_id comes from the source row."""
    cur.execute(NODE_STATE_SQL, (node_id,))
    average, suspect, alert, tree_label = cur.fetchone()
    previous = band(previous_average, suspect, alert)
    current = band(average, suspect, alert)
    if current not in INFESTATION_TYPES:
        return None
    alert_type, severity = INFESTATION_TYPES[current]
    cur.execute(LAST_ALERT_SQL, (org_id, node_id, alert_type))
    row = cur.fetchone()
    last = LastAlert(*row) if row else None
    if not should_raise_infestation(previous, current, last, now, cfg.cooldown_hours):
        return None
    cur.execute(INSERT_ALERT_SQL, (org_id, measurement_ts, measurement_ts, node_id, alert_type, severity,
                                   float(average), infestation_message(tree_label, average)))
    return alert_type


def process_next(conn, classifier, cfg, stats=None):
    """Handle one pending measurement. Returns False when the queue is empty.
    A connection problem propagates, leaving the row pending. Anything else wrong with this one
    measurement marks it failed, so one bad row can't stop the queue for every organization."""
    node_id = measurement_ts = None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CLAIM_SQL)
            row = cur.fetchone()
            if row is None:
                return False
            measurement_ts, org_id, node_id, mfcc, node_confidence, node_model = row

            if node_confidence is not None:
                # The node already ran a model. Only the classification step is skipped.
                prediction = prediction_from_probability(node_confidence)
                model_version, inference_ms = node_model, None
            else:
                started = perf_counter()
                prediction = classifier.predict(preprocess(mfcc, stats))
                inference_ms = (perf_counter() - started) * 1000
                model_version = classifier.model_version

            cur.execute('SELECT avg_confidence FROM node_current WHERE node_id = %s', (node_id,))
            previous_average = cur.fetchone()[0]
            cur.execute(INSERT_RESULT_SQL, (measurement_ts, org_id, node_id, prediction.label,
                                            prediction.confidence, model_version, inference_ms))
            cur.execute(MARK_SQL, ('classified', node_id, measurement_ts))
            raise_infestation_alert(cur, cfg, org_id, node_id, measurement_ts, previous_average,
                                    datetime.now(timezone.utc))
    except psycopg2.OperationalError:
        raise
    except Exception:
        if node_id is None:
            raise
        log.exception('could not process node %s at %s', node_id, measurement_ts)
        with conn, conn.cursor() as cur:  # the first transaction has rolled back, so nothing half-done
            cur.execute(MARK_SQL, ('failed', node_id, measurement_ts))
    return True
