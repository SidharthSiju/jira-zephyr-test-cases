/**
 * attachFilesParallel.spec.js  —  Stage 2: Collect Created Issue Links
 *
 * Reads the issues list URL saved by Stage 1 (link.json), navigates to it,
 * and scrapes the name and URL of every created Jira issue.  Each scraped
 * issue is matched back to its originating CSV row, and the combined data is
 * written to issues.json so Stage 3 (uploadEvidence.spec.js) can process
 * each issue in parallel without needing to re-scrape.
 *
 * Playwright project:  scenarios  (depends on setup)
 *                      scenarios-only  (standalone, no dependency)
 * Run command:         npx playwright test --project=scenarios
 */

import { test, chromium, expect } from '@playwright/test';
import GetCreatedIssuesPage from '../pages/getCreatedIssuesPage';
import EvidenceFilePage from '../pages/EvidenceFilePage';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { retryAction } from '../utils/retryHelper';

// Load environment variables from the .env file in the project root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Reads a CSV file and returns its rows as an array of objects.
 * Each row is augmented with null placeholders for testLink and testStatus.
 *
 * @param {string} csvPath - Absolute path to the CSV file.
 * @returns {Promise<Array<object>>} Parsed CSV records with added testLink/testStatus fields.
 * @throws {Error} If the CSV file is empty.
 */
async function readTestCasesData(csvPath) {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csvContent, {
    columns: (header) => header.map(col => col.trim()),
    skip_empty_lines: true,
    trim: true,
    on_record: (record) => ({
      ...record,
      testLink: null,
      testStatus: null
    })
  });

  if (records.length === 0) {
    throw new Error(`CSV file ${csvPath} is empty or has no data rows`);
  }
  return records;
}

/**
 * Matches the scraped Jira issues to the original CSV rows by Summary name.
 * Sets testLink and testStatus on each matched CSV record.
 *
 * @param {Array<object>} dataFromCSV    - CSV records (from readTestCasesData).
 * @param {Array<{issueName: string, issueLink: string}>} createdIssues - Scraped from Jira.
 * @returns {Promise<Array<object>>} CSV records enriched with Jira issue data.
 */
async function mapIssuesCreated(dataFromCSV, createdIssues) {
  for (const record of dataFromCSV) {
    const matchingIssue = createdIssues.find(issue => issue.issueName === record.Summary);
    if (matchingIssue) {
      record.testLink = matchingIssue.issueLink;
      record.testStatus = 'Created';
    } else {
      record.testStatus = 'Not Created';
    }
  }
  return dataFromCSV;
}

// Use saved browser auth state so no manual login is required
test.use({ storageState: 'auth.json' });

test.describe('Get scenarios', () => {
  // Run serially — this is a single scraping pass, not per-issue work
  test.describe.configure({ mode: 'serial' });

  test('Attach issue files', async ({ page }, testInfo) => {
    // Extend timeout — the issues list can be slow to load and may have many rows
    await test.setTimeout(500000);

    // Read paths from environment variables
    const folderPath = process.env.TEST_DATA_PATH;
    const resultsPath = process.env.OUTPUT_PATH;
    const folderName = process.env.FOLDER_NAME;

    // Find the CSV file in the test data folder
    const files = fs.readdirSync(folderPath, { withFileTypes: true });
    const csvFile = files
      .filter(f => f.isFile())
      .map(f => f.name)
      .find(name => name.toLowerCase().endsWith('.csv'));

    if (!csvFile) {
      throw new Error(`No CSV file found in folder: ${folderPath}`);
    }

    // Read link.json written by Stage 1 to get the issues list URL
    const filePath = `link.json`;
    if (!fs.existsSync(filePath)) {
      throw new Error(`Link file not found: ${filePath}`);
    }
    const { link } = JSON.parse(fs.readFileSync(filePath));

    // Navigate to the Jira issues list page from Stage 1
    await page.goto(link, { waitUntil: 'domcontentloaded' });

    // ── Scrape all created issues from the list ────────────────────────────────
    const getCreatedIssuesPage = new GetCreatedIssuesPage(page);
    const dataFromCSV = await readTestCasesData(path.join(folderPath, csvFile));
    const createdIssues = await getCreatedIssuesPage.getIssueRows();

    // ── Match scraped issues back to CSV rows ──────────────────────────────────
    const scenarioMap = await mapIssuesCreated(dataFromCSV, createdIssues);
    await page.waitForTimeout(2000); // Let the page settle before any further interaction

    // ── Persist the enriched issue map to disk ─────────────────────────────────
    // issues.json is the input for Stage 3 (uploadEvidence.spec.js).
    // Each entry contains the original CSV fields plus testLink and testStatus.
    fs.writeFileSync(
      `issues.json`,
      JSON.stringify(scenarioMap, null, 2)
    );

    // Refresh the issues list to confirm it is still live (optional sanity check)
    await page.locator('[data-testid="issue-navigator.common.ui.refresh-button.refresh-button"]').click();
    await page.waitForTimeout(3000);
  });
});
