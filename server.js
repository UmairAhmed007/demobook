const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let users = [], posts = [], groups = [], groupMessages = [], stories = [], messages = [];
let friendships = new Map(), friendRequests = new Map(), sessions = new Map();
let nextUserId = 1, nextPostId = 1, nextCommentId = 1, nextMessageId = 1;
let nextGroupId = 1, nextGroupMessageId = 1, nextStoryId = 1;
const sseClients = new Map();
const STORY_TTL = 24 * 60 * 60 * 1000;

// ---------- password hashing ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (!stored.includes(':')) return pw === stored;
  const [salt, h] = stored.split(':');
  try { return crypto.timingSafeEqual(Buffer.from(h,'hex'), Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'),'hex')); }
  catch { return false; }
}

// ---------- persistence ----------
function save() {
  try {
    const d = {
      users, posts, messages, groups, groupMessages, stories,
      friendships: [...friendships].map(([k,v]) => [k,[...v]]),
      friendRequests: [...friendRequests].map(([k,v]) => [k,[...v]]),
      nextUserId, nextPostId, nextCommentId, nextMessageId,
      nextGroupId, nextGroupMessageId, nextStoryId
    };
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('[db] save failed:', e.message); }
}
function load() {
  if (!fs.existsSync(DB_FILE)) return false;
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    users = d.users || []; posts = d.posts || []; messages = d.messages || [];
    groups = d.groups || []; groupMessages = d.groupMessages || []; stories = d.stories || [];
    friendships = new Map((d.friendships||[]).map(([k,v])=>[k,new Set(v)]));
    friendRequests = new Map((d.friendRequests||[]).map(([k,v])=>[k,new Set(v)]));
    nextUserId = d.nextUserId || (users.reduce((m,u)=>Math.max(m,u.id),0)+1);
    nextPostId = d.nextPostId || (posts.reduce((m,p)=>Math.max(m,p.id),0)+1);
    nextCommentId = d.nextCommentId || 1;
    nextMessageId = d.nextMessageId || (messages.reduce((m,x)=>Math.max(m,x.id),0)+1);
    nextGroupId = d.nextGroupId || (groups.reduce((m,g)=>Math.max(m,g.id),0)+1);
    nextGroupMessageId = d.nextGroupMessageId || (groupMessages.reduce((m,x)=>Math.max(m,x.id),0)+1);
    nextStoryId = d.nextStoryId || (stories.reduce((m,s)=>Math.max(m,s.id),0)+1);
    console.log(`[db] loaded ${users.length}u ${posts.length}p ${messages.length}m ${groups.length}g ${stories.length}s`);
    return true;
  } catch (e) { console.error('[db] load failed:', e.message); return false; }
}
app.use((req,res,next) => { res.on('finish', () => { if (req.method !== 'GET' && res.statusCode < 400) save(); }); next(); });

function broadcast(userIds, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const uid of userIds) {
    const set = sseClients.get(uid);
    if (!set) continue;
    for (const res of set) { try { res.write(payload); } catch {} }
  }
}
function auth(req,res,next) {
  let token = req.headers.authorization?.replace('Bearer ','');
  if (!token && req.query.token) token = req.query.token;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = sessions.get(token);
  const u = getUser(req.userId);
  if (u) u.lastActiveAt = Date.now();
  next();
}
function getUser(id) { return users.find(u => u.id === id); }
function publicUser(u) { return { id:u.id, username:u.username, name:u.name, bio:u.bio, avatarColor:u.avatarColor, lastActiveAt:u.lastActiveAt||null }; }

