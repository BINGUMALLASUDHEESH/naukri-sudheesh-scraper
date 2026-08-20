/**
 * Naukri "AI Gen AI Jobs" scraper
 * ---------------------------------------------------------------
 * - Loads pages 1..N (or ALL pages, computed from noOfJobs / page size)
 * - Captures the /jobapi/v3/search JSON response for each page
 * - Flattens jobDetails[] into rows and appends them to a CSV
 * - Writes a log file recording which pages completed / failed
 * - On rerun, already-COMPLETED pages are skipped automatically,
 *   so a crash mid-run does not lose previously scraped data.
 *
 * THREE MODES:
 *
 * 1) Simple/local mode (default) - scrape pages 1..PAGES sequentially,
 *    writing to naukri_jobs.csv / scrape_log.txt.
 *      node index.js            -> uses CONFIG.PAGES below (default 3)
 *      PAGES=3 node index.js    -> override via env var
 *      PAGES=ALL node index.js  -> scrape every page Naukri reports
 *      FORCE=1 node index.js    -> ignore log, re-scrape every page
 *
 * 2) Resolve-only mode - fetch page 1, work out the total page count,
 *    write it to $GITHUB_OUTPUT (or stdout), then exit. No CSV/log
 *    written. Used by the workflow's "resolve" job so the 15 parallel
 *    shards below know how many total pages exist without each of
 *    them re-fetching page 1 separately.
 *      RESOLVE_ONLY=1 node index.js
 *
 * 3) Sharded/parallel mode - scrape only a specific inclusive page
 *    range, writing to naukri_jobs_shard<SHARD_ID>.csv and
 *    scrape_log_shard<SHARD_ID>.txt so multiple runners can work in
 *    parallel without colliding on the same output files.
 *      SHARD_ID=1 START_PAGE=1 END_PAGE=94 node index.js
 *      SHARD_ID=2 START_PAGE=95 END_PAGE=188 node index.js
 *      ...etc
 * ---------------------------------------------------------------
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ------------------------- CONFIG -------------------------
const SHARD_ID = process.env.SHARD_ID || ''; // e.g. "1".."15" when running as part of a parallel matrix
const shardSuffix = SHARD_ID ? `_shard${SHARD_ID}` : '';

const CONFIG = {
  // 3 for local testing by default. Ignored when START_PAGE/END_PAGE
  // are set (sharded mode) or RESOLVE_ONLY=1 (resolve-only mode).
  PAGES: process.env.PAGES || 3,

  // Sharded mode: scrape only this inclusive page range. Set by the
  // GitHub Actions matrix job so each of the 15 parallel runners
  // covers a distinct slice of the total pages.
  START_PAGE: process.env.START_PAGE ? parseInt(process.env.START_PAGE, 10) : null,
  END_PAGE: process.env.END_PAGE ? parseInt(process.env.END_PAGE, 10) : null,

  // Resolve-only mode: just fetch page 1, compute the total page
  // count, write it out, and exit. See header comment above.
  RESOLVE_ONLY: process.env.RESOLVE_ONLY === '1',

  BASE_KEYWORD_PARAM: 'k=ai%20gen%20ai%20jobs',
  BASE_KEYWORD_PARAM_PLUS: 'k=ai+gen+ai+jobs',
  FIRST_PAGE_URL: 'https://www.naukri.com/ai-gen-ai-jobs?k=ai%20gen%20ai%20jobs',
  PAGE_URL_TEMPLATE: (n) => `https://www.naukri.com/ai-gen-ai-jobs-${n}?k=ai+gen+ai+jobs`,
  JOBS_PER_PAGE_FALLBACK: 20, // used only to estimate total pages if 'ALL' is requested / resolve mode

  OUTPUT_DIR: __dirname,
  // File names get a _shardN suffix automatically when SHARD_ID is set,
  // so 15 parallel runners never write to (or collide on) the same file.
  CSV_FILE: path.join(__dirname, `naukri_jobs${shardSuffix}.csv`),
  LOG_FILE: path.join(__dirname, `scrape_log${shardSuffix}.txt`),
  RAW_JSON_DIR: path.join(__dirname, `raw_pages${shardSuffix}`),

  NAV_TIMEOUT_MS: 60000,
  WAIT_AFTER_LOAD_MS: 8000,
  RETRIES_PER_PAGE: 3,
  DELAY_BETWEEN_PAGES_MS: 3000,
  FORCE_RESTART: process.env.FORCE === '1',

  // Self-imposed time budget for this run/shard. When elapsed time
  // crosses this, the script stops picking up new pages and exits
  // gracefully so progress already written to disk is never lost.
  // Default: 170 minutes (safely under a typical 340-minute job timeout).
  RUN_BUDGET_MS: (parseInt(process.env.RUN_BUDGET_MINUTES, 10) || 170) * 60 * 1000,
};

// ------------------------- CSV COLUMNS -------------------------
const CSV_COLUMNS = [
  'pageNumber',
  'jobId',
  'title',
  'companyName',
  'groupId',
  'companyId',
  'isTopGroup',
  'tagsAndSkills',
  'jobDescription',
  'location',
  'salaryLabel',
  'currency',
  'minimumSalary',
  'maximumSalary',
  'hideSalary',
  'variablePercentage',
  'minSalaryPerMonth',
  'maxSalaryPerMonth',
  'experienceText',
  'minimumExperience',
  'maximumExperience',
  'footerPlaceholderLabel',
  'createdDateISO',
  'createdDateRaw',
  'mode',
  'board',
  'vacancy',
  'jobType',
  'walkinJob',
  'walkin_contactName',
  'walkin_contactPhone',
  'walkin_dailyTiming',
  'walkin_venueAddress',
  'walkin_startDate',
  'walkin_endDate',
  'companyApplyJob',
  'companyApplyUrl',
  'applyRedirectUrl',
  'applyByTime',
  'jdURL',
  'staticUrl',
  'ambitionBoxUrl',
  'ambitionBoxReviewsCount',
  'ambitionBoxRating',
  'roleCategoryGid',
  'todaysJob',
  'jobAgentEligle',
  'consultant',
  'hiringFor',
  'hideClientName',
  'clientTitleString',
  'brandedJDTemplateId',
  'questionnaireIdPresent',
  'exclusive',
  'diversityTagText',
  'logoPath',
];

// ------------------------- HELPERS -------------------------

function ensureDirs() {
  if (!fs.existsSync(CONFIG.RAW_JSON_DIR)) {
    fs.mkdirSync(CONFIG.RAW_JSON_DIR, { recursive: true });
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r?\n/g, ' ').trim();
  if (/[",]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function writeCsvHeaderIfNeeded() {
  if (!fs.existsSync(CONFIG.CSV_FILE)) {
    fs.writeFileSync(CONFIG.CSV_FILE, CSV_COLUMNS.join(',') + '\n', 'utf8');
  }
}

function appendJobsToCsv(rows) {
  if (!rows.length) return;
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape(row[col])).join(',')
  );
  fs.appendFileSync(CONFIG.CSV_FILE, lines.join('\n') + '\n', 'utf8');
}

function logLine(message) {
  const stamp = new Date().toISOString();
  const prefix = SHARD_ID ? `[shard ${SHARD_ID}] ` : '';
  const line = `[${stamp}] ${prefix}${message}`;
  console.log(line);
  fs.appendFileSync(CONFIG.LOG_FILE, line + '\n', 'utf8');
}

// Read the log file and figure out which page numbers already completed.
function getCompletedPages() {
  if (CONFIG.FORCE_RESTART) return new Set();
  if (!fs.existsSync(CONFIG.LOG_FILE)) return new Set();
  const text = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
  const completed = new Set();
  const regex = /PAGE (\d+) COMPLETED/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    completed.add(Number(m[1]));
  }
  return completed;
}

function findPlaceholder(placeholders, type) {
  if (!Array.isArray(placeholders)) return '';
  const found = placeholders.find((p) => p.type === type);
  return found ? found.label : '';
}

function flattenJob(job, pageNumber) {
  const salaryDetail = job.salaryDetail || {};
  const walkin = job.walkInDetail || {};
  const ambition = job.ambitionBoxData || {};
  const branded = job.brandedJD || {};

  let createdDateISO = '';
  if (job.createdDate) {
    try {
      createdDateISO = new Date(job.createdDate).toISOString();
    } catch (e) {
      createdDateISO = '';
    }
  }

  return {
    pageNumber,
    jobId: job.jobId || '',
    title: job.title || '',
    companyName: job.companyName || '',
    groupId: job.groupId || '',
    companyId: job.companyId || '',
    isTopGroup: job.isTopGroup ?? '',
    tagsAndSkills: job.tagsAndSkills || '',
    jobDescription: job.jobDescription || '',
    location: findPlaceholder(job.placeholders, 'location'),
    salaryLabel: findPlaceholder(job.placeholders, 'salary'),
    currency: job.currency || salaryDetail.currency || '',
    minimumSalary: salaryDetail.minimumSalary ?? '',
    maximumSalary: salaryDetail.maximumSalary ?? '',
    hideSalary: salaryDetail.hideSalary ?? '',
    variablePercentage: salaryDetail.variablePercentage ?? '',
    minSalaryPerMonth: salaryDetail.minSalaryPerMonth ?? '',
    maxSalaryPerMonth: salaryDetail.maxSalaryPerMonth ?? '',
    experienceText: job.experienceText || '',
    minimumExperience: job.minimumExperience || '',
    maximumExperience: job.maximumExperience || '',
    footerPlaceholderLabel: job.footerPlaceholderLabel || '',
    createdDateISO,
    createdDateRaw: job.createdDate || '',
    mode: job.mode || '',
    board: job.board || '',
    vacancy: job.vacancy ?? '',
    jobType: job.jobType || '',
    walkinJob: job.walkinJob ?? '',
    walkin_contactName: walkin.contactName || '',
    walkin_contactPhone: walkin.contactPhone || '',
    walkin_dailyTiming: walkin.dailyTiming || '',
    walkin_venueAddress: walkin.venueAddress || '',
    walkin_startDate: walkin.walkinStartDate || '',
    walkin_endDate: walkin.walkinEndDate || '',
    companyApplyJob: job.companyApplyJob ?? '',
    companyApplyUrl: job.companyApplyUrl || '',
    applyRedirectUrl: job.applyRedirectUrl || '',
    applyByTime: job.applyByTime || '',
    jdURL: job.jdURL ? `https://www.naukri.com${job.jdURL}` : '',
    staticUrl: job.staticUrl || '',
    ambitionBoxUrl: ambition.Url || '',
    ambitionBoxReviewsCount: ambition.ReviewsCount ?? '',
    ambitionBoxRating: ambition.AggregateRating || '',
    roleCategoryGid: job.roleCategoryGid || '',
    todaysJob: job.todaysJob ?? '',
    jobAgentEligle: job.jobAgentEligle ?? '',
    consultant: job.consultant ?? '',
    hiringFor: job.hiringFor || '',
    hideClientName: job.hideClientName ?? '',
    clientTitleString: job.clientTitleString || '',
    brandedJDTemplateId: branded.templateId ?? '',
    questionnaireIdPresent: job.questionnaireIdPresent ?? '',
    exclusive: job.exclusive ?? '',
    diversityTagText: job.diversityTagText || '',
    logoPath: job.logoPath || '',
  };
}

function pageUrl(pageNumber) {
  return pageNumber === 1 ? CONFIG.FIRST_PAGE_URL : CONFIG.PAGE_URL_TEMPLATE(pageNumber);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapePage(context, pageNumber) {
  const page = await context.newPage();
  let apiResponse = null;

  const responseHandler = async (response) => {
    const url = response.url();
    if (url.includes('/jobapi/v3/search') && response.status() === 200) {
      try {
        const data = await response.json();
        apiResponse = data;
      } catch (err) {
        // ignore parse errors, handled by caller via null check
      }
    }
  };

  page.on('response', responseHandler);

  try {
    await page.goto(pageUrl(pageNumber), {
      waitUntil: 'networkidle',
      timeout: CONFIG.NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(CONFIG.WAIT_AFTER_LOAD_MS);
  } finally {
    page.off('response', responseHandler);
    await page.close();
  }

  return apiResponse;
}

async function scrapePageWithRetries(context, pageNumber) {
  for (let attempt = 1; attempt <= CONFIG.RETRIES_PER_PAGE; attempt++) {
    try {
      logLine(`PAGE ${pageNumber} attempt ${attempt}/${CONFIG.RETRIES_PER_PAGE} - loading ${pageUrl(pageNumber)}`);
      const data = await scrapePage(context, pageNumber);
      if (data && Array.isArray(data.jobDetails)) {
        return data;
      }
      logLine(`PAGE ${pageNumber} attempt ${attempt} - no valid API response captured (possible captcha/block)`);
    } catch (err) {
      logLine(`PAGE ${pageNumber} attempt ${attempt} - ERROR: ${err.message}`);
    }
    if (attempt < CONFIG.RETRIES_PER_PAGE) {
      await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
    }
  }
  return null;
}

function resolveTotalPagesFromData(firstPageData) {
  const noOfJobs = firstPageData?.noOfJobs || 0;
  const perPage =
    (firstPageData?.jobDetails && firstPageData.jobDetails.length) ||
    CONFIG.JOBS_PER_PAGE_FALLBACK;
  return Math.max(1, Math.ceil(noOfJobs / perPage));
}

// ------------------------- RESOLVE-ONLY MODE -------------------------
// Fetches page 1, computes the total page count, writes it to
// $GITHUB_OUTPUT (or prints it) and exits. Used once, up front, by the
// "resolve" job so the 15 parallel shards each know their page range
// without every shard having to re-fetch page 1 individually.
async function runResolveOnly() {
  console.log('RESOLVE_ONLY mode: fetching page 1 to determine total page count...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  try {
    const data = await scrapePageWithRetriesStandalone(context);
    if (!data) {
      console.error('RESOLVE_ONLY: failed to fetch page 1 after retries. Aborting.');
      await browser.close();
      process.exit(1);
    }
    const totalPages = resolveTotalPagesFromData(data);
    console.log(`RESOLVE_ONLY: noOfJobs=${data.noOfJobs}, totalPages=${totalPages}`);

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `total_pages=${totalPages}\n`, 'utf8');
    } else {
      // Local fallback: just print it clearly
      console.log(`total_pages=${totalPages}`);
    }
  } finally {
    await browser.close();
  }
}

// Standalone retry helper for resolve-only mode (doesn't depend on CONFIG.LOG_FILE/logLine
// since resolve-only mode writes no log file).
async function scrapePageWithRetriesStandalone(context) {
  for (let attempt = 1; attempt <= CONFIG.RETRIES_PER_PAGE; attempt++) {
    try {
      console.log(`Resolve attempt ${attempt}/${CONFIG.RETRIES_PER_PAGE} - loading page 1`);
      const data = await scrapePage(context, 1);
      if (data && Array.isArray(data.jobDetails)) {
        return data;
      }
    } catch (err) {
      console.error(`Resolve attempt ${attempt} - ERROR: ${err.message}`);
    }
    if (attempt < CONFIG.RETRIES_PER_PAGE) {
      await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
    }
  }
  return null;
}

// ------------------------- MAIN SCRAPE (simple or sharded mode) -------------------------

async function runScrape() {
  ensureDirs();
  writeCsvHeaderIfNeeded();

  const completedPages = getCompletedPages();
  const runStartTime = Date.now();
  if (completedPages.size > 0) {
    logLine(`Resuming run. Already-completed pages found in log: [${[...completedPages].sort((a, b) => a - b).join(', ')}]`);
  } else {
    logLine('Starting fresh run (no completed pages found in log, or FORCE=1 was set).');
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  try {
    // Determine the page range to scrape.
    let firstPage;
    let lastPage;

    if (CONFIG.START_PAGE && CONFIG.END_PAGE) {
      // SHARDED MODE: range is explicit, no need to resolve totals.
      firstPage = CONFIG.START_PAGE;
      lastPage = CONFIG.END_PAGE;
      logLine(`SHARDED MODE: scraping pages ${firstPage}-${lastPage}`);
    } else {
      // SIMPLE MODE (legacy): 1..PAGES, resolving 'ALL' from page 1 if needed.
      firstPage = 1;
      lastPage = String(CONFIG.PAGES).toUpperCase() === 'ALL' ? null : parseInt(CONFIG.PAGES, 10);
    }

    for (let pageNumber = firstPage; lastPage === null || pageNumber <= lastPage; pageNumber++) {
      if (completedPages.has(pageNumber)) {
        logLine(`PAGE ${pageNumber} already COMPLETED, skipping.`);
        continue;
      }

      const elapsed = Date.now() - runStartTime;
      if (elapsed >= CONFIG.RUN_BUDGET_MS) {
        logLine(
          `RUN BUDGET REACHED (${Math.round(elapsed / 60000)} min elapsed) - stopping gracefully at page ${pageNumber}. ` +
          `Progress so far is saved; a future run can resume from here.`
        );
        break;
      }

      const data = await scrapePageWithRetries(context, pageNumber);

      if (!data) {
        logLine(`PAGE ${pageNumber} FAILED after ${CONFIG.RETRIES_PER_PAGE} attempts - will retry on next run.`);
        continue;
      }

      // Legacy simple-mode 'ALL' resolution: figure out lastPage from page 1's response.
      if (lastPage === null) {
        lastPage = resolveTotalPagesFromData(data);
        logLine(`PAGES=ALL -> resolved totalPages=${lastPage}`);
      }

      fs.writeFileSync(
        path.join(CONFIG.RAW_JSON_DIR, `page_${pageNumber}.json`),
        JSON.stringify(data, null, 2),
        'utf8'
      );

      const rows = data.jobDetails.map((job) => flattenJob(job, pageNumber));
      appendJobsToCsv(rows);
      logLine(`PAGE ${pageNumber} COMPLETED - ${rows.length} jobs written`);
      completedPages.add(pageNumber);

      await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
    }

    logLine(`Run finished. Page range targeted: ${firstPage}-${lastPage}. Completed pages: [${[...completedPages].sort((a, b) => a - b).join(', ')}]`);
  } catch (err) {
    logLine(`FATAL ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }
}

// ------------------------- ENTRY POINT -------------------------

(async () => {
  if (CONFIG.RESOLVE_ONLY) {
    await runResolveOnly();
    return;
  }
  await runScrape();
})();


















































































// /**
//  * Naukri "AI Gen AI Jobs" scraper
//  * ---------------------------------------------------------------
//  * - Loads pages 1..N (or ALL pages, computed from noOfJobs / page size)
//  * - Captures the /jobapi/v3/search JSON response for each page
//  * - Flattens jobDetails[] into rows and appends them to a CSV
//  * - Writes a log file recording which pages completed / failed
//  * - On rerun, already-COMPLETED pages are skipped automatically,
//  *   so a crash mid-run does not lose previously scraped data.
//  *
//  * Usage:
//  *   node index.js            -> uses CONFIG.PAGES below (default 3, or PAGES env var)
//  *   PAGES=3 node index.js    -> override via env var
//  *   PAGES=ALL node index.js  -> scrape every page Naukri reports
//  *   FORCE=1 node index.js    -> ignore log, re-scrape every page
//  * ---------------------------------------------------------------
//  */

