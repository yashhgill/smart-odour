#!/usr/bin/env python3
"""Asks for the Wi-Fi details and device key, and writes firmware/odour_node/secrets.h.
That file is ignored by git. Nothing you type is shown or printed."""
import getpass, os, re, secrets, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, 'firmware', 'odour_node', 'secrets.h')
HOST = 'nikdxqsardermmjkfudv.supabase.co'
ANON = 'sb_publishable_fQfM3HatwxiSpZZZLUifQg_dXoJMSnF'

ignored = subprocess.run(['git', '-C', ROOT, 'check-ignore', '-q', PATH]).returncode == 0
if not ignored:
    raise SystemExit('Stopped: secrets.h is not ignored by git, so it could get published.')

old = open(PATH).read() if os.path.exists(PATH) else ''
def current(name):
    m = re.search(r'#define\s+%s\s+"([^"]*)"' % name, old)
    return m.group(1) if m else ''
def c_string(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')

ssid = input('Wi-Fi name (2.4 GHz, capitals matter): ').strip()
password = getpass.getpass('Wi-Fi password (hidden as you type): ')
key = getpass.getpass('NODE-1 device key from the admin page (hidden as you type): ').strip()
if not ssid or not password or not key:
    raise SystemExit('Stopped: all three are needed. Nothing was changed.')

ota = current('OTA_PASSWORD')
if not ota or ota == 'CHANGE_ME':
    ota = secrets.token_hex(12)

fd = os.open(PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(f'''// Written by tools/set_secrets.py. Ignored by git.
#pragma once
#define WIFI_SSID     "{c_string(ssid)}"
#define WIFI_PASSWORD "{c_string(password)}"
#define SUPABASE_HOST "{HOST}"
#define SUPABASE_ANON "{ANON}"
#define DEVICE_ID     "NODE-1"
#define DEVICE_KEY    "{c_string(key)}"
#define OTA_PASSWORD  "{ota}"
''')
print('Saved. Tell Claude it is done, and it will build and upload the firmware.')
