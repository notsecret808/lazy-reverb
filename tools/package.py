"""Package only the extension runtime; no development files or dependencies."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
FILES = ('manifest.json', 'engine.js', 'popup.html', 'popup.css', 'popup.js', 'icon.svg')


def package(destination=None):
    version = json.loads((ROOT / 'manifest.json').read_text())['version']
    destination = destination or ROOT / 'dist' / f'lazy-reverb-{version}.zip'
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(ROOT / name, name)
    return destination


if __name__ == '__main__':
    print(package())
