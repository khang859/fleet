import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Page } from 'playwright';
import {
  screenshot,
  snapshot,
  click,
  type,
  keys,
  evalExpr,
  settle,
  listCommands,
  runCommand
} from './verbs';
import { FIXTURES, fixtureNames } from './fixtures';
import { parseScript } from './run-script';
import { restartDevApp, startDevApp, stopDevApp } from './dev-app';
import { keySequence, readTerminal, sendToTerminal, waitForTerminal } from './terminal';

export const DEFAULT_TIMEOUT_MS = 5000;
/** A TUI starting up (Claude Code, say) routinely takes longer than a click. */
const TERM_WAIT_TIMEOUT_MS = 30_000;

interface VerbContext {
  /** Attaches on first use, so verbs that never touch the window never wait for it. */
  page: () => Promise<Page>;
  root: string;
  /** The caller's working directory, for relative `--out` and `run` paths. */
  cwd: string;
  stdin?: string;
  describeDaemon: () => string;
}

interface VerbResult {
  output: string;
  warnings: string[];
}

const STRING_FLAGS = ['selector', 'out', 'timeout', 'pane'] as const;
const BOOLEAN_FLAGS = ['png', 'refs', 'shot', 'all', 'enter'] as const;

type StringFlag = (typeof STRING_FLAGS)[number];
type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type Flag = StringFlag | BooleanFlag;

type FlagValues = Partial<Record<StringFlag, string> & Record<BooleanFlag, boolean>>;

function isOneOf<T extends string>(list: readonly T[], name: string): name is T {
  return list.some((item) => item === name);
}

/**
 * Split a verb's arguments into flags and text. Not `util.parseArgs`: verbs
 * take free text (`eval '-1+1'`, `term-send 'echo -n hi'`), and parseArgs reads
 * any leading dash as a flag - it rejects the text, or with `strict: false`
 * quietly turns it into flags. Here only `--name` or `--name=value` for a known
 * flag is a flag, and `--` makes everything after it text.
 */
export function parseVerbArgs(args: string[]): { values: FlagValues; positionals: string[] } {
  const values: FlagValues = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    const flag = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!flag) {
      positionals.push(arg);
      continue;
    }
    const name = flag[1];
    // `.at` keeps the undefined an unmatched optional group really is; `[2]` types it string.
    const inline = flag.at(2);
    if (isOneOf(BOOLEAN_FLAGS, name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      values[name] = true;
    } else if (isOneOf(STRING_FLAGS, name)) {
      const value = inline ?? args.at(++i);
      if (value === undefined) throw new Error(`--${name} needs a value`);
      values[name] = value;
    } else {
      throw new Error(`Unknown flag: ${arg}. To pass it as text, put it after \`--\`.`);
    }
  }
  return { values, positionals };
}

/** Every verb takes `--timeout`; these are the rest each one accepts. */
const VERB_FLAGS: Partial<Record<string, Flag[]>> = {
  status: [],
  screenshot: ['selector', 'out', 'png'],
  snapshot: ['refs'],
  click: ['shot'],
  type: ['shot'],
  keys: ['shot'],
  eval: ['shot'],
  fixture: ['shot'],
  cmd: ['shot'],
  term: ['pane', 'all'],
  'term-send': ['pane', 'enter', 'shot'],
  'term-key': ['pane', 'shot'],
  'term-wait': ['pane', 'all'],
  run: [],
  stop: [],
  up: [],
  restart: []
};

export const VERBS = Object.keys(VERB_FLAGS);

