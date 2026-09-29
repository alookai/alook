import {
  selectComposition,
  renderStill,
  openBrowser,
} from "@remotion/renderer";
import path from "node:path";
const browser = await openBrowser("chrome", {
  browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE,
});
const serveUrl = path.resolve("build");
const composition = await selectComposition({
  serveUrl,
  id: "AlookGTM",
  puppeteerInstance: browser,
});
for (const second of process.argv.slice(2).map(Number)) {
  await renderStill({
    serveUrl,
    composition,
    output: `out/check-${second}.png`,
    frame: Math.round(second * 30),
    puppeteerInstance: browser,
    onBrowserLog: (log) => console.log(log.text),
  });
  console.log(`Checked still ${second}s`);
}
await browser.close({ silent: true });
