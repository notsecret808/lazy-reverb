"""Run unit, real-audio and end-to-end checks with one command."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', default='firefox', help='Firefox-compatible executable, e.g. /opt/zen/zen')
    args = parser.parse_args()
    checks = [
        ['node', '--expose-gc', 'tests/engine.test.cjs'],
        ['node', 'tests/popup.test.cjs'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_performance_gate.py'],
        [sys.executable, 'tools/firefox-smoke.py', '--browser', args.browser],
        ['node', 'node_modules/playwright/cli.js', 'test'],
    ]
    for check in checks:
        print('Running:', ' '.join(check), flush=True)
        subprocess.run(check, cwd=ROOT, check=True)
    print('All checks passed.', flush=True)


if __name__ == '__main__':
    main()
