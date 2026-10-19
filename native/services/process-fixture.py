#!/usr/bin/env python3
"""Trusted Android process fixture v1; commands are fixed modes, never evaluated input."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['echo', 'http', 'flood', 'stubborn', 'exit', 'blocked-stdin'])
parser.add_argument('directory')
parser.add_argument('--bytes', type=int, default=2098176)
parser.add_argument('--port', type=int, default=0)
args = parser.parse_args()
state = Path(args.directory)
state.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()


def put(name, value):
    with (state / name).open('w') as file:
        file.write(str(value))
        file.flush()
        os.fsync(file.fileno())


def increment(name):
    with lock:
        path = state / name
        value = int(path.read_text() if path.exists() else '0') + 1
        put(name, value)
        return value


increment('launches')
put('pid', os.getpid())
put('pgid', os.getpgrp())
put('startup_job', os.environ.get('ARXD_JOB_FILE', 'absent'))
put('cwd', os.getcwd())
put('environment', os.environ.get('ARXD_FIXTURE_VALUE', ''))
print('trusted-process-fixture-ready', file=sys.stderr, flush=True)
if args.mode == 'exit':
    sys.exit(37)
if args.mode == 'http':
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            count = increment('requests')
            body = json.dumps({'fixture': 'arxd-managed-http-v1', 'requests': count,
                               'pid': os.getpid(), 'time': time.time_ns()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            print('http-request:' + str(count), flush=True)
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    put('port', server.server_port)
    server.serve_forever()
elif args.mode == 'blocked-stdin':
    # Deliberately do not consume stdin until the public-write timeout has been
    # observed. A finite fixture lifetime also bounds cleanup after a failed run.
    deadline = time.monotonic() + 45
    while not (state / 'release').exists():
        if time.monotonic() >= deadline:
            sys.exit(38)
        time.sleep(.02)
    for raw in sys.stdin.buffer:
        sequence = int(raw.split(b':', 1)[0])
        with (state / 'delivered').open('a') as file:
            file.write(str(sequence) + '\n')
            file.flush()
            os.fsync(file.fileno())
        increment('inputs')
elif args.mode == 'stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print('ignoring-term', flush=True)
    while True:
        time.sleep(1)
else:
    if args.mode == 'flood':
        remaining = min(max(args.bytes, 1), 8 * 1024 * 1024)
        while remaining:
            count = min(65536, remaining)
            os.write(1, b'O' * count)
            os.write(2, b'E' * count)
            remaining -= count
        os.write(1, b'OUT-END\n')
        os.write(2, b'ERR-END\n')
    else:
        os.write(1, b'prefix-\xe2')
        time.sleep(.05)
        os.write(1, b'\x9c')
        time.sleep(.05)
        os.write(1, b'\x93\n')
    for raw in sys.stdin.buffer:
        line = raw.decode('utf-8').rstrip('\n')
        if line == 'quit':
            break
        increment('inputs')
        if line == 'binary':
            os.write(1, b'\x00\xff\xfe')
        else:
            print('input:' + line, flush=True)
