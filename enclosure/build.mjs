// Parametric enclosure for the Smart Odour node. Run:  node enclosure/build.mjs  (from the repo, after npm install in tools/)
// Writes one STL per printed part, plus a fit report: it places mock-ups of every component
// inside the model and fails if anything collides, or if the outer size goes over the limit.
//
// Layout (seen from the front): top bay = electronics, LCD in the lid. Bottom bay = sensors.
// Air enters the louvres on the left, passes the DHT11 then the four MQ cans, and the 40 mm
// fan blows it out through the louvres on the right. A wall keeps heater warmth and dirty
// air away from the electronics.
import { writeFileSync, mkdirSync } from 'node:fs';
const { default: Module } = await import(new URL('../tools/node_modules/manifold-3d/manifold.js', import.meta.url).href);
const wasm = await Module(); wasm.setup();
const { Manifold, CrossSection } = wasm;

// ---------------- dimensions (mm). Measure yours with a ruler and edit here if different.
const P = {
  limit: 180,        // the client's maximum length
  wall: 2.4, floor: 2.4,
  W: 142, H: 138, D: 70,        // body outside: width, height, depth
  sensorBay: 52,     // inside height of the sensor bay
  divider: 2.4,
  lidT: 2.4, lipH: 3, fit: 0.3,
  lcd: { w: 80, h: 36, holeX: 75, holeY: 31, winW: 72, winH: 25, standoff: 8.5, depth: 20 },
  acrylic: { w: 78, h: 33, t: 1.6 },
  base: { w: 86, h: 70, stand: 4, height: 34 },   // ESP32 on its expansion base, wires included
  mq: { w: 21, h: 33, t: 2, can: 20, canH: 24, pins: 8 },
  dht: { w: 15, h: 30, t: 2, body: 13 },
  fan: { size: 40, thick: 11, holes: 32, bore: 37 },
  cable: { d: 13 },
  roofOver: 8, roofT: 2.4, roofRise: 6,
  ear: { w: 18, h: 16 },
};
const { W, H, D, wall, floor, divider, lidT } = P;
const bodyD = D - lidT;      // the lid sits on the front of the body
const innerW = W - 2 * wall;
const box = (x, y, z, w, h, d) => Manifold.cube([w, h, d]).translate([x, y, z]);
const cyl = (x, y, z, r, h) => Manifold.cylinder(h, r, r, 48).translate([x, y, z]);   // along z
const cylX = (x, y, z, r, h) => Manifold.cylinder(h, r, r, 48).rotate([0, 90, 0]).translate([x, y, z]);
const u = (...a) => Manifold.union(a.flat());
// Coordinates: x = width, y = height (0 at the bottom), z = depth (0 at the back wall, D at the front).
const bayFloor = floor;                                   // sensor bay bottom
const divY = floor + P.sensorBay;                         // underside of divider
const elecFloor = divY + divider;
const topY = H - floor;

// A side wall strip of slanted slits: rain hits the slope and runs out.
function louvres(left, y0, y1, z0, z1, pitch = 7) {
  const cuts = [], len = wall + 8, run = len * Math.cos(40 * Math.PI / 180), rise = len * Math.sin(40 * Math.PI / 180);
  for (let y = y0; y + 3.2 + rise <= y1; y += pitch) {
    const slot = Manifold.cube([len, 3.2, z1 - z0]);
    cuts.push(left ? slot.rotate([0, 0, 40]).translate([-3, y, z0]) : slot.rotate([0, 0, -40]).translate([W + 3 - run, y + rise, z0]));
  }
  return u(cuts);
}

