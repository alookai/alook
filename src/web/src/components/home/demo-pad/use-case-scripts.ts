import type { DashboardStep, AgentInfo } from "./demo-dashboard";
import type { UseCaseScript } from "./use-case-demo";

/* ─── Agent Configs ─── */
const SALES: AgentInfo = { name: "Sales", email: "sales@alook.ai", config: { shape: "hexagon", eye: "dots", nose: "dash", bg: 5 } };
const PLANNER: AgentInfo = { name: "Planner", email: "planner@alook.ai", config: { shape: "hexagon", eye: "dots", nose: "dash", bg: 5 } };
const CODER: AgentInfo = { name: "Coder", email: "coder@alook.ai", config: { shape: "task", eye: "happy", nose: "dot", bg: 0 } };
const REVIEWER: AgentInfo = { name: "Reviewer", email: "reviewer@alook.ai", config: { shape: "circle", eye: "arches", nose: "smile", bg: 8 } };
const MARKETER: AgentInfo = { name: "Marketer", email: "marketer@alook.ai", config: { shape: "mail", eye: "dots", nose: "smile", bg: 3 } };
const OPS: AgentInfo = { name: "Ops", email: "ops@alook.ai", config: { shape: "folder", eye: "lines", nose: "dash", bg: 7 } };
const ASSISTANT: AgentInfo = { name: "Assistant", email: "assistant@alook.ai", config: { shape: "bulb", eye: "rings", nose: "oh", bg: 11 } };

/* ═══════════════════════════════════════════
   1. Lead Auto Follow-up
   Sales recalls memory → asks Coder about feature → sends personalized reply
   ═══════════════════════════════════════════ */

const LEAD_SALES_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "What's your pricing for a 50-person team?", address: "sarah@acmecorp.com" },
  { type: "message", text: "I remember this person. AcmeCorp, Series A — asked about API access on Discord 2 weeks ago." },
  { type: "email-out", subject: "Does our API support bulk user import? Sarah needs this for 50 seats.", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Yes, /api/users/bulk supports CSV import up to 500 users.", address: "coder@alook.ai" },
  { type: "message", text: "Got confirmation. Sending personalized reply with accurate info." },
  { type: "email-out", subject: "Re: Pricing — Team plan $29/seat with API access", address: "sarah@acmecorp.com" },
];

const LEAD_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Does our API support bulk user import? Sarah needs this for 50 seats.", address: "sales@alook.ai" },
  { type: "message", markdown: "Yes, <code>/api/users/bulk</code> supports CSV import up to 500 users. Shipped last week." },
  { type: "email-out", subject: "Re: Yes, /api/users/bulk supports CSV import up to 500 users.", address: "sales@alook.ai" },
];

