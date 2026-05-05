import { test, expect } from '@playwright/test';
import { retryAction } from '../utils/retryHelper';
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const PROJECT_ROOT = path.resolve(__dirname, '..');

test.use({ storageState: 'auth.json' });

test('Download CSV', async ({ page }) => {
    test.setTimeout(60000);

    const linkFilePath = path.join(PROJECT_ROOT, 'link.json');
    if (!fs.existsSync(linkFilePath)) {
        throw new Error(`link.json not found at ${linkFilePath}`);
    }

    const { link } = JSON.parse(fs.readFileSync(linkFilePath, 'utf8'));
    await page.goto(link);

    await retryAction({
        action: async () => {
            await page.getByTestId('issue-navigator-action-meatball-menu.ui.menu-trigger').click();
        },
        successCheck: async () => {
            return await page.getByRole('menuitem', { name: 'Export' }).isVisible();
        },
    });

    await page.getByRole('menuitem', { name: 'Export' }).click();

    // 👇 Start waiting for download BEFORE clicking
    const downloadPromise = page.waitForEvent('download');

    await page.getByRole('menuitem', { name: 'CSV - my defaults' }, { exact: true }).last().click();

    const download = await downloadPromise;

    // 👇 Define your custom path
    const downloadPath = path.join(process.env.OUTPUT_PATH, 'exported_issues.csv');

    // Ensure folder exists
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });

    // 👇 Save file
    await download.saveAs(downloadPath);

    console.log('File saved to:', downloadPath);
});