# Railway 部署指南

本文档详细说明如何将 MarketNarrative 部署到 Railway 平台。

## 快速部署

### 一键部署（推荐）

点击下方按钮直接部署到 Railway：

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

部署后会自动：
- ✅ 创建 PostgreSQL 数据库
- ✅ 配置环境变量
- ✅ 构建并启动应用

### 手动部署步骤

#### 1. 准备工作

```bash
# 克隆仓库
git clone https://github.com/your-username/MarketNarrative.git
cd MarketNarrative

# 确保代码已提交
git add .
git commit -m "Ready for deployment"
```

#### 2. 创建 Railway 项目

1. 访问 [Railway.app](https://railway.app/)
2. 点击 "New Project"
3. 选择 "Deploy from GitHub repo"
4. 授权并选择 `MarketNarrative` 仓库

#### 3. 添加 PostgreSQL 数据库

在 Railway 项目中：
1. 点击 "+ New"
2. 选择 "Database" → "PostgreSQL"
3. 等待数据库创建完成
4. Railway 会自动设置 `DATABASE_URL` 环境变量

#### 4. 配置环境变量

在 Railway 项目的 "Variables" 标签页添加：

| 变量名           | 值                   | 说明       |
| ---------------- | -------------------- | ---------- |
| `SECRET_KEY`     | （生成随机字符串）   | **必需**   |
| `APP_PASSWORD`   | your-secure-password | **必需**   |
| `FLASK_DEBUG`    | False                | 推荐       |
| `PORT`           | 5001                 | 可选       |
| `DIFY_API_TOKEN` | your-dify-token      | AI功能需要 |

**生成 SECRET_KEY**：

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

#### 5. 数据库迁移

部署后首次需要初始化数据库表结构。

**方法一：使用 Railway CLI**

```bash
# 安装 Railway CLI
npm i -g @railway/cli

# 登录
railway login

# 连接到项目
railway link

# 执行数据库初始化
railway run python scripts/init_db.py
```

**方法二：使用 PostgreSQL 客户端**

连接到 Railway 提供的数据库 URL，执行以下 SQL：

```sql
CREATE TABLE IF NOT EXISTS annotations (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    period TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    content TEXT NOT NULL,
    ai_analysis TEXT,
    original_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_favorite INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ticker_period ON annotations(ticker, period);
CREATE INDEX IF NOT EXISTS idx_start_date ON annotations(start_date);
```

#### 6. 验证部署

1. 访问 Railway 提供的 URL（如 `https://marketnarrative-production.up.railway.app`）
2. 使用配置的 `APP_PASSWORD` 登录
3. 搜索股票代码测试功能

## 性能优化

### 1. Worker 配置

Railway 自动检测 `Procfile` 或使用 Nixpacks 构建。

创建 `Procfile`（可选）：

```
web: gunicorn app:app --workers 2 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT
```

**参数说明**：
- `--workers 2`：2个进程（Railway 免费层适用）
- `--threads 4`：每进程4个线程
- `--timeout 120`：请求超时时间（AI分析需要）
- `--bind 0.0.0.0:$PORT`：绑定到Railway环境变量端口

### 2. 数据库连接池

在生产环境启用连接池优化：

```python
# app.py 中已实现
import psycopg2.pool

db_pool = psycopg2.pool.SimpleConnectionPool(
    minconn=1,
    maxconn=10,
    dsn=DATABASE_URL
)
```

### 3. 启用 Gzip 压缩

减少传输大小，提升加载速度：

```python
from flask_compress import Compress

app = Flask(__name__)
Compress(app)  # 自动压缩响应
```

### 4. 静态资源优化

**方法一：使用 CDN**

将 `static/` 目录上传到 CDN：

```html
<!-- 修改 templates/index.html -->
<script src="https://cdn.example.com/static/script.js"></script>
<link rel="stylesheet" href="https://cdn.example.com/static/style.css">
```

**方法二：启用浏览器缓存**

```python
@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'public, max-age=86400'  # 24小时
    return response
```

### 5. 监控与日志

**查看实时日志**：

```bash
railway logs
```

**配置日志级别**：

```python
import logging

if IS_PRODUCTION:
    logging.basicConfig(level=logging.INFO)  # 生产环境
else:
    logging.basicConfig(level=logging.DEBUG)  # 开发环境
```

## 故障排除

### 问题1：数据库连接失败

**症状**：
```
sqlalchemy.exc.OperationalError: could not connect to server
```

**解决方案**：

1. 检查 `DATABASE_URL` 环境变量是否正确设置
2. 确认 PostgreSQL 服务已启动
3. 验证数据库凭据：

```bash
railway variables
```

### 问题2：应用启动超时

**症状**：
```
Error: Application failed to respond
```

**解决方案**：

1. 增加启动超时时间（Railway Settings）
2. 检查 `requirements.txt` 依赖是否完整
3. 查看构建日志：

```bash
railway logs --deployment
```

### 问题3：AI 分析504超时

**症状**：
```
504 Gateway Timeout when calling Dify API
```

**解决方案**：

1. 检查 `DIFY_API_TOKEN` 是否配置
2. 增加超时时间（已设置为600秒）
3. 验证 Dify 服务可用性

### 问题4：静态文件404

**症状**：
```
GET /static/script.js 404 Not Found
```

**解决方案**：

1. 确认 `static/` 和 `templates/` 目录已提交到 Git
2. 检查 `.gitignore` 是否误排除了静态文件
3. 验证 Flask 静态文件配置：

```python
app = Flask(__name__, 
            static_folder='static',
            template_folder='templates')
```

### 问题5：认证失败

**症状**：
```
401 Unauthorized
```

**解决方案**：

1. 确认 `APP_PASSWORD` 环境变量已设置
2. 清除浏览器 Cookie 重新登录
3. 测试 Basic Auth：

```bash
curl -u api:your-password https://your-app.railway.app/api/stock/TSLA
```

## 数据库备份

### 自动备份（Railway 内置）

Railway PostgreSQL 自动进行每日备份，保留7天。

### 手动备份

```bash
# 导出数据库
railway run pg_dump $DATABASE_URL > backup.sql

# 恢复数据库
railway run psql $DATABASE_URL < backup.sql
```

### 备份到本地

```bash
# 获取数据库 URL
railway variables

# 使用 pg_dump 导出（需本地安装 PostgreSQL 客户端）
pg_dump "postgresql://user:pass@host:port/dbname" > local_backup.sql
```

## 自定义域名

### 1. 添加域名

在 Railway 项目中：
1. 进入 "Settings" → "Domains"
2. 点击 "Add Domain"
3. 输入自定义域名（如 `marketnarrative.com`）

### 2. 配置 DNS

在域名注册商处添加 CNAME 记录：

| 类型  | 名称 | 值                      |
| ----- | ---- | ----------------------- |
| CNAME | @    | your-app.up.railway.app |

### 3. 启用 HTTPS

Railway 自动提供免费 SSL 证书（Let's Encrypt）。

## 成本估算

### Railway 定价（2024）

| 资源       | 免费层         | Pro 套餐         |
| ---------- | -------------- | ---------------- |
| 执行时间   | $5 免费额度/月 | $0.000463/GB-min |
| PostgreSQL | 512MB 存储     | $0.25/GB/月      |
| 带宽       | 无限制         | 无限制           |

**MarketNarrative 预估成本**：
- 小规模使用（<500请求/天）：**免费层足够**
- 中等规模（1000-5000请求/天）：约 **$5-10/月**

## 扩展阅读

- [Railway 官方文档](https://docs.railway.app/)
- [Flask 生产部署最佳实践](https://flask.palletsprojects.com/en/latest/deploying/)
- [PostgreSQL 性能调优](https://wiki.postgresql.org/wiki/Performance_Optimization)

---

**需要帮助？** 
- 📧 提交 [GitHub Issue](https://github.com/your-username/MarketNarrative/issues)
- 💬 查看 [Railway 社区](https://help.railway.app/)