// const { chromium } = require('playwright');
// const fs = require('fs');
// const path = require('path');

// // ------------------------- CONFIG -------------------------
// const CONFIG = {
//   // 3 for local testing by default. Override with PAGES=ALL or PAGES=<n>
//   // as an environment variable (this is how the GitHub Actions workflow drives it).
//   PAGES: process.env.PAGES || 3,
//   BASE_KEYWORD_PARAM: 'k=ai%20gen%20ai%20jobs',
//   BASE_KEYWORD_PARAM_PLUS: 'k=ai+gen+ai+jobs', // used on paginated URLs, matches sample given
//   FIRST_PAGE_URL: 'https://www.naukri.com/ai-gen-ai-jobs?k=ai%20gen%20ai%20jobs',
//   PAGE_URL_TEMPLATE: (n) => `https://www.naukri.com/ai-gen-ai-jobs-${n}?k=ai+gen+ai+jobs`,
//   JOBS_PER_PAGE_FALLBACK: 20, // used only to estimate total pages if 'ALL' is requested
//   OUTPUT_DIR: __dirname,
//   CSV_FILE: path.join(__dirname, 'naukri_jobs.csv'),
//   LOG_FILE: path.join(__dirname, 'scrape_log.txt'),
//   RAW_JSON_DIR: path.join(__dirname, 'raw_pages'), // keep raw page JSON too, handy for debugging
//   NAV_TIMEOUT_MS: 60000,
//   WAIT_AFTER_LOAD_MS: 8000,
//   RETRIES_PER_PAGE: 3,
//   DELAY_BETWEEN_PAGES_MS: 3000,
//   FORCE_RESTART: process.env.FORCE === '1',
// };

