// Windows argument quoting for spawn({ shell: true }).
//
// Node's child_process.spawn does NOT quote individual args when `shell: true`
// is set on Windows — it joins them with spaces and hands the raw string to
// cmd.exe. Any arg containing whitespace (e.g. --dir C:\Users\John Doe\...) is
// then split by cmd, causing "Failed to change dir to C:\Users\John".
//
// We can't drop `shell: true` because Node has blocked spawning .cmd/.bat
// shims without a shell since CVE-2024-27980, and every npm-installed CLI we
// launch (opencode, claude, codex) lands as a .cmd shim on Windows. So we
// pre-quote each argument here.
//
// Strategy: wrap in double quotes whenever the arg contains whitespace or any
// cmd.exe metachar (& | < > ^ ( ) " %), then apply the MSVCRT rules for
// escaping backslashes and inner quotes. Inside "..." cmd itself does not
// interpret & | < > ^ ( ) — so no ^-escaping is needed once quoted.
//
// Known cmd.exe residuals (out of scope for this helper — they are limitations
// of ALL shell:true spawns on Windows, not regressions of this fix):
//   - CR/LF inside an arg terminates the cmd command line. Multi-line prompts
//     have to be delivered via stdin or a temp file, not argv, on Windows.
//   - %VAR% still expands inside "...". There is no reliable command-line
//     escape for % on Windows (%% only works in batch files). If arbitrary
//     user text with literal % must reach the child, use stdin.
// Both were broken before this fix and remain broken; the space-in-path bug
// (the reported one) is fully addressed.

const NEEDS_QUOTING = /[\s"&|<>^()%]/;

export function quoteWinArg(arg: string): string {
  if (arg.length > 0 && !NEEDS_QUOTING.test(arg)) return arg;

  let result = "\"";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === "\"") {
      result += "\\".repeat(backslashes * 2 + 1) + "\"";
    } else {
      result += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2) + "\"";
  return result;
}

export function quoteWinArgs(args: string[]): string[] {
  return args.map(quoteWinArg);
}
