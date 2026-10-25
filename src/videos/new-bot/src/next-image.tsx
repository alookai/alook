import React from "react";
import { Img } from "remotion";
export default function Image({
  src,
  alt = "",
  fill,
  priority,
  unoptimized,
  loader,
  quality,
  sizes,
  ...props
}: any) {
  return (
    <Img src={typeof src === "string" ? src : src.src} alt={alt} {...props} />
  );
}
