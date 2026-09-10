export const DURATION = 540;
export const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const motionAt = (frame: number) => {
  const merge = smooth(frame / 144);
  const split = smooth((frame - 204) / 144);
  const joined = merge - split;
  const times = [348, 384, 414, 450, 486, 510];
  const values = [0, -1, -1, 1, 1, 0];
  let look = 0;
  for (let i = 0; i < times.length - 1; i++) {
    if (frame >= times[i] && frame < times[i + 1]) {
      look =
        values[i] +
        (values[i + 1] - values[i]) *
          smooth((frame - times[i]) / (times[i + 1] - times[i]));
    }
  }
  return { joined, orbit: ((merge + split) * 1080) % 360, look };
};
