"""Settings from the environment."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:  # pylint: disable=too-many-instance-attributes
    database_url: str
    app_base_url: str = 'http://127.0.0.1:3100'
    smtp_host: str = 'mailpit'
    smtp_port: int = 1025
    smtp_user: str = ''
    smtp_password: str = ''
    smtp_starttls: bool = False
    email_from: str = 'NAKHEL Alerts <alerts@nakhel.local>'
    poll_seconds: float = 2.0
    system_scan_seconds: float = 60.0
    email_retry_seconds: float = 60.0
    cooldown_hours: float = 24.0
    acknowledged_quiet_days: float = 7.0
    low_battery_mv: int = 3400          # decision D3
    sd_low_mb: int = 1024               # decision D3
    cluster_offline_minutes: float = 15.0  # decision D3


def from_env():
    env = os.environ
    return Config(
        database_url=env['DATABASE_URL'],
        app_base_url=env.get('APP_BASE_URL', Config.app_base_url).rstrip('/'),
        smtp_host=env.get('SMTP_HOST', Config.smtp_host),
        smtp_port=int(env.get('SMTP_PORT', Config.smtp_port)),
        smtp_user=env.get('SMTP_USER', ''),
        smtp_password=env.get('SMTP_PASSWORD', ''),
        smtp_starttls=env.get('SMTP_STARTTLS', 'false').lower() == 'true',
        email_from=env.get('EMAIL_FROM', Config.email_from),
    )
