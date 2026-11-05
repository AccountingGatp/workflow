import { Client, ClientProject, ProjectWorkItem } from './models/index.js';

/* Imported from user-supplied Bluntd project task register.
   It is a catalog for reference, NOT automatic calendar tasks.
   Source contradictions remain in the schedule fields for management review.
   Re-import never changes manager edits (insert-only). */
const workItems = [
  {
    "sourceKey": "bluntd-sheet-row-1",
    "title": "Mail Checking",
    "weeklyHours": "1 Hour",
    "responsible": "Krupali",
    "frequency": "Daily",
    "executionDay": "Daily",
    "software": "Whatsapp and Accounting ID (2 Ids)",
    "automated": true,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2ztdM8TcCB9D/repeating/repeating-work"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3vr45hkjTHjl"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1N9ihkD6se_34Alw2OiDN9pbkNqduQty0/edit"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-2",
    "title": "Bank & CC Updation",
    "weeklyHours": "2.5 Hours",
    "responsible": "Satya",
    "frequency": "Daily",
    "executionDay": "Every Monday & Friday",
    "software": "Quickbooks Desktop",
    "automated": false,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/39lNxxRQBNvV/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2D526BgzLx4/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/18bXsCRaQGdVqBwwiv743QD33-BOPwwFt2Rd4E1cF3M0/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/95a8b3f3243d46608f292c5eae4fc0dc"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": "Source frequency says Daily, execution day says Monday & Friday. Please confirm."
  },
  {
    "sourceKey": "bluntd-sheet-row-3",
    "title": "Bank Reconciliation",
    "weeklyHours": "0.5 hour",
    "responsible": "Satya",
    "frequency": "Monthly",
    "executionDay": "5th of Every Month",
    "software": "Quickbooks Desktop",
    "automated": false,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/4gPyntR43WkZ"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3Y77tMPwGZQP/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/18bXsCRaQGdVqBwwiv743QD33-BOPwwFt2Rd4E1cF3M0/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/95a8b3f3243d46608f292c5eae4fc0dc"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-4",
    "title": "CC Reconciliation",
    "weeklyHours": "0.5 Hour",
    "responsible": "Satya",
    "frequency": "Monthly",
    "executionDay": "15th of Every Month",
    "software": "Quickbooks Desktop",
    "automated": false,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/39lNxxRQBNvV/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3Y77tMPwGZQP/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/18bXsCRaQGdVqBwwiv743QD33-BOPwwFt2Rd4E1cF3M0/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/95a8b3f3243d46608f292c5eae4fc0dc"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-5",
    "title": "Bill Updation and Payment",
    "weeklyHours": "Bill part Updated by Ryan as of now.",
    "responsible": "Satya",
    "frequency": "Daily",
    "executionDay": "Daily",
    "software": "QBD/ Fishbowl",
    "automated": false,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/4BFJBvJGBnc1/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3M9fmtBqnq8g/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1Zu01mWxlh59nUdyrDHG7lUkz9iIabB4975nPxvZ4a9c/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/f577eee36f8c4410a37cce0af6998491"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-6",
    "title": "Match Customer deposit with Invoice & SO Checking",
    "weeklyHours": "2.5 Hours",
    "responsible": "Krupali",
    "frequency": "Daily",
    "executionDay": "",
    "software": "QBD & Fishbowl",
    "automated": false,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3ZTpBfgZqpdQ/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/Ym3WF9Sr6Yf/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1aMHGSJYttFmt3khEB28dT4oGUOvPzooyE8OxLCoqOrs/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/ad9c3b04e2234d2a9df397f70d009472"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-7",
    "title": "Tsheet Preparation",
    "weeklyHours": "1.5 hrs",
    "responsible": "",
    "frequency": "Weekly-Monday",
    "executionDay": "Monday",
    "software": "",
    "automated": true,
    "reminder": "Done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/GrXcGCDpR18/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/245MB1PWmX63/tasks"
      },
      {
        "label": "Tango SOP",
        "url": "https://app.tango.us/app/workflow/How-to-Upload---Update-Payroll-Time-sheet-from-QBO--31c90afcffc84fe189dcbebbd5c9d698"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/9ae74cc7fb8947c2b449b29059f97236"
      }
    ],
    "category": "Payroll",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-8",
    "title": "Overtime Calculation",
    "weeklyHours": "1 hour",
    "responsible": "",
    "frequency": "Weekly-Monday",
    "executionDay": "Monday",
    "software": "",
    "automated": true,
    "reminder": "Done",
    "links": [
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/245MB1PWmX63/tasks"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/368ee05768b84e3db0b1b78e12e0467e"
      }
    ],
    "category": "Payroll",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-9",
    "title": "Sales report approval for Joey and commission calculation",
    "weeklyHours": "20 Min Monthly",
    "responsible": "",
    "frequency": "Monthly",
    "executionDay": "Monthly",
    "software": "",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/bVXlhSpkffX/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/X9Xy3HBjzPd/repeating/repeating-work"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1TniWcP5BlvZA8JM5e1G2AuQ_Uqr9f4wp8sxsKO1GkwQ/edit"
      }
    ],
    "category": "Payroll",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-10",
    "title": "Payroll processing",
    "weeklyHours": "1.5 hour",
    "responsible": "",
    "frequency": "Weekly-Wednesday",
    "executionDay": "Tuesday",
    "software": "Gusto",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/vXBtzjmbSjj/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2t43GxHmTVGg"
      },
      {
        "label": "Tango SOP",
        "url": "https://app.tango.us/app/workflow/Run-Payroll-from-Gusto-ea48efa3a1e94de093238a3e1a43da27"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/bb643440195b43489600be2a4129ca7a"
      }
    ],
    "category": "Payroll",
    "notes": "Source frequency says Weekly-Wednesday, execution day says Tuesday. Please confirm."
  },
  {
    "sourceKey": "bluntd-sheet-row-11",
    "title": "Payroll Updation-Thursday to Friday",
    "weeklyHours": "1 Hour",
    "responsible": "",
    "frequency": "Weekly",
    "executionDay": "Thursday",
    "software": "QBD",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/Lf2sRZHkTq4/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3Ty92nqzHFnN/tasks"
      },
      {
        "label": "Tango SOP",
        "url": "https://app.tango.us/app/workflow/How-to-Upload---Update-Payroll-Time-sheet-from-QBO--31c90afcffc84fe189dcbebbd5c9d698"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/5588768d52bf499d821a451e0008d21e"
      }
    ],
    "category": "Payroll",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-12",
    "title": "WC Process",
    "weeklyHours": "0.5 Hours",
    "responsible": "",
    "frequency": "Weekly-Wednesday",
    "executionDay": "Thursday",
    "software": "RightSum",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2sxClFwSrwBm/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/4xRjmbNbqYB9/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1r1T524oSxyC8mHzMZGgucySgQ3OyxqSQ7HLvgO2MlcQ/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/58444c27849f46cda04cce1a8b06b891"
      }
    ],
    "category": "Payroll",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-13",
    "title": "Need to send to client work status",
    "weeklyHours": "2 Hours",
    "responsible": "Krupali",
    "frequency": "Weekly-Friday",
    "executionDay": "Friday",
    "software": "",
    "automated": false,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/mPHx6cftwh4/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3kvTG15mXFBc"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-14",
    "title": "JE for interest on Auto Loan",
    "weeklyHours": "10 min monthly",
    "responsible": "Satya",
    "frequency": "Monthly",
    "executionDay": "When you code EMI payment",
    "software": "Mercedes & Stellantis, use credentials from Accounting Ops",
    "automated": false,
    "reminder": "",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/4s6M2PJCmhyh/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/48r5d7V5QGvg/tasks"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-15",
    "title": "PO Checking",
    "weeklyHours": "1 Hour",
    "responsible": "Krupali",
    "frequency": "Daily",
    "executionDay": "Daily",
    "software": "QBD & Fishbowl",
    "automated": false,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2SrxYLsqVcdz"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-16",
    "title": "Review AP and AR",
    "weeklyHours": "1 Hour",
    "responsible": "Krupali",
    "frequency": "Weekly-Thursday",
    "executionDay": "Every Thursday",
    "software": "",
    "automated": false,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/4Hdv5qrP1f3q"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2dgGx5ndHs6G"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-17",
    "title": "Monthly Financials review",
    "weeklyHours": "0.25 Hour( Monthly 2 Hours)",
    "responsible": "Krupali",
    "frequency": "Monthly",
    "executionDay": "12th of Every Month",
    "software": "",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/39HS7RXJ4fFb/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2szYsqHDJzHZ/tasks"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-18",
    "title": "Hazel's Cost Invoice and Bill updation",
    "weeklyHours": "0.5 hours",
    "responsible": "Krupali",
    "frequency": "weekly-Wednesday",
    "executionDay": "Thursday",
    "software": "",
    "automated": true,
    "reminder": "done",
    "links": [
      {
        "label": "Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3PqNSRYQX86k/tasks"
      },
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3TXRmnm4ybjg/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1CB-nDoOzPfCxZhlr6FvyfnMC4zyLej2EIiZF8fc6LjA/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/f4ba508201cc443ea8650d1f2aa10ba6"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-19",
    "title": "Paul Cost Invoice and Bill updation",
    "weeklyHours": "",
    "responsible": "",
    "frequency": "weekly-Wednesday",
    "executionDay": "",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-20",
    "title": "Ryan Cost Invoice and Bill updation",
    "weeklyHours": "",
    "responsible": "",
    "frequency": "Biweekly-Wednesday",
    "executionDay": "",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-21",
    "title": "Meaghan's Cost Invoice and Bill updation",
    "weeklyHours": "0.5 hours",
    "responsible": "",
    "frequency": "Biweekly-Wednesday",
    "executionDay": "Thursday",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1KgQKaauvi_oa4ejFe-xGgSsQwu4xnuap/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/ce2bde70484f468393aeed4249859c75"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-22",
    "title": "Elysia's cost invoice and bill updation",
    "weeklyHours": "0.5 hours",
    "responsible": "",
    "frequency": "Weekly",
    "executionDay": "Thursday",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-23",
    "title": "Mona's Upwork bill and Invoice",
    "weeklyHours": "10 minutes",
    "responsible": "",
    "frequency": "Weekly-Monday",
    "executionDay": "Monthly",
    "software": "This task comes once in while when cody request it",
    "automated": false,
    "reminder": "",
    "links": [
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/3y9gQ9PCfJCF/tasks"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": "Source frequency says Weekly-Monday, execution day says Monthly; task occurs on Cody's request. Please confirm."
  },
  {
    "sourceKey": "bluntd-sheet-row-24",
    "title": "Chelsey Upwork bill and Invoice",
    "weeklyHours": "",
    "responsible": "",
    "frequency": "",
    "executionDay": "",
    "software": "",
    "automated": false,
    "reminder": "",
    "links": [],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-25",
    "title": "Catie Upwork bill and Invoice",
    "weeklyHours": "",
    "responsible": "",
    "frequency": "",
    "executionDay": "",
    "software": "",
    "automated": false,
    "reminder": "",
    "links": [],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-26",
    "title": "Club House hours",
    "weeklyHours": "1 hour",
    "responsible": "Krupali",
    "frequency": "weekly-Wednesday",
    "executionDay": "",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H/work/24WnbbWM5SB6/tasks"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/5bbed3b66b394bbcad27ebaefeb81b1b"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-27",
    "title": "CCA Report",
    "weeklyHours": "1.5 hour",
    "responsible": "Krupali",
    "frequency": "",
    "executionDay": "",
    "software": "QBD, Excel",
    "automated": true,
    "reminder": "",
    "links": [
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/45dSfJkZG1Vc/tasks"
      },
      {
        "label": "SOP",
        "url": "https://docs.google.com/document/d/1onwWNJap0GjznPGFvyeJCgBZ98qYQg2IVqN8NSBM8Fo/edit"
      },
      {
        "label": "Loom video",
        "url": "https://www.loom.com/share/7450725c029444ecaef82553defa4578"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  },
  {
    "sourceKey": "bluntd-sheet-row-28",
    "title": "Crysp",
    "weeklyHours": "1",
    "responsible": "Krupali",
    "frequency": "weekly-Wednesday",
    "executionDay": "",
    "software": "",
    "automated": true,
    "reminder": "",
    "links": [
      {
        "label": "Updated Karbon task",
        "url": "https://app2.karbonhq.com/SNhN2szkD7H#/work/2sPszFh5bsfd/tasks"
      }
    ],
    "category": "Bookkeeping & Operations",
    "notes": ""
  }
];

export async function seedBluntdWorkItems() {
  const client = await Client.findOne({ name: /^Republic Supply Company LLC$/i }).select('_id');
  if (!client) return;
  const project = await ClientProject.findOne({ client: client._id, name: 'Bluntd' }).select('_id');
  if (!project) return;
  await ProjectWorkItem.bulkWrite(workItems.map(item => ({
    updateOne: {
      filter: { project: project._id, sourceKey: item.sourceKey },
      update: { $setOnInsert: { ...item, client: client._id, project: project._id } },
      upsert: true,
    },
  })), { ordered: false });
  const stored = await ProjectWorkItem.countDocuments({ project: project._id, sourceKey: /^bluntd-sheet-row-/ });
  console.info('Bluntd source task register verified in MongoDB:', { expected: workItems.length, stored });
  if (stored !== workItems.length) throw new Error('Bluntd task register import did not fully verify');
}
