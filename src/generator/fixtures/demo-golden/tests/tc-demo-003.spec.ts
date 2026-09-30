import { test, expect } from '../fixtures/test.fixture';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';
import { ProfilePage } from '../pages/ProfilePage';
import { data } from '../data/tc-demo-003.data';

test(
  'TC-DEMO-003: Verify the profile can be saved',
  { annotation: [{ type: 'automation', description: 'AUTO-DEMO-003' }] },
  async ({ page }) => {
    const dashboardPage = new DashboardPage(page);
    const loginPage = new LoginPage(page);
    const profilePage = new ProfilePage(page);

    await test.step('S1: Open Login page', async () => {
      await loginPage.goto();
    });
    await test.step('S2, S3, S4: Enter valid username; Enter valid password; Click Login', async () => {
      await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_PASSWORD!);
    });
    await test.step('S5: Click Profile', async () => {
      await dashboardPage.openProfile();
    });
    await test.step('S6, S7, S8, S9: Enter Full name; Select India from Country; Check Send me news; Click Save changes', async () => {
      await profilePage.saveChanges(data.fullName, 'India');
    });
    await test.step('A1: Message "Profile saved" is shown.', async () => {
      await expect(page.getByText('Profile saved').first()).toBeVisible();
    });
    await test.step('A2: Send me news is checked.', async () => {
      await expect(profilePage.sendMeNewsCheckbox).toBeChecked();
    });
  },
);
