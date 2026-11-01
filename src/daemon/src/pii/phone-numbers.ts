import { PHONE_NUMBER_PLANS } from "./phone-number-plans.js";

export const PHONE_NUMBERS_SOURCE = "const plans=" + JSON.stringify(PHONE_NUMBER_PLANS) + ";\n" + String.raw`
export default (text: string) => {
  let triggered = false;
  const patterns = new Map();
  const valid = (digits, plan) => {
    if (!patterns.has(plan)) patterns.set(plan, new RegExp("^(?:" + plan[1] + ")$"));
    return patterns.get(plan).test(digits);
  };
  const international = value => {
    const digits = value.replace(/\(0\)/g, "").replace(/\D/g, "");
    return digits.length <= 15 && plans.some(plan => digits.startsWith(plan[0]) && valid(digits.slice(plan[0].length), plan));
  };
  const national = value => {
    if (/^[+＋]/.test(value)) return international(value);
    const digits = value.replace(/\D/g, "");
    if (digits.startsWith("00")) return international(digits.slice(2));
    if (digits.length < 6 || digits.length > 15) return false;
    return plans.some(plan => valid(digits, plan) || (plan[2] && valid(digits.replace(new RegExp("^(?:" + plan[2] + ")"), ""), plan)));
  };
  const redact = () => { triggered = true; return "[REDACTED_PHONE]"; };
  let output = text.replace(/(?<![\p{L}\p{N}_@/.-])[+＋]\d[\d ().-]{3,48}\d(?![\p{L}\p{N}_@/-]|[ ().-]*\d)/gu, value => international(value) ? redact() : value);
  output = output.replace(/(?<![\p{L}\p{N}_])((?:phone(?:[ _-]?(?:number|no))?|telephone|tel|mobile(?:[ _-]?(?:number|no))?|cell(?:[ _-]?(?:phone|number|no))?|telefon|téléphone|teléfono|telefone|celular|телефон|手机号?|电话|電話|携帯|휴대폰|전화)["']?[ \t]*(?:[:=：][ \t]*["']?[ \t]*|[ \t]+))((?:[+＋]?\d|\(\d{1,5}\))[\d ().-]{3,48}\d)(?![\p{L}\p{N}_@/-]|[ ().-]*\d)/giu, (all, prefix, value) => national(value) ? prefix + redact() : all);
  output = output.replace(/(?<![A-Za-z0-9_./-])(?:1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?![A-Za-z0-9_/-])/g, redact);
  output = output.replace(/(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])/g, (value, offset) => {
    const before=output.slice(0,offset).match(/[a-fA-F0-9-]+$/)?.[0]||"", after=output.slice(offset+value.length).match(/^[a-fA-F0-9-]+/)?.[0]||"";
    const whole=before+value+after;
    return /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(whole)||/^[a-fA-F0-9]{32,}$/.test(whole)?value:redact();
  });
  return { text: output, triggered };
};`;