export const leadFollowupScript: UseCaseScript = {
  agents: [SALES, CODER],
  timeline: [
    { id: "email-in", duration: 2000 },
    { id: "sales-typing", duration: 1500 },
    { id: "sales-msg", duration: 1800 },
    { id: "sales-email-out", duration: 1800 },
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg", duration: 1500 },
    { id: "coder-email-out", duration: 1800 },
    { id: "switch-sales", duration: 1000 },
    { id: "sales-email-in-2", duration: 1500 },
    { id: "sales-msg-2", duration: 1800 },
    { id: "sales-email-out-2", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(9);
    if (showCoder) {
      let vis = 0;
      if (isStepVisible(5)) vis = 1;
      if (isStepVisible(7)) vis = 2;
      if (isStepVisible(8)) vis = 3;
      return { activeAgent: "coder", steps: LEAD_CODER_STEPS, visibleCount: vis, isTyping: isStepVisible(6) && !isStepVisible(7), isWorking: isStepVisible(5) && !isStepVisible(8) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(10)) vis = 4;
    if (isStepVisible(11)) vis = 5;
    if (isStepVisible(12)) vis = 6;
    return { activeAgent: "sales", steps: LEAD_SALES_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(12) };
  },
};

/* ═══════════════════════════════════════════
   2. Monday 8am Briefing
   Calendar triggers Planner → asks CTO + Marketer → compiles weekly report
   ═══════════════════════════════════════════ */

const BRIEF_PLANNER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Weekly Briefing — Mon 8:00 AM", address: "calendar@alook.ai" },
  { type: "message", text: "Collecting updates from the team..." },
  { type: "email-out", subject: "What shipped this week? Any blockers?", address: "coder@alook.ai" },
  { type: "email-in", subject: "Shipped calendar v2, 3 bug fixes. Blocker: OAuth refresh in staging.", address: "coder@alook.ai" },
  { type: "email-out", subject: "Marketing status update?", address: "marketer@alook.ai" },
  { type: "email-in", subject: "Blog post live, 2 social campaigns running. Launch copy 80% done.", address: "marketer@alook.ai" },
  { type: "message", markdown: `<strong>Weekly Briefing — May 19</strong><br/><span style="display:inline-block;margin:4px 0"><span style="font-size:18px;font-weight:600">12</span> <span style="font-size:11px;opacity:0.6">Completed</span> · <span style="font-size:18px;font-weight:600;color:#ca8a04">1</span> <span style="font-size:11px;opacity:0.6">Blocker</span> · <span style="font-size:18px;font-weight:600">5</span> <span style="font-size:11px;opacity:0.6">This Week</span></span><br/>🔴 OAuth token refresh failing in staging` },
  { type: "email-out", subject: "Your Monday Briefing — May 19", address: "owner@company.com" },
];

const BRIEF_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "What shipped this week? Any blockers?", address: "planner@alook.ai" },
  { type: "message", text: "Shipped calendar v2, 3 bug fixes. Blocker: OAuth refresh failing in staging." },
  { type: "email-out", subject: "Shipped calendar v2, 3 bug fixes. Blocker: OAuth refresh in staging.", address: "planner@alook.ai" },
];

const BRIEF_MARKETER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Marketing status update?", address: "planner@alook.ai" },
  { type: "message", text: "Blog post live, 2 social campaigns running. Launch copy 80% done." },
  { type: "email-out", subject: "Blog post live, 2 social campaigns running. Launch copy 80% done.", address: "planner@alook.ai" },
];

