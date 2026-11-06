# Reading the LCD

Each screen shows for 3 seconds.

| The screen says | What it means | What to do |
|---|---|---|
| `Warming up` / `Ready in 4:32` | Gas sensors are heating. No readings yet. | Wait 5 minutes after power-on. |
| `Learning air` / `Done in 23h` | First 24 hours: the node is learning what clean air looks like. | Leave it running in normal air. |
| `Air: NORMAL` / `Odour 12 of 100` | **The main result.** | Under 30 is fine. |
| `Air: NOTICEABLE` / `Odour 44 of 100` | You may smell it. 30 to 59. | |
| `Air: STRONG` / `Odour 75 of 100` | Close windows if you can. 60 and above. | |
| `Temperature 29C` / `Humidity 81%` | Air around the node. | `Check DHT11` means that sensor is not answering. |
| `Gas vs clean air` / `1.0x = same` | Reminder for the next two screens. | |
| `Fuel gas 1.1x` / `Butane gas 1.0x` | MQ-5 and MQ-6, compared with clean air. 2.0x is double. | |
| `CO gas A 1.2x` / `CO gas B 1.0x` | The two MQ-7 sensors (carbon monoxide), compared with clean air. | |
| `WiFi connected` / `All data sent` | Everything has reached the cloud. | |
| `No WiFi` / `To send: 12` | 12 readings are saved and will send when WiFi returns (12 hours maximum). | Check the hotspot. |

The old numbers such as `MQ7_1(CO):634` were raw electrical readings from 0 to 4095. They have no meaning on their own, so they now appear only in the USB tool's log.

Thresholds of 30 and 60 are starting values until smell reports calibrate them.
