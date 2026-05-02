/**
 * uploadEvidence.spec.js  —  Stage 3: Attach Evidence & Set Status to Pass
 *
 * Reads issues.json (written by Stage 2) and dynamically generates one
 * Playwright test per issue.  Tests run in parallel, so multiple issues
 * are processed simultaneously — controlled by the --workers flag.
 *
 * For each issue the test:
 *  1. Navigates to the Jira issue page.
 *  2. Skips if evidence is already uploaded or the issue previously failed.
 *  3. Attaches the matching .docx file via the quick-add attachment button.
 *  4. Sets the issue status to Pass.
 *  5. On the final issue, writes a timestamped results CSV to OUTPUT_PATH.
 *
 * Playwright project:  evidence-only  (standalone)
 *                      evidence-with-scenarios  (depends on scenarios-only)
 * Run command:         npx playwright test --project=evidence-only --workers=4
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
 * (Defined here for potential future use; Stage 3 primarily reads issues.json.)
 *
 * @param {string} csvPath - Absolute path to the CSV file.
 * @returns {Promise<Array<object>>} Parsed CSV records with added testLink/testStatus fields.
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
 * Matches scraped Jira issues back to CSV rows by Summary name.
 * Sets testLink and testStatus on each matched record.
 *
 * @param {Array<object>} dataFromCSV - CSV records.
 * @param {Array<{issueName: string, issueLink: string}>} createdIssues - Scraped from Jira.
 * @returns {Promise<Array<object>>} Enriched CSV records.
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

test.describe('Upload evidence (parallel)', () => {
    // Run each dynamically generated test in its own browser context (parallel)
    test.describe.configure({ mode: 'parallel' });

    // ── Read shared state once at describe-block level (before tests are generated) ──
    const folderName = process.env.FOLDER_NAME;
    const folderPath = process.env.TEST_DATA_PATH;
    const resultsPath = process.env.OUTPUT_PATH;
    const issuesFilePath = `issues.json`;

    // Fail fast if issues.json is missing — Stage 2 must run first
    if (!fs.existsSync(issuesFilePath)) {
        throw new Error(`Issues file not found: ${issuesFilePath}`);
    }

    // Load the full scenario map from issues.json written by Stage 2
    const scenarioMap = JSON.parse(fs.readFileSync(issuesFilePath, 'utf8'));

    // ── Dynamically generate one test per issue ────────────────────────────────
    scenarioMap.forEach((record, index, array) => {

        test(`Upload for ${record.Summary}`, async ({ page }, testInfo) => {
            // Extend timeout — file uploads and status changes can be slow
            await test.setTimeout(500000);

            // Find the CSV file in the test data folder
            const files = fs.readdirSync(folderPath, { withFileTypes: true });
            const csvFile = files
                .filter(f => f.isFile())
                .map(f => f.name)
                .find(name => name.toLowerCase().endsWith('.csv'));

            if (!csvFile) {
                throw new Error(`No CSV file found in folder: ${folderPath}`);
            }

            // Verify link.json exists (used for fallback navigation if needed)
            const filePath = `link.json`;
            if (!fs.existsSync(filePath)) {
                throw new Error(`Link file not found: ${filePath}`);
            }

            // Navigate directly to this issue's page using the stored link
            await page.goto(record.testLink, { waitUntil: 'domcontentloaded' });
            await page.getByText('Apps', { exact: true }).waitFor({ state: 'visible' });

            // Determine the expected evidence filename for this issue
            const wordFileName = `${record.Summary}.docx`;

            // ── Skip conditions ────────────────────────────────────────────────

            // If the issue already shows Pass and the evidence file is present, skip
            if (
                await page.getByRole('button', { name: 'Pass' }).isVisible() &&
                await page.locator(`text=${wordFileName}`).first().isVisible
            ) {
                test.skip('Evidence already uploaded, skipping');
            }

            // If the issue is already marked Failed, skip to avoid overwriting the status
            if (await page.getByRole('button', { name: 'Failed' }).isVisible()) {
                test.skip('Test failed in previous run, skipping');
            }

            // ── Open the quick-add dropdown ────────────────────────────────────
            const addBtn = page.getByTestId(
                'issue-view-foundation.quick-add.quick-add-items-compact.add-button-dropdown--trigger'
            );
            const attachBtn = page.getByTestId(
                'issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment'
            );

            // Wait for the add button to be interactive before clicking
            await addBtn.waitFor({ state: 'visible' });

            // Retry clicking the add button until the attach option appears in the dropdown.
            // This handles cases where the dropdown closes or re-renders before attaching.
            await retryAction({
                action: async () => {
                    await addBtn.click();
                },
                successCheck: async () => {
                    try {
                        await attachBtn.waitFor({ state: 'visible', timeout: 1000 });
                        return true;
                    } catch {
                        return false;
                    }
                },
                retries: 20,
            });

            // ── Attach the evidence file ───────────────────────────────────────

            // Intercept the native file chooser dialog and provide the file path
            const [fileChooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                attachBtn.click()
            ]);

            const wordFilePath = path.join(folderPath, wordFileName);

            if (fs.existsSync(wordFilePath)) {
                // Mark as Pass in memory before uploading (will be written to CSV at end)
                record.testStatus = 'Pass';
                await fileChooser.setFiles(wordFilePath);
            } else {
                // Evidence file not found — skip this issue
                await test.skip(`File not found: ${wordFilePath}`);
            }

            // Wait for the uploaded filename to appear on the page as upload confirmation
            await page.locator(`text=${wordFileName}`).first().waitFor({ timeout: 30000 });

            // ── Set issue status to Pass ───────────────────────────────────────
            await page.getByTestId('issue-field-status.ui.status-view.status-button.status-button').click();
            await page.getByRole('option', { name: 'Pass' }).click();
            await page.waitForTimeout(1000); // Allow the status change to commit

            // ── Write results CSV after the last issue is processed ───────────
            // Because tests run in parallel, only the last issue in the array
            // triggers the CSV write.  This is a simple but imperfect heuristic;
            // a shared results file or post-test hook would be more robust.
            if (index === array.length - 1) {
                const outputCsvPath = path.join(
                    resultsPath,
                    `${csvFile}_results_${new Date().toISOString().replace(/:/g, '-')}.csv`
                );
                const csvContent = stringify(scenarioMap, {
                    header: true,
                    // Only quote fields that contain newlines (avoids unnecessary quoting)
                    quoted: (value, context) => {
                        return typeof value === 'string' && value.includes('\n');
                    }
                });
                fs.writeFileSync(outputCsvPath, csvContent, 'utf8');
                console.log(`Results written to ${outputCsvPath}`);
            }
        });
    });
});
