"use client";

import { useRef, useEffect, useState } from "react";
import { useTheme } from "next-themes";

interface EmailBodyFrameProps {
  html: string;
  className?: string;
}

const SCROLLBAR_STYLES = `
  html {
    scrollbar-width: thin;
    scrollbar-color: var(--sb-thumb, rgba(0,0,0,0.15)) transparent;
  }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--sb-thumb, rgba(0,0,0,0.15)); border-radius: 2px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--sb-hover, rgba(0,0,0,0.3)); }
`;

const LIGHT_STYLES = `
  html, body {
    --sb-thumb: rgba(0,0,0,0.15);
    --sb-hover: rgba(0,0,0,0.3);
    margin: 0;
    padding: 0;
    background: transparent;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  a { color: inherit; }
  img { max-width: 100%; height: auto; }
`;

const DARK_STYLES = `
  html, body {
    --sb-thumb: rgba(255,255,255,0.1);
    --sb-hover: rgba(255,255,255,0.25);
    margin: 0;
    padding: 0;
    background: transparent;
    color: #e8e5e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: break-word;
    color-scheme: dark;
  }
  a { color: inherit; }
  img { max-width: 100%; height: auto; }
  /* Force dark-friendly defaults on common email patterns */
  body, div, td, th, p, span, li {
    color: #e8e5e0 !important;
  }
  table, tr, td, th, div, section, article, header, footer, main {
    background-color: transparent !important;
    border-color: rgba(255, 255, 255, 0.1) !important;
  }
  /* Preserve image backgrounds (logos, etc) */
  img { background-color: transparent !important; }
  h1, h2, h3, h4, h5, h6 {
    color: #f0ede8 !important;
  }
  a { color: #93b5ff !important; }
`;

export function buildSrcDoc(html: string, isDark: boolean): string {
  const styles = isDark ? DARK_STYLES : LIGHT_STYLES;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="${isDark ? "dark" : "light"}">
  <style>${SCROLLBAR_STYLES}${styles}</style>
</head>
<body>${html}</body>
</html>`;
}

export function EmailBodyFrame({ html, className }: EmailBodyFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { resolvedTheme } = useTheme();
  const [height, setHeight] = useState(200);
  const isDark = resolvedTheme === "dark";

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let ro: ResizeObserver | null = null;

    iframe.srcdoc = buildSrcDoc(html, isDark);

    const onLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      const updateHeight = () => {
        const h = doc.documentElement.scrollHeight;
        if (h > 0) setHeight(h);
      };

      updateHeight();

      ro = new ResizeObserver(updateHeight);
      ro.observe(doc.documentElement);
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [html, isDark]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      className={className}
      style={{ width: "100%", height: `${height}px`, border: "none", display: "block" }}
      title="Email content"
    />
  );
}
