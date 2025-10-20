// Minimal process shim for browser environments
// Some UMD/ESM bundles expect `process.env.NODE_ENV` to exist.
// This shim is safe and non-invasive for production usage in the browser.
(function () {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : self);
    if (!g.process) {
      g.process = { env: { NODE_ENV: 'production' } };
    } else if (!g.process.env) {
      g.process.env = { NODE_ENV: 'production' };
    } else if (typeof g.process.env.NODE_ENV === 'undefined') {
      g.process.env.NODE_ENV = 'production';
    }
  } catch (e) {
    // ignore
  }
})();

