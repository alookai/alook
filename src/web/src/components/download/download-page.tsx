/* eslint-disable @next/next/no-html-link-for-pages -- Product entrances require a new document to unload public tracking. */

import Image from "next/image"
import { ArrowDown, ArrowUpRight, Globe, Monitor, Smartphone } from "lucide-react"
import { SiApple, SiLinux, SiAndroid, SiGoogleplay } from "@icons-pack/react-simple-icons"
import { PublicSiteHeader } from "@/components/home/public-site-header"
import { LandingFooter } from "@/components/home/landing-footer"
import { LandingReachMotion } from "@/components/home/landing-reach-motion"
import { DeferredMobileChatMotion, DeferredShellMotion } from "@/components/home/deferred-landing-media"
import { SCENE_MAX_BEAT } from "@/components/home/landing-shell-motion-timeline"
import { DOWNLOAD_TARGETS, IOS_TESTFLIGHT_URL, type DownloadEnvironment } from "@/lib/download-platforms"
import { ALOOK_RELEASES_URL, type DownloadCatalog } from "@/lib/download-catalog"
import { DownloadCurrentPlatform } from "./download-current-platform"
import landing from "@/components/home/landing-page.module.css"
import styles from "./download-page.module.css"
import { buttonVariants } from "@/components/ui/button"
import { HandAccent } from "@/components/brand/hand-accent"

const PRIMARY = buttonVariants({ size: "lg" }) + " h-12 px-5 text-sm"
const SECONDARY = buttonVariants({ size: "lg", variant: "secondary" }) + " h-12 px-5 text-sm"

function InstallerChoices({ platform, catalog }: { platform: "macos" | "windows" | "linux" | "android"; catalog: DownloadCatalog }) {
  return <ul className={styles.installers}>
    {DOWNLOAD_TARGETS.filter(target => target.platform === platform).map(target => {
      const installer = catalog.installers.find(item => item.id === target.id)
      return <li key={target.id}>
        {installer ? <a href={installer.url} className={styles.installer}>
          <span><strong>{target.label}</strong><small>{target.format} · v{installer.version} · {(installer.bytes / 1_000_000).toFixed(1)} MB</small></span>
          <ArrowDown size={18} aria-hidden="true" />
        </a> : <span className={styles.unavailable}><strong>{target.label} · {target.format}</strong><small>Not available right now</small></span>}
      </li>
    })}
  </ul>
}