export const weeklyBriefScript: UseCaseScript = {
  agents: [PLANNER, CODER, MARKETER],
  timeline: [
    { id: "trigger", duration: 2000 },
    { id: "planner-typing", duration: 1500 },
    { id: "planner-msg", duration: 1500 },
    { id: "planner-email-out-coder", duration: 1800 },
    // Switch to Coder
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg", duration: 1500 },
    { id: "coder-email-out", duration: 1800 },
    // Switch back to Planner briefly
    { id: "switch-planner-1", duration: 1000 },
    { id: "planner-email-in-coder", duration: 1200 },
    { id: "planner-email-out-marketer", duration: 1500 },
    // Switch to Marketer
    { id: "switch-marketer", duration: 1000 },
    { id: "marketer-email-in", duration: 1500 },
    { id: "marketer-typing", duration: 1200 },
    { id: "marketer-msg", duration: 1500 },
    { id: "marketer-email-out", duration: 1800 },
    // Switch back to Planner for final
    { id: "switch-planner-2", duration: 1000 },
    { id: "planner-email-in-marketer", duration: 1200 },
    { id: "planner-msg-2", duration: 2500 },
    { id: "planner-email-out-final", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(9);
    const showMarketer = isStepVisible(12) && !isStepVisible(17);
    if (showMarketer) {
      let vis = 0;
      if (isStepVisible(13)) vis = 1;
      if (isStepVisible(15)) vis = 2;
      if (isStepVisible(16)) vis = 3;
      return { activeAgent: "marketer", steps: BRIEF_MARKETER_STEPS, visibleCount: vis, isTyping: isStepVisible(14) && !isStepVisible(15), isWorking: isStepVisible(13) && !isStepVisible(16) };
    }
    if (showCoder) {
      let vis = 0;
      if (isStepVisible(5)) vis = 1;
      if (isStepVisible(7)) vis = 2;
      if (isStepVisible(8)) vis = 3;
      return { activeAgent: "coder", steps: BRIEF_CODER_STEPS, visibleCount: vis, isTyping: isStepVisible(6) && !isStepVisible(7), isWorking: isStepVisible(5) && !isStepVisible(8) };
    }
    // Planner view
    let vis = 0;
    if (isStepVisible(0)) vis = 1;  // calendar trigger
    if (isStepVisible(2)) vis = 2;  // msg "collecting..."
    if (isStepVisible(3)) vis = 3;  // email-out to coder
    if (isStepVisible(10)) vis = 4; // email-in from coder
    if (isStepVisible(11)) vis = 5; // email-out to marketer
    if (isStepVisible(18)) vis = 6; // email-in from marketer
    if (isStepVisible(19)) vis = 7; // briefing summary
    if (isStepVisible(20)) vis = 8; // email-out to owner
    return { activeAgent: "planner", steps: BRIEF_PLANNER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(20) };
  },
};

/* ═══════════════════════════════════════════
   3. Daily Store Operations
   Ops checks inventory → finds low stock → emails Marketer to pause ads
   ═══════════════════════════════════════════ */

const STORE_OPS_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Daily Store Check — 7:00 AM", address: "calendar@alook.ai" },
  { type: "message", markdown: "Checking inventory, traffic, sales...<br/>✓ Check Inventory Levels<br/>✓ Pull Yesterday's Traffic &amp; Sales<br/>✓ Spot Anomalies" },
  { type: "message", text: "\"Classic Tee\" almost out of stock (3 left). Emailing Marketer to pause that ad." },
  { type: "email-out", subject: "Pause \"Classic Tee\" Instagram ad — only 3 left in stock", address: "marketer@alook.ai" },
  { type: "email-in", subject: "Re: Paused. Switching budget to Hoodie campaign.", address: "marketer@alook.ai" },
  { type: "email-out", subject: "Daily Store Report — May 23", address: "owner@company.com" },
];

const STORE_MARKETER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Pause \"Classic Tee\" Instagram ad — only 3 left in stock", address: "ops@alook.ai" },
  { type: "message", text: "Paused. Switching budget to the Hoodie campaign instead." },
  { type: "email-out", subject: "Re: Paused. Switching budget to Hoodie campaign.", address: "ops@alook.ai" },
];

