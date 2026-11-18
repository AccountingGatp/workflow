import mongoose from 'mongoose';
import { ensureReviewCatalog } from './budgets.js';

const { Schema } = mongoose;
const timestamps = { timestamps: true };
const text = { type: String, required: true };
const hours = { type: Number, min: 0, max: 24 };
const options = { ...timestamps, optimisticConcurrency: true };

const projectSchema = new Schema({
  name: text,
  clientId: text,
  workflowProjectId: String,
  archived: { type: Boolean, default: false },
}, timestamps);
projectSchema.index({ clientId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const catalogSchema = new Schema({
  projectId: text,
  title: text,
  description: String,
  hours: { type: Number, min: 0, max: 744 },
  period: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
  archived: { type: Boolean, default: false },
}, timestamps);
catalogSchema.index({ projectId: 1, title: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const assignmentSchema = new Schema({
  _id: String,
  projectId: text,
  memberId: text,
  hours,
}, timestamps);
assignmentSchema.index({ memberId: 1 });

const memberSchema = new Schema({
  _id: String,
  enrolled: { type: Boolean, default: true },
  shift: { type: String, enum: ['morning', 'afternoon'], default: 'morning' },
  reportFrom: String,
  hubstaffUserId: String,
  hubstaffAccess: { type: Boolean, default: false },
}, timestamps);

const leaveSchema = new Schema({ _id: String, memberId: text, date: text }, timestamps);
leaveSchema.index({ date: 1, memberId: 1 });

const entry = new Schema({
  projectId: text,
  clientId: text,
  projectName: text,
  catalogId: String,
  workflowTaskId: String,
  title: text,
  hours: { ...hours, required: true },
  priority: { type: String, enum: ['low', 'normal', 'high'], required: true },
  status: { type: String, enum: ['incomplete', 'complete'], required: true },
});
const submissionSchema = new Schema({
  _id: String,
  memberId: text,
  memberName: text,
  date: text,
  entries: [entry],
  slackChannel: String,
  slackTs: String,
  delivery: { type: String, enum: ['pending', 'sending', 'sent', 'skipped', 'failed', 'uncertain'] },
  deliveryAt: Date,
  deliveryAfter: Date,
}, options);
submissionSchema.index({ date: 1, memberId: 1 });
submissionSchema.index({ memberId: 1, date: 1 });
submissionSchema.index({ delivery: 1, deliveryAfter: 1 });

const reportSchema = new Schema({ _id: String, state: text, startedAt: Date, expiresAt: Date });
reportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const budgetRevisionSchema = new Schema({ _id: String, revision: Number });
const catalogInitialization = new WeakMap();

let dedicated;
let dedicatedUri;
export async function dailyModels() {
  const uri = process.env.DAILY_WORK_MONGODB_URI;
  const dbName = process.env.DAILY_WORK_DB_NAME || 'workflow_daily_work';
  if (dbName === mongoose.connection.name) throw new Error('Daily Work requires a different database name');
  if (uri && (!dedicated || dedicatedUri !== uri)) {
    dedicatedUri = uri;
    const connection = mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 });
    dedicated = connection.asPromise().catch(async (error) => {
      dedicated = undefined;
      await connection.destroy().catch(() => {});
      throw error;
    });
  }
  const db = uri ? await dedicated : mongoose.connection.useDb(dbName, { useCache: true });
  function model(name, schema, collection) {
    return db.models[name] || db.model(name, schema, collection);
  }
  const models = {
    Project: model('DailyProject', projectSchema, 'projects'),
    CatalogTask: model('DailyCatalogTask', catalogSchema, 'task_catalog'),
    Assignment: model('DailyAssignment', assignmentSchema, 'work_distribution'),
    BudgetRevision: model('DailyBudgetRevision', budgetRevisionSchema, 'budget_revisions'),
    Member: model('DailyMember', memberSchema, 'members'),
    Leave: model('DailyLeave', leaveSchema, 'leave'),
    Submission: model('DailySubmission', submissionSchema, 'daily_submissions'),
    Report: model('DailySlackReport', reportSchema, 'slack_report_runs'),
  };
  await Promise.all(Object.values(models).map((item) => item.init()));
  if (!catalogInitialization.has(db)) {
    const prepare = Promise.all([
      models.CatalogTask.updateMany({ period: { $exists: false } }, { $set: { period: 'daily' } }, { timestamps: false }),
      models.Project.find().select('_id').lean().then((projects) => ensureReviewCatalog(models, projects)),
    ])
      .catch((error) => { catalogInitialization.delete(db); throw error; });
    catalogInitialization.set(db, prepare);
  }
  await catalogInitialization.get(db);
  return models;
}
