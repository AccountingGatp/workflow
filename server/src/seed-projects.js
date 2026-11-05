import { Client, ClientProject, Task, TaskTemplate } from './models/index.js';

/**
 * One-time project profile import from the Republic Supply / Bluntd overview
 * supplied by the client manager. Never changes previously saved project edits.
 * Reference URLs are stored as links; no credentials or passwords are imported.
 */
export async function seedRepublicProjects() {
  const client = await Client.findOne({ name: /^Republic Supply Company LLC$/i }).select('_id');
  if (!client) return;
  const bluntd = {
    client: client._id,
    name: 'Bluntd',
    description: 'Bluntd cones — manufacturing project operated under Republic Supply Company LLC. Client overview supplied by GATP.',
    businessType: 'Manufacturing blunt cones',
    website: 'https://bluntdcones.com/',
    contacts: [
      { name: 'Cody Baldwin', role: 'Owner · Main contact', email: 'sales@bluntdcones.com' },
      { name: 'Issa Madanat', role: 'Co-owner', email: 'issa@bluntdcones.com' },
      { name: 'Carlos Silva', role: 'Office / Payroll Manager · Payroll only', email: 'carlos@bluntdcones.com' },
    ],
    team: [
      { name: 'Palak Soni', role: 'Manager', profileUrl: 'https://gatpclients.slack.com/team/U04FL4PQWLA' },
      { name: 'Dhwani Tamboli', role: 'Team Lead', profileUrl: 'https://gatpclients.slack.com/team/U092TV01PN2' },
      { name: 'Krupali Shah', role: 'Team member', profileUrl: 'https://gatpclients.slack.com/team/U071PT80N2Y' },
    ],
    scope: [
      'Mail checking — daily',
      'Bank and credit card updates — one bank and one card, weekly',
      'Bank reconciliation — one bank, monthly',
      'Credit card reconciliation — one account',
      'Stripe reconciliation — one account',
      'Bill updates and payments — daily',
      'Purchase order checking — daily',
      'Review accounts payable and receivable — monthly',
      'Monthly Profit & Loss review',
      'Monthly Balance Sheet review',
      'Record sales and purchases from inventory management software and track AP/AR',
      'Payroll processing and employee onboarding through Gusto',
      'Workers compensation processing',
    ],
    excluded: [
      'Sales and federal tax compliance',
      'Inventory tracking and month-end inventory reconciliation',
    ],
    links: [
      { label: 'Karbon task overview', url: 'https://app2.karbonhq.com/SNhN2szkD7H#/work-overview?view=21QTjdfCsFx8' },
      { label: 'Scope, timelines and daily bookkeeping sheet', url: 'https://docs.google.com/spreadsheets/d/1HFxVGQQ8Nmk5AwrX5MHrPTYbVcCvLfszVUNkwUxdHwQ/edit?gid=1285117344#gid=1285117344' },
      { label: 'Credentials reference (restricted)', url: 'https://docs.google.com/spreadsheets/d/1f3V6M30mFoP_K-MiNYcv3YuBYXWXYyP8-vc5K0SOoLM/edit?gid=0#gid=0', restricted: true },
      { label: 'Bookkeeper onboarding', url: 'https://docs.google.com/document/d/1Ux8zMFoRQivgbYpg4XYa1_KkFUdNOFJQByUPVV2uoOU/edit' },
      { label: 'Payroll report upload folder', url: 'https://drive.google.com/drive/u/2/folders/1Gb8_B4RYIVHtVt_2p5oQYAaA_OwHK3AQ' },
      { label: 'Remote access restart guide', url: 'https://www.loom.com/share/50249f2a9c4145938397d95d1d39c2d2' },
      { label: 'Onboarding documents', url: 'https://docs.google.com/document/d/1t6V60CG3H9RWKFGLNFY3k1oO3DUuZVovjzvaAqhu04U/edit' },
      { label: 'Roadmap document', url: 'https://docs.google.com/document/d/1C9XbsexgR4qPAqU-iSjEm2TyODb-ozku/edit' },
      { label: 'Miro roadmap', url: 'https://miro.com/app/board/uXjVJQFual0=/' },
      { label: 'Additional Bluntd work', url: 'https://docs.google.com/document/d/14g9zAzu64KwnWS4B6zfQNLN76WOHQfx4GVraQQcpcoY/edit' },
      { label: 'Intercompany sheet', url: 'https://docs.google.com/spreadsheets/d/15wfb_TVWEgEIkJflOIPZ3v5KPbo_Neh1IGdrylqnCNQ/edit?gid=0#gid=0' },
      { label: 'RDP connection demonstration', url: 'https://www.loom.com/share/b7bae72d3d164224a62739c3b3a3cb99' },
      { label: 'Fishbowl SO/PO reconciliation demonstration', url: 'https://www.loom.com/share/ad9c3b04e2234d2a9df397f70d009472' },
      { label: 'Manager folder structure', url: 'https://docs.google.com/document/d/1tssclQ4hIkbAlrJWjwqUFlnTanHpHfgSozLH-yxkJGc/edit' },
      { label: 'QBD import tool reference', url: 'https://gatpclients.slack.com/files/U0BJYK7M6FQ/F08F4DATU1Z/qbimport.accdb' },
    ],
    tools: [
      { name: 'Remote Desktop (RDP)', purpose: 'Access QuickBooks Desktop, Fishbowl and client email', url: 'https://www.loom.com/share/b7bae72d3d164224a62739c3b3a3cb99' },
      { name: 'QuickBooks Desktop', purpose: 'Bookkeeping' },
      { name: 'Gusto', purpose: 'Payroll processing and onboarding' },
      { name: 'Fishbowl', purpose: 'Inventory management and order records' },
      { name: 'Stripe', purpose: 'Customer payments' },
    ],
    automations: [
      'QBD bank and credit card transaction import tool available; client QBD version may be outdated',
      'Workers compensation macro: internal Z: drive / GATP / VBA Programm / Worker compensation',
      'AI-assisted financial review',
    ],
    quality: [
      { title: "Owner's perspective", items: [
        'Timely payroll every Wednesday',
        'AP and AR reporting every Friday',
        'Daily reconciliation with Fishbowl',
        'Proper reconciliation of Fishbowl sales orders and purchase orders',
        'Sales and purchases synchronized with Fishbowl',
      ] },
      { title: "Manager's perspective", items: [
        'Well-defined tasks and deadlines',
        'Well-defined folder structure',
        'Automate major repetitive tasks where possible',
        'Maintain quality standards and GATP guarantees',
      ] },
      { title: "Technician's perspective", items: [
        'Complete documentation',
        'Daily mail checking',
        'Timely task completion',
        'Client reporting',
        'Daily QuickBooks and Fishbowl reconciliation',
        'Proper bank and credit-card transaction categorization',
      ] },
    ],
    guarantees: [
      'Process payroll by Wednesday each week',
      'Send AP and AR reports by Friday each week',
      'Reconcile Fishbowl purchase and sales orders daily',
      'Sync data between QuickBooks and Fishbowl daily',
    ],
    notes: 'Compliance noted: timely payroll submission and 1099 processing. Confirm exact scope and schedule with the manager before changing existing recurring tasks.',
  };
  await ClientProject.updateOne({ client: client._id, name: 'Bluntd' }, { $setOnInsert: bluntd }, { upsert: true });
  await ClientProject.updateOne({ client: client._id, name: 'Bravura' }, { $setOnInsert: {
    client: client._id, name: 'Bravura', description: 'Project workspace created under Republic Supply Company LLC. Scope, contacts, deadlines and links to be added by the manager.',
  } }, { upsert: true });
  // Classify the four existing Republic recurring workflows that match the
  // supplied Bluntd scope. Keep all other tasks unassigned for manual review.
  // Never overwrite a project already chosen by a manager.
  const bluntdProject = await ClientProject.findOne({ client: client._id, name: 'Bluntd' }).select('_id');
  const legacyTitles = [
    /^mail checking$/i,
    /^bank\s*(?:&|and)\s*cc updating$/i,
    /^bill updating\s*(?:&|and)\s*payment$/i,
    /^po checking$/i,
  ];
  const matches = { $in: legacyTitles };
  const templateMove = await TaskTemplate.updateMany({
    client: client._id, project: null, title: matches,
  }, { $set: { project: bluntdProject._id } });
  const taskMove = await Task.updateMany({
    client: client._id, project: null, title: matches,
  }, { $set: { project: bluntdProject._id } });
  console.info('Republic legacy tasks grouped under Bluntd:', {
    recurringSchedules: templateMove.modifiedCount,
    taskOccurrences: taskMove.modifiedCount,
  });
  const stored = await ClientProject.find({ client: client._id, name: { $in: ['Bluntd', 'Bravura'] } })
    .select('name contacts scope team links').lean();
  const bluntdStored = stored.find(p => p.name === 'Bluntd');
  const bravuraStored = stored.find(p => p.name === 'Bravura');
  if (!bluntdStored || !bravuraStored || !bluntdStored.scope?.length || !bluntdStored.contacts?.length) {
    throw new Error('Republic project import verification failed');
  }
  console.info('Republic projects verified in MongoDB:', {
    names: stored.map(p => p.name),
    bluntdContacts: bluntdStored.contacts.length,
    bluntdScopeItems: bluntdStored.scope.length,
    bluntdTeamMembers: bluntdStored.team.length,
    bluntdReferenceLinks: bluntdStored.links.length,
  });
}
