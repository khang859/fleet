import { attach } from './core';
import { screenshot, snapshot, click, type, keys, evalExpr } from './verbs';

function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const verb = process.argv.at(2);

  if (!verb || verb === 'help') {
    print('Usage: npm run drive -- <status|screenshot|snapshot|click|type|keys|eval> [args]');
    return;
  }

  const { browser, page } = await attach();
  try {
    switch (verb) {
      case 'status': {
        print(`Attached to: ${page.url()} (title: ${await page.title()})`);
        break;
      }
      case 'screenshot': {
        const rest = process.argv.slice(3);
        const out = await screenshot(page, {
          selector: flag(rest, 'selector'),
          out: flag(rest, 'out')
        });
        print(out);
        break;
      }
      case 'snapshot': {
        print(await snapshot(page));
        break;
      }
      case 'click': {
        const sel = process.argv.at(3);
        if (!sel) throw new Error('click requires a selector');
        await click(page, sel);
        print(`clicked: ${sel}`);
        break;
      }
      case 'type': {
        const sel = process.argv.at(3);
        const text = process.argv.at(4);
        if (!sel || text === undefined) throw new Error('type requires <selector> <text>');
        await type(page, sel, text);
        print(`typed into: ${sel}`);
        break;
      }
      case 'keys': {
        const chord = process.argv.at(3);
        if (!chord) throw new Error('keys requires a chord, e.g. Meta+K');
        await keys(page, chord);
        print(`pressed: ${chord}`);
        break;
      }
      case 'eval': {
        const expr = process.argv.at(3);
        if (!expr) throw new Error('eval requires a JS expression');
        print(await evalExpr(page, expr));
        break;
      }
      default:
        throw new Error(`Unknown verb: ${verb}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
