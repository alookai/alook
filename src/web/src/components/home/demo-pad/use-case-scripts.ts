import type { DashboardStep, DashboardState } from "./demo-dashboard";
import type { TimelineStep } from "./use-scripted-timeline";
import type { UseCaseScript } from "./use-case-demo";

/* ═══════════════════════════════════════════
   1. Lead Auto Follow-up
   Sales agent gets lead email → recalls memory → asks Coder about feature → replies
   ═══════════════════════════════════════════ */

const LEAD_SALES_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Pricing for a 50-person team?", address: "sarah@acmecorp.com" },
  { type: "message", text: "I remember AcmeCorp — they asked about API access 2 weeks ago. Let me check with Coder." },
  { type: "email-out", subject: "Does our API support bulk user import?", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Bulk import — yes, /api/users/bulk (up to 500)", address: "coder@alook.ai" },
  { type: "message", markdown: "Confirmed. Sending personalized reply with pricing + API info." },
  { type: "email-out", subject: "Re: Pricing — Team plan $29/seat with API access", address: "sarah@acmecorp.com" },
];

const LEAD_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Does our API support bulk user import?", address: "sales@alook.ai" },
  { type: "message", markdown: "Checking... Yes, <code>/api/users/bulk</code> supports CSV import up to 500 users. Shipped last week." },
  { type: "email-out", subject: "Re: Bulk import — yes, /api/users/bulk (up to 500)", address: "sales@alook.ai" },
];

export const leadFollowupScript: UseCaseScript = {
  phases: [
    { agent: "planner", steps: LEAD_SALES_STEPS },
    { agent: "coder", steps: LEAD_CODER_STEPS },
  ],
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
    return { activeAgent: "planner", steps: LEAD_SALES_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(12) };
  },
};

/* ═══════════════════════════════════════════
   2. Monday 8am Briefing
   Calendar triggers Planner → Planner asks Coder + Marketer → compiles report
   ═══════════════════════════════════════════ */

const BRIEF_PLANNER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Weekly Briefing — triggered", address: "calendar@alook.ai" },
  { type: "message", text: "Collecting updates from the team..." },
  { type: "email-out", subject: "What shipped this week?", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Shipped calendar v2, 3 bug fixes", address: "coder@alook.ai" },
  { type: "message", markdown: `<strong>Weekly Briefing</strong><br/><table style="font-size:12px;width:100%;border-collapse:collapse"><tr><td style="padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.2)"><strong>Completed</strong></td><td style="padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.2)"><strong>Blockers</strong></td><td style="padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.2)"><strong>Next</strong></td></tr><tr><td style="padding:2px 6px">12</td><td style="padding:2px 6px">1</td><td style="padding:2px 6px">5</td></tr></table>` },
  { type: "email-out", subject: "Your Monday Briefing — May 19", address: "owner@company.com" },
];

const BRIEF_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "What shipped this week?", address: "planner@alook.ai" },
  { type: "message", text: "Calendar v2, 3 bug fixes, OAuth refresh still blocked in staging." },
  { type: "email-out", subject: "Re: Shipped calendar v2, 3 bug fixes", address: "planner@alook.ai" },
];

