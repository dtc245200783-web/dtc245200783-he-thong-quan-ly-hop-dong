# Hệ thống Quản lý Hợp đồng

Dự án môn **Triển khai và Quản trị Hệ thống Phần mềm**. Stack: Node.js/Express, PostgreSQL, pgAdmin, Nginx reverse proxy, Prometheus, Grafana, Loki và Promtail, tất cả chạy bằng Docker Compose.

## 1. Yêu cầu

- Docker Desktop đã cài và đang chạy.
- Git.
- Windows PowerShell hoặc terminal tương đương.

## 2. Chạy lần đầu

1. Giải nén dự án.
2. Sao chép `.env.example` thành `.env`.
3. Điền `POSTGRES_PASSWORD`, `PGADMIN_PASSWORD`, `GRAFANA_PASSWORD` và `SESSION_SECRET` bằng secret ngẫu nhiên mạnh. Nên dùng chuỗi hex ngẫu nhiên từ password manager hoặc ít nhất 32 byte cho mật khẩu, 48 byte cho session secret. Không dùng lại cùng một secret.
4. Tạo chứng chỉ HTTPS tự ký (PowerShell, chạy tại thư mục gốc):

```powershell
New-Item -ItemType Directory -Force nginx/certs
docker run --rm -v "${PWD}/nginx/certs:/certs" alpine/openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /certs/self-signed.key -out /certs/self-signed.crt -subj "/CN=localhost"
```

5. Khởi chạy:

```powershell
docker compose --env-file .env up -d --build
docker compose ps
```

Lần đầu có thể mất vài phút để tải image. Xem log: `docker compose logs -f web`.

## 3. Đăng nhập ứng dụng

- Lần truy cập đầu tiên vào website sẽ chuyển tới trang `/setup`. Tạo tài khoản quản trị của bạn; không có tài khoản/mật khẩu mặc định.
- Tên đăng nhập có thể dùng chữ hoa/thường, dấu cách và ký tự Unicode; tối đa 255 ký tự. Mật khẩu tối thiểu 12 ký tự và được lưu dạng bcrypt hash trong PostgreSQL.
- Các lần sau đăng nhập tại `/login`; đăng xuất bằng nút trên header. Session hết hạn sau 8 giờ và lưu trong PostgreSQL.
- `SESSION_SECRET` trong `.env` phải là chuỗi ngẫu nhiên mạnh (ít nhất 64 ký tự hex) để session tiếp tục hợp lệ sau khi container khởi động lại. Không commit `.env`.

## 4. Địa chỉ truy cập

- Website: http://localhost:8080
- Website HTTPS tự ký: https://localhost:8443 (trình duyệt sẽ cảnh báo chứng chỉ không được CA tin cậy)
- pgAdmin: http://localhost:8080/pgadmin/
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001
- Loki API: http://localhost:3100/ready

pgAdmin đăng nhập bằng `PGADMIN_EMAIL` và `PGADMIN_PASSWORD` trong `.env`. Thêm server:
- Host: `db`
- Port: `5432`
- Maintenance database: giá trị `POSTGRES_DB`
- Username/password: `POSTGRES_USER` / `POSTGRES_PASSWORD`

Grafana đăng nhập bằng `GRAFANA_USER` / `GRAFANA_PASSWORD`. Datasource Prometheus và Loki được provision tự động.

## 5. Chức năng website

- Dashboard tổng số, trạng thái, tổng giá trị, hợp đồng sắp hết hạn và danh sách cập nhật gần đây.
- Tạo, xem chi tiết, chỉnh sửa và xóa hợp đồng; tìm theo mã/tên/bên liên quan.
- Trạng thái: Nháp, Chờ phê duyệt, Đang hiệu lực, Hết hạn, Đã hủy; ngày kết thúc đã qua được tính là hết hạn.
- Danh bạ bên liên quan gồm tên, email, điện thoại, địa chỉ; một hợp đồng có thể liên kết nhiều bên.
- Lọc hợp đồng theo trạng thái, bên liên quan và khoảng ngày; nhắc hạn trong 30 ngày.
- Báo cáo theo năm, tổng hợp theo trạng thái/tháng và xuất CSV.
- Số liệu endpoint `/metrics` cho Prometheus; `/health` kiểm tra ứng dụng và DB.

## 6. Giám sát

Prometheus scrape ứng dụng, cAdvisor và PostgreSQL exporter. Grafana tự động provision datasource Prometheus/Loki cùng dashboard **Contract System Overview** tại Dashboards → Contract Management. Dashboard hiển thị trạng thái scrape, request rate, bộ nhớ web, PostgreSQL exporter, CPU/bộ nhớ container và log ứng dụng. Một số metric hữu ích: `up`, `process_resident_memory_bytes`, `pg_up`, `container_cpu_usage_seconds_total`.

## 7. Truy vấn LogQL mẫu

Trong Grafana → Explore → chọn Loki:

```logql
{container="contract-web"}
```

```logql
{container="contract-nginx"} |= " 5"
```

```logql
{container=~"contract-web|contract-nginx"} |~ "(?i)error|exception|failed"
```

Tên label có thể khác theo phiên bản Docker/Promtail và môi trường; nếu chưa có log, mở website tạo vài request rồi chờ Promtail thu thập.

## 8. Hardening đã áp dụng / cần kiểm tra

