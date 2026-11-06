# Notes

## 2026-11-07: PSM 2 rebuild (branch psm2-rebuild, not yet committed)
Changed: replaced the Cloudflare stack with Supabase and a static dashboard; new Odour Index and events; glass dashboard with satellite map; plain-word LCD; USB recorder (tools/usb_node.py); parametric enclosure with STLs; PSM 2 report built from the PSM 1 docx by report/build_report.py from report/content.txt.
Verified: 19 database tests, firmware logic tests, USB tool tests on simulated lines, ESP32 compile, enclosure fit check.
Not verified: nothing has run on real hardware, on a real Supabase project, or been printed. Report page layout is not fully checked in Word.
Next: plug in the board and run tools/usb_node.py; confirm pin positions (Lestari is a guess); add dividers; deploy; 72-hour test; fill yellow blanks in the report.