export const weeklyBriefScript: UseCaseScript = {
  phases: [
    { agent: "planner", steps: BRIEF_PLANNER_STEPS },
    { agent: "coder", steps: BRIEF_CODER_STEPS },
  ],
  timeline: [
    { id: "trigger", duration: 2000 },
    { id: "planner-typing", duration: 1500 },
    { id: "planner-msg", duration: 1500 },
    { id: "planner-email-out", duration: 1800 },
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg", duration: 1500 },
    { id: "coder-email-out", duration: 1800 },
    { id: "switch-planner", duration: 1000 },
    { id: "planner-email-in", duration: 1500 },
    { id: "planner-msg-2", duration: 2500 },
    { id: "planner-email-out-2", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(9);
    if (showCoder) {
      let vis = 0;
      if (isStepVisible(5)) vis = 1;
      if (isStepVisible(7)) vis = 2;
      if (isStepVisible(8)) vis = 3;
      return { activeAgent: "coder", steps: BRIEF_CODER_STEPS, visibleCount: vis, isTyping: isStepVisible(6) && !isStepVisible(7), isWorking: isStepVisible(5) && !isStepVisible(8) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(10)) vis = 4;
    if (isStepVisible(11)) vis = 5;
    if (isStepVisible(12)) vis = 6;
    return { activeAgent: "planner", steps: BRIEF_PLANNER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(12) };
  },
};

/* ═══════════════════════════════════════════
   3. Daily Store Operations
   Ops checks inventory → finds low stock → emails Marketer to pause ads
   ═══════════════════════════════════════════ */

const STORE_OPS_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Daily Store Check — triggered", address: "calendar@alook.ai" },
  { type: "message", markdown: "Checking inventory, traffic, and sales...<br/>• Inventory: <code>Classic Tee</code> only 3 left<br/>• Traffic: 1,420 visitors (+12%)<br/>• Revenue: $4,230" },
  { type: "message", text: "Low stock alert — emailing Marketer to pause the ad." },
  { type: "email-out", subject: "Pause Classic Tee Instagram ad — only 3 left", address: "marketer@alook.ai" },
  { type: "email-in", subject: "Re: Paused. Switching budget to Hoodie campaign", address: "marketer@alook.ai" },
  { type: "email-out", subject: "Daily Store Report — May 23", address: "owner@company.com" },
];

const STORE_MARKETER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Pause Classic Tee Instagram ad — only 3 left", address: "ops@alook.ai" },
  { type: "message", text: "Paused. Switching budget to the Hoodie campaign instead." },
  { type: "email-out", subject: "Re: Paused. Switching budget to Hoodie campaign", address: "ops@alook.ai" },
];

export const storeOpsScript: UseCaseScript = {
  phases: [
    { agent: "planner", steps: STORE_OPS_STEPS },
    { agent: "coder", steps: STORE_MARKETER_STEPS },
  ],
  timeline: [
    { id: "trigger", duration: 2000 },
    { id: "ops-typing", duration: 1500 },
    { id: "ops-msg", duration: 2500 },
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
      return { activeAgent: "coder", steps: STORE_MARKETER_STEPS, visibleCount: vis, isTyping: isStepVisible(7) && !isStepVisible(8), isWorking: isStepVisible(6) && !isStepVisible(9) };
    }
    let vis = 0;
    if (isStepVisible(0)) vis = 1;
    if (isStepVisible(2)) vis = 2;
    if (isStepVisible(3)) vis = 3;
    if (isStepVisible(4)) vis = 4;
    if (isStepVisible(11)) vis = 5;
    if (isStepVisible(12)) vis = 6;
    return { activeAgent: "planner", steps: STORE_OPS_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(12) };
  },
};

/* ═══════════════════════════════════════════
   4. Bug Report → PR Ready
   User reports bug → Planner delegates → Coder fixes → PR merged
   ═══════════════════════════════════════════ */

const BUG_PLANNER_STEPS: DashboardStep[] = [
  { type: "user-message", text: "Safari crashes on login — can you fix it?" },
  { type: "message", text: "On it. Delegating to Coder." },
  { type: "email-out", subject: "Fix Safari flex gap in login page", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Fixed — PR #142 opened", address: "coder@alook.ai" },
  { type: "message", markdown: "Coder fixed it — <strong>PR #142</strong> merged. 42 tests passing." },
  { type: "email-out", subject: "Re: Login crashes on Safari — Fixed", address: "user@company.com" },
];

const BUG_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "Fix Safari flex gap in login page", address: "planner@alook.ai" },
  { type: "message", markdown: "Found the issue in <code>login-page.tsx:42</code>. Fixing..." },
  { type: "message", markdown: "Done — replaced flex gap → margin. <strong>42 tests passing ✓</strong>" },
  { type: "email-out", subject: "Re: Fixed — PR #142 opened", address: "planner@alook.ai" },
];

