import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const shrinkMinRows = 10;
const shrinkMaxLoss = 0.2;
/** Names tabs whose rows dropped sharply (or vanished) versus the previous snapshot. */
export function shrunkTabs(previous, sheets) {
  // A retired tab is renamed "OLD X" and recreated as "X" under a new gid, so fall back to the name.
  const byGid = new Map(sheets.map((sheet) => [sheet.gid, sheet.rows.length]));
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet.rows.length]));
  const shrunk = [];
  for (const old of previous?.tabs ?? []) {
    if (old.rows.length < shrinkMinRows) continue;
    const rows = byGid.get(old.gid) ?? byName.get(old.name) ?? 0;
    if (rows < old.rows.length * (1 - shrinkMaxLoss)) {
      shrunk.push(`${old.name} ${old.rows.length}→${rows}`);
    }
  }
  return shrunk;
}
const goodArtifact = 'compendium-refresh-good';
const captureDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'compendium-refresh');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only completed, successful scheduled runs with a full parse reset the 24-hour clock.
export async function hasRecentGoodRefresh(now, api = githubApi) {
  const cutoff = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const current = await api(`/actions/runs/${process.env.GITHUB_RUN_ID}`);
  const { workflow_runs: runs } = await api(
    `/actions/workflows/${current.workflow_id}/runs?event=schedule&status=success&per_page=100&created=${encodeURIComponent('>' + cutoff)}`,
  );
  for (const run of runs) {
    if (String(run.id) === process.env.GITHUB_RUN_ID || new Date(run.created_at).getTime() <= new Date(cutoff).getTime()) continue;
    const { artifacts } = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
    if (artifacts.some((artifact) => artifact.name === goodArtifact && !artifact.expired)) return true;
    // Before captures were introduced, this exact runner failed on every rejected parse.
    const file = await api(`/contents/runner.mjs?ref=${encodeURIComponent(run.head_sha)}`);
    if (file.sha === '0cc4081c904a58144681bb9a3fb065d3465cef31') return true;
  }
  return false;
}
async function githubApi(path) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required to check refresh history');
  }
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Compendium refresh history HTTP ${response.status}`);
  return response.json();
}
export async function captureRejected({ attempt, downloads, shrunk, counts }, directory = captureDir) {
  await mkdir(directory, { recursive: true });
  for (const [index, download] of downloads.entries()) {
    await writeFile(join(directory, `attempt-${attempt}-${index}.html`), download.html);
  }
  await writeFile(join(directory, `attempt-${attempt}.json`), JSON.stringify({
    shrunk, counts, sources: downloads.map(({ url }, index) => ({ url, file: `attempt-${attempt}-${index}.html` })),
  }, null, 2));
}
export async function buildCompendium({
  parser,
  load = fetchHtml,
  previous,
  now = new Date().toISOString(),
  onTab = () => {},
  scheduled = process.env.GITHUB_EVENT_NAME === 'schedule',
  sleep = pause,
  capture = captureRejected,
  recentGood = hasRecentGoodRefresh,
  allowShrink = process.env.COMPENDIUM_ALLOW_SHRINK === '1',
} = {}) {
  parser ??= await import('./parser.mjs');
  if (previous) parser.compendiumDataSchema.parse(previous);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const downloads = [];
    const download = async (url) => {
      const html = await load(url);
      downloads.push({ url, html });
      return html;
    };
    const tabs = parser.parseCompendiumTabs(await download(source));
    const sheets = [];
    for (const tab of tabs) {
      const sheet = parser.parseCompendiumSheet(
        await download(`${source}/sheet?headers=true&gid=${encodeURIComponent(tab.gid)}`),
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
    const shrunk = allowShrink ? [] : shrunkTabs(previous, sheets);
    if (shrunk.length) {
      await capture({ attempt, downloads, shrunk, counts: {
        previous: (previous?.tabs ?? []).map(({ gid, name, rows }) => ({ gid, name, rows: rows.length })),
        parsed: sheets.map(({ gid, name, rows }) => ({ gid, name, rows: rows.length })),
      } });
      if (scheduled) {
        console.warn(`Compendium snapshot rejected, attempt ${attempt}/3 (${shrunk.join(', ')})`);
        if (attempt < 3) {
          await sleep(attempt * 5000);
          continue;
        }
        if (await recentGood(now)) {
          console.info(`Compendium keeping last good data (${shrunk.join(', ')}); full refresh succeeded within 24 hours`);
          return { changed: false, data: previous, rejected: true };
        }
        throw new Error(`Compendium has no good refresh within 24 hours (${shrunk.join(', ')}); keeping last good data`);
      }
      throw new Error(
        `Compendium tabs shrank sharply (${shrunk.join(', ')}); keeping the last good data. ` +
          'Re-run the workflow manually with allow_shrink enabled (COMPENDIUM_ALLOW_SHRINK=1) if this is deliberate',
      );
    }
    if (previous && parser.stableStringify(previous.tabs) === parser.stableStringify(next.tabs)) {
      return { changed: false, data: previous };
    }
    return { changed: true, data: next };
  }
}
export async function main(file = 'compendium.json', options = {}) {
  let previous;
  try {
    previous = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.info('Creating the initial Compendium dataset');
  }
  const result = await buildCompendium({
    ...options,
    previous,
    onTab: (tab) => console.info(`${tab.name}: ${tab.rows.length} rows`),
  });
  if (result.changed) {
    await writeFile(`${file}.tmp`, `${JSON.stringify(result.data)}\n`);
    await rename(`${file}.tmp`, file);
    console.info(`Updated ${file} at ${result.data.fetchedAt}`);
  } else if (!result.rejected) console.info(`Compendium is up to date; content unchanged since ${result.data.fetchedAt}`);
  // The artifact proves a full parse, even when the published content did not change.
  if (!result.rejected && process.env.GITHUB_ACTIONS === 'true') {
    await mkdir(captureDir, { recursive: true });
    await writeFile(join(captureDir, 'good.json'), JSON.stringify({ checkedAt: new Date().toISOString() }));
    await appendFile(process.env.GITHUB_OUTPUT, 'good=true\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
