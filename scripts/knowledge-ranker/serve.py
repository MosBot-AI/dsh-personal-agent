"""Run the checked knowledge ranker on a private local Unix socket."""

from argparse import ArgumentParser
from hashlib import sha256
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import signal
from socketserver import UnixStreamServer
import sys

from models import verify


SHA256 = re.compile(r'[0-9a-f]{64}')
ROOT_ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
MAX_REQUEST = 512 * 1024
MAX_DOCUMENTS = 256


def parse_request(body):
    if not isinstance(body, dict) or set(body) - {'query', 'root', 'documents', 'lexical', 'limit'}:
        raise ValueError('Malformed query')
    query, root = body.get('query'), body.get('root')
    if not isinstance(query, str) or not 0 < len(query) <= 256:
        raise ValueError('Malformed query text')
    if root is not None and (not isinstance(root, str) or not ROOT_ID.fullmatch(root)):
        raise ValueError('Malformed root ID')
    limit, rows, lexical = body.get('limit'), body.get('documents'), body.get('lexical')
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('Malformed result limit')
    if not isinstance(rows, list) or not 0 < len(rows) <= MAX_DOCUMENTS:
        raise ValueError('Malformed document list')
    known = set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'id', 'rootId', 'path', 'revision', 'text'}
                or any(not isinstance(value, str) for value in row.values())):
            raise ValueError('Malformed document')
        ref, document_root = row['id'], row['rootId']
        if not SHA256.fullmatch(ref) or ref in known or not ROOT_ID.fullmatch(document_root):
            raise ValueError('Malformed document reference')
        if root is not None and document_root != root:
            raise ValueError('Document is outside the requested root')
        if not row['path'] or any(part in ('', '.', '..') for part in row['path'].split('/')):
            raise ValueError('Malformed document path')
        if sha256(row['text'].encode('utf-8')).hexdigest() != row['revision']:
            raise ValueError('Document bytes do not match their revision')
        known.add(ref)
    if not isinstance(lexical, list) or len(lexical) > 3 or any(
        not isinstance(ref, str) or ref not in known for ref in lexical
    ):
        raise ValueError('Malformed lexical references')
    return query, rows, lexical, limit


def serve(socket_path, ranker):
    class Handler(BaseHTTPRequestHandler):
        timeout = 5

        def do_POST(self):
            if self.path != '/rank':
                self.send_error(404)
                return
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= MAX_REQUEST:
                    raise ValueError('Request size exceeded')
                query = parse_request(json.loads(self.rfile.read(length)))
            except ValueError:
                self.send_error(400)
                return
            try:
                result = json.dumps(ranker.search(*query)).encode('utf-8')
            except Exception as error:
                print(f'Local scoring failed ({type(error).__name__})', file=sys.stderr, flush=True)
                self.send_error(503)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        def log_message(self, *_args):
            pass

    os.umask(0o077)
    with UnixStreamServer(str(socket_path), Handler) as server:
        identity = socket_path.lstat()
        try:
            print('Knowledge ranker ready', flush=True)
            server.serve_forever()
        finally:
            if socket_path.exists() and os.path.samestat(socket_path.lstat(), identity):
                socket_path.unlink()


def stop(_signal, _frame):
    raise SystemExit(0)


if __name__ == '__main__':
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--models', required=True, type=Path)
    parser.add_argument('--socket', required=True, type=Path)
    parser.add_argument('--threads', type=int, default=6)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error('--threads must be positive')
    if not args.socket.is_absolute():
        parser.error('--socket must use an absolute path')
    try:
        verify(args.models)
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'

    from scoring import Ranker

    signal.signal(signal.SIGTERM, stop)
    serve(args.socket, Ranker(args.models, args.threads))