// // ------------------------- CSV COLUMNS -------------------------
// // Fixed superset of columns. Any job missing a field just gets "".
// const CSV_COLUMNS = [
//   'pageNumber',
//   'jobId',
//   'title',
//   'companyName',
//   'groupId',
//   'companyId',
//   'isTopGroup',
//   'tagsAndSkills',
//   'jobDescription',
//   'location',
//   'salaryLabel',
//   'currency',
//   'minimumSalary',
//   'maximumSalary',
//   'hideSalary',
//   'variablePercentage',
//   'minSalaryPerMonth',
//   'maxSalaryPerMonth',
//   'experienceText',
//   'minimumExperience',
//   'maximumExperience',
//   'footerPlaceholderLabel',
//   'createdDateISO',
//   'createdDateRaw',
//   'mode',
//   'board',
//   'vacancy',
//   'jobType',
//   'walkinJob',
//   'walkin_contactName',
//   'walkin_contactPhone',
//   'walkin_dailyTiming',
//   'walkin_venueAddress',
//   'walkin_startDate',
//   'walkin_endDate',
//   'companyApplyJob',
//   'companyApplyUrl',
//   'applyRedirectUrl',
//   'applyByTime',
//   'jdURL',
//   'staticUrl',
//   'ambitionBoxUrl',
//   'ambitionBoxReviewsCount',
//   'ambitionBoxRating',
//   'roleCategoryGid',
//   'todaysJob',
//   'jobAgentEligle',
//   'consultant',
//   'hiringFor',
//   'hideClientName',
//   'clientTitleString',
//   'brandedJDTemplateId',
//   'questionnaireIdPresent',
//   'exclusive',
//   'diversityTagText',
//   'logoPath',
// ];

