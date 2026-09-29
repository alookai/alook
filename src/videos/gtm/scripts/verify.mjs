import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
const voice = JSON.parse(readFileSync("src/voice-timing.json", "utf8"));
assert.equal(voice.length, 11);
assert.match(voice[0].text, /Lin/);
for (const [i, line] of voice.entries()) {
  assert.ok(line.at >= 0 && line.duration > 0 && line.at + line.duration <= 63);
  if (i)
    assert.ok(
      voice[i - 1].at + voice[i - 1].duration <= line.at,
      `Overlapping narration ${i}`,
    );
  assert.ok(existsSync(`public/${line.file}`));
}
const film = readFileSync("src/Film.tsx", "utf8"),
  product = readFileSync("src/Product.tsx", "utf8"),
  ending = readFileSync("src/Ending.tsx", "utf8");
assert.ok(!/opacity|fadeIn|fadeOut/.test(film));
assert.ok(!/heading-mask|className="heading"/.test(film));
assert.match(film, /Lin’s teammate/);
assert.match(film, /Share your agents with people you trust\./);
assert.equal(
  ending.match(/const agents\s*=\s*\[([\s\S]*?)\]/)[1].match(/['"][^'"]+['"]/g)
    .length,
  9,
);
assert.match(product, /Keep work details private/);
const shots = JSON.parse(readFileSync("src/camera-keyframes.json", "utf8"));
for (let i = 1; i < shots.length; i++) assert.ok(shots[i][0] > shots[i - 1][0]);
assert.ok(Math.max(...shots.map((s) => s[3])) >= 1.48);
assert.ok(shots.filter((s) => s[3] === 1).length >= 6);
assert.ok(
  Math.max(...shots.map((s) => s[1])) - Math.min(...shots.map((s) => s[1])) >
    1700,
);
for (const name of ["Lin", "Alex", "Sam"])
  assert.ok(existsSync(`src/assets/people/${name}.png`));
console.log(
  "PASS: named protagonist, non-overlapping VO, 63s timeline, deliberate zoom/pan and pullbacks, no section titles/fades, nine-agent ending, private sharing boundary.",
);
