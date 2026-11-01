import type { ReactNode } from "react";
import styles from "./guide.module.css";

export function Prerequisites({ children }: { children: ReactNode }) {
  return <aside className={styles.prerequisites} aria-label="Before you begin">
    <strong>Before you begin</strong>
    <div>{children}</div>
  </aside>;
}
