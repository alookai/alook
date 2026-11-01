export const ID_NUMBERS_SOURCE = String.raw`export default (text: string) => {
  let triggered = false;
  const marker = "[REDACTED_ID_CARD]";
  const digits = (value: string) => [...value].map(Number);
  const weighted = (value: string, weights: number[]) => digits(value).reduce((sum, n, i) => sum + n * weights[i], 0);
  const date = (year: number, month: number, day: number) => {
    const value = new Date(Date.UTC(year, month - 1, day));
    return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
  };
  const label = (names: string) => new RegExp("(?:^|[^A-Za-z0-9_])(?:" + names + ")(?:[ _-]*(?:number|no\\.?|nummer|n[°º]))?[\"']?[ \\t]*[:=#：]?[ \\t]*[\"']?$", "i");
  const redact = (pattern: RegExp, valid: (value: string) => boolean, context?: RegExp) => {
    text = text.replace(pattern, (value: string, offset: number, body: string) => {
      const before = body.slice(0, offset), after = body.slice(offset + value.length);
      if (/[A-Za-z0-9_]$/.test(before) || /^[A-Za-z0-9_]/.test(after) || /[A-Za-z0-9_][./-]$/.test(before) || /^[./-][A-Za-z0-9_]/.test(after)) return value;
      const contextMatch = context?.exec(before);
      if (context && (!contextMatch || contextMatch[0].length > 96 || /^\d/.test(value) && /^[ .-]\d/.test(after))) return value;
      if (!valid(value.replace(/[ .()-]/g, "").toUpperCase())) return value;
      triggered = true;
      return marker;
    });
  };
  const varied = (value: string) => !/^(\d)\1+$/.test(value);

  redact(/[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, value =>
    date(+value.slice(6, 10), +value.slice(10, 12), +value.slice(12, 14)) && value.slice(14, 17) !== "000" &&
    "10X98765432"[weighted(value.slice(0, 17), [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2]) % 11] === value[17]);

  redact(/[A-Z]{1,2}\d{6}(?:\([\dA]\)|[\dA])/gi, value => {
    const body = value.slice(0, -1).padStart(8, " ");
    const sum = [...body].reduce((sum, c, i) => sum + (c === " " ? 36 : /[A-Z]/.test(c) ? c.charCodeAt(0) - 55 : +c) * (9 - i), 0);
    return "0123456789A"[(11 - sum % 11) % 11] === value.at(-1);
  });
  redact(/[A-Z][12]\d{8}/gi, value => {
    const code = [10,11,12,13,14,15,16,17,34,18,19,20,21,22,35,23,24,25,26,27,28,29,32,30,31,33][value.charCodeAt(0) - 65];
    return (Math.floor(code / 10) + code % 10 * 9 + weighted(value.slice(1), [8,7,6,5,4,3,2,1,1])) % 10 === 0;
  });
  redact(/(?:\d{8}|[XYZ]\d{7})[ -]?[A-Z]/gi, value => {
    const body = value.slice(0, -1).replace(/^[XYZ]/, c => String("XYZ".indexOf(c)));
    return "TRWAGMYFPDXBNJZSQVHLCKE"[+body % 23] === value.at(-1);
  });
  redact(/[A-Z]{6}[\dLMNPQRSTUV]{2}[ABCDEHLMPRST][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z]/gi, value => {
    const decode = (s: string) => +s.replace(/[LMNPQRSTUV]/g, c => String("LMNPQRSTUV".indexOf(c)));
    const day = decode(value.slice(9, 11));
    if (!date(2000 + decode(value.slice(6, 8)), "ABCDEHLMPRST".indexOf(value[8]) + 1, day > 40 ? day - 40 : day)) return false;
    const odd = [1,0,5,7,9,13,15,17,19,21,2,4,18,20,11,3,6,8,12,14,16,10,22,25,24,23];
    const sum = [...value.slice(0, 15)].reduce((sum, c, i) => {
      const n = /\d/.test(c) ? +c : c.charCodeAt(0) - 65;
      return sum + (i % 2 === 0 ? odd[n] : n);
    }, 0);
    return String.fromCharCode(65 + sum % 26) === value[15];
  });

  redact(/\d{3}[- ]?\d{2}[- ]?\d{4}/g, value =>
    varied(value) && !/^(?:000|666|9\d{2})/.test(value) && value.slice(3, 5) !== "00" && value.slice(5) !== "0000",
    label("ssn|social[ _-]+security(?:[ _-]+number)?"));
  redact(/\d{3}[- ]?\d{3}[- ]?\d{3}/g, value => {
    const sum = digits(value).reduce((sum, n, i) => { const doubled = n * (i % 2 ? 2 : 1); return sum + (doubled > 9 ? doubled - 9 : doubled); }, 0);
    return !/^[08]/.test(value) && varied(value) && sum % 10 === 0;
  }, label("sin|nas|social[ _-]+insurance(?:[ _-]+number)?|numéro[ ]+d['’]assurance[ ]+sociale"));
  redact(/[A-Z]{2}(?: ?\d{2}){3} ?[A-D]/gi, value =>
    /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]/.test(value) && !/^(?:BG|GB|KN|NK|NT|TN|ZZ)/.test(value),
    label("nino|national[ _-]+insurance(?:[ _-]+number)?"));
  redact(/[1-9]\d ?\d{3} ?\d{3} ?\d{3}/g, value => {
    const counts = Array(10).fill(0);
    for (const n of value.slice(0, 10)) counts[+n]++;
    const sorted = counts.filter(n => n > 0).sort().join("");
    if ((sorted !== "111111112" && sorted !== "11111113") || /(\d)\1\1/.test(value.slice(0, 10))) return false;
    let product = 10;
    for (const n of value.slice(0, 10)) product = 2 * ((+n + product) % 10 || 10) % 11;
    return (11 - product) % 10 === +value[10];
  }, label("steuer[ -]?id|steueridentifikationsnummer|idnr\\.?|german[ ]+tax[ ]+id"));
  redact(/[CFGHJKLMNPRTVWXYZ][0-9CFGHJKLMNPRTVWXYZ]{8}/gi, () => true,
    label("personalausweis(?:nummer)?|ausweisnummer|german[ ]+id"));
  redact(/[12] ?\d{2} ?\d{2} ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3} ?\d{2}/gi, value => {
    const month = +value.slice(3, 5);
    const numeric = value.slice(0, 13).replace("2A", "19").replace("2B", "18");
    return (month >= 1 && month <= 12 || month >= 20 && month <= 99) && 97 - +numeric % 97 === +value.slice(13);
  }, label("nir|numéro[ ]+(?:de[ ]+)?sécurité[ ]+sociale|french[ ]+social[ ]+security"));
  redact(/(?:\d{12}|[A-Z0-9]{9})/gi, () => true,
    label("cni|carte[ ]+nationale[ ]+d['’]identité|french[ ]+id"));
  redact(/[A-Z]{2}\d{5}[A-Z]{2}/gi, () => true,
    label("cie|carta[ ]+d['’]identità|italian[ ]+id"));

  redact(/[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}/g, value => {
    const product = ["0123456789","1234067895","2340178956","3401289567","4012395678","5987604321","6598710432","7659821043","8765932104","9876543210"];
    const permutation = ["0123456789","1576283094","5803796142","8916043527","9453126870","4286573901","2793806415","7046913258"];
    let check = 0;
    digits(value).reverse().forEach((n, i) => { check = +product[check][+permutation[i % 8][n]]; });
    return varied(value) && check === 0;
  }, label("aadhaar|aadhar|आधार(?:[ ]+(?:नंबर|संख्या))?"));
  redact(/\d{4}[ -]?\d{4}[ -]?\d{4}/g, value => {
    const remainder = weighted(value.slice(0, 11), [6,5,4,3,2,7,6,5,4,3,2]) % 11;
    return varied(value) && (remainder <= 1 ? 0 : 11 - remainder) === +value[11];
  }, label("my[ _-]+number|個人番号|マイナンバー"));
  redact(/\d{6}[- ]?[1-8]\d{6}/g, value => {
    const century = [1900,1900,2000,2000,1900,1900,2000,2000][+value[6] - 1];
    return date(century + +value.slice(0, 2), +value.slice(2, 4), +value.slice(4, 6));
  }, label("rrn|resident[ _-]+registration(?:[ _-]+number)?|주민등록번호|외국인등록번호"));
  redact(/[STFGM]\d{7}[A-Z]/gi, () => true, label("nric|fin"));
  redact(/\d{3} ?\d{3} ?\d{3}/g, value =>
    varied(value) && weighted(value, [1,4,3,7,5,8,6,9,10]) % 11 === 0,
    label("tfn|tax[ _-]+file(?:[ _-]+number)?"));
  redact(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, value => {
    if (!varied(value)) return false;
    for (let size = 9; size <= 10; size++) {
      const sum = digits(value.slice(0, size)).reduce((sum, n, i) => sum + n * (size + 1 - i), 0);
      const remainder = sum % 11;
      if ((remainder < 2 ? 0 : 11 - remainder) !== +value[size]) return false;
    }
    return true;
  }, label("cpf|cadastro[ ]+de[ ]+pessoas[ ]+físicas"));
  return { text, triggered };
};`;
