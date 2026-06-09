"use client";

import { useMemo, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { DemoWindow } from "./demo-window";
import { DemoDashboard, type DashboardStep, type DashboardState, type DashboardConfig, type AgentInfo } from "./demo-pad/demo-dashboard";
import { DemoTerminal, type TerminalLine } from "./demo-pad/demo-terminal";
import { DemoMobile } from "./demo-pad/demo-mobile";
import { useScriptedTimeline, type TimelineStep } from "./demo-pad/use-scripted-timeline";

gsap.registerPlugin(ScrollTrigger);

const ARCH_AGENTS: AgentInfo[] = [
  { name: "Planner", email: "planner@alook.ai", config: { shape: "hexagon", eye: "dots", nose: "dash", bg: 5 } },
  { name: "Coder", email: "coder@alook.ai", config: { shape: "task", eye: "happy", nose: "dot", bg: 0 } },
];
const ARCH_CONFIG: DashboardConfig = { agents: ARCH_AGENTS };

/* ─── Planner's chat steps ─── */
const PLANNER_STEPS: DashboardStep[] = [
  { type: "user-message", text: "A user reported Safari crashes on login — can you fix it?" },
  { type: "message", text: "On it. Let me investigate and delegate to Coder." },
  { type: "email-out", subject: "Fix Safari flex gap in login page", address: "coder@alook.ai" },
  // After Coder finishes:
  { type: "email-in", subject: "Re: Fix Safari flex gap — Done, PR #142", address: "coder@alook.ai" },
  { type: "message", markdown: "Coder fixed it — <strong>PR #142</strong> opened. Both <code>login-page.tsx</code> and <code>signup.tsx</code> patched, 42 tests passing." },
  { type: "user-message", text: "Nice, ship it" },
  { type: "message", text: "Done. Merged and replied to the reporter." },
  { type: "email-out", subject: "Re: Login crashes on Safari — Fixed", address: "user@company.com" },
];

/* ─── Coder's chat steps ─── */
const CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Fix Safari flex gap in login page", address: "planner@alook.ai" },
  { type: "message", text: "Got it. Searching for flex gap usage..." },
  { type: "message", markdown: `Found 2 affected files:<br/><code>login-page.tsx:42</code> and <code>signup.tsx:18</code>. Fixing both.` },
  { type: "message", markdown: "Done — replaced flex gap → margin spacing. <strong>42 tests passing ✓</strong>" },
  { type: "email-out", subject: "Re: Fix Safari flex gap — Done, PR #142", address: "planner@alook.ai" },
];

/* ─── Terminal lines ─── */
const TERMINAL_LINES: TerminalLine[] = [
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[daemon] ", color: "muted" },
    { text: "Task ", color: "info" },
    { text: "PhGFC9l ", color: "string" },
    { text: "claimed agent=", color: "info" },
    { text: "Planner", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "send-dm", color: "highlight" },
    { text: ": ", color: "muted" },
    { text: "\"Let me investigate and delegate...\"", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "email-send", color: "highlight" },
    { text: ": → ", color: "muted" },
    { text: "coder@alook.ai", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[daemon] ", color: "muted" },
    { text: "Task ", color: "info" },
    { text: "xK9mT2r ", color: "string" },
    { text: "claimed agent=", color: "info" },
    { text: "Coder", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "starting ", color: "info" },
    { text: "(provider=", color: "muted" },
    { text: "claude", color: "string" },
    { text: ")", color: "muted" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "Bash", color: "highlight" },
    { text: ": grep -rn ", color: "info" },
    { text: "flex-gap", color: "string" },
    { text: " src/", color: "muted" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "→ found in ", color: "info" },
    { text: "login-page.tsx:42", color: "highlight" },
    { text: ", ", color: "muted" },
    { text: "signup.tsx:18", color: "highlight" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "Edit", color: "highlight" },
    { text: ": ", color: "muted" },
    { text: "login-page.tsx", color: "string" },
    { text: ", ", color: "muted" },
    { text: "signup.tsx", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "Bash", color: "highlight" },
    { text: ": pnpm test ", color: "info" },
    { text: "→ ", color: "muted" },
    { text: "42 passed ✓", color: "success" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "email-send", color: "highlight" },
    { text: ": → ", color: "muted" },
    { text: "planner@alook.ai", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "completed ", color: "success" },
    { text: "(duration=18s, tools=4)", color: "muted" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "send-dm", color: "highlight" },
    { text: ": ", color: "muted" },
    { text: "\"Coder fixed it — PR #142 opened.\"", color: "string" },
  ] },
  { spans: [
    { text: "INFO  ", color: "keyword" },
    { text: "[session-runner] ", color: "muted" },
    { text: "email-send", color: "highlight" },
    { text: ": → ", color: "muted" },
    { text: "user@company.com", color: "string" },
    { text: " — ", color: "muted" },
    { text: "completed", color: "success" },
  ] },
];

