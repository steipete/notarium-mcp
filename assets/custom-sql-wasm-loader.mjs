import { createRequire } from 'module';

// Create a require function relative to the current module (custom-sql-wasm-loader.mjs)
const require = createRequire(import.meta.url);

// Attempt to pre-initialize a global Module object, as Emscripten might expect
// @ts-ignore
if (typeof global !== 'undefined' && typeof global.Module === 'undefined') {
  // @ts-ignore
  global.Module = {};
} else if (typeof window !== 'undefined' && typeof window.Module === 'undefined') {
  // @ts-ignore
  window.Module = {}; // For browser-like environments tsx might emulate
}

// Require the CJS module. Since custom-sql-wasm.js does `module.exports = initSqlJs`
// and `module.exports.default = initSqlJs`, the result of require should be the function itself
// or an object with a .default property.
const cjsModule = require('./custom-sql-wasm.js');

let initSqlJsToExport;

if (typeof cjsModule === 'function') {
  initSqlJsToExport = cjsModule;
} else if (cjsModule && typeof cjsModule.default === 'function') {
  initSqlJsToExport = cjsModule.default;
} else {
  console.error('Failed to find initSqlJs in custom-sql-wasm.js. Loaded module:', cjsModule);
  // @ts-ignore
  if (typeof global !== 'undefined' && global.Module && typeof global.Module.initSqlJs === 'function') {
    // @ts-ignore
    initSqlJsToExport = global.Module.initSqlJs;
  // @ts-ignore
  } else if (typeof window !== 'undefined' && window.Module && typeof window.Module.initSqlJs === 'function') {
    // @ts-ignore
    initSqlJsToExport = window.Module.initSqlJs;
  }
}

if (!initSqlJsToExport) {
  // @ts-ignore
  const globalModule = typeof global !== 'undefined' ? global.Module : (typeof window !== 'undefined' ? window.Module : undefined);
  console.error('Still failed to find initSqlJs. Global Module object:', globalModule);
  throw new Error('Could not load initSqlJs function from custom-sql-wasm.js');
}

export default initSqlJsToExport; 