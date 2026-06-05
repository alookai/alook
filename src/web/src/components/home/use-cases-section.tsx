"use client";

import { useId, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Mail, Calendar, FileText, MessageSquare, Check, DollarSign, BarChart3, Bug, Brain } from "lucide-react";
import { DemoPad } from "./demo-pad";

gsap.registerPlugin(ScrollTrigger);

/* ─────────────────────────────────────────────
   Sequential animation wrapper
   ───────────────────────────────────────────── */

function AnimatedItem({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <div
      className="usecase-anim-item"
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────
   Demo UI Primitives (matching real product)
   ───────────────────────────────────────────── */

interface AvatarConfig {
  gradient: [string, string, string];
  faceColor: string;
  shape: "circle" | "rounded" | "hexagon" | "mail" | "book";
}

const AGENT_AVATARS: Record<string, AvatarConfig> = {
  A: { gradient: ["#5eead4", "#14b8a6", "#0d9488"], faceColor: "#134e4a", shape: "circle" },
  P: { gradient: ["#a5b4fc", "#6366f1", "#3730a3"], faceColor: "#312e81", shape: "hexagon" },
  C: { gradient: ["#93c5fd", "#3b82f6", "#1d4ed8"], faceColor: "#1e3a5f", shape: "rounded" },
  R: { gradient: ["#fdba74", "#f97316", "#c2410c"], faceColor: "#7c2d12", shape: "book" },
  M: { gradient: ["#fda4af", "#f472b6", "#be185d"], faceColor: "#831843", shape: "mail" },
};

function DemoAvatar({ letter }: { letter: string }) {
  const config = AGENT_AVATARS[letter] || AGENT_AVATARS.A;
  const gradId = useId();

  return (
    <svg viewBox="0 0 200 200" className="size-6 shrink-0 rounded-xl">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={config.gradient[0]} />
          <stop offset="50%" stopColor={config.gradient[1]} />
          <stop offset="100%" stopColor={config.gradient[2]} />
        </linearGradient>
      </defs>
      <rect width="200" height="200" fill={`url(#${gradId})`} />
      {config.shape === "circle" && <circle cx="100" cy="100" r="66" fill="white" stroke="rgba(255,255,255,0.95)" strokeWidth="3.5" />}
      {config.shape === "rounded" && <rect x="30" y="30" width="140" height="140" rx="32" fill="white" stroke="rgba(255,255,255,0.95)" strokeWidth="3.5" />}
      {config.shape === "hexagon" && <path d="M100 32 C108 32 114 35 120 39 L155 60 C161 64 165 70 165 78 L165 122 C165 130 161 136 155 140 L120 161 C114 165 108 168 100 168 C92 168 86 165 80 161 L45 140 C39 136 35 130 35 122 L35 78 C35 70 39 64 45 60 L80 39 C86 35 92 32 100 32 Z" fill="white" stroke="rgba(255,255,255,0.95)" strokeWidth="3.5" />}
      {config.shape === "mail" && <rect x="28" y="54" width="144" height="92" rx="46" fill="white" stroke="rgba(255,255,255,0.95)" strokeWidth="3.5" />}
      {config.shape === "book" && <path d="M42 162 L42 88 C42 54 68 34 100 34 C132 34 158 54 158 88 L158 162 C158 166 154 170 150 170 L50 170 C46 170 42 166 42 162 Z" fill="white" stroke="rgba(255,255,255,0.95)" strokeWidth="3.5" />}
      {/* Simple face: two dots for eyes */}
      <circle cx="82" cy="95" r="6" fill={config.faceColor} />
      <circle cx="118" cy="95" r="6" fill={config.faceColor} />
      <path d="M88 115 Q100 125 112 115" fill="none" stroke={config.faceColor} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function DemoStatusDot({ status }: { status: "online" | "working" }) {
  return (
    <span className={`size-1.5 rounded-full shrink-0 ${status === "working" ? "bg-green-500 animate-pulse" : "bg-green-500"}`} />
  );
}

/* ─────────────────────────────────────────────
   Demo Scene 1: Bug Report → PR Ready
   Email arrives → Agent chat → Issue created → PR reviewed
   ───────────────────────────────────────────── */

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function DemoScene1() {
  return (
    <DemoPad totalSteps={7} stepInterval={2500} loopPause={5000}>
      {({ currentStep, isResetting, showAll, Step }) => (
        <div className="flex flex-col gap-3 p-4 h-full">
          <Step step={0} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">New email from <span className="font-medium text-foreground">user@company.com</span>: &ldquo;Login page crashes on Safari&rdquo;</span>
            </div>
          </Step>

          <Step step={1} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="flex items-start gap-2">
              <DemoAvatar letter="P" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-medium">Planner</span>
                  <DemoStatusDot status="working" />
                </div>
                <div className="text-sm text-foreground">Reproduced it — WebKit flex gap bug in Safari 14. Writing fix plan and emailing Coder.</div>
              </div>
            </div>
          </Step>

          <Step step={2} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Planner → Coder:</span> Replace flex gap with margin-based spacing in login page. See repro + plan attached.</span>
            </div>
          </Step>

          <Step step={3} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="flex items-start gap-2">
              <DemoAvatar letter="C" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-medium">Coder</span>
                  <DemoStatusDot status="working" />
                </div>
                <div className="text-sm text-foreground">Fixed. PR opened. Emailing Reviewer.</div>
              </div>
            </div>
          </Step>

          <Step step={4} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Coder → Reviewer:</span> PR #142 ready. Safari flex gap fix.</span>
            </div>
          </Step>

          <Step step={5} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="flex items-start gap-2">
              <DemoAvatar letter="R" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-medium">Reviewer</span>
                </div>
                <div className="text-sm text-foreground">All tests pass. Approved.</div>
              </div>
            </div>
          </Step>

          <Step step={6} currentStep={currentStep} isResetting={isResetting} showAll={showAll}>
            <div className="rounded-lg border border-border/60 bg-background/75 p-3">
              <div className="flex items-center gap-1.5">
                <GitHubIcon className="size-3.5 shrink-0" />
                <span className="text-xs font-medium">#142 Fix Safari flex gap</span>
                <span className="ml-auto rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600">Approved</span>
              </div>
            </div>
          </Step>
        </div>
      )}
    </DemoPad>
  );
}

/* ─────────────────────────────────────────────
   Demo Scene 2: "Post an update" → Published
   ───────────────────────────────────────────── */

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function DemoScene2() {
  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* User request */}
      <AnimatedItem delay={0}>
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-primary text-primary-foreground text-sm">
            Post something about today&apos;s release
          </div>
        </div>
      </AnimatedItem>

      {/* Marketer thinking */}
      <AnimatedItem delay={400}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="M" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium">Marketer</span>
              <DemoStatusDot status="working" />
            </div>
            <div className="text-sm text-foreground">I need to know what shipped today. Emailing Coder.</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Marketer → Coder email */}
      <AnimatedItem delay={800}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Marketer → Coder:</span> What did we ship today? I need to write a post.</span>
        </div>
      </AnimatedItem>

      {/* Coder → Marketer reply */}
      <AnimatedItem delay={1200}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Coder → Marketer:</span> Shipped calendar recurring events, email forwarding, and 3 bug fixes.</span>
        </div>
      </AnimatedItem>

      {/* Marketer drafts and publishes */}
      <AnimatedItem delay={1600}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="M" />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium">Marketer</span>
            <div className="text-sm text-foreground mt-1">Got it. Drafting and publishing now.</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Result: X post card */}
      <AnimatedItem delay={2000}>
        <div className="rounded-lg border border-border/60 bg-background/75 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <XIcon className="size-3.5 shrink-0" />
            <span className="text-xs font-medium">Posted to X</span>
            <span className="ml-auto text-[10px] text-muted-foreground">Just now</span>
          </div>
          <p className="text-sm text-foreground">&ldquo;Just shipped: recurring calendar events, email forwarding, and squashed 3 bugs. Your AI team never sleeps.&rdquo;</p>
        </div>
      </AnimatedItem>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Demo Scene 3: Monday 8am Briefing
   ───────────────────────────────────────────── */

function DemoScene3() {
  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* Calendar trigger */}
      <AnimatedItem delay={0}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-muted-foreground text-sm px-3 py-2 flex items-center gap-2">
          <Calendar className="h-4 w-4 shrink-0" />
          <span className="text-xs">Calendar event triggered: <span className="font-medium text-foreground">Weekly Briefing</span> · Mon 8:00 AM</span>
        </div>
      </AnimatedItem>

      {/* Planner emails CTO and Marketer */}
      <AnimatedItem delay={400}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="P" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium">Planner</span>
              <DemoStatusDot status="working" />
            </div>
            <div className="text-sm text-foreground">Collecting updates from the team...</div>
          </div>
        </div>
      </AnimatedItem>

      {/* CTO replies */}
      <AnimatedItem delay={800}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">CTO → Planner:</span> Shipped calendar v2, 3 bug fixes. Blocker: OAuth refresh in staging.</span>
        </div>
      </AnimatedItem>

      {/* Marketer → Planner */}
      <AnimatedItem delay={1100}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Marketer → Planner:</span> Blog post live, 2 social campaigns running. Launch copy 80% done.</span>
        </div>
      </AnimatedItem>

      {/* Mock dashboard output */}
      <AnimatedItem delay={1000}>
        <div className="rounded-lg border border-border/60 bg-background/75 overflow-hidden">
          {/* Dashboard header */}
          <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
            <span className="text-[11px] font-medium">Weekly Briefing — May 19</span>
          </div>
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-px bg-border/40">
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-foreground">12</div>
              <div className="text-[10px] text-muted-foreground">Completed</div>
            </div>
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-yellow-600">1</div>
              <div className="text-[10px] text-muted-foreground">Blockers</div>
            </div>
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-foreground">5</div>
              <div className="text-[10px] text-muted-foreground">This Week</div>
            </div>
          </div>
          {/* Priority list */}
          <div className="px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-red-500 shrink-0" />
              <span className="text-xs text-foreground">OAuth token refresh failing in staging</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-foreground/30 shrink-0" />
              <span className="text-xs text-foreground">Ship calendar v2</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-foreground/30 shrink-0" />
              <span className="text-xs text-foreground">Finalize launch copy</span>
            </div>
          </div>
        </div>
      </AnimatedItem>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Demo Scene 4: Fill Form (Memory-powered)
   ───────────────────────────────────────────── */

function DemoScene4() {
  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* User drops form */}
      <AnimatedItem delay={0}>
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-primary text-primary-foreground text-sm">
            Fill this for me
            <div className="flex items-center gap-1 mt-1.5 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-0.5">
              <FileText className="size-3 shrink-0" />
              <span className="text-xs opacity-80">YC_Application_W27.pdf</span>
            </div>
          </div>
        </div>
      </AnimatedItem>

      {/* Assistant recalls from memory */}
      <AnimatedItem delay={400}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="A" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium">Assistant</span>
              <DemoStatusDot status="working" />
            </div>
            <div className="text-sm text-foreground">I have most of this from memory. Let me check what I know...</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Memory recall visualization */}
      <AnimatedItem delay={800}>
        <div className="rounded-lg border border-border/60 bg-background/75 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Recalled from memory</span>
          </div>
          <div className="space-y-1 text-xs text-foreground">
            <div className="flex items-center gap-2">
              <Check className="size-3 text-emerald-500 shrink-0" />
              <span>Company name, address, EIN</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="size-3 text-emerald-500 shrink-0" />
              <span>Founder name, email, background</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="size-3 text-emerald-500 shrink-0" />
              <span>Product description, tech stack</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="size-3 text-emerald-500 shrink-0" />
              <span>Revenue, team size, launch date</span>
            </div>
          </div>
        </div>
      </AnimatedItem>

      {/* Result */}
      <AnimatedItem delay={1300}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="A" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-foreground mb-1.5">All 31 fields filled from memory. No questions needed.</div>
            <div className="inline-flex items-center gap-1 rounded-md bg-muted border border-border/60 px-2.5 py-1.5">
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">YC_Application_W27_filled.pdf</span>
            </div>
          </div>
        </div>
      </AnimatedItem>
    </div>
  );
}


