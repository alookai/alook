import { ID_NUMBERS_SOURCE } from "./id-numbers.js";
import { PHONE_NUMBERS_SOURCE } from "./phone-numbers.js";

export const PII_DEFAULTS = [
  {
    id: "builtin.secrets", name: "Keys", description: "Redacts keys, tokens and passwords.",
    source: String.raw`export default (text: string) => { let triggered = false; const output = text
  .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, () => { triggered = true; return "[REDACTED_PRIVATE_KEY]"; })
  .replace(/(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[0-9A-Za-z-]{10,}|(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9_+\/-]{20,}={0,2}|sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|(?:cmk|cmt|crk|vch)_[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g, () => { triggered = true; return "[REDACTED_API_KEY]"; })
  .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, () => { triggered = true; return "[REDACTED_TOKEN]"; }).replace(/(\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+={0,2}/gi, (all, prefix) => { if (!/Authorization/i.test(prefix) && all.length-prefix.length < 8) return all; triggered = true; return prefix+"[REDACTED_TOKEN]"; })
  .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:)([^\s@/?#"'<>]{3,})(@)/g, (_all, prefix, _value, suffix) => { triggered = true; return prefix+"[REDACTED_PASSWORD]"+suffix; }).replace(/(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=~!@#%^&*]{8,})/gi, (all, prefix, value) => { const field = prefix.replace(/["'\s:=]+$/g, ""); if (/(?:id|ids|uuid|guid|hash|digest|checksum|cursor)$/i.test(field) || /^(?:process\.env|os\.)/.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value)) return all; triggered = true; return prefix + "[REDACTED_SECRET]"; }); return { text: output, triggered }; };`,
  },
  {
    id: "builtin.emails", name: "Email addresses", description: "Redacts email addresses.",
    source: String.raw`export default (text: string) => { let triggered = false; const output = text.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9_%+-]|\.[A-Za-z0-9-])/g, value => /\.(?:png|jpe?g|gif|webp|svg|txt|md|tsx?|jsx?|json|css|log)$/i.test(value) ? value : (triggered = true, "[REDACTED_EMAIL]")); return { text: output, triggered }; };`,
  },
  {
    id: "builtin.id-cards", name: "ID numbers", description: "Redacts supported ID, social-security and personal tax numbers",
    source: ID_NUMBERS_SOURCE,
  },
  {
    id: "builtin.phones", name: "Phone numbers", description: "Redacts phone numbers",
    source: PHONE_NUMBERS_SOURCE,
  },
  {
    id: "builtin.bank-cards", name: "Bank cards", description: "Redacts bank card numbers.",
    source: String.raw`export default (text: string) => { let triggered = false; const output = text.replace(/(?<![A-Za-z0-9])[3-6](?:[ -]?\d){12,18}(?![A-Za-z0-9])/g, (value,offset) => { const before=text.slice(0,offset).match(/[a-fA-F0-9-]+$/)?.[0]||"",after=text.slice(offset+value.length).match(/^[a-fA-F0-9-]+/)?.[0]||""; if(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(before+value+after))return value; const digits=value.replace(/[ -]/g,""); let sum=0,twice=false; for(let i=digits.length-1;i>=0;i--){let n=+digits[i];if(twice){n*=2;if(n>9)n-=9;}sum+=n;twice=!twice;}return sum%10===0?(triggered=true,"[REDACTED_BANK_CARD]"):value; }); return { text: output, triggered }; };`,
  },
] as const;