/* ─── Timeline ─── */
const TIMELINE: TimelineStep[] = [
  // Planner phase 1: user asks, planner responds + delegates
  { id: "user-asks", duration: 2000 },
  { id: "planner-typing", duration: 1500 },
  { id: "planner-msg1", duration: 1500 },
  { id: "planner-email-out", duration: 2000 },
  // Switch to Coder
  { id: "switch-to-coder", duration: 1200 },
  { id: "coder-email-in", duration: 1800 },
  { id: "coder-typing", duration: 1200 },
  { id: "coder-msg1", duration: 1500 },
  { id: "coder-msg2", duration: 1800 },
  { id: "coder-msg3", duration: 1800 },
  { id: "coder-email-out", duration: 2000 },
  // Switch back to Planner
  { id: "switch-to-planner", duration: 1200 },
  { id: "planner-email-in", duration: 1800 },
  { id: "planner-msg2", duration: 2000 },
  { id: "user-confirms", duration: 1800 },
  { id: "planner-msg3", duration: 1500 },
  { id: "planner-final-email", duration: 3000 },
];

/* ─── Main component ─── */

export function ArchitectureOverview() {
  const sectionRef = useRef<HTMLDivElement>(null);

  const { visibleCount, isResetting, containerRef, isStepVisible } =
    useScriptedTimeline({ steps: TIMELINE, holdAfterComplete: 3500 });

  // Derive dashboard state from timeline
  const dashboardState: DashboardState = useMemo(() => {
    // Which agent is active?
    const showCoder = isStepVisible(4) && !isStepVisible(11);
    const activeAgent = showCoder ? "coder" as const : "planner" as const;

    let steps: DashboardStep[];
    let vis: number;
    let isTyping: boolean;
    let isWorking: boolean;

    if (showCoder) {
      steps = CODER_STEPS;
      vis = 0;
      if (isStepVisible(5)) vis = 1;  // email-in
      if (isStepVisible(7)) vis = 2;  // msg1 "Got it"
      if (isStepVisible(8)) vis = 3;  // msg2 "Found 2 files"
      if (isStepVisible(9)) vis = 4;  // msg3 "Done"
      if (isStepVisible(10)) vis = 5; // email-out
      isTyping = isStepVisible(6) && !isStepVisible(7);
      isWorking = isStepVisible(5) && !isStepVisible(10);
    } else {
      steps = PLANNER_STEPS;
      vis = 0;
      if (isStepVisible(0)) vis = 1;  // user msg
      if (isStepVisible(2)) vis = 2;  // planner msg1
      if (isStepVisible(3)) vis = 3;  // email-out to coder
      if (isStepVisible(12)) vis = 4; // email-in from coder
      if (isStepVisible(13)) vis = 5; // planner msg2 "Coder fixed it"
      if (isStepVisible(14)) vis = 6; // user "Nice, ship it"
      if (isStepVisible(15)) vis = 7; // planner msg3 "Done"
      if (isStepVisible(16)) vis = 8; // email-out to user
      isTyping = isStepVisible(1) && !isStepVisible(2);
      isWorking = isStepVisible(0) && !isStepVisible(16);
    }

    return { activeAgent, steps, visibleCount: vis, isTyping, isWorking };
  }, [visibleCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Terminal: each timeline step from 0 onward maps to a line
  const terminalVisible = useMemo(() => {
    // Map timeline steps to terminal lines
    const mapping = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12];
    let count = 0;
    for (let i = 0; i < mapping.length; i++) {
      if (isStepVisible(i)) count = mapping[i] + 1;
    }
    return Math.min(count, TERMINAL_LINES.length);
  }, [visibleCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useGSAP(
    () => {
      gsap.from(".arch-title", {
        y: 30, opacity: 0, duration: 0.6,
        scrollTrigger: { trigger: sectionRef.current, start: "top 75%", toggleActions: "play none none none" },
      });
      gsap.from(".arch-demo-container", {
        y: 40, opacity: 0, duration: 0.7,
        scrollTrigger: { trigger: ".arch-demo-container", start: "top 70%", toggleActions: "play none none none" },
      });
    },
    { scope: sectionRef },
  );

  return (
    <section
      ref={sectionRef}
      className="relative flex flex-col items-center justify-center px-6 py-24 lg:py-32"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Title */}
      <div className="arch-title mb-16 text-center">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--landing-text-muted)" }}
        >
          How It Works
        </div>
        <h2 style={{ fontFamily: "var(--font-crt)", color: "var(--landing-text)", fontSize: "clamp(1.75rem, 4vw, 3rem)" }}>
          Local Agent, Global Reach
        </h2>
        <p
          className="mt-2 max-w-2xl mx-auto"
          style={{ fontFamily: "var(--font-mono)", color: "var(--landing-text-muted)", fontSize: "0.85rem" }}
        >
          Your agent runs on your machine with full access to your tools.
          Alook connects it to email, dashboards, and the outside world.
        </p>
      </div>

      {/* Triple-window demo */}
      <div
        ref={containerRef}
        className={`arch-demo-container relative w-full max-w-5xl mx-auto h-130 lg:h-120 transition-opacity duration-300 ${
          isResetting ? "opacity-0" : "opacity-100"
        }`}
      >
        {/* Desktop — top-left, behind */}
        <div className="absolute top-0 left-0 w-[60%] h-[88%] z-10 hidden md:block">
          <DemoWindow title="Alook Desktop" className="h-full shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.1)]">
            <DemoDashboard state={dashboardState} config={ARCH_CONFIG} />
          </DemoWindow>
        </div>

        {/* Mobile + Terminal — side by side, overlapping desktop from left */}
        <div className="absolute top-[25%] left-[40%] right-0 h-[75%] z-20 hidden md:flex gap-3">
          {/* Mobile — phone frame */}
          <div className="w-45 shrink-0 h-full hidden lg:block">
            <div className="h-full rounded-[1.5rem] border-[3px] border-neutral-700 bg-background shadow-[0_28px_70px_rgba(0,0,0,0.18),0_14px_32px_rgba(0,0,0,0.12)] overflow-hidden flex flex-col dark">
              {/* Dynamic Island */}
              <div className="flex justify-center pt-1 shrink-0">
                <div className="px-2 py-px bg-neutral-800 rounded-full flex items-center justify-center">
                  <span className="text-[8px] text-neutral-400">Alook Mobile</span>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <DemoMobile state={dashboardState} config={ARCH_CONFIG} />
              </div>
              {/* Home indicator */}
              <div className="flex justify-center py-1 shrink-0">
                <div className="w-12 h-1 bg-muted-foreground/30 rounded-full" />
              </div>
            </div>
          </div>
          {/* Terminal */}
          <div className="flex-1 min-w-0 h-full">
            <DemoWindow title="Your Machine" className="h-full shadow-[0_28px_70px_rgba(0,0,0,0.18),0_14px_32px_rgba(0,0,0,0.12)]">
              <DemoTerminal lines={TERMINAL_LINES} visibleCount={terminalVisible} />
            </DemoWindow>
          </div>
        </div>

        {/* Responsive (< md): mobile phone only */}
        <div className="md:hidden flex justify-center h-full">
          <div className="w-65 h-full rounded-[2rem] border-[3px] border-neutral-700 bg-background shadow-lg overflow-hidden flex flex-col dark">
            <div className="flex justify-center pt-2 shrink-0">
              <div className="px-4 py-1 bg-neutral-800 rounded-full flex items-center justify-center">
                <span className="text-[11px] text-neutral-400 leading-none">Alook Mobile</span>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <DemoMobile state={dashboardState} config={ARCH_CONFIG} />
            </div>
            <div className="flex justify-center py-1 shrink-0">
              <div className="w-16 h-1 bg-muted-foreground/30 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