function extractTags(c) {
  if (!c) return [];
  const r = /#([a-zA-Z0-9_]+)/g, t = []; let m;
  while ((m = r.exec(c)) !== null) t.push(m[1].toLowerCase());
  return [...new Set(t)];
}
function extractMentions(c) {
  if (!c) return [];
  const r = /@([a-zA-Z0-9_]+)/g, t = []; let m;
  while ((m = r.exec(c)) !== null) t.push(m[1].toLowerCase());
  return [...new Set(t)];
}
function formatPost(p, me) {
  const a = getUser(p.userId);
  return {
    id: p.id,
    author: { id: a.id, name: a.name, username: a.username, avatarColor: a.avatarColor },
    content: p.content, imageUrl: p.imageUrl || null,
    createdAt: p.createdAt, mine: p.userId === me,
    likes: p.likes.length, likedByMe: p.likes.includes(me),
    tags: extractTags(p.content),
    comments: p.comments.map(c => {
      const cu = getUser(c.userId);
      return { id: c.id, author: { id: cu.id, name: cu.name, avatarColor: cu.avatarColor }, content: c.content, createdAt: c.createdAt, mine: c.userId === me };
    })
  };
}

// ---------- seed ----------
function seed() {
  const a = { id: nextUserId++, username:'alice', password: hashPassword('pass'), name:'Alice Johnson', bio:'Hello, I am Alice!', avatarColor:'#6c5ce7', lastActiveAt: Date.now() };
  const b = { id: nextUserId++, username:'bob', password: hashPassword('pass'), name:'Bob Smith', bio:'Just a Bob.', avatarColor:'#00b894', lastActiveAt: Date.now() };
  users.push(a, b);
  friendships.set(a.id, new Set([b.id]));
  friendships.set(b.id, new Set([a.id]));
  friendRequests.set(a.id, new Set());
  friendRequests.set(b.id, new Set());
  posts.push({
    id: nextPostId++, userId: a.id,
    content: 'Hey everyone! First post. #hello #intro',
    imageUrl: null, createdAt: Date.now()-3600000, likes:[b.id],
    comments:[{ id:nextCommentId++, userId:b.id, content:'Welcome @alice!', createdAt:Date.now()-1800000 }]
  });
  posts.push({
    id: nextPostId++, userId: b.id,
    content: 'Building a social net #coding — hi @alice!',
    imageUrl: null, createdAt: Date.now()-7200000, likes:[], comments:[]
  });
  save();
  console.log(`[db] seeded at ${DB_FILE}`);
}

// ---------- SSE ----------
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  if (!sseClients.has(req.userId)) sseClients.set(req.userId, new Set());
  sseClients.get(req.userId).add(res);
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(ka);
    const s = sseClients.get(req.userId);
    if (s) { s.delete(res); if (!s.size) sseClients.delete(req.userId); }
  });
});

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  const { username, password, name, bio } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const user = {
    id: nextUserId++, username, password: hashPassword(password), name,
    bio: bio || '',
    avatarColor: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),
    lastActiveAt: Date.now()
  };
  users.push(user);
  friendships.set(user.id, new Set());
  friendRequests.set(user.id, new Set());
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, user.id);
  res.json({ token, user: publicUser(user) });
});
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.password.includes(':')) { user.password = hashPassword(password); save(); }
  user.lastActiveAt = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, user.id);
  res.json({ token, user: publicUser(user) });
});
app.post('/api/logout', auth, (req, res) => {
  sessions.delete(req.headers.authorization?.replace('Bearer ',''));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(publicUser(getUser(req.userId))));
app.patch('/api/me', auth, (req, res) => {
  const u = getUser(req.userId);
  const { name, bio, avatarColor } = req.body;
  if (typeof name === 'string' && name.trim()) u.name = name.trim();
  if (typeof bio === 'string') u.bio = bio.trim();
  if (typeof avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatarColor)) u.avatarColor = avatarColor;
  res.json(publicUser(u));
});

