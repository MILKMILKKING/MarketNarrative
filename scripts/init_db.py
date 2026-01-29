"""
MarketNarrative 本地数据库初始化脚本

功能：
1. 创建SQLite数据库
2. 初始化annotations表结构
3. 插入示例公司数据（用于展示）

使用方法：
    python scripts/init_db.py
"""

import sqlite3
import os
from datetime import datetime

# 数据库文件路径
DB_PATH = 'annotations.db'

def init_database():
    """初始化数据库和表结构"""
    print(f"[初始化] 开始创建数据库: {DB_PATH}")
    
    # 连接数据库（如果不存在会自动创建）
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 创建annotations表
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    )
    ''')
    
    print("✅ annotations表创建成功")
    
    # 创建索引以提升查询性能
    cursor.execute('''
    CREATE INDEX IF NOT EXISTS idx_ticker_period 
    ON annotations(ticker, period)
    ''')
    
    cursor.execute('''
    CREATE INDEX IF NOT EXISTS idx_start_date 
    ON annotations(start_date)
    ''')
    
    print("✅ 索引创建成功")
    
    # 提交更改
    conn.commit()
    conn.close()
    
    print(f"[完成] 数据库初始化成功: {DB_PATH}")
    print(f"[提示] 数据库文件大小: {os.path.getsize(DB_PATH)} 字节")

def insert_demo_data():
    """插入演示数据（可选）"""
    print("\n[演示数据] 开始插入示例注释...")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.now().isoformat()
    
    demo_annotations = [
        {
            'ticker': 'TSLA',
            'period': 'daily',
            'start_date': '2020-03-18',
            'end_date': '2020-03-18',
            'content': '【市场恐慌底】COVID-19疫情导致市场暴跌，特斯拉股价从900美元跌至350美元附近。此时市场普遍质疑：电动车在经济衰退中是否是伪需求？',
            'created_at': now,
            'updated_at': now,
            'is_favorite': 1
        },
        {
            'ticker': 'TSLA',
            'period': 'daily',
            'start_date': '2020-07-01',
            'end_date': '2020-07-02',
            'content': '【Q2交付量超预期】特斯拉宣布Q2交付9.065万辆，远超华尔街预期的7.2万辆。市场叙事开始转变：疫情反而加速了消费者对个人交通工具的偏好。',
            'created_at': now,
            'updated_at': now,
            'is_favorite': 1
        },
        {
            'ticker': '600519.SH',
            'period': 'daily',
            'start_date': '2021-02-18',
            'end_date': '2021-02-18',
            'content': '【春节效应】春节前白酒消费旺季，贵州茅台股价创历史新高，市值突破3万亿元。',
            'created_at': now,
            'updated_at': now
        }
    ]
    
    for annotation in demo_annotations:
        cursor.execute('''
        INSERT INTO annotations 
        (ticker, period, start_date, end_date, content, created_at, updated_at, is_favorite)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            annotation['ticker'],
            annotation['period'],
            annotation['start_date'],
            annotation['end_date'],
            annotation['content'],
            annotation['created_at'],
            annotation['updated_at'],
            annotation.get('is_favorite', 0)
        ))
    
    conn.commit()
    conn.close()
    
    print(f"✅ 已插入 {len(demo_annotations)} 条演示数据")

if __name__ == '__main__':
    print("=" * 60)
    print(" MarketNarrative 数据库初始化工具")
    print("=" * 60)
    
    # 检查数据库是否已存在
    if os.path.exists(DB_PATH):
        response = input(f"\n⚠️  数据库文件 {DB_PATH} 已存在，是否覆盖？(y/N): ")
        if response.lower() != 'y':
            print("[取消] 初始化已取消")
            exit(0)
        else:
            os.remove(DB_PATH)
            print("[删除] 已删除旧数据库文件")
    
    # 初始化数据库
    init_database()
    
    # 询问是否插入演示数据
    response = input("\n是否插入演示数据？(Y/n): ")
    if response.lower() not in ['n', 'no']:
        insert_demo_data()
    
    print("\n" + "=" * 60)
    print("✅ 初始化完成！")
    print("=" * 60)
    print("\n下一步：")
    print("  1. python app.py")
    print("  2. 打开 http://localhost:5001")
    print("")
