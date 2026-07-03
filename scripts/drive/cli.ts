import { attach } from './core';
import { screenshot, snapshot } from './verbs';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [verb] = process.argv.slice(2);

  if (!verb || verb === 'help') {
    console.log('Usage: npm run drive -- <status|screenshot|snapshot|click|type|keys|eval> [args]');
    return;
  }

  const { browser, page } = await attach();
  try {
    switch (verb) {
      case 'status': {
        console.log(`Attached to: ${page.url()} (title: ${await page.title()})`);
        break;
      }
      case 'screenshot': {
        const rest = process.argv.slice(3);
        const out = await screenshot(page, {
          selector: flag(rest, 'selector'),
          out: flag(rest, 'out')
        });
        console.log(out);
        break;
      }
      case 'snapshot': {
        console.log(await snapshot(page));
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
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
