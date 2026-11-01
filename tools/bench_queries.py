#!/usr/bin/env python3
"""Time every file in db/queries as nakhel_web against the large seed. Run with: ./db.sh bench

--explain NAME prints EXPLAIN ANALYZE for one query instead.
"""
import argparse
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from time import perf_counter

import psycopg2

QUERIES = Path(__file__).resolve().parents[1] / 'db' / 'queries'


def parse_params(text):
    match = re.search(r'^-- @params (.+)$', text, re.M)
    return [p.split(':') for p in match.group(1).split()] if match else []


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--org', default='scale-test')
    parser.add_argument('--runs', type=int, default=7)
    parser.add_argument('--explain')
    parser.add_argument('--host', default=os.environ.get('NAKHEL_DB_HOST', 'db'))
    args = parser.parse_args()

    owner = psycopg2.connect(host=args.host, dbname='nakhel', user='nakhel_owner',
                             password=os.environ['NAKHEL_OWNER_PASSWORD'])
    with owner.cursor() as cur:
        cur.execute('SELECT org_id FROM organizations WHERE slug = %s', (args.org,))
        org_id = cur.fetchone()[0]
        # A node with data, like the one a user would actually open.
        cur.execute('SELECT node_id FROM classification_results WHERE org_id = %s '
                    'ORDER BY "timestamp" DESC LIMIT 1', (org_id,))
        node_id = cur.fetchone()[0]
    owner.close()

    now = datetime.now(timezone.utc)
    values = {
        'zone': None, 'status': None, 'q': None, 'limit': 50, 'offset': 0, 'node_id': node_id,
        'from': now - timedelta(days=7), 'to': now, 'bucket': '1 hour', 'label': None,
        'min_conf': None, 'sort': 'time_desc', 'severity': None, 'acknowledged': None,
        'include_mfcc': False, 'batch': 50,
    }
    conn = psycopg2.connect(host=args.host, dbname='nakhel', user='nakhel_web',
                            password=os.environ['NAKHEL_WEB_PASSWORD'])
    print(f"{'query':28}{'rows':>7}{'median ms':>11}{'max ms':>9}")
    for path in sorted(QUERIES.glob('*.sql')):
        if path.stem.startswith('worker_') or (args.explain and args.explain != path.stem):
            continue
        text = path.read_text().rstrip().rstrip(';')
        params = parse_params(text)
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.current_org', %s, true)", (str(org_id),))
            if params:
                types = ', '.join(t for _, t in params)
                cur.execute(f'PREPARE q({types}) AS {text}')
                call = f'EXECUTE q({", ".join(["%s"] * len(params))})'
            else:
                call = text
            call_args = [values[n] for n, _ in params] or None
            if args.explain:
                cur.execute('EXPLAIN (ANALYZE, BUFFERS) ' + call, call_args)
                print('\n'.join(r[0] for r in cur.fetchall()))
                cur.execute('DEALLOCATE ALL')
                conn.rollback()
                continue
            times, rows = [], 0
            for _ in range(args.runs):
                start = perf_counter()
                cur.execute(call, call_args)
                rows = len(cur.fetchall())
                times.append((perf_counter() - start) * 1000)
            cur.execute('DEALLOCATE ALL')
        conn.rollback()
        print(f'{path.stem:28}{rows:>7}{median(times):>11.1f}{max(times):>9.1f}')
    conn.close()


if __name__ == '__main__':
    main()