/* ─────────────────────────────────────────────
   Demo Scene 6: Daily Store Operations
   ───────────────────────────────────────────── */

function DemoScene6() {
  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* Calendar trigger */}
      <AnimatedItem delay={0}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Scheduled task triggered: <span className="font-medium text-foreground">Daily Store Check</span> · 7:00 AM</span>
        </div>
      </AnimatedItem>

      {/* Ops agent working */}
      <AnimatedItem delay={400}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="P" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium">Ops</span>
              <DemoStatusDot status="working" />
            </div>
            <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 py-0.5">
                <Check className="size-3 text-emerald-500" />
                <span className="text-foreground">Check Inventory Levels</span>
              </div>
              <div className="flex items-center gap-2 py-0.5">
                <Check className="size-3 text-emerald-500" />
                <span className="text-foreground">Pull Yesterday&apos;s Traffic &amp; Sales</span>
              </div>
              <div className="flex items-center gap-2 py-0.5">
                <Check className="size-3 text-emerald-500" />
                <span className="text-foreground">Spot Anomalies</span>
              </div>
            </div>
          </div>
        </div>
      </AnimatedItem>

      {/* Ops finds low stock, emails Marketer to pause ads */}
      <AnimatedItem delay={1000}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="P" />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium">Ops</span>
            <div className="text-sm text-foreground mt-1">&ldquo;Classic Tee&rdquo; almost out of stock. Emailing Marketer to pause that ad.</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Ops → Marketer email */}
      <AnimatedItem delay={1400}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Ops → Marketer:</span> Pause &ldquo;Classic Tee&rdquo; Instagram ad — only 3 left in stock. Reorder sent to supplier.</span>
        </div>
      </AnimatedItem>

      {/* Daily ops dashboard */}
      <AnimatedItem delay={1800}>
        <div className="rounded-lg border border-border/60 bg-background/75 overflow-hidden">
          <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
            <Mail className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] font-medium">Daily Store Report — May 23</span>
          </div>
          <div className="grid grid-cols-3 gap-px bg-border/40">
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-foreground">$4,230</div>
              <div className="text-[10px] text-muted-foreground">Revenue</div>
            </div>
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-green-600">+12%</div>
              <div className="text-[10px] text-muted-foreground">vs Last Week</div>
            </div>
            <div className="bg-background/75 px-3 py-2 text-center">
              <div className="text-lg font-semibold text-foreground">1,420</div>
              <div className="text-[10px] text-muted-foreground">Visitors</div>
            </div>
          </div>
          <div className="px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-red-500 shrink-0" />
              <span className="text-xs text-foreground">&ldquo;Classic Tee&rdquo; low stock (3 left) — reorder email sent to supplier</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-yellow-500 shrink-0" />
              <span className="text-xs text-foreground">/pricing bounce rate 68% — needs your attention</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="text-xs text-foreground">Instagram ad converting at 4.8% — keep running</span>
            </div>
          </div>
        </div>
      </AnimatedItem>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Demo Scene 7: Lead Auto Follow-up
   ───────────────────────────────────────────── */

