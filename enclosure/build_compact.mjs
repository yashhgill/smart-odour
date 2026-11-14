// Compact desk enclosure for the Smart Odour node, made for a Bambu Lab A1 (256 mm cube, no supports).
// Run:  node enclosure/build_compact.mjs   (after npm install in tools/)
// Writes the printable STL files to enclosure/compact/, places mock-ups of every part inside the model,
// and fails if anything collides or a clearance goes negative.
//
// Layout: LCD, DHT11 and the four MQ cans come through the lid. The ESP32 on its expansion base and
// the 40 mm fan sit on the floor. The fan pulls air in through the floor (the box stands on feet) and
// pushes it out through the lid and wall vents, so heat from the MQ heaters does not build up.
// USB and the power plug leave through the back wall.
import { writeFileSync, mkdirSync } from 'node:fs';
const { default: Module } = await import(new URL('../tools/node_modules/manifold-3d/manifold.js', import.meta.url).href);
const wasm = await Module(); wasm.setup();
const { Manifold } = wasm;

// ---------------- part sizes (mm). Typical values: measure yours and edit here, then run again.
const P = {
  wall: 2.4, floor: 2.4, lidT: 2.4, gap: 1,
  base: { w: 64, d: 80, h: 40 },          // ESP32 on its expansion base, with jumper wires standing up
  fan: { size: 40, thick: 10.5, holes: 32 },
  lcd: { w: 80, d: 36, holeX: 75, holeY: 31, bezelW: 71.2, bezelD: 24.2, bezel: 7, back: 12, header: 16 },
  mq: { w: 22, d: 32, can: 20, canUp: 17, below: 22 },    // below = header pins plus jumper plugs
  dht: { w: 14, d: 28, bodyW: 12, bodyD: 15.5, bodyUp: 5.5, below: 20 },
  ear: 9,                                  // corner screw blocks under the lid
  usb: { w: 40, h: 22, up: 3 },            // opening in the back wall for USB and the power plug
  foot: { d: 12, h: 8 },
};
const { wall, floor, lidT, gap } = P;
// Inside size comes from the layout: front row LCD (with room for its I2C plug) + DHT11, back row four MQ.
const inW = gap + P.lcd.header + P.lcd.w + 3 + P.dht.w + gap + 2;
const inD = 2 + P.lcd.d + 4 + P.mq.d + 4 + P.ear;
const mqHang = 1.6 + P.mq.below, lcdHang = (P.lcd.bezel - lidT) + 1.6 + P.lcd.back;
const inH = 1 + P.base.h + 3 + Math.max(mqHang, lcdHang);
const W = inW + 2 * wall, D = inD + 2 * wall, H = floor + inH;   // body; lid adds lidT on top
const top = H;                                                   // lid underside

const box = (x, y, z, w, d, h) => Manifold.cube([w, d, h]).translate([x, y, z]);
const cyl = (x, y, z, r, h, n = 48) => Manifold.cylinder(h, r, r, n).translate([x, y, z]);
const u = (...a) => Manifold.union(a.flat());
// Coordinates: x = width (0 left), y = depth (0 front), z = up (0 under the floor).

// ---------------- where each part sits
const X0 = wall, Y0 = wall;
const lcd = { x: X0 + gap + P.lcd.header, y: Y0 + 2 };
lcd.cx = lcd.x + P.lcd.w / 2; lcd.cy = lcd.y + P.lcd.d / 2;
const dht = { x: lcd.x + P.lcd.w + 3, y: Y0 + P.ear + 2 };
const mqRowW = 4 * P.mq.w + 3 * 3;
const mqY = lcd.y + P.lcd.d + 4;
const mqs = [0, 1, 2, 3].map(i => ({ x: X0 + (inW - mqRowW) / 2 + i * (P.mq.w + 3), y: mqY }));
const base = { x: X0 + gap + 1, y: Y0 + (inD - P.base.d) / 2 };
const fan = { x: X0 + inW - gap - P.fan.size, y: Y0 + 2 };
fan.cx = fan.x + P.fan.size / 2; fan.cy = fan.y + P.fan.size / 2;
const ears = [[X0, Y0], [X0 + inW - P.ear, Y0], [X0, Y0 + inD - P.ear], [X0 + inW - P.ear, Y0 + inD - P.ear]];
const earHole = ([x, y]) => [x + P.ear / 2, y + P.ear / 2];