// // ------------------------- HELPERS -------------------------

// function ensureDirs() {
//   if (!fs.existsSync(CONFIG.RAW_JSON_DIR)) {
//     fs.mkdirSync(CONFIG.RAW_JSON_DIR, { recursive: true });
//   }
// }

// function csvEscape(value) {
//   if (value === null || value === undefined) return '';
//   let s = String(value);
//   // Strip newlines so rows stay on one line; keep it readable.
//   s = s.replace(/\r?\n/g, ' ').trim();
//   if (/[",]/.test(s)) {
//     s = '"' + s.replace(/"/g, '""') + '"';
//   }
//   return s;
// }

// function writeCsvHeaderIfNeeded() {
//   if (!fs.existsSync(CONFIG.CSV_FILE)) {
//     fs.writeFileSync(CONFIG.CSV_FILE, CSV_COLUMNS.join(',') + '\n', 'utf8');
//   }
// }

// function appendJobsToCsv(rows) {
//   if (!rows.length) return;
//   const lines = rows.map((row) =>
//     CSV_COLUMNS.map((col) => csvEscape(row[col])).join(',')
//   );
//   fs.appendFileSync(CONFIG.CSV_FILE, lines.join('\n') + '\n', 'utf8');
// }

// function logLine(message) {
//   const stamp = new Date().toISOString();
//   const line = `[${stamp}] ${message}`;
//   console.log(line);
//   fs.appendFileSync(CONFIG.LOG_FILE, line + '\n', 'utf8');
// }

