const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), vm = require('node:vm');
module.exports = function loadSource(file) {
  const filename = path.resolve(file);
  const context = { exports: {}, require(id) {
    if (!id.startsWith('.')) return require(id);
    const target = path.resolve(path.dirname(filename), id);
    if (target.endsWith('.json')) return JSON.parse(fs.readFileSync(target, 'utf8'));
    const source = [target, target + '.ts', target + '.tsx'].find(file => fs.existsSync(file));
    if (!source) throw new Error('Missing source dependency: ' + id);
    return module.exports(source);
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, context, { filename });
  return context.exports;
};