// ---------------- body: printed upright, floor on the plate
function makeBody() {
  let b = box(0, 0, 0, W, D, H).subtract(box(wall, wall, floor, inW, inD, H));
  // Screw blocks in the top corners. The 45 degree underside prints without support.
  for (const e of ears) {
    const [x, y] = e, s = P.ear, cx = x === X0 ? x : x + s, cy = y === Y0 ? y : y + s;
    const block = Manifold.hull([box(x, y, top - 8, s, s, 8), box(cx - (cx === x ? 0 : 0.4), cy - (cy === y ? 0 : 0.4), top - 8 - s, 0.4, 0.4, 0.4)]);
    const [hx, hy] = earHole(e);
    b = b.add(block.subtract(cyl(hx, hy, top - 10, 1.3, 11)));     // 2.6 mm pilot for M3 self-tapping screws
  }
  // Fan in the floor: grille, plus four M3 holes.
  const f = P.fan;
  let grille = [];
  for (let gx = -18; gx <= 18; gx += 4.6) for (let gy = -18; gy <= 18; gy += 4) {
    const ox = gx + ((Math.round((gy + 18) / 4) % 2) ? 2.3 : 0);
    if (Math.hypot(ox, gy) < 17) grille.push(cyl(fan.cx + ox, fan.cy + gy, -1, 1.7, floor + 2, 6));
  }
  b = b.subtract(u(grille));
  for (const a of [-1, 1]) for (const c of [-1, 1]) b = b.subtract(cyl(fan.cx + a * f.holes / 2, fan.cy + c * f.holes / 2, -1, 1.7, floor + 2, 20));
  // Feet: four holes for the printed push-in feet (or use stick-on rubber feet and ignore them).
  for (const [fx, fy] of feetAt()) b = b.subtract(cyl(fx, fy, -1, 1.65, floor + 2, 20));
  // Low corner stops so the expansion base cannot slide. Hold it down with a hook-and-loop pad.
  const bb = P.base;
  for (const [cx, cy] of [[base.x, base.y], [base.x + bb.w, base.y], [base.x, base.y + bb.d], [base.x + bb.w, base.y + bb.d]])
    b = b.add(cyl(cx + (cx === base.x ? -1.8 : 1.8), cy + (cy === base.y ? -1.8 : 1.8), floor, 1.5, 5, 16));
  // USB and power opening in the back wall, in line with the base.
  b = b.subtract(box(base.x + bb.w / 2 - P.usb.w / 2, D - wall - 1, floor + P.usb.up, P.usb.w, wall + 2, P.usb.h));
  // Exhaust slits high on both side walls and the back wall (vertical, so no bridging).
  const slits = [];
  for (let k = 0; k < 8; k++) {
    slits.push(box(-1, Y0 + 20 + k * 6, top - 18, wall + 2, 2.4, 12));
    slits.push(box(W - wall - 1, Y0 + 20 + k * 6, top - 18, wall + 2, 2.4, 12));
  }
  for (let k = 0; k < 9; k++) slits.push(box(base.x + bb.w / 2 + P.usb.w / 2 + 6 + k * 5.2, D - wall - 1, top - 30, 2.4, wall + 2, 18));
  return b.subtract(u(slits));
}
function feetAt() { return [[8, 8], [W - 8, 8], [8, D - 8], [W - 8, D - 8]].filter(([x, y]) => !(Math.abs(x - fan.cx) < 21 && Math.abs(y - fan.cy) < 21)).concat([[W - 8, fan.y + P.fan.size + 6]]); }

