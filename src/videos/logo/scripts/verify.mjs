import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const repositoryRoot = resolve(projectRoot, "../../..");
const canonicalLogo = resolve(repositoryRoot, "assets/alook.svg");
const bundledLogo = resolve(projectRoot, "public/alook.svg");
if (!existsSync(canonicalLogo)) {
  throw new Error(`Canonical Alook logo not found at ${canonicalLogo}`);
}
if (sha256(canonicalLogo) !== sha256(bundledLogo)) {
  throw new Error("Bundled Alook SVG differs from assets/alook.svg");
}

const finalFrame = resolve(projectRoot, "out/final-frame.png");
const referenceFrame = resolve(projectRoot, "out/reference-frame.png");
if (sha256(finalFrame) !== sha256(referenceFrame)) {
  throw new Error("Frame 299 differs from the canonical-logo reference render");
}

const firstFrame = resolve(projectRoot, "out/first-frame.png");
const firstFrameAlpha = execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    firstFrame,
    "-vf",
    "alphaextract",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ],
  { maxBuffer: 2 * 1024 * 1024 },
);
if (firstFrameAlpha.some((value) => value !== 0)) {
  throw new Error("Frame 0 must be fully transparent");
}

const probe = (file) =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,nb_frames",
        "-of",
        "json",
        resolve(projectRoot, file),
      ],
      { encoding: "utf8" },
    ),
  );

const assertVideo = (file, codec, pixelFormat) => {
  const metadata = probe(file);
  const [video] = metadata.streams;
  if (metadata.streams.length !== 1 || video.codec_type !== "video") {
    throw new Error(
      `${file} must contain one video stream and no silent audio track`,
    );
  }
  if (
    video.codec_name !== codec ||
    video.pix_fmt !== pixelFormat ||
    video.width !== 1080 ||
    video.height !== 1080 ||
    video.r_frame_rate !== "60/1" ||
    video.nb_frames !== "300" ||
    metadata.format.duration !== "5.000000"
  ) {
    throw new Error(
      `${file} metadata does not match the 1080×1080, 60 fps, 5s contract`,
    );
  }
};

assertVideo("out/alook-logo-official.mp4", "h264", "yuv420p");

console.log(
  "Verified empty first frame, canonical final frame, and 300-frame MP4 duration.",
);
