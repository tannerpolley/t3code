import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('slow-requests.py')


class SlowRequestsTest(unittest.TestCase):
    def test_slow_request_keeps_children_and_fast_request_is_ignored(self):
        def span(name, span_id, parent, duration, attributes=None):
            return dict(type='effect-span', name=name, traceId='trace', spanId=span_id,
                        parentSpanId=parent, startTimeUnixNano='100000000000',
                        endTimeUnixNano=str(100_000_000_000 + int(duration * 1e6)),
                        durationMs=duration, attributes=attributes or {})

        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'trace.ndjson'
            out = Path(directory) / 'slow.ndjson'
            # Children end first, and may be in the preceding rotation.
            trace.with_suffix('.ndjson.1').write_text(json.dumps(span(
                'sqlite', 'query', 'step', 11000,
                {'db.lock_wait_ms': 9500, 'db.query.text': 'SELECT 1',
                 'db.connection': 'writer'})) + '\n')
            trace.write_text('\n'.join(json.dumps(s) for s in [
                span('Database.read', 'step', 'slow', 11500),
                span('ws.rpc.server.read', 'slow', None, 12000),
                span('ws.rpc.server.read', 'fast', None, 10000),
                span('ws.rpc.server.subscribeEvents', 'stream', None, 20000),
            ]) + '\n')
            subprocess.run([sys.executable, str(SCRIPT), '--trace', str(trace),
                            '--out', str(out), '--once'], check=True)
            records = [json.loads(line) for line in out.read_text().splitlines()]
            self.assertEqual(len(records), 1)
            record = records[0]
            self.assertEqual(record['request'], 'ws.rpc.server.read')
            self.assertEqual(record['durationMs'], 12000)
            self.assertEqual(record['time'], '1970-01-01T00:01:52+00:00')
            self.assertEqual(record['slowestDescendants'], [
                dict(name='Database.read', durationMs=11500, lockWaitMs=0),
                dict(name='sqlite', durationMs=11000, lockWaitMs=9500),
            ])
            self.assertEqual(record['topQueries'], [dict(
                query='SELECT 1', durationMs=11000, lockWaitMs=9500, connection='writer')])
            self.assertEqual(len(record['loadAverage']), 3)


if __name__ == '__main__':
    unittest.main()