// ---------------- lid: printed upside down, top face on the plate. Modelled in place (z = top .. top + lidT).
function makeLid() {
  let l = box(0, 0, top, W, D, lidT);
  const z = top - 0.01;
  // LCD: the metal bezel pushes up into the window, so the screen sits flush with the lid.
  l = l.subtract(box(lcd.cx - P.lcd.bezelW / 2 - 0.6, lcd.cy - P.lcd.bezelD / 2 - 0.6, z - 1, P.lcd.bezelW + 1.2, P.lcd.bezelD + 1.2, lidT + 2));
  const sh = P.lcd.bezel - lidT;   // standoff height under the lid
  for (const a of [-1, 1]) for (const c of [-1, 1])
    l = l.add(cyl(lcd.cx + a * P.lcd.holeX / 2, lcd.cy + c * P.lcd.holeY / 2, top - sh, 2.8, sh + 0.1, 24)
      .subtract(cyl(lcd.cx + a * P.lcd.holeX / 2, lcd.cy + c * P.lcd.holeY / 2, top - sh - 1, 1.15, sh + 0.5, 16)));
  // MQ cans stick up through the lid and sample the outside air. A low rim locates each board.
  for (const m of mqs) {
    const cx = m.x + P.mq.w / 2, cy = m.y + P.mq.d / 2;
    l = l.add(box(m.x - 1.5, m.y - 1.5, top - 2.5, P.mq.w + 3, P.mq.d + 3, 2.6).subtract(box(m.x - 0.3, m.y - 0.3, top - 3, P.mq.w + 0.6, P.mq.d + 0.6, 3)));
    l = l.subtract(cyl(cx, cy, z - 3, P.mq.can / 2 + 0.5, lidT + 5, 64));
  }
  // DHT11: the blue sensor pokes through a slot; its board sits in a rim like the MQ boards.
  l = l.add(box(dht.x - 1.5, dht.y - 1.5, top - 2.5, P.dht.w + 3, P.dht.d + 3, 2.6).subtract(box(dht.x - 0.3, dht.y - 0.3, top - 3, P.dht.w + 0.6, P.dht.d + 0.6, 3)));
  l = l.subtract(box(dht.x + (P.dht.w - P.dht.bodyW) / 2 - 0.4, dht.y + 2 - 0.4, z - 3, P.dht.bodyW + 0.8, P.dht.bodyD + 0.8, lidT + 5));
  // Exhaust slots along the back edge, and the four screw holes.
  for (let k = 0; k < 12; k++) l = l.subtract(box(X0 + P.ear + 6 + k * ((inW - 2 * P.ear - 14) / 11), Y0 + inD - P.ear + 1.5, z - 1, 2.4, P.ear - 3, lidT + 2));
  for (const e of ears) { const [hx, hy] = earHole(e); l = l.subtract(cyl(hx, hy, z - 1, 1.7, lidT + 2, 20)).subtract(cyl(hx, hy, top + lidT - 1.6, 1.7, 1.7, 20).add(Manifold.cylinder(1.6, 1.7, 3.2, 24).translate([hx, hy, top + lidT - 1.6]))); }
  return l;
}

// ---------------- push-in foot (print 4)
const foot = cyl(0, 0, 0, P.foot.d / 2, P.foot.h, 48).add(cyl(0, 0, P.foot.h, 1.45, 2.2, 20));

// ---------------- mock-ups of the real parts, for the collision check and the pictures
function makeMocks() {
  const m = {};
  m.base = box(base.x, base.y, floor + 1, P.base.w, P.base.d, P.base.h);
  m.fan = box(fan.x, fan.y, floor, P.fan.size, P.fan.size, P.fan.thick);
  const pcbZ = top - (P.lcd.bezel - lidT) - 1.6;
  m.lcd = u(box(lcd.x, lcd.y, pcbZ, P.lcd.w, P.lcd.d, 1.6),
    box(lcd.cx - P.lcd.bezelW / 2, lcd.cy - P.lcd.bezelD / 2, pcbZ + 1.6, P.lcd.bezelW, P.lcd.bezelD, P.lcd.bezel - 0.2),
    box(lcd.x + 10, lcd.y + 4, pcbZ - P.lcd.back, 42, 19, P.lcd.back),              // I2C backpack
    box(lcd.x - P.lcd.header + 1, lcd.cy - 6, pcbZ - P.lcd.back + 1, P.lcd.header - 1, 12, 9));   // its plug and wires
  m.mq = u(mqs.map(q => u(box(q.x, q.y, top - 1.6, P.mq.w, P.mq.d, 1.6),
    cyl(q.x + P.mq.w / 2, q.y + P.mq.d / 2, top, P.mq.can / 2, P.mq.canUp, 48),
    box(q.x + 2, q.y + 2, top - mqHang, P.mq.w - 4, P.mq.d - 4, mqHang - 1.6))));
  m.dht = u(box(dht.x, dht.y, top - 1.6, P.dht.w, P.dht.d, 1.6),
    box(dht.x + (P.dht.w - P.dht.bodyW) / 2, dht.y + 2, top, P.dht.bodyW, P.dht.bodyD, P.dht.bodyUp),
    box(dht.x + 2, dht.y + P.dht.d - 8, top - P.dht.below, P.dht.w - 4, 6, P.dht.below - 1.6));
  return m;
}

