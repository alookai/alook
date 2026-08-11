import localFont from "next/font/local";

export const dmSans = localFont({
  src: "./fonts/dm-sans-latin.woff2",
  variable: "--font-dm-sans",
  weight: "400 900",
  style: "normal",
  display: "swap",
});

export const dmMono = localFont({
  src: "./fonts/dm-mono-latin-400.woff2",
  variable: "--font-dm-mono",
  weight: "400",
  style: "normal",
  display: "swap",
});

export const instrumentSerif = localFont({
  src: [
    {
      path: "./fonts/instrument-serif-latin-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/instrument-serif-latin-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const caveat = localFont({
  src: "./fonts/caveat-latin.woff2",
  variable: "--font-caveat",
  weight: "400 700",
  style: "normal",
  display: "swap",
});

export const vt323 = localFont({
  src: "./fonts/vt323-latin-400.woff2",
  variable: "--font-vt323",
  weight: "400",
  style: "normal",
  display: "swap",
});

export const literata = localFont({
  src: "./fonts/literata-latin.woff2",
  variable: "--font-literata",
  weight: "400 600",
  style: "normal",
  display: "swap",
});
