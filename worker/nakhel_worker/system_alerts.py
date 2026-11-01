"""Scans for conditions no measurement announces: silent nodes, low batteries, cluster heads."""
from datetime import datetime, timezone

from .pipeline import LAST_ALERT_SQL
from .rules import SYSTEM_SEVERITY, LastAlert, should_raise_system

NODES_SQL = """
    SELECT s.org_id, s.node_id, n.tree_label, s.status, s.battery_mv, s.last_heartbeat
    FROM node_status s
    JOIN nodes n ON n.node_id = s.node_id
    WHERE s.status = 'offline' OR s.battery_mv < %s"""

# A cluster head that has never reported isn't "offline" yet: the health endpoints may not be in
# use, and with no data we don't guess (same reasoning as nodes, decision D2).
CLUSTERS_SQL = """
    SELECT c.org_id, c.cluster_id, c.name, h."timestamp", h.sd_free_mb
    FROM cluster_heads c
    CROSS JOIN LATERAL (
      SELECT ch."timestamp", ch.sd_free_mb FROM cluster_health ch
      WHERE ch.org_id = c.org_id AND ch.cluster_id = c.cluster_id
      ORDER BY ch."timestamp" DESC LIMIT 1
    ) h
    WHERE NOT c.revoked"""

LAST_CLUSTER_ALERT_SQL = """
    SELECT created_at, acknowledged FROM alert_log
    WHERE org_id = %s AND cluster_id = %s AND alert_type = %s
    ORDER BY "timestamp" DESC, alert_id DESC LIMIT 1"""

INSERT_SQL = """
    INSERT INTO alert_log (org_id, "timestamp", node_id, cluster_id, alert_type, severity, message)
    VALUES (%s, %s, %s, %s, %s, %s, %s)"""


def _raise(cur, cfg, now, org_id, node_id, cluster_id, alert_type, message):
    if node_id is not None:
        cur.execute(LAST_ALERT_SQL, (org_id, node_id, alert_type))
    else:
        cur.execute(LAST_CLUSTER_ALERT_SQL, (org_id, cluster_id, alert_type))
    row = cur.fetchone()
    last = LastAlert(*row) if row else None
    if should_raise_system(last, now, cfg.cooldown_hours, cfg.acknowledged_quiet_days):
        cur.execute(INSERT_SQL, (org_id, now, node_id, cluster_id, alert_type, SYSTEM_SEVERITY[alert_type], message))
        return True
    return False


def scan(conn, cfg):
    """Returns how many alerts were raised."""
    now = datetime.now(timezone.utc)
    raised = 0
    with conn, conn.cursor() as cur:
        cur.execute(NODES_SQL, (cfg.low_battery_mv,))
        for org_id, node_id, label, status, battery_mv, _heartbeat in cur.fetchall():
            if status == 'offline':
                raised += _raise(cur, cfg, now, org_id, node_id, None, 'node_offline',
                                 f'{label}: no heartbeat for over 56 hours')
            if battery_mv is not None and battery_mv < cfg.low_battery_mv:
                raised += _raise(cur, cfg, now, org_id, node_id, None, 'low_battery',
                                 f'{label}: battery at {battery_mv} mV')
        cur.execute(CLUSTERS_SQL)
        for org_id, cluster_id, name, seen, sd_free_mb in cur.fetchall():
            minutes_silent = (now - seen).total_seconds() / 60
            if minutes_silent >= cfg.cluster_offline_minutes:
                raised += _raise(cur, cfg, now, org_id, None, cluster_id, 'cluster_offline',
                                 f'{name}: no health report for {minutes_silent:.0f} minutes')
            if sd_free_mb is not None and sd_free_mb < cfg.sd_low_mb:
                raised += _raise(cur, cfg, now, org_id, None, cluster_id, 'sd_low',
                                 f'{name}: SD card has {sd_free_mb} MB free')
    return raised