const body = makeBody(), lid = makeLid(), mocks = makeMocks();

// ---------------- export
function stl(mf, path) {
  const mesh = mf.getMesh(), tris = mesh.triVerts.length / 3, pos = mesh.vertProperties, n = mesh.numProp;
  const buf = Buffer.alloc(84 + 50 * tris); buf.write('Smart Odour compact enclosure', 0); buf.writeUInt32LE(tris, 80);
  let o = 84;
  for (let i = 0; i < tris; i++) {
    const v = [0, 1, 2].map(k => { const j = mesh.triVerts[i * 3 + k]; return [pos[j * n], pos[j * n + 1], pos[j * n + 2]]; });
    const a = v[1].map((c, q) => c - v[0][q]), c = v[2].map((c2, q) => c2 - v[0][q]);
    const nx = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]], len = Math.hypot(...nx) || 1;
    nx.forEach(q => { buf.writeFloatLE(q / len, o); o += 4; });
    v.flat().forEach(q => { buf.writeFloatLE(q, o); o += 4; });
    o += 2;
  }
  writeFileSync(path, buf);
}
const out = new URL('./compact/', import.meta.url).pathname; mkdirSync(out + 'view/', { recursive: true });
// Print orientation: body as modelled; lid flipped so its top face lies on the plate; feet peg up.
stl(body, out + '1_body.stl');
stl(lid.rotate([180, 0, 0]).translate([0, D, top + lidT]), out + '2_lid.stl');
stl(u([0, 1, 2, 3].map(i => foot.translate([10 + i * 16, 10, 0]))), out + '3_feet_x4.stl');
// Viewing files (z up turned to y up for the renderer).
const view = m => m.rotate([-90, 0, 0]);
stl(view(body), out + 'view/body.stl');
stl(view(lid), out + 'view/lid.stl');
stl(view(lid.translate([0, 0, 45])), out + 'view/lid_raised.stl');
for (const [k, v] of Object.entries(mocks)) stl(view(v), out + `view/part_${k}.stl`);

// ---------------- checks
const problems = [];
const printed = { body, lid };
for (const [cn, c] of Object.entries(mocks)) for (const [pn, p] of Object.entries(printed)) {
  const v = c.intersect(p).volume();
  if (v > 0.5) problems.push(`${cn} collides with ${pn}: ${v.toFixed(0)} mm3`);
}
const names = Object.keys(mocks);
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const v = mocks[names[i]].intersect(mocks[names[j]]).volume();
  if (v > 0.5) problems.push(`${names[i]} collides with ${names[j]}: ${v.toFixed(0)} mm3`);
}
if (body.intersect(lid).volume() > 0.5) problems.push('lid overlaps body');
const clear = {
  mq_wires_to_base: +((top - mqHang) - (floor + 1 + P.base.h)).toFixed(1),
  lcd_back_to_base: +((top - lcdHang) - (floor + 1 + P.base.h)).toFixed(1),
  base_to_fan: +(fan.x - (base.x + P.base.w)).toFixed(1),
};
for (const [k, v] of Object.entries(clear)) if (v < 0) problems.push(`negative clearance ${k}: ${v}`);
const all = u(body, lid), bb = all.boundingBox();
const size = bb.max.map((v, i) => +(v - bb.min[i]).toFixed(1));
const bed = 256;
for (const [k, m] of Object.entries({ body, lid })) { const b2 = m.boundingBox(); if (b2.max.some((v, i) => v - b2.min[i] > bed)) problems.push(`${k} is larger than the A1 bed`); }
const grams = v => +(v / 1000 * 1.27).toFixed(0);   // PETG, solid volume: an upper bound before infill
const report = {
  outer_mm: { width: size[0], depth: size[1], height_without_feet_or_cans: size[2] },
  height_with_feet_and_cans_mm: +(size[2] + P.foot.h + P.mq.canUp - lidT).toFixed(1),
  inside_mm: { width: +inW.toFixed(1), depth: +inD.toFixed(1), height: +inH.toFixed(1) },
  clearances_mm: clear,
  watertight: { body: body.status() === 0 || body.status() === 'NoError', lid: lid.status() === 0 || lid.status() === 'NoError' },
  grams_petg_solid: { body: grams(body.volume()), lid: grams(lid.volume()), feet: grams(foot.volume() * 4) },
  problems,
};
writeFileSync(out + 'fit_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
process.exit(problems.length ? 1 : 0);