function DemoScene7() {
  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* Lead email arrives */}
      <AnimatedItem delay={0}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">New email from <span className="font-medium text-foreground">sarah@acmecorp.com</span>: &ldquo;What&apos;s your pricing for a 50-person team?&rdquo;</span>
        </div>
      </AnimatedItem>

      {/* Sales agent recalls from memory */}
      <AnimatedItem delay={400}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="A" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium">Sales</span>
              <DemoStatusDot status="working" />
            </div>
            <div className="text-sm text-foreground">I remember this person. Let me check...</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Memory recall */}
      <AnimatedItem delay={800}>
        <div className="rounded-lg border border-border/60 bg-background/75 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Recalled from memory</span>
          </div>
          <div className="text-xs text-foreground flex items-center gap-2">
            <Check className="size-3 text-emerald-500 shrink-0" />
            <span>AcmeCorp, Series A, 50 ppl — asked about API access on Discord 2 weeks ago</span>
          </div>
        </div>
      </AnimatedItem>

      {/* Sales emails Coder to confirm feature */}
      <AnimatedItem delay={1200}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Sales → Coder:</span> Does our API support bulk user import? Sarah needs this for 50 seats.</span>
        </div>
      </AnimatedItem>

      {/* Coder replies */}
      <AnimatedItem delay={1600}>
        <div className="w-full rounded-md border border-border/60 bg-muted/50 text-sm px-3 py-2 flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Coder → Sales:</span> Yes, /api/users/bulk supports CSV import up to 500 users. Shipped last week.</span>
        </div>
      </AnimatedItem>

      {/* Sales sends personalized reply */}
      <AnimatedItem delay={2000}>
        <div className="flex items-start gap-2">
          <DemoAvatar letter="A" />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium">Sales</span>
            <div className="text-sm text-foreground mt-1">Got confirmation. Sending personalized reply with accurate info.</div>
          </div>
        </div>
      </AnimatedItem>

      {/* Sent email card */}
      <AnimatedItem delay={2400}>
        <div className="rounded-lg border border-border/60 bg-background/75 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Mail className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] font-medium">Reply sent to sarah@acmecorp.com</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">&ldquo;Hi Sarah! For 50 seats with API access, our Team plan at $29/seat is the best fit...&rdquo;</p>
          <div className="flex items-center gap-2 mt-2">
            <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-600">Hot Lead</span>
            <span className="text-[10px] text-muted-foreground">Flagged for your follow-up</span>
          </div>
        </div>
      </AnimatedItem>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Scenario Data
   ───────────────────────────────────────────── */

interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  Demo: () => React.JSX.Element;
}

const scenarios: Scenario[] = [
  {
    id: "lead-followup",
    title: "Lead auto follow-up",
    subtitle: "Personalized reply in minutes. Not hours.",
    icon: <DollarSign className="size-4" />,
    Demo: DemoScene7,
  },
  {
    id: "weekly-brief",
    title: "Monday 8am briefing",
    subtitle: "Your week is planned before coffee.",
    icon: <Calendar className="size-4" />,
    Demo: DemoScene3,
  },
  {
    id: "store-ops",
    title: "Daily store operations",
    subtitle: "Your AI ops manager checks in every morning.",
    icon: <BarChart3 className="size-4" />,
    Demo: DemoScene6,
  },
  {
    id: "bug-to-pr",
    title: "Bug report → PR ready",
    subtitle: "Three agents turn a bug email into a merged fix.",
    icon: <Bug className="size-4" />,
    Demo: DemoScene1,
  },
  {
    id: "post-update",
    title: "\"Post an update\"",
    subtitle: "One sentence. Five minutes. Published.",
    icon: <MessageSquare className="size-4" />,
    Demo: DemoScene2,
  },
  {
    id: "fill-form",
    title: "\"Fill this form\"",
    subtitle: "It remembers everything. You just sign.",
    icon: <Brain className="size-4" />,
    Demo: DemoScene4,
  },
];

