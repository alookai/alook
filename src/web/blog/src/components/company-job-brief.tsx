import type { ReactNode } from "react";
import styles from "./company-job-brief.module.css";
export function CompanyJobBrief({children}:{children:ReactNode}){return <div className={`${styles.frame} ${styles.frame}`}>{children}</div>;}
