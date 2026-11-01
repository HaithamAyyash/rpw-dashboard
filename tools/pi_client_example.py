#!/usr/bin/env python3
"""Reference client for the NAKHEL ingestion API, for the Pi team to copy into the real daemon.

Shows the auth header, timeouts and retry rules from docs/contracts/cluster_head_to_cloud.md.
Needs only `requests`. The SQLite buffer is the Pi team's; the three comments marked BUFFER show
where it plugs in.

Try it:  python pi_client_example.py --url http://127.0.0.1:3100 --key nkh_... --lora-id 1000
"""
import argparse
import random
import time
import uuid
from datetime import datetime, timezone
from enum import Enum

import requests

ENDPOINT = '/api/v1/ingest/measurements'
TIMEOUT_SECONDS = (5, 15)  # (connect, read). Never call requests without a timeout.
FIRST_RETRY_SECONDS = 5
MAX_RETRY_SECONDS = 600
CLOCK_DRIFT_WARNING_SECONDS = 60


class Outcome(Enum):
    """What the daemon must do with a message after one attempt."""
    DELETE = 'delete from the buffer'         # 200, 201: the server has it
    REJECT = 'move to the rejected table'     # 400, 413, 422: retrying can't help
    STOP = 'stop sending, alert the operator'  # 401: bad or revoked key
    RETRY = 'keep it, retry with backoff'     # 429, 5xx, timeout, no network


def classify_status(status):
    if status in (200, 201):
        return Outcome.DELETE
    if status == 401:
        return Outcome.STOP
    if status == 429 or status >= 500:
        return Outcome.RETRY
    if 400 <= status < 500:
        return Outcome.REJECT
    return Outcome.RETRY  # anything unexpected: the safe choice is to keep the data


def clock_drift_seconds(server_time, now=None):
    """How far this Pi's clock is ahead of the server's (negative = behind)."""
    server = datetime.fromisoformat(server_time.replace('Z', '+00:00'))
    return ((now or datetime.now(timezone.utc)) - server).total_seconds()


def send_measurement(session, base_url, api_key, measurement):
    """One attempt. Returns (Outcome, response JSON or None)."""
    try:
        response = session.post(
            base_url.rstrip('/') + ENDPOINT,
            json=measurement,
            headers={'Authorization': f'Bearer {api_key}'},
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        print(f'network error: {error}')
        return Outcome.RETRY, None
    try:
        body = response.json()
    except ValueError:  # e.g. an HTML error page from a proxy
        body = None
    if body and 'server_time' in body:
        drift = clock_drift_seconds(body['server_time'])
        if abs(drift) > CLOCK_DRIFT_WARNING_SECONDS:
            print(f'warning: Pi clock is {drift:+.0f} s off server time')
    return classify_status(response.status_code), body


def backoff_delays(first=FIRST_RETRY_SECONDS, cap=MAX_RETRY_SECONDS):
    """5, 10, 20, ... up to 10 min. With up to 20% jitter, so cluster heads recovering from the
    same outage don't all retry at the same moment."""
    delay = first
    while True:
        yield delay * (1 + random.random() * 0.2)
        delay = min(delay * 2, cap)


def deliver(session, base_url, api_key, measurement, sleep=time.sleep):
    """Sends one message until it has a final outcome: DELETE, REJECT or STOP."""
    for delay in backoff_delays():
        outcome, body = send_measurement(session, base_url, api_key, measurement)
        if outcome is not Outcome.RETRY:
            return outcome, body
        sleep(delay)  # BUFFER: the message stays in SQLite while waiting, so a crash loses nothing
    raise AssertionError('unreachable')


def run_daemon_step(session, base_url, api_key, measurement):
    """What one message's handling looks like in the daemon."""
    outcome, body = deliver(session, base_url, api_key, measurement)
    if outcome is Outcome.DELETE:
        print(f"{body['status']}: LoRa {body['node_id']} at {body['timestamp']}")
        # BUFFER: DELETE the row from SQLite. Only now; never before the server has answered.
    elif outcome is Outcome.REJECT:
        print(f"rejected: {body['error'] if body else 'no details'}")
        # BUFFER: move the row to the "rejected" table and log it.
    elif outcome is Outcome.STOP:
        print('API key refused: stop sending and alert the operator')
        # BUFFER: keep every row. Sending resumes once the operator installs a valid key.
    return outcome


def example_measurement(lora_id):
    """Demo data. In the daemon, mfcc comes from the reconstructed LoRa packet."""
    return {
        'node_id': lora_id,
        'timestamp': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'mfcc': [[round(random.gauss(-300 if c == 0 else 0, 5), 3) for c in range(13)] for _ in range(30)],
        # Optional fields; leave out any you don't have.
        'msg_id': str(uuid.uuid4()),
        'snr_db': 7.5,
        'rssi_dbm': -101,
        'schema_version': 1,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--lora-id', type=int, required=True)
    args = parser.parse_args()
    with requests.Session() as session:
        outcome = run_daemon_step(session, args.url, args.key, example_measurement(args.lora_id))
    raise SystemExit(0 if outcome is Outcome.DELETE else 1)


if __name__ == '__main__':
    main()