// // Read the log file and figure out which page numbers already completed.
// function getCompletedPages() {
//   if (CONFIG.FORCE_RESTART) return new Set();
//   if (!fs.existsSync(CONFIG.LOG_FILE)) return new Set();
//   const text = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
//   const completed = new Set();
//   const regex = /PAGE (\d+) COMPLETED/g;
//   let m;
//   while ((m = regex.exec(text)) !== null) {
//     completed.add(Number(m[1]));
//   }
//   return completed;
// }

// function findPlaceholder(placeholders, type) {
//   if (!Array.isArray(placeholders)) return '';
//   const found = placeholders.find((p) => p.type === type);
//   return found ? found.label : '';
// }

// function flattenJob(job, pageNumber) {
//   const salaryDetail = job.salaryDetail || {};
//   const walkin = job.walkInDetail || {};
//   const ambition = job.ambitionBoxData || {};
//   const branded = job.brandedJD || {};

//   let createdDateISO = '';
//   if (job.createdDate) {
//     try {
//       createdDateISO = new Date(job.createdDate).toISOString();
//     } catch (e) {
//       createdDateISO = '';
//     }
//   }

//   return {
//     pageNumber,
//     jobId: job.jobId || '',
//     title: job.title || '',
//     companyName: job.companyName || '',
//     groupId: job.groupId || '',
//     companyId: job.companyId || '',
//     isTopGroup: job.isTopGroup ?? '',
//     tagsAndSkills: job.tagsAndSkills || '',
//     jobDescription: job.jobDescription || '',
//     location: findPlaceholder(job.placeholders, 'location'),
//     salaryLabel: findPlaceholder(job.placeholders, 'salary'),
//     currency: job.currency || salaryDetail.currency || '',
//     minimumSalary: salaryDetail.minimumSalary ?? '',
//     maximumSalary: salaryDetail.maximumSalary ?? '',
//     hideSalary: salaryDetail.hideSalary ?? '',
//     variablePercentage: salaryDetail.variablePercentage ?? '',
//     minSalaryPerMonth: salaryDetail.minSalaryPerMonth ?? '',
//     maxSalaryPerMonth: salaryDetail.maxSalaryPerMonth ?? '',
//     experienceText: job.experienceText || '',
//     minimumExperience: job.minimumExperience || '',
//     maximumExperience: job.maximumExperience || '',
//     footerPlaceholderLabel: job.footerPlaceholderLabel || '',
//     createdDateISO,
//     createdDateRaw: job.createdDate || '',
//     mode: job.mode || '',
//     board: job.board || '',
//     vacancy: job.vacancy ?? '',
//     jobType: job.jobType || '',
//     walkinJob: job.walkinJob ?? '',
//     walkin_contactName: walkin.contactName || '',
//     walkin_contactPhone: walkin.contactPhone || '',
//     walkin_dailyTiming: walkin.dailyTiming || '',
//     walkin_venueAddress: walkin.venueAddress || '',
//     walkin_startDate: walkin.walkinStartDate || '',
//     walkin_endDate: walkin.walkinEndDate || '',
//     companyApplyJob: job.companyApplyJob ?? '',
//     companyApplyUrl: job.companyApplyUrl || '',
//     applyRedirectUrl: job.applyRedirectUrl || '',
//     applyByTime: job.applyByTime || '',
//     jdURL: job.jdURL ? `https://www.naukri.com${job.jdURL}` : '',
//     staticUrl: job.staticUrl || '',
//     ambitionBoxUrl: ambition.Url || '',
//     ambitionBoxReviewsCount: ambition.ReviewsCount ?? '',
//     ambitionBoxRating: ambition.AggregateRating || '',
//     roleCategoryGid: job.roleCategoryGid || '',
//     todaysJob: job.todaysJob ?? '',
//     jobAgentEligle: job.jobAgentEligle ?? '',
//     consultant: job.consultant ?? '',
//     hiringFor: job.hiringFor || '',
//     hideClientName: job.hideClientName ?? '',
//     clientTitleString: job.clientTitleString || '',
//     brandedJDTemplateId: branded.templateId ?? '',
//     questionnaireIdPresent: job.questionnaireIdPresent ?? '',
//     exclusive: job.exclusive ?? '',
//     diversityTagText: job.diversityTagText || '',
//     logoPath: job.logoPath || '',
//   };
// }

