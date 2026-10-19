#!/usr/bin/env python3
"""Wrap the independent local MCP fixture in an untrusted test TLS certificate."""
import argparse
import importlib.util
from pathlib import Path
import ssl
from http.server import ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--cert', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('independent_mcp_fixture', args.fixture)
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    args.directory.mkdir(parents=True, exist_ok=True)
    fixture.STATE = args.directory
    fixture.increment('launches')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    server = ThreadingHTTPServer(('127.0.0.1', 0), fixture.Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    (args.directory / 'port').write_text(str(server.server_port))
    server.serve_forever(poll_interval=.1)


if __name__ == '__main__':
    main()