export const storeOpsScript: UseCaseScript = {
  agents: [OPS, MARKETER],
  timeline: [
    { id: "trigger", duration: 2000 },
    { id: "ops-typing", duration: 1500 },
    { id: "ops-msg", duration: 2200 },
    { id: "ops-msg-2", duration: 1500 },
    { id: "ops-email-out", duration: 1800 },
    { id: "switch-marketer", duration: 1000 },
    { id: "marketer-email-in", duration: 1500 },
    { id: "marketer-typing", duration: 1200 },
    { id: "marketer-msg", duration: 1500 },
    { id: "marketer-email-out", duration: 1800 },
    { id: "switch-ops", duration: 1000 },
    { id: "ops-email-in", duration: 1500 },
    { id: "ops-final-email", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showMarketer = isStepVisible(5) && !isStepVisible(10);
    if (showMarketer) {
      let vis = 0;
      if (isStepVisible(6)) vis = 1;
      if (isStepVisible(8)) vis = 2;
      if (isStepVisible(9)) vis = 3;
      return { activeAgent: "marketer", steps: STORE_MARKETER_STEPS, visibleCount: vis, isTyping: isStepVisible(7) && !isStepVisible(8), isWorking: isStepVisible(6) && !isStepVisible(9) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(4)) vis = 4;
    if (isStepVisible(11)) vis = 5;
    if (isStepVisible(12)) vis = 6;
    return { activeAgent: "ops", steps: STORE_OPS_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(12) };
  },
};

/* ═══════════════════════════════════════════
   4. Bug Report → PR Ready
   Email → Planner → Coder → Reviewer → PR merged
   ═══════════════════════════════════════════ */

const BUG_PLANNER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Login page crashes on Safari", address: "user@company.com" },
  { type: "message", text: "Reproduced it — WebKit flex gap bug in Safari 14. Writing fix plan and emailing Coder." },
  { type: "email-out", subject: "Replace flex gap with margin-based spacing in login page.", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Fixed. PR #142 ready for review.", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: All tests pass. Approved.", address: "reviewer@alook.ai" },
  { type: "email-out", subject: "Re: Login page crashes on Safari — Fixed in PR #142", address: "user@company.com" },
];

const BUG_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Replace flex gap with margin-based spacing in login page.", address: "planner@alook.ai" },
  { type: "message", text: "Fixed. PR opened. Emailing Reviewer." },
  { type: "email-out", subject: "PR #142 ready. Safari flex gap fix.", address: "reviewer@alook.ai" },
  { type: "email-out", subject: "Re: Fixed. PR #142 ready for review.", address: "planner@alook.ai" },
];

const BUG_REVIEWER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "PR #142 ready. Safari flex gap fix.", address: "coder@alook.ai" },
  { type: "message", text: "All tests pass. Approved." },
  { type: "email-out", subject: "Re: All tests pass. Approved.", address: "planner@alook.ai" },
];

