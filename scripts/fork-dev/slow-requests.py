#!/usr/bin/env python3
"""Keep slow RPC evidence outside the server's short-lived trace rotation."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import heapq
import json
import os
from pathlib import Path
import time

WINDOW_SECONDS = 15 * 60
MAX_SPANS = 100_000
MAX_LOG_BYTES = 20 * 1024 * 1024
RETENTION_SECONDS = 14 * 24 * 60 * 60
# Subscription RPCs whose names do not contain a subscribe-prefixed segment.
LONG_LIVED_RPC_SPANS = {
    'ws.rpc.terminal.attach',
    'ws.rpc.terminal.observe',
    'ws.rpc.terminal.watchInlineRun',
    'ws.rpc.server.getStorageCleanupReport',
    'ws.rpc.server.getDatabaseStorage',
    'ws.rpc.orchestration.searchThreadStream',
}


class SpanWindow:
    def __init__(self):
        self.spans = {}
        self.children = defaultdict(set)
        self.expiry = []
        self.latest_end = 0

    def discard(self, key):
        span = self.spans.pop(key)
        siblings = self.children[span['parent']]
        siblings.discard(key)
        if not siblings:
            del self.children[span['parent']]

    def feed(self, line):
        try:
            raw = json.loads(line)
            if raw.get('type') != 'effect-span':
                return None
            end = int(raw['endTimeUnixNano']) / 1e9
            key = (raw['traceId'], raw['spanId'])
            parent = (raw['traceId'], raw.get('parentSpanId'))
            name = raw['name']
            duration = float(raw['durationMs'])
            attrs = raw.get('attributes', {})
            span = dict(name=name, durationMs=duration,
                        lockWaitMs=float(attrs.get('db.lock_wait_ms', 0)),
                        query=str(attrs.get('db.query.text', ''))[:2000],
                        connection=attrs.get('db.connection'), parent=parent)
        except (ValueError, TypeError, KeyError, AttributeError):
            # A damaged line must not stop collection of later requests.
            return None
        self.latest_end = max(self.latest_end, end)
        cutoff = self.latest_end - WINDOW_SECONDS
        while self.expiry and self.expiry[0][0] < cutoff:
            _, expired = heapq.heappop(self.expiry)
            if expired in self.spans:
                self.discard(expired)
        if end < cutoff or key in self.spans:
            return None
        self.spans[key] = span
        self.children[parent].add(key)
        heapq.heappush(self.expiry, (end, key))
        # Remove the oldest end time too, so the expiry heap is bounded with the index.
        while len(self.spans) > MAX_SPANS:
            _, expired = heapq.heappop(self.expiry)
            if expired in self.spans:
                self.discard(expired)
        if (not name.startswith('ws.rpc.') or duration <= 10_000
                or name in LONG_LIVED_RPC_SPANS
                or any(part.lower().startswith('subscribe')
                       for part in name.split('.')[2:])):
            return None
        descendants = []
        pending = list(self.children.get(key, ()))
        seen = {key}
        while pending:
            child = pending.pop()
            if child in seen:
                continue
            seen.add(child)
            descendants.append(self.spans[child])
            pending.extend(self.children.get(child, ()))
        slowest = sorted(descendants, key=lambda s: s['durationMs'], reverse=True)[:10]
        queries = sorted((s for s in descendants if s['query']),
                         key=lambda s: (s['lockWaitMs'], s['durationMs']), reverse=True)[:5]
        return dict(time=datetime.fromtimestamp(end, timezone.utc).isoformat(),
                    request=name, durationMs=duration, traceId=key[0], spanId=key[1],
                    slowestDescendants=[{k: s[k] for k in ('name', 'durationMs', 'lockWaitMs')}
                                        for s in slowest],
                    topQueries=[{k: s[k] for k in ('query', 'durationMs', 'lockWaitMs', 'connection')}
                                for s in queries],
                    loadAverage=os.getloadavg())


class RecordLog:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.next_cleanup = 0

    def cleanup(self):
        now = time.time()
        if now < self.next_cleanup:
            return
        if self.path.exists() and self.path.stat().st_mtime < now - RETENTION_SECONDS:
            self.path.rename(self.path.with_name(self.path.name + '.' + str(time.time_ns())))
        for archive in self.path.parent.glob(self.path.name + '.*'):
            # Only manage our timestamped archives, never unrelated files.
            if archive.suffix[1:].isdigit() and archive.stat().st_mtime < now - RETENTION_SECONDS:
                archive.unlink()
        self.next_cleanup = now + 3600

    def write(self, record):
        self.cleanup()
        line = (json.dumps(record, separators=(',', ':'), allow_nan=False) + '\n').encode()
        if self.path.exists():
            stat = self.path.stat()
            if (stat.st_size + len(line) > MAX_LOG_BYTES
                    or int(stat.st_mtime // 86400) != int(time.time() // 86400)):
                self.path.rename(self.path.with_name(self.path.name + '.' + str(time.time_ns())))
        with self.path.open('ab') as out:
            out.write(line)


def trace_files(path):
    return [p for p in [*(path.with_name(path.name + f'.{i}') for i in range(10, 0, -1)), path]
            if p.exists()]


def follow(path):
    """Drain the old inode before advancing through rotations to the active file."""
    current = None
    try:
        while True:
            if current is None:
                try:
                    current = path.open('rb')
                except FileNotFoundError:
                    time.sleep(0.5)
                    yield None
                    continue
            position = current.tell()
            line = current.readline()
            if line.endswith(b'\n'):
                yield line
                continue
            # The writer may still be finishing this line.
            current.seek(position)
            identity = os.fstat(current.fileno()).st_ino
            try:
                active = path.stat()
            except FileNotFoundError:
                active = None
            if active is not None and active.st_ino != identity:
                files = trace_files(path)
                try:
                    identities = [p.stat().st_ino for p in files]
                    index = identities.index(identity) + 1 if identity in identities else 0
                    replacement = files[index].open('rb')
                except (FileNotFoundError, IndexError):
                    continue
                current.close()
                current = replacement
                continue
            if active is not None and active.st_size < position:
                current.seek(0)
            time.sleep(0.5)
            yield None
    finally:
        if current is not None:
            current.close()


def main():
    logs = Path.home() / '.t3/userdata/logs'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trace', type=Path, default=logs / 'server.trace.ndjson')
    parser.add_argument('--out', type=Path, default=logs / 'slow-requests.ndjson')
    parser.add_argument('--once', action='store_true', help='Replay .10 through the active file, then exit')
    args = parser.parse_args()
    window = SpanWindow()
    output = RecordLog(args.out)

    def consume(lines):
        for line in lines:
            output.cleanup()
            if line is not None:
                record = window.feed(line)
                if record is not None:
                    output.write(record)

    if args.once:
        for path in trace_files(args.trace):
            try:
                with path.open('rb') as source:
                    consume(source)
            except FileNotFoundError:
                continue
    else:
        consume(follow(args.trace))


if __name__ == '__main__':
    main()
