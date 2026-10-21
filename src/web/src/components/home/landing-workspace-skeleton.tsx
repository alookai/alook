import { Skeleton } from "@/components/ui/skeleton"
import styles from "./landing-interactive-shell.module.css"

export function LandingWorkspaceSkeleton() {
  return <div className={styles.workspaceSkeleton} role="status" aria-label="Loading Alook workspace">
    <div className={styles.skeletonLayout} aria-hidden="true">
      <div className={styles.skeletonRail}>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="size-9 rounded-xl" />)}
      </div>
      <div className={styles.skeletonSidebar}>
        <div className={styles.skeletonHeader}><Skeleton className="h-4 w-28" /></div>
        <div className={styles.skeletonChannels}>
          <Skeleton className="mb-4 h-3 w-16" />
          {[70, 88, 62, 76].map((width) => <div className={styles.skeletonChannel} key={width}><Skeleton className="size-4" /><Skeleton style={{width: `${width}%`}} className="h-3" /></div>)}
        </div>
      </div>
      <div className={styles.skeletonUser}><div className={styles.skeletonUserInner}>
        <Skeleton className="size-7 shrink-0 rounded-full bg-background/60" />
        <Skeleton className="h-3 min-w-0 flex-1 bg-background/60" />
        <Skeleton className={styles.skeletonUserAction} /><Skeleton className={styles.skeletonUserAction} />
      </div></div>
      <div className={styles.skeletonChat}>
        <div className={styles.skeletonHeader}><Skeleton className="size-5" /><Skeleton className="h-4 w-24" /></div>
        <div className={styles.skeletonMessages}>
          {[78, 62, 86].map((width) => <div className={styles.skeletonMessage} key={width}><Skeleton className="size-8 shrink-0 rounded-full" /><div className={styles.skeletonMessageText}><Skeleton className="mb-3 h-3 w-24" /><Skeleton className="mb-2 h-3" style={{width:`${width}%`}} /><Skeleton className="h-3" style={{width:`${width-22}%`}} /></div></div>)}
        </div>
        <div className={styles.skeletonComposer}><Skeleton className="h-12 w-full rounded-xl" /></div>
      </div>
    </div>
  </div>
}
