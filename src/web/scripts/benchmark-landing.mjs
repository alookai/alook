import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const url = process.env.BENCH_URL ?? 'http://127.0.0.1:3026/';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Local benchmark only');
const runs = Number(process.env.BENCH_RUNS ?? 10);
const latency = Number(process.env.BENCH_LATENCY_MS ?? 0);
const downloadMbps = Number(process.env.BENCH_DOWNLOAD_MBPS ?? 0);
const cpuRate = Number(process.env.BENCH_CPU_RATE ?? 1);
const budget = process.env.BENCH_BUDGET_MS === undefined ? null : Number(process.env.BENCH_BUDGET_MS);
if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Invalid benchmark budget');
const output = process.env.BENCH_OUTPUT ?? '.alook-qa-scratch/landing-benchmark';
if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(latency) || latency < 0 || !Number.isFinite(downloadMbps) || downloadMbps < 0 || !Number.isFinite(cpuRate) || cpuRate < 1) throw new Error('Invalid benchmark parameters');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
 for (const [profile, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
  for (let run = 0; run < runs; run++) {
   const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
   const page = await context.newPage();
   const cdp = await context.newCDPSession(page);
   await cdp.send('Network.enable');
   await cdp.send('Network.setBlockedURLs', { urls: ['*googletagmanager.com/*', '*google-analytics.com/*', '*grafana.net/*'] });
   if (latency || downloadMbps) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: downloadMbps ? downloadMbps * 1000000 / 8 : -1, uploadThroughput: downloadMbps ? downloadMbps * 1000000 / 8 : -1 });
   await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
   await page.addInitScript(() => {
    window.__landingBench = { lcp: 0, fonts: 0, heroReady: 0 };
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.__landingBench.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    document.addEventListener('DOMContentLoaded', () => {
     document.fonts.ready.then(() => { window.__landingBench.fonts = performance.now(); });
     const check = () => {
      const hero = document.querySelector('.hero-section');
      const paper = hero?.querySelector('.tw-paper');
      const images = hero ? [...hero.querySelectorAll('img')] : [];
      if (hero && paper && document.fonts.status === 'loaded' && images.every(i => i.complete && i.naturalWidth > 0 && (!i.hasAttribute('data-remote-image-state') || i.dataset.remoteImageState === 'ready'))) {
       requestAnimationFrame(() => { window.__landingBench.heroReady = performance.now(); });
      } else requestAnimationFrame(check);
     };
     requestAnimationFrame(check);
    });
   });
   for (const cache of ['cold', 'warm']) {
    const errors = [];
    const onResponse = r => { if (new URL(r.url()).origin === new URL(url).origin && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); };
    page.on('response', onResponse);
    const onError = e => errors.push(e.message);
    page.on('pageerror', onError);
    const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (response.status() !== 200) throw new Error(`Homepage status ${response.status()}`);
    await page.waitForFunction(() => window.__landingBench.heroReady > 0, undefined, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const sample = await page.evaluate(() => {
     const nav = performance.getEntriesByType('navigation')[0];
     const resources = performance.getEntriesByType('resource');
     return { ...window.__landingBench, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, ttfb: nav.responseStart, load: nav.loadEventEnd, resources: resources.map(r => ({ name: new URL(r.name).origin + new URL(r.name).pathname, start: r.startTime, duration: r.duration, bytes: r.transferSize })), title: document.title };
    });
    page.off('pageerror', onError);
    page.off('response', onResponse);
    if (errors.length) throw new Error(errors.join('\n'));
    sample.firstScreen = Math.max(sample.fcp ?? 0, sample.lcp, sample.heroReady);
    results.push({ profile, cache, run, ...sample });
    if (run === 0) await page.screenshot({ path: path.join(output, `${profile}-${cache}.png`), animations: 'disabled' });
    console.log(JSON.stringify({ profile, cache, run, fcp: sample.fcp, lcp: sample.lcp, heroReady: sample.heroReady, ttfb: sample.ttfb }));
   }
   await context.close();
  }
 }
} finally { await browser.close(); }
const percentile = (xs, p) => xs.sort((a,b) => a-b)[Math.ceil(xs.length*p)-1];
const summary = [];
for (const profile of ['desktop','mobile']) for (const cache of ['cold','warm']) {
 const samples = results.filter(r => r.profile === profile && r.cache === cache);
 summary.push({ profile, cache, count: samples.length, ...Object.fromEntries(['fcp','lcp','heroReady','firstScreen','ttfb'].map(key => [key, Object.fromEntries([.5,.75,.95].map(p => [`p${p*100}`,percentile(samples.map(r => r[key]),p)]))])) });
}
const passed = budget === null ? null : summary.every(s => s.firstScreen.p95 < budget);
const report = { budgetMs: budget, passed, url, build: await readFile('.next/BUILD_ID','utf8'), platform: os.platform(), cpu: os.cpus()[0]?.model, chromium: browser.version(), network: { kind: 'loopback simulation; not internet measurement', latencyMs: latency, downloadMbps }, cpuThrottle: cpuRate, deviceScaleFactor: 1, serviceWorkers: 'blocked for both series', externalTelemetry: 'GTM, GA and Grafana blocked by CDP without request routing; browser cache remains enabled', summary, results };
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(summary,null,2));

if (passed === false) process.exitCode = 1;
