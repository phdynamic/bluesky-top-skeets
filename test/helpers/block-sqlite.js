// Makes requiring the native SQLite module fail, to prove the site starts without it when games are off.
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'better-sqlite3') throw new Error('better-sqlite3 is blocked for this test');
  return load.call(this, request, ...rest);
};