// ---------------- body
const screws = [[wall + 4, floor + 4], [W - wall - 4, floor + 4], [wall + 4, H - floor - 4], [W - wall - 4, H - floor - 4]];
const baseX = 40;     // ESP32 base sits right of centre, leaving room on the left for the power plug to bend
const rack = { x: wall + 8.6, y: floor + 2, w: W - 2 * wall - 8.6 - 8.8, h: P.sensorBay - 4, t: 2.4, z: floor + 5 };   // clears the corner screw posts
const rackPosts = [[rack.x + 4, rack.y + 4], [rack.x + rack.w - 4, rack.y + 4], [rack.x + 4, rack.y + rack.h - 4], [rack.x + rack.w - 4, rack.y + rack.h - 4]];
const fanY = () => divY - P.fan.size - 3;   // high in the bay, clear of the corner screw post
function makeBody() {
  let body = box(0, 0, 0, W, H, bodyD).subtract(box(wall, floor, floor, innerW, H - 2 * floor, bodyD));
  body = body.add(box(wall, divY, floor, innerW, divider, bodyD - floor - P.lipH - 0.2));         // divider
  for (const [x, y] of screws) body = body.add(box(x - 4, y - 4, floor, 8, 8, bodyD - floor));     // screw posts
  // Slanted slits: intake on the left, exhaust on the right.
  body = body.subtract(louvres(true, bayFloor + 10, divY - 1, floor + 8, bodyD - 8));
  body = body.subtract(louvres(false, bayFloor + 3, divY - 8, floor + 8, bodyD - 8));
  // Fan mount: a frame on the inside of the right wall. M3 screws from the fan side.
  const f = P.fan, fy = fanY(), fz = floor + (bodyD - floor - f.size) / 2;
  const fx = W - wall - 3;
  body = body.add(box(fx, fy - 3, fz - 3, 3, f.size + 6, f.size + 6).subtract(cylX(fx - 1, fy + f.size / 2, fz + f.size / 2, f.bore / 2, 6)));
  for (const a of [-1, 1]) for (const b of [-1, 1]) body = body.subtract(cylX(fx - 1, fy + f.size / 2 + a * f.holes / 2, fz + f.size / 2 + b * f.holes / 2, 1.3, 5));
  // Four posts hold the sensor rack 5 mm off the back wall; sensor wires run behind the plate.
  for (const [x, y] of rackPosts) body = body.add(cyl(x, y, floor, 3.5, rack.z - floor).subtract(cyl(x, y, floor - 1, 1.25, rack.z - floor + 2)));
  // Wire passage between bays, at the back. Plug it with foam or sealant after wiring.
  body = body.subtract(box(W / 2 - 22, divY - 1, floor + 0.5, 44, divider + 2, 10));
  // Electronics cradle: corner stops, so no hole pattern has to match. A hook-and-loop pad holds the base.
  const b = P.base, bx = baseX, by = elecFloor + 4, hStop = b.stand + 4;
  body = body.add(box(bx + 8, by + 8, floor, b.w - 16, 3, b.stand)).add(box(bx + 8, by + b.h - 11, floor, b.w - 16, 3, b.stand));
  for (const [cx, cy, sx, sy] of [[bx, by, -1, -1], [bx + b.w, by, 1, -1], [bx, by + b.h, -1, 1], [bx + b.w, by + b.h, 1, 1]]) {
    body = body.add(box(sx < 0 ? cx - 2 : cx - 8, sy < 0 ? cy - 2 : cy, floor, 10, 2, hStop));
    body = body.add(box(sx < 0 ? cx - 2 : cx, sy < 0 ? cy - 2 : cy - 8, floor, 2, 10, hStop));
  }
  // Power cable: a round hole in the left wall of the electronics bay, under the roof overhang.
  const cz = floor + 26;
  body = body.subtract(cylX(-1, elecFloor + 12, cz, P.cable.d / 2, wall + 2));
  // Cable-tie anchor just inside the hole, so a tug on the cable does not reach the board.
  body = body.add(box(wall, elecFloor + 24, cz - 7, 7, 3, 14).subtract(box(wall + 2, elecFloor + 23, cz - 2.5, 3, 5, 5)));
  // Mounting ears at the back: screws on a wall, or cable ties round a pole.
  for (const x of [-P.ear.w + 2, W - 2]) {
    const y0 = H / 2 - P.ear.h / 2;
    let ear = box(x, y0 - 28, 0, P.ear.w, P.ear.h, 3).add(box(x, y0 + 28, 0, P.ear.w, P.ear.h, 3));
    ear = ear.subtract(cyl(x + P.ear.w / 2, y0 - 28 + P.ear.h / 2, -1, 2.3, 6)).subtract(cyl(x + P.ear.w / 2, y0 + 28 + P.ear.h / 2, -1, 2.3, 6));
    body = body.add(ear);
  }
  // Screw pilots (M3 self-tapping).
  for (const [x, y] of screws) body = body.subtract(cyl(x, y, bodyD - 13, 1.25, 14));
  return body;
}

