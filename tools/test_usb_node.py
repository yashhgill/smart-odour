"""Tests the USB tool's parsing and recording using lines shaped like the firmware's output."""
import csv, io, tempfile, unittest
from usb_node import parse, explain_live, explain_reading, run, to_row, post_reading

LIVE_WARM = b'LIVE fw=2.1.0 up=28 warm=272 adc=634,2811,300,410 t=29.0 h=81 wifi=0 clock=0\n'
LIVE_BAD = b'LIVE fw=2.1.0 up=400 warm=0 adc=4095,5,300,410 t=nan h=nan wifi=1 clock=1\n'
READ = b'READING index=44.4 level=Noticeable ratios=1.80,1.70,1.10,1.00 t=29.0 h=81 queued=3 dropped=0 learning=0\n'

class Lines:
    def __init__(self, rows): self.rows = list(rows)
    def readline(self): return self.rows.pop(0) if self.rows else b''

class T(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse(READ.decode().strip())[0], 'READING')
        self.assertEqual(parse('MQ7_1(CO):634')[0], None)
    def test_plain_words(self):
        k, d = parse(LIVE_WARM.decode().strip()); self.assertIn('Warming up, 4:32 left', explain_live(d)[0])
        k, d = parse(READ.decode().strip()); m = explain_reading(d)
        self.assertIn('Air is NOTICEABLE. Odour 44 of 100', m[0]); self.assertIn('Fuel gas 1.8x', m[1])
    def test_warnings(self):
        k, d = parse(LIVE_BAD.decode().strip()); m = ' '.join(explain_live(d))
        self.assertIn('voltage divider', m); self.assertIn('Check its wire', m); self.assertIn('not answering', m)
    def test_records_and_sets_clock_and_keeps_old_firmware_lines(self):
        sent = []
        with tempfile.TemporaryDirectory() as tmp:
            path, n = run(Lines([b'MQ7_1(CO):634\n', LIVE_WARM, READ]), tmp, write=sent.append, stop_after=1)
            rows = list(csv.DictReader(path.open()))
            self.assertEqual(n, 1); self.assertEqual(rows[0]['index'], '44.4'); self.assertEqual(rows[0]['fuel_gas_x'], '1.80')
            self.assertIn('MQ7_1(CO):634', path.with_suffix('.log').read_text())
        self.assertTrue(sent[0].startswith(b'T'))

class Row(unittest.TestCase):
    def test_row_for_database(self):
        r = to_row(parse(READ.decode().strip())[1])
        self.assertEqual((r['i'], r['r'][0], r['tc'], r['h'], r['l']), (44.4, 1.8, 29.0, 81, False))
    def test_missing_climate_is_null(self):
        r = to_row(parse('READING index=1.0 level=NORMAL ratios=1,1,1,1 t=nan h=nan queued=0 dropped=0 learning=1')[1])
        self.assertIsNone(r['tc']); self.assertIsNone(r['h']); self.assertTrue(r['l'])
    def test_dashboard_down_does_not_raise(self):
        self.assertIn('still saved', post_reading('http://127.0.0.1:9', parse(READ.decode().strip())[1]))

unittest.main()
