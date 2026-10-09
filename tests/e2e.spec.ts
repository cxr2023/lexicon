import { test as base, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Backup, Snapshot } from '../src/types';

// This is the documented demo key in repository.ts. Tests only read it to assert
// persistence; all changes happen through real UI in fresh isolated contexts.
const DEMO_STORAGE_KEY = 'lexicon-garden-demo-v1';
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await use(errors);
    expect(errors, 'The app must not log browser errors during a normal workflow').toEqual([]);
  }, { auto: true }],
});

async function state(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), DEMO_STORAGE_KEY);
}

async function openDemo(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '体验示例词库', exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), DEMO_STORAGE_KEY)).toBeNull();
  await page.getByRole('button', { name: '体验示例词库', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始学习新词', exact: true })).toBeVisible();
  await expect.poll(async () => (await state(page)).entries.length).toBe(12);
}

async function navigate(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  const heading: Record<string, string | RegExp> = {
    今日学习: /让每次遇见/, 我的词库: /让每一个词/, 导入与补全: /把偶然遇见/, 设置: '按你的节奏来',
  };
  if (heading[name]) await expect(page.getByRole('heading', { name: heading[name], level: 1 })).toBeVisible();
}

async function rateEasy(page: Page, expectedCount: number, captureAnswer = false) {
  await page.getByRole('button', { name: /显示答案/ }).click();
  await expect(page.getByText('MEANING IN ENGLISH', { exact: true })).toBeVisible();
  if (captureAnswer) await screenshot(page, 'study-answer-desktop.png');
  await page.getByRole('button', { name: /4 很轻松/ }).click();
  await expect.poll(async () => (await state(page)).reviews.filter(review => !review.undone).length).toBe(expectedCount);
  await expect(page.getByText('正在确认保存…', { exact: true })).toHaveCount(0);
}

async function screenshot(page: Page, name: string) {
  await mkdir('test-results', { recursive: true });
  if (await page.locator('.page-enter').count()) await expect(page.locator('.page-enter').first()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: path.resolve('test-results', name), fullPage: true, animations: 'disabled' });
}

