#!/usr/bin/env python3
"""Independent availability check for the evaluation. Run from any computer for the 72-hour test:
     python3 tools/probe.py https://YOUR-PROJECT.supabase.co YOUR_PUBLISHABLE_KEY https://your-dashboard.example
   Every 5 minutes it checks the API and the dashboard, appends to tools/out/availability.csv and prints the running figure."""
import csv, json, os, sys, time, urllib.request, datetime as dt
api, key, page = sys.argv[1:4]
os.makedirs(os.path.join(os.path.dirname(__file__), 'out'), exist_ok=True)
path = os.path.join(os.path.dirname(__file__), 'out', 'availability.csv')
def check(req):
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status == 200, round((time.time() - t) * 1000)
    except Exception: return False, round((time.time() - t) * 1000)
ok = total = 0
while True:
    a = urllib.request.Request(f'{api}/rest/v1/rpc/get_status', data=b'{}', method='POST',
        headers={'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    aok, ams = check(a); pok, pms = check(page)
    total += 1; ok += aok and pok
    with open(path, 'a', newline='') as f:
        csv.writer(f).writerow([dt.datetime.now(dt.timezone.utc).isoformat(), aok, ams, pok, pms])
    print(f'{total} checks, availability {100 * ok / total:.2f}%', flush=True)
    time.sleep(300)
