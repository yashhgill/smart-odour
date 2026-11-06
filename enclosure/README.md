# Enclosure

Outer size 174 x 147 x 78 mm, within the 18 cm limit. Print the four files in `stl/` (millimetres).

**Measure first.** The sizes in `build.mjs` are typical values, not measured from your parts. The biggest unknown is the expansion base, assumed 86 x 70 x 34 mm. If yours differs, edit the size at the top of `build.mjs` and run `node build.mjs`, which reports any collision and rewrites the STL files.

**Tinkercad.** Open a new design > Import, choose an STL, set units to millimetres. Each file is under Tinkercad's 25 MB limit. Tinkercad Circuits has no ESP32, so use the wiring diagram in `report/figures/wiring.png`.

**Print.** PETG (better outdoors than PLA), 0.2 mm layers, 3 walls, 20% infill. Support only if your printer needs it for the roof.

**Also buy.** M3 x 16 screws (bottom two) and M3 x 20 (top two, which also hold the roof), M3 screws for the fan, 78 x 33 x 1.6 mm clear acrylic, hook-and-loop pad, cable tie.

The power cable enters by the 13 mm hole in the left wall and is tied to the anchor so a tug doesn't reach the board. Keep the enclosure sheltered: the louvres shed rain but it isn't waterproof.
