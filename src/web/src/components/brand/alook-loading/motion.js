export const DURATION = 540;
export const REDUCED_MOTION_FRAME = 0;

/** @param {number} value */
export const smooth = (value) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** @param {number} frame */
export const motionAt = (frame) => {
  const split = smooth((frame - 60) / 144);
  const merge = smooth((frame - 366) / 144);
  const joined = 1 - split + merge;
  const times = [204, 240, 270, 306, 342, 366];
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
  return { joined, orbit: ((split + merge) * 1080) % 360, look };
};
