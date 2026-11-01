import { requiresExplicitModel } from "@alook/shared";
import Image from "next/image";
import { ProviderLogo } from "@/components/provider-logo";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { ZoneLink } from "@/components/public-layout";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { getStepGuide, stepGuides, tutorialAgents, type TutorialPair } from "@/lib/step-guides";
import { MessageDemo } from "@blog/components/guides/message-demo";
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
function guideSteps(agents: TutorialPair) {
  return [
    ["sign-in", "Sign in to Alook"],
    ["connect", "Connect your computer"],
    [`create-${agents[0]}`, `Create your ${tutorialAgents[agents[0]].name} bot`],
    [`create-${agents[1]}`, `Create your ${tutorialAgents[agents[1]].name} bot`],
    ["create-server", "Bring them into a server"],
    ["send-message", "Send your first message"],
  ] as const;
}

type Steps = ReturnType<typeof guideSteps>;
function Contents({ steps }: { steps: Steps }) {
  return <ol>{steps.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>;
}
function Heading({ index, steps }: { index: number; steps: Steps }) {
  return <div className={styles.stepHeading}><span aria-hidden="true">{index + 1}</span><h2><a href={`#${steps[index][0]}`} className={styles.stepLink}>{steps[index][1]}<span aria-hidden="true">#</span></a></h2></div>;
}

function CompletionCriteria({ children }: { children: React.ReactNode }) {
  return <aside className={styles.completionCriteria} aria-label="Step completion criteria"><span aria-hidden="true">👌</span><p><strong>Before you continue,</strong> {children}</p></aside>;
}

export default async function StepGuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = getStepGuide((await params).slug);
  if (!guide) notFound();
  const [first, second] = guide.agents;
  const firstAgent = tutorialAgents[first];
  const secondAgent = tutorialAgents[second];
  const steps = guideSteps(guide.agents);
  return <div className={styles.page}>
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      <ZoneLink href="/" zone="blog">Home</ZoneLink><ChevronRight size={12} aria-hidden="true" />
      <ZoneLink href="/tutorials" zone="blog">Tutorials</ZoneLink><ChevronRight size={12} aria-hidden="true" />
      <span aria-current="page">{firstAgent.name} + {secondAgent.name}</span>
    </nav>
    <div className={styles.layout}>
      <article className={styles.article} data-step-guide={guide.slug}>
        <header className={styles.header}>
          <h1>Use <span className={styles.titleProduct}><span aria-hidden="true"><ProviderLogo provider={first} className={styles.titleIcon} /></span>{firstAgent.name}</span> and <span className={styles.titleProduct}><span aria-hidden="true"><ProviderLogo provider={second} className={styles.titleIcon} /></span>{secondAgent.name}</span> together in <span className={styles.titleProduct}><Image src="/alook.svg" alt="" width={36} height={36} className={styles.titleIcon} /><span className={styles.titleBrand}>Alook</span></span></h1>
          <p className={styles.intro}>{guide.description}</p>
          <Prerequisites>
            {firstAgent.preparation} {secondAgent.preparation} Have Node.js and npm installed too.
            Keep that computer online while your bots work.{" "}
            Setup: <a href={firstAgent.setupUrl}>{firstAgent.setupName}</a> and <a href={secondAgent.setupUrl}>{secondAgent.setupName}</a>.
          </Prerequisites>
        </header>
        <details className={styles.mobileContents}><summary>On this page<ChevronDown size={14} /></summary><Contents steps={steps} /></details>
        <section id="sign-in" className={styles.step}>
          <Heading index={0} steps={steps} />
          <p>Open <ZoneLink href="/sign-in" zone="blog">Alook</ZoneLink> and sign in. If you are new, use the same screen to create your account. <strong>Creating your Alook account is completely free.</strong></p>
          <CompletionCriteria>make sure you can open your <ZoneLink href="/c/me" zone="blog">Alook home</ZoneLink>.</CompletionCriteria>
        </section>
        <section id="connect" className={styles.step}>
          <Heading index={1} steps={steps} />
          <p>{guide.connectLead} Open <ZoneLink href="/c/me/machines" zone="blog">Machines</ZoneLink> and choose <strong>Connect a machine</strong>. Copy the command Alook gives you, then paste it into Terminal on the computer where your agents are installed.</p>
          <ConnectDemo agents={guide.agents} />
          <p>The example uses a placeholder key. Run the command from <em>your</em> Alook screen, then return to <ZoneLink href="/c/me/machines" zone="blog">Machines</ZoneLink> to check the connection.</p>
          <CompletionCriteria>check that your computer appears Online in <ZoneLink href="/c/me/machines" zone="blog">Machines</ZoneLink>.</CompletionCriteria>
        </section>
        <section id={steps[2][0]} className={styles.step}>
          <Heading index={2} steps={steps} />
          <p>{guide.firstBotLead} Open <ZoneLink href="/c/me/bots" zone="blog">My Bots</ZoneLink> and choose <strong>Create a bot</strong>. Give it a name, select your online <strong>Machine</strong>, then select <strong>{first}</strong> under Runtime. {requiresExplicitModel(first) && <>Choose a model from your configured provider under <strong>Model</strong>. </>}Choose <strong>Create bot</strong>.</p>
          <BotsDemo runtime={first} agents={guide.agents} />
          <p>{requiresExplicitModel(first) ? "OpenCode requires a model. The animation uses provider/model-id as a placeholder; select a model available in your own OpenCode configuration." : "Leave Model at its default to use the agent’s own default."} If a runtime is missing, check that it is installed and ready to run on the selected computer before continuing.</p>
          <CompletionCriteria>check that your new bot appears in <ZoneLink href="/c/me/bots" zone="blog">My Bots</ZoneLink> with {first} as its runtime.</CompletionCriteria>
        </section>
        <section id={steps[3][0]} className={styles.step}>
          <Heading index={3} steps={steps} />
          <p>{guide.secondBotLead} In <ZoneLink href="/c/me/bots" zone="blog">My Bots</ZoneLink>, choose <strong>Create a bot</strong> again. Give this bot a different name and select the same online <strong>Machine</strong>. Select <strong>{second}</strong> under Runtime for {secondAgent.name}, then choose <strong>Create bot</strong>.</p>
          <BotsDemo runtime={second} agents={guide.agents} />
          <CompletionCriteria>check that your second bot appears in <ZoneLink href="/c/me/bots" zone="blog">My Bots</ZoneLink> with {second} as its runtime.</CompletionCriteria>
        </section>
        <section id="create-server" className={styles.step}>
          <Heading index={4} steps={steps} />
          <p>{guide.serverLead} Use the <strong>+</strong> in the server sidebar to create a server. Give it a name, then choose <strong>Invite to server</strong>. In the invitation dialog, choose <strong>Invite</strong> next to each bot.</p>
          <ServerDemo agents={guide.agents} />
          <p><strong>Invited</strong> means the invitation was sent. Wait for your bots to join, then open the member list to check that both are there. Send the invites from your own account: you must be the bots’ owner.</p>
          <CompletionCriteria>check that the server’s member list shows you and both bots.</CompletionCriteria>
        </section>
        <section id="send-message" className={styles.step}>
          <Heading index={5} steps={steps} />
          <p>{guide.messageLead}</p>
          <p>For example: “Agree on roles, then wait for my task.”</p>
          <MessageDemo />
        </section>
        <section className={styles.close} aria-label="Continue in Alook">
          <div className={styles.actions}><ZoneLink href="/c" zone="blog" className={styles.cta}>Open Alook<ArrowRight size={16} /></ZoneLink><ZoneLink href="/tutorials" zone="blog">Back to Tutorials</ZoneLink></div>
        </section>
      </article>
      <nav className={styles.contents} aria-label="On this page"><p>On this page</p><Contents steps={steps} /></nav>
    </div>
  </div>;
}
