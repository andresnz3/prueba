const { expect } = require('@playwright/test');
async function checkCartCheckout(page) {
  const button = page.locator('#processSaleBtn');
  // A normal wheel gesture must reach the action; automatic click scrolling
  // would conceal clipping by a non-scrollable ancestor.
  // Keep the wheel away from focused numeric controls: Chromium would step
  // the discount instead of scrolling the page.
  await page.locator('#cartPanel').hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 2400);
  await expect.poll(async () => button.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight &&
      [rect.top + 2, rect.bottom - 2].every(y =>
        element.contains(document.elementFromPoint(rect.left + rect.width / 2, y)));
  })).toBe(true);
}
module.exports = { checkCartCheckout };
