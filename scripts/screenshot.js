import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.setViewportSize({ width: 1400, height: 900 });
  
  console.log('Navigating to localhost:7777...');
  await page.goto('http://localhost:7777', { waitUntil: 'networkidle', timeout: 10000 });
  
  // Get page title and body text for debugging
  const title = await page.title();
  console.log(`Page title: ${title}`);
  
  // Try to wait for cards grid, but don't fail if it's not there
  try {
    await page.waitForSelector('.cards-grid, #cardList', { timeout: 3000 });
    console.log('Found cards grid!');
  } catch (e) {
    console.log('Cards grid not found, taking screenshot anyway...');
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`Page body preview: ${bodyText}`);
  }
  
  // Wait a bit for any animations
  await page.waitForTimeout(1000);
  
  // Take screenshot
  const screenshotPath = join(__dirname, '..', '.odm-data', 'ui-screenshot.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  
  console.log(`Screenshot saved to: ${screenshotPath}`);
  
  await browser.close();
})();
