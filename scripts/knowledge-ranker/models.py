"""Verify the exact checked model files or fetch them as a separate setup step."""

from argparse import ArgumentParser
from hashlib import file_digest
import json
from pathlib import Path


MANIFEST = Path(__file__).with_name('models.json')


def verify(root, download=False):
    models = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for name, model in models.items():
        directory = root / name
        for filename, expected in model['files'].items():
            source = directory / filename
            if source.is_file():
                with source.open('rb') as stream:
                    if file_digest(stream, 'sha256').hexdigest() == expected:
                        continue
                raise ValueError(f'Unexpected file SHA-256 for {name}/{filename}')
            if not download:
                raise ValueError(f'Missing checked file {name}/{filename}')
            from huggingface_hub import hf_hub_download

            hf_hub_download(repo_id=model['repository'], revision=model['revision'],
                            filename=filename, local_dir=directory, token=False)
            with source.open('rb') as stream:
                if file_digest(stream, 'sha256').hexdigest() != expected:
                    raise ValueError(f'Unexpected download SHA-256 for {name}/{filename}')
        extra = {path.name for path in directory.iterdir()} - model['files'].keys() - {'.cache'}
        if extra:
            raise ValueError(f'Use a dedicated model directory for {name}')


if __name__ == '__main__':
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    try:
        verify(args.directory, download=args.download)
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