async function deleteFromLibrary(page: Page, term: string) {
  await navigate(page, '我的词库');
  await page.getByRole('button', { name: `永久删除 ${term}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除词条' });
  await expect(dialog.getByText(term, { exact: true })).toBeVisible();
  await expect(dialog).toContainText('无法撤销');
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `永久删除 ${term}`, exact: true })).toHaveCount(0);
}

test('explicit demo, recall before reveal, resumable ten-card batch and remaining two', async ({ page }) => {
  await openDemo(page);
  await screenshot(page, 'home-desktop.png');
  await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
  await expect(page.getByText('本批初学 0 / 10', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'serendipity', exact: true })).toBeVisible();
  await expect(page.getByRole('article').getByText('/ˌserənˈdɪpəti/', { exact: false })).toBeVisible();
  await expect(page.getByText('MEANING IN ENGLISH', { exact: true })).toHaveCount(0);
  await expect(page.getByText('The chance discovery of something pleasant or valuable when you are not looking for it.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await screenshot(page, 'study-desktop.png');
  await rateEasy(page, 1, true);
  await expect(page.getByText('本批初学 1 / 10', { exact: true })).toBeVisible();
  const batchId = (await state(page)).batches[0].id;
  await page.reload();
  await expect(page.getByText('本批初学 1 / 10', { exact: true })).toBeVisible();
  expect((await state(page)).batches[0].id).toBe(batchId);
  await expect(page.getByRole('heading', { name: 'take your time', exact: true })).toBeVisible();
  for (let count = 2; count <= 10; count += 1) await rateEasy(page, count);
  await expect(page.getByRole('heading', { name: '这一小步，完成了。', exact: true })).toBeVisible();
  await expect(page.getByText('本批 10 个词条已完成初学，后续复习会按时安排。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续学习剩余 2 个', exact: true }).click();
  await expect(page.getByText('本批初学 0 / 2', { exact: true })).toBeVisible();
  await rateEasy(page, 11); await rateEasy(page, 12);
  await expect(page.getByText('本批 2 个词条已完成初学，后续复习会按时安排。', { exact: true })).toBeVisible();
  const saved = await state(page);
  expect(saved.batches).toHaveLength(2);
  expect(saved.batches.every(batch => batch.completed_at && batch.completed_ids.length === batch.entry_ids.length)).toBe(true);
  expect(saved.cards.every(card => card.state.reps === 1)).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '新词已全部学完', exact: true })).toBeVisible();
  expect((await state(page)).reviews).toHaveLength(12);
});

test('draft and Markdown enrichment keep stable IDs, existing meanings and review progress', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
  await rateEasy(page, 1);
  const before = await state(page);
  const studied = before.entries.find(entry => entry.term === 'serendipity')!;
  const studiedCard = before.cards.find(card => card.entry_id === studied.id)!;
  await navigate(page, '导入与补全');
  await page.getByRole('textbox', { name: /支持标准 Markdown/ }).fill('mellifluous\nmellifluous');
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await expect(page.getByText('还有 1 条同名词条需要选择处理方式。', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '发现同名词条，选择处理方式', exact: true }).selectOption('merge');
  await page.getByRole('button', { name: '确认导入 1 个词条', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认后，再收入词库' })).toHaveCount(0);
  const draft = (await state(page)).entries.find(entry => entry.term === 'mellifluous')!;
  expect((await state(page)).cards.some(card => card.entry_id === draft.id)).toBe(false);
  await page.getByRole('button', { name: '生成并复制补全提示词', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: '复制到 ChatGPT' });
  await expect(prompt.getByRole('textbox', { name: '完整补全提示词' })).toContainText(draft.id);
  await prompt.getByRole('button', { name: '关闭弹窗' }).click();

  const markdown = `## mellifluous\n- ID: ${draft.id}\n- 美式音标: /məˈlɪfluəs/\n- 英文释义: Pleasant and smooth to listen to.\n- 中文释义: 悦耳的\n\n## serendipity\n- ID: ${studied.id}\n- 英文释义: This must not replace the existing meaning by default.\n- 用法: Often used for a fortunate discovery.\n`;
  await page.getByLabel('选择 Markdown 或文本文件').setInputFiles({ name: 'enrichment.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
  await expect(page.getByText('识别到 2 条 · 预计新增 0 条 · 更新 2 条', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /允许导入的非空内容替换已有字段/ }).first()).not.toBeChecked();
  await page.getByRole('button', { name: '确认导入 2 个词条', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认后，再收入词库' })).toHaveCount(0);
  const after = await state(page);
  expect(after.entries).toHaveLength(13);
  expect(after.entries.find(entry => entry.id === draft.id)?.definition_en).toBe('Pleasant and smooth to listen to.');
  expect(after.entries.find(entry => entry.id === studied.id)?.definition_en).toBe(studied.definition_en);
  expect(after.entries.find(entry => entry.id === studied.id)?.usage).toBe('Often used for a fortunate discovery.');
  expect(after.cards.find(card => card.id === studiedCard.id)).toEqual(studiedCard);
  expect(after.reviews).toEqual(before.reviews);
  expect(after.cards.filter(card => card.entry_id === draft.id)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '放入你的英语素材', exact: true })).toBeVisible();
  expect((await state(page)).entries.find(entry => entry.term === 'mellifluous')?.id).toBe(draft.id);

  await page.getByRole('textbox', { name: /支持标准 Markdown/ }).fill('## invalid identifier\n- ID: not-a-uuid');
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await expect(page.getByText(/第 1 行：.*ID 不是有效 UUID/)).toBeVisible();
  await expect(page.getByRole('button', { name: '确认导入 0 个词条', exact: true })).toBeDisabled();
  expect((await state(page)).entries).toHaveLength(13);
});

test('permanent deletion removes entries, cards and history from library and study', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
  await rateEasy(page, 1);
  const firstId = (await state(page)).entries.find(entry => entry.term === 'serendipity')!.id;
  await navigate(page, '我的词库');
  await page.getByRole('button', { name: '永久删除 serendipity', exact: true }).click();
  await page.getByRole('dialog', { name: '永久删除词条' }).getByRole('button', { name: '取消', exact: true }).click();
  expect((await state(page)).entries.some(entry => entry.id === firstId)).toBe(true);
  await deleteFromLibrary(page, 'serendipity');
  let saved = await state(page);
  expect(saved.entries.some(entry => entry.id === firstId)).toBe(false);
  expect(saved.cards.some(card => card.entry_id === firstId)).toBe(false);
  expect(saved.reviews.some(review => review.entry_id === firstId)).toBe(false);
  await navigate(page, '今日学习');
  await page.getByRole('button', { name: '继续本批学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'take your time', exact: true })).toBeVisible();
  const secondId = saved.entries.find(entry => entry.term === 'take your time')!.id;
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('take your time');
    expect(dialog.message()).toContain('无法撤销');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'resilient', exact: true })).toBeVisible();
  saved = await state(page);
  expect(saved.entries).toHaveLength(10);
  expect(saved.cards.some(card => card.entry_id === secondId)).toBe(false);
  expect(saved.batches.flatMap(batch => batch.entry_ids)).not.toContain(secondId);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'resilient', exact: true })).toBeVisible();
  expect((await state(page)).entries.some(entry => [firstId, secondId].includes(entry.id))).toBe(false);
});