// function pageUrl(pageNumber) {
//   return pageNumber === 1 ? CONFIG.FIRST_PAGE_URL : CONFIG.PAGE_URL_TEMPLATE(pageNumber);
// }

// function sleep(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// // Fetch+capture the API JSON for a single page. Returns the parsed JSON or null.
// async function scrapePage(context, pageNumber) {
//   const page = await context.newPage();
//   let apiResponse = null;

//   const responseHandler = async (response) => {
//     const url = response.url();
//     if (url.includes('/jobapi/v3/search') && response.status() === 200) {
//       try {
//         const data = await response.json();
//         apiResponse = data;
//       } catch (err) {
//         // ignore parse errors, handled by caller via null check
//       }
//     }
//   };

//   page.on('response', responseHandler);

//   try {
//     await page.goto(pageUrl(pageNumber), {
//       waitUntil: 'networkidle',
//       timeout: CONFIG.NAV_TIMEOUT_MS,
//     });
//     await page.waitForTimeout(CONFIG.WAIT_AFTER_LOAD_MS);
//   } finally {
//     page.off('response', responseHandler);
//     await page.close();
//   }

//   return apiResponse;
// }

// async function scrapePageWithRetries(context, pageNumber) {
//   for (let attempt = 1; attempt <= CONFIG.RETRIES_PER_PAGE; attempt++) {
//     try {
//       logLine(`PAGE ${pageNumber} attempt ${attempt}/${CONFIG.RETRIES_PER_PAGE} - loading ${pageUrl(pageNumber)}`);
//       const data = await scrapePage(context, pageNumber);
//       if (data && Array.isArray(data.jobDetails)) {
//         return data;
//       }
//       logLine(`PAGE ${pageNumber} attempt ${attempt} - no valid API response captured (possible captcha/block)`);
//     } catch (err) {
//       logLine(`PAGE ${pageNumber} attempt ${attempt} - ERROR: ${err.message}`);
//     }
//     if (attempt < CONFIG.RETRIES_PER_PAGE) {
//       await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
//     }
//   }
//   return null;
// }

