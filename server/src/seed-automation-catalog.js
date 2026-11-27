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

const additionalCards = [
  ['6afff707dd2acbc38db65bf4', [
    ['Monthly Recurring Entries', 'https://hamilton-monthly-recurring-entries.vercel.app/'],
    ['Duplicate Invoice Checker', 'https://hamilton-duplicate-invoice.vercel.app/'],
    ['Bank Matching', 'https://hamilton-bank-matching.vercel.app/'],
    ['GL Review', 'https://hamilton-gl-review.vercel.app/'],
    ['Payroll Automation', 'https://hamilton-payroll.vercel.app/'],
  ]],
  ['6affec83763f1cacbcc36719', [
    ['Settlement Automation', 'https://settelement.vercel.app/'],
    ['Bill Automation', 'https://lxp-bill-automation.vercel.app/'],
  ]],
];

async function addStarterCards(id, cards) {
  const migrations = AutomationGroup.db.collection('workflow_migrations');
  const _id = `automation-cards-hamilton-lxp-v1-${id}`;
  if (await migrations.findOne({ _id })) return;
  try {
    await AutomationGroup.db.transaction(async (session) => {
      if (await migrations.findOne({ _id }, { session })) return;
      await migrations.insertOne({ _id, createdAt: new Date() }, { session });
      const group = await AutomationGroup.findById(id).session(session);
      const starterLinks = cards.map(([name, url]) => ({ name, url }));
      if (!group) {
        await AutomationGroup.create([{ _id: id, links: starterLinks }], { session });
        return;
      }
      const urls = new Set(group.links.map((link) => link.url));
      group.links.push(...starterLinks.filter((link) => !urls.has(link.url)));
      if (group.isModified('links')) await group.save({ session });
    });
  } catch (error) {
    if (error.code !== 11000 || !await migrations.findOne({ _id })) throw error;
  }
}

export async function seedAutomationCatalog() {
  const ids = await ClientProject.distinct('_id', { _id: { $in: [...initialCards, ...additionalCards].map(([id]) => id) }, deletedAt: null });
  const found = new Set(ids.map(String));
  await Promise.all(initialCards.filter(([id]) => found.has(id)).map(([id, cards]) =>
    AutomationGroup.updateOne({ _id: id },
      { $setOnInsert: { links: cards.map(([name, url]) => ({ name, url })) } },
      { upsert: true, timestamps: false }).catch((error) => { if (error.code !== 11000) throw error; })));
  for (const [id, cards] of additionalCards) {
    if (found.has(id)) await addStarterCards(id, cards);
  }
}
