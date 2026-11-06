# Smart Odour Monitoring Platform

Detects odour near UTeM from a low-cost ESP32 node, and shows how often, when and where it happens.

- `firmware/` sensor node (LCD in plain words, 12-hour offline queue)
- `supabase/` database, logic, alerts, three SQL files
- `dashboard/` public page (map, levels, history) and admin page (reports, calibration)
- `tools/usb_node.py` plug in by USB, read the node in plain English and record CSV
- `enclosure/` 3D-printed case, STL files
- `report/` PSM 2 report

Start with [docs/SETUP.md](docs/SETUP.md). The LCD is explained in [docs/LCD.md](docs/LCD.md), wiring in [docs/WIRING.md](docs/WIRING.md).