// function resolveTotalPages(firstPageData) {
//   if (String(CONFIG.PAGES).toUpperCase() !== 'ALL') {
//     return parseInt(CONFIG.PAGES, 10);
//   }
//   const noOfJobs = firstPageData?.noOfJobs || 0;
//   const perPage =
//     (firstPageData?.jobDetails && firstPageData.jobDetails.length) ||
//     CONFIG.JOBS_PER_PAGE_FALLBACK;
//   const totalPages = Math.max(1, Math.ceil(noOfJobs / perPage));
//   logLine(`PAGES=ALL -> noOfJobs=${noOfJobs}, perPage=${perPage}, totalPages=${totalPages}`);
//   return totalPages;
// }

// // ------------------------- MAIN -------------------------

// (async () => {
//   ensureDirs();
//   writeCsvHeaderIfNeeded();

//   const completedPages = getCompletedPages();
//   if (completedPages.size > 0) {
//     logLine(`Resuming run. Already-completed pages found in log: [${[...completedPages].sort((a, b) => a - b).join(', ')}]`);
//   } else {
//     logLine('Starting fresh run (no completed pages found in log, or FORCE=1 was set).');
//   }

//   const browser = await chromium.launch({
//     headless: false,
//     args: [
//       '--disable-blink-features=AutomationControlled',
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//     ],
//   });