// ---------------- lid (front panel). Printed face down.
const lcdCX = W / 2, lcdCY = elecFloor + (topY - elecFloor) / 2 + 2;
function makeLid() {
  let lid = box(0, 0, 0, W, H, lidT);
  const fit = P.fit, inX = wall + fit, inW = innerW - 2 * fit;
  // Lip that slides into the body; cut around posts.
  let lip = box(inX, floor + fit, lidT, inW, H - 2 * floor - 2 * fit, P.lipH)
    .subtract(box(inX + 1.6, floor + fit + 1.6, lidT - 1, inW - 3.2, H - 2 * floor - 2 * fit - 3.2, P.lipH + 2));
  for (const [x, y] of screws) lip = lip.subtract(box(x - 4.5, y - 4.5, lidT, 9, 9, P.lipH + 1));
  lid = lid.add(lip);
  lid = lid.add(box(inX, divY - 0.2, lidT, inW, divider + 0.4, P.lipH));                  // rib closes the divider
  for (const [x, y] of screws) lid = lid.subtract(cyl(x, y, -1, 1.7, lidT + 2)).subtract(Manifold.cylinder(1.6, 3.2, 1.7, 32).translate([x, y, 0]));
  // LCD window and acrylic rebate (lid inner face is z = lidT). Lid is modelled front face at z=0.
  const l = P.lcd, a = P.acrylic;
  lid = lid.subtract(box(lcdCX - l.winW / 2, lcdCY - l.winH / 2, -1, l.winW, l.winH, lidT + 2));
  lid = lid.subtract(box(lcdCX - a.w / 2, lcdCY - a.h / 2, lidT - 1.2, a.w, a.h, 2));
  for (const a2 of [-1, 1]) for (const b2 of [-1, 1]) {
    const x = lcdCX + a2 * l.holeX / 2, y = lcdCY + b2 * l.holeY / 2;
    lid = lid.add(cyl(x, y, lidT, 3, l.standoff).subtract(cyl(x, y, lidT, 1.15, l.standoff + 1)));
  }
  return lid;
}

// ---------------- sensor rack: a plate with pockets for the 4 MQ boards and DHT11. Lifts out for servicing.
const slots = (() => {
  const dhtX = rack.x + 3, firstMq = dhtX + P.dht.w + 2.6, pitch = P.mq.w + 1.6;
  return { dhtX, mq: [0, 1, 2, 3].map(i => firstMq + i * pitch) };
})();
function makeRack() {
  const t = rack.t, pocketY = rack.y + (rack.h - P.mq.h) / 2;
  let r = box(rack.x, rack.y, rack.z, rack.w, rack.h, t);
  const pocket = (x, y, w, h) => {
    let p = u(box(x - 1.2, y - 1.2, rack.z + t, w + 2.4, 1.2, 5), box(x - 1.2, y + h, rack.z + t, w + 2.4, 1.2, 5));
    p = p.add(box(x + w / 2 - 4, y + 4, rack.z + t, 8, 2, 3)).add(box(x + w / 2 - 4, y + h - 6, rack.z + t, 8, 2, 3));   // keeps solder joints off the plate
    return p;
  };
  for (const x of slots.mq) r = r.add(pocket(x, pocketY, P.mq.w, P.mq.h));
  r = r.add(pocket(slots.dhtX, rack.y + (rack.h - P.dht.h) / 2, P.dht.w, P.dht.h));
  // Slots for small cable ties behind each board, and a pull tab on top.
  for (const x of [...slots.mq.map(v => v + P.mq.w / 2), slots.dhtX + P.dht.w / 2]) {
    r = r.subtract(box(x - 5.5, rack.y + rack.h / 2 - 1.5, rack.z - 1, 2.2, 3, t + 2)).subtract(box(x + 3.3, rack.y + rack.h / 2 - 1.5, rack.z - 1, 2.2, 3, t + 2));
  }
  for (const [x, y] of rackPosts) r = r.subtract(cyl(x, y, rack.z - 1, 1.7, t + 2));
  return r;
}

