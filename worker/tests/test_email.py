"""Alert email through a real SMTP server (Mailpit)."""
import smtplib

import pytest
from conftest import LOUD, QUIET, mailpit
from test_pipeline import TestSystemAlerts, feed
from nakhel_worker.classifier import StubClassifier
from nakhel_worker.mailer import send_pending
from nakhel_worker.pipeline import process_next
from nakhel_worker.system_alerts import scan

CLUSTERS = TestSystemAlerts()


def full(message):
    return mailpit(f"/message/{message['ID']}")


def to(message):
    return sorted(address['Address'] for address in message['To'])


def test_nothing_to_send(conn, cfg, inbox):
    assert send_pending(conn, cfg) == 0
    assert inbox() == []


def test_goes_to_that_orgs_owners_only(conn, cfg, inbox, make_org):
    a = make_org(owners=2)
    b = make_org()
    feed(a, conn, cfg, LOUD, LOUD, LOUD)
    feed(b, conn, cfg, QUIET, QUIET, QUIET)
    assert send_pending(conn, cfg) == 1
    messages = inbox()
    assert len(messages) == 1
    assert to(messages[0]) == sorted(a.owner_emails)
    assert not set(to(messages[0])) & set(b.owner_emails)


def test_two_orgs_each_hear_only_about_their_own_tree(conn, cfg, inbox, make_org):
    a, b = make_org(), make_org()
    feed(a, conn, cfg, LOUD, LOUD, LOUD)
    feed(b, conn, cfg, LOUD, LOUD, LOUD)
    assert send_pending(conn, cfg) == 2
    by_owner = {to(m)[0]: full(m)['Text'] for m in inbox()}
    assert a.slug in by_owner[a.owner_emails[0]]
    assert b.slug not in by_owner[a.owner_emails[0]]
    assert b.slug in by_owner[b.owner_emails[0]]
    assert a.slug not in by_owner[b.owner_emails[0]]


def test_has_everything_the_brief_lists(conn, cfg, inbox, org):
    feed(org, conn, cfg, LOUD, LOUD, LOUD)
    send_pending(conn, cfg)
    message = full(inbox()[0])
    assert message['Subject'] == '[NAKHEL] Infestation detected: T-1'
    text = message['Text']
    for expected in ('Tree: T-1', 'Node (LoRa ID): 1000', 'Farm zone: Zone A', 'Confidence: ', 'Asia/Dubai',
                     f'{cfg.app_base_url}/{org.slug}?q=T-1'):
        assert expected in text


def test_time_is_in_the_orgs_time_zone(conn, cfg, inbox, make_org, owner):
    org = make_org(timezone_name='America/New_York')
    feed(org, conn, cfg, LOUD, LOUD, LOUD)
    send_pending(conn, cfg)
    with owner.cursor() as cur:
        cur.execute("SELECT to_char(\"timestamp\" AT TIME ZONE 'America/New_York', 'DD Mon YYYY, HH24:MI') "
                    'FROM alert_log WHERE org_id = %s', (org.org_id,))
        expected = cur.fetchone()[0]
    assert f'Time: {expected} (America/New_York)' in full(inbox()[0])['Text']


def test_sends_only_once(conn, cfg, inbox, org):
    feed(org, conn, cfg, LOUD, LOUD, LOUD)
    assert send_pending(conn, cfg) == 1
    assert send_pending(conn, cfg) == 0
    assert len(inbox()) == 1
    assert org.alerts()[0][5] is not None


def test_cluster_offline_emails_but_low_battery_doesnt(conn, cfg, inbox, make_org, owner):
    org = make_org()
    CLUSTERS.cluster_report(org, owner, 20)
    CLUSTERS.heartbeat(org, owner, 1, battery=3000)
    scan(conn, cfg)
    assert {a[0] for a in org.alerts()} == {'cluster_offline', 'low_battery'}
    assert send_pending(conn, cfg) == 1
    assert full(inbox()[0])['Subject'] == '[NAKHEL] Cluster head offline: CH-01'


def test_line_break_in_a_tree_label_cant_inject_headers(conn, cfg, inbox, org):
    node = org.add_node(2000, 'T-2\r\nBcc: attacker@evil.example')
    org.measure(LOUD, node_id=node)
    org.measure(LOUD, node_id=node)
    while process_next(conn, StubClassifier(), cfg):
        pass
    assert send_pending(conn, cfg) == 1
    message = full(inbox()[0])
    assert message['Bcc'] == []
    assert 'Bcc: attacker' in message['Subject']


def test_mail_server_down_keeps_the_alert_queued(conn, cfg, inbox, org, monkeypatch):
    feed(org, conn, cfg, LOUD, LOUD, LOUD)

    def refuse(*_args, **_kwargs):
        raise OSError('connection refused')
    monkeypatch.setattr(smtplib, 'SMTP', refuse)
    with pytest.raises(OSError):
        send_pending(conn, cfg)
    assert org.alerts()[0][5] is None
    monkeypatch.undo()
    assert send_pending(conn, cfg) == 1
    assert len(inbox()) == 1
