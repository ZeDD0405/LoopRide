require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const mongoose  = require('mongoose');

const app = express();

/* ════════════════════════════════════════════════
   MIDDLEWARE
════════════════════════════════════════════════ */
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

/* ════════════════════════════════════════════════
   SCHEMA
   Every nested doc gets id (string) via toJSON transform.
════════════════════════════════════════════════ */
const tfm = (_, ret) => {
  if (ret._id) { ret.id = ret._id.toString(); delete ret._id; }
  delete ret.__v;
  return ret;
};
const subOpts  = { _id: true, toJSON: { transform: tfm } };
const baseOpts = { timestamps: true, toJSON: { transform: tfm } };

const ReplySchema = new mongoose.Schema({
  author:    { type: String, default: null },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, subOpts);

const CommentSchema = new mongoose.Schema({
  author:    { type: String, default: null },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  replies:   [ReplySchema],
}, subOpts);

const ActivitySchema = new mongoose.Schema({
  type: { type: String, required: true },
  by:   { type: String, default: null },
  at:   { type: Date,   default: Date.now },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, subOpts);

const TaskSchema = new mongoose.Schema({
  title:     { type: String, required: true, trim: true, maxlength: 200 },
  status:    { type: String, enum: ['todo','assigned','doing','done'], default: 'todo' },
  assignee:  { type: String, default: null },
  createdBy: { type: String, default: null },
  comments:  [CommentSchema],
  activity:  [ActivitySchema],
}, baseOpts);

const Task = mongoose.model('Task', TaskSchema);

/* ════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */
// Wraps async route handlers – no try/catch boilerplate
const go = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  });

const notFound = (res, what = 'Resource') =>
  res.status(404).json({ ok: false, error: `${what} not found` });

/* ════════════════════════════════════════════════
   ROUTES
════════════════════════════════════════════════ */

// Health – Render uses this to confirm the service is up
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── GET /api/tasks ──────────────────────────────
app.get('/api/tasks', go(async (req, res) => {
  const tasks = await Task.find().sort({ createdAt: 1 }).lean({ virtuals: false });
  // lean() returns plain objects; apply manual id transform
  res.json({ ok: true, tasks: tasks.map(leanFmt) });
}));

// ── POST /api/tasks ─────────────────────────────
app.post('/api/tasks', go(async (req, res) => {
  const { title, by } = req.body;
  if (!title?.trim()) return res.status(400).json({ ok: false, error: 'title is required' });

  const task = await Task.create({
    title:     title.trim(),
    createdBy: by || null,
    activity:  [{ type: 'created', by: by || null }],
  });
  res.status(201).json({ ok: true, task: task.toJSON() });
}));

// ── PATCH /api/tasks/:id/assign ─────────────────
app.patch('/api/tasks/:id/assign', go(async (req, res) => {
  const { assignee, by } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return notFound(res, 'Task');

  const prev     = task.assignee;
  task.assignee  = assignee || null;

  // Auto-move status
  if (assignee && task.status === 'todo')     task.status = 'assigned';
  if (!assignee && task.status === 'assigned') task.status = 'todo';

  task.activity.push({
    type: assignee ? 'assigned' : 'unassigned',
    by:   by || null,
    meta: { from: prev, to: assignee || null },
  });

  await task.save();
  res.json({ ok: true, task: task.toJSON() });
}));

// ── PATCH /api/tasks/:id/status ─────────────────
app.patch('/api/tasks/:id/status', go(async (req, res) => {
  const { status, by } = req.body;
  const VALID = ['todo', 'assigned', 'doing', 'done'];
  if (!VALID.includes(status))
    return res.status(400).json({ ok: false, error: `status must be one of: ${VALID.join(', ')}` });

  const task = await Task.findById(req.params.id);
  if (!task) return notFound(res, 'Task');

  const prev   = task.status;
  task.status  = status;
  task.activity.push({ type: 'status', by: by || null, meta: { from: prev, to: status } });

  await task.save();
  res.json({ ok: true, task: task.toJSON() });
}));

// ── DELETE /api/tasks/:id ───────────────────────
app.delete('/api/tasks/:id', go(async (req, res) => {
  const task = await Task.findByIdAndDelete(req.params.id);
  if (!task) return notFound(res, 'Task');
  res.json({ ok: true });
}));

// ── POST /api/tasks/:id/comments ────────────────
app.post('/api/tasks/:id/comments', go(async (req, res) => {
  const { author, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ ok: false, error: 'text is required' });

  const task = await Task.findById(req.params.id);
  if (!task) return notFound(res, 'Task');

  task.comments.push({ author: author || null, text: text.trim() });
  task.activity.push({ type: 'commented', by: author || null });
  await task.save();
  res.json({ ok: true, task: task.toJSON() });
}));

// ── POST /api/tasks/:id/comments/:cid/replies ───
app.post('/api/tasks/:id/comments/:cid/replies', go(async (req, res) => {
  const { author, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ ok: false, error: 'text is required' });

  const task = await Task.findById(req.params.id);
  if (!task) return notFound(res, 'Task');

  const comment = task.comments.id(req.params.cid);
  if (!comment) return notFound(res, 'Comment');

  comment.replies.push({ author: author || null, text: text.trim() });
  task.activity.push({ type: 'replied', by: author || null, meta: { commentId: req.params.cid } });
  await task.save();
  res.json({ ok: true, task: task.toJSON() });
}));

/* ════════════════════════════════════════════════
   LEAN FORMAT  (for GET /api/tasks with lean())
════════════════════════════════════════════════ */
function leanFmt(doc) {
  doc.id = doc._id.toString();
  delete doc._id; delete doc.__v;
  doc.comments = (doc.comments || []).map(c => {
    c.id = c._id.toString(); delete c._id;
    c.replies = (c.replies || []).map(r => {
      r.id = r._id.toString(); delete r._id; return r;
    });
    return c;
  });
  doc.activity = (doc.activity || []).map(a => {
    a.id = a._id.toString(); delete a._id; return a;
  });
  return doc;
}

/* ════════════════════════════════════════════════
   SEED  (runs once if DB is empty)
════════════════════════════════════════════════ */
async function seedIfEmpty() {
  if (await Task.countDocuments() > 0) return;
  console.log('🌱  Seeding initial tasks…');
  const rows = [
    { title: 'Design homepage layout',     status: 'todo',     assignee: null,       createdBy: null },
    { title: 'Set up backend API routes',  status: 'todo',     assignee: null,       createdBy: null },
    { title: 'Write unit tests',           status: 'todo',     assignee: null,       createdBy: null },
    { title: 'Database schema design',     status: 'assigned', assignee: 'sagar',    createdBy: 'sagar' },
    { title: 'Build UI component library', status: 'doing',    assignee: 'varad',    createdBy: 'varad' },
    { title: 'Deploy to staging server',   status: 'done',     assignee: 'leonardo', createdBy: 'leonardo' },
  ];
  for (const r of rows) {
    await Task.create({ ...r, activity: [{ type: 'created', by: r.createdBy }] });
  }
  console.log(`✅  Seeded ${rows.length} tasks`);
}

/* ════════════════════════════════════════════════
   START
════════════════════════════════════════════════ */
const PORT      = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌  MONGODB_URI is not set. Create a .env file from .env.example');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅  Connected to MongoDB');
    await seedIfEmpty();
    app.listen(PORT, () =>
      console.log(`🚀  Loop API running → http://localhost:${PORT}`)
    );
  })
  .catch(err => {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  });
