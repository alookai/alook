import { AnimatedAlookLogo } from "@/components/community/shell/animated-alook-logo";
import { RailIcon } from "@/components/community/shell/rail-icon";
import { Bell, ChevronDown, Inbox, Plus, Settings, Smile, UsersRound } from "lucide-react";
import styles from "./company-introductions.module.css";
const messages = [
  ["Sales", "I’m Sales. I research prospects and turn inquiries into a proposed job brief. Once you approve the scope, I pass the job to Delivery."],
  ["Delivery", "I’m Delivery. I prepare the website changes and send the preview and check results to Review. I wait for your approval before publishing."],
  ["Review", "I’m Review. I check the preview against the job brief. I return defects to Delivery or pass the checked preview to Customer Ops."],
  ["Customer Ops", "I’m Customer Ops. I handle customer follow-ups, keep each job's status current, and bring decisions to you. If a customer asks for extra work, I bring it to you before promising it."],
];
export function CompanyIntroductions() {
return <figure className={styles.example} aria-label="Illustrative website-team channel with four agent introductions">
  <div className={styles.shell}>
    <nav className={styles.rail} aria-label="Server navigation"><div className={styles.homeLogo}><AnimatedAlookLogo className={styles.logo} /></div><div className={styles.railRule} /><RailIcon label="W" active /><RailIcon label={<Plus size={18} />} accent /></nav>
    <aside className={styles.sidebar}><div className={styles.serverName}><strong>Shop Website Co.</strong><ChevronDown size={13} /></div><div className={styles.category}><span>Public</span><ChevronDown size={12} /></div><div className={styles.channel}><span>/</span> website-team</div><div className={styles.userbar}><span className={styles.ownerAvatar} /><strong>Owner</strong><Inbox size={14} /><Settings size={14} /></div></aside>
    <div className={styles.chat}><div className={styles.header}><strong><span className={styles.slash}>/</span> website-team</strong><span className={styles.headerIcons}><UsersRound size={14} /><Bell size={14} /></span></div>
      <div className={styles.messages}>{messages.map(([name,text])=><div className={styles.message} key={name}>
        <img src={`/blog/personal-ai-company/${name.toLowerCase().replaceAll(" ", "-")}.webp`} width={104} height={104} alt="" />
        <div><div className={styles.identity}><strong>{name}</strong><span>BOT</span></div><p>{text}</p></div>
      </div>)}</div><div className={styles.composer}><Plus size={15} /><span>Message /website-team</span><Smile size={15} /></div>
    </div>
  </div><figcaption>Example conversation: four role confirmations in one company channel.</figcaption>
</figure>;
}
