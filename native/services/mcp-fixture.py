#!/usr/bin/env python3
"""Trusted Android acceptance fixture v1: independent Python stdlib MCP server.

Own fixture, protocol 2025-11-25. Never executes tool arguments. Mutable state is
restricted to the explicit verifier-owned directory. HTTP binds loopback only.
"""
import argparse
import json
import os
import re
from pathlib import Path
import sys
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '2025-11-25'
LOCK = threading.Lock()
PENDING = {}
CANCELLED = set()
LAST_UNSUPPORTED = None
STATE = None


def increment(name):
    with LOCK:
        path = STATE / name
        value = int(path.read_text() if path.exists() else '0') + 1
        with path.open('w') as file:
            file.write(str(value))
            file.flush()
            os.fsync(file.fileno())
        return value



def slow_marker(request_id, phase, outcome=None):
    # Native request correlation IDs only; never retain arguments or credentials.
    request_id = str(request_id)
    if not re.fullmatch(r'[0-9]{1,20}', request_id):
        return
    with LOCK:
        path = STATE / 'slow-markers.json'
        data = json.loads(path.read_text()) if path.exists() and path.stat().st_size <= 8192 else {'version': 1, 'pid': os.getpid(), 'entries': []}
        entries = data['entries'][-8:]
        entry = next((item for item in entries if item['rpcId'] == request_id), None)
        if entry is None:
            entry = {'rpcId': request_id}
            entries.append(entry)
        entry['phase'] = phase
        prefix = 'started' if phase == 'started' else 'finished'
        entry[prefix + 'EpochMs'] = time.time_ns() // 1000000
        entry[prefix + 'ElapsedMs'] = time.monotonic_ns() // 1000000
        if outcome is not None:
            entry['outcome'] = outcome
        data = {'version': 1, 'pid': os.getpid(), 'entries': entries[-8:]}
        encoded = json.dumps(data, separators=(',', ':'))
        assert len(encoded.encode()) <= 8192
        staged = STATE / 'slow-markers.staging'
        with staged.open('w') as output:
            output.write(encoded); output.flush(); os.fsync(output.fileno())
        os.replace(staged, path)


def verification_probe():
    path = STATE.parent / 'stdio' / 'slow-markers.json'
    markers = {'version': 1, 'entries': []}
    if path.is_file() and path.stat().st_size <= 8192:
        markers = json.loads(path.read_text())
    assert markers.get('version') == 1 and len(markers.get('entries', [])) <= 8
    return {'fixture': 'arxd-mcp-background-v1', 'pid': os.getpid(),
            'observedEpochMs': time.time_ns() // 1000000, 'observedElapsedMs': time.monotonic_ns() // 1000000,
            'httpLaunches': int((STATE / 'launches').read_text()),
            'stdioLaunches': int((STATE.parent / 'stdio' / 'launches').read_text()),
            'stdio': markers}


def expected_token():
    path = STATE / 'expected-token'
    return path.read_text() if path.is_file() and path.stat().st_size <= 256 else 'fixture-token'


def result(text, error=False):
    return {'content': [{'type': 'text', 'text': str(text)}], 'isError': error}


