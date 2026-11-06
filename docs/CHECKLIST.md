# Smart Odour Monitor: what is built and what works

Checked 7 November 2026. "Tested" means it was actually run on the real system, not only written.

## Fix first: sensor voltage

The MQ modules run at 5 V and their output can rise close to 5 V, but ESP32 inputs are rated for about 3.3 V. There are no voltage dividers yet, so a strong smell could read wrong or damage the board. Add one divider per sensor as described in `docs/WIRING.md`, then set `HAS_DIVIDERS = true` and upload again. Do this before the sensor goes to Satria.

## Working and tested

| Part | How it was checked |
|---|---|
| ESP32 firmware 2.3.1 | Running on the board. Reads 4 gas sensors, temperature and humidity |
| Room Wi-Fi | Board reports connected |
| Upload to the database | Board log: `accepted: 1, rejected: 0`. Reading seen on the live database |
| Live website | smart-odour.pages.dev answers and shows Lekiu (Satria) online, labelled as a test sensor |
| Test mode | Lekiu is in test mode, so bench readings do not count as campus air and do not alert the public |
| Database rules | 25 automated tests pass |
| Admin sign-in | smartodour@gmail.com signs in, and NODE-1 is linked to Lekiu |
| Telegram bot sign-up | Token saved and webhook connected. One person has pressed Start |
| Bot security | The webhook refuses a request with the wrong secret (403) |
| Map pins | Moved to OpenStreetMap positions and checked on satellite |
| Phone layout | Checked at 375 px: public page, admin page, map, event list and all 7 guide steps. No sideways scrolling, no clipped labels |

## Built, not yet tested for real

| Part | What is left |
|---|---|
| Telegram odour alert | No real alert has gone out, because test mode blocks public alerts. Test it once the sensor is at Satria |
| Telegram device alert | Send the `/admin` code to the bot, then unplug the board and wait for the offline message |
| Re-learn and Restart buttons | Built and covered by database tests. Not yet pressed against the real board |
| Update over Wi-Fi (OTA) | Built into the firmware, never used |
| Real odour readings | The board is at home in Sunway, so nothing has smelled the farm yet. It is also learning that room's air for 24 hours, so it must re-learn at Satria |
| Odour levels (30 and 60) | Starting values only. They need calibrating from real smell reports at UTeM |
| Phone layout on real phones | Tested in a phone-sized browser view. Open it once on an iPhone and an Android |

## Not built yet

| Part | What is needed |
|---|---|
| Enclosure, new compact version | Measurements of the base, fan and MQ modules. The older 174 x 147 x 78 mm design exists but has not been printed |
| Haze and particle readings | Needs a PMS5003 sensor. The MQ sensors cannot measure particles |
| Sensors at Lestari, cafeteria and other sites | More boards. The website already has their places on the map |
| UTeM Wi-Fi | Firmware supports a plain name and password only. A login page needs UTeM IT, or a hotspot |

## To confirm

- Main Cafeteria pin: Kafeteria Pelajar 1 was assumed. Ask Azira.
- North Perimeter pin: chosen from satellite images. Ask Azira.
- Sensor models: the firmware assumes MQ-5, MQ-6 and two MQ-7. Check the labels on the actual modules.
- Report wording: the local report still says "Telegram channel" in several places. It should say bot.

## When the sensor moves to Satria

1. Connect it to Wi-Fi there. This needs a plain name and password, so use a hotspot or room Wi-Fi.
2. On the admin page, press Clear test readings.
3. Turn Test mode off for Lekiu.
4. Press Re-learn while the air is clean.
5. Check that the site shows it as online with no test label.
