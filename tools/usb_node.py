#!/usr/bin/env python3
"""Plug the sensor node into USB and run this. It finds the board by itself, explains what
the node is reading in plain English, and saves every reading to a CSV file.

    python3 -m venv tools/.venv && tools/.venv/bin/pip install pyserial    # first time only
    tools/.venv/bin/python tools/usb_node.py            # find, explain, record
    tools/.venv/bin/python tools/usb_node.py --find     # only say whether a board is plugged in
    tools/.venv/bin/python tools/usb_node.py --dashboard http://localhost:8788   # also show on a local live dashboard

Also works with older firmware: lines it does not recognise are shown and saved as they are.
Files go in recordings/ : node_<date>.csv (readings) and node_<date>.log (everything).
"""
import argparse, csv, json, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

GASES = ['Fuel gas (MQ-5)', 'Butane gas (MQ-6)', 'CO gas A (MQ-7)', 'CO gas B (MQ-7)']
USB_CHIPS = {0x10C4: 'CP210x', 0x1A86: 'CH340/CH9102', 0x0403: 'FTDI', 0x303A: 'Espressif'}
FIELDS = ['time', 'index', 'level', 'fuel_gas_x', 'butane_gas_x', 'co_a_x', 'co_b_x', 'temp_c', 'humidity', 'queued', 'learning']

def find_board():
    from serial.tools import list_ports
    hits = [p for p in list_ports.comports()
            if p.vid in USB_CHIPS or any(k in p.device.lower() for k in ('usbserial', 'slab', 'wchusb', 'usbmodem'))]
    return hits[0] if hits else None

def parse(line):
    """'LIVE a=1 b=2' -> ('LIVE', {'a': '1', 'b': '2'}). Anything else -> (None, {})."""
    kind, _, rest = line.partition(' ')
    if kind not in ('LIVE', 'READING'):
        return None, {}
    return kind, dict(p.split('=', 1) for p in rest.split() if '=' in p)

def num(v):
    return None if v in (None, 'nan') else float(v)

def climate(d):
    t, h = num(d.get('t')), num(d.get('h'))
    return 'temperature and humidity sensor not answering' if t is None or h is None else f'{t:.0f}°C, {h:.0f}% humidity'

def explain_live(d):
    """One plain sentence, plus a warning for each thing that looks wrong."""
    warm = int(d.get('warm', 0))
    state = f'Warming up, {warm // 60}:{warm % 60:02d} left' if warm else 'Running'
    net = 'WiFi on' if d.get('wifi') == '1' else 'no WiFi'
    out = [f'{state}. {climate(d)}. {net}.']
    for name, raw in zip(GASES, d.get('adc', '').split(',')):
        v = int(raw) if raw else 0
        if v >= 4050: out.append(f'  ! {name} is at the top of the range. It needs a voltage divider, see docs/WIRING.md.')
        elif v <= 20 and not warm: out.append(f'  ! {name} reads almost nothing. Check its wire.')
    return out

def explain_reading(d):
    r = (d.get('ratios') or ',,,').split(',')
    head = 'Learning clean air, ignore the level for now.' if d.get('learning') == '1' else f"Air is {d.get('level', '?').upper()}."
    gas = '  '.join(f"{n.split(' (')[0]} {float(x):.1f}x" for n, x in zip(GASES, r) if x)
    return [f"{head} Odour {float(d['index']):.0f} of 100. {climate(d)}.", f'  Compared with clean air: {gas}. (1.0x means the same.)']

def csv_row(d, now):
    r = (d.get('ratios') or ',,,').split(',')
    return [now, d.get('index'), d.get('level'), *r, num(d.get('t')), num(d.get('h')), d.get('queued'), d.get('learning')]

def to_row(d):
    """A READING line as one row for the database's ingest function, stamped by this laptop."""
    t, h = num(d.get('t')), num(d.get('h'))
    return {'t': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'i': float(d['index']),
            'r': [float(x) for x in d['ratios'].split(',')], 'tc': t, 'h': None if h is None else round(h), 'l': d.get('learning') == '1'}

def post_reading(url, d):
    """Recording must never stop because the dashboard is down, so failures only produce a note."""
    req = urllib.request.Request(url.rstrip('/') + '/local/reading', json.dumps(to_row(d)).encode(), {'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=5).read(); return '  Shown on the dashboard.'
    except Exception as e:
        return f'  Dashboard did not take it ({e}). The reading is still saved.'

def run(stream, out_dir, write=None, stop_after=None, dashboard=None):
    """Reads lines until the board goes away. Kept separate from the serial port so it can be tested."""
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    csv_path, log_path = out_dir / f'node_{stamp}.csv', out_dir / f'node_{stamp}.log'
    saved, clock_sent = 0, False
    with csv_path.open('w', newline='') as cf, log_path.open('w') as lf:
        w = csv.writer(cf); w.writerow(FIELDS); cf.flush()
        print(f'Saving to {csv_path}')
        while stop_after is None or saved < stop_after:
            raw = stream.readline()
            if not raw:
                continue
            line = raw.decode('utf-8', 'replace').strip()
            if not line:
                continue
            now = datetime.now().isoformat(timespec='seconds')
            lf.write(f'{now} {line}\n'); lf.flush()
            kind, d = parse(line)
            clock = now[11:19]
            if kind == 'LIVE':
                if d.get('clock') == '0' and not clock_sent and write:   # no WiFi needed for real timestamps
                    write(f'T{int(time.time())}\n'.encode()); clock_sent = True
                msgs = explain_live(d)
            elif kind == 'READING':
                w.writerow(csv_row(d, now)); cf.flush(); saved += 1
                msgs = explain_reading(d) + [f'  Saved reading {saved}.'] + ([post_reading(dashboard, d)] if dashboard else [])
            else:
                msgs = [line]
            print(clock, msgs[0])
            for m in msgs[1:]:
                print(' ' * 8, m)
    return csv_path, saved

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--find', action='store_true', help='only report whether a board is plugged in')
    ap.add_argument('--port', help='use this port instead of searching')
    ap.add_argument('--dashboard', help='also send readings to a local live dashboard, e.g. http://localhost:8788')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'recordings'))
    a = ap.parse_args()
    try:
        import serial
    except ImportError:
        sys.exit('First run: python3 -m venv tools/.venv && tools/.venv/bin/pip install pyserial\nThen: tools/.venv/bin/python tools/usb_node.py')
    if a.find:
        b = find_board()
        print(f'Found {USB_CHIPS.get(b.vid, "USB serial")} board at {b.device}' if b else
              'No board found. Use a data USB cable (many are charge-only) and try another port.')
        sys.exit(0 if b else 1)
    port = a.port
    while not port:
        b = find_board()
        if b:
            port = b.device; print(f'Found {USB_CHIPS.get(b.vid, "USB serial")} board at {port}')
        else:
            print('Waiting for the board. Plug in the USB cable...', end='\r'); time.sleep(1)
    s = serial.Serial(); s.port, s.baudrate, s.timeout = port, 115200, 2
    s.dtr = s.rts = False   # opening the port must not reset the board
    s.open()
    try:
        run(s, a.out, write=s.write, dashboard=a.dashboard)
    except KeyboardInterrupt:
        print('\nStopped. Your readings are saved in', a.out)
    except serial.SerialException:
        print('\nThe board was unplugged. Your readings are saved in', a.out)

if __name__ == '__main__':
    main()