// ---------- posts ----------
app.get('/api/posts', auth, (req, res) => {
  const me = req.userId;
  const friends = friendships.get(me) || new Set();
  const ids = new Set([me, ...friends]);
  res.json(posts.filter(p => ids.has(p.userId)).sort((a,b) => b.createdAt - a.createdAt).map(p => formatPost(p, me)));
});
app.post('/api/posts', auth, (req, res) => {
  const { content, imageUrl } = req.body;
  if ((!content || !content.trim()) && (!imageUrl || !imageUrl.trim())) return res.status(400).json({ error: 'Post needs text or image' });
  const post = {
    id: nextPostId++, userId: req.userId,
    content: (content || '').trim(),
    imageUrl: (imageUrl || '').trim() || null,
    createdAt: Date.now(), likes: [], comments: []
  };
  posts.push(post);
  const friends = friendships.get(req.userId) || new Set();
  const notified = new Set([...friends]);
  extractMentions(post.content).forEach(un => {
    const u = users.find(x => x.username.toLowerCase() === un);
    if (u) notified.add(u.id);
  });
  broadcast([...notified], { type: 'new_post', postId: post.id, authorId: req.userId });
  res.json(formatPost(post, req.userId));
});
app.delete('/api/posts/:id', auth, (req, res) => {
  const i = posts.findIndex(p => p.id === parseInt(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  if (posts[i].userId !== req.userId) return res.status(403).json({ error: 'Not yours' });
  posts.splice(i, 1);
  res.json({ ok: true });
});
app.post('/api/posts/:id/like', auth, (req, res) => {
  const p = posts.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const i = p.likes.indexOf(req.userId);
  if (i === -1) p.likes.push(req.userId); else p.likes.splice(i, 1);
  if (p.userId !== req.userId) broadcast([p.userId], { type: 'post_like', postId: p.id, byId: req.userId });
  res.json({ liked: i === -1, likes: p.likes.length });
});
app.post('/api/posts/:id/comments', auth, (req, res) => {
  const p = posts.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Required' });
  const c = { id: nextCommentId++, userId: req.userId, content: content.trim(), createdAt: Date.now() };
  p.comments.push(c);
  if (p.userId !== req.userId) broadcast([p.userId], { type: 'post_comment', postId: p.id, byId: req.userId });
  const cu = getUser(req.userId);
  res.json({ id: c.id, author: { id: cu.id, name: cu.name, avatarColor: cu.avatarColor }, content: c.content, createdAt: c.createdAt, mine: true });
});
app.delete('/api/posts/:pid/comments/:cid', auth, (req, res) => {
  const p = posts.find(x => x.id === parseInt(req.params.pid));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const i = p.comments.findIndex(c => c.id === parseInt(req.params.cid));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  if (p.comments[i].userId !== req.userId) return res.status(403).json({ error: 'Not yours' });
  p.comments.splice(i, 1);
  res.json({ ok: true });
});

// ---------- tags ----------
app.get('/api/tags/:tag', auth, (req, res) => {
  const tag = req.params.tag.toLowerCase();
  const me = req.userId;
  res.json({ tag, posts: posts.filter(p => extractTags(p.content).includes(tag)).sort((a,b) => b.createdAt - a.createdAt).map(p => formatPost(p, me)) });
});

// ---------- notifications ----------
app.get('/api/notifications', auth, (req, res) => {
  const me = req.userId;
  const pendingRequests = (friendRequests.get(me) || new Set()).size;
  const unreadMessages = messages.filter(m => m.toId === me && !m.readAt).length;
  const unreadGroups = groupMessages.filter(m => {
    const g = groups.find(x => x.id === m.groupId);
    if (!g || !g.members.includes(me) || m.fromId === me) return false;
    return !(g.reads && g.reads[me] && g.reads[me] >= m.id);
  }).length;
  res.json({ pendingRequests, unreadMessages, unreadGroups, total: pendingRequests + unreadMessages + unreadGroups });
});

// ---------- user search ----------
app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const me = req.userId;
  const friends = friendships.get(me) || new Set();
  const incoming = friendRequests.get(me) || new Set();
  res.json(users.filter(u => u.id !== me && (u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))).slice(0, 20).map(u => ({
    ...publicUser(u),
    isFriend: friends.has(u.id),
    pendingSent: friendRequests.get(u.id)?.has(me) || false,
    pendingIncoming: incoming.has(u.id) || false
  })));
});
app.get('/api/users/by-username/:u', auth, (req, res) => {
  const u = users.find(x => x.username.toLowerCase() === req.params.u.toLowerCase());
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(u));
});
app.get('/api/users/:id', auth, (req, res) => {
  const user = getUser(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'Not found' });
  const me = req.userId;
  const friends = friendships.get(me) || new Set();
  res.json({
    ...publicUser(user),
    isFriend: friends.has(user.id),
    pendingRequest: friendRequests.get(user.id)?.has(me) || false,
    incomingRequest: friendRequests.get(me)?.has(user.id) || false,
    posts: posts.filter(p => p.userId === user.id).sort((a,b) => b.createdAt - a.createdAt).map(p => formatPost(p, me))
  });
});

