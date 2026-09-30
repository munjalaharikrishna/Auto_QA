import { test, expect, expectPath } from '../fixtures/test.fixture';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';

test(
  'TC-DEMO-001: Verify a user can log in',
  { tag: ['@positive'], annotation: [{ type: 'automation', description: 'AUTO-DEMO-001' }] },
  async ({ page }) => {
    const dashboardPage = new DashboardPage(page);
    const loginPage = new LoginPage(page);

    await test.step('S1: Open Login page', async () => {
      await loginPage.goto();
    });
    await test.step('S2, S3, S4: Enter valid username; Enter valid password; Click the Login button', async () => {
      await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_PASSWORD!);
    });
    await test.step('A1: User is redirected to Dashboard page.', async () => {
      await expectPath(page, DashboardPage.path);
    });
    await test.step('A2: Dashboard heading is displayed.', async () => {
      await expect(dashboardPage.dashboardHeading).toBeVisible();
    });
  },
);