- Backend và database nằm trong network `backend` dạng internal.
- PostgreSQL không publish trực tiếp ra máy host.
- Ứng dụng chạy bằng user không phải root.
- Ứng dụng có filesystem read-only, `cap_drop: ALL`, `no-new-privileges`.
- Nginx có security headers, HTTPS tự ký.
- Mật khẩu tài khoản ứng dụng được bcrypt hash; session dùng cookie HttpOnly/SameSite và được lưu trong PostgreSQL.
- Tắt đăng ký tài khoản Grafana và đặt mật khẩu qua `.env`.
- Không commit `.env` hoặc private key lên GitHub.
- **Lưu ý:** cAdvisor cần quyền truy cập host để thu thập metrics nên là ngoại lệ quyền cao; chỉ dùng trong môi trường học tập/local. Với môi trường thực tế, cần rà soát lại quyền và phiên bản image.

## 9. Kịch bản demo và minh chứng

### Chuẩn bị

```powershell
docker compose ps
docker compose logs --tail 50 web db nginx prometheus grafana loki promtail
```

Đảm bảo `db` healthy và các service đang chạy trước khi trình bày. Website lần đầu sẽ mở `/setup`; tự tạo admin với mật khẩu tối thiểu 12 ký tự. Đăng nhập xong, tạo một bên liên quan và một hợp đồng thử để dashboard, biểu đồ và log có dữ liệu.

### Website và PostgreSQL/pgAdmin

1. Mở `http://localhost:8080`, đăng nhập, tạo bên liên quan gồm email/điện thoại/địa chỉ.
2. Tạo hợp đồng; mở chi tiết, sửa trạng thái/ngày, thử lọc theo trạng thái và bên liên quan; xem dashboard cảnh báo sắp hạn/quá hạn.
3. Mở `http://localhost:8080/pgadmin/`. Lần đầu pgAdmin yêu cầu tạo master password riêng; vào **Servers → Register → Server** để kết nối:
	- Name: `Contract DB`
	- Host: `db`; Port: `5432`
	- Maintenance database: giá trị `POSTGRES_DB` (mặc định `contracts`)
	- Username: `POSTGRES_USER`; Password: `POSTGRES_PASSWORD`
4. Trong pgAdmin mở `Databases → contracts → Schemas → public → Tables`, kiểm tra `contracts`, `counterparties`, `contract_parties`, `app_users` và `app_sessions`. Không publish cổng PostgreSQL ra host; pgAdmin kết nối qua Docker network.

### Prometheus và Grafana

1. Mở `http://localhost:9090/targets`; xác nhận `contract-web`, `postgres`, `cadvisor`, `prometheus` là `UP`. Có thể thử query `up`, `pg_up`, `contract_http_requests_total`.
2. Mở `http://localhost:3001`, đăng nhập bằng `GRAFANA_USER`/`GRAFANA_PASSWORD` trong `.env`; mở **Dashboards → Contract Management → Contract System Overview**.
3. Mở **Explore → Loki**, chạy các query ở mục LogQL bên dưới. Tạo request ở website rồi chạy lại query để có log mới.

### Hardening

Chạy các lệnh sau để minh chứng cấu hình trên container đang chạy:

```powershell
docker inspect contract-web --format "user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capDrop={{json .HostConfig.CapDrop}} security={{json .HostConfig.SecurityOpt}}"
docker compose ps db
docker network ls
git check-ignore .env nginx/certs/self-signed.key
```

Kết quả mong đợi: user ứng dụng là `node`, `readonly=true`, `capDrop` có `ALL`, security có `no-new-privileges:true`; service DB không có port host; `.env` và private key bị ignore. cAdvisor là ngoại lệ dùng quyền cao để đọc metrics host, chỉ nên trình bày trong môi trường lab/local.

### Thứ tự trình bày

Website tạo/sửa hợp đồng → pgAdmin kiểm tra bảng → Prometheus targets → Grafana dashboard → Explore với LogQL → `docker inspect`/network chứng minh hardening. Ảnh minh chứng và báo cáo nằm trong `report/`.

## 10. Báo cáo

Báo cáo triển khai và ảnh minh chứng nằm trong `report/bao-cao-trien-khai.html`. Mở file bằng trình duyệt, thay các placeholder trường/khoa, họ tên, MSSV, lớp và giảng viên; sau đó in khổ A4 hoặc chọn Save as PDF. Báo cáo hiện có ảnh website, pgAdmin, Prometheus Targets và Grafana; cần bổ sung ảnh pgAdmin sau khi đặt master password và kết nối database.

## 11. Commit theo rubric

Repository Git đã được khởi tạo ở nhánh `main`, có các commit riêng cho web/Nginx, monitoring, logging, báo cáo và các sửa lỗi. Khi bổ sung chức năng, tạo commit mô tả đúng thay đổi; không commit `.env`, private key hoặc dữ liệu thật.

## 12. GitHub

Repository đã được tạo và push tại `https://github.com/dtc245200783-web/dtc245200783-he-thong-quan-ly-hop-dong`; nhánh `main` theo dõi `origin/main`. Kiểm tra remote bằng:

```powershell
git remote -v
git status --short --branch
```

Đẩy commit mới bằng `git add <files>`, `git commit -m "Describe the change"`, rồi `git push`. Không tải `.env`, mật khẩu thật hoặc private key lên GitHub.
