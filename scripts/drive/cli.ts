import { attach } from './core';

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
