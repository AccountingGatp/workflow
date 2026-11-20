import { model, Schema } from 'mongoose';
import { User } from '../models/index.js';

export const companyEmail = (email) => typeof email === 'string' &&
  /^[^\s@]+@gatpsolutions\.com$/.test(email) && email.length <= 254;

export const SignInRequest = model('SignInRequest', new Schema({
  _id: String,
  name: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
}, { timestamps: true }), 'sign_in_requests');

export async function requestCompanyAccess(email, name) {
  if (!companyEmail(email) || await User.exists({ email })) return null;
  const suggested = typeof name === 'string' && name.trim()
    ? name.trim().slice(0, 150)
    : email.split('@')[0].replace(/[._-]+/g, ' ').trim().slice(0, 150) || email;
  const request = await SignInRequest.findOneAndUpdate({ _id: email }, {
    $setOnInsert: { name: suggested, status: 'pending' },
  }, { upsert: true, returnDocument: 'after' });
  if (request.status !== 'approved') return request.status;

  // A removed account releases its email. A new verified sign-in needs fresh approval.
  return User.db.transaction(async (session) => {
    if (await User.exists({ email }).session(session)) return null;
    const current = await SignInRequest.findById(email).session(session);
    if (current?.status !== 'approved') return current?.status || null;
    const reopened = await SignInRequest.findOneAndUpdate({ _id: email, status: 'approved' }, {
      $set: { name: suggested, status: 'pending', createdAt: new Date(), updatedAt: new Date() },
      $unset: { decidedAt: '', decidedBy: '' },
    }, { session, timestamps: false, overwriteImmutable: true, returnDocument: 'after' });
    return reopened?.status || null;
  });
}
