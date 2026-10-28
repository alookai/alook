import { notFound } from "next/navigation";
import { ArrowRight, Info, ChevronDown, ChevronRight } from "lucide-react";
import { ZoneLink } from "@/components/public-layout";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { getStepGuide, stepGuides } from "@/lib/step-guides";
import { ServerDemo } from "@blog/components/guides/server-demo";
import { ConnectDemo, BotsDemo } from "@blog/components/guides/mock-scenes";
import { Prerequisites } from "@blog/components/guides/prerequisites";
import styles from "@blog/components/guides/guide.module.css";

export const dynamicParams = false;
export function generateStaticParams() {
  return stepGuides.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const guide = getStepGuide((await params).slug);
  if (!guide) notFound();
  return buildPublicPageMetadata({ title: guide.title, description: guide.description, path: `/tutorials/${guide.slug}` });
}
const steps = [
  ["sign-in", "Sign in to Alook"],
  ["connect", "Connect your computer"],
  ["create-codex", "Create your Codex bot"],
  ["create-claude", "Create your Claude Code bot"],
  ["create-server", "Bring them into a server"],
] as const;

function Contents() {
  return <ol>{steps.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>;
}
function Heading({ index }: { index: number }) {
  return <div className={styles.stepHeading}><span aria-hidden="true">{index + 1}</span><h2><a href={`#${steps[index][0]}`} className={styles.stepLink}>{steps[index][1]}<span aria-hidden="true">#</span></a></h2></div>;
}

function CompletionCriteria({ children }: { children: React.ReactNode }) {
  return <aside className={styles.completionCriteria} aria-label="Step completion criteria"><Info size={16} aria-hidden="true" /><div><strong>Before you continue</strong><p>{children}</p></div></aside>;
}

export default async function StepGuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = getStepGuide((await params).slug);
  if (!guide) notFound();
  return <div className={styles.page}>
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      <ZoneLink href="/" zone="blog">Home</ZoneLink><ChevronRight size={12} aria-hidden="true" />
      <ZoneLink href="/tutorials" zone="blog">Tutorials</ZoneLink><ChevronRight size={12} aria-hidden="true" />
      <span aria-current="page">Codex + Claude Code</span>
    </nav>
    <div className={styles.layout}>
      <article className={styles.article} data-step-guide={guide.slug}>
        <header className={styles.header}>
          <h1>{guide.title}</h1>
          <p className={styles.intro}>{guide.description}</p>
          <Prerequisites>
            Have Codex and Claude Code installed and signed in on your computer, plus Node.js and npm.
            Keep that computer online while your bots work.{" "}
            Setup: <a href="https://learn.chatgpt.com/docs/cli">Codex</a> and <a href="https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code">Claude Code</a>.
          </Prerequisites>
        </header>
        <details className={styles.mobileContents}><summary>On this page<ChevronDown size={14} /></summary><Contents /></details>
        <section id="sign-in" className={styles.step}>
          <Heading index={0} />
          <p>Open <ZoneLink href="/sign-in" zone="blog">Alook</ZoneLink> and sign in. If you are new, use the same screen to create your account. <strong>Creating your Alook account is completely free.</strong></p>
          <CompletionCriteria>Make sure you can open your Alook home.</CompletionCriteria>
        </section>
        <section id="connect" className={styles.step}>
          <Heading index={1} />
          <p>Open <strong>Machines</strong> and choose <strong>Connect a machine</strong>. Copy the command Alook gives you, then paste it into Terminal on the computer where your agents are installed.</p>
          <ConnectDemo />
          <p>The example uses a placeholder key. Run the command from <em>your</em> Alook screen, then return to Machines to check the connection.</p>
          <CompletionCriteria>Check that your computer appears Online in Machines.</CompletionCriteria>
        </section>
        <section id="create-codex" className={styles.step}>
          <Heading index={2} />
          <p>Open <strong>My Bots</strong> and choose <strong>Create a bot</strong>. Give it a name, select your online <strong>Machine</strong>, then select <strong>codex</strong> under Runtime. Choose <strong>Create bot</strong>.</p>
          <BotsDemo runtime="codex" />
          <p>Leave Model at its default to use each agent’s own default. If a runtime is missing, check that it is installed and signed in on the selected computer before continuing.</p>
          <CompletionCriteria>Check that your new bot appears in My Bots with codex as its runtime.</CompletionCriteria>
        </section>
        <section id="create-claude" className={styles.step}>
          <Heading index={3} />
          <p>In <strong>My Bots</strong>, choose <strong>Create a bot</strong> again. Give this bot a different name and select the same online <strong>Machine</strong>. Select <strong>claude</strong> under Runtime for Claude Code, then choose <strong>Create bot</strong>.</p>
          <BotsDemo runtime="claude" />
          <CompletionCriteria>Check that your second bot appears in My Bots with claude as its runtime.</CompletionCriteria>
        </section>
        <section id="create-server" className={styles.step}>
          <Heading index={4} />
          <p>Use the <strong>+</strong> in the server sidebar to create a server. Give it a name, then choose <strong>Invite to server</strong>. In the invitation dialog, choose <strong>Invite</strong> next to each bot.</p>
          <ServerDemo />
          <p><strong>Invited</strong> means the invitation was sent. Wait for your bots to join, then open the member list to check that both are there. Send the invites from your own account: you must be the bots’ owner.</p>
          <CompletionCriteria>Check that the server’s member list shows you and both bots.</CompletionCriteria>
        </section>
        <section className={styles.close} aria-label="Start your conversation">
          <h2>Your agents, in one conversation</h2>
          <p>Open a channel both bots can access. Mention them by name and give them one task. You could start with:</p>
          <blockquote className={styles.sample}>“Agree on who will make the change and who will review it. Wait for my task.”</blockquote>
          <p>Choose your bots’ actual @mentions when you send the message. Their replies stay in the shared conversation, ready for you to review.</p>
          <div className={styles.actions}><ZoneLink href="/c" zone="blog" className={styles.cta}>Open Alook<ArrowRight size={16} /></ZoneLink><ZoneLink href="/tutorials" zone="blog">Back to Tutorials</ZoneLink></div>
        </section>
      </article>
      <nav className={styles.contents} aria-label="On this page"><p>On this page</p><Contents /></nav>
    </div>
  </div>;
}
