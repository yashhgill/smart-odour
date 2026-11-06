# Notes

## 2026-11-07: PSM 2 rebuild (branch psm2-rebuild, not yet committed)
Changed: replaced the Cloudflare stack with Supabase and a static dashboard; new Odour Index and events; glass dashboard with satellite map; plain-word LCD; USB recorder (tools/usb_node.py); parametric enclosure with STLs; PSM 2 report built from the PSM 1 docx by report/build_report.py from report/content.txt.
Verified: 19 database tests, firmware logic tests, USB tool tests on simulated lines, ESP32 compile, enclosure fit check.
Not verified: nothing has run on real hardware, on a real Supabase project, or been printed. Report page layout is not fully checked in Word.
Next: plug in the board and run tools/usb_node.py; confirm pin positions (Lestari is a guess); add dividers; deploy; 72-hour test; fill yellow blanks in the report.

## TV bridge and real map pins (2026-11-07)
Changed: map pins now come from OpenStreetMap and were checked on satellite imagery (farm-side pin and "main" cafeteria still need confirming with Azira); farm labelled on the map. tools/tv_bridge fixed so esptool works through the TV over rfc2217 (both reset lines switched together, one queued USB read, no hardware purge). usb_node.py accepts rfc2217:// URLs. The TV light app grabs the ESP32 if it is running, so force-stop it first.
Next: finish the flash backup (firmware/backup, ignored by git, may hold old Wi-Fi details), upload firmware, read live sensors. User must create Supabase with smartodour@gmail.com, add the admin user and supply the old bot's token via BotFather. Students use Telegram with no login; never share the admin login.

## Real database and firmware on the board (2026-11-07)
Changed: Supabase project nikdxqsardermmjkfudv has the schema, 5 locations, 1 admin (smartodour@gmail.com) and a healthy cron job. The public site is now in real-data mode, so it says no sensors online until a device reports. Firmware 2.2.0 is on the board through the TV; old flash saved in firmware/backup (local only). usb_node.py streams board readings to the local dashboard on 8788, which labels them as a local test.
Next: sign in once as admin (not yet tested). Add NODE-1 on the admin page when the board is at a real site, and do not assign bench readings to a campus location on the public site. Fill secrets.h with 2.4 GHz Wi-Fi and the device key, rebuild, upload. Set the Telegram token and channels in private.config and TELEGRAM_LINK in config.js. Afterwards uninstall the TV bridge (adb uninstall my.yashh.espbridge) and reopen the light app.
