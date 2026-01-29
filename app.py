from flask import Flask, jsonify, request, render_template, session, redirect, url_for
import requests
import datetime
from functools import wraps # V5.0
import pandas as pd
import numpy as np
import os
import uuid
import json
import time
import random

# V5.0: 增强的环境配置
DATABASE_URL = os.environ.get('DATABASE_URL')
IS_PRODUCTION = bool(DATABASE_URL)

if IS_PRODUCTION:
    # 生产环境 - 使用PostgreSQL
    import psycopg2
    from psycopg2.extras import RealDictCursor
    USE_POSTGRESQL = True
    print("[INFO] 生产环境 - 使用PostgreSQL数据库")
else:
    # 开发环境 - 使用SQLite
    import sqlite3
    USE_POSTGRESQL = False
    DATABASE_PATH = 'annotations.db'
    print("[INFO] 开发环境 - 使用SQLite数据库")

app = Flask(__name__, template_folder='templates', static_folder='static')

# 确保JSON响应直接输出UTF-8中文，而不是\uXXXX转义
# 仅影响jsonify的输出，不改变其他逻辑
app.config['JSON_AS_ASCII'] = False

# V5.0: 会话和安全配置
# 从环境变量加载密钥和密码
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-for-local-testing')
APP_PASSWORD = os.environ.get('APP_PASSWORD', 'password') # 本地开发的默认密码

if IS_PRODUCTION and app.config['SECRET_KEY'] == 'dev-secret-key-for-local-testing':
    print("[WARNING] 安全警报: 在生产环境中使用默认的SECRET_KEY是不安全的！")
if not IS_PRODUCTION:
    print(f"[INFO] 开发环境登录密码是: {APP_PASSWORD}")

@app.before_request
def make_session_permanent():
    session.permanent = True
    app.permanent_session_lifetime = datetime.timedelta(days=7)

# V5.0: 登录逻辑
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 仅在生产环境中强制执行登录
        if IS_PRODUCTION and 'logged_in' not in session:
            # 将用户重定向到登录页面，并在URL中附带他们想访问的页面
            return redirect(url_for('login', next=request.url))
        return f(*args, **kwargs)
    return decorated_function

# V5.8: 新增混合认证系统 - 支持Web Session + Basic Auth
def require_api_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 在开发环境下，不强制认证（保持原有行为）
        if not IS_PRODUCTION:
            return f(*args, **kwargs)
        
        # 生产环境下检查认证
        # 方式1: 检查Web Session（保持向后兼容）
        if 'logged_in' in session:
            return f(*args, **kwargs)
        
        # 方式2: 检查Basic Auth（新增API友好方式）
        # 注意：用户名固定为'api'，密码从环境变量读取
        auth = request.authorization
        if auth and auth.username == 'api' and APP_PASSWORD and auth.password == APP_PASSWORD:
            return f(*args, **kwargs)
        
        # 如果都没有，返回401错误（API调用不重定向到登录页面）
        return jsonify({
            'error': 'Authentication required',
            'message': 'Please provide authentication via Web login or Basic Auth (username: api, password: from env)'
        }), 401
    
    return decorated_function

# --- Database Setup ---
def get_db():
    if IS_PRODUCTION: # V5.0: 使用IS_PRODUCTION
        # 生产环境 - PostgreSQL
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    else:
        # 开发环境 - SQLite
        conn = sqlite3.connect(DATABASE_PATH)
        conn.row_factory = sqlite3.Row  # 让结果可以像字典一样访问
    return conn

def db_execute(cursor, query, params=None):
    """智能执行数据库查询，自动处理SQLite和PostgreSQL的占位符差异"""
    # V5.0: 移除旧的USE_POSTGRESQL检查，逻辑简化
    if not IS_PRODUCTION and query and '%s' in query:
        # SQLite环境：将%s占位符替换为?
        query = query.replace('%s', '?')
    
    if params:
        return cursor.execute(query, params)
    else:
        return cursor.execute(query)

def save_algorithm_annotation(ticker, date, text, algorithm_type, algorithm_params=None):
    """保存算法生成的注释到数据库"""
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 生成唯一的注释ID
        annotation_id = f"algo-{ticker}-{date}-{algorithm_type}-{uuid.uuid4().hex[:8]}"
        
        # V4.8.1: 增强重复检查逻辑 - 优先检查是否已存在AI分析记录
        db_execute(cursor, """
            SELECT annotation_id, text, algorithm_type, is_deleted, is_favorite FROM annotations
            WHERE ticker = %s AND date = %s AND algorithm_type = 'ai_analysis' AND is_deleted = 0
        """, (ticker, date))
        
        ai_existing = cursor.fetchone()
        if ai_existing:
            # 如果已存在AI分析记录，不生成新的算法记录（AI分析优先级更高）
            print(f"[INFO] 跳过算法记录生成 {ticker}-{date}-{algorithm_type}：已存在AI分析记录 {ai_existing['annotation_id']}")
            cursor.close()
            db.close()
            return {'id': ai_existing['annotation_id'], 'text': ai_existing['text'], 'exists': True, 'type': 'ai_analysis', 'is_favorite': bool(ai_existing['is_favorite']) if ai_existing['is_favorite'] is not None else False}
        
        # 检查是否已存在相同的算法注释（同一股票、同一日期、同一算法类型）
        db_execute(cursor, """
            SELECT annotation_id, text, is_deleted, is_favorite FROM annotations
            WHERE ticker = %s AND date = %s AND algorithm_type = %s
        """, (ticker, date, algorithm_type))
        
        existing = cursor.fetchone()
        if existing:
            if existing['is_deleted'] == 0:
                # 如果存在未删除的注释，返回现有注释的ID和内容
                print(f"[INFO] 复用现有算法记录: {existing['annotation_id']}")
                cursor.close()
                db.close()
                return {'id': existing['annotation_id'], 'text': existing['text'], 'exists': True, 'is_favorite': bool(existing['is_favorite']) if existing['is_favorite'] is not None else False}
            else:
                # 如果存在已删除的注释，不创建新注释（保持删除状态）
                print(f"[INFO] 跳过已删除的记录: {ticker}-{date}-{algorithm_type}")
                cursor.close()
                db.close()
                return None
        
        # 保存新的算法注释
        params_json = json.dumps(algorithm_params) if algorithm_params else None
        db_execute(cursor, """
            INSERT INTO annotations
            (annotation_id, ticker, date, text, annotation_type, algorithm_type, algorithm_params, created_at, updated_at)
            VALUES (%s, %s, %s, %s, 'algorithm', %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """, (annotation_id, ticker, date, text, algorithm_type, params_json))
        
        db.commit()
        cursor.close()
        db.close()
        
        print(f"[INFO] 新建算法记录: {annotation_id} - {text}")
        return {'id': annotation_id, 'text': text, 'exists': False, 'is_favorite': False}
        
    except Exception as e:
        print(f"[ERROR] 保存算法注释失败: {e}")
        return None

