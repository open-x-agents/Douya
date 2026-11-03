import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtemp, cp, rm } from 'fs/promises';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  // Create temp ODM_HOME with sample data
  const tempHome = await mkdtemp(join(tmpdir(), 'odm-test-'));
  console.log(`Using temp home: ${tempHome}`);
  
  // Copy sample state
  await cp(
    join(__dirname, '..', 'test', 'fixtures', 'state.sample.json'),
    join(tempHome, 'state.json')
  );
  
  // Start server with temp home
  const { spawn } = await import('child_process');
  const serverProcess = spawn('node', ['scripts/server.js'], {
    env: { ...process.env, ODM_DATA_DIR: tempHome },
    cwd: join(__dirname, '..'),
    stdio: 'pipe'
  });
  
  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.setViewportSize({ width: 1400, height: 900 });
    
    console.log('Navigating to localhost:7777...');
    await page.goto('http://localhost:7777', { waitUntil: 'networkidle', timeout: 10000 });
    
    // Get page title
    const title = await page.title();
    console.log(`Page title: ${title}`);
    
    // Try to wait for cards grid
    try {
      await page.waitForSelector('.cards-grid, #cardList', { timeout: 3000 });
      console.log('Found cards grid!');
    } catch (e) {
      console.log('Cards grid not found, taking screenshot anyway...');
    }
    
    // Wait for any animations
    await page.waitForTimeout(1000);
    
    // Take screenshot
    const screenshotPath = join(__dirname, '..', 'test', 'fixtures', 'ui-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    
    console.log(`Screenshot saved to: ${screenshotPath}`);
    
    await browser.close();
  } finally {
    // Kill server
    serverProcess.kill();
    
    // Clean up temp directory
    await rm(tempHome, { recursive: true, force: true });
    console.log('Cleaned up temp directory');
  }
})();
