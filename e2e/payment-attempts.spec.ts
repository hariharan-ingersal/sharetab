import { test, expect, type Page } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, navigateToGroup } from './helpers';
import { newRequestKey } from '../src/lib/guest-session';

// One attempt to record a payment records at most one payment, however many times it is sent: a
// double-click, two sends at once, or a retry after an answer that never arrived. Separate attempts
// with the same details are separate payments.

type Ctx = Awaited<ReturnType<typeof createTestGroup>>['owner'];

async function payments(ctx: Ctx, groupId: string): Promise<{ id: string; amount: number }[]> {
  return (await trpcResult(await trpcQuery(ctx, 'settlements.list', { groupId }))).items;
}

/** Alice paid $20.00 split with Bob, so Bob owes Alice $10.00 */
async function bobOwesAlice(name: string) {
  const group = await createTestGroup(users.alice.email, users.alice.password, [users.bob], name);
  const aliceId = group.memberIds[users.alice.email]!;
  const bobId = group.memberIds[users.bob.email]!;
  const res = await trpcMutation(group.owner, 'expenses.create', {
    groupId: group.groupId,
    title: 'Groceries',
    amount: 2000,
    paidById: aliceId,
    splitMode: 'EQUAL',
    shares: [
      { userId: aliceId, amount: 1000 },
      { userId: bobId, amount: 1000 },
    ],
  });
  expect(res.ok()).toBe(true);
  return { ...group, aliceId, bobId, bob: group.memberContexts[0]! };
}

test.describe('Payment attempts (API)', () => {
  test('five sends of one attempt at once record one payment, and all get it back', async () => {
    const g = await bobOwesAlice(`Attempts-burst-${Date.now()}`);
    try {
      const requestKey = newRequestKey();
      const sends = await Promise.all(
        Array.from({ length: 5 }, () =>
          trpcMutation(g.bob, 'settlements.create', { groupId: g.groupId, toId: g.aliceId, amount: 1000, requestKey }),
        ),
      );
      const ids = await Promise.all(sends.map(async (r) => (await r.json()).result?.data?.json?.id));
      expect(sends.every((r) => r.ok())).toBe(true);
      expect(new Set(ids).size).toBe(1);
      expect(await payments(g.owner, g.groupId)).toHaveLength(1);
    } finally {
      await g.dispose();
    }
  });

  test('a retry after the answer was lost gets the recorded payment back', async () => {
    const g = await bobOwesAlice(`Attempts-retry-${Date.now()}`);
    try {
      const requestKey = newRequestKey();
      const input = { groupId: g.groupId, toId: g.aliceId, amount: 1000, requestKey };
      // The first send is recorded; to the server, a client that never saw its answer looks the same
      const first = await trpcMutation(g.bob, 'settlements.create', input);
      const retry = await trpcMutation(g.bob, 'settlements.create', input);
      expect(retry.ok()).toBe(true);
      const firstId = (await first.json()).result.data.json.id;
      expect((await retry.json()).result.data.json.id).toBe(firstId);
      expect((await payments(g.owner, g.groupId)).map((p) => p.id)).toEqual([firstId]);
    } finally {
      await g.dispose();
    }
  });

  test('two attempts with the same details are two payments', async () => {
    const g = await bobOwesAlice(`Attempts-separate-${Date.now()}`);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await trpcMutation(g.bob, 'settlements.create', {
          groupId: g.groupId,
          toId: g.aliceId,
          amount: 500,
          requestKey: newRequestKey(),
        });
        expect(res.ok()).toBe(true);
      }
      expect(await payments(g.owner, g.groupId)).toHaveLength(2);
    } finally {
      await g.dispose();
    }
  });

  test('the attempt key is not part of the payment history', async () => {
    const g = await bobOwesAlice(`Attempts-history-${Date.now()}`);
    try {
      await trpcMutation(g.bob, 'settlements.create', {
        groupId: g.groupId,
        toId: g.aliceId,
        amount: 500,
        requestKey: newRequestKey(),
      });
      const [payment] = await payments(g.owner, g.groupId);
      expect(payment).not.toHaveProperty('requestKey');
    } finally {
      await g.dispose();
    }
  });
});

test.describe('Payment attempts (Record Payment dialog)', () => {
  async function openSettle(page: Page, groupName: string) {
    await login(page, users.bob.email, users.bob.password);
    await navigateToGroup(page, groupName);
    await page.getByRole('button', { name: 'Settle up' }).click();
    await expect(page.getByTestId('record-payment-btn')).toBeVisible();
  }

  async function fillPayment(page: Page, aliceId: string) {
    await page.locator('#to').selectOption(aliceId);
    await page.locator('#settle-amount').fill('10.00');
  }

  test('a double-click records one payment', async ({ page }) => {
    const name = `Attempts-dblclick-${Date.now()}`;
    const g = await bobOwesAlice(name);
    try {
      await openSettle(page, name);
      await fillPayment(page, g.aliceId);
      await page.getByTestId('record-payment-btn').dblclick();
      await expect(page.getByTestId('record-payment-btn')).toBeHidden();
      await expect.poll(async () => (await payments(g.owner, g.groupId)).length).toBe(1);
    } finally {
      await g.dispose();
    }
  });

  test('two clicks in the same moment record one payment', async ({ page }) => {
    const name = `Attempts-clicks-${Date.now()}`;
    const g = await bobOwesAlice(name);
    try {
      await openSettle(page, name);
      await fillPayment(page, g.aliceId);
      await page.getByTestId('record-payment-btn').evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect(page.getByTestId('record-payment-btn')).toBeHidden();
      // Give a second request, if one went out, time to land
      await page.waitForTimeout(1000);
      expect(await payments(g.owner, g.groupId)).toHaveLength(1);
    } finally {
      await g.dispose();
    }
  });

  test('when the answer is lost, sending again records nothing more', async ({ page }) => {
    const name = `Attempts-lost-${Date.now()}`;
    const g = await bobOwesAlice(name);
    try {
      await openSettle(page, name);
      await fillPayment(page, g.aliceId);
      // The first send reaches the server, which records the payment, but its answer never arrives
      let dropped = false;
      await page.route('**/api/trpc/**settlements.create**', async (route) => {
        if (dropped) return route.continue();
        dropped = true;
        await route.fetch();
        await route.abort('failed');
      });
      await page.getByTestId('record-payment-btn').click();
      await expect(page.getByTestId('settle-error')).toHaveText(/couldn.t confirm/i);
      await expect(page.locator('#settle-amount')).toBeDisabled();
      expect(await payments(g.owner, g.groupId)).toHaveLength(1);

      await page.getByTestId('record-payment-btn').click();
      await expect(page.getByTestId('record-payment-btn')).toBeHidden();
      expect(await payments(g.owner, g.groupId)).toHaveLength(1);
    } finally {
      await g.dispose();
    }
  });
});