// ---------------- roof: slides over the top like a cap, sheds rain clear of lid and louvres.
function makeRoof() {
  const o = P.roofOver, t = P.roofT, w = W + 2 * o + 2 * t, d = D + o, skirt = 10;
  const prof = CrossSection.ofPolygons([[[0, 0], [w, 0], [w, 3], [w / 2, 3 + P.roofRise], [0, 3]]]);
  let top = prof.extrude(d).translate([-o - t, H + 0.0, 0]);
  let sk = box(-0.3 - t, H - skirt, 0, W + 0.6 + 2 * t, skirt, D + 0.3 + t)
    .subtract(box(-0.3, H - skirt - 1, -1, W + 0.6, skirt + 1.5, D + 1.3));
  // The two top lid screws pass through the skirt, so they also hold the roof on.
  for (const [x, y] of screws.slice(2)) sk = sk.subtract(cyl(x, y, D - 1, 1.7, t + 3));
  return top.add(sk);
}

// ---------------- mock components, placed to prove that everything fits
function makeMocks() {
  const m = {};
  const b = P.base, bx = baseX, by = elecFloor + 4;
  m.power_plug = box(bx - 30, by + 18, floor + b.stand, 30, 14, 14);
  m.esp32_on_base = box(bx, by, floor + b.stand, b.w, b.h, b.height - b.stand);
  const l = P.lcd;
  m.lcd = box(lcdCX - l.w / 2, lcdCY - l.h / 2, D - lidT - l.standoff - l.depth, l.w, l.h, l.depth);
  const pocketY = rack.y + (rack.h - P.mq.h) / 2, boardZ = rack.z + rack.t + 3;
  slots.mq.forEach((x, i) => {
    m[`mq_${i + 1}`] = u(box(x, pocketY, boardZ, P.mq.w, P.mq.h, P.mq.t),
      cyl(x + P.mq.w / 2, pocketY + P.mq.h / 2, boardZ + P.mq.t, P.mq.can / 2, P.mq.canH));
  });
  m.dht11 = box(slots.dhtX, rack.y + (rack.h - P.dht.h) / 2, boardZ, P.dht.w, P.dht.h, P.dht.body);
  const f = P.fan, fy = fanY(), fz = floor + (bodyD - floor - f.size) / 2;
  m.fan = box(W - wall - 3 - f.thick, fy, fz, f.thick, f.size, f.size);
  return m;
}

// ---------------- output
const body = makeBody();
const lidFront = makeLid();
// Place the lid in assembly position: its front face at z = D + lidT - lidT. Lid modelled with lip towards +z,
// so flip for assembly: front face at z = D, lip reaching back into the body.
const lidAsm = lidFront.scale([1, 1, -1]).translate([0, 0, D]);
const rackPart = makeRack();
const roof = makeRoof();
const mocks = makeMocks();

