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

## Telegram bot, test mode, commands, story and walkthrough (2026-11-07)
Changed: supabase/04_bot_and_control.sql is applied to the live project: students press Start on @utem_odour_alert_bot (no channel), functions/api/telegram.js is the webhook and holds no secret, test mode labels a location and stops its public alerts, admin_send_command queues Re-learn or Restart for the next upload (firmware 2.3.0). Fixed the firmware reading thresholds from the reply. Public page has a Telegram button, story section and first-visit walkthrough (dashboard/tour.js). Lekiu (Satria) is in test mode because the board is in Sunway.
Next: user runs tools/set_secrets.py, adds NODE-1 on the admin page, revokes the shared bot token and runs select private.set_telegram('TOKEN'). Then build and upload firmware 2.3.0 through the TV. At Satria: Clear test readings, turn off test mode, press Re-learn. UTeM Wi-Fi must be plain WPA2 with no login page, or use a hotspot. report/content.txt still says Telegram channel in places.
