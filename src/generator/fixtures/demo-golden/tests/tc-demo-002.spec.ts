import { test, expect, expectPath } from '../fixtures/test.fixture';
import { LoginPage } from '../pages/LoginPage';

test(
  'TC-DEMO-002: Verify a wrong password is rejected',
  { tag: ['@negative'], annotation: [{ type: 'automation', description: 'AUTO-DEMO-002' }] },
  async ({ page }) => {
    const loginPage = new LoginPage(page);

    await test.step('S1: Open Login page', async () => {
      await loginPage.goto();
    });
    await test.step('S2, S3, S4: Enter valid username; Enter wrong password; Click Login', async () => {
      await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_WRONG_PASSWORD!);
    });
    await test.step('A1: Error "Invalid username or password" is shown.', async () => {
      await expect(page.getByText('Invalid username or password').first()).toBeVisible();
    });
    await test.step('A2: User stays on the Login page.', async () => {
      await expectPath(page, LoginPage.path);
    });
  },
);