function stl(m, path) {
  const mesh = m.getMesh(); const tris = mesh.triVerts.length / 3, pos = mesh.vertProperties, n = mesh.numProp;
  const buf = Buffer.alloc(84 + 50 * tris); buf.write('Smart Odour enclosure', 0); buf.writeUInt32LE(tris, 80);
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
const out = new URL('./stl/', import.meta.url).pathname; mkdirSync(out, { recursive: true });
// Printing orientation: body on its back, lid face down, rack flat, roof rotated open side down.
stl(body, out + '1_body.stl');
stl(lidFront, out + '2_front_lid.stl');
stl(rackPart.translate([-rack.x, -rack.y, -rack.z]), out + '3_sensor_rack.stl');
stl(roof.rotate([-90, 0, 0]).translate([0, 0, -(H - 10)]), out + '4_roof.stl');
// Assembly files for viewing only.
const mkAsm = out + '../assembly/'; mkdirSync(mkAsm, { recursive: true });
stl(u(body, lidAsm, rackPart, roof), mkAsm + 'assembled_shell.stl');
stl(u(Object.values(mocks)), mkAsm + 'components_mockup.stl');
stl(u(body, rackPart), mkAsm + 'open_shell.stl');

// ---------------- checks
const printed = { body, lid: lidAsm, rack: rackPart, roof };
const problems = [];
for (const [cn, c] of Object.entries(mocks)) for (const [pn, p] of Object.entries(printed)) {
  // The MQ rack contact is by design: the board rests on the rack's raised pads only.
  const v = c.intersect(p).volume();
  if (v > 0.5) problems.push(`${cn} collides with ${pn}: ${v.toFixed(0)} mm3`);
}
const names = Object.keys(mocks);
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const v = mocks[names[i]].intersect(mocks[names[j]]).volume();
  if (v > 0.5) problems.push(`${names[i]} collides with ${names[j]}: ${v.toFixed(0)} mm3`);
}
for (const [a, b] of [['body', 'lid'], ['body', 'rack'], ['body', 'roof'], ['lid', 'rack'], ['lid', 'roof']]) {
  const v = printed[a].intersect(printed[b]).volume();
  if (v > 1) problems.push(`printed parts ${a} and ${b} overlap: ${v.toFixed(0)} mm3`);
}
const all = u(body, lidAsm, rackPart, roof), bb = all.boundingBox();
const size = bb.max.map((v, i) => +(v - bb.min[i]).toFixed(1));
const biggest = Math.max(...size);
if (biggest > P.limit) problems.push(`outer size ${biggest} exceeds the ${P.limit} mm limit`);
// Clearances between the can tops and the lid, and the LCD and the ESP32 stack.
const clear = {
  mq_can_to_lid: +(bodyD - P.lipH - (rack.z + rack.t + 3 + P.mq.t + P.mq.canH)).toFixed(1),
  lcd_to_esp_stack: +((D - lidT - P.lcd.standoff - P.lcd.depth) - (floor + P.base.height)).toFixed(1),
  mq_row_to_fan: +((W - wall - 3 - P.fan.thick) - (slots.mq[3] + P.mq.w)).toFixed(1),
};
for (const [k, v] of Object.entries(clear)) if (v < 0) problems.push(`negative clearance ${k}: ${v}`);
const grams = v => +(v / 1000 * 1.27).toFixed(0);  // PETG, solid volume, upper bound
const report = {
  outer_mm: { width: size[0], height: size[1], depth: size[2] }, limit_mm: P.limit, within_limit: biggest <= P.limit, clearances_mm: clear,
  watertight: Object.fromEntries(Object.entries(printed).map(([k, m]) => [k, m.status() === 'NoError' || m.status() === 0])),
  grams_petg: Object.fromEntries(Object.entries(printed).map(([k, m]) => [k, grams(m.volume())])),
  parts_bbox_mm: Object.fromEntries(Object.entries(printed).map(([k, m]) => { const b2 = m.boundingBox(); return [k, b2.max.map((v, i) => +(v - b2.min[i]).toFixed(1))]; })),
  problems,
};
writeFileSync(new URL('./fit_report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
process.exit(problems.length ? 1 : 0);
