// srv/test/evals/utils/format.mjs
// Tiny formatter for pretty console output without external deps

const supportsColor = () => {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout && process.stdout.isTTY);
};

const colorOn = supportsColor();
const wrap = (open, close) => (s) => (colorOn ? `${open}${s}${close}` : String(s));

export const colors = {
  bold: wrap('\u001b[1m', '\u001b[22m'),
  dim: wrap('\u001b[2m', '\u001b[22m'),
  cyan: wrap('\u001b[36m', '\u001b[39m'),
  green: wrap('\u001b[32m', '\u001b[39m'),
  yellow: wrap('\u001b[33m', '\u001b[39m'),
  red: wrap('\u001b[31m', '\u001b[39m'),
  gray: wrap('\u001b[90m', '\u001b[39m')
};

export const symbols = {
  ok: '✔',
  fail: '✖',
  warn: '⚠',
  info: 'ℹ',
  bullet: '•'
};

export function hr(char = '─', width = 60) {
  console.log(char.repeat(width));
}

export function section(title) {
  const line = '─'.repeat(Math.max(8, Math.min(70, String(title).length + 8)));
  console.log(colors.cyan(line));
  console.log(colors.bold(colors.cyan(`  ${title}`)));
  console.log(colors.cyan(line));
}

export function kv(label, value) {
  const l = colors.dim(String(label).padEnd(14));
  console.log(`${l} ${value}`);
}

export function bullet(text, color = colors.gray) {
  console.log(`${color(symbols.bullet)} ${text}`);
}

export function ok(text) {
  console.log(`${colors.green(symbols.ok)} ${text}`);
}

export function warn(text) {
  console.log(`${colors.yellow(symbols.warn)} ${text}`);
}

export function fail(text) {
  console.log(`${colors.red(symbols.fail)} ${text}`);
}

export function info(text) {
  console.log(`${colors.cyan(symbols.info)} ${text}`);
}

export function truncate(text, max = 240) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function measure(fn) {
  const t0 = Date.now();
  const out = await fn();
  return { out, ms: Date.now() - t0 };
}