//   const context = await browser.newContext({
//     userAgent:
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
//     viewport: { width: 1366, height: 768 },
//     locale: 'en-IN',
//   });

//   try {
//     // Page 1 must always be fetched first if we need to resolve PAGES=ALL,
//     // or if page 1 itself hasn't completed yet.
//     let totalPages = String(CONFIG.PAGES).toUpperCase() === 'ALL' ? null : parseInt(CONFIG.PAGES, 10);

//     if (totalPages === null || !completedPages.has(1)) {
//       const firstData = await scrapePageWithRetries(context, 1);
//       if (!firstData) {
//         logLine('PAGE 1 FAILED after all retries - cannot resolve total page count. Aborting.');
//         await browser.close();
//         process.exit(1);
//       }
//       if (totalPages === null) {
//         totalPages = resolveTotalPages(firstData);
//       }
//       const rows = firstData.jobDetails.map((job) => flattenJob(job, 1));
//       appendJobsToCsv(rows);
//       logLine(`PAGE 1 COMPLETED - ${rows.length} jobs written`);
//       completedPages.add(1);
//     } else {
//       logLine('PAGE 1 already COMPLETED, skipping (use FORCE=1 to redo).');
//     }

//     for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
//       if (completedPages.has(pageNumber)) {
//         logLine(`PAGE ${pageNumber} already COMPLETED, skipping.`);
//         continue;
//       }

//       const data = await scrapePageWithRetries(context, pageNumber);

//       if (!data) {
//         logLine(`PAGE ${pageNumber} FAILED after ${CONFIG.RETRIES_PER_PAGE} attempts - will retry on next run.`);
//         continue; // do not mark completed; move to next page
//       }

//       // optional: keep raw JSON per page for debugging/auditing
//       fs.writeFileSync(
//         path.join(CONFIG.RAW_JSON_DIR, `page_${pageNumber}.json`),
//         JSON.stringify(data, null, 2),
//         'utf8'
//       );

//       const rows = data.jobDetails.map((job) => flattenJob(job, pageNumber));
//       appendJobsToCsv(rows);
//       logLine(`PAGE ${pageNumber} COMPLETED - ${rows.length} jobs written`);
//       completedPages.add(pageNumber);

//       await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
//     }

//     logLine(`Run finished. Total pages targeted: ${totalPages}. Completed pages: [${[...completedPages].sort((a, b) => a - b).join(', ')}]`);
//   } catch (err) {
//     logLine(`FATAL ERROR: ${err.message}`);
//   } finally {
//     await browser.close();
//   }
// })();












