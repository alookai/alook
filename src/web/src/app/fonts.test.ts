import { describe, expect, it, vi } from "vitest"

const { localFont } = vi.hoisted(() => ({
  localFont: vi.fn((options: { variable: string }) => ({
    className: options.variable,
    style: { fontFamily: options.variable },
    variable: options.variable,
  })),
}))

vi.mock("next/font/local", () => ({ default: localFont }))

import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "./fonts"

describe("local font configuration", () => {
  it("loads every design font from committed assets", () => {
    expect(localFont.mock.calls.map(([options]) => options)).toEqual([
      {
        src: "./fonts/dm-sans-latin.woff2",
        variable: "--font-dm-sans",
        weight: "400 900",
        style: "normal",
        display: "swap",
      },
      {
        src: "./fonts/dm-mono-latin-400.woff2",
        variable: "--font-dm-mono",
        weight: "400",
        style: "normal",
        display: "swap",
      },
      {
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
      },
      {
        src: "./fonts/caveat-latin.woff2",
        variable: "--font-caveat",
        weight: "400 700",
        style: "normal",
        display: "swap",
      },
      {
        src: "./fonts/vt323-latin-400.woff2",
        variable: "--font-vt323",
        weight: "400",
        style: "normal",
        display: "swap",
      },
      {
        src: "./fonts/literata-latin.woff2",
        variable: "--font-literata",
        weight: "400 600",
        style: "normal",
        display: "swap",
      },
    ])
    expect([dmSans, dmMono, instrumentSerif, caveat, vt323, literata].map(font => font.variable)).toEqual([
      "--font-dm-sans",
      "--font-dm-mono",
      "--font-instrument-serif",
      "--font-caveat",
      "--font-vt323",
      "--font-literata",
    ])
  })
})