// ---------- friends ----------
app.get('/api/friends', auth, (req, res) => {
  const ids = friendships.get(req.userId) || new Set();
  res.json([...ids].map(id => publicUser(getUser(id))));
});
app.get('/api/friends/requests', auth, (req, res) => {
  const ids = friendRequests.get(req.userId) || new Set();
  res.json([...ids].map(id => publicUser(getUser(id))));
});
app.post('/api/friends/request/:id', auth, (req, res) => {
  const tid = parseInt(req.params.id), me = req.userId;
  if (me === tid) return res.status(400).json({ error: 'Cannot friend yourself' });
  if (!getUser(tid)) return res.status(404).json({ error: 'Not found' });
  if ((friendships.get(me) || new Set()).has(tid)) return res.status(400).json({ error: 'Already friends' });
  if (!friendRequests.has(tid)) friendRequests.set(tid, new Set());
  friendRequests.get(tid).add(me);
  broadcast([tid], { type: 'friend_request', fromId: me });
  res.json({ ok: true });
});
app.post('/api/friends/accept/:id', auth, (req, res) => {
  const rid = parseInt(req.params.id), me = req.userId;
  const reqs = friendRequests.get(me) || new Set();
  if (!reqs.has(rid)) return res.status(400).json({ error: 'No request' });
  reqs.delete(rid);
  if (!friendships.has(me)) friendships.set(me, new Set());
  if (!friendships.has(rid)) friendships.set(rid, new Set());
  friendships.get(me).add(rid); friendships.get(rid).add(me);
  broadcast([rid], { type: 'friend_accept', byId: me });
  res.json({ ok: true });
});
app.post('/api/friends/reject/:id', auth, (req, res) => {
  (friendRequests.get(req.userId) || new Set()).delete(parseInt(req.params.id));
  res.json({ ok: true });
});

