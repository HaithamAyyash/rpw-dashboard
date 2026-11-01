"""The reference client's retry rules, against a real local HTTP server."""
import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from itertools import islice
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# pylint: disable=wrong-import-position
import pi_client_example as client
from pi_client_example import Outcome


class Script(BaseHTTPRequestHandler):
    """Answers each POST with the next status from server.script, recording what it received."""
    def do_POST(self):  # pylint: disable=invalid-name
        length = int(self.headers['Content-Length'])
        self.server.received.append((self.headers.get('Authorization'), json.loads(self.rfile.read(length))))
        status, body = self.server.script.pop(0)
        self.send_response(status)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    httpd = HTTPServer(('127.0.0.1', 0), Script)
    httpd.received = []
    httpd.script = []
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()


def url(httpd):
    return f'http://127.0.0.1:{httpd.server_port}'


def ok(status='stored'):
    now = datetime.now(timezone.utc).isoformat()
    return json.dumps({'status': status, 'node_id': 1, 'timestamp': 't', 'server_time': now})


ERROR = json.dumps({'error': {'code': 'x', 'message': 'y'}, 'server_time': '2026-01-01T00:00:00Z'})


@pytest.mark.parametrize('status,outcome', [
    (201, Outcome.DELETE), (200, Outcome.DELETE),
    (400, Outcome.REJECT), (413, Outcome.REJECT), (422, Outcome.REJECT),
    (401, Outcome.STOP),
    (429, Outcome.RETRY), (500, Outcome.RETRY), (502, Outcome.RETRY), (503, Outcome.RETRY),
])
def test_every_row_of_the_response_table(status, outcome):
    assert client.classify_status(status) is outcome


def test_sends_bearer_key_and_json(server):
    server.script = [(201, ok())]
    with requests.Session() as session:
        outcome, body = client.send_measurement(session, url(server), 'nkh_key', {'node_id': 1})
    assert outcome is Outcome.DELETE and body['status'] == 'stored'
    assert server.received == [('Bearer nkh_key', {'node_id': 1})]


def test_retries_5xx_with_growing_delays_then_delivers(server):
    server.script = [(500, ERROR), (503, 'not json'), (429, ''), (200, ok('duplicate'))]
    delays = []
    with requests.Session() as session:
        outcome, body = client.deliver(session, url(server), 'k', {}, sleep=delays.append)
    assert outcome is Outcome.DELETE and body['status'] == 'duplicate'
    assert len(delays) == 3
    assert 5 <= delays[0] <= 6 and 10 <= delays[1] <= 12 and 20 <= delays[2] <= 24


@pytest.mark.parametrize('status,outcome', [(422, Outcome.REJECT), (401, Outcome.STOP), (400, Outcome.REJECT)])
def test_final_answers_are_not_retried(server, status, outcome):
    server.script = [(status, ERROR)]
    with requests.Session() as session:
        result, _ = client.deliver(session, url(server), 'k', {}, sleep=pytest.fail)
    assert result is outcome
    assert len(server.received) == 1


def test_connection_refused_is_retried():
    with requests.Session() as session:
        outcome, body = client.send_measurement(session, 'http://127.0.0.1:9', 'k', {})
    assert outcome is Outcome.RETRY and body is None


def test_backoff_caps_at_ten_minutes():
    delays = list(islice(client.backoff_delays(), 12))
    assert all(a <= 600 * 1.2 for a in delays)
    assert delays[-1] >= 600


def test_clock_drift():
    now = datetime(2026, 1, 1, 0, 0, 10, tzinfo=timezone.utc)
    assert client.clock_drift_seconds('2026-01-01T00:00:00.000Z', now) == 10
    assert client.clock_drift_seconds((now + timedelta(seconds=5)).isoformat(), now) == -5


def test_example_measurement_has_the_right_shape():
    measurement = client.example_measurement(5)
    assert len(measurement['mfcc']) == 30 and all(len(row) == 13 for row in measurement['mfcc'])
    assert measurement['timestamp'].endswith('Z')
