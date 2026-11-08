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
  "PASS: historical narration timing/non-overlap and media presence; historical camera zoom/pan/pullback metadata.",
);