test('optional card settings preserve independent state and JSON backup restores through file upload', async ({ page }, testInfo) => {
  await openDemo(page);
  await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
  await rateEasy(page, 1);
  const initial = await state(page);
  const learned = initial.cards.find(card => card.state.reps === 1)!;
  await navigate(page, '设置');
  await page.getByRole('checkbox', { name: /默认折叠中文释义/ }).check();
  await page.getByRole('checkbox', { name: /开启中 → 英表达卡/ }).check();
  await page.getByRole('checkbox', { name: /开启语境填空卡/ }).check();
  await page.getByRole('button', { name: '保存学习偏好', exact: true }).click();
  await expect.poll(async () => (await state(page)).cards.length).toBe(36);
  const enabled = await state(page);
  expect(enabled.cards.find(card => card.id === learned.id)?.state).toEqual(learned.state);
  const siblings = enabled.cards.filter(card => card.entry_id === learned.entry_id && card.kind !== 'recognition');
  expect(siblings).toHaveLength(2);
  expect(siblings.every(card => card.state.reps === 0 && !!card.bury_until)).toBe(true);
  await page.getByRole('checkbox', { name: /开启中 → 英表达卡/ }).uncheck();
  await page.getByRole('button', { name: '保存学习偏好', exact: true }).click();
  await expect.poll(async () => (await state(page)).settings.production_enabled).toBe(false);
  expect((await state(page)).cards.filter(card => siblings.some(sibling => sibling.id === card.id))).toEqual(siblings);
  await page.getByRole('checkbox', { name: /开启中 → 英表达卡/ }).check();
  await page.getByRole('button', { name: '保存学习偏好', exact: true }).click();
  await expect.poll(async () => (await state(page)).settings.production_enabled).toBe(true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 JSON 备份', exact: true }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('exported-backup.json');
  await download.saveAs(backupPath);
  const backup: Backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.data.reviews).toHaveLength(1);
  expect(backup.data.cards).toHaveLength(36);
  await deleteFromLibrary(page, 'serendipity');
  expect((await state(page)).reviews).toHaveLength(0);
  await navigate(page, '设置');
  await page.getByLabel('选择 JSON 备份', { exact: true }).setInputFiles(backupPath);
  const restore = page.getByRole('dialog', { name: '确认恢复备份' });
  await expect(restore).toContainText('11 → 12');
  await expect(restore.getByRole('button', { name: '备份现有数据并恢复', exact: true })).toBeDisabled();
  await restore.getByRole('checkbox', { name: '我已检查内容，同意替换当前数据。', exact: true }).check();
  const safetyDownload = page.waitForEvent('download');
  await restore.getByRole('button', { name: '备份现有数据并恢复', exact: true }).click();
  const safetyPath = testInfo.outputPath('before-restore-backup.json');
  await (await safetyDownload).saveAs(safetyPath);
  await expect(restore).toHaveCount(0);
  const restored = await state(page);
  expect(restored.entries.map(entry => entry.id)).toEqual(backup.data.entries.map(entry => entry.id));
  expect(restored.settings).toEqual(backup.data.settings);
  expect(restored.cards.find(card => card.id === learned.id)?.state).toEqual(learned.state);
  expect(restored.reviews).toEqual(backup.data.reviews);
  expect(JSON.parse(await readFile(safetyPath, 'utf8')).data.entries).toHaveLength(11);
  await page.reload();
  await expect(page.getByRole('heading', { name: '学习偏好', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /开启中 → 英表达卡/ })).toBeChecked();
  expect((await state(page)).entries).toHaveLength(12);
});

