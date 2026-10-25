export const PII_DEFAULTS = [
  {
    id: "builtin.private-keys", name: "Private keys", description: "Redacts PEM private key blocks.",
    source: String.raw`export default (text: string): string => text.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, "[REDACTED_PRIVATE_KEY]");`,
  },
  {
    id: "builtin.api-keys", name: "API keys", description: "Redacts recognized API key and Alook credential formats.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[0-9A-Za-z-]{10,}|(?:sk|rk)_live_[0-9A-Za-z]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|(?:cmk|cmt|crk|vch)_[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g, "[REDACTED_API_KEY]");`,
  },
  {
    id: "builtin.tokens", name: "Tokens", description: "Redacts JWTs and Authorization bearer/basic values.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, "[REDACTED_TOKEN]").replace(/(\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+={0,2}/gi, (all, prefix) => /Authorization/i.test(prefix) || all.length-prefix.length >= 8 ? prefix+"[REDACTED_TOKEN]" : all);`,
  },
  {
    id: "builtin.secrets", name: "Passwords and secrets", description: "Redacts credential assignments and passwords in connection URLs.",
    source: String.raw`export default (text: string): string => text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:)([^\s@/?#"'<>]{3,})(@)/g, "$1[REDACTED_PASSWORD]$3").replace(/(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=~!@#%^&*]{8,})/gi, (all, prefix, value) => { const field = prefix.replace(/["'\s:=]+$/g, ""); return /(?:id|ids|uuid|guid|hash|digest|checksum|cursor)$/i.test(field) || /^(?:process\.env|os\.)/.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value) ? all : prefix + "[REDACTED_SECRET]"; });`,
  },
  {
    id: "builtin.emails", name: "Email addresses", description: "Redacts email addresses in the message body.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9_%+-]|\.[A-Za-z0-9-])/g, value => /\.(?:png|jpe?g|gif|webp|svg|txt|md|tsx?|jsx?|json|css|log)$/i.test(value) ? value : "[REDACTED_EMAIL]");`,
  },
  {
    id: "builtin.id-cards", name: "Chinese ID cards", description: "Redacts 18-character Chinese ID numbers with a valid date and checksum.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![A-Za-z0-9])/g, value => { const year=+value.slice(6,10),month=+value.slice(10,12),day=+value.slice(12,14),date=new Date(Date.UTC(year,month-1,day)); if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return value; const weights=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2]; const sum=weights.reduce((sum,w,i)=>sum+(+value[i])*w,0); return "10X98765432"[sum%11]===value[17].toUpperCase()?"[REDACTED_ID_CARD]":value; });`,
  },
  {
    id: "builtin.phones", name: "Phone numbers", description: "Redacts mainland China mobile numbers, including +86 prefixes.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])/g, (value,offset) => { const before=text.slice(0,offset).match(/[a-fA-F0-9-]+$/)?.[0]||"",after=text.slice(offset+value.length).match(/^[a-fA-F0-9-]+/)?.[0]||""; const whole=before+value+after; return /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(whole)||/^[a-fA-F0-9]{32,}$/.test(whole)?value:"[REDACTED_PHONE]"; });`,
  },
  {
    id: "builtin.bank-cards", name: "Bank cards", description: "Redacts 13–19 digit card numbers that pass the Luhn check.",
    source: String.raw`export default (text: string): string => text.replace(/(?<![A-Za-z0-9])[3-6](?:[ -]?\d){12,18}(?![A-Za-z0-9])/g, (value,offset) => { const before=text.slice(0,offset).match(/[a-fA-F0-9-]+$/)?.[0]||"",after=text.slice(offset+value.length).match(/^[a-fA-F0-9-]+/)?.[0]||""; if(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(before+value+after))return value; const digits=value.replace(/[ -]/g,""); let sum=0,twice=false; for(let i=digits.length-1;i>=0;i--){let n=+digits[i];if(twice){n*=2;if(n>9)n-=9;}sum+=n;twice=!twice;}return sum%10===0?"[REDACTED_BANK_CARD]":value; });`,
  },
] as const;
