const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {TextEncoder} = require('node:util');
const html = fs.readFileSync(path.resolve(__dirname, '../tools/usb_mirror.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function run(failure) {
  let now = 100, frameSequence = 1, connected = true;
  const commands = [], intervals = [], timeouts = [], elements = new Map();
  const element = name => {
    if (!elements.has(name)) elements.set(name, {
      listeners: new Map(), value: '', classList: {toggle() {}},
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      getBoundingClientRect() { return {left: 0, top: 0, width: 466, height: 466}; },
      setPointerCapture() {},
      getContext() { return {createImageData() { return {data: new Uint8ClampedArray(466*466*4)}; }, putImageData() {}}; },
    });
    return elements.get(name);
  };
  const context = vm.createContext({
    Uint8ClampedArray, DataView, TextEncoder, Math, JSON, Error,
    document: {querySelector: element, addEventListener() {}},
    window: {addEventListener() {}}, performance: {now: () => now},
    setInterval: f => intervals.push(f), setTimeout: f => timeouts.push(f),
    fetch: async (url, options) => {
      if (url === '/input') {
        if (!connected) throw Error('Disconnected');
        commands.push(JSON.parse(options.body)); return {ok: true};
      }
      if (!connected) return {ok: false};
      const data = new ArrayBuffer(434428), view = new DataView(data);
      view.setUint32(0, 0x334d4c41, true); view.setUint32(8, frameSequence, true);
      view.setUint16(16,466,true); view.setUint16(18,466,true);
      return {ok:true,arrayBuffer:async()=>data};
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  vm.runInContext(script, context); await settle();
  const event = {pointerId:1,clientX:20,clientY:30,preventDefault(){}};
  element('#screen').listeners.get('pointerdown')(event);
  element('#record').listeners.get('pointerdown')(event); await settle();
  assert.equal(commands.filter(c=>c.down).length,2);
  connected = false;
  if (failure === 'frame-age') { now = 5001; intervals[0](); }
  else { element('#screen').listeners.get('pointermove')({...event,clientX:40}); }
  await settle();
  connected = true; frameSequence = 2; timeouts.shift()(); await settle();
  const before = commands.length;
  intervals[0](); await settle();
  element('#screen').listeners.get('pointermove')({...event,clientX:50}); await settle();
  assert.equal(commands.length,before,`${failure}: held input resumed without a new pointerdown`);
  element('#screen').listeners.get('pointerdown')(event); await settle();
  assert.equal(commands.length,before+1,`${failure}: fresh pointerdown should work after recovery`);
  assert.equal(commands.at(-1).type,'touch'); assert.equal(commands.at(-1).down,true);
}

(async()=>{await run('frame-age');await run('input-failure');console.log('Held input retires across disconnect/reconnect; fresh input works.');})().catch(error=>{console.error(error);process.exitCode=1;});
