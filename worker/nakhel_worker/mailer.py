"""Sends alert email. Alerts are the queue: email_sent_at empty means it hasn't gone yet, so a
crash or SMTP outage loses nothing. A crash between sending and stamping can send a repeat."""
import logging
import smtplib
from email.message import EmailMessage
from urllib.parse import quote
from zoneinfo import ZoneInfo

from .rules import EMAIL_TYPES

log = logging.getLogger(__name__)

UNSENT_SQL = """
    SELECT a.alert_id, a.org_id, a."timestamp", a.alert_type, a.severity, a.confidence, a.message,
           n.tree_label, COALESCE(n.farm_zone, c.farm_zone), n.lora_id, c.name,
           o.name, o.slug, o.timezone
    FROM alert_log a
    JOIN organizations o ON o.org_id = a.org_id
    LEFT JOIN nodes n ON n.node_id = a.node_id
    LEFT JOIN cluster_heads c ON c.cluster_id = a.cluster_id
    WHERE a.email_sent_at IS NULL AND a.alert_type = ANY(%s)
    ORDER BY a.created_at
    LIMIT 50"""

OWNERS_SQL = """
    SELECT u.email FROM organization_members m JOIN users u ON u.user_id = m.user_id
    WHERE m.org_id = %s AND m.role = 'owner' ORDER BY u.email"""

TITLES = {
    'infestation_detected': 'Infestation detected',
    'infestation_suspected': 'Infestation suspected',
    'cluster_offline': 'Cluster head offline',
}


def single_line(text):
    """Labels are typed by users; a line break in an email header would be refused."""
    return ' '.join(str(text).split())


def build_message(alert, owners, cfg):
    (_alert_id, _org_id, when, alert_type, _severity, confidence, message,
     tree_label, zone, lora_id, cluster_name, org_name, slug, tz_name) = alert
    subject_target = tree_label or cluster_name
    link = f'{cfg.app_base_url}/{slug}'
    if tree_label:
        link += f'?q={quote(tree_label)}'
    local_time = when.astimezone(ZoneInfo(tz_name)).strftime('%d %b %Y, %H:%M')

    lines = [f'{TITLES[alert_type]} at {org_name}.', '', message, '']
    if tree_label:
        lines += [f'Tree: {tree_label}', f'Node (LoRa ID): {lora_id}']
    if cluster_name:
        lines.append(f'Cluster head: {cluster_name}')
    if zone:
        lines.append(f'Farm zone: {zone}')
    if confidence is not None:
        lines.append(f'Confidence: {confidence:.0%}')
    lines += [f'Time: {local_time} ({tz_name})', '', f'Open in the dashboard: {link}']

    email = EmailMessage()
    email['Subject'] = single_line(f'[NAKHEL] {TITLES[alert_type]}: {subject_target}')
    email['From'] = cfg.email_from
    email['To'] = ', '.join(owners)
    email.set_content('\n'.join(lines))
    return email


def open_smtp(cfg):
    smtp = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=20)
    if cfg.smtp_starttls:
        smtp.starttls()
    if cfg.smtp_user:
        smtp.login(cfg.smtp_user, cfg.smtp_password)
    return smtp


def send_pending(conn, cfg):
    """Sends up to one batch, only ever to that alert's own organization's owners. Returns how
    many went. Raises OSError or SMTPException if the mail server is unreachable."""
    with conn, conn.cursor() as cur:
        cur.execute(UNSENT_SQL, (list(EMAIL_TYPES),))
        alerts = cur.fetchall()
    if not alerts:
        return 0
    sent = 0
    with open_smtp(cfg) as smtp:
        for alert in alerts:
            alert_id, org_id = alert[0], alert[1]
            with conn, conn.cursor() as cur:
                cur.execute(OWNERS_SQL, (org_id,))
                owners = [row[0] for row in cur.fetchall()]
            try:
                smtp.send_message(build_message(alert, owners, cfg))
            except smtplib.SMTPRecipientsRefused:
                # Permanent for this alert. Stamped below so it can't block the queue forever.
                log.exception('all owners refused for alert %s', alert_id)
            with conn, conn.cursor() as cur:
                cur.execute('UPDATE alert_log SET email_sent_at = clock_timestamp() WHERE alert_id = %s', (alert_id,))
            sent += 1
    return sent