function need(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

export async function runVerb(ctx: VerbContext, argv: string[]): Promise<VerbResult> {
  const [verb, ...rest] = argv;
  const allowed = VERB_FLAGS[verb];
  if (!allowed) throw new Error(`Unknown verb: ${verb}. Try one of: ${VERBS.join(', ')}`);

  const { values, positionals } = parseVerbArgs(rest);
  for (const name of Object.keys(values)) {
    if (name !== 'timeout' && !isOneOf(allowed, name)) {
      throw new Error(`${verb} does not take --${name}`);
    }
  }
  const timeout = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error(`Bad --timeout: ${values.timeout}`);

  const warnings: string[] = [];
  const page = async (): Promise<Page> => {
    const p = await ctx.page();
    p.setDefaultTimeout(timeout);
    return p;
  };
  // An action with `--shot` prints what it did, then the path of what it looks like now.
  const act = async (done: string, action: (p: Page) => Promise<unknown>): Promise<VerbResult> => {
    const p = await page();
    await action(p);
    if (!values.shot) return { output: done, warnings };
    await settle(p);
    const shot = await screenshot(p, {});
    if (shot.warning) warnings.push(shot.warning);
    return { output: `${done}\n${shot.path}`, warnings };
  };

  switch (verb) {
    case 'status': {
      const p = await page();
      return {
        output: `Attached to: ${p.url()} (title: ${await p.title()})\n${ctx.describeDaemon()}`,
        warnings
      };
    }
    case 'screenshot': {
      const shot = await screenshot(await page(), {
        selector: values.selector,
        out: values.out,
        png: values.png,
        cwd: ctx.cwd
      });
      if (shot.warning) warnings.push(shot.warning);
      return { output: shot.path, warnings };
    }
    case 'snapshot':
      return { output: await snapshot(await page(), { refs: values.refs }), warnings };
    case 'click': {
      const sel = need(positionals.at(0), 'click requires a selector');
      return act(`clicked: ${sel}`, async (p) => click(p, sel));
    }
    case 'type': {
      const sel = need(positionals.at(0), 'type requires <selector> <text>');
      const text = need(positionals.at(1), 'type requires <selector> <text>');
      return act(`typed into: ${sel}`, async (p) => type(p, sel, text));
    }
    case 'keys': {
      const chord = need(positionals.at(0), 'keys requires a chord, e.g. Meta+K');
      return act(`pressed: ${chord}`, async (p) => keys(p, chord));
    }
    case 'eval': {
      const expr = need(positionals.at(0), 'eval requires a JS expression');
      let result = '';
      const done = await act('', async (p) => (result = await evalExpr(p, expr)));
      return { output: `${result}${done.output}`, warnings };
    }
    case 'fixture': {
      const name = positionals.at(0);
      if (name === undefined) {
        const list = fixtureNames().map((n) => `  ${n}\n    ${FIXTURES[n].describe}\n`);
        return { output: ['Usage: fixture <name>\n', ...list].join('\n'), warnings };
      }
      if (!(name in FIXTURES)) {
        throw new Error(`Unknown fixture: ${name}. Try one of: ${fixtureNames().join(', ')}`);
      }
      let result = '';
      const done = await act('', async (p) => (result = await evalExpr(p, FIXTURES[name].source)));
      return { output: `${result}${done.output}`, warnings };
    }
    case 'cmd': {
      const id = positionals.at(0);
      if (id === undefined) return { output: await listCommands(await page()), warnings };
      return act(`ran: ${id}`, async (p) => runCommand(p, id));
    }
    case 'term':
      return { output: await readTerminal(await page(), values.pane, values.all), warnings };
    case 'term-send': {
      const text = need(positionals.at(0), 'term-send requires <text>');
      const data = values.enter ? `${text}\r` : text;
      return act(`sent: ${JSON.stringify(data)}`, async (p) =>
        sendToTerminal(p, data, values.pane)
      );
    }
    case 'term-key': {
      if (positionals.length === 0) throw new Error('term-key requires one or more key names');
      const data = keySequence(positionals);
      return act(`pressed in pane: ${positionals.join(' ')}`, async (p) =>
        sendToTerminal(p, data, values.pane)
      );
    }
    case 'term-wait': {
      const pattern = need(positionals.at(0), 'term-wait requires a regular expression');
      const wait = values.timeout === undefined ? TERM_WAIT_TIMEOUT_MS : timeout;
      return {
        output: await waitForTerminal(await page(), pattern, wait, values.pane, values.all),
        warnings
      };
    }
    case 'run':
      return runScript(ctx, positionals.at(0));
    case 'stop':
      return { output: await stopDevApp(page), warnings };
    case 'up':
      return { output: await startDevApp(ctx.root), warnings };
    case 'restart':
      return { output: await restartDevApp(ctx.root, page), warnings };
  }
  throw new Error(`Unhandled verb: ${verb}`);
}

/**
 * Run a script of verb lines on the one connection, stopping at the first
 * failure. Output is each step's own output under its line, then the total.
 */
async function runScript(ctx: VerbContext, file: string | undefined): Promise<VerbResult> {
  const source =
    file !== undefined && file !== '-'
      ? readFileSync(resolve(ctx.cwd, file), 'utf8')
      : need(ctx.stdin, 'run requires a script file, or the script on stdin');
  const steps = parseScript(source);
  const started = Date.now();
  const out: string[] = [];
  const warnings: string[] = [];
  for (const step of steps) {
    if (step.argv[0] === 'run') throw new Error(`line ${step.line}: run cannot run another run`);
    let result: VerbResult;
    try {
      result = await runVerb(ctx, step.argv);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const done = out.length > 0 ? `${out.join('\n')}\n` : '';
      throw new Error(`${done}line ${step.line} failed: ${step.text}\n${message}`);
    }
    out.push(`> ${step.text}`);
    if (result.output !== '') out.push(result.output);
    warnings.push(...result.warnings.map((w) => `line ${step.line}: ${w}`));
  }
  out.push(`${steps.length} steps in ${Date.now() - started} ms`);
  return { output: out.join('\n'), warnings };
}