def rpc(message, emit):
    global LAST_UNSUPPORTED
    if 'method' not in message:
        if message.get('id') == 'fixture-server-request':
            LAST_UNSUPPORTED = message.get('error', {}).get('code')
        return None
    method, rid = message['method'], message.get('id')
    params = message.get('params', {})
    if method == 'notifications/cancelled':
        CANCELLED.add(str(params.get('requestId')))
        increment('cancellations')
        return None
    if rid is None:
        return None
    if method == 'initialize':
        increment('initializations')
        payload = {'protocolVersion': VERSION, 'capabilities': {'tools': {'listChanged': True}},
                   'serverInfo': {'name': 'Arxd independent Python fixture', 'version': '1'}}
    elif method == 'ping':
        payload = {}
    elif method == 'tools/list':
        names = ['echo', 'increment', 'slow', 'count'] if not params.get('cursor') else [
            'tool_error', 'rpc_error', 'unicode', 'oversized', 'unsupported', 'unsupported_status', 'notify', 'malformed', 'deep']
        payload = {'tools': [{'name': name, 'description': 'Trusted deterministic ' + name,
                             'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'},
                                             'seconds': {'type': 'number'}}, 'additionalProperties': False}}
                            for name in names]}
        # Independent mutable catalog, used to hold a real Pi model request
        # across UI rediscovery. Compatible old arguments remain valid.
        schema_file = STATE / 'schema-version'
        if schema_file.exists() and schema_file.read_text() == '2':
            for tool in payload['tools']:
                tool['inputSchema']['properties']['schemaRevision'] = {'type': 'string', 'description': 'Revision two optional argument'}
        if not params.get('cursor'):
            payload['nextCursor'] = 'page2'
        elif params['cursor'] != 'page2':
            return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32602, 'message': 'Unknown cursor'}}
    elif method == 'tools/call':
        name, args = params.get('name'), params.get('arguments', {})
        if name == 'rpc_error':
            return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32001, 'message': 'Fixture RPC failure ' + expected_token() + ' fixture-header'}}
        if name == 'slow':
            slow_marker(rid, 'started')
            deadline = time.monotonic() + min(max(float(args.get('seconds', 2)), 0), 30)
            while time.monotonic() < deadline:
                if str(rid) in CANCELLED:
                    return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32800, 'message': 'Cancelled'}}
                time.sleep(.02)
            payload = result('slow-finished')
        elif name == 'echo':
            payload = result(args.get('text', 'fixture-echo'))
        elif name == 'unicode':
            payload = result('Android 原始✓ 🐉')
        elif name == 'increment':
            payload = result(increment('effects'))
        elif name == 'count':
            payload = result((STATE / 'effects').read_text() if (STATE / 'effects').exists() else '0')
        elif name == 'tool_error':
            payload = result('Fixture tool failure', True)
        elif name == 'oversized':
            payload = result('x' * (1048576 + 100))
        elif name == 'unsupported':
            emit({'jsonrpc': '2.0', 'id': 'fixture-server-request', 'method': 'sampling/createMessage', 'params': {}})
            payload = result('unsupported-request-issued')
        elif name == 'unsupported_status':
            payload = result(LAST_UNSUPPORTED)
        elif name == 'notify':
            emit({'jsonrpc': '2.0', 'method': 'notifications/tools/list_changed'})
            payload = result('catalog-changed')
        elif name == 'deep':
            emit('{"jsonrpc":"2.0","id":' + json.dumps(rid) + ',"result":' + '[' * 5000 + '0' + ']' * 5000 + '}')
            return None
        elif name == 'malformed':
            emit('not-json')
            return None
        else:
            return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32602, 'message': 'Unknown tool'}}
    else:
        return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': 'Method not found'}}
    return {'jsonrpc': '2.0', 'id': rid, 'result': payload}


