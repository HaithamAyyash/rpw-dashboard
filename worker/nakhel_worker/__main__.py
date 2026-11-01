"""The worker's main loop: classify, then periodically scan and send email."""
import logging
import signal
import smtplib
import time

import psycopg2

from . import mailer, pipeline, system_alerts
from .classifier import StubClassifier
from .config import from_env

log = logging.getLogger('nakhel_worker')
RECONNECT_SECONDS = 5
IDLE_DRAIN_LIMIT = 200  # let email and scans run even while a backlog is draining


class Worker:
    def __init__(self, cfg, classifier):
        self.cfg = cfg
        self.classifier = classifier
        self.stopping = False
        self.next_scan = 0.0
        self.next_email = 0.0

    def stop(self, *_):
        self.stopping = True

    def drain_queue(self, conn):
        """Returns how many measurements were handled."""
        handled = 0
        while handled < IDLE_DRAIN_LIMIT and not self.stopping:
            if not pipeline.process_next(conn, self.classifier, self.cfg):
                break
            handled += 1
        return handled

    def run_scan(self, conn):
        if time.monotonic() >= self.next_scan:
            raised = system_alerts.scan(conn, self.cfg)
            if raised:
                log.info('raised %d system alerts', raised)
            self.next_scan = time.monotonic() + self.cfg.system_scan_seconds

    def run_email(self, conn):
        if time.monotonic() < self.next_email:
            return
        try:
            sent = mailer.send_pending(conn, self.cfg)
            if sent:
                log.info('sent %d alert emails', sent)
        except (OSError, smtplib.SMTPException) as error:
            # Alerts stay unsent and queued; classification carries on regardless.
            log.warning('mail server problem, retrying in %.0f s: %s', self.cfg.email_retry_seconds, error)
            self.next_email = time.monotonic() + self.cfg.email_retry_seconds

    def run_once(self, conn):
        """One pass: work through the queue, then anything that's due. True if it did work."""
        handled = self.drain_queue(conn)
        self.run_scan(conn)
        self.run_email(conn)
        return handled > 0

    def run(self):
        while not self.stopping:
            conn = None
            try:
                conn = psycopg2.connect(self.cfg.database_url)
                log.info('connected; model %s', self.classifier.model_version)
                while not self.stopping:
                    if not self.run_once(conn):
                        time.sleep(self.cfg.poll_seconds)
            except psycopg2.OperationalError as error:
                log.warning('database connection lost, retrying: %s', error)
                time.sleep(RECONNECT_SECONDS)
            finally:
                if conn is not None:
                    conn.close()


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    worker = Worker(from_env(), StubClassifier())
    signal.signal(signal.SIGTERM, worker.stop)
    signal.signal(signal.SIGINT, worker.stop)
    worker.run()


if __name__ == '__main__':
    main()
