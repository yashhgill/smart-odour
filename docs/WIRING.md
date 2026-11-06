# Wiring

These are the same pins as the PSM 1 board, so nothing needs moving to run the new firmware.

| Part | Pin |
|---|---|
| MQ-5 AOUT | GPIO32 |
| MQ-6 AOUT | GPIO33 |
| MQ-7 A AOUT | GPIO34 |
| MQ-7 B AOUT | GPIO35 |
| DHT11 data | GPIO4 |
| LCD SDA / SCL | GPIO21 / GPIO22 (I2C address 0x27) |
| Fan relay IN | GPIO26, held on so the fan always runs |
| MQ VCC | 5V, all GND shared |

## Fix this before long-term use: voltage dividers

MQ modules run at 5 V and their AOUT can rise close to 5 V. ESP32 inputs are rated for about 3.3 V. The PSM 1 code reads AOUT directly, and it reads raw values such as 2811, so dividers probably aren't fitted. Check the board.

Add one per sensor: AOUT to 10 kΩ to the GPIO, then the GPIO to 20 kΩ to GND. Then set `HAS_DIVIDERS = true` in `firmware/odour_node/odour_node.ino` and upload again. Until then `tools/usb_node.py` warns when a sensor hits the top of the range.

## Power

Use a 5 V supply of at least 2 A. Four MQ heaters plus a fan is more than a laptop USB port should supply for long, so if the board keeps restarting on USB, add the external supply and keep USB for data.

## Sensor choice

MQ-5, MQ-6 and MQ-7 are made for fuel gas, butane and carbon monoxide, not ammonia, the main poultry smell. Swapping one MQ-7 for an MQ-135 (about RM10) uses the same wiring and is the most useful single upgrade. Then change the LCD label in `updateLcd()`.
