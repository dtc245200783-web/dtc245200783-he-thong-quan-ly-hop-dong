# Hệ thống Quản lý Hợp đồng

Dự án môn **Triển khai và Quản trị Hệ thống Phần mềm**. Stack: Node.js/Express, PostgreSQL, pgAdmin, Nginx reverse proxy, Prometheus, Grafana, Loki và Promtail, tất cả chạy bằng Docker Compose.

## 1. Yêu cầu

- Docker Desktop đã cài và đang chạy.
- Git.
- Windows PowerShell hoặc terminal tương đương.

## 2. Chạy lần đầu

1. Giải nén dự án.
2. Đổi tên `.env.example` thành `.env`.
3. Mở `.env`, đổi tất cả mật khẩu mẫu thành mật khẩu mạnh riêng của bạn.
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

## 3. Địa chỉ truy cập

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

## 4. Chức năng website

- Tạo hợp đồng.
- Xem danh sách hợp đồng và tìm kiếm.
- Theo dõi trạng thái: Nháp, Đang hiệu lực, Hết hạn, Đã hủy.
- Lưu bên liên quan, giá trị, ngày bắt đầu/kết thúc, ghi chú.
- Số liệu endpoint `/metrics` cho Prometheus; `/health` kiểm tra ứng dụng và DB.

## 5. Giám sát

Prometheus scrape ứng dụng, cAdvisor và PostgreSQL exporter. Grafana tự động provision datasource Prometheus/Loki cùng dashboard **Contract System Overview** tại Dashboards → Contract Management. Dashboard hiển thị trạng thái scrape, request rate, bộ nhớ web, PostgreSQL exporter, CPU/bộ nhớ container và log ứng dụng. Một số metric hữu ích: `up`, `process_resident_memory_bytes`, `pg_up`, `container_cpu_usage_seconds_total`.

## 6. Truy vấn LogQL mẫu

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

## 7. Hardening đã áp dụng / cần kiểm tra

- Backend và database nằm trong network `backend` dạng internal.
- PostgreSQL không publish trực tiếp ra máy host.
- Ứng dụng chạy bằng user không phải root.
- Ứng dụng có filesystem read-only, `cap_drop: ALL`, `no-new-privileges`.
- Nginx có security headers, HTTPS tự ký.
- Tắt đăng ký tài khoản Grafana và đặt mật khẩu qua `.env`.
- Không commit `.env` hoặc private key lên GitHub.
- **Lưu ý:** cAdvisor cần quyền truy cập host để thu thập metrics nên là ngoại lệ quyền cao; chỉ dùng trong môi trường học tập/local. Với môi trường thực tế, cần rà soát lại quyền và phiên bản image.

## 8. Báo cáo

Báo cáo triển khai và ảnh minh chứng nằm trong `report/bao-cao-trien-khai.html`. Mở file bằng trình duyệt, thay các placeholder trường/khoa, họ tên, MSSV, lớp và giảng viên; sau đó in khổ A4 hoặc chọn Save as PDF. Báo cáo hiện có ảnh website, pgAdmin, Prometheus Targets và Grafana; cần bổ sung ảnh pgAdmin sau khi đặt master password và kết nối database.

## 9. Commit theo rubric

Tạo commit sau khi kiểm tra phần tương ứng; không commit `.env`, private key hoặc dữ liệu thật:

```bash
git init
git branch -M main
git add app nginx docker-compose.yml .env.example README.md
git commit -m "Deploy contract web with PostgreSQL and Nginx"

git add prometheus grafana
git commit -m "Add Prometheus monitoring and Grafana dashboard"

git add loki promtail
git commit -m "Add centralized logging with Loki and Promtail"

git add report
git commit -m "Add deployment report and evidence"
```

Hardening được thể hiện trong commit Compose/Nginx liên quan; nếu thay đổi sau đó, tạo commit riêng mô tả đúng thay đổi. Không tạo commit rỗng chỉ để đủ số lượng.

## 10. GitHub

Tạo repository đặt tên theo mã số sinh viên theo yêu cầu giảng viên. Không tải `.env`, mật khẩu thật, hoặc file chứng chỉ private lên GitHub. Sau khi tạo repo:

```bash
git init
git branch -M main
git add .
git commit -m "Initial project scaffold"
git remote add origin https://github.com/<username>/<repository>.git
git push -u origin main
```

Thay URL bằng repository thật của bạn.