export const bugToPrScript: UseCaseScript = {
  agents: [PLANNER, CODER, REVIEWER],
  timeline: [
    { id: "email-in", duration: 2000 },
    { id: "planner-typing", duration: 1500 },
    { id: "planner-msg", duration: 1800 },
    { id: "planner-email-out", duration: 1800 },
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg", duration: 1500 },
    { id: "coder-email-out-1", duration: 1200 },
    { id: "coder-email-out-2", duration: 1500 },
    { id: "switch-reviewer", duration: 1000 },
    { id: "reviewer-email-in", duration: 1500 },
    { id: "reviewer-typing", duration: 1200 },
    { id: "reviewer-msg", duration: 1500 },
    { id: "reviewer-email-out", duration: 1800 },
    { id: "switch-planner", duration: 1000 },
    { id: "planner-email-in-1", duration: 1200 },
    { id: "planner-email-in-2", duration: 1200 },
    { id: "planner-email-out-2", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(10);
    const showReviewer = isStepVisible(10) && !isStepVisible(15);
    if (showReviewer) {
      let vis = 0;
      if (isStepVisible(11)) vis = 1;
      if (isStepVisible(13)) vis = 2;
      if (isStepVisible(14)) vis = 3;
      return { activeAgent: "reviewer", steps: BUG_REVIEWER_STEPS, visibleCount: vis, isTyping: isStepVisible(12) && !isStepVisible(13), isWorking: isStepVisible(11) && !isStepVisible(14) };
    }
    if (showCoder) {
      let vis = 0;
      if (isStepVisible(5)) vis = 1;
      if (isStepVisible(7)) vis = 2;
      if (isStepVisible(8)) vis = 3;
      if (isStepVisible(9)) vis = 4;
      return { activeAgent: "coder", steps: BUG_CODER_STEPS, visibleCount: vis, isTyping: isStepVisible(6) && !isStepVisible(7), isWorking: isStepVisible(5) && !isStepVisible(9) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(16)) vis = 4;
    if (isStepVisible(17)) vis = 5;
    if (isStepVisible(18)) vis = 6;
    return { activeAgent: "planner", steps: BUG_PLANNER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(18) };
  },
};

/* ═══════════════════════════════════════════
   5. "Post an update"
   User → Marketer asks Coder what shipped → drafts + publishes
   ═══════════════════════════════════════════ */

const POST_MARKETER_STEPS: DashboardStep[] = [
  { type: "user-message", text: "Post something about today's release" },
  { type: "message", text: "I need to know what shipped today. Emailing Coder." },
  { type: "email-out", subject: "What did we ship today? I need to write a post.", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Shipped calendar recurring events, email forwarding, and 3 bug fixes.", address: "coder@alook.ai" },
  { type: "message", markdown: "Got it. Drafting and publishing now.<br/><br/>✓ Posted to X: <em>\"Just shipped: recurring calendar events, email forwarding, and squashed 3 bugs. Your AI team never sleeps.\"</em>" },
];

const POST_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "What did we ship today? I need to write a post.", address: "marketer@alook.ai" },
  { type: "message", text: "Shipped calendar recurring events, email forwarding, and 3 bug fixes." },
  { type: "email-out", subject: "Re: Shipped calendar recurring events, email forwarding, and 3 bug fixes.", address: "marketer@alook.ai" },
];

export const postUpdateScript: UseCaseScript = {
  agents: [MARKETER, CODER],
  timeline: [
    { id: "user-asks", duration: 2000 },
    { id: "marketer-typing", duration: 1500 },
    { id: "marketer-msg", duration: 1500 },
    { id: "marketer-email-out", duration: 1800 },
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg", duration: 1500 },
    { id: "coder-email-out", duration: 1800 },
    { id: "switch-marketer", duration: 1000 },
    { id: "marketer-email-in", duration: 1500 },
    { id: "marketer-msg-2", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(9);
    if (showCoder) {
      let vis = 0;
      if (isStepVisible(5)) vis = 1;
      if (isStepVisible(7)) vis = 2;
      if (isStepVisible(8)) vis = 3;
      return { activeAgent: "coder", steps: POST_CODER_STEPS, visibleCount: vis, isTyping: isStepVisible(6) && !isStepVisible(7), isWorking: isStepVisible(5) && !isStepVisible(8) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(10)) vis = 4;
    if (isStepVisible(11)) vis = 5;
    return { activeAgent: "marketer", steps: POST_MARKETER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(11) };
  },
};

/* ═══════════════════════════════════════════
   6. "Fill this form"
   User drops PDF → Assistant recalls from memory → fills all fields
   ═══════════════════════════════════════════ */

const FILL_STEPS: DashboardStep[] = [
  { type: "user-message", text: "Fill this for me", attachment: "YC_Application_W27.pdf" },
  { type: "message", text: "I have most of this from memory. Let me check what I know..." },
  { type: "message", markdown: `<span style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6">Recalled from memory</span><br/><span style="color:#10b981">✓</span> Company name, address, EIN<br/><span style="color:#10b981">✓</span> Founder name, email, background<br/><span style="color:#10b981">✓</span> Product description, tech stack<br/><span style="color:#10b981">✓</span> Revenue, team size, launch date` },
  { type: "message", markdown: `All <strong>31 fields</strong> filled from memory. No questions needed.<br/><br/><span style="display:inline-flex;align-items:center;gap:4px;background:var(--muted);border:1px solid var(--border);border-radius:6px;padding:4px 10px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><span style="font-size:13px;font-weight:500">YC_Application_W27_filled.pdf</span></span>` },
];

export const fillFormScript: UseCaseScript = {
  agents: [ASSISTANT],
  timeline: [
    { id: "user-drops", duration: 2000 },
    { id: "agent-typing", duration: 1800 },
    { id: "agent-msg-1", duration: 2000 },
    { id: "agent-msg-2", duration: 2500 },
    { id: "agent-msg-3", duration: 3000 },
  ],
  derive(isStepVisible) {
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(4)) vis = 4;
    return { activeAgent: "assistant", steps: FILL_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(4) };
  },
};
