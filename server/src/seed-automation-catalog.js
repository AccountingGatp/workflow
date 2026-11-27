import { AutomationGroup, ClientProject } from './models/index.js';

const initialCards = [
  ['6afff3ef87820376a56e62a1', [
    ['Sales Automation', 'https://saint-sales-automation.vercel.app/'],
    ['Merchant Fee Automation', 'https://merchant-fee.vercel.app/'],
    ['Advertisement Updation in DRS', 'https://ad-spend-sheet.vercel.app/'],
    ['COGS Automation', 'https://cogs-app.vercel.app/'],
    ['Xero Bill Summary', 'https://xero-bill-summary.vercel.app/'],
    ['Daily Reporting Sheet', 'https://daily-report-sheet.vercel.app/'],
  ]],
  ['6afff706dd2acbc38db65bec', [
    ['Empire Categorizer', 'https://empirecategoriser.vercel.app/'],
    ['Empire GYG Automation', 'https://empire-gyg-ui.vercel.app/'],
    ['Empire Sales', 'https://empire-final-master-frontend.vercel.app/'],
    ['Empire Month-End Entries', 'https://month-end-entries.vercel.app/'],
    ['Empire Payroll', 'https://empire-payroll-six.vercel.app/'],
    ['Xola Reports Downloader', 'https://xola-reports.vercel.app/'],
  ]],
];

export async function seedAutomationCatalog() {
  const ids = await ClientProject.distinct('_id', { _id: { $in: initialCards.map(([id]) => id) }, deletedAt: null });
  const found = new Set(ids.map(String));
  await Promise.all(initialCards.filter(([id]) => found.has(id)).map(([id, cards]) =>
    AutomationGroup.updateOne({ _id: id },
      { $setOnInsert: { links: cards.map(([name, url]) => ({ name, url })) } },
      { upsert: true, timestamps: false }).catch((error) => { if (error.code !== 11000) throw error; })));
}
