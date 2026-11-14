# Updating the firmware over Wi-Fi (OTA)

**OTA works on this board.** It was tested on 14 November 2026: firmware 2.3.1 was replaced by 2.3.2 over home Wi-Fi in about 20 seconds, with no cable. Afterwards, the database recorded the board reporting `fw=2.3.2`.

## Why it fits

| Check | This board | Needed |
|---|---|---|
| Chip | ESP32-D0WD-V3 (ESP32-WROOM-32 class) | Any ESP32 |
| Flash size | 4 MB (a full 4,194,304-byte backup was read off it) | At least 4 MB |
| Partition table | Two app slots, `app0` and `app1`, of 1,280 KB each, plus `otadata` | Two app slots |
| Firmware size | 1,145,559 bytes, 87% of the 1,310,720-byte slot | Under 100% |
| OTA code | `ArduinoOTA` in `odour_node.ino`, password protected, name `odour-node` | Present |

OTA writes the new program into the slot that is not running, checks it, then restarts into it. If the upload breaks halfway, the old program keeps running.

There is no need to change the Partition Scheme, as some guides suggest. The board already has the default scheme with two OTA slots. Changing the scheme in Arduino IDE would not match the board, and a partition table can only be changed over USB.

## How to update (Arduino IDE)

1. Put the computer on the **same Wi-Fi** as the board.
2. Open `firmware/odour_node/odour_node.ino`. Keep **Tools > Partition Scheme** on "Default 4MB with spiffs".
3. **Tools > Port**: choose the network port `odour-node at 192.168.x.x`. It can take a minute to appear.
4. Click **Upload**. When asked for a password, enter the `OTA_PASSWORD` from `firmware/odour_node/secrets.h`.
5. The LCD shows "Updating code / Do not unplug". The board restarts, warms up for 5 minutes, and then sends readings again.

From the command line, the equivalent is:

```
python3 ~/Library/Arduino15/packages/esp32/hardware/esp32/<version>/tools/espota.py -i <board IP> -a <OTA password> -f odour_node.ino.bin
```

## Limits

- **Same network only.** The laptop and the board must be on the same Wi-Fi or hotspot. On UTeM Wi-Fi this may not work, because campus networks often block devices from reaching each other (client isolation). A phone hotspot shared by the laptop and the board always works.
- **Room to grow:** about 160 KB is left in each slot. If the code grows past that, switch once, over USB, to "Minimal SPIFFS (1.9MB APP with OTA)".
- **Updating from anywhere** (for example from the admin page, while the laptop is elsewhere) needs a different method, where the board downloads the new firmware from the internet. That is not built yet. It would use the same command channel as the Re-learn and Restart buttons.
