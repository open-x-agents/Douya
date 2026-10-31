#!/usr/bin/env node
/**
 * Test chat UI in headless browser
 * Verifies: choice cards render, actions work, no error bubbles on success
 */

import { chromium } from '@playwright/test';

const PORT = process.env.PORT || 7777;
const BASE_URL = `http://localhost:${PORT}`;

async function test() {
  console.log('🧪 Testing Chat UI in headless browser\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Listen for console logs
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('❌ Browser error:', msg.text());
    }
  });

  try {
    // Navigate to app
    console.log('→ Loading app...');
    await page.goto(BASE_URL);
    await page.waitForSelector('#dockPanel', { timeout: 5000 });
    console.log('✓ App loaded\n');

    // Open chat
    console.log('→ Opening chat...');
    await page.click('#dockOpen');
    await page.waitForSelector('#dockPanel.open', { timeout: 2000 });
    console.log('✓ Chat opened\n');

    // Send test message
    console.log('→ Sending test message...');
    await page.fill('#dockInput', '测试');
    await page.click('#dockSend');

    // Wait for response (max 10 seconds)
    console.log('→ Waiting for response...');
    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll('.bubble:not(.me)');
        return bubbles.length > 1; // Initial typing + response
      },
      { timeout: 10000 }
    );
    console.log('✓ Response received\n');

    // Check for error bubbles
    console.log('→ Checking for error bubbles...');
    const errorBubbles = await page.$$eval('.bubble', bubbles =>
      bubbles.filter(b => b.textContent.includes('发送失败')).length
    );
    
    if (errorBubbles > 0) {
      console.log(`❌ Found ${errorBubbles} error bubble(s) - should be 0 on success`);
    } else {
      console.log('✓ No error bubbles (correct!)\n');
    }

    // Check for cards
    console.log('→ Checking for cards...');
    const cards = await page.$$('.chat-card');
    console.log(`✓ Found ${cards.length} card(s)\n`);

    if (cards.length > 0) {
      // Check first card for action buttons
      console.log('→ Checking card buttons...');
      const buttons = await cards[0].$$('.card-btn');
      console.log(`✓ Found ${buttons.length} button(s)\n`);

      if (buttons.length > 0) {
        // Click first button
        console.log('→ Testing button click...');
        const buttonText = await buttons[0].textContent();
        await buttons[0].click();
        
        // Check if input was filled
        await page.waitForTimeout(500);
        const inputValue = await page.$eval('#dockInput', el => el.value);
        
        if (inputValue) {
          console.log(`✓ Button click filled input: "${inputValue}"\n`);
        } else {
          console.log('⚠️  Button click did not fill input\n');
        }
      }
    }

    // Take screenshot
    console.log('→ Taking screenshot...');
    await page.screenshot({ path: '/tmp/chat-test.png', fullPage: true });
    console.log('✓ Screenshot saved to /tmp/chat-test.png\n');

    console.log('✅ Chat UI test completed!\n');
    console.log('Summary:');
    console.log(`  - Error bubbles: ${errorBubbles} (should be 0)`);
    console.log(`  - Cards rendered: ${cards.length}`);
    console.log(`  - Action buttons: ${cards.length > 0 ? 'tested' : 'N/A'}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    await page.screenshot({ path: '/tmp/chat-test-error.png', fullPage: true });
    console.error('Error screenshot saved to /tmp/chat-test-error.png');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Check if server is running
console.log(`Checking server at ${BASE_URL}...`);
try {
  const response = await fetch(BASE_URL);
  if (response.ok) {
    console.log('✓ Server is running\n');
    test();
  } else {
    console.error(`Server returned ${response.status}`);
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Server not running. Start with: npm start');
  process.exit(1);
}
