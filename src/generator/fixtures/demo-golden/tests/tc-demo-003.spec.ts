import { test, step, expect } from '../fixtures/test.fixture';
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

    await step('S1: Open Login page', page, async () => {
      await loginPage.goto();
    });
    await step('S2, S3, S4: Enter valid username; Enter valid password; Click Login', page, async () => {
      await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_PASSWORD!);
    });
    await step('S5: Click Profile', page, async () => {
      await dashboardPage.openProfile();
    });
    await step(
      'S6, S7, S8, S9: Enter Full name; Select India from Country; Check Send me news; Click Save changes',
      page,
      async () => {
        await profilePage.saveChanges(data.fullName, 'India');
      },
    );
    await step('A1: Message "Profile saved" is shown.', page, async () => {
      await expect(page.getByText('Profile saved').first()).toBeVisible();
    });
    await step('A2: Send me news is checked.', page, async () => {
      await expect(profilePage.sendMeNewsCheckbox).toBeChecked();
    });
  },
);