// ---------- 1:1 chat ----------
app.get('/api/chat', auth, (req, res) => {
  const me = req.userId;
  const ids = friendships.get(me) || new Set();
  const list = [...ids].map(fid => {
    const u = getUser(fid);
    const convo = messages.filter(m => (m.fromId === me && m.toId === fid) || (m.fromId === fid && m.toId === me));
    const last = convo[convo.length - 1];
    const unread = convo.filter(m => m.toId === me && !m.readAt).length;
    return { ...publicUser(u), lastMessage: last?.content || null, lastAt: last?.createdAt || null, unread };
  }).sort((a,b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json(list);
});
app.get('/api/chat/:fid', auth, (req, res) => {
  const me = req.userId, fid = parseInt(req.params.fid);
  if (!(friendships.get(me) || new Set()).has(fid)) return res.status(403).json({ error: 'Not friends' });
  const since = parseInt(req.query.since || '0', 10);
  const msgs = messages.filter(m => ((m.fromId === me && m.toId === fid) || (m.fromId === fid && m.toId === me)) && m.id > since);
  const now = Date.now();
  let marked = false;
  msgs.forEach(m => { if (m.toId === me && !m.readAt) { m.readAt = now; marked = true; } });
  if (marked) { save(); broadcast([fid], { type: 'messages_read', byId: me }); }
  res.json(msgs.map(m => ({
    id: m.id, fromId: m.fromId, toId: m.toId, content: m.content,
    createdAt: m.createdAt, mine: m.fromId === me, readAt: m.readAt, reactions: m.reactions || {}
  })));
});
app.post('/api/chat/:fid', auth, (req, res) => {
  const me = req.userId, fid = parseInt(req.params.fid);
  if (!(friendships.get(me) || new Set()).has(fid)) return res.status(403).json({ error: 'Not friends' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty' });
  const msg = { id: nextMessageId++, fromId: me, toId: fid, content: content.trim(), createdAt: Date.now(), readAt: null, reactions: {} };
  messages.push(msg);
  broadcast([fid], { type: 'message', fromId: me, messageId: msg.id });
  res.json({ id: msg.id, fromId: msg.fromId, toId: msg.toId, content: msg.content, createdAt: msg.createdAt, mine: true, readAt: null, reactions: {} });
});

// ---------- group chat ----------
app.get('/api/groups', auth, (req, res) => {
  const me = req.userId;
  const list = groups.filter(g => g.members.includes(me)).map(g => {
    const last = [...groupMessages].reverse().find(m => m.groupId === g.id);
    const unread = groupMessages.filter(m => m.groupId === g.id && m.fromId !== me && (!g.reads || !g.reads[me] || g.reads[me] < m.id)).length;
    return {
      id: g.id, name: g.name,
      members: g.members.map(id => publicUser(getUser(id))),
      lastMessage: last ? (getUser(last.fromId)?.name.split(' ')[0] + ': ' + last.content) : null,
      lastAt: last?.createdAt || g.createdAt,
      unread
    };
  }).sort((a,b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json(list);
});
app.post('/api/groups', auth, (req, res) => {
  const me = req.userId;
  const { name, memberIds } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const members = [...new Set([me, ...(memberIds || []).map(Number)])].filter(id => getUser(id));
  if (members.length < 2) return res.status(400).json({ error: 'Pick at least one friend' });
  const g = { id: nextGroupId++, name: name.trim(), members, createdBy: me, createdAt: Date.now(), reads: {} };
  groups.push(g);
  broadcast(members, { type: 'group_created', groupId: g.id });
  res.json({ id: g.id, name: g.name, members: g.members.map(id => publicUser(getUser(id))) });
});
app.get('/api/groups/:id/messages', auth, (req, res) => {
  const me = req.userId;
  const g = groups.find(x => x.id === parseInt(req.params.id));
  if (!g || !g.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
  const since = parseInt(req.query.since || '0', 10);
  const msgs = groupMessages.filter(m => m.groupId === g.id && m.id > since);
  if (!g.reads) g.reads = {};
  const latest = groupMessages.filter(m => m.groupId === g.id).reduce((mx, m) => Math.max(mx, m.id), 0);
  if (latest > (g.reads[me] || 0)) { g.reads[me] = latest; save(); }
  res.json({ group: { id: g.id, name: g.name, members: g.members.map(id => publicUser(getUser(id))) },
    messages: msgs.map(m => {
      const u = getUser(m.fromId);
      return { id: m.id, groupId: m.groupId, fromId: m.fromId,
        author: u ? { id: u.id, name: u.name, avatarColor: u.avatarColor } : { id: 0, name: '?', avatarColor: '#666' },
        content: m.content, createdAt: m.createdAt, mine: m.fromId === me, reactions: m.reactions || {} };
    })
  });
});
app.post('/api/groups/:id/messages', auth, (req, res) => {
  const me = req.userId;
  const g = groups.find(x => x.id === parseInt(req.params.id));
  if (!g || !g.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty' });
  const msg = { id: nextGroupMessageId++, groupId: g.id, fromId: me, content: content.trim(), createdAt: Date.now(), reactions: {} };
  groupMessages.push(msg);
  broadcast(g.members.filter(id => id !== me), { type: 'group_message', groupId: g.id, fromId: me, messageId: msg.id });
  const u = getUser(me);
  res.json({ id: msg.id, groupId: msg.groupId, fromId: me,
    author: { id: u.id, name: u.name, avatarColor: u.avatarColor },
    content: msg.content, createdAt: msg.createdAt, mine: true, reactions: {} });
});
app.post('/api/groups/:id/add', auth, (req, res) => {
  const me = req.userId;
  const g = groups.find(x => x.id === parseInt(req.params.id));
  if (!g || !g.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
  const newMembers = (req.body.memberIds || []).map(Number).filter(id => getUser(id) && !g.members.includes(id));
  g.members.push(...newMembers);
  broadcast(newMembers, { type: 'group_created', groupId: g.id });
  res.json({ ok: true, members: g.members.map(id => publicUser(getUser(id))) });
});
app.post('/api/groups/:id/leave', auth, (req, res) => {
  const me = req.userId;
  const g = groups.find(x => x.id === parseInt(req.params.id));
  if (!g) return res.status(404).json({ error: 'Not found' });
  g.members = g.members.filter(id => id !== me);
  if (!g.members.length) groups = groups.filter(x => x.id !== g.id);
  res.json({ ok: true });
});

// ---------- reactions ----------
app.post('/api/messages/:id/react', auth, (req, res) => {
  const me = req.userId;
  const id = parseInt(req.params.id);
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  let target = messages.find(m => m.id === id);
  let isGroup = false;
  if (!target) { target = groupMessages.find(m => m.id === id); isGroup = true; }
  if (!target) return res.status(404).json({ error: 'Message not found' });
  if (!target.reactions) target.reactions = {};
  if (!target.reactions[emoji]) target.reactions[emoji] = [];
  const arr = target.reactions[emoji];
  const i = arr.indexOf(me);
  if (i === -1) arr.push(me); else arr.splice(i, 1);
  if (!arr.length) delete target.reactions[emoji];

  if (isGroup) {
    const g = groups.find(x => x.id === target.groupId);
    if (g) broadcast(g.members.filter(uid => uid !== me), { type: 'reaction', messageId: id, groupId: g.id });
  } else {
    const other = target.fromId === me ? target.toId : target.fromId;
    broadcast([other], { type: 'reaction', messageId: id });
  }
  res.json({ reactions: target.reactions });
});

// ---------- stories ----------
function cleanStories() {
  const now = Date.now();
  const before = stories.length;
  stories = stories.filter(s => s.expiresAt > now);
  return before !== stories.length;
}
app.get('/api/stories', auth, (req, res) => {
  cleanStories();
  const me = req.userId;
  const friends = friendships.get(me) || new Set();
  const visible = new Set([me, ...friends]);
  const byUser = new Map();
  for (const s of stories) {
    if (!visible.has(s.userId)) continue;
    if (!byUser.has(s.userId)) byUser.set(s.userId, { user: publicUser(getUser(s.userId)), items: [], hasUnseen: false });
    const entry = byUser.get(s.userId);
    entry.items.push({ id: s.id, imageData: s.imageData, caption: s.caption, createdAt: s.createdAt, expiresAt: s.expiresAt, viewers: s.viewers || [] });
    if (!(s.viewers || []).includes(me) && s.userId !== me) entry.hasUnseen = true;
  }
  const arr = [...byUser.values()].map(v => ({ ...v, items: v.items.sort((a,b) => a.createdAt - b.createdAt) }));
  arr.sort((a, b) => {
    if (a.user.id === me) return -1;
    if (b.user.id === me) return 1;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    const la = a.items[a.items.length-1].createdAt;
    const lb = b.items[b.items.length-1].createdAt;
    return lb - la;
  });
  res.json(arr);
});
app.post('/api/stories', auth, (req, res) => {
  const { imageData, caption } = req.body;
  if (!imageData || !imageData.startsWith('data:image/')) return res.status(400).json({ error: 'Image required' });
  if (imageData.length > 500000) return res.status(400).json({ error: 'Image too large (max ~375KB)' });
  const s = {
    id: nextStoryId++, userId: req.userId,
    imageData, caption: (caption || '').trim(),
    createdAt: Date.now(), expiresAt: Date.now() + STORY_TTL, viewers: []
  };
  stories.push(s);
  const friends = friendships.get(req.userId) || new Set();
  broadcast([...friends], { type: 'new_story', userId: req.userId, storyId: s.id });
  res.json({ id: s.id });
});
app.post('/api/stories/:id/view', auth, (req, res) => {
  const s = stories.find(x => x.id === parseInt(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!s.viewers) s.viewers = [];
  if (!s.viewers.includes(req.userId)) s.viewers.push(req.userId);
  res.json({ ok: true, viewers: s.viewers.length });
});
app.delete('/api/stories/:id', auth, (req, res) => {
  const i = stories.findIndex(x => x.id === parseInt(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  if (stories[i].userId !== req.userId) return res.status(403).json({ error: 'Not yours' });
  stories.splice(i, 1);
  res.json({ ok: true });
});

// ============================================================
// ---------- ADMIN API (feeds admin.html) ----------
// ============================================================
app.get('/api/admin/data', (req, res) => {
  const pw = req.query.pw || '';
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const data = {
    counts: {
      users: users.length,
      posts: posts.length,
      directMessages: messages.length,
      groups: groups.length,
      groupMessages: groupMessages.length,
      stories: stories.length,
      friendships: Math.floor([...friendships.values()].reduce((s, v) => s + v.size, 0) / 2),
      pendingRequests: [...friendRequests.values()].reduce((s, v) => s + v.size, 0)
    },
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      name: u.name,
      bio: u.bio || '',
      avatarColor: u.avatarColor,
      passwordHashPreview: (u.password || '').slice(0, 24) + '...',
      lastActiveAt: u.lastActiveAt || null,
      friendCount: (friendships.get(u.id) || new Set()).size,
      postCount: posts.filter(p => p.userId === u.id).length,
      messagesSent: messages.filter(m => m.fromId === u.id).length
    })),
    posts: posts.map(p => {
      const u = getUser(p.userId);
      return {
        id: p.id,
        author: u ? u.username : '?',
        authorName: u ? u.name : '?',
        content: p.content || '',
        hasImage: !!p.imageUrl,
        likes: p.likes.length,
        comments: p.comments.length,
        createdAt: p.createdAt
      };
    }).sort((a, b) => b.createdAt - a.createdAt),
    messages: messages.map(m => {
      const from = getUser(m.fromId), to = getUser(m.toId);
      return {
        id: m.id,
        from: from ? from.username : '?',
        to: to ? to.username : '?',
        content: m.content,
        createdAt: m.createdAt,
        read: !!m.readAt
      };
    }).sort((a, b) => b.createdAt - a.createdAt),
    groups: groups.map(g => ({
      id: g.id,
      name: g.name,
      memberCount: g.members.length,
      messageCount: groupMessages.filter(m => m.groupId === g.id).length,
      createdAt: g.createdAt
    })),
    exportedAt: Date.now()
  };
  res.json(data);
});

// Download raw data.json
app.get('/admin/export', (req, res) => {
  if ((req.query.pw || '') !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  const data = {
    users, posts, messages, groups, groupMessages, stories,
    friendships: [...friendships].map(([k, v]) => [k, [...v]]),
    friendRequests: [...friendRequests].map(([k, v]) => [k, [...v]]),
    nextUserId, nextPostId, nextCommentId, nextMessageId,
    nextGroupId, nextGroupMessageId, nextStoryId
  };
  res.setHeader('Content-Disposition', 'attachment; filename="data-backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

// Serve admin.html on /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- serve frontend ----------
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- startup ----------
if (!load()) seed();
console.log(`[admin] Password is set to: "${ADMIN_PASSWORD}"`);
console.log(`[admin] Open http://localhost:${PORT}/admin`);
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));