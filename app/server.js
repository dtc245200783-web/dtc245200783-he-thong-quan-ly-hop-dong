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
const userRoleCache = new Map();
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
app.use(async (req, res, next) => {
  if (['/login', '/admin/login', '/setup', '/health', '/metrics'].includes(req.path)) return next();
  if (!req.session.userId) return res.redirect(req.path.startsWith('/admin') ? '/admin/login' : '/login');
  try {
    const result = await pool.query('SELECT username, role FROM app_users WHERE id=$1 AND is_active=TRUE', [req.session.userId]);
    if (!result.rowCount) {
      req.session.destroy(() => {});
      res.clearCookie('connect.sid', { path: '/' });
      return res.redirect(req.path.startsWith('/admin') ? '/admin/login' : '/login');
    }
    req.session.username = result.rows[0].username;
    req.session.role = result.rows[0].role;
    if ((req.path === '/users' || req.path.startsWith('/users/')) && req.session.role !== 'admin') {
      return res.status(403).send(page('<section class="card"><h2>Bạn không có quyền truy cập trang này.</h2></section>', req.session.username, req.session.role, req.path));
    }
    next();
  } catch (error) {
    next(error);
  }
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
      role VARCHAR(16) NOT NULL DEFAULT 'admin',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE app_users ALTER COLUMN username TYPE VARCHAR(255)');
  await pool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'admin'");
  await pool.query('ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
  const users = await pool.query('SELECT username, role FROM app_users');
  userRoleCache.clear();
  for (const user of users.rows) userRoleCache.set(user.username, user.role);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const money = (v) => Number(v || 0).toLocaleString('vi-VN') + ' ₫';
const formatDate = value => value ? (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)) : '';
const displayDate = value => {
  const date = formatDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

function page(content, username = '', role = '', activePath = '') {
  role = role || userRoleCache.get(username) || 'user';
  if (!activePath) {
    const title = content.match(/<h2[^>]*>([^<]+)/)?.[1] || '';
    if (title.startsWith('Tổng quan')) activePath = '/';
    else if (title.includes('Bên liên quan')) activePath = '/counterparties';
    else if (title.includes('Báo cáo')) activePath = '/reports';
    else if (title.includes('người dùng') || title.includes('Người dùng')) activePath = '/users';
    else activePath = '/contracts';
  }
  const navItems = [
    { href: '/', label: 'Tổng quan', active: activePath === '/' },
    { href: '/contracts', label: 'Quản lý hợp đồng', active: activePath.startsWith('/contracts') && !activePath.includes('status=') },
    { href: '/counterparties', label: 'Bên liên quan', active: activePath.startsWith('/counterparties') },
    { href: '/contracts?status=Ch%E1%BB%9D+ph%C3%AA+duy%E1%BB%87t', label: 'Theo dõi trạng thái', active: activePath.includes('status=') },
    { href: '/reports', label: 'Báo cáo', active: activePath.startsWith('/reports') },
    { href: '/settings', label: 'Cài đặt', active: activePath.startsWith('/settings') },
  ];
  if (role === 'admin') navItems.push({ href: '/users', label: 'Người dùng', active: activePath.startsWith('/users') });
  const navigation = username ? navItems.map(item => `<a class="sidebar-link ${item.active ? 'active' : ''}" href="${item.href}"><span class="nav-dot">•</span>${item.label}</a>`).join('') : '';
  const userLabel = role === 'admin' ? 'Quản trị viên' : 'Người dùng';
  const authActions = username
    ? `<div class="user-actions"><span class="role-chip">${userLabel} <span aria-hidden="true">▾</span></span><span class="user-name">${esc(username)}</span><form method="post" action="/logout"><button class="logout-button" type="submit">Đăng xuất</button></form></div>`
    : '';
  const shell = username
    ? `<div class="app-shell"><aside class="sidebar"><a class="brand" href="/"><strong>CONTRACT</strong><span>MANAGEMENT</span></a><nav class="sidebar-nav">${navigation}</nav></aside><div class="workspace"><header class="topbar"><h1>Quản lý hợp đồng</h1>${authActions}</header><main>${content}<footer class="app-footer">Hệ thống Quản lý Hợp đồng</footer></main></div></div>`
    : `<main class="auth-shell">${content}</main>`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Quản lý hợp đồng</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#1f2937;font:15px Arial,sans-serif;line-height:1.5}
  .app-shell{min-height:100vh;display:grid;grid-template-columns:252px minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;padding:22px 14px;background:#19283f;color:#e7edf5;overflow:auto}.brand{display:flex;flex-direction:column;margin:0 14px 48px;color:white;text-decoration:none;line-height:1.25}.brand strong{font-size:27px;letter-spacing:.4px}.brand span{margin-top:3px;color:#a8bad1;font-size:16px}.sidebar-nav{display:grid;gap:8px}.sidebar-link{display:flex;align-items:center;gap:12px;min-height:43px;padding:8px 13px;border-radius:8px;color:#c7d2e0;text-decoration:none;font-size:15px;white-space:nowrap}.sidebar-link:hover{background:#ffffff12;color:white}.sidebar-link.active{background:#2c64b2;color:#fff;font-weight:bold}.nav-dot{width:12px;color:inherit;font-size:20px;line-height:1;text-align:center}
  .workspace{min-width:0}.topbar{height:76px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 28px;background:#fff;border-bottom:1px solid #e6eaf0}.topbar h1{margin:0;color:#1d2b43;font-size:26px;line-height:1.2;white-space:nowrap}.user-actions{display:flex;align-items:center;gap:8px;min-width:0}.role-chip{display:inline-flex;align-items:center;gap:8px;padding:8px 13px;border-radius:20px;background:#edf2f8;color:#42546c;white-space:nowrap}.user-name{max-width:130px;overflow:hidden;color:#53657a;text-overflow:ellipsis;white-space:nowrap}.user-actions form{margin:0}.logout-button{min-height:36px;padding:6px 11px;background:transparent;color:#385574;border:1px solid #ccd6e2;font-size:13px;white-space:nowrap}.logout-button:hover{background:#edf2f8;transform:none;box-shadow:none}
  .workspace main{max-width:none;margin:0;padding:28px 36px 18px}.app-footer{margin-top:46px;color:#8897a9;font-size:13px}.auth-shell{min-height:100vh;display:grid;place-items:center;padding:28px;background:#f3f5f8}
  .card{background:white;padding:24px;border:1px solid #dfe5ed;border-radius:8px;box-shadow:0 2px 7px #1327430a;margin-bottom:20px}
  h2{margin:0 0 18px;padding-left:11px;border-left:3px solid #1769d2;font-size:20px;line-height:1.35;color:#23344e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  label{display:block;font-weight:bold;font-size:13px;color:#34475a;margin-bottom:6px}input,select,textarea{width:100%;min-height:42px;padding:9px 12px;border:1px solid #d6dee8;border-radius:6px;background:#fff;color:#1f2937;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}input::placeholder,textarea::placeholder{color:#9aa8b8}input:hover,select:hover,textarea:hover{border-color:#9eb0c4}input:focus,select:focus,textarea:focus{outline:none;border-color:#3472c3;box-shadow:0 0 0 3px #3472c322}
  textarea{min-height:88px;resize:vertical}button{min-height:40px;background:#326ab4;color:white;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;font:inherit;font-weight:bold;transition:background .15s ease,box-shadow .15s ease,transform .15s ease}button:hover{background:#255996;box-shadow:0 2px 7px #193d6c24;transform:translateY(-1px)}button:active{transform:translateY(0)}button:focus-visible,a:focus-visible{outline:3px solid #3472c355;outline-offset:2px}
  .table-wrap{overflow:auto;border:0;border-radius:0}table{width:100%;border-collapse:separate;border-spacing:0;min-width:760px}th,td{text-align:left;border-bottom:1px solid #edf0f4;padding:11px 12px}th{background:#edf1f6;color:#52627a;font-size:12px;font-weight:bold;white-space:nowrap}tbody tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#fafbfd}tbody tr:hover{background:#f3f7fc}
  .pill{display:inline-block;padding:4px 9px;border:1px solid #cfe0f7;border-radius:999px;background:#eaf2ff;color:#164b8a;font-size:12px;font-weight:bold;white-space:nowrap}.top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.top h2{margin:0}.top form{display:flex;align-items:center;gap:8px}.muted{color:#718198;font-size:13px}.alert{background:#e9f7ee;color:#166534;padding:11px 13px;border:1px solid #cbe9d4;border-radius:6px;margin-bottom:14px}
  .auth-card{width:min(460px,100%);margin:0;padding:30px}.auth-card h2{margin-bottom:10px}.auth-card .auth-intro{margin:0 0 18px;color:#64748b}.auth-card .auth-field{margin:14px 0}.auth-card .auth-submit{width:100%;margin-top:8px}.auth-error{margin:12px 0;padding:10px 12px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#991b1b}
  .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.page-head h2{margin:0}.page-head p{margin:6px 0 0;color:#718198}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.button-link{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:7px 13px;border-radius:6px;background:#326ab4;color:#fff;text-decoration:none;font-weight:bold}.button-link:hover{background:#255996;color:#fff}.button-secondary{background:#fff;color:#326ab4;border:1px solid #cbd6e3}.button-secondary:hover{background:#f3f7fc;color:#255996}.button-danger{background:#b42318}.button-danger:hover{background:#912018}
  .contract-intro{margin:0 0 22px;color:#718198;font-size:16px}.contract-list-card{min-height:540px;padding:22px}.contracts-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px}.contract-search{display:flex;align-items:center;gap:10px;flex:1;min-width:0}.contract-search input{max-width:320px;min-width:0;flex:1;background:#f8fafc}.contract-search button,.contracts-toolbar>.button-link{flex:none;white-space:nowrap}.filter-details{margin:0 0 16px;border-top:1px solid #e8edf2}.filter-details summary{padding:12px 0;color:#53657a;font-size:13px;font-weight:bold;cursor:pointer}.filter-details[open] summary{margin-bottom:10px}.contract-list-table{min-width:720px}.contract-list-table td:nth-child(2){min-width:175px}.status-upcoming{background:#fff7e8;border-color:#f6dfb0;color:#80550e}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.stat-card{padding:17px 18px;border-top:3px solid #326ab4}.stat-label{color:#718198;font-size:13px}.stat-value{margin-top:6px;color:#1d2b43;font-size:27px;font-weight:bold}.stat-note{margin-top:4px;color:#718198;font-size:12px}.status-active{background:#e7f7ee;border-color:#bde7cc;color:#17643b}.status-expired{background:#fff1f0;border-color:#ffd2cc;color:#a1281b}.status-draft{background:#edf3fb;border-color:#cbd9eb;color:#385475}.status-pending{background:#fff7e8;border-color:#f6dfb0;color:#80550e}.status-cancelled{background:#f1f2f4;border-color:#d7dbe0;color:#59616a}
  .filter-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;align-items:end;gap:10px}.filter-grid label{font-size:12px}.filter-grid button{white-space:nowrap}.field-hint{display:block;margin-top:4px;color:#64748b;font-size:12px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.detail-item{padding:12px;border-bottom:1px solid #e8edf2}.detail-label{display:block;color:#718198;font-size:12px}.detail-value{display:block;margin-top:4px;font-weight:600;overflow-wrap:anywhere}.notice-warning{padding:12px 14px;border:1px solid #f2d28c;border-radius:6px;background:#fff8e8;color:#704d0b}.notice-danger{padding:12px 14px;border:1px solid #f2c4bf;border-radius:6px;background:#fff2f0;color:#8c251b}.empty-state{padding:28px 12px;text-align:center;color:#718198}.table-actions{display:flex;align-items:center;gap:7px;white-space:nowrap}.inline-form{display:inline;margin:0}.monthly-chart{display:grid;gap:8px}.month-row{display:grid;grid-template-columns:46px minmax(70px,1fr) 120px;align-items:center;gap:10px}.month-track{height:12px;overflow:hidden;border-radius:8px;background:#e8eef5}.month-bar{height:100%;border-radius:8px;background:#326ab4}.month-amount{text-align:right;color:#526273;font-size:12px}.danger{color:#b91c1c}.smallbtn{min-height:34px;padding:6px 11px;font-size:12px}
  @media(max-width:900px){.app-shell{grid-template-columns:215px minmax(0,1fr)}.sidebar{padding-inline:10px}.topbar{padding-inline:24px}.workspace main{padding:24px}.filter-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.stats-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:650px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;width:100%;height:auto;padding:13px 12px}.brand{margin:0 8px 11px}.brand strong{font-size:20px}.brand span{font-size:12px}.sidebar-nav{display:flex;gap:4px;overflow-x:auto}.sidebar-link{min-height:38px;padding:7px 10px;font-size:13px}.workspace{min-width:0}.topbar{height:auto;min-height:68px;padding:12px 16px;align-items:flex-start;flex-direction:column;gap:10px}.topbar h1{font-size:22px}.user-actions{width:100%;flex-wrap:wrap}.workspace main{padding:20px 14px}.grid,.detail-grid{grid-template-columns:1fr;gap:13px}.card{padding:17px;margin-bottom:14px}.top form{width:100%}.top form input{min-width:0;flex:1}.contracts-toolbar{align-items:stretch;flex-direction:column}.contract-search{width:100%}.contract-search input{max-width:none;min-width:0;flex:1}.contracts-toolbar>.button-link{width:100%}.filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-grid > :first-child{grid-column:1/-1}.page-head{align-items:stretch;flex-direction:column}.page-head .actions{width:100%}.stats-grid{gap:9px}.stat-card{padding:13px}.stat-value{font-size:23px}.month-row{grid-template-columns:36px minmax(40px,1fr) 92px;gap:7px}}
  </style></head><body>${shell}</body></html>`;
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

function loginPage(error = '', role = 'user') {
  const isAdmin = role === 'admin';
  const message = error ? '<div class="auth-error">Tên đăng nhập hoặc mật khẩu không đúng.</div>' : '';
  const title = isAdmin ? 'Đăng nhập quản trị viên' : 'Đăng nhập người dùng';
  const switchLink = isAdmin ? '<a href="/login">Đăng nhập với tài khoản người dùng</a>' : '<a href="/admin/login">Đăng nhập quản trị viên</a>';
  const action = isAdmin ? '/admin/login' : '/login';
  return page(`<section class="card auth-card"><h2>${title}</h2>
    <p class="auth-intro">Đăng nhập để tiếp tục quản lý hợp đồng.</p>${message}
    <form method="post" action="${action}">
      <div class="auth-field"><label for="login-username">Tên đăng nhập</label><input id="login-username" name="username" required autocomplete="username"></div>
      <div class="auth-field"><label for="login-password">Mật khẩu</label><input id="login-password" name="password" type="password" required autocomplete="current-password"></div>
      <button class="auth-submit" type="submit">Đăng nhập</button>
    </form><p class="auth-intro">${switchLink}</p></section>`);
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
  const endDate = formatDate(contract.end_date);
  if (contract.status === 'Đang hiệu lực' && endDate && endDate < today) return 'Hết hạn';
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
    <td>${money(contract.contract_value)}</td><td>${esc(displayDate(contract.start_date) || '—')}</td><td>${esc(displayDate(contract.end_date) || '—')}</td>
    <td><div class="table-actions"><a class="button-link button-secondary" href="/contracts/${contract.id}">Chi tiết</a><a class="button-link button-secondary" href="/contracts/${contract.id}/edit">Sửa</a>
      <form class="inline-form" method="post" action="/contracts/${contract.id}/delete" onsubmit="return confirm('Xóa hợp đồng này?')"><button class="button-danger" type="submit">Xóa</button></form>
    </div></td>
  </tr>`).join('');
}

function contractTable(contracts) {
  return `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Hợp đồng / Bên liên quan</th><th>Trạng thái</th><th>Giá trị</th><th>Bắt đầu</th><th>Kết thúc</th><th>Thao tác</th></tr></thead><tbody>${contractRows(contracts)}</tbody></table></div>`;
}

function contractListTable(contracts) {
  const rows = contracts.map(contract => {
    const status = currentContractStatus(contract);
    const endDate = formatDate(contract.end_date);
    const today = new Date().toISOString().slice(0, 10);
    const soon = status === 'Đang hiệu lực' && endDate && endDate >= today && endDate <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const displayStatus = soon ? 'Sắp hết hạn' : status;
    return `<tr><td><a href="/contracts/${contract.id}">${esc(contract.contract_code)}</a></td><td>${esc(contract.title)}</td><td>${esc(contract.related_parties || '—')}</td><td>${esc(displayDate(endDate) || '—')}</td><td>${soon ? statusBadge(displayStatus).replace('status-draft', 'status-upcoming') : statusBadge(displayStatus)}</td><td>${money(contract.contract_value)}</td></tr>`;
  }).join('') || emptyRow(6, 'Chưa có hợp đồng phù hợp.');
  return `<div class="table-wrap"><table class="contract-list-table"><thead><tr><th>Mã HĐ</th><th>Tên hợp đồng</th><th>Bên liên quan</th><th>Ngày hết hạn</th><th>Trạng thái</th><th>Giá trị</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
        <div><label for="start-date">Ngày bắt đầu</label><input id="start-date" name="start_date" type="date" value="${esc(formatDate(contract.start_date))}"></div>
        <div><label for="end-date">Ngày kết thúc</label><input id="end-date" name="end_date" type="date" value="${esc(formatDate(contract.end_date))}"></div>
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
  if (isValidIsoDate(from)) conditions.push(`COALESCE(c.end_date, c.start_date, c.created_at::date) >= ${addValue(from)}::date`);
  if (isValidIsoDate(to)) conditions.push(`COALESCE(c.start_date, c.created_at::date) <= ${addValue(to)}::date`);
  return { values, where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '' };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
    const result = await db.query("INSERT INTO app_users(username, password_hash, role) VALUES($1, $2, 'admin') RETURNING id, role", [username, passwordHash]);
    await db.query('COMMIT');
    await regenerateSession(req);
    req.session.userId = result.rows[0].id;
    req.session.username = username;
    req.session.role = result.rows[0].role;
    userRoleCache.set(username, result.rows[0].role);
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

app.get(['/login', '/admin/login'], async (req, res) => {
  try {
    if (!(await hasUsers())) return res.redirect('/setup');
    const role = req.path === '/admin/login' ? 'admin' : 'user';
    if (req.session.userId && req.session.role === role) return res.redirect('/');
    res.send(loginPage(req.query.error === '1', role));
  } catch (error) {
    console.error('Load login page failed:', error.message);
    res.status(500).send('Không thể tải trang đăng nhập.');
  }
});

async function authenticateUser(req, res, requiredRole) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query('SELECT id, username, password_hash, role, is_active FROM app_users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !user.is_active || user.role !== requiredRole || !(await bcrypt.compare(password, user.password_hash))) {
      const loginPath = requiredRole === 'admin' ? '/admin/login' : '/login';
      return res.redirect(303, `${loginPath}?error=1`);
    }
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    userRoleCache.set(user.username, user.role);
    await saveSession(req);
    res.redirect(303, '/');
  } catch (error) {
    console.error('Login failed:', error.message);
    res.status(500).send('Không thể đăng nhập. Vui lòng thử lại.');
  }
}

app.post('/login', (req, res) => authenticateUser(req, res, 'user'));
app.post('/admin/login', (req, res) => authenticateUser(req, res, 'admin'));

app.get('/users', async (req, res) => {
  const result = await pool.query('SELECT id, username, role, is_active, created_at FROM app_users ORDER BY role, username');
  const rows = result.rows.map(user => `<tr><td>${esc(user.username)}</td><td>${user.role === 'admin' ? 'Quản trị viên' : 'Người dùng'}</td><td>${user.is_active ? 'Đang hoạt động' : 'Đã khóa'}</td><td>${esc(user.created_at)}</td><td>${user.id === req.session.userId ? 'Tài khoản hiện tại' : `<form method="post" action="/users/${user.id}/toggle"><button class="${user.is_active ? 'button-danger' : 'button-secondary'}" type="submit">${user.is_active ? 'Khóa' : 'Mở khóa'}</button></form>`}</td></tr>`).join('');
  res.send(page(`<section class="card">${pageHead('Quản lý người dùng', 'Tạo và khóa tài khoản người dùng.', '<a class="button-link" href="/users/new">Thêm người dùng</a>')}<div class="table-wrap"><table><thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Ngày tạo</th><th>Thao tác</th></tr></thead><tbody>${rows || emptyRow(5, 'Chưa có tài khoản.')}</tbody></table></div></section>`, req.session.username, req.session.role, req.path));
});

app.get('/users/new', (req, res) => {
  res.send(page(`<section class="card auth-card">${pageHead('Thêm người dùng', 'Tài khoản mới chỉ có quyền sử dụng nghiệp vụ.')}
    <form method="post" action="/users"><div class="auth-field"><label for="new-username">Tên đăng nhập</label><input id="new-username" name="username" required maxlength="255" autocomplete="username"></div>
    <div class="auth-field"><label for="new-password">Mật khẩu</label><input id="new-password" name="password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"></div>
    <button class="auth-submit" type="submit">Tạo tài khoản</button></form></section>`, req.session.username, req.session.role, req.path));
});

app.post('/users', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || Array.from(username).length > 255 || Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).send(page('<section class="card"><div class="auth-error">Tên đăng nhập là bắt buộc (tối đa 255 ký tự), mật khẩu từ 12 đến 72 byte.</div><a href="/users/new">Quay lại</a></section>', req.session.username, req.session.role, req.path));
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query("INSERT INTO app_users(username, password_hash, role) VALUES($1, $2, 'user')", [username, passwordHash]);
    userRoleCache.set(username, 'user');
    res.redirect(303, '/users');
  } catch (error) {
    const message = error.code === '23505' ? 'Tên đăng nhập đã tồn tại.' : 'Không thể tạo tài khoản.';
    res.status(error.code === '23505' ? 409 : 500).send(page(`<section class="card"><div class="auth-error">${esc(message)}</div><a href="/users/new">Quay lại</a></section>`, req.session.username, req.session.role, req.path));
  }
});

app.post('/users/:id/toggle', async (req, res) => {
  await pool.query('UPDATE app_users SET is_active = NOT is_active WHERE id=$1 AND id<>$2 AND role<>\'admin\'', [req.params.id, req.session.userId]);
  res.redirect(303, '/users');
});

app.get('/settings', (req, res) => {
  const error = req.query.error ? '<div class="auth-error">Mật khẩu hiện tại không đúng hoặc mật khẩu mới không hợp lệ.</div>' : '';
  const success = req.query.updated ? '<div class="alert">Mật khẩu đã được cập nhật.</div>' : '';
  res.send(page(`<section class="card auth-card">${pageHead('Cài đặt tài khoản', 'Đổi mật khẩu đăng nhập.')}${error}${success}
    <form method="post" action="/settings/password">
      <div class="auth-field"><label for="current-password">Mật khẩu hiện tại</label><input id="current-password" name="current_password" type="password" required autocomplete="current-password"></div>
      <div class="auth-field"><label for="new-password">Mật khẩu mới</label><input id="new-password" name="new_password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"></div>
      <div class="auth-field"><label for="confirm-password">Nhập lại mật khẩu mới</label><input id="confirm-password" name="confirm_password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"></div>
      <button class="auth-submit" type="submit">Cập nhật mật khẩu</button>
    </form></section>`, req.session.username, req.session.role, req.path));
});

app.post('/settings/password', async (req, res) => {
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const account = await pool.query('SELECT id, username, role, password_hash FROM app_users WHERE id=$1 AND is_active=TRUE', [req.session.userId]);
  if (!account.rowCount || !(await bcrypt.compare(currentPassword, account.rows[0].password_hash))
      || Buffer.byteLength(newPassword, 'utf8') < 12 || Buffer.byteLength(newPassword, 'utf8') > 72
      || newPassword !== confirmPassword) return res.redirect(303, '/settings?error=1');
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE app_users SET password_hash=$1 WHERE id=$2', [passwordHash, req.session.userId]);
  await regenerateSession(req);
  req.session.userId = account.rows[0].id;
  req.session.username = account.rows[0].username;
  req.session.role = account.rows[0].role;
  await saveSession(req);
  res.redirect(303, '/settings?updated=1');
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
        COUNT(*) FILTER (WHERE status = 'Đang hiệu lực' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS upcoming,
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
        <section class="card stat-card"><div class="stat-label">Sắp hết hạn</div><div class="stat-value">${s.upcoming}</div><div class="stat-note">Trong 30 ngày tới</div></section>
        <section class="card stat-card"><div class="stat-label">Tổng giá trị</div><div class="stat-value">${money(s.total_value)}</div><div class="stat-note">Tất cả trạng thái</div></section>
      </div>
      <section class="card"><div class="page-head"><div><h2>Trạng thái hợp đồng</h2><p>Hạn đã qua được tính là hết hạn.</p></div></div>
        <div class="stats-grid"><div><span class="stat-label">Nháp</span><div class="stat-value">${s.draft}</div></div><div><span class="stat-label">Chờ phê duyệt</span><div class="stat-value">${s.pending}</div></div><div><span class="stat-label">Hết hạn</span><div class="stat-value">${s.expired}</div></div><div><span class="stat-label">Đã hủy</span><div class="stat-value">${s.cancelled}</div></div></div>
      </section>
      <section class="card">${pageHead('Sắp hết hạn', 'Hợp đồng đang hiệu lực sẽ kết thúc trong 30 ngày.', '<a href="/contracts?status=Đang+hiệu+lực">Xem danh sách</a>')}${upcoming.rowCount ? contractTable(upcoming.rows) : '<div class="empty-state">Chưa có hợp đồng sắp hết hạn.</div>'}</section>
      ${s.expired ? `<section class="card"><div class="notice-danger"><strong>${s.expired} hợp đồng đã hết hạn</strong>; hiển thị tối đa 5 hợp đồng gần nhất.</div>${contractTable(expired.rows)}</section>` : ''}
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
    const hasAdvancedFilter = Boolean(req.query.status || req.query.counterparty || req.query.from || req.query.to);
    const filters = `<details class="filter-details" ${hasAdvancedFilter ? 'open' : ''}><summary>Bộ lọc nâng cao</summary><form class="filter-grid" method="get">
      <input type="hidden" name="q" value="${esc(req.query.q || '')}">
      <div><label for="filter-status">Trạng thái</label><select id="filter-status" name="status"><option value="">Tất cả</option>${statusOptions}</select></div>
      <div><label for="filter-party">Bên liên quan</label><select id="filter-party" name="counterparty"><option value="">Tất cả</option>${partyOptions}</select></div>
      <div><label for="filter-from">Từ ngày</label><input id="filter-from" name="from" type="date" value="${esc(req.query.from || '')}"></div>
      <div><label for="filter-to">Đến ngày</label><input id="filter-to" name="to" type="date" value="${esc(req.query.to || '')}"></div>
      <div class="actions"><button type="submit">Lọc</button><a class="button-link button-secondary" href="/contracts">Xóa lọc</a></div>
    </form></details>`;
    res.send(page(`<p class="contract-intro">Danh sách, tìm kiếm và lọc hợp đồng</p><section class="card contract-list-card"><div class="contracts-toolbar"><form class="contract-search" method="get"><label class="sr-only" for="contract-search">Tìm kiếm hợp đồng</label><input id="contract-search" name="q" value="${esc(req.query.q || '')}" placeholder="Tìm kiếm hợp đồng..."/><button type="submit">Tìm kiếm</button></form><a class="button-link" href="/contracts/new">＋ Thêm mới</a></div>${filters}<div class="muted" style="margin-bottom:10px">${result.rowCount} hợp đồng</div>${contractListTable(result.rows)}</section>`, req.session.username, req.session.role, req.originalUrl));
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
  const validDate = date => !date || isValidIsoDate(date);
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
  const endDate = formatDate(contract.end_date);
  const today = new Date().toISOString().slice(0, 10);
  const next30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const soon = contract.status === 'Đang hiệu lực' && endDate && endDate >= today && endDate <= next30
    ? '<div class="notice-warning">Hợp đồng sẽ hết hạn trong 30 ngày tới.</div>' : '';
  res.send(page(`<section class="card">${pageHead(`Hợp đồng ${contract.contract_code}`, contract.title, `<a class="button-link button-secondary" href="/contracts">Danh sách</a><a class="button-link" href="/contracts/${contract.id}/edit">Chỉnh sửa</a>`)}${expired}${soon}
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Trạng thái</span><span class="detail-value">${statusBadge(currentContractStatus(contract))}</span></div>
      <div class="detail-item"><span class="detail-label">Giá trị</span><span class="detail-value">${money(contract.contract_value)}</span></div>
      <div class="detail-item"><span class="detail-label">Ngày bắt đầu</span><span class="detail-value">${esc(displayDate(contract.start_date) || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Ngày kết thúc</span><span class="detail-value">${esc(displayDate(contract.end_date) || '—')}</span></div>
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
  const stats = await pool.query(`SELECT CASE
      WHEN status = 'Đang hiệu lực' AND end_date < CURRENT_DATE THEN 'Hết hạn'
      ELSE status END AS report_status,
      COUNT(*)::int AS count, COALESCE(SUM(contract_value),0)::numeric AS value
    FROM contracts WHERE EXTRACT(YEAR FROM created_at)=$1 GROUP BY report_status ORDER BY report_status`, [year]);
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
  const statusRows = stats.rows.map(row => `<tr><td>${statusBadge(row.report_status)}</td><td>${row.count}</td><td>${money(row.value)}</td></tr>`).join('') || emptyRow(3, 'Chưa có dữ liệu trong năm này.');
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
  const lines = [headers, ...result.rows.map(row => [row.contract_code,row.title,currentContractStatus(row),row.contract_value,formatDate(row.start_date),formatDate(row.end_date),row.parties,row.emails,row.notes,row.created_at])]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="contracts-${year}.csv"` });
  res.send(`\uFEFF${lines}`);
});
initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`Contract app listening on ${port}`)))
  .catch(e => { console.error('Database initialization failed:', e); process.exit(1); });
