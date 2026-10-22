const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpCounter = new client.Counter({
  name: 'contract_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
register.registerMetric(httpCounter);
app.use((req, res, next) => {
  res.on('finish', () => httpCounter.inc({
    method: req.method,
    route: req.route?.path || req.path,
    status: String(res.statusCode),
  }));
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contracts (
      id SERIAL PRIMARY KEY,
      contract_code VARCHAR(40) NOT NULL UNIQUE,
      title VARCHAR(200) NOT NULL,
      related_party VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Nháp',
      contract_value NUMERIC(14,2) DEFAULT 0,
      start_date DATE,
      end_date DATE,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const money = (v) => Number(v || 0).toLocaleString('vi-VN') + ' ₫';

function page(content) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Quản lý hợp đồng</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#1f2937;font:15px Arial,sans-serif;line-height:1.5}
  header{background:#142d4e;color:white;padding:24px max(20px,calc((100% - 1100px)/2));border-bottom:4px solid #1769d2;box-shadow:0 3px 12px #10204018}
  header h1{margin:0 0 6px;font-size:26px;line-height:1.25}header p{margin:0;color:#d7e6fa;font-size:14px}
  main{max-width:1140px;margin:28px auto;padding:0 20px}.card{background:white;padding:24px;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 5px 18px #1020400d;margin-bottom:20px}
  h2{margin:0 0 18px;padding-left:11px;border-left:3px solid #1769d2;font-size:20px;line-height:1.35;color:#142d4e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  label{display:block;font-weight:bold;font-size:13px;color:#34475a;margin-bottom:6px}input,select,textarea{width:100%;min-height:44px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#1f2937;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}
  input::placeholder,textarea::placeholder{color:#8391a0}input:hover,select:hover,textarea:hover{border-color:#94a3b8}input:focus,select:focus,textarea:focus{outline:none;border-color:#1769d2;box-shadow:0 0 0 3px #1769d226}
  textarea{min-height:88px;resize:vertical}button{min-height:42px;background:#1769d2;color:white;border:0;border-radius:6px;padding:10px 17px;cursor:pointer;font:inherit;font-weight:bold;transition:background .15s ease,box-shadow .15s ease,transform .15s ease}
  button:hover{background:#1258b5;box-shadow:0 3px 9px #1769d233;transform:translateY(-1px)}button:active{transform:translateY(0)}button:focus-visible,a:focus-visible{outline:3px solid #1769d266;outline-offset:2px}
  .table-wrap{overflow-x:auto;border:1px solid #e2e8f0;border-radius:7px}table{width:100%;border-collapse:separate;border-spacing:0;min-width:780px}th,td{text-align:left;border-bottom:1px solid #e8edf2;padding:12px 10px}th{background:#f4f7fa;color:#34475a;font-size:12px;font-weight:bold;white-space:nowrap}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#f8fbff}
  .pill{display:inline-block;padding:4px 9px;border:1px solid #cfe0f7;border-radius:999px;background:#eaf2ff;color:#164b8a;font-size:12px;font-weight:bold;white-space:nowrap}
  .top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.top h2{margin:0}.top form{display:flex;align-items:center;gap:8px}.muted{color:#64748b;font-size:13px}.alert{background:#dcfce7;color:#166534;padding:11px 13px;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:14px}
  .danger{color:#b91c1c}.smallbtn{min-height:34px;padding:6px 11px;font-size:12px}a{color:#1769d2}
  @media(max-width:650px){header{padding:20px}header h1{font-size:22px}main{margin:18px auto;padding:0 12px}.grid{grid-template-columns:1fr;gap:13px}.card{padding:17px;margin-bottom:14px}.top form{width:100%}.top form input{min-width:0;flex:1}.top form button{flex:none}}
  </style></head><body><header><h1>Hệ thống Quản lý Hợp đồng</h1>
  <p>Tạo mới · Theo dõi trạng thái · Quản lý các bên liên quan</p></header><main>${content}
  <p class="muted">Bài tập môn Triển khai và Quản trị Hệ thống Phần mềm · Node.js + PostgreSQL + Docker</p></main></body></html>`;
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch (e) { res.status(503).json({ status: 'error', database: 'unavailable' }); }
});
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
app.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const result = await pool.query(
      `SELECT * FROM contracts WHERE ($1 = '' OR contract_code ILIKE $2 OR title ILIKE $2 OR related_party ILIKE $2) ORDER BY created_at DESC`,
      [q, `%${q}%`]);
    const rows = result.rows.map(c => `<tr><td>${esc(c.contract_code)}</td><td><strong>${esc(c.title)}</strong><br><span class="muted">${esc(c.related_party)}</span></td><td><span class="pill">${esc(c.status)}</span></td><td>${money(c.contract_value)}</td><td>${esc(c.start_date || '—')}</td><td>${esc(c.end_date || '—')}</td><td><form method="post" action="/contracts/${c.id}/status"><select name="status" aria-label="Đổi trạng thái"><option ${c.status==='Nháp'?'selected':''}>Nháp</option><option ${c.status==='Đang hiệu lực'?'selected':''}>Đang hiệu lực</option><option ${c.status==='Hết hạn'?'selected':''}>Hết hạn</option><option ${c.status==='Đã hủy'?'selected':''}>Đã hủy</option></select><button class="smallbtn" style="margin-top:5px">Lưu</button></form></td></tr>`).join('');
    const flash = req.query.created ? '<div class="alert">Đã tạo hợp đồng thành công.</div>' : '';
    res.send(page(`${flash}<section class="card"><h2>Thêm hợp đồng mới</h2>
      <form method="post" action="/contracts"><div class="grid">
      <div><label>Mã hợp đồng *</label><input name="contract_code" required maxlength="40" placeholder="HD-2026-001"></div>
      <div><label>Tên hợp đồng *</label><input name="title" required maxlength="200" placeholder="Hợp đồng cung cấp dịch vụ"></div>
      <div><label>Bên liên quan *</label><input name="related_party" required maxlength="200" placeholder="Tên công ty / cá nhân"></div>
      <div><label>Giá trị (VNĐ)</label><input name="contract_value" type="number" min="0" step="0.01" value="0"></div>
      <div><label>Ngày bắt đầu</label><input name="start_date" type="date"></div><div><label>Ngày kết thúc</label><input name="end_date" type="date"></div>
      <div><label>Trạng thái</label><select name="status"><option>Nháp</option><option>Đang hiệu lực</option><option>Hết hạn</option><option>Đã hủy</option></select></div>
      <div><label>Ghi chú</label><textarea name="notes" placeholder="Thông tin bổ sung"></textarea></div></div><p><button type="submit">+ Tạo hợp đồng</button></p></form></section>
      <section class="card"><div class="top"><h2>Danh sách hợp đồng (${result.rowCount})</h2><form method="get"><input name="q" value="${esc(q)}" placeholder="Tìm mã, tên hoặc bên liên quan" style="width:260px;max-width:65vw;display:inline-block"><button>Tìm</button></form></div>
      <div class="table-wrap"><table><thead><tr><th>Mã</th><th>Hợp đồng / Bên liên quan</th><th>Trạng thái</th><th>Giá trị</th><th>Bắt đầu</th><th>Kết thúc</th><th>Cập nhật trạng thái</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Chưa có hợp đồng. Hãy tạo hợp đồng đầu tiên ở biểu mẫu phía trên.</td></tr>'}</tbody></table></div></section>`));
  } catch (e) {
    console.error('Load contracts failed:', e.message);
    res.status(500).send(page('<section class="card"><h2>Lỗi tải dữ liệu</h2><p>Không thể đọc dữ liệu hợp đồng. Kiểm tra kết nối PostgreSQL bằng <code>docker compose logs web db</code>.</p></section>'));
  }
});
app.post('/contracts', async (req, res) => {
  const { contract_code, title, related_party, status, contract_value, start_date, end_date, notes } = req.body;
  if (!contract_code?.trim() || !title?.trim() || !related_party?.trim()) return res.status(400).send('Thiếu trường bắt buộc.');
  const valid = ['Nháp', 'Đang hiệu lực', 'Hết hạn', 'Đã hủy'];
  if (!valid.includes(status)) return res.status(400).send('Trạng thái không hợp lệ.');
  try {
    await pool.query(`INSERT INTO contracts(contract_code,title,related_party,status,contract_value,start_date,end_date,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [contract_code.trim(), title.trim(), related_party.trim(), status, Math.max(0, Number(contract_value || 0)), start_date || null, end_date || null, notes || '']);
    res.redirect('/?created=1');
  } catch (e) {
    console.error('Create contract failed:', e.message);
    if (e.code === '23505') return res.status(409).send(page('<section class="card"><h2>Mã hợp đồng đã tồn tại</h2><a href="/">Quay lại</a></section>'));
    res.status(500).send('Không thể tạo hợp đồng. Kiểm tra dữ liệu và log ứng dụng.');
  }
});
app.post('/contracts/:id/status', async (req, res) => {
  const valid = ['Nháp', 'Đang hiệu lực', 'Hết hạn', 'Đã hủy'];
  if (!valid.includes(req.body.status)) return res.status(400).send('Trạng thái không hợp lệ.');
  try {
    await pool.query('UPDATE contracts SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
    res.redirect('/');
  } catch (e) { console.error('Update status failed:', e.message); res.status(500).send('Không thể cập nhật trạng thái.'); }
});
initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`Contract app listening on ${port}`)))
  .catch(e => { console.error('Database initialization failed:', e); process.exit(1); });
