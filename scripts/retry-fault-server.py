#!/usr/bin/env python3
"""Controlled Android model endpoint. Deterministic test data, no model inference.
ADB: adb reverse tcp:18759 tcp:18759. POST /control {id, failures:[...]}.
GET /evidence returns independent receive timestamps/counts. One fixture per id.
"""
import argparse
import json
import socket
import socketserver
import ssl
import subprocess
import tempfile
from pathlib import Path
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
CASES = {}
TLS_CLOSE_CASE = None

class TLSCloseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

class TLSCloseHandler(socketserver.BaseRequestHandler):
    """Consume a real bounded TLS ClientHello, then EOF before any certificate.
    Store only timing/type/byte counts; no TLS payload or HTTP/auth data.
    """
    def handle(self):
        self.request.settimeout(5)
        observation = {'at': time.time(), 'clientHello': False, 'bytes': 0}
        with LOCK:
            case = CASES.get(TLS_CLOSE_CASE)
            if case is not None:
                case['tlsConnectionCount'] += 1
                if len(case['tlsConnections']) < 8:
                    case['tlsConnections'].append(observation)
        until = time.monotonic() + 5
        def read_exact(size):
            data = bytearray()
            while len(data) < size:
                remaining = until - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('TLS ClientHello fixture deadline')
                self.request.settimeout(remaining)
                part = self.request.recv(size - len(data))
                if not part:
                    break
                data.extend(part)
            return bytes(data)
        try:
            header = read_exact(5)
            length = int.from_bytes(header[3:5], 'big') if len(header) == 5 else 0
            payload = read_exact(length) if 0 < length <= 16384 else b''
            with LOCK:
                observation['bytes'] = len(header) + len(payload)
                observation['clientHello'] = len(header) == 5 and header[0] == 22 and len(payload) == length and payload[:1] == b'\x01'
        except OSError as error:
            with LOCK:
                observation['ioClass'] = type(error).__name__
        finally:
            with LOCK:
                observation['failedAt'] = time.time()
            try:
                self.request.shutdown(socket.SHUT_WR)
            except OSError:
                pass