def stdio():
    write_lock = threading.Lock()
    def emit(message):
        encoded = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
        with write_lock:
            # Deliberately split UTF-8 sequences across writes to exercise framing.
            data = (encoded + '\n').encode()
            step = 37 if len(data) < 65536 else 4096
            for start in range(0, len(data), step):
                sys.stdout.buffer.write(data[start:start + step])
                sys.stdout.buffer.flush()
    def handle(message):
        try:
            response = rpc(message, emit)
            if response is not None:
                emit(response)
                if message.get('method') == 'tools/call' and message.get('params', {}).get('name') == 'slow':
                    slow_marker(message.get('id'), 'response-written', 'success' if 'result' in response else 'cancelled')
        except Exception as error:
            print(type(error).__name__, file=sys.stderr, flush=True)
    print('fixture-ready stdio', file=sys.stderr, flush=True)
    for line in sys.stdin.buffer:
        message = json.loads(line)
        # Read cancellation while a trusted slow tool is running.
        if message.get('method') == 'tools/call' and message.get('params', {}).get('name') == 'slow':
            threading.Thread(target=handle, args=(message,), daemon=True).start()
        else:
            handle(message)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass
    def response(self, code, body=b'', kind='application/json', headers=None):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
    def authorized(self):
        token = self.headers.get('Authorization') == 'Bearer ' + expected_token()
        header = self.headers.get('X-Arxd-Fixture') == 'fixture-header'
        if self.path == '/auth-token':
            return token and not self.headers.get('X-Arxd-Fixture')
        if self.path == '/auth-header':
            return header and not self.headers.get('Authorization')
        return self.path != '/auth' or (token and header)
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        if not 0 < n <= 1048576:
            self.response(413)
            return
        raw = self.rfile.read(n)
        increment('http_posts')
        if self.headers.get('Authorization') == 'Bearer fixture-token':
            increment('credential_posts')
        if self.path == '/oauth-only':
            increment('oauth_challenges')
            self.response(401, headers={'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1:%s/oauth-resource"' % self.server.server_port})
            return
        if not self.authorized():
            self.response(401)
            return
        if self.path == '/redirect':
            self.response(302, headers={'Location': 'http://localhost:%s/stolen' % self.server.server_port})
            return
        message = json.loads(raw)
        emitted = []
        if self.path in ('/invalid-schema', '/duplicate-tools', '/oversized-schema', '/oversized-catalog') and message.get('method') == 'tools/list':
            tool = {'name': 'echo', 'inputSchema': {'type': 'object'}}
            tools = [tool]
            if self.path == '/invalid-schema':
                tool['inputSchema'] = {'type': 'array'}
            elif self.path == '/oversized-schema':
                tool['inputSchema']['description'] = 'x' * 131073
            elif self.path == '/oversized-catalog':
                offset = int(message.get('params', {}).get('cursor', '0'))
                tools = [{'name': 'tool_%s' % i, 'inputSchema': {'type': 'object'}} for i in range(offset, min(offset + 128, 257))]
            payload = {'tools': tools}
            if self.path == '/duplicate-tools' and not message.get('params', {}).get('cursor'):
                payload['nextCursor'] = 'duplicate'
            if self.path == '/oversized-catalog' and offset + len(tools) < 257:
                payload['nextCursor'] = str(offset + len(tools))
            value = {'jsonrpc': '2.0', 'id': message['id'], 'result': payload}
        elif self.path == '/empty-pages' and message.get('method') == 'tools/list':
            value = {'jsonrpc': '2.0', 'id': message['id'], 'result': {'tools': [], 'nextCursor': str(increment('empty_pages'))}}
        else:
            value = rpc(message, emitted.append)
        if value is None:
            self.response(202)
            return
        if self.path == '/uncertain' and message.get('method') == 'tools/call':
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.path == '/version':
            value.get('result', {})['protocolVersion'] = 'unsupported-fixture-version'
        headers = {}
        if message.get('method') == 'initialize':
            headers['MCP-Session-Id'] = str(uuid.uuid4())
        else:
            if self.headers.get('MCP-Protocol-Version') != VERSION or not self.headers.get('MCP-Session-Id'):
                self.response(400)
                return
        if self.path == '/expired' and message.get('method') != 'initialize':
            self.response(404)
            return
        if self.path == '/resume' and message.get('method') == 'tools/call':
            cursor = str(uuid.uuid4())
            PENDING[cursor] = value
            self.response(200, ('id: %s\nretry: 10\ndata:\n\n' % cursor).encode(), 'text/event-stream', headers)
        elif self.path == '/sse':
            frames = emitted + [value]
            body = '\ufeff: unicode stream\r\n\r\n' + ''.join(
                'id: %s\r\ndata: %s\r\n\r\n' % (uuid.uuid4(), json.dumps(item, ensure_ascii=False)) for item in frames)
            self.response(200, body.encode(), 'text/event-stream; charset=utf-8', headers)
        else:
            self.response(200, json.dumps(value, ensure_ascii=False).encode(), headers=headers)
    def do_GET(self):
        if self.path == '/oauth-resource':
            increment('oauth_metadata')
            self.response(200, json.dumps({'resource': 'fixture-only', 'authorization_servers': []}).encode())
            return
        if self.path == '/arxd-verification':
            encoded = json.dumps(verification_probe(), separators=(',', ':')).encode()
            assert len(encoded) <= 8192
            self.response(200, encoded)
            return
        if not self.authorized():
            self.response(401)
            return
        if self.path == '/resume' and self.headers.get('Last-Event-ID') in PENDING:
            value = PENDING.pop(self.headers['Last-Event-ID'])
            self.response(200, ('data: ' + json.dumps(value) + '\n\n').encode(), 'text/event-stream')
        elif self.path == '/sse':
            value = {'jsonrpc': '2.0', 'method': 'notifications/tools/list_changed'}
            self.response(200, ('data: ' + json.dumps(value) + '\n\n').encode(), 'text/event-stream')
        else:
            self.response(405)


def main():
    global STATE
    parser = argparse.ArgumentParser()
    parser.add_argument('transport', choices=['stdio', 'http'])
    parser.add_argument('directory')
    parser.add_argument('--bind-host', default='127.0.0.1', help='Explicit controlled fixture interface; loopback by default')
    args = parser.parse_args()
    STATE = Path(args.directory)
    STATE.mkdir(parents=True, exist_ok=True)
    increment('launches')
    if args.transport == 'stdio':
        stdio()
    else:
        server = ThreadingHTTPServer((args.bind_host, 0), Handler)
        (STATE / 'port').write_text(str(server.server_port))
        print(json.dumps({'fixture': 'arxd-mcp-v1', 'port': server.server_port}), file=sys.stderr, flush=True)
        server.serve_forever(poll_interval=.1)


if __name__ == '__main__':
    main()