export const bugToPrScript: UseCaseScript = {
  phases: [
    { agent: "planner", steps: BUG_PLANNER_STEPS },
    { agent: "coder", steps: BUG_CODER_STEPS },
  ],
  timeline: [
    { id: "user-asks", duration: 2000 },
    { id: "planner-typing", duration: 1500 },
    { id: "planner-msg", duration: 1500 },
    { id: "planner-email-out", duration: 1800 },
    { id: "switch-coder", duration: 1000 },
    { id: "coder-email-in", duration: 1500 },
    { id: "coder-typing", duration: 1200 },
    { id: "coder-msg-1", duration: 1500 },
    { id: "coder-msg-2", duration: 1800 },
    { id: "coder-email-out", duration: 1800 },
    { id: "switch-planner", duration: 1000 },
    { id: "planner-email-in", duration: 1500 },
    { id: "planner-msg-2", duration: 1800 },
    { id: "planner-email-out-2", duration: 3000 },
  ],
  derive(isStepVisible) {
    const showCoder = isStepVisible(4) && !isStepVisible(10);
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
    if (isStepVisible(11)) vis = 4;
    if (isStepVisible(12)) vis = 5;
    if (isStepVisible(13)) vis = 6;
    return { activeAgent: "planner", steps: BUG_PLANNER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(13) };
  },
};

/* ═══════════════════════════════════════════
   5. "Post an update"
   User says "post about today's release" → Marketer asks Coder what shipped → posts
   ═══════════════════════════════════════════ */

const POST_MARKETER_STEPS: DashboardStep[] = [
  { type: "user-message", text: "Post something about today's release" },
  { type: "message", text: "I need to know what shipped. Asking Coder." },
  { type: "email-out", subject: "What did we ship today?", address: "coder@alook.ai" },
  { type: "email-in", subject: "Re: Calendar recurring, email forwarding, 3 fixes", address: "coder@alook.ai" },
  { type: "message", markdown: "Got it. Drafting and publishing now.<br/><br/>✓ Posted to X: <em>\"Just shipped: recurring calendar events, email forwarding, and squashed 3 bugs.\"</em>" },
];

const POST_CODER_STEPS: DashboardStep[] = [
  { type: "email-in", subject: "What did we ship today?", address: "marketer@alook.ai" },
  { type: "message", text: "Calendar recurring events, email forwarding, and 3 bug fixes." },
  { type: "email-out", subject: "Re: Calendar recurring, email forwarding, 3 fixes", address: "marketer@alook.ai" },
];

export const postUpdateScript: UseCaseScript = {
  phases: [
    { agent: "planner", steps: POST_MARKETER_STEPS },
    { agent: "coder", steps: POST_CODER_STEPS },
  ],
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
    return { activeAgent: "planner", steps: POST_MARKETER_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(11) };
  },
};

/* ═══════════════════════════════════════════
   6. "Fill this form"
   User drops PDF → Agent recalls from memory → fills all fields
   ═══════════════════════════════════════════ */

const FILL_STEPS: DashboardStep[] = [
  { type: "user-message", text: "Fill this for me — YC_Application_W27.pdf" },
  { type: "message", text: "I have most of this from memory. Let me check..." },
  { type: "message", markdown: `<strong>Recalled from memory:</strong><br/>✓ Company name, address, EIN<br/>✓ Founder name, email, background<br/>✓ Product description, tech stack<br/>✓ Revenue, team size, launch date` },
  { type: "message", markdown: "All <strong>31 fields</strong> filled. No questions needed.<br/><br/>📄 <code>YC_Application_W27_filled.pdf</code>" },
];

export const fillFormScript: UseCaseScript = {
  phases: [{ agent: "planner", steps: FILL_STEPS }],
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
    return { activeAgent: "planner", steps: FILL_STEPS, visibleCount: vis, isTyping: isStepVisible(1) && !isStepVisible(2), isWorking: isStepVisible(0) && !isStepVisible(4) };
  },
};
