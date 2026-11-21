"""Isolated Firefox/Zen test session. Standard library only; no user profile."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import uuid

from package import package

ROOT = Path(__file__).resolve().parent.parent


class Marionette:
    def __init__(self, connection):
        self.connection = connection
        self.sequence = 0
        self.read()

    def read(self):
        size = b''
        while not size.endswith(b':'):
            chunk = self.connection.recv(1)
            if not chunk:
                raise RuntimeError('Browser closed the Marionette connection')
            size += chunk
        remaining = int(size[:-1])
        message = b''
        while remaining:
            chunk = self.connection.recv(remaining)
            if not chunk:
                raise RuntimeError('Incomplete Marionette response')
            message += chunk
            remaining -= len(chunk)
        return json.loads(message)

    def command(self, name, parameters=None):
        self.sequence += 1
        data = json.dumps([0, self.sequence, name, parameters or {}]).encode()
        self.connection.sendall(str(len(data)).encode() + b':' + data)
        message = self.read()
        if message[2]:
            raise RuntimeError(f'{name}: {message[2]}')
        return message[3]

    def execute(self, script, asynchronous=False):
        return self.command('WebDriver:ExecuteAsyncScript' if asynchronous else 'WebDriver:ExecuteScript', {
            'script': script, 'args': [], 'newSandbox': False, 'sandbox': None,
        })

    def inject_page_script(self, source):
        # Execute fixture code in the actual page realm, like MAIN content
        # scripts, rather than retaining a Marionette sandbox's global object.
        self.execute('const script = document.createElement("script"); script.textContent = ' + json.dumps(source) + '; document.documentElement.append(script); script.remove();')

@contextmanager
def browser_session(executable='firefox'):
    binary = shutil.which(executable)
    if not binary:
        raise RuntimeError(f'Browser not found: {executable}')
    with tempfile.TemporaryDirectory(prefix='lazy-reverb-test-') as temporary:
        root = Path(temporary)
        extension_uuid = str(uuid.uuid4())
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        prefs = {
            'marionette.port': port, 'media.autoplay.default': 0,
            'media.autoplay.block-webaudio': False, 'browser.shell.checkDefaultBrowser': False,
            'datareporting.policy.dataSubmissionEnabled': False,
            'browser.startup.homepage': 'about:blank', 'browser.newtabpage.enabled': False,
            'zen.welcome-screen.seen': True, 'zen.welcome-screen.always-show': False,
            'extensions.webextensions.uuids': json.dumps({'lazy-reverb@local.example': extension_uuid}),
        }
        (root / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(key)}, {json.dumps(value)});' for key, value in prefs.items()))
        with (root / 'firefox.log').open('w') as log:
            process = subprocess.Popen([
                binary, '--headless', '--no-remote', '--marionette',
                '--remote-allow-system-access', '--profile', str(root),
            ], stdout=log, stderr=log, env={**os.environ, 'MOZ_HEADLESS': '1', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'})
            connection = None
            try:
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError((root / 'firefox.log').read_text())
                    try:
                        connection = socket.create_connection(('127.0.0.1', port), timeout=1)
                        break
                    except OSError:
                        time.sleep(0.2)
                if connection is None:
                    raise RuntimeError('Marionette did not start: ' + (root / 'firefox.log').read_text())
                connection.settimeout(30)
                client = Marionette(connection)
                client.extension_uuid = extension_uuid
                session = client.command('WebDriver:NewSession', {'capabilities': {
                    'acceptInsecureCerts': True, 'pageLoadStrategy': 'eager',
                    'timeouts': {'pageLoad': 15000, 'script': 20000},
                }})
                details = session.get('value', session).get('capabilities', {})
                print('Browser:', details.get('browserName'), details.get('browserVersion'), flush=True)
                addon = package(root / 'lazy-reverb.xpi')
                print('Installed:', client.command('Addon:Install', {'path': str(addon), 'temporary': True}), flush=True)
                yield client
            finally:
                if connection:
                    connection.close()
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
