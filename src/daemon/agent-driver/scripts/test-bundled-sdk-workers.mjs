import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const entry = process.argv[2];
if (!entry || !process.argv[3])
    throw new Error('Usage: test-bundled-sdk-workers.mjs <daemon-entry-url> <isolated-sdk-prefix>');
const daemon = await import(entry);
const repository = resolve('.');
const native = resolve(process.argv[3], 'node_modules');
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../src/testing/fixtures/sdk');
const prefix = mkdtempSync(join(tmpdir(), 'alook-bun-sdk-'));
const scoped = (name) => join(prefix, 'node_modules', ...name.split('/'));
const link = (name) => { const target = scoped(name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(join(native, ...name.split('/')), target, 'dir'); };
for (const name of ['@github/copilot-sdk', '@qoder-ai/qoder-agent-sdk', '@earendil-works/pi-ai', '@earendil-works/chord', '@earendil-works/pi-schema', '@earendil-works/pi-telemetry'])
    link(name);
const cursor = scoped('@cursor/sdk');
mkdirSync(cursor, { recursive: true });
writeFileSync(join(cursor, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version: 'fixture', type: 'module', exports: './index.mjs' }));
writeFileSync(join(cursor, 'index.mjs'), readFileSync(join(fixtures, 'cursor-sdk.mjs')));
const durable = scoped('@earendil-works/pi-durable');
mkdirSync(durable, { recursive: true });
const pkg = JSON.parse(readFileSync(join(native, '@earendil-works/pi-durable/package.json'), 'utf8'));
pkg.exports['.'] = './fixture.mjs';
writeFileSync(join(durable, 'package.json'), JSON.stringify(pkg));
symlinkSync(join(native, '@earendil-works/pi-durable/dist'), join(durable, 'dist'), 'dir');
const nativePi = pathToFileURL(join(native, '@earendil-works/pi-durable/dist/index.js')).href;
writeFileSync(join(durable, 'fixture.mjs'), readFileSync(join(fixtures, 'pi-harness.mjs'), 'utf8').replaceAll("'@earendil-works/pi-durable'", JSON.stringify(nativePi)));
process.env.QODER_PERSONAL_ACCESS_TOKEN = 'fixture-local-token';
process.chdir(prefix);
const wait = async (test, label) => { for (let i = 0; i < 1000; i++) {
    if (test())
        return;
    await new Promise(r => setTimeout(r, 10));
} throw new Error('Timed out:' + label); };
try {
    for (const [id, model, cli] of [['cursor-sdk', 'fixture-model'], ['qoder', 'native-fixture', 'qoder-cli.mjs'], ['copilot', 'native-fixture', 'copilot-cli.mjs'], ['pi-durable', 'faux/faux-1']]) {
        const root = join(prefix, 'workspace-' + id);
        mkdirSync(root, { recursive: true });
        let command;
        if (cli) {
            command = join(prefix, id + '-cli.mjs');
            writeFileSync(command, readFileSync(join(fixtures, cli), 'utf8').replace('#!/usr/bin/env node', '#!' + process.execPath), { mode: 0o700 });
        }
        const sdk = daemon.createAgentDriverSdk();
        const probe = await sdk.probe({ backend: id, command, includeModels: true });
        if (probe.status !== 'healthy')
            throw new Error('Probe failed ' + id + ':' + JSON.stringify(probe));
        const opened = await sdk.open({ backend: id, config: { model: { kind: 'named', name: model }, provider: { kind: 'default' }, command }, launch: { workingDirectory: root, instructions: { format: 'markdown', content: 'Bun fixture' }, launchId: 'bun-' + id } });
        if (!opened.ok)
            throw new Error(JSON.stringify(opened));
        const session = opened.session;
        const events = [];
        void (async () => { for await (const e of session.events)
            events.push(e); })();
        try {
            const first = await session.start({ id: 'first', kind: 'user', text: 'hold first' });
            if (first.status !== 'accepted')
                throw new Error(id + ':' + JSON.stringify(first));
            const busy = await session.send({ id: 'second', kind: 'user', text: 'second' });
            if (busy.status !== 'accepted')
                throw new Error(id + ':' + JSON.stringify(busy));
            writeFileSync(join(root, 'release'), 'go');
            await wait(() => session.snapshot().state === 'idle', id + ' first idle');
            rmSync(join(root, 'release'));
            const next = await session.send({ id: 'next', kind: 'user', text: 'hold interrupt' });
            if (next.status !== 'accepted')
                throw new Error(id + ':' + JSON.stringify(next));
            const interrupted = await session.interrupt({ requestId: 'interrupt', reason: 'test' });
            if (interrupted.status !== 'accepted')
                throw new Error(id + ':' + JSON.stringify(interrupted));
            await wait(() => session.snapshot().state === 'idle', id + ' interrupt idle');
            const results = events.filter(e => e.type === 'turn_completed').map(e => e.result.outcome);
            if (JSON.stringify(results) !== JSON.stringify(['success', 'interrupted']))
                throw new Error(id + ':' + JSON.stringify(results));
            await session.stop({ reason: 'shutdown', forceAfterMs: 300 });
            console.log(JSON.stringify({ id, probe: probe.status, catalog: probe.reasoning.models.length, first: first.status, busy: busy.delivery, results, closed: (await session.closed).outcome }));
            const managerRoot = join(prefix, 'manager-' + id);
            mkdirSync(managerRoot, { recursive: true });
            let managed;
            const nativeFactory = daemon.createBuiltinDaemonSessionFactory();
            const broker = { revokeAgent() { }, revoke() { }, mint() { return { voucher: "fixture", voucherFile: join(prefix, "voucher") }; } };
            writeFileSync(join(prefix, "voucher"), "fixture");
            const agentCliPath = join(dirname(fileURLToPath(entry)), "cli", "index.js");
            let opens = 0;
            let handler;
            const acknowledgements = [];
            const logger = { debug() { }, info() { }, warn() { }, error() { }, child() { return this; } };
            const manager = new daemon.AgentProcessManager({
                logger,
                driverFor: () => ({ id }),
                baseContextFor: agentId => ({ agentId, workingDirectory: managerRoot, standingPrompt: 'Managed fixture', agentCliPath, credentialProxy: { broker, proxyUrl: 'http://127.0.0.1:9', runnerKey: 'fixture', capabilities: [] } }),
                sessionFactory: async (input) => {
                    managed = await nativeFactory(input);
                    opens++;
                    return managed;
                },
                wakePromptFooter: 'Use alook inbox pull.',
            });
            const channel = { onCommand: fn => { handler = fn; }, reportReady: async () => { }, reportAgentSession: async () => { }, reportWakeAck: async (ack) => acknowledgements.push(ack), reportSessionError: async (error) => { throw new Error(JSON.stringify(error)); }, reportAgentTyping() { }, onResync() { } };
            const router = new daemon.AgentRouter({ manager, channel, logger, runtimeReport: [{ id, status: 'healthy' }], formatUnreadNoticeText: notice => 'hold WAKE ' + notice.latestSeq });
            try {
                await router.start();
                const wake = latestSeq => ({ type: 'agent:wake', agentId: 'fixture-agent', launchId: 'wake-' + latestSeq, config: { version: 1, runtime: id, model: { kind: 'named', name: model }, provider: { kind: 'default' }, mode: { kind: 'default' }, command }, unreadNotice: { kind: 'unread_notice', channel: '/fixture#1234/general', latestSeq } });
                await handler(wake(1));
                await wait(() => manager.snapshot().agents['fixture-agent']?.status === 'running', id + ' manager running');
                await handler(wake(2));
                await wait(() => managed.snapshot().activeTurn?.commandIds.length === 2, id + ' manager busy admission');
                if (acknowledgements.length !== 2 || acknowledgements.some(ack => ack.status !== 'ok'))
                    throw new Error(id + ' manager wake ack failed');
                writeFileSync(join(managerRoot, 'release'), 'go');
                await wait(() => managed.snapshot().state === 'idle' && !manager.snapshot().agents['fixture-agent']?.turnActive, id + ' manager idle');
                if (opens !== 1 || managed.snapshot().diagnostics.metrics.physicalOpenCount !== 1)
                    throw new Error(id + ' lost persistent manager lane');
                console.log(JSON.stringify({ id, manager: 'wake-during-work', acks: acknowledgements.length, opens, turnActive: manager.snapshot().agents['fixture-agent'].turnActive, sessionState: managed.snapshot().state }));
            }
            finally {
                await manager.stopAll();
            }
        }
        finally {
            await session.stop({ reason: 'shutdown', forceAfterMs: 300 });
        }
    }
}
finally {
    process.chdir(repository);
    rmSync(prefix, { recursive: true, force: true });
}