export function DownloadPageView({ catalog, initialEnvironment }: { catalog: DownloadCatalog; initialEnvironment?: DownloadEnvironment }) {
  return <div className={`landing ${landing.page} ${styles.page}`}>
    <PublicSiteHeader currentPath="/download" />
    <main>
      <section className={`${landing.siteContainer} ${styles.hero}`} aria-labelledby="download-heading">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Alook, wherever you are</p>
          <h1 id="download-heading">Good company.<br />On every <HandAccent>screen.</HandAccent></h1>
          <p className={styles.intro}>Your team, friends and agents. One shared place, from your desk to your pocket.</p>
          <div className={styles.heroActions}><DownloadCurrentPlatform installers={catalog.installers} initialEnvironment={initialEnvironment} /><a data-variant="secondary" className={SECONDARY} href="/c/me"><Globe size={18} aria-hidden="true" />Open in your browser<ArrowUpRight size={16} aria-hidden="true" /></a></div>
          <a className={styles.textLink} href="#desktop">See all platforms <ArrowDown size={14} aria-hidden="true" /></a>
        </div>
        <div className={styles.heroMedia} role="group" aria-label="Alook on desktop and mobile"><div className={styles.characters} aria-hidden="true">{["purple", "teal", "red", "blue"].map(color => <Image key={color} src={`/download/character-${color}.svg`} width={80} height={80} alt="" />)}</div><LandingReachMotion /></div>
      </section>

      <section id="desktop" className={styles.desktop} aria-labelledby="desktop-heading">
        <div className={landing.siteContainer}>
          <div className={styles.sectionLead}><p className={styles.eyebrow}><Monitor size={16} aria-hidden="true" />At your desk</p><h2 id="desktop-heading">Make room for your whole <HandAccent>team.</HandAccent></h2><p>Keep the conversation close. Connect your computer when you’re ready to bring your agents along.</p></div>
          <div className={styles.desktopBody}>
            <div className={styles.desktopMedia} role="img" aria-label="Alook’s existing Machines view with connected computers and agent runtimes"><DeferredShellMotion scene="machine" beat={SCENE_MAX_BEAT.machine} /></div>
            <div className={styles.platformList}>
              <details className={styles.platform} id="macos" open><summary><SiApple size={23} aria-hidden="true" /><h3>macOS</h3><span>Choose your chip</span></summary><InstallerChoices platform="macos" catalog={catalog} /></details>
              <details className={styles.platform} id="windows" open><summary><Monitor size={23} aria-hidden="true" /><h3>Windows</h3><span>x64</span></summary><InstallerChoices platform="windows" catalog={catalog} /></details>
              <details className={styles.platform} id="linux" open><summary><SiLinux size={23} aria-hidden="true" /><h3>Linux</h3><span>x64</span></summary><InstallerChoices platform="linux" catalog={catalog} /></details>
            </div>
          </div>
          <p className={styles.releaseNote}>{catalog.unavailable ? "We couldn’t load the download list. " : "Looking for a different release? "}<a href={ALOOK_RELEASES_URL}>View releases on GitHub <ArrowUpRight size={14} aria-hidden="true" /></a></p>
        </div>
      </section>

      <section id="mobile" className={`${landing.siteContainer} ${styles.mobile}`} aria-labelledby="mobile-heading">
        <div className={styles.phoneMedia} role="img" aria-label="Alook’s existing mobile conversation view"><DeferredMobileChatMotion beat={SCENE_MAX_BEAT.server} /></div>
        <div className={styles.mobileCopy}>
          <p className={styles.eyebrow}><Smartphone size={16} aria-hidden="true" />Out and about</p>
          <h2 id="mobile-heading">The conversation comes <HandAccent>with you.</HandAccent></h2>
          <p>Check in with your people and agents, pick up a conversation, and stay in the loop from your phone.</p>
          <div className={styles.stores} role="group" aria-label="Store availability">
            <span className={styles.store}><SiApple size={24} aria-hidden="true" /><span>App Store<small>Coming soon</small></span></span>
            <span className={styles.store}><SiGoogleplay size={24} aria-hidden="true" /><span>Google Play<small>Coming soon</small></span></span>
          </div>
          <div className={styles.mobileDownload}><h3><Image src="/download/testflight.png" width={21} height={21} alt="" />TestFlight</h3><ul className={styles.installers}><li><a className={styles.installer} href={IOS_TESTFLIGHT_URL}><span><strong>iPhone &amp; iPad</strong><small>Public beta</small></span><ArrowUpRight size={18} aria-hidden="true" /></a></li></ul></div>
          <div id="android" className={styles.mobileDownload}><h3><SiAndroid size={21} aria-hidden="true" />Android APK</h3><InstallerChoices platform="android" catalog={catalog} /></div>
        </div>
      </section>

      <section className={styles.browser} aria-labelledby="browser-heading"><div className={landing.siteContainer}><p className={styles.eyebrow}>No installation needed</p><h2 id="browser-heading">A tab is all it <HandAccent>takes.</HandAccent></h2><p>Open Alook in your browser. Your conversations are already at home.</p><a data-variant="default" className={PRIMARY} href="/c/me">Open Alook<ArrowUpRight size={18} aria-hidden="true" /></a><a className={styles.textLink} href="https://alook.ai/c/invite/nC7ax53lwm">Need a hand? Get in touch.</a></div></section>
    </main>
    <LandingFooter />
  </div>
}
