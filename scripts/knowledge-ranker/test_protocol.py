from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import models
from serve import parse_request


def document(root, marker):
    text = '项目现场记录。'
    return {'id': marker * 64, 'rootId': root, 'path': '现场.md',
            'revision': sha256(text.encode()).hexdigest(), 'text': text}


class RankerRequestTests(unittest.TestCase):
    def test_accepts_revision_checked_sources_with_equal_paths_across_roots(self):
        rows = [document('manual', 'a'), document('reports', 'b')]
        body = {'query': '现场记录在哪里？', 'documents': rows, 'lexical': [rows[1]['id']], 'limit': 2}
        self.assertEqual(parse_request(body), (body['query'], rows, body['lexical'], 2))

    def test_rejects_unscoped_sources_and_changed_bytes(self):
        row = document('reports', 'a')
        body = {'query': 'Where is the record?', 'documents': [row], 'root': 'manual', 'lexical': [], 'limit': 1}
        with self.assertRaisesRegex(ValueError, 'outside the requested root'):
            parse_request(body)
        body['root'] = row['rootId']
        row['text'] = 'Different bytes'
        with self.assertRaisesRegex(ValueError, 'do not match their revision'):
            parse_request(body)


class ModelVerificationTests(unittest.TestCase):
    def test_checked_files_are_reusable_and_corruption_is_reported(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'local-model'
            directory.mkdir()
            file = directory / 'model.safetensors'
            content = b'pin the weights'
            file.write_bytes(content)
            manifest = root / 'models.json'
            manifest.write_text(json.dumps({'local-model': {
                'files': {file.name: sha256(content).hexdigest()},
            }}), encoding='utf-8')
            with patch.object(models, 'MANIFEST', manifest):
                models.verify(root)
                file.write_bytes(b'corruption')
                with self.assertRaisesRegex(ValueError, 'Unexpected file SHA-256'):
                    models.verify(root)
                self.assertEqual(file.read_bytes(), b'corruption')
