import React from "react";
export default function Link({
  children,
  prefetch,
  replace,
  scroll,
  ...props
}: any) {
  return <a {...props}>{children}</a>;
}
