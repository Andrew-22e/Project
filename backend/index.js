const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

// 请求日志中间件
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url} - 来自: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 导入路由
const debateRoutes = require('./routes/debateRoutes');
const streamRoutes = require('./routes/streamRoutes');
const userRoutes = require('./routes/userRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');

// 使用路由 - 兼容原有路由结构
app.use('/api/admin', debateRoutes);
app.use('/api/admin', streamRoutes);
app.use('/api/admin', userRoutes);
app.use('/api', statisticsRoutes);

// 添加 v1 版本的路由支持，用于直播流辩题设置接口
app.use('/api/v1/admin', debateRoutes);
app.use('/api/v1/admin', streamRoutes);

// 兼容小程序端获取辩题接口
app.get('/api/v1/debate-topic', (req, res) => {
    try {
        const { debate, debateTopics } = require('./data/mockData');
        const streamId = req.query.stream_id;
        
        // 如果指定了直播流ID，查找对应辩题
        if (streamId) {
            const topic = debateTopics.find(t => t.streamId === streamId);
            if (topic) {
                // 返回直播流对应的辩题，确保字段名兼容
                res.json({
                    success: true,
                    data: {
                        id: topic.id,
                        title: topic.title,
                        description: topic.description,
                        leftPosition: topic.leftPosition,
                        rightPosition: topic.rightPosition,
                        leftSide: topic.leftPosition,  // 兼容字段
                        rightSide: topic.rightPosition  // 兼容字段
                    }
                });
                return;
            }
            // 如果指定了streamId但没有找到对应的辩题，返回404
            return res.status(404).json({
                success: false,
                message: '该直播流尚未设置辩题',
                error: 'DEBATE_TOPIC_NOT_FOUND'
            });
        }
        
        // 否则返回全局辩题
        res.json({
            success: true,
            data: {
                id: debate.id,
                title: debate.title,
                description: debate.description,
                leftPosition: debate.affirmativeSide || debate.leftSide || '正方',
                rightPosition: debate.negativeSide || debate.rightSide || '反方',
                leftSide: debate.affirmativeSide || debate.leftSide || '正方',
                rightSide: debate.negativeSide || debate.rightSide || '反方'
            }
        });
    } catch (error) {
        console.error('获取辩题失败:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: 'INTERNAL_ERROR'
        });
    }
});