test('390px mobile layouts and entry editing stay within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  const noOverflow = async () => expect(await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }))).toEqual({ width: 390, content: 390 });
  await noOverflow();
  await screenshot(page, 'home-mobile.png');
  await navigate(page, '我的词库'); await noOverflow();
  await page.getByRole('button', { name: '添加词条', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '收下一个新表达' });
  await expect(editor).toBeVisible();
  await noOverflow();
  await editor.getByRole('textbox', { name: /英语词条/ }).fill('a mobile expression');
  await editor.getByRole('button', { name: '保存词条', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await state(page)).entries.some(entry => entry.term === 'a mobile expression')).toBe(true);
  await navigate(page, '导入与补全'); await noOverflow();
  await navigate(page, '设置'); await noOverflow();
  await navigate(page, '今日学习');
  await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
  await expect(page.getByRole('button', { name: /显示答案/ })).toBeVisible();
  await noOverflow();
  await page.getByRole('button', { name: /显示答案/ }).click();
  await expect(page.getByRole('button', { name: /4 很轻松/ })).toBeVisible();
  await noOverflow();
});

for (const failure of ['before-commit', 'after-commit'] as const) {
  test(`a real pending answer survives ${failure} failure and reload without duplicate scoring`, async ({ page }) => {
    await openDemo(page);
    await page.getByRole('button', { name: '开始学习新词', exact: true }).click();
    await page.getByRole('button', { name: /显示答案/ }).click();
    // Inject a one-shot storage failure, not fabricated data. The app creates and
    // persists its own pending answer through the same click path as a user.
    await page.evaluate(({ key, failureMode }) => {
      const originalSet = Storage.prototype.setItem;
      const originalGet = Storage.prototype.getItem;
      let armed = true;
      let failNextRead = false;
      Storage.prototype.setItem = function(storageKey: string, value: string) {
        if (this === localStorage && storageKey === key && armed && JSON.parse(value).reviews.length === 1) {
          armed = false;
          if (failureMode === 'before-commit') throw new DOMException('模拟一次保存中断', 'QuotaExceededError');
          originalSet.call(this, storageKey, value);
          failNextRead = true;
          return;
        }
        originalSet.call(this, storageKey, value);
      };
      Storage.prototype.getItem = function(storageKey: string) {
        if (this === localStorage && storageKey === key && failNextRead) {
          failNextRead = false;
          throw new Error('模拟一次刷新中断');
        }
        return originalGet.call(this, storageKey);
      };
    }, { key: DEMO_STORAGE_KEY, failureMode: failure });
    await page.getByRole('button', { name: /4 很轻松/ }).click();
    await expect(page.getByText(failure === 'before-commit' ? '答案已暂存，等待确认' : '评分已保存，正在更新进度', { exact: true })).toBeVisible();
    const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('lexicon.pending.demo') || 'null'));
    expect(pending.committed).toBe(failure === 'after-commit');
    expect((await state(page)).reviews).toHaveLength(failure === 'after-commit' ? 1 : 0);
    await expect(page.getByRole('button', { name: /4 很轻松/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'take your time', exact: true })).toBeVisible();
    await expect(page.getByText('本批初学 1 / 10', { exact: true })).toBeVisible();
    const saved = await state(page);
    expect(saved.reviews).toHaveLength(1);
    expect(saved.reviews[0].id).toBe(pending.input.operation_id);
    expect(saved.cards.find(card => card.id === pending.input.card_id)?.state.reps).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('lexicon.pending.demo'))).toBeNull();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'take your time', exact: true })).toBeVisible();
    expect((await state(page)).reviews).toHaveLength(1);
  });
}
