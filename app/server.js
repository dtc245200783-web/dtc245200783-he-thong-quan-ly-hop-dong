const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { randomBytes } = require('crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const maxContractValue = 999999999999.99;
const contractStatuses = ['Nháp', 'Chờ phê duyệt', 'Đang hiệu lực', 'Hết hạn', 'Đã hủy'];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sessionSecret = process.env.SESSION_SECRET || randomBytes(48).toString('hex');
const register = new client.Registry();
app.disable('x-powered-by');
app.set('trust proxy', 1);
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
app.use(session({
  store: new PgSession({ pool, tableName: 'app_sessions', createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use((req, res, next) => {
  if (['/login', '/setup', '/health', '/metrics'].includes(req.path) || req.session.userId) return next();
  res.redirect('/login');
});

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE contracts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await pool.query('ALTER TABLE contracts ALTER COLUMN related_party DROP NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counterparties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL UNIQUE,
      email VARCHAR(254) NOT NULL DEFAULT '',
      phone VARCHAR(40) NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contract_parties (
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      counterparty_id INTEGER NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
      PRIMARY KEY (contract_id, counterparty_id)
    )
  `);
  await pool.query(`
    INSERT INTO counterparties(name)
    SELECT DISTINCT BTRIM(related_party) FROM contracts
    WHERE NULLIF(BTRIM(related_party), '') IS NOT NULL
    ON CONFLICT (name) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO contract_parties(contract_id, counterparty_id)
    SELECT c.id, p.id FROM contracts c
    JOIN counterparties p ON p.name = BTRIM(c.related_party)
    WHERE NULLIF(BTRIM(c.related_party), '') IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS contracts_end_date_idx ON contracts(end_date)');
  await pool.query('CREATE INDEX IF NOT EXISTS contracts_status_idx ON contracts(status)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE app_users ALTER COLUMN username TYPE VARCHAR(255)');
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const money = (v) => Number(v || 0).toLocaleString('vi-VN') + ' ₫';

function page(content, username = '') {
  const accountControl = username
    ? `<div class="header-account"><span>${esc(username)}</span><form method="post" action="/logout"><button type="submit">Đăng xuất</button></form></div>`
    : '';
  const appNav = username
    ? '<nav class="main-nav"><a href="/">Tổng quan</a><a href="/contracts">Hợp đồng</a><a href="/counterparties">Bên liên quan</a><a href="/reports">Báo cáo</a></nav>'
    : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Quản lý hợp đồng</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#1f2937;font:15px Arial,sans-serif;line-height:1.5}
  header{background:#142d4e;color:white;padding:24px max(20px,calc((100% - 1100px)/2));border-bottom:4px solid #1769d2;box-shadow:0 3px 12px #10204018}
  .header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.header-account{display:flex;align-items:center;gap:12px}.header-account span{color:#d7e6fa;font-size:13px}.header-account form{margin:0}.header-account button{min-height:36px;padding:6px 11px;border:1px solid #8fa9c2;background:transparent;font-size:13px}.header-account button:hover{background:#ffffff18}
  .main-nav{display:flex;gap:5px;margin-top:18px;overflow-x:auto}.main-nav a{padding:8px 12px;border-radius:5px;color:#e5eff8;text-decoration:none;font-size:13px;font-weight:bold;white-space:nowrap}.main-nav a:hover,.main-nav a[aria-current="page"]{background:#ffffff1c;color:white}
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
  .auth-card{max-width:480px;margin:34px auto}.auth-card h2{margin-bottom:10px}.auth-card .auth-intro{margin:0 0 18px;color:#64748b}.auth-card .auth-field{margin:14px 0}.auth-card .auth-submit{width:100%;margin-top:8px}.auth-error{margin:12px 0;padding:10px 12px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#991b1b}
  .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.page-head h2{margin:0}.page-head p{margin:6px 0 0;color:#64748b}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.button-link{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 13px;border-radius:6px;background:#1769d2;color:#fff;text-decoration:none;font-weight:bold}.button-link:hover{background:#1258b5;color:#fff}.button-secondary{background:#fff;color:#1769d2;border:1px solid #b8cbe0}.button-secondary:hover{background:#f2f7fd;color:#1258b5}.button-danger{background:#b42318}.button-danger:hover{background:#912018}
  .stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.stat-card{padding:17px 18px;border-top:3px solid #1769d2}.stat-label{color:#64748b;font-size:13px}.stat-value{margin-top:6px;color:#142d4e;font-size:27px;font-weight:bold}.stat-note{margin-top:4px;color:#64748b;font-size:12px}.status-active{background:#e7f7ee;border-color:#bde7cc;color:#17643b}.status-expired{background:#fff1f0;border-color:#ffd2cc;color:#a1281b}.status-draft{background:#edf3fb;border-color:#cbd9eb;color:#385475}.status-pending{background:#fff7e8;border-color:#f6dfb0;color:#80550e}.status-cancelled{background:#f1f2f4;border-color:#d7dbe0;color:#59616a}
  .filter-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;align-items:end;gap:10px}.filter-grid label{font-size:12px}.filter-grid button{white-space:nowrap}.field-hint{display:block;margin-top:4px;color:#64748b;font-size:12px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.detail-item{padding:12px;border-bottom:1px solid #e8edf2}.detail-label{display:block;color:#64748b;font-size:12px}.detail-value{display:block;margin-top:4px;font-weight:600;overflow-wrap:anywhere}.notice-warning{padding:12px 14px;border:1px solid #f2d28c;border-radius:6px;background:#fff8e8;color:#704d0b}.notice-danger{padding:12px 14px;border:1px solid #f2c4bf;border-radius:6px;background:#fff2f0;color:#8c251b}.empty-state{padding:28px 12px;text-align:center;color:#64748b}.table-actions{display:flex;align-items:center;gap:7px;white-space:nowrap}.inline-form{display:inline;margin:0}.monthly-chart{display:grid;gap:8px}.month-row{display:grid;grid-template-columns:46px minmax(70px,1fr) 120px;align-items:center;gap:10px}.month-track{height:12px;overflow:hidden;border-radius:8px;background:#e8eef5}.month-bar{height:100%;border-radius:8px;background:#1769d2}.month-amount{text-align:right;color:#526273;font-size:12px}
  .danger{color:#b91c1c}.smallbtn{min-height:34px;padding:6px 11px;font-size:12px}a{color:#1769d2}
  @media(max-width:850px){.filter-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.stats-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:650px){header{padding:20px}.header-row{align-items:flex-start;flex-direction:column}header h1{font-size:22px}main{margin:18px auto;padding:0 12px}.main-nav{margin-top:13px}.grid,.detail-grid{grid-template-columns:1fr;gap:13px}.card{padding:17px;margin-bottom:14px}.top form{width:100%}.top form input{min-width:0;flex:1}.top form button{flex:none}.filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-grid > :first-child{grid-column:1/-1}.page-head{align-items:stretch;flex-direction:column}.page-head .actions{width:100%}.stats-grid{gap:9px}.stat-card{padding:13px}.stat-value{font-size:23px}.month-row{grid-template-columns:36px minmax(40px,1fr) 92px;gap:7px}}
  </style></head><body><header><div class="header-row"><div><h1>Hệ thống Quản lý Hợp đồng</h1>
  <p>Tạo mới · Theo dõi trạng thái · Quản lý các bên liên quan</p></div>${accountControl}</div>${appNav}</header><main>${content}
  <p class="muted">Bài tập môn Triển khai và Quản trị Hệ thống Phần mềm · Node.js + PostgreSQL + Docker</p></main></body></html>`;
}

async function hasUsers() {
  const result = await pool.query('SELECT 1 FROM app_users LIMIT 1');
  return result.rowCount > 0;
}

function setupPage(error = '') {
  const message = error ? `<div class="auth-error">${esc(error)}</div>` : '';
  return page(`<section class="card auth-card"><h2>Tạo tài khoản quản trị</h2>
    <p class="auth-intro">Đây là lần thiết lập đầu tiên. Tài khoản này sẽ được dùng để đăng nhập quản lý hợp đồng.</p>${message}
    <form method="post" action="/setup">
      <div class="auth-field"><label for="setup-username">Tên đăng nhập</label><input id="setup-username" name="username" required maxlength="255" autocomplete="username"></div>
      <div class="auth-field"><label for="setup-password">Mật khẩu</label><input id="setup-password" name="password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"></div>
      <div class="auth-field"><label for="setup-confirm">Nhập lại mật khẩu</label><input id="setup-confirm" name="confirm_password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"></div>
      <button class="auth-submit" type="submit">Tạo tài khoản</button>
    </form></section>`);
}

function loginPage(error = '') {
  const message = error ? '<div class="auth-error">Tên đăng nhập hoặc mật khẩu không đúng.</div>' : '';
  return page(`<section class="card auth-card"><h2>Đăng nhập</h2>
    <p class="auth-intro">Đăng nhập để tiếp tục quản lý hợp đồng.</p>${message}
    <form method="post" action="/login">
      <div class="auth-field"><label for="login-username">Tên đăng nhập</label><input id="login-username" name="username" required autocomplete="username"></div>
      <div class="auth-field"><label for="login-password">Mật khẩu</label><input id="login-password" name="password" type="password" required autocomplete="current-password"></div>
      <button class="auth-submit" type="submit">Đăng nhập</button>
    </form></section>`);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => error ? reject(error) : resolve());
  });
}

function currentContractStatus(contract) {
  const today = new Date().toISOString().slice(0, 10);
  if (contract.status === 'Đang hiệu lực' && contract.end_date && contract.end_date < today) return 'Hết hạn';
  return contract.status;
}

function statusBadge(status) {
  const statusClass = {
    'Đang hiệu lực': 'status-active',
    'Hết hạn': 'status-expired',
    'Nháp': 'status-draft',
    'Chờ phê duyệt': 'status-pending',
    'Đã hủy': 'status-cancelled',
  }[status] || 'status-draft';
  return `<span class="pill ${statusClass}">${esc(status)}</span>`;
}

function pageHead(title, description, actions = '') {
  return `<div class="page-head"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="empty-state">${esc(text)}</td></tr>`;
}

function contractRows(contracts) {
  if (!contracts.length) return emptyRow(7, 'Chưa có hợp đồng phù hợp.');
  return contracts.map(contract => `<tr>
    <td><a href="/contracts/${contract.id}"><strong>${esc(contract.contract_code)}</strong></a></td>
    <td><strong>${esc(contract.title)}</strong><br><span class="muted">${esc(contract.related_parties || 'Chưa gắn bên liên quan')}</span></td>
    <td>${statusBadge(currentContractStatus(contract))}</td>
    <td>${money(contract.contract_value)}</td><td>${esc(contract.start_date || '—')}</td><td>${esc(contract.end_date || '—')}</td>
    <td><div class="table-actions"><a class="button-link button-secondary" href="/contracts/${contract.id}">Chi tiết</a><a class="button-link button-secondary" href="/contracts/${contract.id}/edit">Sửa</a>
      <form class="inline-form" method="post" action="/contracts/${contract.id}/delete" onsubmit="return confirm('Xóa hợp đồng này?')"><button class="button-danger" type="submit">Xóa</button></form>
    </div></td>
  </tr>`).join('');
}

function contractTable(contracts) {
  return `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Hợp đồng / Bên liên quan</th><th>Trạng thái</th><th>Giá trị</th><th>Bắt đầu</th><th>Kết thúc</th><th>Thao tác</th></tr></thead><tbody>${contractRows(contracts)}</tbody></table></div>`;
}

async function getContract(id) {
  const result = await pool.query(`
    SELECT c.*, COALESCE(
      json_agg(json_build_object('id', p.id, 'name', p.name, 'email', p.email, 'phone', p.phone, 'address', p.address))
        FILTER (WHERE p.id IS NOT NULL), '[]'
    ) AS parties,
    COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS related_parties
    FROM contracts c
    LEFT JOIN contract_parties cp ON cp.contract_id = c.id
    LEFT JOIN counterparties p ON p.id = cp.counterparty_id
    WHERE c.id = $1 GROUP BY c.id
  `, [id]);
  return result.rows[0];
}

async function getCounterparties() {
  const result = await pool.query('SELECT id, name, email, phone, address FROM counterparties ORDER BY name');
  return result.rows;
}

function renderContractForm(contract = {}, parties = [], error = '') {
  const selected = new Set((contract.parties || []).map(party => Number(party.id)));
  const options = parties.map(party => `<option value="${party.id}" ${selected.has(Number(party.id)) ? 'selected' : ''}>${esc(party.name)}${party.email ? ` · ${esc(party.email)}` : ''}</option>`).join('');
  const message = error ? `<div class="auth-error">${esc(error)}</div>` : '';
  const selectedStatus = currentContractStatus({ status: contract.status || 'Nháp', end_date: contract.end_date });
  const statuses = contractStatuses.map(status => `<option ${selectedStatus === status ? 'selected' : ''}>${esc(status)}</option>`).join('');
  return `<section class="card">${pageHead(contract.id ? 'Chỉnh sửa hợp đồng' : 'Thêm hợp đồng mới', 'Thông tin hợp đồng và các bên tham gia.')}${message}
    ${parties.length ? '' : '<div class="notice-warning">Hãy tạo bên liên quan trước khi lập hợp đồng.</div>'}
    <form method="post" action="${contract.id ? `/contracts/${contract.id}` : '/contracts'}">
      <div class="grid">
        <div><label for="contract-code">Mã hợp đồng *</label><input id="contract-code" name="contract_code" required maxlength="40" value="${esc(contract.contract_code)}" placeholder="HD-2026-001"></div>
        <div><label for="contract-title">Tên hợp đồng *</label><input id="contract-title" name="title" required maxlength="200" value="${esc(contract.title)}" placeholder="Hợp đồng cung cấp dịch vụ"></div>
        <div><label for="party-ids">Bên liên quan *</label><select id="party-ids" name="party_ids" multiple required size="${Math.max(2, Math.min(5, parties.length))}">${options}</select><span class="field-hint">Chọn nhiều bên bằng Ctrl hoặc Cmd.</span></div>
        <div><label for="contract-value">Giá trị (VNĐ)</label><input id="contract-value" name="contract_value" type="number" min="0" max="999999999999.99" step="0.01" value="${esc(contract.contract_value ?? '0')}"></div>
        <div><label for="start-date">Ngày bắt đầu</label><input id="start-date" name="start_date" type="date" value="${esc(contract.start_date || '')}"></div>
        <div><label for="end-date">Ngày kết thúc</label><input id="end-date" name="end_date" type="date" value="${esc(contract.end_date || '')}"></div>
        <div><label for="contract-status">Trạng thái</label><select id="contract-status" name="status">${statuses}</select></div>
        <div><label for="contract-notes">Ghi chú</label><textarea id="contract-notes" name="notes" maxlength="10000" placeholder="Thông tin bổ sung">${esc(contract.notes || '')}</textarea></div>
      </div>
      <div class="actions" style="margin-top:18px"><button type="submit" ${parties.length ? '' : 'disabled'}>${contract.id ? 'Lưu thay đổi' : 'Tạo hợp đồng'}</button><a class="button-link button-secondary" href="/contracts">Hủy</a></div>
    </form></section>`;
}

function contractFilterQuery(query) {
  const values = [];
  const conditions = [];
  const addValue = value => { values.push(value); return `$${values.length}`; };
  const q = String(query.q || '').trim();
  const status = String(query.status || '').trim();
  const counterpartyId = Number(query.counterparty || 0);
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  if (q) {
    const param = addValue(`%${q}%`);
    conditions.push(`(c.contract_code ILIKE ${param} OR c.title ILIKE ${param} OR p.name ILIKE ${param})`);
  }
  if (contractStatuses.includes(status)) {
    if (status === 'Hết hạn') conditions.push(`(c.status = 'Hết hạn' OR (c.status = 'Đang hiệu lực' AND c.end_date < CURRENT_DATE))`);
    else if (status === 'Đang hiệu lực') conditions.push(`(c.status = 'Đang hiệu lực' AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE))`);
    else conditions.push(`c.status = ${addValue(status)}`);
  }
  if (Number.isInteger(counterpartyId) && counterpartyId > 0) conditions.push(`p.id = ${addValue(counterpartyId)}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) conditions.push(`COALESCE(c.end_date, c.start_date, c.created_at::date) >= ${addValue(from)}::date`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) conditions.push(`COALESCE(c.start_date, c.created_at::date) <= ${addValue(to)}::date`);
  return { values, where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '' };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

app.get('/setup', async (_req, res) => {
  try {
    if (await hasUsers()) return res.redirect('/login');
    res.send(setupPage());
  } catch (error) {
    console.error('Load setup page failed:', error.message);
    res.status(500).send('Không thể tải trang thiết lập tài khoản.');
  }
});

app.post('/setup', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  if (!username || Array.from(username).length > 255) return res.status(400).send(setupPage('Tên đăng nhập là bắt buộc và tối đa 255 ký tự.'));
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).send(setupPage('Mật khẩu phải dài từ 12 đến 72 byte.'));
  if (password !== confirmPassword) return res.status(400).send(setupPage('Hai mật khẩu không khớp.'));

  const passwordHash = await bcrypt.hash(password, 12);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
    if ((await db.query('SELECT 1 FROM app_users LIMIT 1')).rowCount) {
      await db.query('ROLLBACK');
      return res.redirect(303, '/login');
    }
    const result = await db.query('INSERT INTO app_users(username, password_hash) VALUES($1, $2) RETURNING id', [username, passwordHash]);
    await db.query('COMMIT');
    await regenerateSession(req);
    req.session.userId = result.rows[0].id;
    req.session.username = username;
    await saveSession(req);
    res.redirect(303, '/');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('Create account failed:', error.message);
    res.status(500).send(setupPage('Không thể tạo tài khoản. Vui lòng thử lại.'));
  } finally {
    db.release();
  }
});

app.get('/login', async (req, res) => {
  try {
    if (!(await hasUsers())) return res.redirect('/setup');
    if (req.session.userId) return res.redirect('/');
    res.send(loginPage(req.query.error === '1'));
  } catch (error) {
    console.error('Load login page failed:', error.message);
    res.status(500).send('Không thể tải trang đăng nhập.');
  }
});

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query('SELECT id, username, password_hash FROM app_users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.redirect(303, '/login?error=1');
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    await saveSession(req);
    res.redirect(303, '/');
  } catch (error) {
    console.error('Login failed:', error.message);
    res.status(500).send('Không thể đăng nhập. Vui lòng thử lại.');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).send('Không thể đăng xuất. Vui lòng thử lại.');
    res.clearCookie('connect.sid', { path: '/' });
    res.redirect(303, '/login');
  });
});

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
    const summary = await pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'Nháp')::int AS draft,
        COUNT(*) FILTER (WHERE status = 'Chờ phê duyệt')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'Đang hiệu lực' AND (end_date IS NULL OR end_date >= CURRENT_DATE))::int AS active,
        COUNT(*) FILTER (WHERE status = 'Hết hạn' OR (status = 'Đang hiệu lực' AND end_date < CURRENT_DATE))::int AS expired,
        COUNT(*) FILTER (WHERE status = 'Đã hủy')::int AS cancelled,
        COALESCE(SUM(contract_value), 0)::numeric AS total_value
      FROM contracts
    `);
    const upcoming = await pool.query(`
      SELECT c.*, COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS related_parties
      FROM contracts c LEFT JOIN contract_parties cp ON cp.contract_id = c.id
      LEFT JOIN counterparties p ON p.id = cp.counterparty_id
      WHERE c.status = 'Đang hiệu lực' AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
      GROUP BY c.id ORDER BY c.end_date LIMIT 6
    `);
    const expired = await pool.query(`
      SELECT c.*, COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS related_parties
      FROM contracts c LEFT JOIN contract_parties cp ON cp.contract_id = c.id
      LEFT JOIN counterparties p ON p.id = cp.counterparty_id
      WHERE c.status = 'Hết hạn' OR (c.status = 'Đang hiệu lực' AND c.end_date < CURRENT_DATE)
      GROUP BY c.id ORDER BY c.end_date DESC NULLS LAST LIMIT 5
    `);
    const recent = await pool.query(`
      SELECT c.*, COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS related_parties
      FROM contracts c LEFT JOIN contract_parties cp ON cp.contract_id = c.id
      LEFT JOIN counterparties p ON p.id = cp.counterparty_id
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT 6
    `);
    const s = summary.rows[0];
    const flash = req.query.created ? '<div class="alert">Đã tạo hợp đồng thành công.</div>' : '';
    res.send(page(`${flash}${pageHead('Tổng quan', 'Tình hình hợp đồng và các mốc cần theo dõi.', '<a class="button-link" href="/contracts/new">Thêm hợp đồng</a>')}
      <div class="stats-grid">
        <section class="card stat-card"><div class="stat-label">Tổng hợp đồng</div><div class="stat-value">${s.total}</div><div class="stat-note">Tổng số hồ sơ</div></section>
        <section class="card stat-card"><div class="stat-label">Đang hiệu lực</div><div class="stat-value">${s.active}</div><div class="stat-note">Còn trong thời hạn</div></section>
        <section class="card stat-card"><div class="stat-label">Sắp hết hạn</div><div class="stat-value">${upcoming.rowCount}</div><div class="stat-note">Trong 30 ngày tới</div></section>
        <section class="card stat-card"><div class="stat-label">Tổng giá trị</div><div class="stat-value">${money(s.total_value)}</div><div class="stat-note">Tất cả trạng thái</div></section>
      </div>
      <section class="card"><div class="page-head"><div><h2>Trạng thái hợp đồng</h2><p>Hạn đã qua được tính là hết hạn.</p></div></div>
        <div class="stats-grid"><div><span class="stat-label">Nháp</span><div class="stat-value">${s.draft}</div></div><div><span class="stat-label">Chờ phê duyệt</span><div class="stat-value">${s.pending}</div></div><div><span class="stat-label">Hết hạn</span><div class="stat-value">${s.expired}</div></div><div><span class="stat-label">Đã hủy</span><div class="stat-value">${s.cancelled}</div></div></div>
      </section>
      <section class="card">${pageHead('Sắp hết hạn', 'Hợp đồng đang hiệu lực sẽ kết thúc trong 30 ngày.', '<a href="/contracts?status=Đang+hiệu+lực">Xem danh sách</a>')}${upcoming.rowCount ? contractTable(upcoming.rows) : '<div class="empty-state">Chưa có hợp đồng sắp hết hạn.</div>'}</section>
      ${expired.rowCount ? `<section class="card"><div class="notice-danger"><strong>${expired.rowCount} hợp đồng đã hết hạn</strong> trong danh sách cảnh báo gần nhất.</div>${contractTable(expired.rows)}</section>` : ''}
      <section class="card">${pageHead('Hợp đồng cập nhật gần đây', '', '<a href="/contracts">Xem tất cả</a>')}${contractTable(recent.rows)}</section>`, req.session.username));
  } catch (error) {
    console.error('Load dashboard failed:', error.message);
    res.status(500).send(page('<section class="card"><h2>Không thể tải tổng quan</h2><p>Kiểm tra log ứng dụng và kết nối database.</p></section>', req.session.username));
  }
});

app.get('/contracts', async (req, res) => {
  try {
    const { values, where } = contractFilterQuery(req.query);
    const result = await pool.query(`
      SELECT c.*, COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS related_parties
      FROM contracts c LEFT JOIN contract_parties cp ON cp.contract_id = c.id
      LEFT JOIN counterparties p ON p.id = cp.counterparty_id
      ${where} GROUP BY c.id ORDER BY c.created_at DESC
    `, values);
    const parties = await getCounterparties();
    const statusOptions = contractStatuses.map(status => `<option value="${esc(status)}" ${req.query.status === status ? 'selected' : ''}>${esc(status)}</option>`).join('');
    const partyOptions = parties.map(party => `<option value="${party.id}" ${Number(req.query.counterparty) === party.id ? 'selected' : ''}>${esc(party.name)}</option>`).join('');
    const filters = `<form class="filter-grid" method="get">
      <div><label for="filter-q">Từ khóa</label><input id="filter-q" name="q" value="${esc(req.query.q || '')}" placeholder="Mã, tên, bên liên quan"></div>
      <div><label for="filter-status">Trạng thái</label><select id="filter-status" name="status"><option value="">Tất cả</option>${statusOptions}</select></div>
      <div><label for="filter-party">Bên liên quan</label><select id="filter-party" name="counterparty"><option value="">Tất cả</option>${partyOptions}</select></div>
      <div><label for="filter-from">Từ ngày</label><input id="filter-from" name="from" type="date" value="${esc(req.query.from || '')}"></div>
      <div><label for="filter-to">Đến ngày</label><input id="filter-to" name="to" type="date" value="${esc(req.query.to || '')}"></div>
      <div class="actions"><button type="submit">Lọc</button><a class="button-link button-secondary" href="/contracts">Xóa lọc</a></div>
    </form>`;
    res.send(page(`<section class="card">${pageHead('Hợp đồng', `${result.rowCount} kết quả`, '<a class="button-link" href="/contracts/new">Thêm hợp đồng</a>')}${filters}</section><section class="card">${contractTable(result.rows)}</section>`, req.session.username));
  } catch (error) {
    console.error('List contracts failed:', error.message);
    res.status(500).send(page('<section class="card"><h2>Không thể tải danh sách hợp đồng.</h2></section>', req.session.username));
  }
});

app.get('/contracts/new', async (req, res) => {
  res.send(page(renderContractForm({}, await getCounterparties()), req.session.username));
});

app.get('/contracts/:id/edit', async (req, res) => {
  const contract = await getContract(req.params.id);
  if (!contract) return res.status(404).send(page('<section class="card"><h2>Không tìm thấy hợp đồng.</h2></section>', req.session.username));
  res.send(page(renderContractForm(contract, await getCounterparties()), req.session.username));
});

async function validateContractInput(body) {
  const contractCode = String(body.contract_code || '').trim();
  const title = String(body.title || '').trim();
  const status = String(body.status || 'Nháp');
  const value = Number(body.contract_value || 0);
  const startDate = String(body.start_date || '') || null;
  const endDate = String(body.end_date || '') || null;
  const partyIds = [...new Set((Array.isArray(body.party_ids) ? body.party_ids : [body.party_ids]).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!contractCode || contractCode.length > 40 || !title || title.length > 200) return { error: 'Mã và tên hợp đồng là bắt buộc, tối đa lần lượt 40 và 200 ký tự.' };
  if (!contractStatuses.includes(status)) return { error: 'Trạng thái hợp đồng không hợp lệ.' };
  if (!Number.isFinite(value) || value < 0 || value > maxContractValue) return { error: 'Giá trị hợp đồng phải từ 0 đến 999.999.999.999,99 VNĐ.' };
  const validDate = date => !date || (/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)));
  if (!validDate(startDate) || !validDate(endDate)) return { error: 'Ngày hợp đồng không hợp lệ.' };
  if (startDate && endDate && startDate > endDate) return { error: 'Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.' };
  if (!partyIds.length) return { error: 'Hãy chọn ít nhất một bên liên quan.' };
  const found = await pool.query('SELECT id FROM counterparties WHERE id = ANY($1::int[])', [partyIds]);
  if (found.rowCount !== partyIds.length) return { error: 'Một hoặc nhiều bên liên quan không tồn tại.' };
  return { contractCode, title, status, value, startDate, endDate, partyIds, notes: String(body.notes || '').slice(0, 10000) };
}

async function saveContract(values, id = null) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    let contractId = id;
    if (id) {
      await db.query(`UPDATE contracts SET contract_code=$1, title=$2, related_party='', status=$3, contract_value=$4, start_date=$5, end_date=$6, notes=$7, updated_at=NOW() WHERE id=$8`,
        [values.contractCode, values.title, values.status, values.value, values.startDate, values.endDate, values.notes, id]);
      await db.query('DELETE FROM contract_parties WHERE contract_id=$1', [id]);
    } else {
      const result = await db.query(`INSERT INTO contracts(contract_code,title,related_party,status,contract_value,start_date,end_date,notes)
        VALUES($1,$2,'',$3,$4,$5,$6,$7) RETURNING id`,
      [values.contractCode, values.title, values.status, values.value, values.startDate, values.endDate, values.notes]);
      contractId = result.rows[0].id;
    }
    await db.query('INSERT INTO contract_parties(contract_id, counterparty_id) SELECT $1, unnest($2::int[])', [contractId, values.partyIds]);
    await db.query(`UPDATE contracts SET related_party = (
      SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM contract_parties cp
      JOIN counterparties p ON p.id=cp.counterparty_id WHERE cp.contract_id=$1
    ) WHERE id=$1`, [contractId]);
    await db.query('COMMIT');
    return contractId;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

app.post('/contracts', async (req, res) => {
  const values = await validateContractInput(req.body);
  if (values.error) return res.status(400).send(page(renderContractForm({ ...req.body, parties: (Array.isArray(req.body.party_ids) ? req.body.party_ids : [req.body.party_ids]).filter(Boolean).map(id => ({ id })) }, await getCounterparties(), values.error), req.session.username));
  try {
    await saveContract(values);
    res.redirect(303, '/contracts?created=1');
  } catch (error) {
    console.error('Create contract failed:', error.message);
    const message = error.code === '23505' ? 'Mã hợp đồng đã tồn tại.' : 'Không thể tạo hợp đồng. Vui lòng kiểm tra dữ liệu.';
    res.status(error.code === '23505' ? 409 : 500).send(page(`<section class="card"><div class="auth-error">${esc(message)}</div><a href="/contracts/new">Quay lại biểu mẫu</a></section>`, req.session.username));
  }
});

app.post('/contracts/:id', async (req, res) => {
  const values = await validateContractInput(req.body);
  if (values.error) {
    const contract = { ...req.body, id: req.params.id, parties: (Array.isArray(req.body.party_ids) ? req.body.party_ids : [req.body.party_ids]).filter(Boolean).map(id => ({ id })) };
    return res.status(400).send(page(renderContractForm(contract, await getCounterparties(), values.error), req.session.username));
  }
  try {
    const result = await pool.query('SELECT 1 FROM contracts WHERE id=$1', [req.params.id]);
    if (!result.rowCount) return res.status(404).send(page('<section class="card"><h2>Không tìm thấy hợp đồng.</h2></section>', req.session.username));
    await saveContract(values, req.params.id);
    res.redirect(303, `/contracts/${req.params.id}`);
  } catch (error) {
    console.error('Update contract failed:', error.message);
    const message = error.code === '23505' ? 'Mã hợp đồng đã tồn tại.' : 'Không thể cập nhật hợp đồng.';
    res.status(error.code === '23505' ? 409 : 500).send(page(`<section class="card"><div class="auth-error">${esc(message)}</div><a href="/contracts/${esc(req.params.id)}/edit">Quay lại biểu mẫu</a></section>`, req.session.username));
  }
});

app.get('/contracts/:id', async (req, res) => {
  const contract = await getContract(req.params.id);
  if (!contract) return res.status(404).send(page('<section class="card"><h2>Không tìm thấy hợp đồng.</h2></section>', req.session.username));
  const parties = contract.parties.map(party => `<div class="detail-item"><a class="detail-value" href="/counterparties/${party.id}/edit">${esc(party.name)}</a><span class="detail-label">${esc([party.email, party.phone, party.address].filter(Boolean).join(' · ') || 'Chưa có thông tin liên hệ')}</span></div>`).join('');
  const expired = currentContractStatus(contract) === 'Hết hạn' ? '<div class="notice-danger">Hợp đồng đã hết hạn. Kiểm tra kế hoạch gia hạn.</div>' : '';
  const soon = contract.status === 'Đang hiệu lực' && contract.end_date && new Date(contract.end_date) >= new Date() && new Date(contract.end_date) <= new Date(Date.now() + 30 * 86400000)
    ? '<div class="notice-warning">Hợp đồng sẽ hết hạn trong 30 ngày tới.</div>' : '';
  res.send(page(`<section class="card">${pageHead(`Hợp đồng ${contract.contract_code}`, contract.title, `<a class="button-link button-secondary" href="/contracts">Danh sách</a><a class="button-link" href="/contracts/${contract.id}/edit">Chỉnh sửa</a>`)}${expired}${soon}
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Trạng thái</span><span class="detail-value">${statusBadge(currentContractStatus(contract))}</span></div>
      <div class="detail-item"><span class="detail-label">Giá trị</span><span class="detail-value">${money(contract.contract_value)}</span></div>
      <div class="detail-item"><span class="detail-label">Ngày bắt đầu</span><span class="detail-value">${esc(contract.start_date || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Ngày kết thúc</span><span class="detail-value">${esc(contract.end_date || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Tạo lúc</span><span class="detail-value">${esc(contract.created_at)}</span></div>
      <div class="detail-item"><span class="detail-label">Cập nhật lúc</span><span class="detail-value">${esc(contract.updated_at)}</span></div>
    </div><h3>Bên liên quan</h3><div class="detail-grid">${parties || '<div class="empty-state">Chưa gắn bên liên quan.</div>'}</div>
    <h3>Ghi chú</h3><p>${esc(contract.notes || 'Không có ghi chú.')}</p></section>`, req.session.username));
});

app.post('/contracts/:id/delete', async (req, res) => {
  const result = await pool.query('DELETE FROM contracts WHERE id=$1 RETURNING id', [req.params.id]);
  if (!result.rowCount) return res.status(404).send(page('<section class="card"><h2>Không tìm thấy hợp đồng.</h2></section>', req.session.username));
  res.redirect(303, '/contracts?deleted=1');
});

app.get('/counterparties', async (req, res) => {
  const result = await pool.query(`SELECT p.*, COUNT(DISTINCT cp.contract_id)::int AS contract_count
    FROM counterparties p LEFT JOIN contract_parties cp ON cp.counterparty_id=p.id
    WHERE ($1 = '' OR p.name ILIKE $2 OR p.email ILIKE $2 OR p.phone ILIKE $2)
    GROUP BY p.id ORDER BY p.name`, [String(req.query.q || '').trim(), `%${String(req.query.q || '').trim()}%`]);
  const rows = result.rows.map(party => `<tr><td><strong>${esc(party.name)}</strong></td><td>${esc(party.email || '—')}</td><td>${esc(party.phone || '—')}</td><td>${esc(party.address || '—')}</td><td>${party.contract_count}</td><td><div class="table-actions"><a class="button-link button-secondary" href="/counterparties/${party.id}/edit">Sửa</a><form class="inline-form" method="post" action="/counterparties/${party.id}/delete" onsubmit="return confirm('Xóa bên liên quan này?')"><button class="button-danger" type="submit">Xóa</button></form></div></td></tr>`).join('') || emptyRow(6, 'Chưa có bên liên quan.');
  res.send(page(`<section class="card">${pageHead('Bên liên quan', `${result.rowCount} tổ chức/cá nhân`, '<a class="button-link" href="/counterparties/new">Thêm bên liên quan</a>')}<form class="top" method="get"><input name="q" value="${esc(req.query.q || '')}" placeholder="Tìm tên, email hoặc số điện thoại"><button type="submit">Tìm</button></form></section><section class="card"><div class="table-wrap"><table><thead><tr><th>Tên</th><th>Email</th><th>Điện thoại</th><th>Địa chỉ</th><th>Hợp đồng</th><th>Thao tác</th></tr></thead><tbody>${rows}</tbody></table></div></section>`, req.session.username));
});

app.get('/counterparties/new', (_req, res) => {
  res.send(page(`<section class="card">${pageHead('Thêm bên liên quan', 'Lưu thông tin công ty hoặc cá nhân.')}
    <form method="post" action="/counterparties"><div class="grid">
      <div><label for="party-name">Tên công ty/cá nhân *</label><input id="party-name" name="name" required maxlength="200"></div>
      <div><label for="party-email">Email</label><input id="party-email" name="email" type="email" maxlength="254"></div>
      <div><label for="party-phone">Số điện thoại</label><input id="party-phone" name="phone" maxlength="40"></div>
      <div><label for="party-address">Địa chỉ</label><textarea id="party-address" name="address" maxlength="1000"></textarea></div>
    </div><div class="actions" style="margin-top:18px"><button type="submit">Lưu bên liên quan</button><a class="button-link button-secondary" href="/counterparties">Hủy</a></div></form></section>`, req.session.username));
});

app.get('/counterparties/:id/edit', async (req, res) => {
  const result = await pool.query('SELECT * FROM counterparties WHERE id=$1', [req.params.id]);
  const party = result.rows[0];
  if (!party) return res.status(404).send(page('<section class="card"><h2>Không tìm thấy bên liên quan.</h2></section>', req.session.username));
  res.send(page(`<section class="card">${pageHead('Chỉnh sửa bên liên quan', party.name)}
    <form method="post" action="/counterparties/${party.id}"><div class="grid">
      <div><label for="party-name">Tên công ty/cá nhân *</label><input id="party-name" name="name" required maxlength="200" value="${esc(party.name)}"></div>
      <div><label for="party-email">Email</label><input id="party-email" name="email" type="email" maxlength="254" value="${esc(party.email)}"></div>
      <div><label for="party-phone">Số điện thoại</label><input id="party-phone" name="phone" maxlength="40" value="${esc(party.phone)}"></div>
      <div><label for="party-address">Địa chỉ</label><textarea id="party-address" name="address" maxlength="1000">${esc(party.address)}</textarea></div>
    </div><div class="actions" style="margin-top:18px"><button type="submit">Lưu thay đổi</button><a class="button-link button-secondary" href="/counterparties">Hủy</a></div></form></section>`, req.session.username));
});

app.post('/counterparties', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const address = String(req.body.address || '').trim();
  if (!name || name.length > 200 || email.length > 254 || phone.length > 40 || address.length > 1000) return res.status(400).send('Thông tin bên liên quan không hợp lệ.');
  try {
    await pool.query('INSERT INTO counterparties(name,email,phone,address) VALUES($1,$2,$3,$4)', [name, email, phone, address]);
    res.redirect(303, '/counterparties');
  } catch (error) {
    const message = error.code === '23505' ? 'Tên bên liên quan đã tồn tại.' : 'Không thể lưu bên liên quan.';
    res.status(error.code === '23505' ? 409 : 500).send(page(`<section class="card"><div class="auth-error">${esc(message)}</div><a href="/counterparties/new">Quay lại</a></section>`, req.session.username));
  }
});

app.post('/counterparties/:id', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const address = String(req.body.address || '').trim();
  if (!name || name.length > 200 || email.length > 254 || phone.length > 40 || address.length > 1000) return res.status(400).send('Thông tin bên liên quan không hợp lệ.');
  try {
    const result = await pool.query('UPDATE counterparties SET name=$1,email=$2,phone=$3,address=$4 WHERE id=$5 RETURNING id', [name, email, phone, address, req.params.id]);
    if (!result.rowCount) return res.status(404).send('Không tìm thấy bên liên quan.');
    await pool.query(`UPDATE contracts c SET related_party = (
      SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM contract_parties cp
      JOIN counterparties p ON p.id=cp.counterparty_id WHERE cp.contract_id=c.id
    ), updated_at=NOW() WHERE EXISTS (SELECT 1 FROM contract_parties cp WHERE cp.contract_id=c.id AND cp.counterparty_id=$1)`, [req.params.id]);
    res.redirect(303, '/counterparties');
  } catch (error) {
    const message = error.code === '23505' ? 'Tên bên liên quan đã tồn tại.' : 'Không thể cập nhật bên liên quan.';
    res.status(error.code === '23505' ? 409 : 500).send(page(`<section class="card"><div class="auth-error">${esc(message)}</div><a href="/counterparties">Quay lại</a></section>`, req.session.username));
  }
});

app.post('/counterparties/:id/delete', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM counterparties WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rowCount) return res.status(404).send('Không tìm thấy bên liên quan.');
    res.redirect(303, '/counterparties');
  } catch (error) {
    if (error.code === '23503') return res.status(409).send(page('<section class="card"><div class="notice-warning">Bên liên quan đang gắn với hợp đồng nên không thể xóa.</div><a href="/counterparties">Quay lại danh sách</a></section>', req.session.username));
    console.error('Delete counterparty failed:', error.message);
    res.status(500).send('Không thể xóa bên liên quan.');
  }
});

app.get('/reports', async (req, res) => {
  const parsedYear = Number(req.query.year || new Date().getFullYear());
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : new Date().getFullYear();
  const stats = await pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(contract_value),0)::numeric AS value
    FROM contracts WHERE EXTRACT(YEAR FROM created_at)=$1 GROUP BY status ORDER BY status`, [year]);
  const months = await pool.query(`SELECT EXTRACT(MONTH FROM created_at)::int AS month, COUNT(*)::int AS count,
    COALESCE(SUM(contract_value),0)::numeric AS value FROM contracts
    WHERE EXTRACT(YEAR FROM created_at)=$1 GROUP BY month ORDER BY month`, [year]);
  const totals = await pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(contract_value),0)::numeric AS value
    FROM contracts WHERE EXTRACT(YEAR FROM created_at)=$1`, [year]);
  const maxValue = Math.max(1, ...months.rows.map(row => Number(row.value)));
  const monthRows = Array.from({ length: 12 }, (_, index) => {
    const row = months.rows.find(item => item.month === index + 1);
    const value = Number(row?.value || 0);
    return `<div class="month-row"><strong>${String(index + 1).padStart(2, '0')}</strong><div class="month-track"><div class="month-bar" style="width:${Math.round(value / maxValue * 100)}%"></div></div><div class="month-amount">${row?.count || 0} · ${money(value)}</div></div>`;
  }).join('');
  const statusRows = stats.rows.map(row => `<tr><td>${statusBadge(row.status)}</td><td>${row.count}</td><td>${money(row.value)}</td></tr>`).join('') || emptyRow(3, 'Chưa có dữ liệu trong năm này.');
  res.send(page(`<section class="card">${pageHead('Báo cáo và thống kê', 'Tổng hợp hợp đồng theo năm tạo.', `<a class="button-link" href="/reports/export.csv?year=${year}">Xuất CSV</a>`)}
    <form class="top" method="get"><label for="report-year">Năm báo cáo</label><input id="report-year" name="year" type="number" min="2000" max="2100" value="${year}" style="max-width:180px"><button type="submit">Xem báo cáo</button></form></section>
    <div class="stats-grid"><section class="card stat-card"><div class="stat-label">Hợp đồng tạo năm ${year}</div><div class="stat-value">${totals.rows[0].count}</div></section><section class="card stat-card"><div class="stat-label">Tổng giá trị</div><div class="stat-value">${money(totals.rows[0].value)}</div></section></div>
    <section class="card">${pageHead('Giá trị theo tháng', 'Số hợp đồng và giá trị được tạo trong từng tháng.') }<div class="monthly-chart">${monthRows}</div></section>
    <section class="card">${pageHead('Theo trạng thái', '')}<div class="table-wrap"><table><thead><tr><th>Trạng thái</th><th>Số lượng</th><th>Tổng giá trị</th></tr></thead><tbody>${statusRows}</tbody></table></div></section>`, req.session.username));
});

app.get('/reports/export.csv', async (req, res) => {
  const parsedYear = Number(req.query.year || new Date().getFullYear());
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : new Date().getFullYear();
  const result = await pool.query(`SELECT c.contract_code, c.title, c.status, c.contract_value, c.start_date, c.end_date,
    COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS parties,
    COALESCE(string_agg(DISTINCT p.email, ', ' ORDER BY p.email) FILTER (WHERE p.email <> ''), '') AS emails, c.notes, c.created_at
    FROM contracts c LEFT JOIN contract_parties cp ON cp.contract_id=c.id LEFT JOIN counterparties p ON p.id=cp.counterparty_id
    WHERE EXTRACT(YEAR FROM c.created_at)=$1 GROUP BY c.id ORDER BY c.created_at DESC`, [year]);
  const headers = ['Mã hợp đồng','Tên hợp đồng','Trạng thái','Giá trị','Ngày bắt đầu','Ngày kết thúc','Bên liên quan','Email','Ghi chú','Ngày tạo'];
  const lines = [headers, ...result.rows.map(row => [row.contract_code,row.title,currentContractStatus(row),row.contract_value,row.start_date,row.end_date,row.parties,row.emails,row.notes,row.created_at])]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="contracts-${year}.csv"` });
  res.send(`\uFEFF${lines}`);
});
initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`Contract app listening on ${port}`)))
  .catch(e => { console.error('Database initialization failed:', e); process.exit(1); });
