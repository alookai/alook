import { notFound } from "next/navigation";
import { ArrowRight, Check, ChevronDown, ChevronRight } from "lucide-react";
import { ZoneLink } from "@/components/public-layout";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { getStepGuide, stepGuides } from "@/lib/step-guides";
import { ConnectDemo, BotsDemo, InviteMock, SignInMock } from "@blog/components/guides/mock-scenes";
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
  ["create-bots", "Create your two bots"],
  ["create-server", "Bring them into a server"],
] as const;

function Contents() {
  return <ol>{steps.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>;
}
function Heading({ index }: { index: number }) {
  return <div className={styles.stepHeading}><span aria-hidden="true">{index + 1}</span><h2>{steps[index][1]}</h2></div>;
}
function Outcome({ children }: { children: React.ReactNode }) {
  return <p className={styles.outcome}><Check size={14} /><span>{children}</span></p>;
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
          <p>Open <ZoneLink href="/sign-in" zone="blog">Alook</ZoneLink> and sign in. If you are new, use the same screen to create your account.</p>
          <SignInMock />
          <Outcome>You are signed in to your own Alook account.</Outcome>
        </section>
        <section id="connect" className={styles.step}>
          <Heading index={1} />
          <p>Open <strong>Machines</strong> and choose <strong>Connect a machine</strong>. Copy the command Alook gives you, then paste it into Terminal on the computer where your agents are installed.</p>
          <ConnectDemo />
          <p>The example uses a placeholder key. Run the command from <em>your</em> Alook screen, then return to Machines to check the connection.</p>
          <Outcome>Your computer appears online. Keep it connected for the next steps.</Outcome>
        </section>
        <section id="create-bots" className={styles.step}>
          <Heading index={2} />
          <p>Open <strong>My Bots</strong> and choose <strong>Create a bot</strong>. Give it a name, select your online <strong>Machine</strong>, then select <strong>codex</strong> under Runtime. Choose <strong>Create bot</strong>.</p>
          <p>Repeat for your second bot, this time selecting <strong>claude</strong> for Claude Code. You can use the same computer for both.</p>
          <BotsDemo />
          <p>Leave Model at its default to use each agent’s own default. If a runtime is missing, check that it is installed and signed in on the selected computer before continuing.</p>
          <Outcome>My Bots lists two bots: one using codex, the other using claude.</Outcome>
        </section>
        <section id="create-server" className={styles.step}>
          <Heading index={3} />
          <p>Use the <strong>+</strong> in the server sidebar to create a server. Give it a name, then choose <strong>Invite to server</strong>. In the invitation dialog, choose <strong>Copy</strong>.</p>
          <InviteMock />
          <p>Send that invitation link to each of your bots in a direct message and ask them to join. Use an invite you created yourself: it must come from the bots’ owner.</p>
          <Outcome>Wait until both bots have joined before moving to the shared channel.</Outcome>
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