class Server(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def body(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        with LOCK:
            self.body(200, CASES)

    def do_POST(self):
        global TLS_CLOSE_CASE
        value = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path == '/control':
            with LOCK:
                CASES[value['id']] = {'failures': value['failures'], 'compactionFailures': value.get('compactionFailures', []), 'requests': [], 'fixture': value.get('fixture', {}), 'tlsConnectionCount': 0, 'tlsConnections': []}
                TLS_CLOSE_CASE = value['id'] if value.get('tlsClose') else None
            self.body(200, {'ok': True})
            return
        case_id = self.path.split('/')[1]
        with LOCK:
            case = CASES[case_id]
            stage = 'compaction' if any(message.get('role') == 'system' and 'You are a context summarization assistant.' in str(message.get('content')) for message in value.get('messages', [])) else 'generation'
            index = sum(request['stage'] == stage for request in case['requests'])
            request = {'at': time.time(), 'stage': stage, 'body': value, 'internalMarkerLeaked': bool(self.headers.get('X-Arxd-Model-Request') or self.headers.get('X-Arxd-Model-Timeout-Ms') or self.headers.get('X-Arxd-Model-Deadline-At'))}
            case['requests'].append(request)
            failures = case['compactionFailures'] if stage == 'compaction' else case['failures']
            failure = failures[index] if index < len(failures) else 'ok'
        zero_retry = failure == 'http503zero'
        if zero_retry:
            failure = 503
        if failure in ('invalid-model', 'invalid-parameters', 'quota'):
            error_message = {'invalid-model': 'invalid model selected', 'invalid-parameters': 'invalid parameters supplied', 'quota': 'quota exhausted'}[failure]
            failure = 429 if failure == 'quota' else 400
        elif failure == 'overflow':
            failure = 400
            error_message = 'maximum context length exceeded'
        elif failure == 'diagnostic':
            failure = 400
            # Public detail must remain long AFTER authorization-line redaction.
            error_message = 'invalid-model fixture sk-fixture-secret-never-display ' + 'bounded-public-detail-' * 1000 + ' Authorization: Bearer fixture-credential'
        else:
            reasons = {400: 'invalid model or parameters', 401: 'authentication rejected', 403: 'permission denied', 404: 'model not found', 429: 'quota exhausted', 500: 'provider internal failure', 503: 'provider unavailable'}
            error_message = reasons.get(failure, 'fixture HTTP failure') + ' sk-fixture-secret-never-display Authorization: Bearer fixture-credential'
        if isinstance(failure, int):
            data = {'error': {'code': 'fixture_' + str(failure), 'message': error_message}}
            self.send_response(failure)
            self.send_header('x-request-id', 'fixture-request-safe-159')
            self.send_header('Retry-After', '0' if zero_retry else '1')
            self.send_header('x-should-retry', 'true')
            self.send_header('Content-Type', 'application/json')
            raw = json.dumps(data).encode()
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if failure == 'reset':
            with LOCK:
                request['failedAt'] = time.time()
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            self.connection.close()
            self.close_connection = True
            return
        def stall_until_disconnect():
            self.connection.settimeout(110)
            try:
                if self.connection.recv(1) == b'':
                    with LOCK:
                        request['disconnectedAt'] = time.time()
            except (ConnectionError, socket.timeout) as error:
                with LOCK:
                    request['disconnectError'] = type(error).__name__
                    if isinstance(error, ConnectionError):
                        request['disconnectedAt'] = time.time()
            self.close_connection = True
        if failure == 'stall':
            stall_until_disconnect()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        if failure == 'bad-chunk':
            self.wfile.write(b'NOT_HEX\r\ninvalid\r\n')
            self.wfile.flush()
            self.close_connection = True
            return
        def chunk(data):
            raw = data.encode()
            self.wfile.write(('%x\r\n' % len(raw)).encode() + raw + b'\r\n')
            self.wfile.flush()
        def event(delta, finish=None):
            chunk('data: ' + json.dumps({'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'deepseek-flash', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}) + '\n\n')
        event({'role': 'assistant'})
        if failure in ('process-tool', 'discover-tool', 'mcp-tool', 'failed-tool'):
            fixture = case['fixture']
            if failure == 'process-tool':
                name, arguments = 'process_start', fixture['process']
            elif failure == 'discover-tool':
                name, arguments = 'mcp_tools', {'id': fixture['serverId'], 'query': 'increment'}
            elif failure == 'mcp-tool':
                aliases = [tool['function']['name'] for tool in value.get('tools', []) if '/ increment]' in tool.get('function', {}).get('description', '')]
                assert len(aliases) == 1, 'actual admitted MCP increment alias missing'
                name, arguments = aliases[0], {}
            else:
                script = "python - <<'PYCODE'\nimport os,sys\np=os.environ['ARXD_WORKSPACE']+'/arxd-retry-" + case_id + "-failed-count'\nn=int(open(p).read()) if os.path.exists(p) else 0\nwith open(p,'w') as f:\n f.write(str(n+1)); f.flush(); os.fsync(f.fileno())\nprint('trusted-tool-failure',n+1)\nsys.exit(37)\nPYCODE"
                name, arguments = 'shell', {'script': script, 'timeoutMs': 10000}
            event({'tool_calls': [{'index': 0, 'id': 'trusted-' + failure, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]})
            event({}, 'tool_calls')
        elif failure == 'tool':
            script = "python - <<'PYCODE'\nimport os\np=os.environ['ARXD_WORKSPACE']+'/arxd-retry-" + case_id + "-count'\nn=int(open(p).read()) if os.path.exists(p) else 0\nwith open(p,'w') as f:\n f.write(str(n+1)); f.flush(); os.fsync(f.fileno())\nprint(n+1)\nPYCODE"
            event({'tool_calls': [{'index': 0, 'id': 'trusted-retry-counter', 'type': 'function', 'function': {'name': 'shell', 'arguments': json.dumps({'script': script, 'timeoutMs': 10000})}}]})
            event({}, 'tool_calls')
        elif failure == 'malformed':
            chunk('data: {bad json\n\n')
        elif failure in ('partial-reset', 'partial-tool-reset', 'partial-stall'):
            event({'reasoning_content': 'INTERRUPTED_FIXTURE_THINKING'})
            event({'content': 'INTERRUPTED_FIXTURE_PREFIX'})
            if failure == 'partial-tool-reset':
                event({'tool_calls': [{'index': 0, 'id': 'uncommitted', 'type': 'function', 'function': {'name': 'shell', 'arguments': '{"script":'}}]})
            if failure == 'partial-stall':
                stall_until_disconnect()
                return
            time.sleep(.8)
            with LOCK:
                request['failedAt'] = time.time()
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            self.connection.close()
            self.close_connection = True
            return
        elif failure == 'clean-incomplete':
            event({'content': 'INCOMPLETE_FIXTURE'})
        else:
            event({'content': 'RECOVERED_FIXTURE_ANSWER'})
            event({}, 'stop')
        chunk('data: [DONE]\n\n')
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18759)
    parser.add_argument('--tls-port', type=int, default=18760, help='Isolated self-signed model endpoint; never installs a CA')
    parser.add_argument('--tls-close-port', type=int, default=18762, help='Loopback TLS ClientHello followed by EOF; no certificate or trust changes')
    args = parser.parse_args()
    print(json.dumps({'port': args.port, 'mode': 'deterministic-test-data'}), flush=True)
    with tempfile.TemporaryDirectory(prefix='arxd-retry-tls-') as temporary:
        directory = Path(temporary)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', str(directory / 'key.pem'), '-out', str(directory / 'cert.pem')], check=True, capture_output=True)
        tls = ThreadingHTTPServer(('127.0.0.1', args.tls_port), Server)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(directory / 'cert.pem', directory / 'key.pem')
        tls.socket = context.wrap_socket(tls.socket, server_side=True)
        threading.Thread(target=tls.serve_forever, daemon=True).start()
        tls_close = TLSCloseServer(('127.0.0.1', args.tls_close_port), TLSCloseHandler)
        threading.Thread(target=tls_close.serve_forever, daemon=True).start()
        try:
            ThreadingHTTPServer(('127.0.0.1', args.port), Server).serve_forever()
        finally:
            tls.shutdown()
            tls_close.shutdown()
            tls.server_close()
            tls_close.server_close()