def init_db():
    with app.app_context():
        conn = get_db()
        cursor = conn.cursor()
        
        if IS_PRODUCTION: # V5.0
            # PostgreSQL - 检查表是否存在
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'annotations'
                )
            """)
            result = cursor.fetchone()
            table_exists = result[0] if isinstance(result, (list, tuple)) else result['exists']
        else:
            # SQLite - 检查表是否存在
            cursor.execute("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='annotations'
            """)
            table_exists = cursor.fetchone() is not None
        
        if not table_exists:
            if IS_PRODUCTION: # V5.0
                # PostgreSQL语法
                cursor.execute('''
                    CREATE TABLE annotations (
                        id SERIAL PRIMARY KEY,
                        annotation_id TEXT NOT NULL UNIQUE,
                        ticker TEXT NOT NULL,
                        date TEXT NOT NULL,
                        text TEXT NOT NULL,
                        annotation_type TEXT NOT NULL DEFAULT 'manual',
                        algorithm_type TEXT,
                        algorithm_params TEXT,
                        original_text TEXT,
                        ai_analysis TEXT,
                        is_deleted INTEGER DEFAULT 0,
                        is_favorite INTEGER DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
            else:
                # SQLite语法
                cursor.execute('''
                    CREATE TABLE annotations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        annotation_id TEXT NOT NULL UNIQUE,
                        ticker TEXT NOT NULL,
                        date TEXT NOT NULL,
                        text TEXT NOT NULL,
                        annotation_type TEXT NOT NULL DEFAULT 'manual',
                        algorithm_type TEXT,
                        algorithm_params TEXT,
                        original_text TEXT,
                        ai_analysis TEXT,
                        is_deleted INTEGER DEFAULT 0,
                        is_favorite INTEGER DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        deleted_at TIMESTAMP NULL
                    )
            ''')
            print("✅ 创建了annotations表")
        else:
            print("📋 annotations表已存在")
            
            # 检查是否需要添加is_favorite字段
            if IS_PRODUCTION: # V5.0
                # PostgreSQL - 检查字段是否存在
                cursor.execute("""
                    SELECT column_name FROM information_schema.columns 
                    WHERE table_name = 'annotations' AND column_name = 'is_favorite'
                """)
                has_favorite_field = cursor.fetchone() is not None
            else:
                # SQLite - 检查字段是否存在
                cursor.execute("PRAGMA table_info(annotations)")
                columns = cursor.fetchall()
                has_favorite_field = any(col[1] == 'is_favorite' for col in columns)
            
            if not has_favorite_field:
                print("🔧 添加is_favorite字段...")
                if IS_PRODUCTION: # V5.0
                    cursor.execute("ALTER TABLE annotations ADD COLUMN is_favorite INTEGER DEFAULT 0")
                else:
                    cursor.execute("ALTER TABLE annotations ADD COLUMN is_favorite INTEGER DEFAULT 0")
                print("✅ is_favorite字段添加成功")
            else:
                print("📋 is_favorite字段已存在")
        
        # 检查company_names表是否已存在
        if IS_PRODUCTION: # V5.0
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'company_names'
                )
            """)
            result = cursor.fetchone()
            company_table_exists = result[0] if isinstance(result, (list, tuple)) else result['exists']
        else:
            cursor.execute("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='company_names'
            """)
            company_table_exists = cursor.fetchone() is not None
        
        if not company_table_exists:
            cursor.execute('''
                CREATE TABLE company_names (
                    ticker TEXT PRIMARY KEY,
                    company_name TEXT NOT NULL,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source TEXT DEFAULT 'api',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            print("✅ 创建了company_names表")
            
            # 将现有的本地映射数据插入到数据库中 (PostgreSQL语法)
            local_mappings = [
                ('ONC', '百济神州', 'local'),
                ('6160.hk', '百济神州', 'local'),
                ('6160.HK', '百济神州', 'local'),
                ('BGNE', '百济神州', 'local'),
                ('6855.hk', '亚盛医药', 'local'),
                ('6855.HK', '亚盛医药', 'local'),
                ('AAPL', '苹果公司', 'local'),
                ('TSLA', '特斯拉', 'local'),
                ('MSFT', '微软', 'local'),
                ('GOOGL', '谷歌', 'local'),
                ('AMZN', '亚马逊', 'local'),
                ('NVDA', '英伟达', 'local'),
                ('META', 'Meta Platforms', 'local'),
                ('0700.hk', '腾讯控股', 'local'),
                ('0700.HK', '腾讯控股', 'local'),
                ('9988.hk', '阿里巴巴', 'local'),
                ('9988.HK', '阿里巴巴', 'local'),
                ('3690.hk', '美团', 'local'),
                ('3690.HK', '美团', 'local'),
                ('2318.hk', '中国平安', 'local'),
                ('2318.HK', '中国平安', 'local'),
                ('0941.hk', '中国移动', 'local'),
                ('0941.HK', '中国移动', 'local'),
                ('1810.hk', '小米集团', 'local'),
                ('1810.HK', '小米集团', 'local'),
                ('9999.hk', '网易', 'local'),
                ('9999.HK', '网易', 'local'),
                ('0388.hk', '香港交易所', 'local'),
                ('0388.HK', '香港交易所', 'local'),
                ('0005.hk', '汇丰控股', 'local'),
                ('0005.HK', '汇丰控股', 'local'),
            ]
            
            # 根据数据库类型使用不同的插入语法
            for ticker, company_name, source in local_mappings:
                if IS_PRODUCTION: # V5.0
                    cursor.execute('''
                        INSERT INTO company_names (ticker, company_name, source)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (ticker) DO NOTHING
                    ''', (ticker, company_name, source))
                else:
                    cursor.execute('''
                        INSERT OR IGNORE INTO company_names (ticker, company_name, source)
                        VALUES (?, ?, ?)
                    ''', (ticker, company_name, source))
            print(f"📊 初始化了 {len(local_mappings)} 个本地公司名称映射")
        else:
            print("📋 company_names表已存在")
        
        conn.commit()
        cursor.close()
        conn.close()

# Initialize the database when the app starts
init_db()

# 启动时自动更新股票名单缓存
print("[INIT] 检查股票名单缓存状态...")
try:
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT COUNT(*) as count FROM company_names WHERE source = 'stock_list_local'")
    local_count = cursor.fetchone()['count']
    cursor.close()
    db.close()
    
    # 检查是否需要导入（少于1000条认为需要重新导入）
    if local_count < 1000:
        print(f"[INIT] 本地股票名单缓存不足（{local_count}条），开始自动导入...")
        update_stock_list_cache()
    else:
        print(f"[INIT] 本地股票名单缓存充足（{local_count}条），跳过导入")
        
except Exception as e:
    print(f"[ERROR] 检查股票名单缓存失败: {str(e)}")
    print("[INIT] 尝试强制导入股票名单...")
    try:
        update_stock_list_cache()
    except Exception as e2:
        print(f"[ERROR] 强制导入也失败: {str(e2)}")

# --- 股票代码智能识别与格式转换系统 ---

def normalize_ticker(user_input):
    """
    将用户输入标准化为内部格式
    支持：纯数字代码、带后缀代码、公司名称、美股代码
    返回：(标准化ticker, 识别类型)
    """
    if not user_input:
        return None, 'invalid'
    
    user_input = str(user_input).strip()
    print(f"[NORMALIZE] 处理用户输入: {user_input}")
    
    # 如果已经是标准格式，直接返回
    if '.' in user_input and user_input.count('.') == 1:
        code, suffix = user_input.split('.')
        suffix = suffix.upper()
        
        # 标准化后缀名
        if suffix in ['SH', 'SZ', 'HK']:
            return f"{code}.{suffix}", 'standard'
        elif suffix == 'SS':  # Yahoo格式转内部格式
            return f"{code}.SH", 'yahoo_format'
        else:
            return user_input.upper(), 'unknown'
    
    # Yahoo Finance 直通格式（如 ETH-USD, BTC-USD, EURUSD=X 等）
    # 这些代码直接传递给 Yahoo Finance API，无需转换
    if '-' in user_input or user_input.endswith('=X'):
        yahoo_ticker = user_input.upper()
        print(f"[NORMALIZE] 检测到Yahoo直通格式: {user_input} -> {yahoo_ticker}")
        return yahoo_ticker, 'yahoo_passthrough'
    
    # 纯英文字母代码识别为美股代码
    if user_input.isalpha() and user_input.isascii():
        us_ticker = user_input.upper()
        print(f"[NORMALIZE] 检测到美股代码: {user_input} -> {us_ticker}")
        return us_ticker, 'us_stock'
    
    # 纯数字代码智能识别（A股/港股）
    if user_input.isdigit():
        return identify_stock_by_code(user_input)
    
    # 可能是公司名称，进行反向查找
    return search_by_company_name(user_input)

def check_ticker_exists(ticker):
    """
    检查股票代码是否在数据库中存在
    返回：(是否存在, 公司名称, 数据来源)
    """
    try:
        db = get_db()  # get_db()已经设置了row_factory
        cursor = db.cursor()
        db_execute(cursor, "SELECT company_name, source FROM company_names WHERE ticker = %s", (ticker,))
        result = cursor.fetchone()
        cursor.close()
        db.close()
        
        if result:
            return True, result['company_name'], result['source']
        else:
            return False, None, None
            
    except Exception as e:
        print(f"[ERROR] 检查股票代码存在性失败: {str(e)}")
        return False, None, None

def identify_stock_by_code(code):
    """
    根据股票代码数字规律识别交易所（增强版 - 支持冲突检测）
    """
    original_code = code
    code = code.zfill(6)  # 补齐到6位
    print(f"[IDENTIFY] 识别股票代码: {original_code} -> {code}")
    
    # 候选列表：存储可能的格式
    candidates = []
    
    # A股代码规律识别
    if len(code) == 6:
        first_three = code[:3]
        
        # 上海交易所（沪市）
        if first_three in ['600', '601', '603', '605']:  # 沪市主板
            candidates.append((f"{code}.SH", 'sh_main'))
        elif first_three == '688':  # 科创板
            candidates.append((f"{code}.SH", 'sh_star'))
        elif first_three == '689':  # 科创板
            candidates.append((f"{code}.SH", 'sh_star'))
            
        # 深圳交易所（深市）
        elif first_three in ['000', '001']:  # 深市主板
            candidates.append((f"{code}.SZ", 'sz_main'))
        elif first_three == '002':  # 中小板
            candidates.append((f"{code}.SZ", 'sz_sme'))
        elif first_three == '300':  # 创业板
            candidates.append((f"{code}.SZ", 'sz_gem'))
    
    # 港股代码（优先原始长度）
    if len(original_code) <= 4:
        hk_code = original_code.zfill(4)  # 港股补齐到4位
        candidates.append((f"{hk_code}.HK", 'hk'))
    
    print(f"[IDENTIFY] 候选格式: {[c[0] for c in candidates]}")
    
    # 按优先级检查候选格式是否存在
    for ticker, market_type in candidates:
        exists, company_name, source = check_ticker_exists(ticker)
        if exists:
            print(f"[IDENTIFY] 找到匹配: {original_code} -> {ticker} ({company_name}) [来源: {source}]")
            return ticker, market_type
    
    # 如果都不存在，返回最可能的格式（A股优先）
    if candidates:
        fallback_ticker, fallback_type = candidates[0]
        print(f"[IDENTIFY] 无匹配数据，使用默认格式: {original_code} -> {fallback_ticker}")
        return fallback_ticker, fallback_type
    
    # 完全无法识别的代码，返回原值
    print(f"[WARNING] 无法识别的股票代码: {original_code}")
    return original_code, 'unknown'

def search_by_company_name(company_name):
    """
    根据公司名称反向查找股票代码（优化版 - 支持智能优先级选择）
    """
    print(f"[SEARCH] 搜索公司名称: {company_name}")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 精确匹配
        db_execute(cursor, "SELECT ticker FROM company_names WHERE company_name = %s", (company_name,))
        exact_match = cursor.fetchone()
        
        if exact_match:
            ticker = exact_match['ticker']
            print(f"[SEARCH] 精确匹配找到: {company_name} -> {ticker}")
            cursor.close()
            db.close()
            return ticker, 'company_name_exact'
        
        # 模糊匹配
        db_execute(cursor, "SELECT ticker, company_name FROM company_names WHERE company_name LIKE %s ORDER BY LENGTH(company_name) ASC", (f"%{company_name}%",))
        fuzzy_matches = cursor.fetchall()
        
        if fuzzy_matches:
            print(f"[SEARCH] 找到 {len(fuzzy_matches)} 个模糊匹配")
            
            if len(fuzzy_matches) == 1:
                ticker = fuzzy_matches[0]['ticker']
                matched_name = fuzzy_matches[0]['company_name']
                print(f"[SEARCH] 单个模糊匹配: {company_name} -> {ticker} ({matched_name})")
                cursor.close()
                db.close()
                return ticker, 'company_name_fuzzy'
            else:
                # 多个匹配时，智能选择优先级最高的
                print(f"[SEARCH] 多个匹配，应用智能优先级选择...")
                
                # 优先级：A股 > 港股 > 其他，且优先stock_list_local来源
                best_match = None
                best_priority = -1
                
                for match in fuzzy_matches:
                    ticker = match['ticker']
                    matched_name = match['company_name']
                    
                    # 计算优先级分数
                    priority = 0
                    
                    # 数据来源优先级
                    db_execute(cursor, "SELECT source FROM company_names WHERE ticker = %s", (ticker,))
                    source_result = cursor.fetchone()
                    source = source_result['source'] if source_result else 'unknown'
                    
                    if source == 'stock_list_local':
                        priority += 1000  # A股本地数据最高优先级
                    elif source in ['sina_hk', 'alpha_vantage']:
                        priority += 500   # API数据中等优先级
                    
                    # 交易所优先级
                    if ticker.endswith('.SZ') or ticker.endswith('.SH'):
                        priority += 100   # A股优先
                    elif ticker.endswith('.HK') or ticker.endswith('.hk'):
                        priority += 50    # 港股次之
                    
                    # 名称匹配度（越短越好，说明匹配度越高）
                    priority += max(0, 50 - len(matched_name))
                    
                    print(f"[SEARCH]   {ticker}: {matched_name} (优先级: {priority})")
                    
                    if priority > best_priority:
                        best_priority = priority
                        best_match = (ticker, matched_name)
                
                if best_match:
                    ticker, matched_name = best_match
                    print(f"[SEARCH] 智能选择最优匹配: {company_name} -> {ticker} ({matched_name})")
                    cursor.close()
                    db.close()
                    return ticker, 'company_name_smart_select'
                else:
                    print(f"[SEARCH] 无法确定最优匹配")
                    cursor.close()
                    db.close()
                    return None, 'company_name_multiple'
        
        cursor.close()
        db.close()
        print(f"[SEARCH] 未找到匹配的公司名称: {company_name}")
        return None, 'company_name_not_found'
        
    except Exception as e:
        print(f"[ERROR] 公司名称搜索失败: {str(e)}")
        return None, 'search_error'

def generate_smart_error_message(user_input, identification_type):
    """
    根据搜索失败原因生成智能错误提示
    """
    base_msg = f'无法识别的股票代码或公司名称: {user_input}'
    
    if identification_type == 'company_name_not_found':
        suggestions = [
            "💡 建议尝试：",
            "1. 使用股票代码替代公司名称（如：600000、AAPL、0700）",
            "2. 检查公司简称是否准确（如：中国平安、工商银行）",
            "3. 尝试使用英文名称（美股）或数字代码（A股/港股）"
        ]
        return base_msg + "\n\n" + "\n".join(suggestions)
    
    elif identification_type == 'search_error':
        return base_msg + "\n\n💡 建议：网络连接异常，请稍后重试或使用股票代码进行搜索"
    
    elif identification_type == 'company_name_multiple':
        return base_msg + "\n\n💡 建议：发现多个匹配结果，请使用更具体的公司名称或直接使用股票代码"
    
    elif user_input.isdigit() and len(user_input) >= 4:
        # 可能是股票代码但格式不对
        return base_msg + f"\n\n💡 建议：如果这是股票代码，请尝试标准格式（如：{user_input}.SH、{user_input}.SZ、{user_input}.HK）"
    
    else:
        return base_msg + "\n\n💡 支持格式：A股代码（600000）、美股代码（AAPL）、港股代码（0700）或公司简称"

def to_yahoo_format(ticker):
    """
    将内部标准格式转换为Yahoo Finance API格式
    内部格式: 600000.SH, 000001.SZ, 0700.HK
    Yahoo格式: 600000.SS, 000001.SZ, 0700.HK
    """
    if not ticker or '.' not in ticker:
        return ticker
    
    code, suffix = ticker.split('.')
    
    # 上海交易所：.SH -> .SS
    if suffix == 'SH':
        yahoo_ticker = f"{code}.SS"
        print(f"[FORMAT] 转换Yahoo格式: {ticker} -> {yahoo_ticker}")
        return yahoo_ticker
    
    # 深圳交易所和港股保持不变
    elif suffix in ['SZ', 'HK']:
        return ticker
    
    # 未知后缀保持原样
    else:
        return ticker

def to_display_format(ticker):
    """
    将ticker转换为用户友好的显示格式
    """
    if not ticker or '.' not in ticker:
        return ticker
    
    code, suffix = ticker.split('.')
    
    if suffix == 'SH':
        return f"{code}(沪市)"
    elif suffix == 'SZ':
        return f"{code}(深市)"
    elif suffix == 'HK':
        return f"{code}(港股)"
    else:
        return ticker

# --- 公司名称缓存管理函数 ---
def get_cached_company_name(ticker):
    """从数据库缓存中获取公司名称"""
    try:
        db = get_db()
        cursor = db.cursor()
        db_execute(cursor, "SELECT company_name, source FROM company_names WHERE ticker = %s", (ticker,))
        result = cursor.fetchone()
        cursor.close()
        db.close()
        
        if result:
            print(f"[CACHE] 从数据库获取公司名称: {ticker} -> {result['company_name']} (来源: {result['source']})")
            return result['company_name']
        return None
    except Exception as e:
        print(f"[ERROR] 查询缓存失败: {e}")
        return None

def save_company_name_to_cache(ticker, company_name, source='api'):
    """将公司名称保存到数据库缓存"""
    try:
        db = get_db()
        cursor = db.cursor()
        db_execute(cursor, '''
            INSERT OR REPLACE INTO company_names (ticker, company_name, source, last_updated)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
        ''', (ticker, company_name, source))
        db.commit()
        cursor.close()
        db.close()
        print(f"[CACHE] 保存公司名称到缓存: {ticker} -> {company_name} (来源: {source})")
        return True
    except Exception as e:
        print(f"[ERROR] 保存缓存失败: {e}")
        return False

# 添加浏览器 User-Agent，模拟浏览器请求
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def get_company_name(ticker):
    """获取股票代码对应的公司名称 - 多层级查询机制（容错增强版）"""
    print(f"[DEBUG] 开始获取公司名称: {ticker}")
    
    if not ticker:
        print("[WARNING] ticker为空，返回默认值")
        return "未知股票"
    
    # 判断是否为A股代码
    is_a_stock = (ticker.endswith('.SH') or ticker.endswith('.SZ'))
    
    if is_a_stock:
        print(f"[PRIORITY] 检测到A股代码，强制使用本地数据: {ticker}")
        
        # A股强制使用本地数据，不调用API
        cached_name = get_cached_company_name(ticker)
        if cached_name:
            print(f"[SUCCESS] A股本地数据: {ticker} -> {cached_name}")
            return cached_name
        
        # 如果本地数据不存在，尝试不同大小写格式
        ticker_variants = [ticker.upper(), ticker.lower()]
        for variant in ticker_variants:
            if variant != ticker:
                cached_name = get_cached_company_name(variant)
                if cached_name:
                    # 将结果也缓存到原始ticker下
                    save_company_name_to_cache(ticker, cached_name, 'cache_alias')
                    print(f"[SUCCESS] A股变体匹配: {ticker} -> {cached_name}")
                    return cached_name
        
        # A股找不到数据时，返回美化的代码显示，不调用API
        display_name = ticker
        if ticker.endswith('.SH'):
            display_name = f"{ticker.replace('.SH', '')}(沪市)"
        elif ticker.endswith('.SZ'):
            display_name = f"{ticker.replace('.SZ', '')}(深市)"
        
        print(f"[FALLBACK] A股本地数据缺失，使用美化显示: {ticker} -> {display_name}")
        save_company_name_to_cache(ticker, display_name, 'a_stock_fallback')
        return display_name
    
    else:
        print(f"[PRIORITY] 非A股代码，使用完整查询链: {ticker}")
        
        # 非A股：正常的多层级查询（本地缓存 → API调用）
        # 第一层：检查数据库缓存
        cached_name = get_cached_company_name(ticker)
        if cached_name:
            return cached_name
        
        # 第二层：尝试不同大小写格式的ticker
        ticker_variants = [ticker, ticker.upper(), ticker.lower()]
        for variant in ticker_variants:
            if variant != ticker:  # 避免重复查询
                cached_name = get_cached_company_name(variant)
                if cached_name:
                    # 将结果也缓存到原始ticker下
                    save_company_name_to_cache(ticker, cached_name, 'cache_alias')
                    return cached_name
        
        # 第三层：API调用（仅用于港股、美股等）
        api_result = fetch_company_name_from_api(ticker)
        if api_result:
            return api_result
        
        # 第四层：最终容错机制
        print(f"[WARNING] 无法获取公司名称，使用股票代码作为显示名称: {ticker}")
        
        # 尝试美化股票代码显示
        display_name = ticker
        
        # 为港股、美股代码添加标识
        if ticker.endswith('.hk') or ticker.endswith('.HK'):
            display_name = f"{ticker}(香港)"
        elif '-' in ticker:  # 加密货币/外汇对（如 ETH-USD, BTC-USD）
            display_name = f"{ticker}"
        elif '.' not in ticker and ticker.isalpha():  # 美股代码
            display_name = f"{ticker}(美股)"
        
        # 保存到缓存，避免重复查询
        save_company_name_to_cache(ticker, display_name, 'fallback')
        
        return display_name

def fetch_company_name_from_sina_hk(ticker):
    """从新浪财经API获取港股公司名称"""
    print(f"[API] 尝试从新浪财经API获取港股公司名称: {ticker}")
    
    try:
        # 港股代码格式：hk + 去掉.hk的代码
        code = ticker.replace('.hk', '').replace('.HK', '')
        sina_code = f"hk{code.zfill(5)}"  # 补齐到5位
        
        url = f"https://hq.sinajs.cn/list={sina_code}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://finance.sina.com.cn/'
        }
        
        response = requests.get(url, headers=headers, timeout=15)
        print(f"[API] 新浪财经港股 响应状态码: {response.status_code}")
        
        if response.status_code == 200 and response.text:
            # 解析新浪财经返回格式
            content = response.text
            if 'var hq_str_' in content:
                data_part = content.split('="')[1].split('";')[0]
                fields = data_part.split(',')
                if len(fields) > 1:
                    company_name = fields[1]  # 第二个字段通常是公司名称
                    print(f"[SUCCESS] 新浪财经获取到港股公司名称: {ticker} -> {company_name}")
                    save_company_name_to_cache(ticker, company_name, 'sina_hk')
                    return company_name
        
        print(f"[API] 新浪财经港股未找到匹配: {ticker}")
        
    except Exception as e:
        print(f"[ERROR] 新浪财经港股API调用失败: {str(e)}")
    
    return None

