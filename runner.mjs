import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const source =
  'https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview';
export async function fetchHtml(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      console.warn(`Compendium HTTP ${response.status}; retrying ${url}`);
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 5000));
      continue;
    }
    if (!response.ok) throw new Error(`Compendium HTTP ${response.status}: ${url}`);
    if (!response.headers.get('Content-Type')?.includes('text/html')) {
      throw new Error(`Compendium did not return HTML: ${url}`);
    }
    return response.text();
  }
  throw new Error(`Compendium retries exhausted: ${url}`);
}
export async function buildCompendium({
  parser,
  load = fetchHtml,
  previous,
  now = new Date().toISOString(),
  onTab = () => {},
} = {}) {
  parser ??= await import('./parser.mjs');
  if (previous) parser.compendiumDataSchema.parse(previous);
  const tabs = parser.parseCompendiumTabs(await load(source));
  const sheets = [];
  for (const tab of tabs) {
    const sheet = parser.parseCompendiumSheet(
      await load(`${source}/sheet?headers=true&gid=${encodeURIComponent(tab.gid)}`),
      tab.gid,
      tab.name,
    );
    if (!sheet.rows.length && tab.name !== 'Landing') {
      throw new Error(
        `Compendium ${tab.name} has no parsed rows; refusing to publish incomplete data`,
      );
    }
    sheets.push(sheet);
    onTab(sheet);
  }
  const next = parser.compendiumDataSchema.parse({ fetchedAt: now, tabs: sheets });
  if (previous && parser.stableStringify(previous.tabs) === parser.stableStringify(next.tabs)) {
    return { changed: false, data: previous };
  }
  return { changed: true, data: next };
}
export async function main(file = 'compendium.json') {
  let previous;
  try {
    previous = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.info('Creating the initial Compendium dataset');
  }
  const result = await buildCompendium({
    previous,
    onTab: (tab) => console.info(`${tab.name}: ${tab.rows.length} rows`),
  });
  if (result.changed) {
    await writeFile(`${file}.tmp`, `${JSON.stringify(result.data)}\n`);
    await rename(`${file}.tmp`, file);
    console.info(`Updated ${file} at ${result.data.fetchedAt}`);
  } else console.info(`Compendium is up to date; content unchanged since ${result.data.fetchedAt}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
