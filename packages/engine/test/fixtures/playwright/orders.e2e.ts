// Keyboard, hover and focus calls plus text assertions, in the shape real e2e specs use them:
// a search box submitted with Enter, a command palette opened with a shortcut, a menu revealed by
// hovering, a field focused before typing, and exact vs partial text checks.
import { expect, test } from '@playwright/test';

test.describe('orders', () => {
  test('ui: search and open an order', async ({ page }) => {
    await page.goto('/orders');
    const search = page.getByPlaceholder('Search orders');
    await search.focus();
    await search.fill('ORD-1001');
    await search.press('Enter');
    await expect(page.getByRole('status')).toHaveText('1 order found');
    await expect(page.getByRole('row', { name: /ORD-1001/ })).toContainText('Acme Garden Supplies');
    await page.getByRole('button', { name: 'Actions' }).hover();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Order ORD-1001/);
    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });
});