def fetch_company_name_from_api(ticker):
    """从多个API获取公司名称 - 带港股支持"""
    print(f"[API] 尝试从API获取公司名称: {ticker}")
    
    # 检查是否为港股代码
    is_hk_stock = ticker.lower().endswith('.hk')
    
    if is_hk_stock:
        # 对于港股，优先使用新浪财经API
        print(f"[API] 检测到港股代码，使用新浪财经API: {ticker}")
        hk_result = fetch_company_name_from_sina_hk(ticker)
        if hk_result:
            return hk_result
        print(f"[API] 新浪财经失败，尝试Alpha Vantage作为备选...")
    
    # Alpha Vantage API (美股主力 + 港股备选)
    alpha_vantage_key = "BT4ER0H28HOFCY3R"
    
    try:
        url = "https://www.alphavantage.co/query"
        params = {
            'function': 'SYMBOL_SEARCH',
            'keywords': ticker,
            'apikey': alpha_vantage_key
        }
        
        response = requests.get(url, params=params, headers=HEADERS, timeout=15)
        print(f"[API] Alpha Vantage 响应状态码: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            
            # 检查API限制
            if 'Note' in data:
                print(f"[API] Alpha Vantage API限制: {data['Note']}")
                return None
            
            if 'bestMatches' in data and len(data['bestMatches']) > 0:
                best_match = data['bestMatches'][0]
                company_name = best_match.get('2. name')
                match_symbol = best_match.get('1. symbol')
                region = best_match.get('4. region', '')
                match_score = best_match.get('9. matchScore', '0')
                
                print(f"[API] 找到匹配: {match_symbol} -> {company_name}")
                print(f"[API] 地区: {region}, 匹配度: {match_score}")
                
                if company_name and float(match_score) > 0.5:  # 只接受匹配度>0.5的结果
                    print(f"[SUCCESS] Alpha Vantage获取到公司名称: {ticker} -> {company_name}")
                    save_company_name_to_cache(ticker, company_name, 'alpha_vantage')
                    return company_name
                else:
                    print(f"[API] 匹配度过低或无公司名称，跳过")
            else:
                print(f"[API] Alpha Vantage未找到匹配: {ticker}")
        else:
            print(f"[API] Alpha Vantage请求失败: {response.status_code}")
            
    except Exception as e:
        print(f"[ERROR] Alpha Vantage API调用失败: {str(e)}")
    
    print(f"[WARNING] 所有API都无法获取公司名称: {ticker}")
    return None

# --- A股股票名单缓存系统 ---
def fetch_sz_stock_list():
    """从深圳交易所API获取股票名单"""
    print("[STOCK_LIST] 开始获取深圳交易所股票名单...")
    
    try:
        url = "http://api.biyingapi.com/hslt/list/biyinglicence"
        response = requests.get(url, headers=HEADERS, timeout=30)
        print(f"[STOCK_LIST] 深圳交易所API响应状态码: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, list):
                print(f"[STOCK_LIST] 成功获取深圳交易所股票数据，共 {len(data)} 条记录")
                return data
            else:
                print(f"[ERROR] 深圳交易所API返回数据格式异常: {type(data)}")
                return []
        else:
            print(f"[ERROR] 深圳交易所API请求失败: {response.status_code}")
            return []
            
    except Exception as e:
        print(f"[ERROR] 获取深圳交易所股票名单失败: {str(e)}")
        return []

def fetch_sh_stock_list():
    """从上海交易所相关API获取股票名单（待实现）"""
    print("[STOCK_LIST] 上海交易所股票名单获取功能待实现...")
    
    # TODO: 查找上海交易所的股票名单API
    # 可能的API来源：
    # 1. 同花顺API
    # 2. 东方财富API  
    # 3. 新浪财经API
    # 4. 其他金融数据源
    
    return []

def save_stock_list_to_cache(stock_data, exchange, data_version=None):
    """将股票名单批量保存到数据库缓存"""
    if not stock_data:
        print("[STOCK_LIST] 没有数据需要保存")
        return 0
        
    print(f"[STOCK_LIST] 开始保存 {exchange} 交易所股票名单，共 {len(stock_data)} 条记录...")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        saved_count = 0
        updated_count = 0
        
        for stock in stock_data:
            # 深圳交易所数据格式：{"dm": "000001.SZ", "mc": "平安银行", "jys": "SZ"}
            if exchange == 'SZ':
                ticker = stock.get('dm', '').strip()
                company_name = stock.get('mc', '').strip()
            else:
                # 其他交易所的数据格式待定
                continue
                
            if not ticker or not company_name:
                continue
                
            # 检查是否已存在
            db_execute(cursor, "SELECT ticker FROM company_names WHERE ticker = %s", (ticker,))
            existing = cursor.fetchone()
            
            if existing:
                # 更新现有记录
                cursor.execute('''
                    UPDATE company_names 
                    SET company_name = %s, source = %s, last_updated = CURRENT_TIMESTAMP
                    WHERE ticker = %s
                ''', (company_name, f'stock_list_{exchange.lower()}', ticker))
                updated_count += 1
            else:
                # 插入新记录
                cursor.execute('''
                    INSERT INTO company_names (ticker, company_name, source, last_updated)
                    VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                ''', (ticker, company_name, f'stock_list_{exchange.lower()}'))
                saved_count += 1
        
        db.commit()
        cursor.close()
        db.close()
        
        print(f"[STOCK_LIST] 保存完成 - 新增: {saved_count}, 更新: {updated_count}")
        return saved_count + updated_count
        
    except Exception as e:
        print(f"[ERROR] 保存股票名单到缓存失败: {str(e)}")
        return 0

def load_local_stock_list():
    """从本地文件加载A股股票名单"""
    print("[STOCK_LIST] 开始从本地文件加载A股股票名单...")
    
    try:
        # 本地文件路径
        local_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'A股公司证券代码和公司名称.md')
        
        if not os.path.exists(local_file):
            print(f"[ERROR] 本地股票名单文件不存在: {local_file}")
            return []
        
        with open(local_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        if isinstance(data, list):
            print(f"[STOCK_LIST] 成功读取本地股票名单，共 {len(data)} 条记录")
            return data
        else:
            print(f"[ERROR] 本地文件数据格式异常: {type(data)}")
            return []
            
    except Exception as e:
        print(f"[ERROR] 读取本地股票名单失败: {str(e)}")
        return []

def save_local_stock_list_to_cache(stock_data):
    """将本地股票名单批量保存到数据库缓存"""
    if not stock_data:
        print("[STOCK_LIST] 没有数据需要保存")
        return 0
        
    print(f"[STOCK_LIST] 开始批量保存A股股票名单，共 {len(stock_data)} 条记录...")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        saved_count = 0
        updated_count = 0
        
        for stock in stock_data:
            # 数据格式：{"dm": "000001.SZ", "mc": "平安银行", "jys": "SZ"}
            ticker = stock.get('dm', '').strip()
            company_name = stock.get('mc', '').strip()
            exchange = stock.get('jys', '').strip()
                
            if not ticker or not company_name:
                continue
                
            # 检查是否已存在
            db_execute(cursor, "SELECT ticker, source FROM company_names WHERE ticker = %s", (ticker,))
            existing = cursor.fetchone()
            
            if existing:
                # 只有当现有数据不是来自本地股票名单时才更新
                if existing['source'] != 'stock_list_local':
                    cursor.execute('''
                        UPDATE company_names 
                        SET company_name = %s, source = %s, last_updated = CURRENT_TIMESTAMP
                        WHERE ticker = %s
                    ''', (company_name, 'stock_list_local', ticker))
                    updated_count += 1
            else:
                # 插入新记录
                cursor.execute('''
                    INSERT INTO company_names (ticker, company_name, source, last_updated)
                    VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                ''', (ticker, company_name, 'stock_list_local'))
                saved_count += 1
        
        db.commit()
        cursor.close()
        db.close()
        
        print(f"[STOCK_LIST] 批量保存完成 - 新增: {saved_count}, 更新: {updated_count}")
        return saved_count + updated_count
        
    except Exception as e:
        print(f"[ERROR] 批量保存股票名单到缓存失败: {str(e)}")
        return 0

def update_stock_list_cache():
    """更新股票名单缓存 - 主入口函数"""
    print("[STOCK_LIST] ========== 开始更新股票名单缓存 ==========")
    
    total_saved = 0
    
    # 1. 优先加载本地完整A股数据
    local_data = load_local_stock_list()
    if local_data:
        local_count = save_local_stock_list_to_cache(local_data)
        total_saved += local_count
        print(f"[STOCK_LIST] 本地A股数据处理完成: {local_count} 条")
    
    # 2. 备用：获取深圳交易所数据（API方式）
    if not local_data:
        print("[STOCK_LIST] 本地数据不可用，尝试API方式...")
        sz_data = fetch_sz_stock_list()
        if sz_data:
            sz_count = save_stock_list_to_cache(sz_data, 'SZ')
            total_saved += sz_count
            print(f"[STOCK_LIST] 深圳交易所API数据处理完成: {sz_count} 条")
    
    print(f"[STOCK_LIST] ========== 股票名单缓存更新完成，总计: {total_saved} 条 ==========")
    return total_saved

def calculate_zig(series, threshold):
    if series.isnull().all():
        return [None] * len(series)

    # 找到第一个有效值作为起点
    first_valid_index = series.first_valid_index()
    if first_valid_index is None:
        return [None] * len(series)

    threshold = threshold / 100.0
    trend = 0  # 0: TBD, 1: up, -1: down
    last_pivot_price = series[first_valid_index]
    last_pivot_index = first_valid_index
    pivots = {last_pivot_index: last_pivot_price}

    for i in range(first_valid_index + 1, len(series)):
        current_price = series.iloc[i]
        if pd.isna(current_price):
            continue

        if trend == 0:
            if current_price / last_pivot_price > 1 + threshold:
                trend = 1
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i
            elif current_price / last_pivot_price < 1 - threshold:
                trend = -1
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i
        elif trend == 1:
            if current_price > last_pivot_price:
                pivots.pop(last_pivot_index)
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i
            elif current_price / last_pivot_price < 1 - threshold:
                trend = -1
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i
        elif trend == -1:
            if current_price < last_pivot_price:
                pivots.pop(last_pivot_index)
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i
            elif current_price / last_pivot_price > 1 + threshold:
                trend = 1
                pivots[i] = current_price
                last_pivot_price = current_price
                last_pivot_index = i

    zig_series = pd.Series([np.nan] * len(series), index=series.index)
    for index, value in pivots.items():
        zig_series.loc[index] = value

    # 关键修复：将所有NaN替换为None，以便正确转换为JSON的null
    return [None if pd.isna(x) else x for x in zig_series]

def calculate_phases_from_zig(zig_series, timestamps):
    import datetime as dt
    pivots = [(i, v) for i, v in enumerate(zig_series) if v is not None]
    if len(pivots) < 2:
        return []

    # 添加边界检查，确保所有pivot索引都在timestamps范围内
    max_index = len(timestamps) - 1
    valid_pivots = [(i, v) for i, v in pivots if i <= max_index]

    if len(valid_pivots) < 2:
        print(f"[WARNING] 有效pivot数量不足: {len(valid_pivots)}, timestamps长度: {len(timestamps)}")
        return []

    phases = []
    for i in range(len(valid_pivots) - 1):
        start_index, start_value = valid_pivots[i]
        end_index, end_value = valid_pivots[i+1]

        # 双重检查边界
        if start_index > max_index or end_index > max_index:
            print(f"[ERROR] 索引越界: start={start_index}, end={end_index}, max={max_index}")
            continue

        start_date = dt.datetime.fromtimestamp(timestamps[start_index]).strftime('%Y-%m-%d')
        end_date = dt.datetime.fromtimestamp(timestamps[end_index]).strftime('%Y-%m-%d')

        phase_type = 'Uptrend' if end_value > start_value else 'Downtrend'

        phases.append({
            'start_date': start_date,
            'end_date': end_date,
            'phase': phase_type
        })
    return phases


@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/test')
@login_required
def test():
    from flask import send_file
    return send_file('test_zig.html')

@app.route('/test-markarea')
@login_required
def test_markarea():
    from flask import send_file
    return send_file('test_markarea.html')

# V5.0: 新增登录/登出路由
@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        if request.form['password'] == APP_PASSWORD:
            session['logged_in'] = True
            session.permanent = True # 确保会话持久化
            next_url = request.args.get('next')
            print(f"[AUTH] 登录成功. 重定向到: {next_url or url_for('index')}")
            return redirect(next_url or url_for('index'))
        else:
            error = '密码错误，请重试'
            print("[AUTH] 登录失败: 密码无效")
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    print("[AUTH] 用户已登出.")
    return redirect(url_for('login'))


# --- V3.1: 新增API用于处理手动注释 ---
@app.route('/api/annotation', methods=['POST'])
@require_api_auth
def add_annotation():
    data = request.get_json()
    if not data or not all(k in data for k in ['ticker', 'date', 'text', 'id']):
        return jsonify({'error': 'Missing data'}), 400
    
    try:
        # 标准化ticker以确保一致性
        normalized_ticker, _ = normalize_ticker(data['ticker'])
        if not normalized_ticker:
            return jsonify({'error': 'Invalid ticker format'}), 400
        
        db = get_db()
        cursor = db.cursor()
        
        # 获取annotation_type，如果前端没有提供则使用默认值'manual'
        annotation_type = data.get('type', 'manual')
        
        # 获取AI分析相关的额外字段
        algorithm_type = data.get('algorithm_type')
        source_annotation_id = data.get('source_annotation_id')
        
        # 准备插入的数据
        insert_data = [normalized_ticker, data['date'], data['text'], data['id'], annotation_type]
        
        # 构建SQL语句，支持AI分析字段
        if algorithm_type:
            sql = """
                INSERT INTO annotations 
                (ticker, date, text, annotation_id, annotation_type, algorithm_type, created_at, updated_at) 
                VALUES (%s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """
            insert_data.append(algorithm_type)
        else:
            sql = """
                INSERT INTO annotations 
                (ticker, date, text, annotation_id, annotation_type, created_at, updated_at) 
                VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """
        
        db_execute(cursor, sql, insert_data)
        db.commit()
        
        # 记录AI分析日志
        if algorithm_type == 'ai_analysis':
            print(f"[AI分析] 保存成功: {data['id']} for {normalized_ticker} on {data['date']}")
            if source_annotation_id:
                print(f"[AI分析] 源注释ID: {source_annotation_id}")
        
        return jsonify({'success': True, 'message': 'Annotation added'}), 201
        
    except sqlite3.IntegrityError:
        # 如果 annotation_id 已存在，可能是一个客户端重试，可以认为是成功的
        return jsonify({'success': True, 'message': 'Annotation already exists'}), 200
    except Exception as e:
        print(f"[ERROR] 保存注释失败: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()

@app.route('/api/annotation/<string:annotation_id>', methods=['DELETE'])
@require_api_auth
def delete_annotation(annotation_id):
    # URL解码处理
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 删除注释API调用")
    print(f"[DEBUG] 原始annotation_id: '{annotation_id}'")
    print(f"[DEBUG] 解码后annotation_id: '{decoded_id}'")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 先检查记录是否存在且未删除 - 同时用原始ID和解码ID进行查询
        db_execute(cursor, """
            SELECT annotation_id, annotation_type FROM annotations 
            WHERE (annotation_id = %s OR annotation_id = %s) AND is_deleted = 0
        """, (annotation_id, decoded_id))
        existing = cursor.fetchone()
        print(f"[DEBUG] 查询现有记录: {existing}")
        
        if not existing:
            print(f"[ERROR] 注释未找到或已删除")
            return jsonify({'error': 'Annotation not found'}), 404
        
        # 使用查询到的实际ID进行软删除
        actual_id = existing['annotation_id']
        print(f"[DEBUG] 使用实际ID进行软删除: '{actual_id}'")
        
        # 软删除：设置 is_deleted = 1 和 deleted_at 时间戳
        db_execute(cursor, """
            UPDATE annotations 
            SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE annotation_id = %s
        """, (actual_id,))
        db.commit()
        
        print(f"[DEBUG] 软删除成功: {cursor.rowcount} 行受影响")
        
        if cursor.rowcount == 0:
            return jsonify({'error': 'Annotation not found'}), 404
        
        return jsonify({'success': True, 'message': 'Annotation moved to recycle bin'}), 200
    except Exception as e:
        print(f"[ERROR] 数据库操作异常: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()

@app.route('/api/annotations/favorite/<string:annotation_id>', methods=['POST'])
@require_api_auth
def mark_annotation_favorite(annotation_id):
    """标记注释为重点"""
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 标记重点注释API调用: '{decoded_id}'")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 查找并更新注释
        db_execute(cursor, """
            UPDATE annotations 
            SET is_favorite = 1, updated_at = CURRENT_TIMESTAMP
            WHERE (annotation_id = %s OR annotation_id = %s) AND is_deleted = 0
        """, (annotation_id, decoded_id))
        
        if cursor.rowcount == 0:
            return jsonify({'error': 'Annotation not found or already deleted'}), 404
        
        db.commit()
        print(f"[DEBUG] 注释标记为重点成功: {cursor.rowcount} 行受影响")
        
        return jsonify({'success': True, 'message': 'Annotation marked as favorite'}), 200
    except Exception as e:
        print(f"[ERROR] 标记重点注释失败: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()

@app.route('/api/annotations/favorite/<string:annotation_id>', methods=['DELETE'])
@require_api_auth
def unmark_annotation_favorite(annotation_id):
    """取消注释重点标记"""
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 取消重点标记API调用: '{decoded_id}'")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 查找并更新注释
        db_execute(cursor, """
            UPDATE annotations 
            SET is_favorite = 0, updated_at = CURRENT_TIMESTAMP
            WHERE (annotation_id = %s OR annotation_id = %s) AND is_deleted = 0
        """, (annotation_id, decoded_id))
        
        if cursor.rowcount == 0:
            return jsonify({'error': 'Annotation not found or already deleted'}), 404
        
        db.commit()
        print(f"[DEBUG] 注释取消重点标记成功: {cursor.rowcount} 行受影响")
        
        return jsonify({'success': True, 'message': 'Annotation unmarked as favorite'}), 200
    except Exception as e:
        print(f"[ERROR] 取消重点标记失败: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()

@app.route('/api/annotation/<string:annotation_id>', methods=['PUT'])
@require_api_auth
def update_annotation(annotation_id):
    # URL解码处理
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 编辑注释API调用")
    print(f"[DEBUG] 原始annotation_id: '{annotation_id}'")
    print(f"[DEBUG] 解码后annotation_id: '{decoded_id}'")
    
    data = request.get_json()
    print(f"[DEBUG] 接收到的数据: {data}")
    
    if not data or not all(k in data for k in ['date', 'text']):
        print(f"[ERROR] 缺少必要的数据字段")
        return jsonify({'error': 'Missing date or text'}), 400
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 先检查记录是否存在 - 同时用原始ID和解码ID进行查询
        db_execute(cursor, "SELECT * FROM annotations WHERE annotation_id = %s OR annotation_id = %s", 
                      (annotation_id, decoded_id))
        existing = cursor.fetchone()
        print(f"[DEBUG] 查询现有记录: {existing}")
        
        if not existing:
            print(f"[ERROR] 注释未找到")
            print(f"[ERROR] 尝试的ID: '{annotation_id}' 和 '{decoded_id}'")
            return jsonify({'error': 'Annotation not found'}), 404
        
        # 使用查询到的实际ID进行更新
        actual_id = existing['annotation_id']
        print(f"[DEBUG] 使用实际ID进行更新: '{actual_id}'")
        
        # 更新记录，同时更新时间戳
        db_execute(cursor,
            "UPDATE annotations SET date = %s, text = %s, updated_at = CURRENT_TIMESTAMP WHERE annotation_id = %s",
            (data['date'], data['text'], actual_id)
        )
        db.commit()
        
        print(f"[DEBUG] 更新成功: {cursor.rowcount} 行受影响")
        
        if cursor.rowcount == 0:
            print(f"[ERROR] 更新失败: 没有行受影响")
            return jsonify({'error': 'Update failed: no rows affected'}), 404
        
        print(f"[SUCCESS] 注释更新成功")
        return jsonify({'success': True, 'message': 'Annotation updated'}), 200
    except Exception as e:
        print(f"[ERROR] 数据库操作异常: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()


# --- V4.7: AI分析内容分离存储API ---
@app.route('/api/annotation/<string:annotation_id>/ai-analysis', methods=['PUT'])
@require_api_auth
def update_annotation_ai_analysis(annotation_id):
    """更新注释的AI分析内容，分离存储原始内容和AI分析"""
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[AI分析] 更新AI分析内容API调用")
    print(f"[AI分析] 原始annotation_id: '{annotation_id}'")
    print(f"[AI分析] 解码后annotation_id: '{decoded_id}'")
    
    data = request.get_json()
    print(f"[AI分析] 接收到的数据: {data}")
    
    # 增强数据验证
    if not data:
        print(f"[ERROR] 请求体为空")
        return jsonify({'error': 'Request body is empty'}), 400
        
    if 'ai_analysis' not in data:
        print(f"[ERROR] 缺少AI分析数据字段")
        return jsonify({'error': 'Missing ai_analysis field'}), 400
    
    ai_content = data['ai_analysis']
    if not ai_content or not isinstance(ai_content, str):
        print(f"[ERROR] AI分析内容为空或格式无效")
        return jsonify({'error': 'AI analysis content is empty or invalid'}), 400
    
    # 内容长度验证
    if len(ai_content.strip()) < 10:
        print(f"[ERROR] AI分析内容过短: {len(ai_content)} 字符")
        return jsonify({'error': 'AI analysis content too short'}), 400
    
    if len(ai_content) > 100000:  # 100KB 限制
        print(f"[WARNING] AI分析内容较长: {len(ai_content)} 字符")
        ai_content = ai_content[:100000] + "...[内容已截断]"
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 先检查记录是否存在
        db_execute(cursor, "SELECT * FROM annotations WHERE annotation_id = %s OR annotation_id = %s", 
                      (annotation_id, decoded_id))
        existing = cursor.fetchone()
        
        if not existing:
            print(f"[ERROR] 注释未找到: {annotation_id}")
            return jsonify({'error': f'Annotation not found: {annotation_id}'}), 404
        
        # 使用查询到的实际ID
        actual_id = existing['annotation_id']
        print(f"[AI分析] 找到记录，使用实际ID: '{actual_id}'")
        print(f"[AI分析] 原始文本存在: {bool(existing['original_text'])}")
        print(f"[AI分析] AI分析存在: {bool(existing['ai_analysis'])}")
        
        # 如果是第一次添加AI分析，需要保存原始文本
        if not existing['original_text']:
            # 保存原始文本
            original_text = existing['text'] or ""
            print(f"[AI分析] 首次添加AI分析，保存原始文本: {len(original_text)} 字符")
            
            # 构建合并文本：AI分析在前，算法内容在后
            combined_text = f"{ai_content}\n\n{original_text}"
            
            db_execute(cursor, """
                UPDATE annotations 
                SET original_text = %s, ai_analysis = %s, text = %s, 
                    algorithm_type = 'ai_analysis', updated_at = CURRENT_TIMESTAMP 
                WHERE annotation_id = %s
            """, (original_text, ai_content, combined_text, actual_id))
        else:
            # 如果已有AI分析，只更新AI分析内容
            print(f"[AI分析] 更新现有AI分析内容")
            original_text = existing['original_text'] or ""
            combined_text = f"{ai_content}\n\n{original_text}"
            
            db_execute(cursor, """
                UPDATE annotations 
                SET ai_analysis = %s, text = %s, updated_at = CURRENT_TIMESTAMP 
                WHERE annotation_id = %s
            """, (ai_content, combined_text, actual_id))
        
        db.commit()
        
        print(f"[AI分析] 数据库更新成功: {cursor.rowcount} 行受影响")
        print(f"[AI分析] 合并后文本长度: {len(combined_text)} 字符")
        
        if cursor.rowcount == 0:
            print(f"[ERROR] AI分析更新失败: 没有行受影响")
            return jsonify({'error': 'No rows were updated'}), 500
        
        print(f"[SUCCESS] AI分析内容更新成功")
        return jsonify({
            'success': True, 
            'message': 'AI analysis updated successfully',
            'annotation_id': actual_id,
            'content_length': len(ai_content),
            'combined_length': len(combined_text)
        }), 200
        
    except sqlite3.Error as e:
        print(f"[ERROR] 数据库操作失败: {str(e)}")
        return jsonify({'error': f'Database error: {str(e)}'}), 500
    except Exception as e:
        print(f"[ERROR] AI分析API异常: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Internal server error: {str(e)}'}), 500
    finally:
        if 'db' in locals() and db:
            db.close()


# --- V5.8: AI分析后端代理API ---
@app.route('/api/ai/dify-run', methods=['POST'])
@require_api_auth
def dify_proxy_api():
    """后端代理Dify AI工作流，解决CORS和安全问题"""
    import requests
    import time
    import logging
    
    # 设置日志
    log_file = os.path.join('logs', 'ai_analysis.log')
    os.makedirs('logs', exist_ok=True)
    
    # 配置日志格式
    logging.basicConfig(
        filename=log_file,
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        filemode='a'
    )
    
    try:
        start_time = time.time()
        data = request.get_json()
        
        # 验证请求数据
        if not data or 'input' not in data:
            logging.error("Dify代理调用失败: 缺少input参数")
            return jsonify({'error': 'Missing input parameter'}), 400
        
        input_text = data['input']
        if not input_text or not isinstance(input_text, str):
            logging.error("Dify代理调用失败: input参数无效")
            return jsonify({'error': 'Invalid input parameter'}), 400

        # 从环境变量获取Dify API token（仅生产环境需要）
        dify_token = os.environ.get('DIFY_API_TOKEN')
        if not dify_token:
            logging.error("Dify API Token未配置，请设置DIFY_API_TOKEN环境变量")
            return jsonify({'error': 'DIFY_API_TOKEN not configured'}), 500

        # 记录调用信息
        annotation_id = data.get('annotation_id', 'unknown')
        ticker = data.get('ticker', 'unknown')
        date = data.get('date', 'unknown')

        # V5.8: 获取AI模式，默认为pro
        ai_mode = data.get('ai_mode', 'pro')  # flash/pro/ultra
        
        print(f"[Dify代理] 开始处理: annotation_id={annotation_id}, ticker={ticker}, date={date}, ai_mode={ai_mode}")
        print(f"[Dify代理] 输入长度: {len(input_text)} 字符")

        # V5.8: 直接构建新API格式的参数，不再需要获取参数配置
        inputs = {
            "Content": input_text,  # 新API使用Content参数
            "model": ai_mode        # 新增model参数
        }

        print(f"[Dify代理] 构建输入参数: {list(inputs.keys())}, model={ai_mode}")
        
        # 第二步：调用工作流，使用600秒超时
        try:
            workflow_response = requests.post(
                'https://work.pgi.chat/v1/workflows/run',
                headers={
                    'Authorization': f'Bearer {dify_token}',
                    'Content-Type': 'application/json'
                },
                json={
                    'inputs': inputs,
                    'response_mode': 'blocking',
                    'user': 'stock-analysis-system'
                },
                timeout=600  # 600秒超时
            )
            
            if not workflow_response.ok:
                try:
                    error_data = workflow_response.json()
                    error_msg = error_data.get('message', '工作流调用失败')
                except:
                    error_msg = f"工作流调用失败: HTTP {workflow_response.status_code}"
                
                logging.error(f"Dify工作流失败 annotation_id={annotation_id} error={error_msg}")
                return jsonify({'error': error_msg}), 500
            
            result = workflow_response.json()
            
            # V5.7.5: 智能验证结果 - 支持partial-succeeded状态
            data = result.get('data', {})
            status = data.get('status', '')
            outputs = data.get('outputs', {})

            # 检查是否为有效的成功状态
            valid_success_statuses = ['succeeded', 'partial-succeeded']
            if not data or status not in valid_success_statuses:
                error_msg = f"工作流执行失败或未成功完成，状态: {status}"
                logging.error(f"Dify工作流状态异常 annotation_id={annotation_id} status={status}")
                return jsonify({'error': error_msg}), 500

            # 即使是partial-succeeded，也要确保有有效输出
            if not outputs:
                error_msg = f"工作流状态为{status}但返回空结果"
                logging.error(f"Dify工作流空结果 annotation_id={annotation_id} status={status}")
                return jsonify({'error': error_msg}), 500

            # 如果是partial-succeeded，记录但继续处理
            if status == 'partial-succeeded':
                logging.warning(f"Dify工作流部分成功 annotation_id={annotation_id}，但有有效输出，继续处理")
            
            # 计算耗时
            duration = time.time() - start_time
            
            # 记录成功日志
            logging.info(f"Dify分析成功 annotation_id={annotation_id} ticker={ticker} date={date} input_length={len(input_text)} duration={duration:.2f}s")
            print(f"[Dify代理] 分析成功，耗时: {duration:.2f}秒")
            
            return jsonify({
                'success': True,
                'data': outputs,
                'duration': duration,
                'input_length': len(input_text)
            }), 200
            
        except requests.exceptions.Timeout:
            error_msg = "AI分析超时(600秒)，请稍后重试"
            logging.error(f"Dify分析超时 annotation_id={annotation_id} ticker={ticker} date={date}")
            return jsonify({'error': error_msg}), 408
            
        except requests.exceptions.RequestException as e:
            error_msg = f"网络请求失败: {str(e)}"
            logging.error(f"Dify网络错误 annotation_id={annotation_id} error={error_msg}")
            return jsonify({'error': error_msg}), 500
        
    except Exception as e:
        error_msg = f"服务器内部错误: {str(e)}"
        logging.error(f"Dify代理异常 error={error_msg}")
        print(f"[ERROR] Dify代理API异常: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': error_msg}), 500


# --- V5.8: 异步AI分析任务管理 ---
import threading
import uuid
import datetime as dt

# 内存中的任务状态存储 (生产环境可以使用Redis)
ai_tasks = {}
task_lock = threading.Lock()

def cleanup_old_tasks():
    """清理24小时前的旧任务"""
    cutoff_time = dt.datetime.now() - dt.timedelta(hours=24)
    with task_lock:
        expired_tasks = [task_id for task_id, task in ai_tasks.items() 
                        if task.get('created_at', dt.datetime.now()) < cutoff_time]
        for task_id in expired_tasks:
            del ai_tasks[task_id]
    
def background_ai_analysis(task_id, annotation_id, input_text, ticker, date, ai_mode='pro'):
    """后台执行AI分析的函数 (V5.8: 添加AI模式支持)"""
    # 配置日志记录器
    log_file = os.path.join('logs', 'ai_analysis.log')
    os.makedirs('logs', exist_ok=True)
    import logging

    # 创建独立的logger避免冲突
    logger = logging.getLogger(f'ai_analysis_{task_id}')
    logger.setLevel(logging.INFO)

    # 避免重复添加handler
    if not logger.handlers:
        handler = logging.FileHandler(log_file, mode='a')
        formatter = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    try:
        logger.info(f"[ASYNC-{task_id}] 开始异步AI分析: annotation_id={annotation_id}, ticker={ticker}, date={date}, input_length={len(input_text)}, ai_mode={ai_mode}")

        # 更新任务状态为处理中
        with task_lock:
            if task_id in ai_tasks:
                ai_tasks[task_id]['status'] = 'processing'
                ai_tasks[task_id]['updated_at'] = dt.datetime.now()
                logger.info(f"[ASYNC-{task_id}] 任务状态已更新为 processing")

        # 执行原有的Dify调用逻辑
        import requests
        import time
        from requests.exceptions import ConnectTimeout, ReadTimeout, Timeout

        start_time = time.time()

        # 从环境变量获取Dify API token
        dify_token = os.environ.get('DIFY_API_TOKEN')
        if not dify_token:
            logger.error(f"[ASYNC-{task_id}] Dify API Token未配置")
            with task_lock:
                ai_tasks[task_id]['status'] = 'failed'
                ai_tasks[task_id]['error'] = 'DIFY_API_TOKEN not configured'
            return
        logger.info(f"[ASYNC-{task_id}] 使用 Dify API Token: {dify_token[:10]}...")

        # V5.8: 直接构建新API格式的参数，不再需要获取参数配置
        inputs = {
            "Content": input_text,  # 新API使用Content参数
            "model": ai_mode        # 新增model参数
        }

        logger.info(f"[ASYNC-{task_id}] 构建输入参数: {list(inputs.keys())}, model={ai_mode}")

        # 第二步：调用工作流
        logger.info(f"[ASYNC-{task_id}] 步骤2: 开始调用Dify工作流")

        # 更新任务状态 - 加一个调用中的状态
        with task_lock:
            if task_id in ai_tasks:
                ai_tasks[task_id]['progress'] = 'calling_dify_api'
                ai_tasks[task_id]['updated_at'] = dt.datetime.now()

        try:
            workflow_response = requests.post(
                'https://work.pgi.chat/v1/workflows/run',
                headers={
                    'Authorization': f'Bearer {dify_token}',
                    'Content-Type': 'application/json'
                },
                json={
                    'inputs': inputs,
                    'response_mode': 'blocking',
                    'user': 'stock-analysis-system'
                },
                timeout=600  # 600秒超时
            )

            logger.info(f"[ASYNC-{task_id}] 步骤2: 工作流调用完成，状态码: {workflow_response.status_code}")

            # V5.7.3: 智能504错误处理 - Dify网关超时但可能已完成处理
            if workflow_response.status_code == 504:
                logger.warning(f"[ASYNC-{task_id}] 步骤2: 收到504网关超时，Dify可能已完成处理，启动智能重试")

                # 先尝试解析当前响应
                try:
                    result = workflow_response.json()
                    if result.get('data') and result['data'].get('status') == 'succeeded':
                        logger.info(f"[ASYNC-{task_id}] 步骤2: 504状态但响应包含成功结果，直接使用")
                    else:
                        raise ValueError("504响应无有效结果")
                except (json.JSONDecodeError, ValueError):
                    # 智能重试机制：用更简单的请求检查Dify是否已完成
                    logger.info(f"[ASYNC-{task_id}] 步骤2: 504响应无法解析，启动智能重试机制")

                    max_retries = 3
                    retry_success = False

                    for retry_count in range(max_retries):
                        wait_time = 3 + retry_count * 2  # 3, 5, 7秒递增等待
                        logger.info(f"[ASYNC-{task_id}] 步骤2: 智能重试 {retry_count + 1}/{max_retries}，等待{wait_time}秒...")
                        time.sleep(wait_time)

                        try:
                            # 使用相同参数但更短超时重试
                            retry_response = requests.post(
                                'https://work.pgi.chat/v1/workflows/run',
                                headers={
                                    'Authorization': f'Bearer {dify_token}',
                                    'Content-Type': 'application/json'
                                },
                                json={
                                    'inputs': inputs,
                                    'response_mode': 'blocking',
                                    'user': 'stock-analysis-system'
                                },
                                timeout=60  # 短超时，如果已完成应该很快响应
                            )

                            logger.info(f"[ASYNC-{task_id}] 步骤2: 重试响应状态码: {retry_response.status_code}")

                            if retry_response.status_code == 200:
                                logger.info(f"[ASYNC-{task_id}] 步骤2: 🎉 智能重试成功!")
                                workflow_response = retry_response
                                retry_success = True
                                break
                            elif retry_response.status_code != 504:
                                # 非504错误，说明有其他问题，停止重试
                                logger.warning(f"[ASYNC-{task_id}] 步骤2: 重试遇到新错误 {retry_response.status_code}，停止重试")
                                workflow_response = retry_response
                                break

                        except Exception as retry_error:
                            logger.warning(f"[ASYNC-{task_id}] 步骤2: 重试 {retry_count + 1} 异常: {str(retry_error)[:100]}")

                    # 如果所有重试都失败了
                    if not retry_success and workflow_response.status_code == 504:
                        logger.error(f"[ASYNC-{task_id}] 步骤2: 所有智能重试均失败，判定为真正的超时失败")
                        raise Exception(f"Dify API网关超时 (已重试{max_retries}次): 请求可能过于复杂或服务繁忙")

            elif not workflow_response.ok:
                try:
                    error_data = workflow_response.json()
                    error_msg = error_data.get('message', '工作流调用失败')
                except:
                    error_msg = f"工作流调用失败: HTTP {workflow_response.status_code}"
                raise Exception(error_msg)
            else:
                result = workflow_response.json()

        except (ConnectTimeout, ReadTimeout, Timeout) as timeout_error:
            logger.error(f"[ASYNC-{task_id}] 步骤2: Dify API调用超时: {str(timeout_error)}")
            # 对于超时错误，我们先等待一小段时间，然后尝试通过其他方式确认是否成功
            logger.info(f"[ASYNC-{task_id}] 步骤2: 超时后等待5秒，然后标记为失败")
            time.sleep(5)
            raise Exception(f"Dify API调用超时: {str(timeout_error)}")

        logger.info(f"[ASYNC-{task_id}] 步骤2: 开始验证工作流结果")

        # V5.7.5: 智能验证结果 - 支持partial-succeeded状态
        data = result.get('data', {})
        status = data.get('status', '')
        outputs = data.get('outputs', {})

        # 检查是否为有效的成功状态
        valid_success_statuses = ['succeeded', 'partial-succeeded']
        if not data or status not in valid_success_statuses:
            error_msg = f"工作流执行失败或未成功完成: status={status}, data={data}"
            logger.error(f"[ASYNC-{task_id}] 步骤2: {error_msg}")
            raise Exception(error_msg)

        # 即使是partial-succeeded，也要确保有有效输出
        if not outputs:
            error_msg = f"工作流状态为{status}但返回空结果"
            logger.error(f"[ASYNC-{task_id}] 步骤2: {error_msg}")
            raise Exception(error_msg)

        # 如果是partial-succeeded，记录但继续处理
        if status == 'partial-succeeded':
            logger.warning(f"[ASYNC-{task_id}] 步骤2: Dify工作流部分成功，但有有效输出，继续处理")
        else:
            logger.info(f"[ASYNC-{task_id}] 步骤2: Dify工作流完全成功")

        duration = time.time() - start_time
        logger.info(f"[ASYNC-{task_id}] 步骤3: Dify分析成功完成，耗时: {duration:.2f}秒，结果长度: {len(str(outputs))}")

        # 更新任务状态为成功
        logger.info(f"[ASYNC-{task_id}] 步骤4: 开始更新任务状态为completed")
        with task_lock:
            if task_id in ai_tasks:
                ai_tasks[task_id].update({
                    'status': 'completed',
                    'result': outputs,
                    'duration': duration,
                    'updated_at': dt.datetime.now(),
                    'progress': 'completed'
                })
                logger.info(f"[ASYNC-{task_id}] 步骤4: 任务状态更新成功，status=completed")
            else:
                logger.error(f"[ASYNC-{task_id}] 步骤4: 警告 - 任务ID在ai_tasks中不存在")

        logger.info(f"[ASYNC-{task_id}] 异步AI分析完全成功: annotation_id={annotation_id}, ticker={ticker}, date={date}, duration={duration:.2f}s")

    except Exception as e:
        error_msg = str(e)
        error_type = type(e).__name__
        logger.error(f"[ASYNC-{task_id}] 异步AI分析失败: error_type={error_type}, error={error_msg}")
        print(f"[后台AI分析] 任务 {task_id} 失败: {error_msg}")

        # 更新任务状态为失败
        with task_lock:
            if task_id in ai_tasks:
                ai_tasks[task_id].update({
                    'status': 'failed',
                    'error': error_msg,
                    'error_type': error_type,
                    'updated_at': dt.datetime.now(),
                    'progress': 'failed'
                })
                logger.info(f"[ASYNC-{task_id}] 任务状态已更新为failed")
            else:
                logger.error(f"[ASYNC-{task_id}] 警告 - 无法更新任务状态，任务ID不存在")

@app.route('/api/ai/dify-async', methods=['POST'])
@require_api_auth  
def dify_async_start():
    """启动异步AI分析任务"""
    try:
        data = request.get_json()
        
        # 验证请求数据
        if not data or 'input' not in data:
            return jsonify({'error': 'Missing input parameter'}), 400
        
        input_text = data['input']
        if not input_text or not isinstance(input_text, str):
            return jsonify({'error': 'Invalid input parameter'}), 400
        
        # 获取上下文信息
        annotation_id = data.get('annotation_id', 'unknown')
        ticker = data.get('ticker', 'unknown')
        date = data.get('date', 'unknown')

        # V5.8: 获取AI模式，默认为pro
        ai_mode = data.get('ai_mode', 'pro')  # flash/pro/ultra
        
        # 生成唯一任务ID
        task_id = str(uuid.uuid4())
        
        # 创建任务记录
        with task_lock:
            ai_tasks[task_id] = {
                'annotation_id': annotation_id,
                'ticker': ticker,
                'date': date,
                'status': 'pending',
                'created_at': dt.datetime.now(),
                'updated_at': dt.datetime.now(),
                'input_length': len(input_text)
            }
        
        # 启动后台线程处理AI分析
        thread = threading.Thread(
            target=background_ai_analysis,
            args=(task_id, annotation_id, input_text, ticker, date, ai_mode)
        )
        thread.daemon = True
        thread.start()

        print(f"[异步AI分析] 任务 {task_id} 已启动: annotation_id={annotation_id}, ticker={ticker}, ai_mode={ai_mode}")
        
        return jsonify({
            'success': True,
            'task_id': task_id,
            'status': 'pending',
            'message': 'AI分析任务已启动'
        }), 200
        
    except Exception as e:
        error_msg = f"启动异步任务失败: {str(e)}"
        print(f"[ERROR] {error_msg}")
        return jsonify({'error': error_msg}), 500

@app.route('/api/ai/task/<string:task_id>', methods=['GET'])
@require_api_auth
def get_ai_task_status(task_id):
    """获取AI分析任务状态"""
    try:
        # 清理旧任务
        cleanup_old_tasks()

        with task_lock:
            if task_id not in ai_tasks:
                return jsonify({'error': 'Task not found'}), 404

            task = ai_tasks[task_id].copy()

        # 转换datetime对象为字符串
        task['created_at'] = task['created_at'].isoformat()
        task['updated_at'] = task['updated_at'].isoformat()

        # 计算任务运行时间
        created_time = dt.datetime.fromisoformat(task['created_at'])
        current_time = dt.datetime.now()
        running_time = (current_time - created_time).total_seconds()
        task['running_time'] = round(running_time, 2)

        # 添加状态描述
        status_descriptions = {
            'pending': '任务已创建，等待开始',
            'processing': '正在分析中...',
            'completed': 'AI分析已完成',
            'failed': 'AI分析失败'
        }

        progress_descriptions = {
            'calling_dify_api': '正在调用Dify API...',
            'completed': '分析完成',
            'failed': '分析失败'
        }

        task['status_description'] = status_descriptions.get(task['status'], task['status'])
        if 'progress' in task:
            task['progress_description'] = progress_descriptions.get(task['progress'], task['progress'])

        # 添加调试信息（仅在非生产环境）
        if not os.environ.get('DATABASE_URL'):  # 本地开发环境
            task['debug_info'] = {
                'task_exists_in_memory': True,
                'task_keys': list(task.keys()),
                'total_tasks_in_memory': len(ai_tasks)
            }

        return jsonify({
            'success': True,
            'task_id': task_id,
            'task': task
        }), 200

    except Exception as e:
        error_msg = f"获取任务状态失败: {str(e)}"
        print(f"[ERROR] {error_msg}")
        return jsonify({'error': error_msg}), 500

@app.route('/api/ai/tasks/status', methods=['GET'])
@require_api_auth
def get_all_tasks_status():
    """获取所有AI分析任务的状态概览"""
    try:
        cleanup_old_tasks()

        with task_lock:
            all_tasks = {}
            for task_id, task in ai_tasks.items():
                task_copy = task.copy()
                # 转换datetime对象为字符串
                task_copy['created_at'] = task_copy['created_at'].isoformat()
                task_copy['updated_at'] = task_copy['updated_at'].isoformat()

                # 计算运行时间
                created_time = dt.datetime.fromisoformat(task_copy['created_at'])
                current_time = dt.datetime.now()
                running_time = (current_time - created_time).total_seconds()
                task_copy['running_time'] = round(running_time, 2)

                all_tasks[task_id] = task_copy

        # 统计各种状态的任务数量
        status_stats = {
            'pending': 0,
            'processing': 0,
            'completed': 0,
            'failed': 0,
            'total': len(all_tasks)
        }

        failed_tasks = []
        long_running_tasks = []

        for task_id, task in all_tasks.items():
            status_stats[task['status']] += 1

            # 收集失败的任务
            if task['status'] == 'failed':
                failed_tasks.append({
                    'task_id': task_id,
                    'annotation_id': task.get('annotation_id'),
                    'ticker': task.get('ticker'),
                    'date': task.get('date'),
                    'error': task.get('error'),
                    'error_type': task.get('error_type'),
                    'running_time': task['running_time']
                })

            # 收集长时间运行的任务（超过10分钟）
            if task['status'] in ['pending', 'processing'] and task['running_time'] > 600:
                long_running_tasks.append({
                    'task_id': task_id,
                    'annotation_id': task.get('annotation_id'),
                    'ticker': task.get('ticker'),
                    'date': task.get('date'),
                    'status': task['status'],
                    'running_time': task['running_time']
                })

        return jsonify({
            'success': True,
            'stats': status_stats,
            'failed_tasks': failed_tasks,
            'long_running_tasks': long_running_tasks,
            'all_tasks': all_tasks if not os.environ.get('DATABASE_URL') else {}  # 仅在开发环境返回全部任务
        }), 200

    except Exception as e:
        error_msg = f"获取任务状态概览失败: {str(e)}"
        print(f"[ERROR] {error_msg}")
        return jsonify({'error': error_msg}), 500

@app.route('/api/ai/task/<string:task_id>/retry', methods=['POST'])
@require_api_auth
def retry_ai_task(task_id):
    """重新尝试一个失败的AI分析任务"""
    try:
        with task_lock:
            if task_id not in ai_tasks:
                return jsonify({'error': 'Task not found'}), 404

            task = ai_tasks[task_id]

            # 只允许重试失败的任务
            if task['status'] != 'failed':
                return jsonify({'error': f'Cannot retry task with status: {task["status"]}'}), 400

            # 获取原始任务信息
            annotation_id = task.get('annotation_id', 'unknown')
            ticker = task.get('ticker', 'unknown')
            date = task.get('date', 'unknown')

            # 我们需要重新获取输入文本，这里先返回错误提示
            return jsonify({
                'error': 'Task retry not implemented yet. Please use the normal AI analysis button to restart the analysis.',
                'suggestion': '请在注释列表中点击"自动分析"按钮重新开始分析',
                'task_info': {
                    'annotation_id': annotation_id,
                    'ticker': ticker,
                    'date': date
                }
            }), 501  # Not Implemented

    except Exception as e:
        error_msg = f"重试任务失败: {str(e)}"
        print(f"[ERROR] {error_msg}")
        return jsonify({'error': error_msg}), 500


# --- V3.7: 回收站API ---
@app.route('/api/recycle/annotations')
@require_api_auth
def get_deleted_annotations():
    """获取回收站中的已删除注释"""
    ticker = request.args.get('ticker', '')
    if not ticker:
        return jsonify({'error': 'Ticker parameter required'}), 400
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 标准化ticker查询
        normalized_ticker, _ = normalize_ticker(ticker)
        
        # 获取指定股票的已删除注释
        db_execute(cursor, """
            SELECT annotation_id, ticker, date, text, annotation_type, algorithm_type, 
                   is_favorite, deleted_at, created_at
            FROM annotations 
            WHERE ticker = %s AND is_deleted = 1
            ORDER BY deleted_at DESC
        """, (normalized_ticker,))
        
        deleted_rows = cursor.fetchall()
        deleted_annotations = [
            {
                'id': row['annotation_id'],
                'ticker': row['ticker'],
                'date': row['date'], 
                'text': row['text'],
                'type': row['annotation_type'],
                'algorithm_type': row['algorithm_type'],
                'is_favorite': bool(row['is_favorite']) if row['is_favorite'] is not None else False,
                'deleted_at': row['deleted_at'],
                'created_at': row['created_at']
            }
            for row in deleted_rows
        ]
        
        cursor.close()
        db.close()
        
        return jsonify({
            'success': True,
            'deleted_annotations': deleted_annotations,
            'count': len(deleted_annotations)
        }), 200
        
    except Exception as e:
        print(f"[ERROR] 获取回收站数据失败: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/recycle/restore/<string:annotation_id>', methods=['POST'])
@require_api_auth
def restore_annotation(annotation_id):
    """从回收站恢复注释"""
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 恢复注释API调用: {decoded_id}")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 检查注释是否在回收站中
        db_execute(cursor, """
            SELECT annotation_id FROM annotations 
            WHERE (annotation_id = %s OR annotation_id = %s) AND is_deleted = 1
        """, (annotation_id, decoded_id))
        
        existing = cursor.fetchone()
        if not existing:
            return jsonify({'error': 'Annotation not found in recycle bin'}), 404
        
        actual_id = existing['annotation_id']
        
        # 恢复注释：设置 is_deleted = 0，清空 deleted_at
        db_execute(cursor, """
            UPDATE annotations 
            SET is_deleted = 0, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE annotation_id = %s
        """, (actual_id,))
        
        db.commit()
        
        print(f"[DEBUG] 注释恢复成功: {actual_id}")
        return jsonify({'success': True, 'message': 'Annotation restored'}), 200
        
    except Exception as e:
        print(f"[ERROR] 恢复注释失败: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()

@app.route('/api/recycle/permanent-delete/<string:annotation_id>', methods=['DELETE'])
@require_api_auth
def permanent_delete_annotation(annotation_id):
    """永久删除注释（从回收站彻底删除）"""
    import urllib.parse
    decoded_id = urllib.parse.unquote(annotation_id)
    print(f"[DEBUG] 永久删除注释API调用: {decoded_id}")
    
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 检查注释是否在回收站中
        db_execute(cursor, """
            SELECT annotation_id FROM annotations 
            WHERE (annotation_id = %s OR annotation_id = %s) AND is_deleted = 1
        """, (annotation_id, decoded_id))
        
        existing = cursor.fetchone()
        if not existing:
            return jsonify({'error': 'Annotation not found in recycle bin'}), 404
        
        actual_id = existing['annotation_id']
        
        # 永久删除
        db_execute(cursor, "DELETE FROM annotations WHERE annotation_id = %s", (actual_id,))
        db.commit()
        
        print(f"[DEBUG] 注释永久删除成功: {actual_id}")
        return jsonify({'success': True, 'message': 'Annotation permanently deleted'}), 200
        
    except Exception as e:
        print(f"[ERROR] 永久删除注释失败: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'db' in locals() and db:
            db.close()


@app.route('/api/annotations/export')
@require_api_auth
def export_annotations():
    """导出指定时间段的股价异常标注数据 - 支持动态算法参数"""
    try:
        # 获取基本参数
        ticker = request.args.get('ticker')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        if not ticker or not start_date or not end_date:
            return jsonify({'error': '缺少必要参数'}), 400
            
        # 获取算法参数（如果提供）
        price_std_multiplier = float(request.args.get('price_std', 1.8))
        volume_std_multiplier = float(request.args.get('volume_std', 1.8))
        price_only_std_multiplier = float(request.args.get('price_only_std', 2.5))
        volume_only_std_multiplier = float(request.args.get('volume_only_std', 3.0))
        
        # ZIG指标参数
        short_term_zig_threshold = float(request.args.get('short_term_zig', 10))
        medium_term_zig_threshold = float(request.args.get('medium_term_zig', 10))
        long_term_zig_threshold = float(request.args.get('long_term_zig', 25))
        zig_phase_source = request.args.get('zig_phase_source', 'zig50')
        
        # 成交量ZIG指标参数
        volume_short_term_zig_threshold = float(request.args.get('volume_short_term_zig', 10))
        volume_medium_term_zig_threshold = float(request.args.get('volume_medium_term_zig', 10))
        volume_long_term_zig_threshold = float(request.args.get('volume_long_term_zig', 10))
        volume_zig_phase_source = request.args.get('volume_zig_phase_source', 'volume_zig50')
            
        # 标准化股票代码
        normalized_ticker, _ = normalize_ticker(ticker)
        
        # 获取公司名称
        company_name = get_company_name(normalized_ticker)
        company_info = f"{ticker} {company_name}" if company_name else ticker
        
        # 构建stock_data API的URL，使用当前算法参数
        stock_api_params = {
            'ticker': ticker,
            'period': '1d',  # 使用日线数据
            'price_std': price_std_multiplier,
            'volume_std': volume_std_multiplier,
            'price_only_std': price_only_std_multiplier,
            'volume_only_std': volume_only_std_multiplier,
            'short_term_zig': short_term_zig_threshold,
            'medium_term_zig': medium_term_zig_threshold,
            'long_term_zig': long_term_zig_threshold,
            'zig_phase_source': zig_phase_source,
            'volume_short_term_zig': volume_short_term_zig_threshold,
            'volume_medium_term_zig': volume_medium_term_zig_threshold,
            'volume_long_term_zig': volume_long_term_zig_threshold,
            'volume_zig_phase_source': volume_zig_phase_source
        }
        
        # 内部调用stock_data API获取带有当前参数的完整数据
        with app.test_request_context('/api/stock_data', query_string=stock_api_params):
            stock_response = stock_data()
            
            # 检查响应是否为空或错误
            if stock_response is None:
                return jsonify({'error': '无法获取股票数据'}), 500
                
            if isinstance(stock_response, tuple) and stock_response[1] != 200:
                return stock_response
                
            stock_result = stock_response.get_json() if hasattr(stock_response, 'get_json') else stock_response
            
            # 进一步检查股票结果是否为空
            if stock_result is None:
                return jsonify({'error': '股票数据为空'}), 500
            
        # 从stock_data结果中提取annotations
        all_annotations = stock_result.get('annotations', [])
        
        # 筛选指定时间段内的标注
        filtered_annotations = [
            annotation for annotation in all_annotations
            if start_date <= annotation['date'] <= end_date
        ]
        
        # 转换格式并添加公司信息
        annotations = []
        for annotation in filtered_annotations:
            annotations.append({
                '公司信息': company_info,
                'date': annotation['date'],
                'text': annotation['text'],
                'type': annotation['type']
            })
        
        return jsonify({
            'success': True,
            'data': annotations,
            'count': len(annotations),
            'period': f"{start_date} 至 {end_date}",
            'ticker': ticker
        })
        
    except Exception as e:
        print(f"导出注释数据时发生错误: {str(e)}")
        return jsonify({'error': f'导出失败: {str(e)}'}), 500
    finally:
        if 'db' in locals() and db:
            db.close()


@app.route('/api/stock_data')
@require_api_auth
def stock_data():
    import datetime as dt
    # --- 获取前端参数 ---
    user_input_ticker = request.args.get('ticker', 'AAPL')
    period_param = request.args.get('period', '1d')
    
    # --- 智能股票代码识别与转换 ---
    print(f"[API] 用户输入: {user_input_ticker}")
    
    # Step 1: 将用户输入标准化为内部格式
    normalized_ticker, identification_type = normalize_ticker(user_input_ticker)
    
    if not normalized_ticker:
        smart_error_msg = generate_smart_error_message(user_input_ticker, identification_type)
        return jsonify({'error': smart_error_msg}), 400
    
    print(f"[API] 标准化结果: {user_input_ticker} -> {normalized_ticker} (类型: {identification_type})")
    
    # Step 2: 为Yahoo API准备正确格式
    yahoo_ticker = to_yahoo_format(normalized_ticker)
    
    # Step 3: 设置内部使用的ticker（用于缓存和显示）
    ticker = normalized_ticker
    print(f"[API] 最终使用 - 内部格式: {ticker}, Yahoo格式: {yahoo_ticker}")
    
    # V1.2 & V1.8 新增：从前端获取算法参数，并提供默认值
    price_std_multiplier = float(request.args.get('price_std', 1.8))
    volume_std_multiplier = float(request.args.get('volume_std', 1.8))
    price_only_std_multiplier = float(request.args.get('price_only_std', 2.5))
    volume_only_std_multiplier = float(request.args.get('volume_only_std', 3.0)) # 新增：仅成交量异常的倍数

    # ZIG指标参数
    short_term_zig_threshold = float(request.args.get('short_term_zig', 10))
    medium_term_zig_threshold = float(request.args.get('medium_term_zig', 10))
    long_term_zig_threshold = float(request.args.get('long_term_zig', 25))
    zig_phase_source = request.args.get('zig_phase_source', 'zig50') # 新增：用于判断区间的ZIG来源

    # V2.0 新增: 成交量ZIG指标参数
    volume_short_term_zig_threshold = float(request.args.get('volume_short_term_zig', 10))
    volume_medium_term_zig_threshold = float(request.args.get('volume_medium_term_zig', 10))
    volume_long_term_zig_threshold = float(request.args.get('volume_long_term_zig', 10))
    volume_zig_phase_source = request.args.get('volume_zig_phase_source', 'volume_zig50')

    print(f"获取股票数据: {ticker}, 周期: {period_param}")
    print(f"算法参数: price_std={price_std_multiplier}, volume_std={volume_std_multiplier}, price_only_std={price_only_std_multiplier}, volume_only_std={volume_only_std_multiplier}")
    print(f"ZIG参数: short={short_term_zig_threshold}%, medium={medium_term_zig_threshold}%, long={long_term_zig_threshold}% Phase Source: {zig_phase_source}")
    print(f"成交量ZIG参数: short={volume_short_term_zig_threshold}%, medium={volume_medium_term_zig_threshold}%, long={volume_long_term_zig_threshold}% Phase Source: {volume_zig_phase_source}")

    # 获取公司名称
    company_name = get_company_name(ticker)


    # 根据K线周期设置合适的时间范围
    # 使用明确的起止日期而不是range=max，以避免Yahoo Finance API的已知bug
    # (使用range=max可能会返回错误的数据粒度，如请求日线却返回周线数据)
    end_date = dt.datetime.now()
    start_date = end_date - dt.timedelta(days=365*20)  # 最多获取20年历史数据

    # 将日期转换为Unix时间戳
    period1 = int(start_date.timestamp())
    period2 = int(end_date.timestamp())

    if period_param == '1mo':
        interval_param = '1mo'
    elif period_param == '1wk':
        interval_param = '1wk'
    else:
        interval_param = '1d'

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?period1={period1}&period2={period2}&interval={interval_param}"
    print(f"请求Yahoo Finance API: {url}")
    print(f"[API] 使用Yahoo格式: {yahoo_ticker} (原始输入: {user_input_ticker})")

    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        response.raise_for_status()

        # 安全地解析JSON响应
        try:
            yahoo_data = response.json()
        except ValueError as e:
            # 响应不是有效的JSON（如"Too Many Requests"文本）
            error_text = response.text[:200] if response.text else "无响应内容"
            print(f"[ERROR] Yahoo Finance API返回非JSON响应: {error_text}")
            return jsonify({
                'error': 'Yahoo Finance API暂时不可用，请等待3-5分钟后重试',
                'details': f'API返回: {error_text}',
                'suggestion': '这通常是由于请求频率过高导致的临时限制'
            }), 503

        result = yahoo_data.get('chart', {}).get('result', [])
        if not result:
            return jsonify({'error': f"无法从雅虎财经获取股票代码为 '{ticker}' 的数据，请检查股票代码是否正确。"}), 404

        res = result[0]
        timestamps = res.get('timestamp', [])

        # 安全地获取quote数据，避免list index out of range
        indicators = res.get('indicators', {})
        quote_list = indicators.get('quote', [])

        if not quote_list:
            print(f"[ERROR] Yahoo Finance返回的数据中没有quote信息")
            return jsonify({
                'error': f"无法解析 '{ticker}' 的股价数据",
                'details': 'Yahoo Finance返回的数据格式不完整'
            }), 500

        ohlc = quote_list[0]

        if not timestamps or not ohlc.get('open'):
             return jsonify({'error': f"返回的数据格式不完整，无法解析 '{ticker}' 的股价。"}), 500
        
        # 使用Pandas DataFrame进行数据分析
        df = pd.DataFrame({
            'timestamp': timestamps,
            'open': ohlc['open'],
            'high': ohlc['high'],
            'low': ohlc['low'],
            'close': ohlc['close'],
            'volume': ohlc['volume']
        })

        # 移除空值行，并使用 .copy() 避免 SettingWithCopyWarning
        df = df.dropna().copy()

        # 初始化分析结果容器
        generated_annotations = []
        market_phases = []

        # --- V3.7: 从数据库获取所有注释（包括手动和算法注释） ---
        existing_annotations = []
        try:
            db = get_db()
            cursor = db.cursor()
            # 获取所有未删除的注释
            if IS_PRODUCTION: # V5.0
                cursor.execute("""
                    SELECT annotation_id, date, text, annotation_type, algorithm_type, is_favorite 
                    FROM annotations 
                    WHERE ticker = %s AND is_deleted = 0
                """, (ticker,))
            else:
                cursor.execute("""
                    SELECT annotation_id, date, text, annotation_type, algorithm_type, is_favorite 
                    FROM annotations 
                    WHERE ticker = ? AND is_deleted = 0
                """, (ticker,))
            annotation_rows = cursor.fetchall()
            existing_annotations = [
                {
                    'date': row['date'], 
                    'text': row['text'], 
                    'id': row['annotation_id'], 
                    'type': row['algorithm_type'] if row['annotation_type'] == 'algorithm' else row['annotation_type'],
                    'algorithm_type': row['algorithm_type'],
                    'is_favorite': bool(row['is_favorite']) if row['is_favorite'] is not None else False
                }
                for row in annotation_rows
            ]
        except Exception as e:
            print(f"Error fetching annotations from DB: {e}")
            existing_annotations = []
        finally:
            if 'db' in locals() and db:
                db.close()

        # 分离手动注释和算法注释（包括AI分析）
        manual_annotations = [anno for anno in existing_annotations if anno['type'] == 'manual']
        existing_algorithm_annotations = [anno for anno in existing_annotations if anno['type'] in ['algorithm', 'price_volume', 'volume_stable_price', 'price_only', 'volume_only', 'ai_analysis']]

        # --- V1.2: 可配置的动态阈值异常检测 ---
        analysis_period = 60  # 使用60个周期作为统计窗口
        
        if len(df) > analysis_period:
            # 1. 计算价格和成交量的动态基准
            df['prev_close'] = df['close'].shift(1)
            df['price_change_pct'] = (df['close'] - df['prev_close']) / df['prev_close']
            
            df['price_change_std'] = df['price_change_pct'].rolling(window=analysis_period).std()
            df['volume_mean'] = df['volume'].rolling(window=analysis_period).mean()
            df['volume_std'] = df['volume'].rolling(window=analysis_period).std()

            # 2. 定义异常条件
            # 价量齐升的异常价格
            is_abnormal_price_for_volume = df['price_change_pct'].abs() > (df['price_change_std'] * price_std_multiplier)
            # 单独的价格异常
            is_abnormal_price_only = df['price_change_pct'].abs() > (df['price_change_std'] * price_only_std_multiplier)
            # 成交量异常
            is_abnormal_volume = df['volume'] > (df['volume_mean'] + df['volume_std'] * volume_std_multiplier)
            # 价格稳定
            is_stable_price = df['price_change_pct'].abs() < 0.01

            # 3. 应用规则并生成标注
            # 规则一：价量齐升/跌
            abnormal_price_volume_days = df[is_abnormal_price_for_volume & is_abnormal_volume]
            for _, row in abnormal_price_volume_days.iterrows():
                change_type = "上涨" if row['price_change_pct'] > 0 else "下跌"
                date_str = dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d')
                text = f'[价量齐{change_type}] 波动: {row["price_change_pct"]:.2%}'
                
                # 保存到数据库并获取注释信息
                annotation_result = save_algorithm_annotation(
                    ticker, date_str, text, 'price_volume',
                    {'price_std': price_std_multiplier, 'volume_std': volume_std_multiplier}
                )
                
                if annotation_result:
                    # 使用数据库中的实际内容（可能已被用户编辑）
                    generated_annotations.append({
                        'date': date_str,
                        'text': annotation_result['text'],
                        'type': 'price_volume',
                        'id': annotation_result['id'],
                        'is_favorite': annotation_result.get('is_favorite', False)
                    })

            # 规则二：放量滞涨/跌 (成交量异常但价格稳定)
            abnormal_volume_stable_price_days = df[is_abnormal_volume & is_stable_price]
            for _, row in abnormal_volume_stable_price_days.iterrows():
                change_type = "上涨" if row['price_change_pct'] > 0 else ("下跌" if row['price_change_pct'] < 0 else "平盘")
                date_str = dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d')
                text = f'[放量滞{change_type}] 波动: {row["price_change_pct"]:.2%}'
                
                # 保存到数据库并获取注释信息
                annotation_result = save_algorithm_annotation(
                    ticker, date_str, text, 'volume_stable_price',
                    {'volume_std': volume_std_multiplier}
                )
                
                if annotation_result:
                    # 使用数据库中的实际内容（可能已被用户编辑）
                    generated_annotations.append({
                        'date': date_str,
                        'text': annotation_result['text'],
                        'type': 'volume_stable_price',
                        'id': annotation_result['id'],
                        'is_favorite': annotation_result.get('is_favorite', False)
                    })
            
            # 规则三：仅价格异常 (成交量未显著放大)
            # 我们要排除掉已经被规则一覆盖的情况
            price_only_days = df[is_abnormal_price_only & ~is_abnormal_volume]
            for _, row in price_only_days.iterrows():
                change_type = "上涨" if row['price_change_pct'] > 0 else "下跌"
                date_str = dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d')
                text = f'[价异动] {change_type} {row["price_change_pct"]:.2%}'
                
                # 保存到数据库并获取注释信息
                annotation_result = save_algorithm_annotation(
                    ticker, date_str, text, 'price_only',
                    {'price_only_std': price_only_std_multiplier}
                )
                
                if annotation_result:
                    # 使用数据库中的实际内容（可能已被用户编辑）
                    generated_annotations.append({
                        'date': date_str,
                        'text': annotation_result['text'],
                        'type': 'price_only',
                        'id': annotation_result['id'],
                        'is_favorite': annotation_result.get('is_favorite', False)
                    })

            # 规则四：仅成交量异常 (价格未显著波动)
            # V1.8 新增：当成交量异常，但价格波动不显著时
            is_abnormal_volume_only = df['volume'] > (df['volume_mean'] + df['volume_std'] * volume_only_std_multiplier)
            # 排除掉已经被规则一和规则二覆盖的情况
            volume_only_days = df[is_abnormal_volume_only & ~is_abnormal_price_for_volume & ~is_stable_price]
            for _, row in volume_only_days.iterrows():
                date_str = dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d')
                text = f'[量异动]'
                
                # 保存到数据库并获取注释信息
                annotation_result = save_algorithm_annotation(
                    ticker, date_str, text, 'volume_only',
                    {'volume_only_std': volume_only_std_multiplier}
                )
                
                if annotation_result:
                    # 使用数据库中的实际内容（可能已被用户编辑）
                    generated_annotations.append({
                        'date': date_str,
                        'text': annotation_result['text'],
                        'type': 'volume_only',
                        'id': annotation_result['id'],
                        'is_favorite': annotation_result.get('is_favorite', False)
                    })

        # --- ZIG指标均线计算 ---
        # 价格均线
        df['ma5'] = df['close'].rolling(window=5).mean()
        df['ma25'] = df['close'].rolling(window=25).mean()
        df['ma50'] = df['close'].rolling(window=50).mean()
        
        # --- 新增：常用均线计算 ---
        df['ma5_new'] = df['close'].rolling(window=5).mean()  # 5日线
        df['ma20'] = df['close'].rolling(window=20).mean()    # 20日线  
        df['ma60_new'] = df['close'].rolling(window=60).mean() # 60日线

        # 成交量均线
        df['volume_ma5'] = df['volume'].rolling(window=5).mean()
        df['volume_ma25'] = df['volume'].rolling(window=25).mean()
        df['volume_ma50'] = df['volume'].rolling(window=50).mean()

        # 计算ZIG指标
        # 价格ZIG
        zig5 = calculate_zig(df['ma5'], short_term_zig_threshold)
        zig25 = calculate_zig(df['ma25'], medium_term_zig_threshold)
        zig50 = calculate_zig(df['ma50'], long_term_zig_threshold)
        
        # 成交量ZIG
        volume_zig5 = calculate_zig(df['volume_ma5'], volume_short_term_zig_threshold)
        volume_zig25 = calculate_zig(df['volume_ma25'], volume_medium_term_zig_threshold)
        volume_zig50 = calculate_zig(df['volume_ma50'], volume_long_term_zig_threshold)

        # --- V1.9: 基于ZIG指标判断市场阶段 ---
        zig_map = {
            'zig5': zig5,
            'zig25': zig25,
            'zig50': zig50
        }
        selected_zig = zig_map.get(zig_phase_source, zig50) # 默认使用zig50
        market_phases = calculate_phases_from_zig(selected_zig, df['timestamp'].tolist())

        # V2.0: 基于成交量ZIG判断放量/缩量阶段
        volume_zig_map = {
            'volume_zig5': volume_zig5,
            'volume_zig25': volume_zig25,
            'volume_zig50': volume_zig50
        }
        selected_volume_zig = volume_zig_map.get(volume_zig_phase_source, volume_zig50)
        volume_phases = calculate_phases_from_zig(selected_volume_zig, df['timestamp'].tolist())

        # V1.4 修复：将NaN替换为0，确保JSON有效
        if 'price_change_pct' not in df.columns:
            df['price_change_pct'] = 0.0
        df['price_change_pct'] = df['price_change_pct'].fillna(0)

        # 将整个DataFrame中的NaN替换为None，以便进行正确的JSON转换
        df.replace({np.nan: None}, inplace=True)

        k_data = []
        for index, row in df.iterrows():
            k_data.append([
                dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d'),
                row['open'],
                row['close'],
                row['low'],
                row['high'],
                row['volume'],
                row['price_change_pct'] * 100 if row['price_change_pct'] is not None else None
            ])
        
        # V3.7: 合并所有注释 - 优先使用数据库中的注释，避免重复
        all_annotations = manual_annotations + existing_algorithm_annotations + generated_annotations
        
        # V4.8.1: 增强去重处理 - 双重去重机制
        # 第一步：基于注释ID去重，避免重复的记录
        seen_annotation_ids = set()
        id_deduped_annotations = []
        
        for anno in all_annotations:
            # 基于注释ID去重，每个注释都应该有唯一的ID
            annotation_id = anno.get('id')
            if annotation_id and annotation_id in seen_annotation_ids:
                continue
            
            if annotation_id:
                seen_annotation_ids.add(annotation_id)
            
            id_deduped_annotations.append(anno)
        
        # 第二步：基于日期+优先级去重，确保同一日期只保留最有价值的记录
        date_priority_map = {}
        
        for anno in id_deduped_annotations:
            date = anno.get('date')
            if not date:
                continue
                
            # 定义优先级：AI分析 > 手动 > 算法
            # 检查是否为AI分析记录（可能在type或algorithm_type字段中）
            is_ai_analysis = (anno.get('algorithm_type') == 'ai_analysis' or 
                            anno.get('type') == 'ai_analysis')
            
            if is_ai_analysis:
                priority = 3  # AI分析最高优先级
            elif anno.get('type') == 'manual':
                priority = 2  # 手动注释优先级高
            elif anno.get('type') in ['price_volume', 'volume_stable_price', 'price_only', 'volume_only']:
                priority = 1  # 算法注释优先级最低
            else:
                priority = 1  # 默认优先级
            
            # 如果该日期还没有记录，或者当前记录优先级更高，则更新
            if date not in date_priority_map or priority > date_priority_map[date]['priority']:
                date_priority_map[date] = {
                    'annotation': anno,
                    'priority': priority
                }
        
        # 提取最终的注释列表
        final_annotations = [info['annotation'] for info in date_priority_map.values()]
        
        print(f"成功获取 {ticker} 数据，共 {len(k_data)} 个数据点，{len(final_annotations)} 个注释 (手动:{len(manual_annotations)}, 算法:{len(existing_algorithm_annotations)+len(generated_annotations)}, 去重前:{len(all_annotations)})")
        
        # 准备均线数据，处理NaN为None
        ma5_data = [None if pd.isna(x) else x for x in df['ma5']]
        ma25_data = [None if pd.isna(x) else x for x in df['ma25']]
        ma50_data = [None if pd.isna(x) else x for x in df['ma50']]
        
        # 新增：常用均线数据
        ma5_new_data = [None if pd.isna(x) else x for x in df['ma5_new']]
        ma20_data = [None if pd.isna(x) else x for x in df['ma20']]
        ma60_new_data = [None if pd.isna(x) else x for x in df['ma60_new']]

        return jsonify({
            'ticker': ticker,
            'company_name': company_name,
            'data': k_data,
            'annotations': final_annotations, # V3.7: 将合并后的所有标注数据返回给前端
            'market_phases': market_phases, # 将市场阶段数据返回给前端
            'zig5': zig5,
            'zig25': zig25,
            'zig50': zig50,
            # V2.0 新增：返回成交量ZIG数据
            'volume_zig5': volume_zig5,
            'volume_zig25': volume_zig25,
            'volume_zig50': volume_zig50,
            'volume_phases': volume_phases,
            # V2.1 恢复：返回均线数据
            'ma5': ma5_data,
            'ma25': ma25_data,
            'ma50': ma50_data,
            # 新增：常用均线数据
            'ma5_new': ma5_new_data,
            'ma20': ma20_data,
            'ma60_new': ma60_new_data
        })

    except requests.exceptions.HTTPError as http_err:
        print(f"[ERROR] Yahoo Finance HTTPError: {http_err}")
        return jsonify({'error': f"请求雅虎财经API时出错: {http_err}"}), 502
    except Exception as e:
        import traceback
        print(f"[ERROR] stock_data异常: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# --- V3.3: 新增结构化分析数据API ---
@app.route('/api/analysis_data')
@require_api_auth
def analysis_data():
    """
    提供结构化的股价分析数据API
    支持所有异常检测和ZIG指标参数的完整配置
    """
    import json
    import datetime as dt
    
    # --- 获取所有参数 ---
    user_input_ticker = request.args.get('ticker', 'ONC')
    period_param = request.args.get('period', '1d')
    
    # --- 智能股票代码识别与转换 ---
    print(f"[ANALYSIS_API] 用户输入: {user_input_ticker}")
    
    # Step 1: 将用户输入标准化为内部格式
    normalized_ticker, identification_type = normalize_ticker(user_input_ticker)
    
    if not normalized_ticker:
        smart_error_msg = generate_smart_error_message(user_input_ticker, identification_type)
        return jsonify({'error': smart_error_msg}), 400
    
    print(f"[ANALYSIS_API] 标准化结果: {user_input_ticker} -> {normalized_ticker} (类型: {identification_type})")
    
    # Step 2: 为Yahoo API准备正确格式
    yahoo_ticker = to_yahoo_format(normalized_ticker)
    
    # Step 3: 设置内部使用的ticker（用于缓存和显示）
    ticker = normalized_ticker
    print(f"[ANALYSIS_API] 最终使用 - 内部格式: {ticker}, Yahoo格式: {yahoo_ticker}")
    
    # 异常检测参数
    price_std_multiplier = float(request.args.get('price_std', 1.8))
    volume_std_multiplier = float(request.args.get('volume_std', 1.8))
    price_only_std_multiplier = float(request.args.get('price_only_std', 2.5))
    volume_only_std_multiplier = float(request.args.get('volume_only_std', 3.0))

    # ZIG指标参数
    short_term_zig_threshold = float(request.args.get('short_term_zig', 10))
    medium_term_zig_threshold = float(request.args.get('medium_term_zig', 10))
    long_term_zig_threshold = float(request.args.get('long_term_zig', 25))
    zig_phase_source = request.args.get('zig_phase_source', 'zig50')

    # 成交量ZIG指标参数
    volume_short_term_zig_threshold = float(request.args.get('volume_short_term_zig', 10))
    volume_medium_term_zig_threshold = float(request.args.get('volume_medium_term_zig', 10))
    volume_long_term_zig_threshold = float(request.args.get('volume_long_term_zig', 10))
    volume_zig_phase_source = request.args.get('volume_zig_phase_source', 'volume_zig50')

    # 记录使用的参数
    used_parameters = {
        'ticker': ticker,
        'period': period_param,
        'price_std': price_std_multiplier,
        'volume_std': volume_std_multiplier,
        'price_only_std': price_only_std_multiplier,
        'volume_only_std': volume_only_std_multiplier,
        'short_term_zig': short_term_zig_threshold,
        'medium_term_zig': medium_term_zig_threshold,
        'long_term_zig': long_term_zig_threshold,
        'zig_phase_source': zig_phase_source,
        'volume_short_term_zig': volume_short_term_zig_threshold,
        'volume_medium_term_zig': volume_medium_term_zig_threshold,
        'volume_long_term_zig': volume_long_term_zig_threshold,
        'volume_zig_phase_source': volume_zig_phase_source
    }

    print(f"分析API调用: {ticker}, 参数: {used_parameters}")

    try:
        # --- 复用现有的数据获取逻辑 ---
        # 根据K线周期设置合适的时间范围
        if period_param == '1mo':
            range_param = '10y'
            interval_param = '1mo'
        elif period_param == '1wk':
            range_param = '10y'
            interval_param = '1wk'
        else:
            range_param = '10y'
            interval_param = '1d'

        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?range={range_param}&interval={interval_param}"
        print(f"[ANALYSIS_API] 请求Yahoo Finance API: {url}")
        print(f"[ANALYSIS_API] 使用Yahoo格式: {yahoo_ticker} (原始输入: {user_input_ticker})")
        
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        
        yahoo_data = response.json()
        result = yahoo_data.get('chart', {}).get('result', [])
        if not result:
            return jsonify({'error': f"无法获取 '{ticker}' 的数据"}), 404

        res = result[0]
        timestamps = res.get('timestamp', [])
        ohlc = res.get('indicators', {}).get('quote', [{}])[0]

        if not timestamps or not ohlc.get('open'):
            return jsonify({'error': f"数据格式不完整"}), 500
        
        # 数据处理
        df = pd.DataFrame({
            'timestamp': timestamps,
            'open': ohlc['open'],
            'high': ohlc['high'],
            'low': ohlc['low'],
            'close': ohlc['close'],
            'volume': ohlc['volume']
        }).dropna().copy()

        # --- 异常检测分析 ---
        anomaly_results = {
            'price_volume_events': [],
            'volume_stable_price_events': [],
            'price_only_events': [],
            'volume_only_events': []
        }

        analysis_period = 60
        if len(df) > analysis_period:
            # 计算动态基准
            df['prev_close'] = df['close'].shift(1)
            df['price_change_pct'] = (df['close'] - df['prev_close']) / df['prev_close']
            df['price_change_std'] = df['price_change_pct'].rolling(window=analysis_period).std()
            df['volume_mean'] = df['volume'].rolling(window=analysis_period).mean()
            df['volume_std'] = df['volume'].rolling(window=analysis_period).std()

            # 异常条件判断
            is_abnormal_price_for_volume = df['price_change_pct'].abs() > (df['price_change_std'] * price_std_multiplier)
            is_abnormal_price_only = df['price_change_pct'].abs() > (df['price_change_std'] * price_only_std_multiplier)
            is_abnormal_volume = df['volume'] > (df['volume_mean'] + df['volume_std'] * volume_std_multiplier)
            is_stable_price = df['price_change_pct'].abs() < 0.01
            is_abnormal_volume_only = df['volume'] > (df['volume_mean'] + df['volume_std'] * volume_only_std_multiplier)

            # 规则一：价量齐升/跌
            for _, row in df[is_abnormal_price_for_volume & is_abnormal_volume].iterrows():
                anomaly_results['price_volume_events'].append({
                    'date': dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d'),
                    'price_change_pct': round(row['price_change_pct'] * 100, 2),
                    'volume': int(row['volume']),
                    'close_price': round(row['close'], 2),
                    'type': '上涨' if row['price_change_pct'] > 0 else '下跌'
                })

            # 规则二：放量滞涨/跌
            for _, row in df[is_abnormal_volume & is_stable_price].iterrows():
                anomaly_results['volume_stable_price_events'].append({
                    'date': dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d'),
                    'price_change_pct': round(row['price_change_pct'] * 100, 2),
                    'volume': int(row['volume']),
                    'close_price': round(row['close'], 2),
                    'type': '滞涨' if row['price_change_pct'] >= 0 else '滞跌'
                })

            # 规则三：仅价格异常
            for _, row in df[is_abnormal_price_only & ~is_abnormal_volume].iterrows():
                anomaly_results['price_only_events'].append({
                    'date': dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d'),
                    'price_change_pct': round(row['price_change_pct'] * 100, 2),
                    'volume': int(row['volume']),
                    'close_price': round(row['close'], 2),
                    'type': '上涨' if row['price_change_pct'] > 0 else '下跌'
                })

            # 规则四：仅成交量异常
            for _, row in df[is_abnormal_volume_only & ~is_abnormal_price_for_volume & ~is_stable_price].iterrows():
                anomaly_results['volume_only_events'].append({
                    'date': dt.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d'),
                    'price_change_pct': round(row['price_change_pct'] * 100, 2),
                    'volume': int(row['volume']),
                    'close_price': round(row['close'], 2),
                    'type': '放量'
                })

        # --- ZIG指标分析 ---
        # 计算均线
        df['ma5'] = df['close'].rolling(window=5).mean()
        df['ma25'] = df['close'].rolling(window=25).mean()
        df['ma50'] = df['close'].rolling(window=50).mean()
        df['volume_ma5'] = df['volume'].rolling(window=5).mean()
        df['volume_ma25'] = df['volume'].rolling(window=25).mean()
        df['volume_ma50'] = df['volume'].rolling(window=50).mean()

        # 计算ZIG指标
        zig5 = calculate_zig(df['ma5'], short_term_zig_threshold)
        zig25 = calculate_zig(df['ma25'], medium_term_zig_threshold)
        zig50 = calculate_zig(df['ma50'], long_term_zig_threshold)
        volume_zig5 = calculate_zig(df['volume_ma5'], volume_short_term_zig_threshold)
        volume_zig25 = calculate_zig(df['volume_ma25'], volume_medium_term_zig_threshold)
        volume_zig50 = calculate_zig(df['volume_ma50'], volume_long_term_zig_threshold)

        # 提取ZIG转折点
        def extract_zig_points(zig_series, timestamps, zig_name):
            points = []
            for i, value in enumerate(zig_series):
                if value is not None:
                    points.append({
                        'date': dt.datetime.fromtimestamp(timestamps[i]).strftime('%Y-%m-%d'),
                        'value': round(value, 2),
                        'index': i,
                        'zig_type': zig_name
                    })
            return points

        zig_analysis = {
            'zig5_points': extract_zig_points(zig5, df['timestamp'].tolist(), 'short_term'),
            'zig25_points': extract_zig_points(zig25, df['timestamp'].tolist(), 'medium_term'),
            'zig50_points': extract_zig_points(zig50, df['timestamp'].tolist(), 'long_term'),
            'volume_zig5_points': extract_zig_points(volume_zig5, df['timestamp'].tolist(), 'volume_short_term'),
            'volume_zig25_points': extract_zig_points(volume_zig25, df['timestamp'].tolist(), 'volume_medium_term'),
            'volume_zig50_points': extract_zig_points(volume_zig50, df['timestamp'].tolist(), 'volume_long_term')
        }

        # --- 市场阶段分析 ---
        zig_map = {'zig5': zig5, 'zig25': zig25, 'zig50': zig50}
        selected_zig = zig_map.get(zig_phase_source, zig50)
        market_phases = calculate_phases_from_zig(selected_zig, df['timestamp'].tolist())

        volume_zig_map = {'volume_zig5': volume_zig5, 'volume_zig25': volume_zig25, 'volume_zig50': volume_zig50}
        selected_volume_zig = volume_zig_map.get(volume_zig_phase_source, volume_zig50)
        volume_phases = calculate_phases_from_zig(selected_volume_zig, df['timestamp'].tolist())

        # --- 统计信息 ---
        statistics = {
            'total_anomalies': sum(len(events) for events in anomaly_results.values()),
            'price_volume_count': len(anomaly_results['price_volume_events']),
            'volume_stable_price_count': len(anomaly_results['volume_stable_price_events']),
            'price_only_count': len(anomaly_results['price_only_events']),
            'volume_only_count': len(anomaly_results['volume_only_events']),
            'market_phases_count': len(market_phases),
            'volume_phases_count': len(volume_phases),
            'zig5_points_count': len(zig_analysis['zig5_points']),
            'zig25_points_count': len(zig_analysis['zig25_points']),
            'zig50_points_count': len(zig_analysis['zig50_points']),
            'data_points': len(df)
        }

        # --- 返回结构化数据 ---
        return jsonify({
            'meta': {
                'ticker': ticker,
                'period': period_param,
                'analysis_timestamp': dt.datetime.now().isoformat(),
                'parameters': used_parameters
            },
            'anomaly_analysis': anomaly_results,
            'zig_analysis': zig_analysis,
            'market_phases': market_phases,
            'volume_phases': volume_phases,
            'statistics': statistics
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- 股票名单缓存管理API ---
@app.route('/api/stock-search', methods=['GET'])
@require_api_auth
def search_stocks():
    """
    股票搜索API - 支持股票代码和公司名称搜索
    参数：
    - q: 搜索关键词（股票代码或公司名称）
    - limit: 返回结果数量限制（默认10）
    """
    try:
        query = request.args.get('q', '').strip()
        limit = int(request.args.get('limit', 10))
        
        if not query:
            return jsonify({
                'success': False,
                'error': '搜索关键词不能为空'
            }), 400
        
        print(f"[SEARCH_API] 搜索关键词: {query}")
        
        # 尝试智能识别
        normalized_ticker, identification_type = normalize_ticker(query)
        
        results = []
        
        # 如果是有效的股票代码，添加到结果中
        if normalized_ticker and identification_type not in ['company_name_not_found', 'search_error', 'invalid']:
            company_name = get_company_name(normalized_ticker)
            
            results.append({
                'ticker': normalized_ticker,
                'company_name': company_name,
                'match_type': 'exact_code',
                'display_name': f"{company_name} ({to_display_format(normalized_ticker)})"
            })
        
        # 搜索公司名称匹配
        db = get_db()
        cursor = db.cursor()
        
        # 模糊搜索公司名称
        cursor.execute("""
            SELECT ticker, company_name, source 
            FROM company_names 
            WHERE company_name LIKE %s 
            ORDER BY 
                CASE WHEN company_name = %s THEN 1 ELSE 2 END,
                LENGTH(company_name) ASC
            LIMIT %s
        """, (f"%{query}%", query, limit))
        
        name_matches = cursor.fetchall()
        
        for match in name_matches:
            ticker = match['ticker']
            company_name = match['company_name']
            source = match['source']
            
            # 避免重复添加（如果前面已经通过代码识别添加了）
            if not any(r['ticker'] == ticker for r in results):
                results.append({
                    'ticker': ticker,
                    'company_name': company_name,
                    'match_type': 'company_name',
                    'display_name': f"{company_name} ({to_display_format(ticker)})",
                    'source': source
                })
        
        # 如果查询是纯数字，也搜索包含该数字的股票代码
        if query.isdigit():
            cursor.execute("""
                SELECT ticker, company_name, source 
                FROM company_names 
                WHERE ticker LIKE %s 
                ORDER BY LENGTH(ticker) ASC
                LIMIT %s
            """, (f"%{query}%", limit))
            
            code_matches = cursor.fetchall()
            
            for match in code_matches:
                ticker = match['ticker']
                company_name = match['company_name']
                source = match['source']
                
                # 避免重复添加
                if not any(r['ticker'] == ticker for r in results):
                    results.append({
                        'ticker': ticker,
                        'company_name': company_name,
                        'match_type': 'partial_code',
                        'display_name': f"{company_name} ({to_display_format(ticker)})",
                        'source': source
                    })
        
        cursor.close()
        db.close()
        
        # 限制最终结果数量
        results = results[:limit]
        
        return jsonify({
            'success': True,
            'query': query,
            'results': results,
            'total': len(results)
        })
        
    except Exception as e:
        print(f"[ERROR] 股票搜索API失败: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# --- V4.5: 新增趋势区间分析API ---
@app.route('/api/trend-analysis')
@require_api_auth
def trend_analysis():
    """
    趋势区间分析API - 提供股票指定时间段内的上涨/下跌区间分析
    支持时间段筛选、异常点关联和当前区间状态判断
    """
    import json
    import datetime as dt
    
    try:
        # 获取请求参数
        user_input_ticker = request.args.get('ticker', 'UNH')
        period_param = request.args.get('period', 'all')  # 支持 1y, 2y, 3y, 5y, 或 all
        
        # 智能股票代码识别与转换
        print(f"[TREND_API] 用户输入: {user_input_ticker}, 时间段: {period_param}")
        
        normalized_ticker, identification_type = normalize_ticker(user_input_ticker)
        if not normalized_ticker:
            smart_error_msg = generate_smart_error_message(user_input_ticker, identification_type)
            return jsonify({'error': smart_error_msg}), 400
        
        yahoo_ticker = to_yahoo_format(normalized_ticker)
        ticker = normalized_ticker
        
        print(f"[TREND_API] 标准化结果: {user_input_ticker} -> {ticker}")
        
        # 设置数据获取范围
        # 使用明确的起止日期而不是range参数，以避免Yahoo Finance API的已知bug
        # (使用range参数可能会返回错误的数据粒度，如请求日线却返回周线数据)
        end_date = dt.datetime.now()

        if period_param.lower() == 'all':
            # period=ALL 使用20年数据（与主API保持一致）
            start_date = end_date - dt.timedelta(days=365*20)
        elif period_param.endswith('y'):
            # 解析年份参数，如 5y, 10y, 20y
            years = int(period_param.replace('y', ''))
            start_date = end_date - dt.timedelta(days=365*years)
        else:
            # 默认3年
            start_date = end_date - dt.timedelta(days=365*3)

        # 将日期转换为Unix时间戳
        period1 = int(start_date.timestamp())
        period2 = int(end_date.timestamp())

        # 获取股价数据
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?period1={period1}&period2={period2}&interval=1d"
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        
        yahoo_data = response.json()
        result = yahoo_data.get('chart', {}).get('result', [])
        if not result:
            return jsonify({'error': f"无法获取 '{ticker}' 的股价数据"}), 404
        
        res = result[0]
        timestamps = res.get('timestamp', [])
        ohlc = res.get('indicators', {}).get('quote', [{}])[0]
        
        if not timestamps or not ohlc.get('open'):
            return jsonify({'error': f"数据格式不完整，无法解析 '{ticker}' 的股价"}), 500
        
        # 创建DataFrame进行分析
        df = pd.DataFrame({
            'timestamp': timestamps,
            'open': ohlc['open'],
            'high': ohlc['high'],
            'low': ohlc['low'],
            'close': ohlc['close'],
            'volume': ohlc['volume']
        })
        
        # 清理数据
        df = df.dropna().copy()
        if df.empty:
            return jsonify({'error': '数据清理后为空'}), 500
        
        # 计算50日移动平均线（与前端保持一致）
        df['ma50'] = df['close'].rolling(window=50).mean()
        
        # 计算ZIG指标（从URL参数获取，默认值为25，基于MA50均线）
        zig_threshold = float(request.args.get('long_term_zig', 25))
        print(f"[TREND_API] 使用ZIG阈值: {zig_threshold}%，基于MA50均线")
        zig_series = calculate_zig(df['ma50'], zig_threshold)
        
        # 计算趋势区间
        market_phases = calculate_phases_from_zig(zig_series, df['timestamp'].tolist())
        
        # 如果指定了时间段，进行筛选
        if period_param != 'all':
            years = int(period_param.replace('y', ''))
            cutoff_date = dt.datetime.now() - dt.timedelta(days=365 * years)
            cutoff_timestamp = cutoff_date.timestamp()
            
            # 筛选指定时间段内的区间
            filtered_phases = []
            for phase in market_phases:
                phase_start = dt.datetime.strptime(phase['start_date'], '%Y-%m-%d').timestamp()
                if phase_start >= cutoff_timestamp:
                    filtered_phases.append(phase)
            market_phases = filtered_phases
        
        # 获取注释数据
        db = get_db()
        cursor = db.cursor()
        if IS_PRODUCTION: # V5.0
            cursor.execute('''
                SELECT date, text, annotation_type, algorithm_type
                FROM annotations 
                WHERE ticker = %s AND is_deleted = 0
                ORDER BY date ASC
            ''', (ticker,))
        else:
            cursor.execute('''
                SELECT date, text, annotation_type, algorithm_type
                FROM annotations 
                WHERE ticker = ? AND is_deleted = 0
                ORDER BY date ASC
            ''', (ticker,))
        
        annotations_data = cursor.fetchall()
        cursor.close()
        db.close()
        
        # 为每个区间关联异常点
        trend_periods = []
        for phase in market_phases:
            # 转换phase类型为中文
            phase_chinese = "上涨区间" if phase['phase'] == 'Uptrend' else "下跌区间"
            
            # 计算区间持续天数
            start_date = dt.datetime.strptime(phase['start_date'], '%Y-%m-%d')
            end_date = dt.datetime.strptime(phase['end_date'], '%Y-%m-%d')
            duration_days = (end_date - start_date).days
            
            # 获取起始和结束日期的股价
            start_timestamp = start_date.timestamp()
            end_timestamp = end_date.timestamp()
            
            # 从DataFrame中查找最接近的股价数据
            start_price = None
            end_price = None
            price_change_pct = None
            
            # 查找起始日期的股价（收盘价）
            start_idx = (df['timestamp'] - start_timestamp).abs().idxmin()
            if not pd.isna(df.loc[start_idx, 'close']):
                start_price = round(df.loc[start_idx, 'close'], 2)
            
            # 查找结束日期的股价（收盘价）
            end_idx = (df['timestamp'] - end_timestamp).abs().idxmin()
            if not pd.isna(df.loc[end_idx, 'close']):
                end_price = round(df.loc[end_idx, 'close'], 2)
            
            # 计算涨跌幅
            if start_price and end_price:
                price_change_pct = round(((end_price - start_price) / start_price) * 100, 2)
            
            # 筛选该区间内的异常点
            period_anomalies = []
            for annotation in annotations_data:
                annotation_date = dt.datetime.strptime(annotation['date'], '%Y-%m-%d')
                if start_date <= annotation_date <= end_date:
                    anomaly_type = annotation['algorithm_type'] if annotation['annotation_type'] == 'algorithm' else 'manual'
                    period_anomalies.append({
                        'date': annotation['date'],
                        'text': annotation['text'],
                        'type': anomaly_type
                    })
            
            trend_periods.append({
                'phase': phase_chinese,
                'start_date': phase['start_date'],
                'end_date': phase['end_date'],
                'duration_days': duration_days,
                'start_price': start_price,
                'end_price': end_price,
                'price_change_pct': price_change_pct,
                'anomalies': period_anomalies
            })
        
        # V5.7: 优化最后一个区间，消除时间缺口问题
        if trend_periods:
            last_period = trend_periods[-1]
            last_end_date = dt.datetime.strptime(last_period['end_date'], '%Y-%m-%d')
            current_date = dt.datetime.now()
            
            # 检查是否存在时间缺口（超过30天）
            days_gap = (current_date - last_end_date).days
            if days_gap > 30:
                print(f"[TREND_API] 发现时间缺口: {days_gap}天，优化最后区间")
                
                # 获取最新股价数据（最后一个交易日的收盘价）
                latest_price = None
                latest_idx = df['close'].last_valid_index()
                if latest_idx is not None:
                    latest_price = round(df.loc[latest_idx, 'close'], 2)
                
                if latest_price and last_period['start_price']:
                    # 重新计算基于最新股价的涨跌幅
                    new_price_change_pct = round(((latest_price - last_period['start_price']) / last_period['start_price']) * 100, 2)
                    
                    # 重新计算持续天数
                    start_date = dt.datetime.strptime(last_period['start_date'], '%Y-%m-%d')
                    new_duration_days = (current_date - start_date).days
                    
                    # 更新最后一个区间
                    trend_periods[-1].update({
                        'end_date': current_date.strftime('%Y-%m-%d'),
                        'duration_days': new_duration_days,
                        'end_price': latest_price,
                        'price_change_pct': new_price_change_pct
                    })
                    
                    # V5.7.1: 重新筛选扩展区间内的anomalies，确保数据完整性
                    extended_end_date = current_date
                    start_date_obj = dt.datetime.strptime(last_period['start_date'], '%Y-%m-%d')
                    extended_anomalies = []
                    
                    print(f"[TREND_API] 重新筛选anomalies: {last_period['start_date']} -> {extended_end_date.strftime('%Y-%m-%d')}")
                    
                    for annotation in annotations_data:
                        annotation_date = dt.datetime.strptime(annotation['date'], '%Y-%m-%d')
                        if start_date_obj <= annotation_date <= extended_end_date:
                            anomaly_type = annotation['algorithm_type'] if annotation['annotation_type'] == 'algorithm' else 'manual'
                            extended_anomalies.append({
                                'date': annotation['date'],
                                'text': annotation['text'],
                                'type': anomaly_type
                            })
                    
                    # 更新anomalies
                    trend_periods[-1]['anomalies'] = extended_anomalies
                    print(f"[TREND_API] anomalies更新: {len(last_period['anomalies'])} -> {len(extended_anomalies)} 个事件")
                    
                    print(f"[TREND_API] 区间优化完成: {last_period['start_date']} -> {current_date.strftime('%Y-%m-%d')}, 涨跌幅: {new_price_change_pct}%")
        
        # V5.7.x: 如起始存在空白区间，向前延伸首个区间以填补缺口
        if trend_periods:
            earliest_ts = df['timestamp'].min()
            earliest_date = dt.datetime.fromtimestamp(earliest_ts).strftime('%Y-%m-%d')
            
            first_period = trend_periods[0]
            first_start_obj = dt.datetime.strptime(first_period['start_date'], '%Y-%m-%d')
            earliest_date_obj = dt.datetime.strptime(earliest_date, '%Y-%m-%d')
            
            if earliest_date_obj < first_start_obj:
                print(f"[TREND_API] 发现起始缺口: {first_period['start_date']} 之前存在数据，向前延伸至 {earliest_date}")
                
                end_date_obj = dt.datetime.strptime(first_period['end_date'], '%Y-%m-%d')
                first_period['start_date'] = earliest_date
                first_period['duration_days'] = (end_date_obj - earliest_date_obj).days
                
                # 重新计算起始价格与涨跌幅
                start_idx = (df['timestamp'] - earliest_date_obj.timestamp()).abs().idxmin()
                if not pd.isna(df.loc[start_idx, 'close']):
                    first_period['start_price'] = round(df.loc[start_idx, 'close'], 2)
                
                if first_period.get('start_price') and first_period.get('end_price'):
                    first_period['price_change_pct'] = round(((first_period['end_price'] - first_period['start_price']) / first_period['start_price']) * 100, 2)
                
                # 重新筛选延伸后区间内的异常点
                extended_anomalies = []
                for annotation in annotations_data:
                    annotation_date = dt.datetime.strptime(annotation['date'], '%Y-%m-%d')
                    if earliest_date_obj <= annotation_date <= end_date_obj:
                        anomaly_type = annotation['algorithm_type'] if annotation['annotation_type'] == 'algorithm' else 'manual'
                        extended_anomalies.append({
                            'date': annotation['date'],
                            'text': annotation['text'],
                            'type': anomaly_type
                        })
                
                first_period['anomalies'] = extended_anomalies
                print(f"[TREND_API] 起始区间延伸完成: {earliest_date} -> {first_period['end_date']}, 涨跌幅: {first_period.get('price_change_pct')}")
        
        # V5.7: 基于优化后的趋势区间判断当前股价状态
        current_trend = None
        if trend_periods:
            latest_period = trend_periods[-1]
            current_start = dt.datetime.strptime(latest_period['start_date'], '%Y-%m-%d')
            current_duration = (dt.datetime.now() - current_start).days
            
            current_trend = {
                'phase': latest_period['phase'],
                'start_date': latest_period['start_date'],
                'duration_days': current_duration,
                'current_price': latest_period['end_price'],
                'start_price': latest_period['start_price'],
                'price_change_pct': latest_period['price_change_pct']
            }
        
        # 计算统计信息
        uptrend_periods = [p for p in trend_periods if p['phase'] == '上涨区间']
        downtrend_periods = [p for p in trend_periods if p['phase'] == '下跌区间']
        
        total_uptrend_days = sum(p['duration_days'] for p in uptrend_periods)
        total_downtrend_days = sum(p['duration_days'] for p in downtrend_periods)
        total_anomalies = sum(len(p['anomalies']) for p in trend_periods)
        
        # 设置分析时间段描述
        if period_param == 'all':
            period_desc = f"全部历史数据"
        else:
            years = int(period_param.replace('y', ''))
            start_date = dt.datetime.now() - dt.timedelta(days=365 * years)
            period_desc = f"{start_date.strftime('%Y-%m-%d')} 至 {dt.datetime.now().strftime('%Y-%m-%d')}"
        
        return jsonify({
            'success': True,
            'ticker': user_input_ticker,
            'analysis_period': period_desc,
            'zig_threshold_used': zig_threshold,
            'current_trend': current_trend,
            'trend_periods': trend_periods,
            'statistics': {
                'total_uptrend_days': total_uptrend_days,
                'total_downtrend_days': total_downtrend_days,
                'uptrend_periods': len(uptrend_periods),
                'downtrend_periods': len(downtrend_periods),
                'total_anomalies': total_anomalies
            }
        })
        
    except Exception as e:
        print(f"[ERROR] 趋势分析API失败: {str(e)}")
        return jsonify({'error': f'趋势分析失败: {str(e)}'}), 500

@app.route('/api/stock-list/update', methods=['POST'])
@require_api_auth
def update_stock_list():
    """手动更新股票名单缓存API"""
    try:
        print("[API] 收到股票名单更新请求")
        
        # 更新股票名单缓存
        updated_count = update_stock_list_cache()
        
        return jsonify({
            'success': True,
            'message': f'股票名单缓存更新完成，处理了 {updated_count} 条记录',
            'updated_count': updated_count
        })
        
    except Exception as e:
        print(f"[ERROR] 股票名单更新API失败: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/stock-list/stats', methods=['GET'])
@require_api_auth
def get_stock_list_stats():
    """获取股票名单缓存统计信息API"""
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 统计总数
        cursor.execute("SELECT COUNT(*) as total FROM company_names")
        total = cursor.fetchone()['total']
        
        # 按来源统计
        cursor.execute("""
            SELECT source, COUNT(*) as count 
            FROM company_names 
            GROUP BY source 
            ORDER BY count DESC
        """)
        source_stats = [{'source': row['source'], 'count': row['count']} for row in cursor.fetchall()]
        
        # 按交易所统计（通过ticker后缀判断）
        cursor.execute("""
            SELECT 
                CASE 
                    WHEN ticker LIKE '%.SZ' THEN 'SZ'
                    WHEN ticker LIKE '%.SH' THEN 'SH'
                    WHEN ticker LIKE '%.hk' OR ticker LIKE '%.HK' THEN 'HK'
                    ELSE 'OTHER'
                END as exchange,
                COUNT(*) as count
            FROM company_names
            GROUP BY exchange
            ORDER BY count DESC
        """)
        exchange_stats = [{'exchange': row['exchange'], 'count': row['count']} for row in cursor.fetchall()]
        
        cursor.close()
        db.close()
        
        return jsonify({
            'success': True,
            'stats': {
                'total_companies': total,
                'by_source': source_stats,
                'by_exchange': exchange_stats
            }
        })
        
    except Exception as e:
        print(f"[ERROR] 获取股票名单统计失败: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# --- V4.8.1: 新增特定日期股价波动获取API，用于手动注释AI分析 ---
@app.route('/api/stock_data/<string:ticker>/<string:date>')
@require_api_auth
def get_stock_data_for_date(ticker, date):
    """获取特定日期的股价波动数据，用于AI分析空内容的手动注释"""
    print(f"[API] 获取股价波动数据: {ticker} on {date}")
    
    try:
        # 标准化股票代码
        normalized_ticker, identification_type = normalize_ticker(ticker)
        if not normalized_ticker:
            smart_error_msg = generate_smart_error_message(ticker, identification_type)
            return jsonify({'error': smart_error_msg}), 400
        
        # 为Yahoo API准备正确格式
        yahoo_ticker = to_yahoo_format(normalized_ticker)
        print(f"[API] 使用Yahoo格式: {yahoo_ticker}")
        
        # 获取最近30天的数据以确保包含目标日期
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?range=1mo&interval=1d"
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        
        yahoo_data = response.json()
        result = yahoo_data.get('chart', {}).get('result', [])
        if not result:
            return jsonify({'error': f"无法获取 {ticker} 的股价数据"}), 404
        
        res = result[0]
        timestamps = res.get('timestamp', [])
        ohlc = res.get('indicators', {}).get('quote', [{}])[0]
        
        if not timestamps or not ohlc.get('open'):
            return jsonify({'error': f"股价数据格式不完整"}), 500
        
        # 转换为DataFrame
        df = pd.DataFrame({
            'timestamp': timestamps,
            'open': ohlc['open'],
            'high': ohlc['high'],
            'low': ohlc['low'],
            'close': ohlc['close'],
            'volume': ohlc.get('volume', [0] * len(timestamps))
        })
        
        # 过滤无效数据
        df = df.dropna()
        if df.empty:
            return jsonify({'error': f"没有有效的股价数据"}), 404
        
        # 转换时间戳为日期
        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.strftime('%Y-%m-%d')
        
        # 查找目标日期的数据
        target_data = df[df['date'] == date]
        if target_data.empty:
            return jsonify({'error': f"未找到 {date} 的股价数据"}), 404
        
        row = target_data.iloc[0]
        
        # 计算涨跌幅（需要前一交易日数据）
        prev_data = df[df['date'] < date].tail(1)
        if not prev_data.empty:
            prev_close = prev_data.iloc[0]['close']
            change_pct = ((row['close'] - prev_close) / prev_close) * 100
        else:
            change_pct = 0
        
        # 计算当日振幅
        amplitude = ((row['high'] - row['low']) / row['low']) * 100
        
        # 获取公司名称
        company_name = get_company_name(normalized_ticker)
        
        # 格式化数据为AI友好的文本
        volatility_text = f"""股价波动情况：
开盘价：{row['open']:.2f}
最高价：{row['high']:.2f}
最低价：{row['low']:.2f}
收盘价：{row['close']:.2f}
成交量：{int(row['volume']):,}
涨跌幅：{change_pct:+.2f}%
当日振幅：{amplitude:.2f}%"""
        
        # 格式化用户注释文本 - 为新建注释提供规范化内容
        formatted_annotation_text = f"""{company_name} {normalized_ticker} 股价异动时点：{date}
股价波动{change_pct:+.2f}%"""
        
        return jsonify({
            'success': True,
            'ticker': normalized_ticker,
            'company_name': company_name,
            'date': date,
            'volatility_text': volatility_text,
            'formatted_annotation_text': formatted_annotation_text,
            'data': {
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': int(row['volume']),
                'change_pct': round(change_pct, 2),
                'amplitude': round(amplitude, 2)
            }
        })
        
    except Exception as e:
        print(f"[ERROR] 获取股价波动数据失败: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'获取股价数据失败: {str(e)}'
        }), 500


# ===== 核心API路由 =====

@app.route('/api/annotations/<string:ticker>', methods=['GET'])
@require_api_auth
def get_annotations(ticker):
    """获取指定股票的所有注释数据"""
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 智能查询适配
        if IS_PRODUCTION: # V5.0
            query = """
                SELECT annotation_id, ticker, date, text, annotation_type, algorithm_type, 
                       algorithm_params, original_text, ai_analysis, is_favorite, created_at, updated_at
                FROM annotations 
                WHERE ticker = %s AND is_deleted = 0
                ORDER BY date DESC
            """
        else:
            query = """
                SELECT annotation_id, ticker, date, text, annotation_type, algorithm_type, 
                       algorithm_params, original_text, ai_analysis, is_favorite, created_at, updated_at
                FROM annotations 
                WHERE ticker = ? AND is_deleted = 0
                ORDER BY date DESC
            """
        
        cursor.execute(query, (ticker,))
        rows = cursor.fetchall()
        
        # 转换为字典列表
        annotations = []
        for row in rows:
            annotations.append({
                'annotation_id': row['annotation_id'],
                'ticker': row['ticker'], 
                'date': row['date'],
                'text': row['text'],
                'annotation_type': row['annotation_type'],
                'algorithm_type': row['algorithm_type'],
                'algorithm_params': row['algorithm_params'],
                'original_text': row['original_text'],
                'ai_analysis': row['ai_analysis'],
                'is_favorite': bool(row['is_favorite']) if row['is_favorite'] is not None else False,
                'created_at': str(row['created_at']),
                'updated_at': str(row['updated_at'])
            })
        
        cursor.close()
        db.close()
        
        return jsonify(annotations)
        
    except Exception as e:
        print(f"[ERROR] 获取注释失败: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/stock/<string:ticker>', methods=['GET'])  
def get_stock_basic(ticker):
    """获取股票基本信息"""
    try:
        # 获取公司名称
        company_name = get_company_name(ticker)
        
        return jsonify({
            'ticker': ticker,
            'company_name': company_name,
            'status': 'success'
        })
        
    except Exception as e:
        print(f"[ERROR] 获取股票基本信息失败: {str(e)}")
        return jsonify({'error': str(e)}), 500

# --- 数据库迁移管理API (仅限管理员) ---
@app.route('/admin/execute-migration', methods=['POST'])
@require_api_auth
def execute_migration():
    """
    安全的数据库迁移执行接口
    只允许执行预定义的INSERT语句
    """
    try:
        data = request.get_json()
        
        if not data or 'migration_type' not in data:
            return jsonify({'error': '缺少迁移类型参数'}), 400
        
        migration_type = data['migration_type']
        
        # 只允许特定的迁移类型
        if migration_type not in ['test_a_stocks', 'full_a_stocks']:
            return jsonify({'error': '不支持的迁移类型'}), 400
        
        # 安全检查：只允许INSERT OR IGNORE语句
        if migration_type == 'test_a_stocks':
            # 执行测试迁移（5条数据）
            test_data = [
                ('000001.SZ', '平安银行', '2025-07-13 10:18:18', 'stock_list_local', '2025-07-13 10:18:18'),
                ('000002.SZ', '万 科Ａ', '2025-07-13 10:18:18', 'stock_list_local', '2025-07-13 10:18:18'),
                ('603688.SH', '石英股份', '2025-07-13 10:18:18', 'stock_list_local', '2025-07-13 10:18:18'),
                ('000858.SZ', '五 粮 液', '2025-07-13 10:18:18', 'stock_list_local', '2025-07-13 10:18:18'),
                ('600036.SH', '招商银行', '2025-07-13 10:18:18', 'stock_list_local', '2025-07-13 10:18:18')
            ]
            
            db = get_db()
            cursor = db.cursor()
            success_count = 0
            
            for ticker, company_name, created_at, source, last_updated in test_data:
                try:
                    if USE_POSTGRESQL:
                        # PostgreSQL使用ON CONFLICT DO NOTHING
                        db_execute(cursor, '''
                            INSERT INTO company_names (ticker, company_name, created_at, source, last_updated) 
                            VALUES (%s, %s, %s, %s, %s) 
                            ON CONFLICT (ticker) DO NOTHING
                        ''', (ticker, company_name, created_at, source, last_updated))
                    else:
                        # SQLite使用INSERT OR IGNORE
                        db_execute(cursor, '''
                            INSERT OR IGNORE INTO company_names (ticker, company_name, created_at, source, last_updated) 
                            VALUES (?, ?, ?, ?, ?)
                        ''', (ticker, company_name, created_at, source, last_updated))
                    success_count += 1
                    print(f"[MIGRATION] 成功添加: {ticker} - {company_name}")
                except Exception as e:
                    print(f"[MIGRATION] 执行失败: {ticker} - {company_name} 错误: {str(e)}")
            
            db.commit()  # 提交事务！
            cursor.close()
            db.close()
            
            return jsonify({
                'success': True,
                'type': 'test_migration',
                'executed': success_count,
                'total': len(test_data),
                'message': f'测试迁移完成，成功执行 {success_count}/{len(test_data)} 条语句'
            })
            
        elif migration_type == 'full_a_stocks':
            # 执行完整的A股数据迁移
            migration_file = 'migration_a_stocks.sql'
            if not os.path.exists(migration_file):
                return jsonify({'error': 'migration_a_stocks.sql文件不存在，请确保文件存在'}), 400
            
            db = get_db()
            cursor = db.cursor()
            success_count = 0
            error_count = 0
            
            print(f"[MIGRATION] 开始执行完整A股数据迁移...")
            
            try:
                with open(migration_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # 解析SQL文件中的INSERT语句（支持INSERT OR IGNORE）
                import re
                insert_pattern = r"INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+company_names\s+\([^)]+\)\s+VALUES\s+\(([^)]+)\);"
                matches = re.findall(insert_pattern, content, re.IGNORECASE)
                
                total_records = len(matches)
                print(f"[MIGRATION] 找到{total_records}条待迁移数据")
                
                for match in matches:
                    try:
                        # 解析VALUES中的数据
                        values_str = match.strip()
                        # 简单解析，假设格式是: 'ticker', 'company_name', 'created_at', 'source', 'last_updated'
                        values_parts = [v.strip().strip("'\"") for v in values_str.split(',')]
                        
                        if len(values_parts) >= 5:
                            ticker, company_name, created_at, source, last_updated = values_parts[:5]
                            
                            if USE_POSTGRESQL:
                                # PostgreSQL使用ON CONFLICT DO NOTHING
                                db_execute(cursor, '''
                                    INSERT INTO company_names (ticker, company_name, created_at, source, last_updated) 
                                    VALUES (%s, %s, %s, %s, %s) 
                                    ON CONFLICT (ticker) DO NOTHING
                                ''', (ticker, company_name, created_at, source, last_updated))
                            else:
                                # SQLite使用INSERT OR IGNORE
                                db_execute(cursor, '''
                                    INSERT OR IGNORE INTO company_names (ticker, company_name, created_at, source, last_updated) 
                                    VALUES (?, ?, ?, ?, ?)
                                ''', (ticker, company_name, created_at, source, last_updated))
                            
                            success_count += 1
                            if success_count % 100 == 0:
                                print(f"[MIGRATION] 已处理 {success_count}/{total_records} 条记录...")
                        else:
                            error_count += 1
                    except Exception as e:
                        error_count += 1
                        print(f"[MIGRATION] 执行失败: {str(e)}")
                
                db.commit()  # 提交事务
                cursor.close()
                db.close()
                
                print(f"[MIGRATION] 完整迁移完成！成功: {success_count}, 失败: {error_count}")
                
                return jsonify({
                    'success': True,
                    'type': 'full_migration',
                    'executed': success_count,
                    'total': total_records,
                    'errors': error_count,
                    'message': f'完整迁移完成，成功执行 {success_count}/{total_records} 条记录，错误 {error_count} 条'
                })
                
            except Exception as e:
                db.rollback()
                cursor.close()
                db.close()
                print(f"[MIGRATION] 迁移过程出错: {str(e)}")
                return jsonify({'error': f'迁移过程出错: {str(e)}'}), 500
            
    except Exception as e:
        print(f"[ERROR] 迁移执行失败: {str(e)}")
        return jsonify({'error': f'迁移执行失败: {str(e)}'}), 500

@app.route('/admin/migration-status', methods=['GET'])
@require_api_auth  
def migration_status():
    """
    检查迁移状态 - 查看A股数据是否存在
    """
    try:
        db = get_db()
        cursor = db.cursor()
        
        # 检查关键A股简称是否存在
        test_companies = ['平安银行', '石英股份', '万 科Ａ', '招商银行', '五 粮 液']
        results = {}
        
        for company in test_companies:
            db_execute(cursor, "SELECT ticker FROM company_names WHERE company_name = %s", (company,))
            result = cursor.fetchone()
            results[company] = result['ticker'] if result else None
        
        # 统计A股数据总数
        db_execute(cursor, "SELECT COUNT(*) as count FROM company_names WHERE source = 'stock_list_local'")
        total_count = cursor.fetchone()['count']
        
        cursor.close()
        db.close()
        
        return jsonify({
            'success': True,
            'test_companies': results,
            'total_a_stocks': total_count,
            'migration_needed': total_count < 1000  # 如果少于1000条说明需要迁移
        })
        
    except Exception as e:
        print(f"[ERROR] 状态检查失败: {str(e)}")
        return jsonify({'error': f'状态检查失败: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