/* ─────────────────────────────────────────────
   Main Section: Left Picker + Right Demo
   ───────────────────────────────────────────── */

export function UseCasesSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slideDir, setSlideDir] = useState<"left" | "right">("left");

  useGSAP(
    () => {
      gsap.from(".usecase-title", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 75%",
          toggleActions: "play none none none",
        },
      });

      gsap.from(".usecase-layout", {
        y: 40,
        opacity: 0,
        duration: 0.6,
        ease: "power2.out",
        scrollTrigger: {
          trigger: ".usecase-layout",
          start: "top 85%",
          toggleActions: "play none none none",
        },
      });
    },
    { scope: sectionRef }
  );

  const ActiveDemo = scenarios[activeIndex].Demo;

  return (
    <section
      ref={sectionRef}
      className="relative px-6 py-24 lg:py-32"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Title */}
      <div className="usecase-title mx-auto mb-14 max-w-4xl text-center lg:mb-20">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          Use Cases
        </div>
        <h2
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
            fontSize: "clamp(1.75rem, 4vw, 3rem)",
          }}
        >
          See It In Action
        </h2>
        <p
          className="mx-auto mt-3 max-w-xl"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            fontSize: "0.85rem",
          }}
        >
          Real scenarios running on real agents. Every day.
        </p>
      </div>

      {/* Layout: Left picker + Right demo */}
      <div className="usecase-layout mx-auto flex max-w-5xl flex-col gap-6 md:flex-row md:items-start md:gap-8">
        {/* Left: Scenario picker */}
        <div className="flex flex-row gap-2 overflow-x-auto thin-scrollbar pb-2 md:w-72 md:shrink-0 md:flex-col md:overflow-x-visible md:pb-0">
          {scenarios.map((scenario, i) => (
            <button
              key={scenario.id}
              type="button"
              onClick={() => { setSlideDir(i > activeIndex ? "left" : "right"); setActiveIndex(i); }}
              className={`flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-all duration-200 cursor-pointer shrink-0 md:shrink md:w-full ${
                i === activeIndex
                  ? "ring-1 ring-[var(--landing-border)] shadow-sm"
                  : "hover:bg-[oklch(0.88_0.02_75)] opacity-70 hover:opacity-100"
              }`}
              style={
                i === activeIndex
                  ? {
                      backgroundColor: "var(--landing-surface)",
                    }
                  : undefined
              }
            >
              <span
                className="mt-0.5 shrink-0"
                style={{ color: i === activeIndex ? "var(--landing-text)" : "var(--landing-text-muted)" }}
              >
                {scenario.icon}
              </span>
              <div className="min-w-0">
                <div
                  className="text-sm font-medium leading-snug whitespace-nowrap lg:whitespace-normal"
                  style={{
                    fontFamily: "var(--font-crt)",
                    color: i === activeIndex ? "var(--landing-text)" : "var(--landing-text-muted)",
                  }}
                >
                  {scenario.title}
                </div>
                {i === activeIndex && (
                  <div
                    className="mt-0.5 text-[11px] leading-snug hidden md:block"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--landing-text-muted)",
                    }}
                  >
                    {scenario.subtitle}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Right: Demo panel */}
        <div className="flex-1 min-w-0 overflow-hidden rounded-2xl" style={{ backgroundColor: "var(--landing-bg)", perspective: "1200px" }}>
          <div
            key={activeIndex}
            className={`rounded-2xl overflow-hidden ${slideDir === "left" ? "usecase-demo-slide-left" : "usecase-demo-slide-right"}`}
            style={{
              backgroundColor: "var(--landing-surface)",
              border: "1px solid var(--landing-border)",
              boxShadow: "0 4px 24px oklch(0.15 0.01 55 / 10%)",
            }}
          >
            {/* Window chrome */}
            <div
              className="flex items-center gap-1.5 px-4 py-2.5 border-b"
              style={{ borderColor: "var(--landing-border)" }}
            >
              <span className="size-2.5 rounded-full bg-[oklch(0.65_0.2_25)]" />
              <span className="size-2.5 rounded-full bg-[oklch(0.75_0.15_85)]" />
              <span className="size-2.5 rounded-full bg-[oklch(0.65_0.15_145)]" />
              <span
                className="ml-3 text-[11px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--landing-text-muted)" }}
              >
                alook — {scenarios[activeIndex].title}
              </span>
            </div>

            {/* Demo content area */}
            <div className="usecase-demo-panel h-120 overflow-y-auto thin-scrollbar">
              <ActiveDemo />
            </div>
          </div>
        </div>
      </div>

    </section>
  );
}
