import { test, step, expect, expectPath } from '../fixtures/test.fixture';
import { LoginPage } from '../pages/LoginPage';

test(
  'TC-DEMO-002: Verify a wrong password is rejected',
  { tag: ['@negative'], annotation: [{ type: 'automation', description: 'AUTO-DEMO-002' }] },
  async ({ page }) => {
    const loginPage = new LoginPage(page);

    await step('S1: Open Login page', page, async () => {
      await loginPage.goto();
    });
    await step('S2, S3, S4: Enter valid username; Enter wrong password; Click Login', page, async () => {
      await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_WRONG_PASSWORD!);
    });
    await step('A1: Error "Invalid username or password" is shown.', page, async () => {
      await expect(page.getByText('Invalid username or password').first()).toBeVisible();
    });
    await step('A2: User stays on the Login page.', page, async () => {
      await expectPath(page, LoginPage.path);
    });
  },
);
