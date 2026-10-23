const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { PORT = 3000, BASE_URL = 'http://localhost:3000', WALLET, NOTIFY_SECRET, ADMIN_KEY, PRICE_PER_CELL = '50' } = process.env;
if (!WALLET || !NOTIFY_SECRET) { console.error('Задайте WALLET и NOTIFY_SECRET'); process.exit(1); }

const COLS = 50, ROWS = 50, CELL = 20, PRICE = Number(PRICE_PER_CELL), HOLD = 15 * 60e3;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), IMG = path.join(DATA, 'img'), DB = path.join(DATA, 'db.json');
fs.mkdirSync(IMG, { recursive: true });
let orders = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : [];
const save = () => fs.writeFileSync(DB, JSON.stringify(orders));
const active = o => o.status === 'paid' || (o.status === 'pending' && Date.now() - o.created < HOLD);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const taken = r => orders.some(o => active(o) && overlap(o, r));
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

const app = express();
app.use(express.json({ limit: '700kb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/state', (req, res) => {
  res.json({
    cols: COLS, rows: ROWS, cell: CELL, price: PRICE,
    blocks: orders.filter(active).map(o => ({
      id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, status: o.status,
      link: o.status === 'paid' ? o.link : undefined
    }))
  });
});

app.get('/api/order/:id', (req, res) => {
  const o = orders.find(o => o.id === req.params.id);
  res.json({ status: o ? o.status : 'none' });
});

app.get('/img/:id.jpg', (req, res) => {
  const o = orders.find(o => o.id === req.params.id && o.status === 'paid');
  if (!o) return res.sendStatus(404);
  res.sendFile(path.join(IMG, o.id + '.jpg'));
});

app.post('/api/order', (req, res) => {
  const { x, y, w, h, link, image } = req.body || {};
  const ints = [x, y, w, h].every(Number.isInteger);
  if (!ints || x < 0 || y < 0 || w < 1 || h < 1 || x + w > COLS || y + h > ROWS)
    return res.status(400).json({ error: 'Неверная область' });
  if (typeof link !== 'string' || link.length > 300 || !/^https?:\/\/[^\s]+$/.test(link))
    return res.status(400).json({ error: 'Ссылка должна начинаться с http:// или https://' });
  const m = typeof image === 'string' && image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length > 500e3 || buf[0] !== 0xff || buf[1] !== 0xd8)
    return res.status(400).json({ error: 'Нужна картинка JPEG до 500 КБ' });
  const rect = { x, y, w, h };
  if (taken(rect)) return res.status(409).json({ error: 'Эти квадраты уже заняты' });

  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(IMG, id + '.jpg'), buf);
  orders.push({ id, ...rect, link, status: 'pending', created: Date.now(), price: w * h * PRICE });
  save();
  res.json({ id, receiver: WALLET, sum: (w * h * PRICE).toFixed(2), successURL: `${BASE_URL}/?paid=${id}` });
});

// Уведомления ЮMoney (HTTP-уведомления кошелька)
app.post('/api/yoomoney', (req, res) => {
  const b = req.body;
  const str = [b.notification_type, b.operation_id, b.amount, b.currency, b.datetime,
    b.sender, b.codepro, NOTIFY_SECRET, b.label].join('&');
  if (sha1(str) !== b.sha1_hash) return res.sendStatus(400);
  res.sendStatus(200);

  const o = orders.find(o => o.id === b.label);
  if (!o || o.status === 'paid' || String(b.codepro) === 'true') return;
  // amount — сумма за вычетом комиссии, поэтому допускаем до 5% разницы
  if (Number(b.amount) < o.price * 0.95) return;
  const clash = orders.some(p => p.id !== o.id && active(p) && overlap(p, o));
  o.status = clash ? 'conflict' : 'paid'; // conflict = оплатили после истечения брони, нужен возврат
  o.operation_id = b.operation_id;
  save();
});

// Модерация: /api/admin/hide?id=...&key=ADMIN_KEY
app.get('/api/admin/hide', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  const o = orders.find(o => o.id === req.query.id);
  if (!o) return res.sendStatus(404);
  o.status = 'hidden'; save(); res.send('ok');
});

app.listen(PORT, () => console.log('Запущено на порту ' + PORT));