// API说明页面
app.get('/', (req, res) => {
    const apiDocumentation = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API接口文档</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background-color: #f5f5f5;
            }
            h1 {
                color: #2c3e50;
                text-align: center;
                margin-bottom: 30px;
            }
            .api-section {
                background-color: white;
                border-radius: 8px;
                padding: 20px;
                margin-bottom: 20px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h2 {
                color: #3498db;
                margin-top: 0;
                border-bottom: 1px solid #eee;
                padding-bottom: 10px;
            }
            h3 {
                color: #2980b9;
            }
            .api-endpoint {
                background-color: #f8f9fa;
                padding: 15px;
                border-left: 4px solid #3498db;
                margin-bottom: 15px;
                border-radius: 0 4px 4px 0;
            }
            .method {
                display: inline-block;
                padding: 4px 8px;
                border-radius: 4px;
                font-weight: bold;
                font-size: 14px;
                margin-right: 10px;
            }
            .get {
                background-color: #28a745;
                color: white;
            }
            .post {
                background-color: #007bff;
                color: white;
            }
            .put {
                background-color: #ffc107;
                color: #212529;
            }
            .delete {
                background-color: #dc3545;
                color: white;
            }
            .url {
                font-family: 'Courier New', Courier, monospace;
                font-weight: bold;
                color: #666;
            }
            .description {
                margin-top: 10px;
                margin-left: 40px;
            }
            .note {
                background-color: #fff3cd;
                border: 1px solid #ffeaa7;
                border-radius: 4px;
                padding: 10px;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <h1>Live Debate 后端 API 接口文档</h1>
        
        <div class="api-section">
            <h2>🔍 基础信息</h2>
            <div class="note">
                <p><strong>服务地址：</strong>http://localhost:3000</p>
                <p><strong>API前缀：</strong>所有接口均以 <code>/api</code> 或 <code>/api/admin</code> 开头</p>
                <p><strong>返回格式：</strong>所有接口返回JSON格式数据，包含 code、message 和 data 字段</p>
            </div>
        </div>
        
        <div class="api-section">
            <h2>🛠️ 基础接口</h2>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/health</span>
                <div class="description">
                    <p>健康检查接口，用于验证服务是否正常运行</p>
                </div>
            </div>
        </div>
        
        <div class="api-section">
            <h2>📊 统计相关接口</h2>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/dashboard</span>
                <div class="description">
                    <p>获取仪表盘统计数据，包括用户统计、直播统计、辩论设置等</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/votes</span>
                <div class="description">
                    <p>获取投票统计数据</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method post">POST</span>
                <span class="url">/api/vote</span>
                <div class="description">
                    <p>提交投票</p>
                    <p>参数：{ "side": "affirmative" | "negative" }</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/live-schedule</span>
                <div class="description">
                    <p>获取直播计划</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method put">PUT</span>
                <span class="url">/api/live-schedule</span>
                <div class="description">
                    <p>更新直播计划</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/ai-status</span>
                <div class="description">
                    <p>获取AI状态</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method post">POST</span>
                <span class="url">/api/ai-control</span>
                <div class="description">
                    <p>控制AI功能</p>
                </div>
            </div>
        </div>
        
        <div class="api-section">
            <h2>🎭 辩论相关接口</h2>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/admin/debate</span>
                <div class="description">
                    <p>获取辩论设置</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method put">PUT</span>
                <span class="url">/api/admin/debate</span>
                <div class="description">
                    <p>更新辩论设置</p>
                </div>
            </div>
        </div>
        
        <div class="api-section">
            <h2>📹 直播流相关接口</h2>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/admin/streams</span>
                <div class="description">
                    <p>获取直播流列表</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method post">POST</span>
                <span class="url">/api/admin/streams</span>
                <div class="description">
                    <p>添加新的直播流</p>
                    <p>参数：{ "name": "流名称", "url": "流地址", "type": "hls|rtmp|flv", "description": "描述", "enabled": true|false }</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method put">PUT</span>
                <span class="url">/api/admin/streams/:id</span>
                <div class="description">
                    <p>更新直播流信息</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method delete">DELETE</span>
                <span class="url">/api/admin/streams/:id</span>
                <div class="description">
                    <p>删除直播流</p>
                </div>
            </div>
        </div>
        
        <div class="api-section">
            <h2>👥 用户相关接口</h2>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/admin/users</span>
                <div class="description">
                    <p>获取用户列表</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method get">GET</span>
                <span class="url">/api/admin/users/:id</span>
                <div class="description">
                    <p>获取单个用户信息</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method put">PUT</span>
                <span class="url">/api/admin/users/:id</span>
                <div class="description">
                    <p>更新用户信息</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method delete">DELETE</span>
                <span class="url">/api/admin/users/:id</span>
                <div class="description">
                    <p>删除用户</p>
                </div>
            </div>
            
            <div class="api-endpoint">
                <span class="method post">POST</span>
                <span class="url">/api/admin/login</span>
                <div class="description">
                    <p>用户登录</p>
                    <p>参数：{ "username": "用户名", "password": "密码" }</p>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
    
    res.send(apiDocumentation);
});

// 健康检查接口
app.get('/api/health', (req, res) => {
    res.json({
        code: 0,
        message: 'success',
        data: {
            status: 'ok',
            timestamp: new Date().toISOString(),
            service: 'live-debate-backend'
        }
    });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=====================================`);
    console.log(`🎯 后端服务启动成功`);
    console.log(`🔗 服务地址: http://localhost:${PORT}`);
    console.log(`=====================================`);
});

module.exports = app;