const express = require('express');
const app = express();
const cors = require('cors');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('http-proxy-middleware');
const serverCfg = require('./config/server-mode.node.js');
const { getCurrentServerConfig, printConfig, BACKEND_SERVER_URL, PRIORITIZE_BACKEND_SERVER } = serverCfg;

const currentConfig = getCurrentServerConfig();
// 强制使用8081端口，避免与网关(8080)冲突
const port = 8081;

// ==================== WebSocket 支持 ====================
// 尝试加载 ws 模块（如果未安装需要运行: npm install ws）
let WebSocketServer;
try {
	const ws = require('ws');
	WebSocketServer = ws.WebSocketServer;
} catch (error) {
	console.warn('⚠️  WebSocket 模块未安装，实时通信功能将不可用。请运行: npm install ws');
	WebSocketServer = null;
}

// WebSocket 客户端连接池
const wsClients = new Set();

// 创建 HTTP 服务器（用于支持 WebSocket）
const server = http.createServer(app);
let wss = null;

if (WebSocketServer) {
	wss = new WebSocketServer({ server, path: '/ws' });
	
	wss.on('connection', (ws, req) => {
		console.log('✅ WebSocket 客户端已连接:', req.socket.remoteAddress);
		wsClients.add(ws);
		
		// 发送欢迎消息和当前状态
		ws.send(JSON.stringify({
			type: 'connected',
			message: '已连接到实时数据服务'
		}));
		
		// 发送当前状态
		broadcastCurrentState(ws);
		
		ws.on('message', (message) => {
			try {
				const data = JSON.parse(message);
				handleWebSocketMessage(ws, data);
			} catch (error) {
				console.error('WebSocket 消息解析失败:', error);
			}
		});
		
		ws.on('close', () => {
			console.log('❌ WebSocket 客户端已断开');
			wsClients.delete(ws);
		});
		
		ws.on('error', (error) => {
			console.error('WebSocket 错误:', error);
			wsClients.delete(ws);
		});
	});
}

// WebSocket 消息处理
function handleWebSocketMessage(ws, data) {
	switch (data.type) {
		case 'ping':
			ws.send(JSON.stringify({ type: 'pong' }));
			break;
		case 'control-live':
			// 后台管理系统控制直播状态
			handleLiveControl(data);
			break;
		case 'update-debate':
			// 后台管理系统更新辩论设置
			handleDebateUpdate(data);
			break;
		default:
			console.log('未知的 WebSocket 消息类型:', data.type);
	}
}

// 广播消息给所有客户端
function broadcast(type, data) {
	if (!wss || wsClients.size === 0) return;
	
	const message = JSON.stringify({ type, data, timestamp: Date.now() });
	
	// 移除已关闭的连接
	wsClients.forEach(client => {
		if (client.readyState === 1) { // WebSocket.OPEN
			client.send(message);
		} else {
			wsClients.delete(client);
		}
	});
}

// 广播当前状态（用于新连接）
function broadcastCurrentState(ws) {
	if (!ws || ws.readyState !== 1) return;
	
	try {
		const db = require('./admin/db.js');
		const dashboard = db.statistics.getDashboard();
		const debate = db.debate.get();
		
		ws.send(JSON.stringify({
			type: 'state',
			data: {
				votes: currentVotes,
				debate: debate,
				dashboard: dashboard,
				liveStatus: dashboard.isLive
			},
			timestamp: Date.now()
		}));
	} catch (error) {
		console.error('发送当前状态失败:', error);
	}
}

// 处理直播控制
function handleLiveControl(data) {
	try {
		const db = require('./admin/db.js');
		const { action } = data; // 'start' 或 'stop'
		
		if (action === 'start') {
			// 开启直播
			const activeStream = db.streams.getActive();
			if (activeStream) {
				broadcast('live-status-changed', {
					status: 'started',
					streamUrl: activeStream.url,
					timestamp: Date.now()
				});
			}
		} else if (action === 'stop') {
			// 停止直播
			broadcast('live-status-changed', {
				status: 'stopped',
				timestamp: Date.now()
			});
		}
	} catch (error) {
		console.error('处理直播控制失败:', error);
	}
}

// 处理辩论设置更新
function handleDebateUpdate(data) {
	// 这个功能已经通过 REST API 实现了，这里可以添加额外的实时通知
	broadcast('debate-updated', {
		debate: data.debate,
		timestamp: Date.now()
	});
}

// CORS 配置 - 允许所有来源（开发环境）
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    credentials: true,
    maxAge: 86400 // 24小时预检请求缓存
}));

// 处理 OPTIONS 预检请求
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Max-Age', '86400');
    res.sendStatus(204);
});

// 确保JSON解析中间件在代理之前加载
app.use(express.json({ limit: '10mb' })); // 增加请求体大小限制

// ==================== 优先代理到后端服务器（如果启用） ====================
// 确保所有 API 请求都代理到网关服务器
console.log('🔗 启用后端服务器优先模式：所有 API 请求将优先代理到后端服务器');
console.log(`🔗 后端服务器地址: ${BACKEND_SERVER_URL}`);

// 创建代理中间件 - 代理所有 /api 开头的路径到网关服务器
const backendProxy = createProxyMiddleware({
	target: BACKEND_SERVER_URL,
	changeOrigin: true,
	pathRewrite: {
		// 保持路径不变，直接转发
		'^/api': '/api'
	},
	logger: console,
	onProxyReq: (proxyReq, req, res) => {
		console.log(`🔄 [代理] ${req.method} ${req.path} -> ${BACKEND_SERVER_URL}${req.path}`);
		// 确保POST请求的内容类型正确
		if (req.method === 'POST' || req.method === 'PUT') {
			proxyReq.setHeader('Content-Type', 'application/json');
			// 确保请求体数据被正确处理
			const bodyData = req.body;
			if (bodyData) {
				proxyReq.write(JSON.stringify(bodyData));
				proxyReq.end();
			}
		}
	},
	onProxyRes: (proxyRes, req, res) => {
		console.log(`✅ [代理] ${req.path} <- ${proxyRes.statusCode} ${BACKEND_SERVER_URL}`);
		// 确保CORS头正确设置
		proxyRes.headers['Access-Control-Allow-Origin'] = '*';
		proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
		proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
	},
	onError: (err, req, res) => {
		console.error(`❌ [代理错误] ${req.path}:`, err.message);
		if (!res.headersSent) {
			res.status(502).json({
				success: false,
				error: 'Bad Gateway',
				message: `无法连接到后端服务器 ${BACKEND_SERVER_URL}`,
				path: req.path,
				details: err.message
			});
		}
	}
});

// 在所有本地路由之前，添加代理中间件
// 使用 app.use('/api', ...) 确保所有 /api 开头的请求都被代理（包括 /api/v1/*）
app.use('/api', backendProxy);
console.log('✅ 代理中间件已成功配置');

// ==================== 后台管理路由（必须在代理之前） ====================
const path = require('path');

// 提供后台管理页面
app.get('/admin', (req, res) => {
	res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// 提供后台管理静态资源
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// 提供静态资源（图标、动画等）
app.use('/static', express.static(path.join(__dirname, 'static')));
// ==================== 后台管理路由结束 ====================

// 根路径处理，返回index.html
app.get('/', (req, res) => {
    // API测试页面
    const apiDocumentation = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API接口测试工具</title>
        <style>
            /* 全局样式 */
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }
            
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6;
                color: #333;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }
            
            .container {
                max-width: 1200px;
                margin: 0 auto;
                background: white;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
                overflow: hidden;
            }
            
            /* 头部样式 */
            .header {
                background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
                color: white;
                padding: 30px;
                text-align: center;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            }
            
            h1 {
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            
            .subtitle {
                font-size: 1.1rem;
                opacity: 0.9;
                margin-bottom: 20px;
            }
            
            /* 过滤区域 */
            .filter-container {
                margin-top: 20px;
            }
            
            .filter-input {
                padding: 12px 20px;
                width: 500px;
                max-width: 100%;
                border: none;
                border-radius: 25px;
                font-size: 16px;
                background: rgba(255, 255, 255, 0.95);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                transition: all 0.3s ease;
            }
            
            .filter-input:focus {
                outline: none;
                background: white;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
                transform: translateY(-2px);
            }
            
            /* 主要内容区域 */
            .content {
                padding: 30px;
            }
            
            .api-section {
                margin-bottom: 40px;
                background: white;
                border-radius: 12px;
                padding: 25px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
                transition: transform 0.3s ease, box-shadow 0.3s ease;
            }
            
            .api-section:hover {
                transform: translateY(-4px);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            }
            
            h2 {
                color: #2c3e50;
                margin-top: 0;
                margin-bottom: 25px;
                font-size: 1.8rem;
                border-bottom: 3px solid #3498db;
                padding-bottom: 12px;
                font-weight: 600;
            }
            
            .api-category {
                margin-bottom: 30px;
            }
            
            h3 {
                color: #34495e;
                margin-bottom: 15px;
                font-size: 1.3rem;
                padding-left: 10px;
                border-left: 4px solid #e74c3c;
            }
            
            /* API项样式 */
            .api-item {
                background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
                padding: 20px;
                margin-bottom: 20px;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                transition: all 0.3s ease;
                position: relative;
                overflow: hidden;
            }
            
            .api-item:hover {
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
                transform: translateX(5px);
            }
            
            .api-item::before {
                content: '';
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                width: 4px;
                background: #3498db;
            }
            
            .endpoint {
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                font-size: 16px;
                font-weight: 500;
                margin-bottom: 15px;
                word-break: break-all;
                color: #2c3e50;
            }
            
            /* 方法标签样式 */
            .method-tag {
                display: inline-block;
                padding: 4px 10px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: bold;
                color: white;
                margin-right: 8px;
            }
            
            .method-get {
                background-color: #27ae60;
            }
            
            .method-post {
                background-color: #3498db;
            }
            
            .method-put {
                background-color: #f39c12;
            }
            
            .method-delete {
                background-color: #e74c3c;
            }
            
            /* 按钮样式 */
            .actions {
                margin-bottom: 15px;
            }
            
            .test-btn, .toggle-btn {
                border: none;
                padding: 10px 18px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.3s ease;
                margin-right: 10px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
            
            .test-btn {
                background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
                color: white;
                box-shadow: 0 2px 6px rgba(39, 174, 96, 0.3);
            }
            
            .test-btn:hover {
                background: linear-gradient(135deg, #229954 0%, #27ae60 100%);
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(39, 174, 96, 0.4);
            }
            
            .test-btn:disabled {
                background: #95a5a6;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            
            .toggle-btn {
                background: linear-gradient(135deg, #3498db 0%, #5dade2 100%);
                color: white;
                box-shadow: 0 2px 6px rgba(52, 152, 219, 0.3);
            }
            
            .toggle-btn:hover {
                background: linear-gradient(135deg, #2980b9 0%, #3498db 100%);
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(52, 152, 219, 0.4);
            }
            
            /* 加载动画 */
            .loading {
                display: inline-block;
                width: 24px;
                height: 24px;
                border: 3px solid #f3f3f3;
                border-top: 3px solid #3498db;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin-left: 10px;
                display: none;
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            /* 请求体样式 */
            .request-body {
                margin-top: 15px;
                padding: 20px;
                background: rgba(248, 249, 250, 0.8);
                border-radius: 8px;
                border: 1px solid #dee2e6;
                transition: all 0.3s ease;
                display: none;
            }
            
            .request-body textarea {
                width: 100%;
                padding: 12px;
                border: 2px solid #ced4da;
                border-radius: 6px;
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                font-size: 14px;
                resize: vertical;
                min-height: 120px;
                background: white;
                transition: border-color 0.3s ease, box-shadow 0.3s ease;
            }
            
            .request-body textarea:focus {
                outline: none;
                border-color: #3498db;
                box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1);
            }
            
            /* 结果区域样式 */
            .result {
                margin-top: 20px;
                padding: 20px;
                background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
                display: none;
                transition: all 0.3s ease;
                animation: slideDown 0.3s ease-out;
            }
            
            @keyframes slideDown {
                from {
                    opacity: 0;
                    transform: translateY(-10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            .result h4 {
                margin-top: 0;
                margin-bottom: 15px;
                color: #1565c0;
                font-size: 1.1rem;
                font-weight: 600;
            }
            
            .result-content {
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                background: #2d3748;
                color: #a0aec0;
                padding: 16px;
                border-radius: 6px;
                max-height: 350px;
                overflow-y: auto;
                white-space: pre-wrap;
                word-break: break-all;
                border: 1px solid #4a5568;
                box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.15);
                font-size: 14px;
                line-height: 1.5;
            }
            
            /* 错误和成功状态 */
            .error {
                color: #e74c3c;
            }
            
            .success {
                color: #27ae60;
            }
            
            /* 响应式设计 */
            @media (max-width: 768px) {
                .container {
                    margin: 10px;
                    border-radius: 8px;
                }
                
                .header {
                    padding: 20px;
                }
                
                h1 {
                    font-size: 2rem;
                }
                
                .content {
                    padding: 20px;
                }
                
                .filter-input {
                    width: 100%;
                }
                
                .test-btn, .toggle-btn {
                    padding: 8px 12px;
                    font-size: 13px;
                    margin-right: 5px;
                    margin-bottom: 5px;
                }
                
                .api-item {
                    padding: 15px;
                }
                
                .endpoint {
                    font-size: 14px;
                }
            }
            
            @media (max-width: 480px) {
                body {
                    padding: 10px;
                }
                
                h1 {
                    font-size: 1.5rem;
                }
                
                .subtitle {
                    font-size: 0.9rem;
                }
                
                .content {
                    padding: 15px;
                }
                
                .api-section {
                    padding: 15px;
                }
                
                h2 {
                    font-size: 1.5rem;
                }
                
                h3 {
                    font-size: 1.1rem;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>API接口测试工具</h1>
                <p class="subtitle">快速测试和调试所有API接口</p>
                <div class="filter-container">
                    <input type="text" id="filter" class="filter-input" placeholder="搜索API接口...">
                </div>
            </div>
            
            <div class="content">
        
        <div class="api-section">
            <h2>GET方法API接口列表</h2>
            
            <div class="api-category">
                <h3>基础接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/health</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/health')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>统计接口</h3>
                
				<div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/dashboard</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/dashboard')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/votes</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/votes')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>

                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/live-schedule</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/live-schedule')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/ai-status</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/ai-status')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>  
            
			<div class="api-category">
                <h3>辩论接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/admin/debate</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/debate')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>直播流接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/admin/streams</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/streams')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>    

			<div class="api-category">
                <h3>管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/admin/users</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/users')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-get">GET</span>/api/admin/users/:id</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/users/:id')">测试</button>
                        <div class="loading"></div>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
               
            </div>
        </div>
        
        <!-- POST方法API接口列表 -->
        <div class="api-section">
            <h2>POST方法API接口列表</h2>
            
            <div class="api-category">
                <h3>用户相关接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/wechat-login</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/wechat-login', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"code": "mock_code"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/user-vote</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/user-vote', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"userId": "test_user", "voteType": "agree", "streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/comment</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/comment', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"userId": "test_user", "content": "测试评论", "streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/like</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/like', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"userId": "test_user", "contentId": "content_1", "type": "comment"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>直播管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/start</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/start', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"streamId": "stream_1", "title": "测试直播"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/stop</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/stop', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/control</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/control', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"action": "start", "streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/schedule</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/schedule', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"title": "预约直播", "scheduledTime": "2024-01-01T12:00:00Z", "streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/update-votes</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/update-votes', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"agree": 10, "disagree": 5, "streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/live/reset-votes</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/live/reset-votes', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"streamId": "stream_1"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>AI内容管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/ai/start</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/ai/start', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"topic": "AI技术发展"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/ai/stop</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/ai/stop', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/ai/toggle</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/ai/toggle', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"enabled": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/ai-content</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/ai-content', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"content": "AI生成的内容", "type": "text"}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>直播流管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-post">POST</span>/api/admin/streams</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/streams', 'POST')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"name": "测试直播流", "url": "http://example.com/live/stream.m3u8", "type": "hls", "description": "测试直播流描述", "enabled": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="api-section">
            <h2>PUT方法API接口列表</h2>
            
            <div class="api-category">
                <h3>辩论管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-put">PUT</span>/api/admin/debate</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/debate', 'PUT')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"title": "测试辩题", "description": "测试辩题描述", "options": [{"id": "1", "content": "选项1"}, {"id": "2", "content": "选项2"}], "active": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>投票管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-put">PUT</span>/api/admin/votes</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/votes', 'PUT')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"optionId": "1", "increment": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>AI内容管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-put">PUT</span>/api/admin/ai-content/:id</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/ai-content/1', 'PUT')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"content": "更新后的AI内容", "type": "text", "enabled": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            
            <div class="api-category">
                <h3>直播流管理接口</h3>
                
                <div class="api-item">
                    <div class="endpoint"><span class="method-tag method-put">PUT</span>/api/admin/streams/:id</div>
                    <div class="actions">
                        <button class="test-btn" onclick="testApi(this, '/api/admin/streams/stream-001', 'PUT')">测试</button>
                        <button class="toggle-btn" onclick="toggleRequestBody(this.closest('.api-item'))">请求体</button>
                        <div class="loading"></div>
                    </div>
                    <div class="request-body" style="display: none; margin-top: 10px;">
                        <textarea rows="5" cols="80" placeholder="输入JSON格式的请求体...">{"name": "更新后的直播流", "url": "http://example.com/live/updated.m3u8", "type": "hls", "description": "更新后的描述", "enabled": true}</textarea>
                    </div>
                    <div class="result">
                        <h4>响应结果：</h4>
                        <div class="result-content"></div>
                    </div>
                </div>
            </div>
            </div>
        </div>
        
        <script>
            // 测试API接口 - 支持GET、POST和PUT
            async function testApi(button, endpoint, method = 'GET') {
                // 获取API项容器
                const apiItem = button.closest('.api-item');
                // 使用更可靠的方式查找loading元素和结果区域
                const loading = apiItem.querySelector('.loading');
                const resultDiv = apiItem.querySelector('.result');
                const resultContent = resultDiv.querySelector('.result-content');
                
                // 重置状态
                resultDiv.style.display = 'none';
                loading.style.display = 'inline-block';
                button.disabled = true;
                
                // 清除之前的定时器
                if (window.apiResultTimer) {
                    clearTimeout(window.apiResultTimer);
                }
                
                try {
                    let response;
                    
                    if (method === 'GET') {
                        response = await fetch(endpoint);
                    } else if (method === 'POST' || method === 'PUT') {
                        // 获取请求体输入框
                        const requestBodyDiv = apiItem.querySelector('.request-body');
                        let requestBody = {};
                        
                        if (requestBodyDiv) {
                            const requestBodyText = requestBodyDiv.querySelector('textarea').value;
                            try {
                                requestBody = requestBodyText ? JSON.parse(requestBodyText) : {};
                            } catch (parseError) {
                    
                                resultContent.classList.add('error');
                                resultDiv.style.display = 'block';
                                return;
                            }
                        }
                        
                        response = await fetch(endpoint, {
                            method: method,
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(requestBody)
                        });
                    }
                    
                    // 检查响应状态
                    if (!response.ok) {
                        
                    }
                    
                    const data = await response.json();
                    resultContent.textContent = JSON.stringify(data, null, 2);
                    resultContent.classList.remove('error');
                    resultContent.classList.add('success');
                    resultDiv.style.display = 'block';
                    
                    // 6秒后自动隐藏结果
                    window.apiResultTimer = setTimeout(() => {
                        resultDiv.style.display = 'none';
                    }, 6000);
                    
                } catch (error) {
                    
                    resultContent.classList.add('error');
                    resultContent.classList.remove('success');
                    resultDiv.style.display = 'block';
                    
                    // 6秒后自动隐藏结果
                    window.apiResultTimer = setTimeout(() => {
                        resultDiv.style.display = 'none';
                    }, 6000);
                } finally {
                    loading.style.display = 'none';
                    button.disabled = false;
                }
            }
            
            // 搜索过滤功能
            document.getElementById('filter').addEventListener('input', function(e) {
                const searchTerm = e.target.value.toLowerCase();
                const apiItems = document.querySelectorAll('.api-item');
                
                apiItems.forEach(item => {
                    const endpoint = item.querySelector('.endpoint').textContent.toLowerCase();
                    if (endpoint.includes(searchTerm)) {
                        item.style.display = 'block';
                    } else {
                        item.style.display = 'none';
                    }
                });
            });
            
            // 切换请求体输入框显示/隐藏
            function toggleRequestBody(apiItem) {
                const requestBodyDiv = apiItem.querySelector('.request-body');
                if (requestBodyDiv) {
                    requestBodyDiv.style.display = requestBodyDiv.style.display === 'none' ? 'block' : 'none';
                }
            }
        </script>
    </body>
    </html>`;
 
    res.send(apiDocumentation);
});

// 提供前端静态文件服务
app.use(express.static(path.join(__dirname, '.')));

// ==================== 直播流代理（SRS 服务器） ====================
// 将直播流请求代理到 SRS 服务器，让小程序通过中间层访问
const SRS_SERVER_URL = 'http://192.168.31.189:8086';

const srsProxy = createProxyMiddleware({
	target: SRS_SERVER_URL,
	changeOrigin: true,
	logger: console,
	// 路径重写：保留 /live 前缀
	// 请求: /live/test.m3u8 -> 转发到: http://192.168.31.189:8086/live/test.m3u8
	// 注意：app.use('/live', proxy) 会自动移除 /live 前缀，所以需要手动加回来
	pathRewrite: (path, req) => {
		// 如果路径不包含 /live，添加 /live 前缀
		if (!path.startsWith('/live')) {
			return '/live' + path;
		}
		return path;
	},
	onProxyReq: (proxyReq, req, res) => {
		console.log(`📺 [直播流代理] ${req.method} ${req.path} -> ${SRS_SERVER_URL}${proxyReq.path}`);
	},
	onProxyRes: (proxyRes, req, res) => {
		// 设置 CORS 头，允许小程序访问
		proxyRes.headers['Access-Control-Allow-Origin'] = '*';
		proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
		proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Range';
		proxyRes.headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range';
		console.log(`✅ [直播流代理] ${req.path} <- ${proxyRes.statusCode} ${SRS_SERVER_URL}`);
	},
	onError: (err, req, res) => {
		console.error(`❌ [直播流代理错误] ${req.path}:`, err.message);
		if (!res.headersSent) {
			res.status(502).json({
				success: false,
				error: 'Bad Gateway',
				message: `无法连接到 SRS 服务器 ${SRS_SERVER_URL}`,
				path: req.path,
				details: err.message
			});
		}
	}
});

// 在所有路由之前添加直播流代理（在 API 代理之后，但在其他路由之前）
app.use('/live', srsProxy);
console.log('✅ 直播流代理已配置: /live/* -> ' + SRS_SERVER_URL);

// ==================== 后台管理 API（仅在非优先后端模式时使用） ====================
const db = require('./admin/db.js');

// 管理API - 直播流管理（完整实现见下方 ==================== 直播流管理接口 ==================== 部分）

// 管理API - 辩论设置
app.get('/api/admin/debate', (req, res) => {
	try {
		const debate = db.debate.get();
		res.json(debate);
	} catch (error) {
		console.error('获取辩论设置失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

app.put('/api/admin/debate', (req, res) => {
	try {
		const debate = db.debate.update(req.body);
		// 同步更新内存中的辩题
		debateTopic.title = debate.title;
		debateTopic.description = debate.description;
		
		// 广播辩论设置更新给所有客户端（包括小程序）
		broadcast('debate-updated', {
			debate: debate,
			timestamp: Date.now()
		});
		
		res.json(debate);
	} catch (error) {
		console.error('更新辩论设置失败:', error);
		res.status(500).json({ error: '更新失败' });
	}
});

// 管理API - 用户管理
app.get('/api/admin/users', (req, res) => {
	try {
		const users = db.users.getAll();
		res.json(users);
	} catch (error) {
		console.error('获取用户列表失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

app.get('/api/admin/users/:id', (req, res) => {
	try {
		const user = db.users.getById(req.params.id);
		if (!user) {
			return res.status(404).json({ error: '用户不存在' });
		}
		res.json(user);
	} catch (error) {
		console.error('获取用户失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

// 获取当前辩题（小程序调用）- 完整实现见下方 API路由 部分

// 添加直播状态控制 API
let globalLiveStatus = {
	isLive: false,
	streamUrl: null,
	scheduledStartTime: null,
	scheduledEndTime: null,
	streamId: null,
	isScheduled: false,
	liveId: null,
	startTime: null
};

// 每个流的独立直播状态（支持多流同时管理）
// 格式: { streamId: { isLive: true/false, liveId: 'xxx', startTime: 'xxx', streamUrl: 'xxx' } }
let streamLiveStatuses = {};

// 添加AI识别状态管理
let globalAIStatus = {
	status: 'stopped',  // stopped / running / paused
	aiSessionId: null,
	startTime: null,
	settings: {
		mode: 'realtime',
		interval: 5000,
		sensitivity: 'high',
		minConfidence: 0.7
	},
	statistics: {
		totalContents: 0,
		totalWords: 0,
		averageConfidence: 0
	}
};

// 定时检查直播计划
let liveScheduleTimer = null;
let lastStopTime = 0; // 记录上次停止直播的时间，防止误触发自动重启

function checkLiveSchedule() {
	const db = require('./admin/db.js');
	const schedule = db.liveSchedule.get();
	const now = Date.now();
	
	if (schedule.isScheduled && schedule.scheduledStartTime) {
		const startTime = new Date(schedule.scheduledStartTime).getTime();
		
		// 🔧 修复：如果到了开始时间且还未开始
		if (now >= startTime && !globalLiveStatus.isLive) {
			// 检查是否刚刚停止直播（2分钟内）
			const timeSinceStop = now - lastStopTime;
			if (timeSinceStop < 120000) { // 2分钟内
				console.log(`⚠️ [定时检查] 检测到计划开始时间已到，但在${Math.floor(timeSinceStop/1000)}秒前刚停止直播，跳过自动启动，防止误触发`);
				// 清除这个过期的计划
				db.liveSchedule.clear();
				globalLiveStatus.isScheduled = false;
				globalLiveStatus.scheduledStartTime = null;
				globalLiveStatus.scheduledEndTime = null;
				return;
			}
			
			console.log('⏰ [定时检查] 定时开始直播');
			startScheduledLive(schedule);
		}
		
		// 如果有结束时间且已到结束时间
		if (schedule.scheduledEndTime && globalLiveStatus.isLive) {
			const endTime = new Date(schedule.scheduledEndTime).getTime();
			if (now >= endTime) {
				console.log('⏰ [定时检查] 定时结束直播');
				lastStopTime = Date.now(); // 记录停止时间
				stopLive();
			}
		}
	}
}

// 启动定时检查（每分钟检查一次）
function startScheduleCheck() {
	if (liveScheduleTimer) {
		clearInterval(liveScheduleTimer);
	}
	liveScheduleTimer = setInterval(checkLiveSchedule, 60000); // 每分钟检查一次
}

// 启动计划的直播
function startScheduledLive(schedule) {
	const db = require('./admin/db.js');
	
	try {
		let streamUrl = null;
		
		// 获取直播流
		if (schedule.streamId) {
			const stream = db.streams.getById(schedule.streamId);
			if (stream && stream.enabled) {
				streamUrl = stream.url;
			}
		}
		
		if (!streamUrl) {
			const activeStream = db.streams.getActive();
			if (activeStream) {
				streamUrl = activeStream.url;
			}
		}
		
		if (!streamUrl) {
			console.error('❌ 没有可用的直播流');
			return;
		}
		
		globalLiveStatus.isLive = true;
		globalLiveStatus.streamUrl = streamUrl;
		globalLiveStatus.streamId = schedule.streamId;
		
		// 广播直播状态变化
		broadcast('live-status-changed', {
			status: 'started',
			streamUrl: globalLiveStatus.streamUrl,
			timestamp: Date.now(),
			scheduled: true
		});
		
		console.log('✅ 直播已开始:', streamUrl);
	} catch (error) {
		console.error('启动计划直播失败:', error);
	}
}

// 停止直播
function stopLive() {
	globalLiveStatus.isLive = false;
	globalLiveStatus.streamUrl = null;
	globalLiveStatus.streamId = null;
	
	// 清除计划
	const db = require('./admin/db.js');
	db.liveSchedule.clear();
	globalLiveStatus.isScheduled = false;
	globalLiveStatus.scheduledStartTime = null;
	globalLiveStatus.scheduledEndTime = null;
	
	// 广播直播状态变化
	broadcast('live-status-changed', {
		status: 'stopped',
		timestamp: Date.now()
	});
	
		console.log('🛑 直播已停止');
}

// 管理端直播控制接口（管理员专用）
app.post('/api/admin/live/control', (req, res) => {
	try {
		const { action, streamUrl } = req.body;
		
		if (action === 'start') {
			if (!streamUrl) {
				const db = require('./admin/db.js');
				const activeStream = db.streams.getActive();
				if (!activeStream) {
					return res.status(400).json({ error: '没有可用的直播流' });
				}
				globalLiveStatus.streamUrl = activeStream.url;
			} else {
				globalLiveStatus.streamUrl = streamUrl;
			}
			globalLiveStatus.isLive = true;
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now()
			});
			
			res.json({ success: true, status: 'started', streamUrl: globalLiveStatus.streamUrl });
		} else if (action === 'stop') {
			stopLive();
			res.json({ success: true, status: 'stopped' });
		} else {
			res.status(400).json({ error: '无效的操作' });
		}
	} catch (error) {
		console.error('控制直播状态失败:', error);
		res.status(500).json({ error: '操作失败' });
	}
});

// 公开的直播控制接口（用户可直接调用）
app.post('/api/live/control', (req, res) => {
	try {
		const { action, streamId } = req.body;
		
		if (action === 'start') {
			const db = require('./admin/db.js');
			let selectedStream = null;
			
			// 如果指定了streamId，使用指定的直播流
			if (streamId) {
				selectedStream = db.streams.getById(streamId);
				if (!selectedStream) {
					return res.status(400).json({ 
						success: false,
						message: '指定的直播流不存在' 
					});
				}
				if (!selectedStream.enabled) {
					return res.status(400).json({ 
						success: false,
						message: '指定的直播流未启用' 
					});
				}
			} else {
				// 否则使用启用的直播流
				selectedStream = db.streams.getActive();
				if (!selectedStream) {
					return res.status(400).json({ 
						success: false,
						message: '没有可用的直播流，请先在后台管理系统中配置直播流' 
					});
				}
			}
			
			// 开始直播
			globalLiveStatus.isLive = true;
			globalLiveStatus.streamUrl = selectedStream.url;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = false;
			globalLiveStatus.scheduledStartTime = null;
			globalLiveStatus.scheduledEndTime = null;
			
			// 清除之前的计划
			db.liveSchedule.clear();
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now(),
				startedBy: 'user'
			});
			
			console.log('✅ 用户启动直播:', selectedStream.name, selectedStream.url);
			
			res.json({ 
				success: true, 
				message: '直播已开始',
				data: {
					status: 'started',
					streamUrl: globalLiveStatus.streamUrl,
					streamId: selectedStream.id,
					streamName: selectedStream.name
				}
			});
		} else if (action === 'stop') {
			stopLive();
			console.log('✅ 用户停止直播');
			res.json({ 
				success: true, 
				message: '直播已停止',
				data: {
					status: 'stopped'
				}
			});
		} else {
			res.status(400).json({ 
				success: false,
				message: '无效的操作，action 必须是 "start" 或 "stop"' 
			});
		}
	} catch (error) {
		console.error('用户控制直播状态失败:', error);
		res.status(500).json({ 
			success: false,
			message: '操作失败: ' + error.message 
		});
	}
});

// 设置直播计划
app.post('/api/admin/live/schedule', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const { scheduledStartTime, scheduledEndTime, streamId } = req.body;
		
		if (!scheduledStartTime) {
			return res.status(400).json({ error: '请设置直播开始时间' });
		}
		
		const startTime = new Date(scheduledStartTime).getTime();
		const now = Date.now();
		
		if (startTime <= now) {
			return res.status(400).json({ error: '开始时间必须晚于当前时间' });
		}
		
		// 验证直播流
		if (streamId) {
			const stream = db.streams.getById(streamId);
			if (!stream) {
				return res.status(400).json({ error: '指定的直播流不存在' });
			}
			if (!stream.enabled) {
				return res.status(400).json({ error: '指定的直播流未启用' });
			}
		} else {
			const activeStream = db.streams.getActive();
			if (!activeStream) {
				return res.status(400).json({ error: '没有可用的直播流' });
			}
		}
		
		// 保存计划
		const schedule = db.liveSchedule.update({
			scheduledStartTime,
			scheduledEndTime: scheduledEndTime || null,
			streamId: streamId || null,
			isScheduled: true
		});
		
		globalLiveStatus.scheduledStartTime = scheduledStartTime;
		globalLiveStatus.scheduledEndTime = scheduledEndTime || null;
		globalLiveStatus.streamId = streamId || null;
		globalLiveStatus.isScheduled = true;
		
		// 启动定时检查
		startScheduleCheck();
		
		// 广播计划更新
		broadcast('live-schedule-updated', {
			schedule: schedule,
			timestamp: Date.now()
		});
		
		res.json({
			success: true,
			message: '直播计划已设置',
			data: schedule
		});
	} catch (error) {
		console.error('设置直播计划失败:', error);
		res.status(500).json({ error: '设置失败' });
	}
});

// 获取直播计划
app.get('/api/admin/live/schedule', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const schedule = db.liveSchedule.get();
		res.json({
			success: true,
			data: schedule
		});
	} catch (error) {
		res.status(500).json({ error: '获取失败' });
	}
});

// 取消直播计划
app.post('/api/admin/live/schedule/cancel', (req, res) => {
	try {
		const db = require('./admin/db.js');
		db.liveSchedule.clear();
		
		globalLiveStatus.isScheduled = false;
		globalLiveStatus.scheduledStartTime = null;
		globalLiveStatus.scheduledEndTime = null;
		
		// 广播计划取消
		broadcast('live-schedule-cancelled', {
			timestamp: Date.now()
		});
		
		res.json({
			success: true,
			message: '直播计划已取消'
		});
	} catch (error) {
		res.status(500).json({ error: '取消失败' });
	}
});

app.get('/api/admin/live/status', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const schedule = db.liveSchedule.get();
		
		// 获取启用的直播流（即使直播未开始，也返回启用的流地址）
		let activeStream = null;
		try {
			activeStream = db.streams.getActive();
		} catch (error) {
			console.warn('获取启用直播流失败:', error);
		}
		
		res.json({
			...globalLiveStatus,
			schedule: schedule,
			// 如果直播未开始但有启用的流，返回流地址以便小程序使用
			activeStreamUrl: activeStream ? activeStream.url : null,
			activeStreamId: activeStream ? activeStream.id : null,
			activeStreamName: activeStream ? activeStream.name : null
		});
	} catch (error) {
		res.json(globalLiveStatus);
	}
});

// 一次性设置并开始直播（整合API）
app.post('/api/admin/live/setup-and-start', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const { streamId, scheduledStartTime, scheduledEndTime, startNow } = req.body;
		
		// 验证直播流
		let selectedStream = null;
		if (streamId) {
			selectedStream = db.streams.getById(streamId);
			if (!selectedStream) {
				return res.status(400).json({ error: '指定的直播流不存在' });
			}
			if (!selectedStream.enabled) {
				return res.status(400).json({ error: '指定的直播流未启用' });
			}
		} else {
			selectedStream = db.streams.getActive();
			if (!selectedStream) {
				return res.status(400).json({ error: '没有可用的直播流' });
			}
		}
		
		if (startNow) {
			// 立即开始直播
			globalLiveStatus.isLive = true;
			globalLiveStatus.streamUrl = selectedStream.url;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = false;
			globalLiveStatus.scheduledStartTime = null;
			globalLiveStatus.scheduledEndTime = null;
			
			// 清除之前的计划
			db.liveSchedule.clear();
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now(),
				startedBy: 'admin'
			});
			
			res.json({
				success: true,
				message: '直播已开始',
				data: {
					isLive: true,
					streamUrl: globalLiveStatus.streamUrl,
					streamId: selectedStream.id
				}
			});
		} else {
			// 设置定时开始
			if (!scheduledStartTime) {
				return res.status(400).json({ error: '请设置直播开始时间' });
			}
			
			const startTime = new Date(scheduledStartTime).getTime();
			const now = Date.now();
			
			if (startTime <= now) {
				return res.status(400).json({ error: '开始时间必须晚于当前时间' });
			}
			
			// 保存计划
			const schedule = db.liveSchedule.update({
				scheduledStartTime,
				scheduledEndTime: scheduledEndTime || null,
				streamId: selectedStream.id,
				isScheduled: true
			});
			
			globalLiveStatus.scheduledStartTime = scheduledStartTime;
			globalLiveStatus.scheduledEndTime = scheduledEndTime || null;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = true;
			
			// 启动定时检查
			startScheduleCheck();
			
			// 广播计划更新
			broadcast('live-schedule-updated', {
				schedule: schedule,
				timestamp: Date.now()
			});
			
			res.json({
				success: true,
				message: '直播计划已设置',
				data: schedule
			});
		}
	} catch (error) {
		console.error('设置并开始直播失败:', error);
		res.status(500).json({ error: '操作失败' });
	}
});

// ==================== 票数管理 API ====================
app.get('/api/admin/votes', (req, res) => {
	try {
		res.json({
			success: true,
			data: {
				leftVotes: currentVotes.leftVotes,
				rightVotes: currentVotes.rightVotes,
				totalVotes: currentVotes.leftVotes + currentVotes.rightVotes,
				leftPercentage: currentVotes.leftVotes + currentVotes.rightVotes > 0
					? Math.round((currentVotes.leftVotes / (currentVotes.leftVotes + currentVotes.rightVotes)) * 100)
					: 50,
				rightPercentage: currentVotes.leftVotes + currentVotes.rightVotes > 0
					? Math.round((currentVotes.rightVotes / (currentVotes.leftVotes + currentVotes.rightVotes)) * 100)
					: 50
			}
		});
	} catch (error) {
		res.status(500).json({ error: '获取票数失败' });
	}
});

app.put('/api/admin/votes', (req, res) => {
	try {
		const { leftVotes, rightVotes } = req.body;
		
		if (typeof leftVotes !== 'undefined' && typeof leftVotes !== 'number') {
			return res.status(400).json({ error: 'leftVotes 必须是数字' });
		}
		if (typeof rightVotes !== 'undefined' && typeof rightVotes !== 'number') {
			return res.status(400).json({ error: 'rightVotes 必须是数字' });
		}
		if ((typeof leftVotes !== 'undefined' && leftVotes < 0) || (typeof rightVotes !== 'undefined' && rightVotes < 0)) {
			return res.status(400).json({ error: '票数不能为负数' });
		}
		
		if (typeof leftVotes !== 'undefined') {
			currentVotes.leftVotes = leftVotes;
		}
		if (typeof rightVotes !== 'undefined') {
			currentVotes.rightVotes = rightVotes;
		}
		
		// 广播票数更新
		const totalVotes = currentVotes.leftVotes + currentVotes.rightVotes;
		broadcast('vote-updated', {
			votes: {
				leftVotes: currentVotes.leftVotes,
				rightVotes: currentVotes.rightVotes,
				totalVotes: totalVotes,
				leftPercentage: totalVotes > 0
					? Math.round((currentVotes.leftVotes / totalVotes) * 100)
					: 50,
				rightPercentage: totalVotes > 0
					? Math.round((currentVotes.rightVotes / totalVotes) * 100)
					: 50
			},
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: {
				leftVotes: currentVotes.leftVotes,
				rightVotes: currentVotes.rightVotes,
				totalVotes: totalVotes
			}
		});
	} catch (error) {
		res.status(500).json({ error: '修改票数失败' });
	}
});

app.post('/api/admin/votes/reset', (req, res) => {
	try {
		currentVotes.leftVotes = 0;
		currentVotes.rightVotes = 0;
		
		// 广播票数重置
		broadcast('vote-updated', {
			votes: {
				leftVotes: 0,
				rightVotes: 0,
				totalVotes: 0,
				leftPercentage: 50,
				rightPercentage: 50
			},
			updatedBy: 'admin',
			action: 'reset'
		});
		
		res.json({
			success: true,
			message: '票数已重置'
		});
	} catch (error) {
		res.status(500).json({ error: '重置票数失败' });
	}
});

// ==================== AI 内容管理 API ====================
app.get('/api/admin/ai-content', (req, res) => {
	try {
		res.json({
			success: true,
			data: aiDebateContent
		});
	} catch (error) {
		res.status(500).json({ error: '获取 AI 内容失败' });
	}
});

// ==================== v1 API 路由（兼容新版本前端） ====================
// 这些路由与上面的路由功能相同，但使用 /api/v1 前缀，支持认证token

// v1: 获取AI内容列表（必须在 /api/admin/ai-content/:id 之前定义，避免路由冲突）
app.get('/api/v1/admin/ai-content/list', (req, res) => {
	console.log('✅ v1 AI内容列表路由被调用:', req.query);
	try {
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const startTime = req.query.startTime || null;
		const endTime = req.query.endTime || null;
		const streamId = req.query.stream_id || null; // 🔧 添加 stream_id 参数支持
		
		// 验证pageSize最大值
		if (pageSize > 100) {
			return res.status(400).json({
				success: false,
				message: 'pageSize最大值为100'
			});
		}
		
		// 从 aiDebateContent 数组中获取数据
		let filteredContent = [...aiDebateContent];
		
		// 🔧 按 stream_id 过滤（如果提供）
		if (streamId) {
			filteredContent = filteredContent.filter(item => {
				// 如果内容有 streamId 字段，必须匹配
				// 如果内容没有 streamId 字段（旧数据），则不过滤（兼容旧数据）
				return !item.streamId || item.streamId === streamId;
			});
			console.log(`📊 按 stream_id=${streamId} 过滤后，剩余 ${filteredContent.length} 条数据`);
		}
		
		// 按时间过滤（如果有提供）
		if (startTime) {
			filteredContent = filteredContent.filter(item => {
				const itemTime = item.timestamp || item.createdAt || 0;
				return new Date(itemTime) >= new Date(startTime);
			});
		}
		if (endTime) {
			filteredContent = filteredContent.filter(item => {
				const itemTime = item.timestamp || item.createdAt || 0;
				return new Date(itemTime) <= new Date(endTime);
			});
		}
		
		// 计算总数
		const total = filteredContent.length;
		
		// 分页
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedContent = filteredContent.slice(start, end);
		
		// 转换为文档格式
		const items = paginatedContent.map(item => {
			// 计算评论数
			const commentCount = (item.comments && Array.isArray(item.comments)) ? item.comments.length : 0;
			
			// 转换timestamp为ISO格式
			let timestampISO = '';
			if (item.timestamp) {
				// 如果是时间戳（数字），转换为ISO格式
				if (typeof item.timestamp === 'number') {
					timestampISO = new Date(item.timestamp).toISOString();
				} else {
					timestampISO = new Date(item.timestamp).toISOString();
				}
			} else if (item.createdAt) {
				timestampISO = new Date(item.createdAt).toISOString();
			} else {
				timestampISO = new Date().toISOString();
			}
			
			return {
				id: item.id,
				content: item.content || item.text || '', // 优先使用content，如果没有则使用text
				type: 'summary', // 固定值
				timestamp: timestampISO,
				position: item.position || item.side || 'left', // side转换为position
				confidence: item.confidence || 0.95, // 默认置信度
				statistics: {
					views: (item.statistics && item.statistics.views) || item.views || 0,
					likes: (item.statistics && item.statistics.likes) || item.likes || 0,
					comments: commentCount // 只返回数量，不返回详细评论
				}
			};
		});
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				items: items
			}
		});
		
	} catch (error) {
		console.error('获取AI内容列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取AI内容列表失败: ' + error.message
		});
	}
});

// AI内容列表（必须在 /api/admin/ai-content/:id 之前定义，避免路由冲突）
app.get('/api/admin/ai-content/list', (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const startTime = req.query.startTime || null;
		const endTime = req.query.endTime || null;
		const streamId = req.query.stream_id || null; // 🔧 添加 stream_id 参数支持
		
		// 从 aiDebateContent 数组中获取数据
		let filteredContent = [...aiDebateContent];
		
		// 🔧 按 stream_id 过滤（如果提供）
		if (streamId) {
			filteredContent = filteredContent.filter(item => {
				// 如果内容有 streamId 字段，必须匹配
				// 如果内容没有 streamId 字段（旧数据），则不过滤（兼容旧数据）
				return !item.streamId || item.streamId === streamId;
			});
		}
		
		// 按时间过滤（如果有提供）
		if (startTime) {
			filteredContent = filteredContent.filter(item => 
				new Date(item.timestamp || item.createdAt || 0) >= new Date(startTime)
			);
		}
		if (endTime) {
			filteredContent = filteredContent.filter(item => 
				new Date(item.timestamp || item.createdAt || 0) <= new Date(endTime)
			);
		}
		
		// 计算总数
		const total = filteredContent.length;
		
		// 分页
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const items = filteredContent.slice(start, end);
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				pageSize: pageSize,
				items: items
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取AI内容列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取AI内容列表失败: ' + error.message
		});
	}
});

app.get('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		res.json({
			success: true,
			data: content
		});
	} catch (error) {
		res.status(500).json({ error: '获取 AI 内容失败' });
	}
});

// 获取AI内容评论列表（必须在 /api/admin/ai-content/:id/comments/:commentId 之前定义）
app.get('/api/admin/ai-content/:id/comments', (req, res) => {
	try {
		const { id } = req.params;
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表（从 content.comments 或 content.items.comments）
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		} else if (content.items && Array.isArray(content.items)) {
			// 如果评论在 items 数组中
			const contentItem = content.items.find(item => item.id === id);
			if (contentItem && contentItem.comments) {
				comments = contentItem.comments;
			}
		}
		
		// 分页
		const total = comments.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedComments = comments.slice(start, end);
		
		res.json({
			success: true,
			data: {
				contentId: id,
				contentText: content.content || content.text || '',
				total: total,
				page: page,
				pageSize: pageSize,
				comments: paginatedComments
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取AI内容评论列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取评论列表失败: ' + error.message
		});
	}
});

// 删除AI内容评论
app.delete('/api/admin/ai-content/:id/comments/:commentId', (req, res) => {
	try {
		const { id, commentId } = req.params;
		const { reason = '', notifyUsers = true } = req.body;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 查找评论
		const commentIndex = comments.findIndex(c => (c.commentId || c.id) === commentId);
		
		if (commentIndex === -1) {
			return res.status(404).json({
				success: false,
				message: '评论不存在'
			});
		}
		
		// 删除评论
		const deletedComment = comments.splice(commentIndex, 1)[0];
		
		// 更新内容中的评论数组
		content.comments = comments;
		
		// 更新统计数据
		if (content.statistics) {
			content.statistics.comments = (content.statistics.comments || 0) - 1;
		}
		
		// 如果通知用户，可以在这里发送WebSocket消息
		if (notifyUsers) {
			// broadcast('comment-deleted', { contentId: id, commentId: commentId });
		}
		
		console.log(`🗑️  已删除评论: ${commentId}, 原因: ${reason || '管理员删除'}`);
		
		res.json({
			success: true,
			data: {
				contentId: id,
				commentId: commentId,
				deleted: true
			},
			message: '评论已删除',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除评论失败:', error);
		res.status(500).json({
			success: false,
			message: '删除评论失败: ' + error.message
		});
	}
});

// v1: 获取AI内容评论列表
app.get('/api/v1/admin/ai-content/:id/comments', (req, res) => {
	try {
		const { id } = req.params;
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		
		// 验证pageSize最大值
		if (pageSize > 100) {
			return res.status(400).json({
				success: false,
				message: 'pageSize最大值为100'
			});
		}
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表（从 content.comments）
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 按时间倒序排序（最新的在前）
		comments.sort((a, b) => {
			const timeA = a.timestamp || a.time || 0;
			const timeB = b.timestamp || b.time || 0;
			// 如果是时间戳，直接比较；如果是ISO字符串，转换为时间戳比较
			const tsA = typeof timeA === 'number' ? timeA : new Date(timeA).getTime();
			const tsB = typeof timeB === 'number' ? timeB : new Date(timeB).getTime();
			return tsB - tsA; // 降序
		});
		
		// 分页
		const total = comments.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedComments = comments.slice(start, end);
		
		// 转换为文档格式
		const formattedComments = paginatedComments.map(comment => {
			// 转换timestamp为ISO格式
			let timestampISO = '';
			if (comment.timestamp) {
				if (typeof comment.timestamp === 'number') {
					timestampISO = new Date(comment.timestamp).toISOString();
				} else {
					timestampISO = new Date(comment.timestamp).toISOString();
				}
			} else if (comment.time) {
				// 如果只有time字段（如"刚刚"、"3分钟前"），使用当前时间
				timestampISO = new Date().toISOString();
			} else {
				timestampISO = new Date().toISOString();
			}
			
			// 判断是否为匿名用户
			const userId = comment.userId || 
				(comment.user === '匿名用户' || !comment.user ? 'anonymous' : null) || 
				'anonymous';
			
			return {
				commentId: comment.commentId || comment.id || '',
				userId: userId,
				nickname: comment.nickname || comment.user || '匿名用户',
				avatar: comment.avatar || '👤',
				content: comment.content || comment.text || '',
				likes: comment.likes || 0,
				timestamp: timestampISO
			};
		});
		
		res.json({
			success: true,
			data: {
				contentId: id,
				contentText: content.content || content.text || '',
				total: total,
				page: page,
				pageSize: pageSize,
				comments: formattedComments
			}
		});
		
	} catch (error) {
		console.error('获取AI内容评论列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取评论列表失败: ' + error.message
		});
	}
});

// v1: 删除AI内容评论
app.delete('/api/v1/admin/ai-content/:id/comments/:commentId', (req, res) => {
	try {
		const { id, commentId } = req.params;
		const { reason = '', notifyUsers = true } = req.body;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 查找评论（支持commentId或id字段）
		const commentIndex = comments.findIndex(c => {
			const cId = c.commentId || c.id;
			return cId === commentId || String(cId) === String(commentId);
		});
		
		if (commentIndex === -1) {
			return res.status(404).json({
				success: false,
				message: `评论ID ${commentId} 不存在或不属于内容ID ${id}`
			});
		}
		
		// 删除评论
		const deletedComment = comments.splice(commentIndex, 1)[0];
		
		// 更新内容中的评论数组
		content.comments = comments;
		
		// 更新统计数据
		if (content.statistics) {
			content.statistics.comments = (content.statistics.comments || 0) - 1;
		} else {
			content.statistics = {
				views: (content.statistics && content.statistics.views) || 0,
				likes: (content.statistics && content.statistics.likes) || content.likes || 0,
				comments: comments.length
			};
		}
		
		// 如果通知用户，通过WebSocket广播删除通知
		if (notifyUsers) {
			broadcast('comment-deleted', {
				contentId: id,
				commentId: commentId,
				timestamp: Date.now()
			});
		}
		
		console.log(`🗑️  已删除评论: ${commentId}, 原因: ${reason || '管理员删除'}`);
		
		// 按照文档格式返回响应
		res.json({
			success: true,
			data: {
				commentId: commentId,
				contentId: id,
				deleteTime: null // 由前端填充当前时间
			},
			message: '评论已删除'
		});
		
	} catch (error) {
		console.error('删除评论失败:', error);
		res.status(500).json({
			success: false,
			message: '删除评论失败: ' + error.message
		});
	}
});

app.post('/api/admin/ai-content', (req, res) => {
	try {
		const { text, side, debate_id, streamId } = req.body;
		
		if (!text || !side) {
			return res.status(400).json({ error: '缺少必要参数: text, side' });
		}
		
		if (side !== 'left' && side !== 'right') {
			return res.status(400).json({ error: 'side 必须是 "left" 或 "right"' });
		}
		
		const newContent = {
			id: uuidv4(),
			debate_id: debate_id || debateTopic.id,
			text: text.trim(),
			side: side,
			timestamp: new Date().getTime(),
			comments: [],
			likes: 0,
			streamId: streamId || globalLiveStatus.streamId || null // 🔧 添加 streamId 字段
		};
		
		aiDebateContent.push(newContent);
		
		// 广播新内容添加
		broadcast('newAIContent', {
			...newContent,
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: newContent
		});
	} catch (error) {
		res.status(500).json({ error: '添加 AI 内容失败' });
	}
});

app.put('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const { text, side, debate_id } = req.body;
		
		const index = aiDebateContent.findIndex(item => item.id === id);
		if (index === -1) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		if (text !== undefined) {
			aiDebateContent[index].text = text.trim();
		}
		if (side !== undefined) {
			if (side !== 'left' && side !== 'right') {
				return res.status(400).json({ error: 'side 必须是 "left" 或 "right"' });
			}
			aiDebateContent[index].side = side;
		}
		if (debate_id !== undefined) {
			aiDebateContent[index].debate_id = debate_id;
		}
		
		// 广播内容更新
		broadcast('ai-content-updated', {
			content: aiDebateContent[index],
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: aiDebateContent[index]
		});
	} catch (error) {
		res.status(500).json({ error: '更新 AI 内容失败' });
	}
});

app.delete('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const index = aiDebateContent.findIndex(item => item.id === id);
		
		if (index === -1) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		const deletedContent = aiDebateContent.splice(index, 1)[0];
		
		// 广播内容删除
		broadcast('aiContentDeleted', {
			contentId: id,
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			message: '删除成功',
			data: deletedContent
		});
	} catch (error) {
		res.status(500).json({ error: '删除 AI 内容失败' });
	}
});

// ==================== 后台管理 API 结束 ====================

// ==================== 统计 API（只读） ====================
app.get('/api/admin/statistics/summary', (req, res) => {
    try {
        const db = require('./admin/db.js');
        const stats = db.statistics.get();
        const users = db.users.getAll();
        const streams = db.streams.getAll();
        const totalVotes = stats.totalVotes || 0;
        const totalUsers = users.length;
        const totalStreams = streams.length;
        const totalLiveDays = Array.isArray(stats.dailyStats) ? stats.dailyStats.length : 0;
        res.json({
            success: true,
            data: {
                totalVotes,
                totalUsers,
                totalStreams,
                totalLiveDays
            }
        });
    } catch (error) {
        res.status(500).json({ error: '获取统计汇总失败' });
    }
});

app.get('/api/admin/statistics/daily', (req, res) => {
    try {
        const db = require('./admin/db.js');
        const stats = db.statistics.get();
        const daily = Array.isArray(stats.dailyStats) ? stats.dailyStats : [];
        res.json({ success: true, data: daily });
    } catch (error) {
        res.status(500).json({ error: '获取每日统计失败' });
    }
});

// 添加请求日志中间件（调试用）
app.use((req, res, next) => {
	if (req.path.startsWith('/api')) {
		console.log(`📥 API请求: ${req.method} ${req.path}`);
	}
	next();
});

// 静态文件服务（提供静态资源，如需要）
// 注意：uni-app 小程序项目通常不需要在服务器提供前端静态文件
// 如果需要提供构建后的静态文件，可以取消注释并配置正确路径
// app.use(express.static(path.join(__dirname, 'dist')));

// 注意：代理中间件已移动到所有本地路由之后（见 server.js 末尾，在 404 处理器之前）


// 模拟数据
let currentVotes = {
    leftVotes: 0,   // 正方票数
    rightVotes: 0   // 反方票数
};

// 辩题信息
const debateTopic = {
    id: 'debate-default-001', // 辩题ID，用于标识该辩题
    title: "如果有一个能一键消除痛苦的按钮，你会按吗？",
    description: "这是一个关于痛苦、成长与人性选择的深度辩论"
};

// AI智能识别的辩论内容
const aiDebateContent = [
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方观点：痛苦是人生成长的必要经历，消除痛苦会让我们失去学习和成长的机会。",
        side: "left",
        timestamp: new Date().getTime() - 300000, // 5分钟前
        comments: [
            {
                id: uuidv4(),
                user: "心理学家",
                text: "痛苦确实能促进心理成长，但过度的痛苦也可能造成创伤",
                time: "3分钟前",
                avatar: "🧠",
                likes: 15
            },
            {
                id: uuidv4(),
                user: "哲学家",
                text: "尼采说过，那些杀不死我们的，会让我们更强大",
                time: "4分钟前",
                avatar: "🤔",
                likes: 23
            }
        ],
        likes: 45
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "反方观点：如果能够消除痛苦，为什么不呢？痛苦本身没有价值，消除痛苦可以让人更专注于积极的事情。",
        side: "right",
        timestamp: new Date().getTime() - 240000, // 4分钟前
        comments: [
            {
                id: uuidv4(),
                user: "医生",
                text: "作为医生，我见过太多不必要的痛苦，如果能消除，我支持",
                time: "2分钟前",
                avatar: "👨‍⚕️",
                likes: 18
            },
            {
                id: uuidv4(),
                user: "患者家属",
                text: "看着亲人痛苦，我多么希望有这样的按钮",
                time: "3分钟前",
                avatar: "💝",
                likes: 31
            }
        ],
        likes: 52
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方回应：痛苦让我们学会同理心，如果所有人都没有痛苦经历，我们如何理解他人的苦难？",
        side: "left",
        timestamp: new Date().getTime() - 180000, // 3分钟前
        comments: [
            {
                id: uuidv4(),
                user: "社工",
                text: "同理心确实需要痛苦的经历来培养",
                time: "1分钟前",
                avatar: "🤝",
                likes: 12
            },
            {
                id: uuidv4(),
                user: "作家",
                text: "很多伟大的文学作品都源于作者的痛苦经历",
                time: "2分钟前",
                avatar: "📚",
                likes: 19
            }
        ],
        likes: 38
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "反方回应：我们可以通过其他方式培养同理心，比如阅读、教育。消除痛苦不等于消除所有负面情绪。",
        side: "right",
        timestamp: new Date().getTime() - 120000, // 2分钟前
        comments: [
            {
                id: uuidv4(),
                user: "教育工作者",
                text: "教育确实可以培养同理心，不一定需要亲身经历痛苦",
                time: "1分钟前",
                avatar: "👩‍🏫",
                likes: 16
            },
            {
                id: uuidv4(),
                user: "心理咨询师",
                text: "区分痛苦和负面情绪很重要，这个按钮可能只针对真正的痛苦",
                time: "刚刚",
                avatar: "💭",
                likes: 8
            }
        ],
        likes: 41
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方总结：痛苦是人性的一部分，消除痛苦可能会让我们失去作为人的完整性。",
        side: "left",
        timestamp: new Date().getTime() - 60000, // 1分钟前
        comments: [
            {
                id: uuidv4(),
                user: "神学家",
                text: "痛苦在宗教和哲学中都有其深层意义",
                time: "刚刚",
                avatar: "⛪",
                likes: 14
            }
        ],
        likes: 29
    }
];

// 模拟实时票数变化
function simulateVoteChanges() {
    setInterval(() => {
        if (!globalLiveStatus.isLive) return; // 只有直播时才模拟
        // 随机增加票数，模拟观众投票
        const leftIncrease = Math.floor(Math.random() * 5) + 1;
        const rightIncrease = Math.floor(Math.random() * 5) + 1;
        
        currentVotes.leftVotes += leftIncrease;
        currentVotes.rightVotes += rightIncrease;
        
        console.log(`票数更新: 正方 ${currentVotes.leftVotes}, 反方 ${currentVotes.rightVotes}`);
    }, 3000); // 每3秒更新一次
}

// 模拟AI识别新内容
function simulateNewAIContent() {
    const newContents = [
        {
            text: "正方补充：痛苦让我们珍惜快乐，没有对比就没有真正的幸福。",
            side: "left"
        },
        {
            text: "反方补充：现代医学已经在消除很多痛苦，这个按钮只是技术的延伸。",
            side: "right"
        },
        {
            text: "正方质疑：如果所有人都按这个按钮，社会会变成什么样？",
            side: "left"
        },
        {
            text: "反方回应：每个人都有自己的选择权，不应该强迫别人承受痛苦。",
            side: "right"
        }
    ];
    
    setInterval(() => {
        if (!globalLiveStatus.isLive) return; // 只有直播时才模拟AI内容
        const randomContent = newContents[Math.floor(Math.random() * newContents.length)];
        const newContent = {
            id: uuidv4(), // 使用UUID
            debate_id: debateTopic.id, // 标识该观点属于哪个辩题
            text: randomContent.text,
            side: randomContent.side,
            timestamp: new Date().getTime(),
            comments: [],
            likes: Math.floor(Math.random() * 20) + 10,
            streamId: globalLiveStatus.streamId || null // 🔧 添加 streamId 字段
        };
        
        aiDebateContent.push(newContent);
        console.log(`新增AI内容: ${newContent.text} (streamId: ${newContent.streamId})`);
    }, 15000); // 每15秒添加新内容
}

// API路由

// 获取当前票数
app.get('/api/votes', (req, res) => {
    try {
        const totalVotes = currentVotes.leftVotes + currentVotes.rightVotes;
        res.json({
            success: true,
            data: {
                leftVotes: currentVotes.leftVotes,
                rightVotes: currentVotes.rightVotes,
                totalVotes: totalVotes,
                leftPercentage: totalVotes > 0
                    ? Math.round((currentVotes.leftVotes / totalVotes) * 100)
                    : 50,
                rightPercentage: totalVotes > 0
                    ? Math.round((currentVotes.rightVotes / totalVotes) * 100)
                    : 50
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取票数时出错: " + error.message
        });
    }
});

// 获取辩题信息
app.get('/api/debate-topic', (req, res) => {
    try {
        // 确保返回的辩题信息包含 id 字段
        res.json({
            success: true,
            data: {
                id: debateTopic.id,
                title: debateTopic.title,
                description: debateTopic.description
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取辩题时出错: " + error.message
        });
    }
});

// 获取AI识别内容
app.get('/api/ai-content', (req, res) => {
    try {
        res.json({
            success: true,
            data: aiDebateContent
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取AI内容时出错: " + error.message
        });
    }
});

// 添加评论
app.post('/api/comment', (req, res) => {
    const { contentId, user, text, avatar } = req.body;

    // 参数验证
    if (!contentId || !text) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: contentId 和 text"
        });
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: "评论内容不能为空"
        });
    }

    const content = aiDebateContent.find(item => item.id === String(contentId));
    if (content) {
        // 使用UUID生成唯一的评论ID
        const newComment = {
            id: uuidv4(),
            user: user || "匿名用户",
            text: text.trim(),
            time: "刚刚",
            avatar: avatar || "👤",
            likes: 0
        };

        content.comments.push(newComment);

        res.json({
            success: true,
            data: newComment
        });
    } else {
        res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }
});

// 删除评论
app.delete('/api/comment/:commentId', (req, res) => {
    const { commentId } = req.params;
    const { contentId } = req.body;

    // 参数验证
    if (!commentId || !contentId) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: commentId 和 contentId"
        });
    }

    const content = aiDebateContent.find(item => item.id === String(contentId));
    if (!content) {
        return res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }

    const commentIndex = content.comments.findIndex(c => c.id === String(commentId));
    if (commentIndex === -1) {
        return res.status(404).json({
            success: false,
            message: "评论不存在"
        });
    }

    // 删除评论
    const deletedComment = content.comments.splice(commentIndex, 1)[0];

    res.json({
        success: true,
        data: {
            message: "评论删除成功",
            deletedComment: deletedComment
        }
    });
});

// 点赞
app.post('/api/like', (req, res) => {
    console.log('✅ /api/like 路由被调用');
    console.log('📥 请求参数:', { contentId: req.body.contentId, commentId: req.body.commentId });
    const { contentId, commentId } = req.body;

    // 参数验证
    if (!contentId) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: contentId"
        });
    }

    const content = aiDebateContent.find(item => item.id === contentId);
    if (content) {
        if (commentId !== undefined && commentId !== null) {
            // 评论点赞
            const comment = content.comments.find(c => c.id === commentId);
            if (comment) {
                comment.likes += 1;
                res.json({
                    success: true,
                    data: { likes: comment.likes }
                });
            } else {
                res.status(404).json({
                    success: false,
                    message: "评论不存在"
                });
            }
        } else {
            // 内容点赞
            content.likes += 1;
            res.json({
                success: true,
                data: { likes: content.likes }
            });
        }
    } else {
        res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }
});

// ==================== 微信登录辅助函数 ====================

/**
 * 调用微信API获取openid和session_key
 * @param {string} appid - 微信小程序AppID
 * @param {string} secret - 微信小程序AppSecret
 * @param {string} code - 微信登录code
 * @returns {Promise<Object>} 微信API响应数据
 */
function callWechatAPI(appid, secret, code) {
    return new Promise((resolve, reject) => {
        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (error) {
                    reject(new Error('解析微信API响应失败: ' + error.message));
                }
            });
        }).on('error', (error) => {
            reject(new Error('调用微信API失败: ' + error.message));
        });
    });
}

// 微信配置（从统一配置文件获取）
const WECHAT_CONFIG = {
    appid: currentConfig.wechat.appid,
    secret: process.env.WECHAT_SECRET || currentConfig.wechat.secret,
    useMock: currentConfig.wechat.useMock
};

// 微信登录接口
app.post('/api/wechat-login', async (req, res) => {
    const { code, userInfo, encryptedData, iv } = req.body;

    // 参数验证
    if (!code) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: code"
        });
    }

    try {
        console.log('═══════════════════════════════════════');
        console.log('微信登录请求收到');
        console.log('═══════════════════════════════════════');
        console.log('Code:', code);
        console.log('UserInfo:', userInfo && userInfo.nickName);
        console.log('useMock 配置:', WECHAT_CONFIG.useMock);
        console.log('═══════════════════════════════════════');
        
        let wechatData = null;
        
        // 根据配置决定使用模拟模式还是真实微信API
        if (WECHAT_CONFIG.useMock) {
            // 使用模拟模式（用于开发测试或 H5 环境）
            console.log('✅ 使用模拟微信登录响应（开发模式）');
            
            // 模拟微信API响应
            wechatData = {
                openid: 'mock_openid_' + Date.now(),
                session_key: 'mock_session_key_' + Math.random().toString(36).substr(2, 9),
                // 注意：真实API不会返回unionid，除非用户已绑定开放平台
            };
            
            console.log('模拟数据生成成功:', {
                openid: wechatData.openid,
                session_key: wechatData.session_key.substring(0, 10) + '...'
            });
        } else {
            // 使用真实微信API
            console.log('🌐 调用真实微信登录API');
            console.log('AppID:', WECHAT_CONFIG.appid);
            
            try {
                console.log('📋 微信登录配置信息:');
                console.log('  - AppID:', WECHAT_CONFIG.appid);
                console.log('  - Secret:', WECHAT_CONFIG.secret ? WECHAT_CONFIG.secret.substring(0, 8) + '...' : '未设置');
                console.log('  - Code:', code ? code.substring(0, 20) + '...' : '未提供');
                
                const apiResult = await callWechatAPI(WECHAT_CONFIG.appid, WECHAT_CONFIG.secret, code);
                
                // 检查微信API返回的错误
                if (apiResult.errcode) {
                    console.error('❌ 微信API返回错误:');
                    console.error('  - 错误码:', apiResult.errcode);
                    console.error('  - 错误信息:', apiResult.errmsg);
                    console.error('  - 完整响应:', JSON.stringify(apiResult, null, 2));
                    
                    // 特殊处理常见错误
                    let errorMessage = `微信API错误: ${apiResult.errmsg || '未知错误'}, rid: ${apiResult.errcode || 'N/A'}`;
                    if (apiResult.errcode === 40029) {
                        errorMessage = '微信API错误: invalid code (code无效或已过期), rid: ' + apiResult.errcode;
                    } else if (apiResult.errcode === 40163) {
                        errorMessage = '微信API错误: code been used (code已被使用), rid: ' + apiResult.errcode;
                    }
                    
                    return res.status(400).json({
                        success: false,
                        message: errorMessage
                    });
                }
                
                // 成功获取微信数据
                wechatData = {
                    openid: apiResult.openid,
                    session_key: apiResult.session_key,
                    unionid: apiResult.unionid || null
                };
                
                console.log('真实微信API调用成功:', {
                    openid: wechatData.openid,
                    hasSessionKey: !!wechatData.session_key,
                    hasUnionId: !!wechatData.unionid
                });
            } catch (error) {
                console.error('调用真实微信API失败:', error);
                return res.status(500).json({
                    success: false,
                    message: `调用微信API失败: ${error.message}`
                });
            }
        }
        
        // 保存用户到数据库（在管理系统中显示）
        const db = require('./admin/db.js');
        const userId = wechatData.openid; // 使用openid作为用户ID
        if (userId) {
            db.users.createOrUpdate({
                id: userId,
                nickName: (userInfo && userInfo.nickName) || '微信用户',
                avatarUrl: (userInfo && userInfo.avatarUrl) || '/static/logo.png'
            });
        }
        
        // 返回统一的响应格式
        const response = {
            success: true,
            data: {
                openid: wechatData.openid,
                session_key: wechatData.session_key,
                unionid: wechatData.unionid || null, // 如果有开放平台，会返回unionid
                userInfo: userInfo || {
                    nickName: '微信用户',
                    avatarUrl: '/static/logo.png'
                },
                loginTime: new Date().toISOString(),
                isMock: WECHAT_CONFIG.useMock || WECHAT_CONFIG.secret === 'YOUR_APP_SECRET_HERE'
            }
        };
        
        console.log('返回登录响应:', { 
            openid: response.data.openid,
            hasUserInfo: !!userInfo,
            isMock: response.data.isMock
        });
        
        res.json(response);
        
    } catch (error) {
        console.error('微信登录处理错误:', error);
        res.status(500).json({
            success: false,
            message: "服务器处理微信登录时出错: " + error.message
        });
    }
});

// 用户投票（支持100票分配制）
app.post('/api/user-vote', (req, res) => {
    console.log('═══════════════════════════════════════');
    console.log('✅ /api/user-vote 路由被调用');
    console.log('📥 请求来源:', req.headers.origin || req.headers.referer || '未知');
    console.log('📥 请求方法:', req.method);
    console.log('📥 请求参数:', req.body);
    console.log('📥 请求头:', {
        'content-type': req.headers['content-type'],
        'user-agent': (req.headers['user-agent'] && req.headers['user-agent'].substring(0, 50)) + '...'
    });
    console.log('═══════════════════════════════════════');
    
    const { side, votes, leftVotes, rightVotes, userId } = req.body;

    // 支持两种格式：
    // 格式1（增量投票）: { side: "left"|"right", votes: number }
    // 格式2（100票分配）: { leftVotes: number, rightVotes: number }
    
    let userLeftVotes = 0;
    let userRightVotes = 0;
    let voteMode = '';
    
    // 检测并解析不同格式
    if (leftVotes !== undefined && rightVotes !== undefined) {
        // 格式2：100票分配制
        voteMode = '100票分配制';
        userLeftVotes = parseInt(leftVotes) || 0;
        userRightVotes = parseInt(rightVotes) || 0;
        
        // 验证总票数是否为100
        const total = userLeftVotes + userRightVotes;
        if (total !== 100) {
            return res.status(400).json({
                success: false,
                message: `票数分配错误: 正方 ${userLeftVotes} + 反方 ${userRightVotes} = ${total}，必须等于100`
            });
        }
        
        if (userLeftVotes < 0 || userLeftVotes > 100 || userRightVotes < 0 || userRightVotes > 100) {
            return res.status(400).json({
                success: false,
                message: "参数错误: 票数必须在 0-100 之间"
            });
        }
        
        console.log(`📊 100票分配制投票: 正方 ${userLeftVotes} 票, 反方 ${userRightVotes} 票`);
        
        // 100票分配制：直接累加用户的票数
        currentVotes.leftVotes += userLeftVotes;
        currentVotes.rightVotes += userRightVotes;
        
    } else if (side && (votes !== undefined || votes === null)) {
        // 格式1：增量投票（兼容旧版本）
        voteMode = '增量投票';
        
        if (side !== 'left' && side !== 'right') {
            return res.status(400).json({
                success: false,
                message: "参数错误: side 必须为 'left' 或 'right'"
            });
        }

        const voteCount = parseInt(votes) || 10;
        if (voteCount < 1 || voteCount > 1000) {
            return res.status(400).json({
                success: false,
                message: "参数错误: 投票数量必须在 1-1000 之间"
            });
        }
        
        console.log(`📊 增量投票: ${side === 'left' ? '正方' : '反方'} +${voteCount} 票`);
        
        if (side === 'left') {
            currentVotes.leftVotes += voteCount;
            userLeftVotes = voteCount;
        } else {
            currentVotes.rightVotes += voteCount;
            userRightVotes = voteCount;
        }
        
    } else {
        return res.status(400).json({
            success: false,
            message: "参数错误: 请提供 { leftVotes, rightVotes } 或 { side, votes }"
        });
    }

    // 更新数据库统计（如果已加载）
    try {
        const db = require('./admin/db.js');
        if (userId) {
            const totalUserVotes = userLeftVotes + userRightVotes;
            db.users.updateStats(userId, { votes: totalUserVotes });
        }
        db.statistics.incrementVotes(userLeftVotes + userRightVotes);
    } catch (error) {
        // 如果数据库模块未加载，忽略错误
        console.log('统计数据更新跳过（开发模式）');
    }

    const total = currentVotes.leftVotes + currentVotes.rightVotes;
    const responseData = {
        success: true,
        data: {
            leftVotes: currentVotes.leftVotes,
            rightVotes: currentVotes.rightVotes,
            totalVotes: total,
            leftPercentage: total > 0
                ? Math.round((currentVotes.leftVotes / total) * 100)
                : 50,
            rightPercentage: total > 0
                ? Math.round((currentVotes.rightVotes / total) * 100)
                : 50
        },
        message: `投票成功 (${voteMode})`
    };
    
    console.log(`✅ 投票成功！当前总票数: 正方 ${currentVotes.leftVotes} (${responseData.data.leftPercentage}%), 反方 ${currentVotes.rightVotes} (${responseData.data.rightPercentage}%)`);

    // 广播投票更新给所有 WebSocket 客户端（包括后台管理系统）
    broadcast('votes-updated', {
        leftVotes: currentVotes.leftVotes,
        rightVotes: currentVotes.rightVotes,
        leftPercentage: responseData.data.leftPercentage,
        rightPercentage: responseData.data.rightPercentage,
        totalVotes: total,
        userVote: {
            userId: userId || 'anonymous',
            leftVotes: userLeftVotes,
            rightVotes: userRightVotes,
            mode: voteMode
        },
        timestamp: new Date().toISOString()
    });

    res.json(responseData);
});

// ==================== 后台管理系统控制接口 ====================

// 一、直播控制接口

// 1.1 开始直播
// 支持 /api/admin/live/start 和 /api/v1/admin/live/start 两种路径
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/live/start', handleStartLive);
	app.post('/api/v1/admin/live/start', handleStartLive);
}

function handleStartLive(req, res) {
	try {
		const { streamId, autoStartAI = false, notifyUsers = true } = req.body;
		
		// 获取直播流
		const db = require('./admin/db.js');
		let stream = null;
		
		if (streamId) {
			stream = db.streams.getById(streamId);
			if (!stream) {
				return res.status(404).json({
					success: false,
					message: '指定的直播流不存在'
				});
			}
		} else {
			stream = db.streams.getActive();
			if (!stream) {
				return res.status(400).json({
					success: false,
					message: '没有可用的直播流，请先配置直播流'
				});
			}
		}
		
		// 检查该流是否已经在直播
		if (streamLiveStatuses[stream.id] && streamLiveStatuses[stream.id].isLive) {
			return res.status(409).json({
				success: false,
				message: '该直播流已经在进行中'
			});
		}
		
		// ⚠️ 重要：停止所有其他正在直播的流
		for (const [otherStreamId, status] of Object.entries(streamLiveStatuses)) {
			if (otherStreamId !== stream.id && status.isLive) {
				console.log(`🛑 自动停止其他直播流: ${otherStreamId}`);
				streamLiveStatuses[otherStreamId].isLive = false;
				streamLiveStatuses[otherStreamId].stopTime = new Date().toISOString();
				
				// 广播其他流停止的消息
				broadcast('liveStatus', {
					streamId: otherStreamId,
					isLive: false,
					status: 'stopped', // 添加 status 字段
					stopTime: streamLiveStatuses[otherStreamId].stopTime
				});
			}
		}
		
		// 生成直播ID
		const liveId = uuidv4();
		const startTime = new Date().toISOString();
		
		// 更新该流的直播状态
		streamLiveStatuses[stream.id] = {
			isLive: true,
			liveId: liveId,
			startTime: startTime,
			streamUrl: stream.url,
			streamName: stream.name
		};
		
		// 更新全局直播状态（当前活跃的流）
		globalLiveStatus.isLive = true;
		globalLiveStatus.streamUrl = stream.url;
		globalLiveStatus.streamId = stream.id;
		globalLiveStatus.liveId = liveId;
		globalLiveStatus.startTime = startTime;
		
		// 如果需要自动启动AI
		if (autoStartAI && globalAIStatus.status !== 'running') {
			globalAIStatus.status = 'running';
			globalAIStatus.aiSessionId = uuidv4();
			globalAIStatus.startTime = startTime;
			
			// 推送AI启动消息
			broadcast('aiStatus', {
				status: 'running',
				aiSessionId: globalAIStatus.aiSessionId
			});
		}
		
		// 推送直播开始消息到小程序
		if (notifyUsers) {
			broadcast('liveStatus', {
				isLive: true,
				status: 'started', // 添加 status 字段
				liveId: liveId,
				streamUrl: stream.url,
				startTime: startTime
			});
			// 同时广播 live-status-changed 消息（兼容旧版前端）
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: stream.url,
				timestamp: Date.now()
			});
		}
		
		console.log(`✅ 直播已开始: ${liveId}, 流地址: ${stream.url}`);
		
		res.json({
			success: true,
			data: {
				liveId: liveId,
				streamUrl: stream.url,
				status: 'started',
				startTime: startTime,
				notifiedUsers: wsClients.size
			},
			message: '直播已开始',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('开始直播失败:', error);
		res.status(500).json({
			success: false,
			message: '开始直播失败: ' + error.message
		});
	}
}

// 1.2 停止直播
// 支持 /api/admin/live/stop 和 /api/v1/admin/live/stop 两种路径
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/live/stop', handleStopLive);
	app.post('/api/v1/admin/live/stop', handleStopLive);
}

function handleStopLive(req, res) {
	try {
		console.log('📥 [停止直播] 收到请求:', {
			streamId: req.body.streamId,
			saveStatistics: req.body.saveStatistics,
			notifyUsers: req.body.notifyUsers,
			body: req.body
		});
		
		const { streamId, saveStatistics = true, notifyUsers = true } = req.body;
		
		// 确定要停止的流ID
		const targetStreamId = streamId || globalLiveStatus.streamId;
		console.log('📥 [停止直播] 目标流ID:', targetStreamId);
		
		// 如果指定了streamId，检查该流是否在直播
		if (targetStreamId && streamLiveStatuses[targetStreamId] && !streamLiveStatuses[targetStreamId].isLive) {
			return res.json({
				success: true,
				data: {
					status: 'stopped',
					message: '该直播流未在直播，无需停止'
				},
				message: '该直播流未在直播，无需停止',
				timestamp: Date.now()
			});
		}
		
		// 如果没有指定streamId且全局直播未开始，直接返回成功
		if (!targetStreamId && !globalLiveStatus.isLive) {
			return res.json({
				success: true,
				data: {
					status: 'stopped',
					message: '直播未开始，无需停止'
				},
				message: '直播未开始，无需停止',
				timestamp: Date.now()
			});
		}
		
		const stopTime = new Date().toISOString();
		let startTime = null;
		let duration = 0;
		let liveId = null;
		
		// 如果指定了streamId，停止该流
		if (targetStreamId && streamLiveStatuses[targetStreamId]) {
			const streamStatus = streamLiveStatuses[targetStreamId];
			if (streamStatus.isLive) {
				startTime = new Date(streamStatus.startTime);
				duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
				liveId = streamStatus.liveId;
				
				// 更新该流的状态
				streamLiveStatuses[targetStreamId].isLive = false;
				streamLiveStatuses[targetStreamId].stopTime = stopTime;
			}
		} else if (globalLiveStatus.isLive) {
			// 停止全局直播状态
			startTime = new Date(globalLiveStatus.startTime);
			duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
			liveId = globalLiveStatus.liveId;
		}
		
		// 如果停止的是当前活跃的流，重置全局状态
		// 修复：只要停止了任何流，都应该检查并更新全局状态
		if (targetStreamId === globalLiveStatus.streamId || !targetStreamId) {
			console.log('🔄 [停止直播] 重置全局状态（流ID匹配）');
			globalLiveStatus.isLive = false;
			globalLiveStatus.streamUrl = null;
			globalLiveStatus.streamId = null;
			globalLiveStatus.liveId = null;
			globalLiveStatus.startTime = null;
			
			// 🔧 修复：清除直播计划，防止自动重启
			try {
				const db = require('./admin/db.js');
				db.liveSchedule.clear();
				globalLiveStatus.isScheduled = false;
				globalLiveStatus.scheduledStartTime = null;
				globalLiveStatus.scheduledEndTime = null;
				lastStopTime = Date.now(); // 记录停止时间，防止定时检查器误触发
				console.log('🔄 [停止直播] 已清除直播计划');
			} catch (error) {
				console.error('❌ [停止直播] 清除直播计划失败:', error);
			}
		} else if (targetStreamId && streamLiveStatuses[targetStreamId]) {
			// 如果停止的流不是全局活跃流，但该流确实在直播，也需要检查是否需要更新全局状态
			console.log('🔄 [停止直播] 停止的流与全局流不匹配，但该流在直播，也重置全局状态');
			// 检查是否有其他流在直播
			const otherLiveStream = Object.entries(streamLiveStatuses).find(
				([id, status]) => id !== targetStreamId && status.isLive
			);
			if (!otherLiveStream) {
				// 没有其他流在直播，重置全局状态
				globalLiveStatus.isLive = false;
				globalLiveStatus.streamUrl = null;
				globalLiveStatus.streamId = null;
				globalLiveStatus.liveId = null;
				globalLiveStatus.startTime = null;
				
				// 🔧 修复：清除直播计划，防止自动重启
				try {
					const db = require('./admin/db.js');
					db.liveSchedule.clear();
					globalLiveStatus.isScheduled = false;
					globalLiveStatus.scheduledStartTime = null;
					globalLiveStatus.scheduledEndTime = null;
					lastStopTime = Date.now(); // 记录停止时间，防止定时检查器误触发
					console.log('🔄 [停止直播] 已清除直播计划');
				} catch (error) {
					console.error('❌ [停止直播] 清除直播计划失败:', error);
				}
			}
		}
		
		// 统计数据
		const summary = {
			totalViewers: wsClients.size,
			peakViewers: wsClients.size,
			totalVotes: currentVotes.leftVotes + currentVotes.rightVotes,
			totalComments: 0,
			totalLikes: 0
		};
		
		// 保存统计数据到数据库
		if (saveStatistics && duration > 0) {
			try {
				console.log('💾 [停止直播] 保存统计数据...');
				const db = require('./admin/db.js');
				db.statistics.updateDashboard({
					totalVotes: summary.totalVotes,
					lastLiveTime: stopTime,
					liveDuration: duration
				});
				console.log('✅ [停止直播] 统计数据已保存');
			} catch (dbError) {
				console.error('❌ [停止直播] 保存统计数据失败:', dbError);
				// 不阻塞响应，继续执行
			}
		}
		
		// 推送直播停止消息
		if (notifyUsers) {
			try {
				console.log('📢 [停止直播] 推送停止消息...');
				// 修复：添加 status 字段，确保前端能正确处理
				broadcast('liveStatus', {
					streamId: targetStreamId,
					isLive: false,
					status: 'stopped', // 添加 status 字段
					liveId: liveId,
					stopTime: stopTime
				});
				// 同时广播 live-status-changed 消息（兼容旧版前端）
				broadcast('live-status-changed', {
					status: 'stopped',
					streamId: targetStreamId,
					timestamp: Date.now()
				});
				console.log('✅ [停止直播] 消息已推送');
			} catch (broadcastError) {
				console.error('❌ [停止直播] 推送消息失败:', broadcastError);
				// 不阻塞响应，继续执行
			}
		}
		
		console.log(`⏹️  [停止直播] 直播已停止: ${liveId}, duration: ${duration}秒`);
		
		const responseData = {
			success: true,
			data: {
				liveId: liveId,
				status: 'stopped',
				stopTime: stopTime,
				duration: duration,
				summary: summary,
				notifiedUsers: wsClients.size
			},
			message: '直播已停止',
			timestamp: Date.now()
		};
		
		console.log('📤 [停止直播] 发送响应:', responseData);
		res.json(responseData);
		console.log('✅ [停止直播] 响应已发送');
		
	} catch (error) {
		console.error('停止直播失败:', error);
		res.status(500).json({
			success: false,
			message: '停止直播失败: ' + error.message
		});
	}
}

// 1.3 更新投票数据
app.post('/api/admin/live/update-votes', (req, res) => {
	try {
		const { action, leftVotes, rightVotes, reason, notifyUsers = true } = req.body;
		
		if (!action || !['set', 'add', 'reset'].includes(action)) {
			return res.status(400).json({
				success: false,
				message: 'action参数必须是: set / add / reset'
			});
		}
		
		const beforeUpdate = {
			leftVotes: currentVotes.leftVotes,
			rightVotes: currentVotes.rightVotes
		};
		
		// 执行操作
		switch (action) {
			case 'set':
				currentVotes.leftVotes = parseInt(leftVotes) || 0;
				currentVotes.rightVotes = parseInt(rightVotes) || 0;
				break;
			case 'add':
				currentVotes.leftVotes += parseInt(leftVotes) || 0;
				currentVotes.rightVotes += parseInt(rightVotes) || 0;
				break;
			case 'reset':
				currentVotes.leftVotes = 0;
				currentVotes.rightVotes = 0;
				break;
		}
		
		const total = currentVotes.leftVotes + currentVotes.rightVotes;
		const afterUpdate = {
			leftVotes: currentVotes.leftVotes,
			rightVotes: currentVotes.rightVotes,
			leftPercentage: total > 0 ? Math.round((currentVotes.leftVotes / total) * 100) : 50,
			rightPercentage: total > 0 ? Math.round((currentVotes.rightVotes / total) * 100) : 50
		};
		
		// 推送更新
		if (notifyUsers) {
			broadcast('votes-updated', afterUpdate);
		}
		
		console.log(`📊 投票数据已更新 (${action}):`, afterUpdate);
		
		res.json({
			success: true,
			data: {
				beforeUpdate,
				afterUpdate,
				updateTime: new Date().toISOString()
			},
			message: '投票数据已更新',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('更新投票数据失败:', error);
		res.status(500).json({
			success: false,
			message: '更新投票数据失败: ' + error.message
		});
	}
});

// 1.4 重置投票数据
app.post('/api/admin/live/reset-votes', (req, res) => {
	try {
		const { resetTo, saveBackup = true, notifyUsers = true } = req.body;
		
		// 备份当前数据
		const backup = saveBackup ? {
			backupId: uuidv4(),
			leftVotes: currentVotes.leftVotes,
			rightVotes: currentVotes.rightVotes,
			timestamp: new Date().toISOString()
		} : null;
		
		// 重置票数
		if (resetTo) {
			currentVotes.leftVotes = parseInt(resetTo.leftVotes) || 0;
			currentVotes.rightVotes = parseInt(resetTo.rightVotes) || 0;
		} else {
			currentVotes.leftVotes = 0;
			currentVotes.rightVotes = 0;
		}
		
		// 推送更新
		if (notifyUsers) {
			broadcast('votes-updated', {
				leftVotes: currentVotes.leftVotes,
				rightVotes: currentVotes.rightVotes,
				leftPercentage: 50,
				rightPercentage: 50
			});
		}
		
		console.log('🔄 投票数据已重置');
		
		res.json({
			success: true,
			data: {
				backup,
				currentVotes: {
					leftVotes: currentVotes.leftVotes,
					rightVotes: currentVotes.rightVotes
				}
			},
			message: '投票数据已重置',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('重置投票数据失败:', error);
		res.status(500).json({
			success: false,
			message: '重置投票数据失败: ' + error.message
		});
	}
});

// 二、AI控制接口

// 2.1 启动AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/ai/start', (req, res) => {
	try {
		const { settings, notifyUsers = true } = req.body;
		
		if (globalAIStatus.status === 'running') {
			return res.status(409).json({
				success: false,
				message: 'AI识别已在运行中'
			});
		}
		
		// 更新设置
		if (settings) {
			globalAIStatus.settings = {
				...globalAIStatus.settings,
				...settings
			};
		}
		
		// 启动AI
		globalAIStatus.status = 'running';
		globalAIStatus.aiSessionId = uuidv4();
		globalAIStatus.startTime = new Date().toISOString();
		globalAIStatus.statistics = {
			totalContents: 0,
			totalWords: 0,
			averageConfidence: 0
		};
		
		// 推送AI启动消息
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: 'running',
				aiSessionId: globalAIStatus.aiSessionId
			});
		}
		
		console.log(`🤖 AI识别已启动: ${globalAIStatus.aiSessionId}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId: globalAIStatus.aiSessionId,
				status: 'running',
				startTime: globalAIStatus.startTime,
				settings: globalAIStatus.settings
			},
			message: 'AI识别已启动',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('启动AI识别失败:', error);
		res.status(500).json({
			success: false,
			message: '启动AI识别失败: ' + error.message
		});
	}
	});
}

// 2.2 停止AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/ai/stop', (req, res) => {
	try {
		const { saveHistory = true, notifyUsers = true } = req.body;
		
		if (globalAIStatus.status === 'stopped') {
			return res.status(400).json({
				success: false,
				message: 'AI识别未运行'
			});
		}
		
		const stopTime = new Date().toISOString();
		const startTime = new Date(globalAIStatus.startTime);
		const duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
		
		const aiSessionId = globalAIStatus.aiSessionId;
		const summary = { ...globalAIStatus.statistics };
		
		// 重置状态
		globalAIStatus.status = 'stopped';
		globalAIStatus.aiSessionId = null;
		globalAIStatus.startTime = null;
		
		// 推送AI停止消息
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: 'stopped',
				aiSessionId: aiSessionId
			});
		}
		
		console.log(`⏹️  AI识别已停止: ${aiSessionId}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId: aiSessionId,
				status: 'stopped',
				stopTime: stopTime,
				duration: duration,
				summary: summary
			},
			message: 'AI识别已停止',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('停止AI识别失败:', error);
		res.status(500).json({
			success: false,
			message: '停止AI识别失败: ' + error.message
		});
	}
	});
}

// 2.3 暂停/恢复AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/ai/toggle', (req, res) => {
	try {
		const { action, notifyUsers = true } = req.body;
		
		if (!action || !['pause', 'resume'].includes(action)) {
			return res.status(400).json({
				success: false,
				message: 'action参数必须是: pause / resume'
			});
		}
		
		if (action === 'pause') {
			if (globalAIStatus.status !== 'running') {
				return res.status(400).json({
					success: false,
					message: 'AI识别未运行，无法暂停'
				});
			}
			globalAIStatus.status = 'paused';
		} else if (action === 'resume') {
			if (globalAIStatus.status !== 'paused') {
				return res.status(400).json({
					success: false,
					message: 'AI识别未暂停，无法恢复'
				});
			}
			globalAIStatus.status = 'running';
		}
		
		// 推送状态变更
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: globalAIStatus.status
			});
		}
		
		console.log(`🤖 AI识别状态已变更: ${globalAIStatus.status}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId: globalAIStatus.aiSessionId,
				status: globalAIStatus.status,
				actionTime: new Date().toISOString()
			},
			message: globalAIStatus.status === 'paused' ? 'AI识别已暂停' : 'AI识别已恢复',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('切换AI状态失败:', error);
		res.status(500).json({
			success: false,
			message: '切换AI状态失败: ' + error.message
		});
	}
	});
}

// 2.4 删除AI内容
app.delete('/api/admin/ai/content/:contentId', (req, res) => {
	try {
		const { contentId } = req.params;
		const { reason, notifyUsers = true } = req.body;
		
		if (!contentId) {
			return res.status(400).json({
				success: false,
				message: '缺少内容ID'
			});
		}
		
		// 这里应该从数据库删除AI内容
		// 暂时模拟删除成功
		
		// 推送删除消息
		if (notifyUsers) {
			broadcast('aiContentDeleted', {
				contentId: contentId
			});
		}
		
		console.log(`🗑️  AI内容已删除: ${contentId}`);
		
		res.json({
			success: true,
			data: {
				contentId: contentId,
				deleteTime: new Date().toISOString(),
				reason: reason || '管理员删除'
			},
			message: '内容已删除',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除AI内容失败:', error);
		res.status(500).json({
			success: false,
			message: '删除AI内容失败: ' + error.message
		});
	}
});

// 三、数据查询接口

// 3.1 实时数据概览
app.get('/api/admin/dashboard', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const users = db.users.getAll();
		const debate = db.debate.get();
		
		const totalVotes = currentVotes.leftVotes + currentVotes.rightVotes;
		const leftPercentage = totalVotes > 0 ? Math.round((currentVotes.leftVotes / totalVotes) * 100) : 50;
		const rightPercentage = totalVotes > 0 ? Math.round((currentVotes.rightVotes / totalVotes) * 100) : 50;
		
		// 计算直播时长
		let liveDuration = 0;
		if (globalLiveStatus.isLive && globalLiveStatus.startTime) {
			const startTime = new Date(globalLiveStatus.startTime);
			liveDuration = Math.floor((Date.now() - startTime.getTime()) / 1000);
		}
		
		// 获取启用的直播流（从数据库查询，即使直播未开始也会返回）
		let activeStream = null;
		try {
			activeStream = db.streams.getActive();
		} catch (error) {
			console.warn('获取启用直播流失败:', error);
		}
		
		const data = {
			totalUsers: users.length,
			activeUsers: wsClients.size,
			isLive: globalLiveStatus.isLive,
			liveStreamUrl: globalLiveStatus.streamUrl,
			streamId: globalLiveStatus.streamId || null, // 当前直播使用的流ID
			// 添加启用的直播流信息（从数据库查询，方便小程序获取测试流地址）
			activeStreamUrl: activeStream ? activeStream.url : null,
			activeStreamId: activeStream ? activeStream.id : null,
			activeStreamName: activeStream ? activeStream.name : null,
			totalVotes: totalVotes,
			leftVotes: currentVotes.leftVotes,
			rightVotes: currentVotes.rightVotes,
			leftPercentage: leftPercentage,
			rightPercentage: rightPercentage,
			totalComments: 0,  // 可从数据库获取
			totalLikes: 0,     // 可从数据库获取
			aiStatus: globalAIStatus.status,
			debateTopic: {
				title: debate.title,
				leftSide: debate.leftPosition,
				rightSide: debate.rightPosition,
				description: debate.description
			},
			liveStartTime: globalLiveStatus.startTime,
			liveDuration: liveDuration
		};
		
		res.json({
			success: true,
			data: data,
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取数据概览失败:', error);
		res.status(500).json({
			success: false,
			message: '获取数据概览失败: ' + error.message
		});
	}
});

// 3.2 用户列表
app.get('/api/admin/miniprogram/users', (req, res) => {
	try {
		const db = require('./admin/db.js');
		const users = db.users.getAll();
		
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const status = req.query.status || 'all';
		const orderBy = req.query.orderBy || 'joinTime';
		
		// 过滤用户
		let filteredUsers = users;
		if (status === 'online') {
			// 简化处理：假设所有WebSocket连接的用户都是在线
			filteredUsers = users.filter(u => wsClients.size > 0);
		}
		
		// 排序
		filteredUsers.sort((a, b) => {
			if (orderBy === 'votes') {
				return ((b.statistics && b.statistics.totalVotes) || 0) - ((a.statistics && a.statistics.totalVotes) || 0);
			}
			return new Date(b.joinTime) - new Date(a.joinTime);
		});
		
		// 分页
		const total = filteredUsers.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedUsers = filteredUsers.slice(start, end);
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				pageSize: pageSize,
				users: paginatedUsers.map(u => ({
					userId: u.id,
					nickname: u.nickname,
					avatar: u.avatar,
					status: 'online',  // 简化处理
					lastActiveTime: new Date().toISOString(),
					statistics: u.statistics || {
						totalVotes: 0,
						totalComments: 0,
						totalLikes: 0,
						currentPosition: 'neutral'
					},
					joinTime: u.createdAt || new Date().toISOString()
				}))
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取用户列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取用户列表失败: ' + error.message
		});
	}
});

// 3.3 投票统计
app.get('/api/admin/votes/statistics', (req, res) => {
	try {
		const timeRange = req.query.timeRange || '1h';
		
		const totalVotes = currentVotes.leftVotes + currentVotes.rightVotes;
		const leftPercentage = totalVotes > 0 ? Math.round((currentVotes.leftVotes / totalVotes) * 100) : 50;
		const rightPercentage = totalVotes > 0 ? Math.round((currentVotes.rightVotes / totalVotes) * 100) : 50;
		
		// 简化：生成模拟时间轴数据
		const timeline = [];
		const now = new Date();
		for (let i = 0; i < 10; i++) {
			const time = new Date(now.getTime() - i * 60000);  // 每分钟一个点
			timeline.unshift({
				timestamp: time.toISOString(),
				leftVotes: Math.floor(currentVotes.leftVotes * (10 - i) / 10),
				rightVotes: Math.floor(currentVotes.rightVotes * (10 - i) / 10),
				totalVotes: Math.floor(totalVotes * (10 - i) / 10),
				activeUsers: wsClients.size
			});
		}
		
		res.json({
			success: true,
			data: {
				summary: {
					totalVotes: totalVotes,
					leftVotes: currentVotes.leftVotes,
					rightVotes: currentVotes.rightVotes,
					leftPercentage: leftPercentage,
					rightPercentage: rightPercentage,
					growthRate: 5.2
				},
				timeline: timeline,
				topVoters: []  // 可从数据库获取
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取投票统计失败:', error);
		res.status(500).json({
			success: false,
			message: '获取投票统计失败: ' + error.message
		});
	}
});

// 3.4 AI内容列表（已在上面定义，此处删除重复定义）

// ==================== 直播流管理接口 ====================

// 获取所有直播流列表
/**
 * 生成播放地址（playUrls）
 * 根据流类型自动生成 HLS、FLV、RTMP 播放地址
 */
function generatePlayUrls(stream) {
	const playUrls = {
		hls: null,
		flv: null,
		rtmp: null
	};
	
	try {
		// 获取服务器IP地址（用于生成转换后的播放地址）
		const serverIP = process.env.SERVER_IP || '192.168.31.249';
		const hlsServerPort = process.env.HLS_SERVER_PORT || '8086';
		const rtmpServerPort = process.env.RTMP_SERVER_PORT || '1935';
		
		// 从原URL中提取流名称（用于RTMP转HLS）
		const getStreamName = (url) => {
			try {
				const urlObj = new URL(url);
				const path = urlObj.pathname;
				// 提取路径的最后一部分作为流名称
				// 例如: rtmp://localhost/live/stream1 -> stream1
				const parts = path.split('/').filter(p => p);
				return parts[parts.length - 1] || 'stream';
			} catch (e) {
				// 如果URL解析失败，尝试从字符串中提取
				const match = url.match(/([^\/]+)(?:\.[^\.]+)?$/);
				return match ? match[1] : 'stream';
			}
		};
		
		switch (stream.type) {
			case 'hls':
				// HLS流直接使用原地址
				playUrls.hls = stream.url;
				// 尝试从HLS地址生成FLV地址（如果可能）
				if (stream.url.includes('.m3u8')) {
					playUrls.flv = stream.url.replace('.m3u8', '.flv');
				}
				break;
				
			case 'rtmp':
				// RTMP流需要转换为HLS
				const streamName = getStreamName(stream.url);
				// 生成HLS播放地址（通过流媒体服务器转换）
				playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
				playUrls.flv = `http://${serverIP}:${hlsServerPort}/live/${streamName}.flv`;
				playUrls.rtmp = stream.url.replace('localhost', serverIP).replace(/^rtmp:\/\//, `rtmp://${serverIP}:${rtmpServerPort}/`);
				break;
				
			case 'flv':
				// FLV流
				playUrls.flv = stream.url;
				// 尝试从FLV地址生成HLS地址
				if (stream.url.includes('.flv')) {
					const streamName = getStreamName(stream.url);
					playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
				}
				break;
				
			default:
				// 未知类型，尝试使用原地址
				playUrls.hls = stream.url;
				break;
		}
		
		// 确保至少有一个播放地址
		if (!playUrls.hls && stream.url) {
			playUrls.hls = stream.url;
		}
		
	} catch (error) {
		console.error('生成播放地址失败:', error);
		// 如果生成失败，至少使用原URL作为HLS地址
		playUrls.hls = stream.url;
	}
	
	return playUrls;
}

app.get('/api/admin/streams', (req, res) => {
	try {
		const streams = db.streams.getAll();
		
		// 为每个流添加直播状态和播放地址
		const streamsWithStatus = streams.map(stream => {
			const status = streamLiveStatuses[stream.id] || { isLive: false };
			
			// 生成播放地址（playUrls）
			const playUrls = generatePlayUrls(stream);
			
			return {
				...stream,
				// ✅ 新增：播放地址字段
				playUrls: playUrls,
				liveStatus: {
					isLive: status.isLive || false,
					liveId: status.liveId || null,
					startTime: status.startTime || null,
					stopTime: status.stopTime || null,
					streamUrl: status.streamUrl || stream.url
				}
			};
		});
		
		res.json({
			success: true,
			data: {
				streams: streamsWithStatus,
				total: streams.length
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取直播流列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取直播流列表失败: ' + error.message
		});
	}
});

// 添加新的直播流
app.post('/api/admin/streams', (req, res) => {
	try {
		const { name, url, type, description, enabled } = req.body;
		
		// 参数验证
		if (!name || !url || !type) {
			return res.status(400).json({
				success: false,
				message: '缺少必要参数: name, url, type 必填'
			});
		}
		
		// 验证URL格式
		try {
			new URL(url);
		} catch (e) {
			return res.status(400).json({
				success: false,
				message: '流地址格式不正确，请输入有效的URL'
			});
		}
		
		// 验证type
		if (!['hls', 'rtmp', 'flv'].includes(type)) {
			return res.status(400).json({
				success: false,
				message: 'type 必须是 hls, rtmp 或 flv'
			});
		}
		
		// 创建新流
		const newStream = {
			id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			name: name.trim(),
			url: url.trim(),
			type,
			description: description ? description.trim() : '',
			enabled: enabled !== false, // 默认启用
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		
		// 保存到数据库
		db.streams.add(newStream);
		
		console.log('✅ 新增直播流:', newStream.name, newStream.url);
		
		res.json({
			success: true,
			data: newStream,
			message: '直播流添加成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('添加直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '添加直播流失败: ' + error.message
		});
	}
});

// 更新直播流
app.put('/api/admin/streams/:id', (req, res) => {
	try {
		const streamId = req.params.id; // 统一使用 :id 参数名
		const { name, url, type, description, enabled } = req.body;
		
		// 查找流
		const stream = db.streams.getById(streamId);
		if (!stream) {
			return res.status(404).json({
				success: false,
				message: '直播流不存在'
			});
		}
		
		// 验证URL格式（如果有更新）
		if (url) {
			try {
				new URL(url);
			} catch (e) {
				return res.status(400).json({
					success: false,
					message: '流地址格式不正确，请输入有效的URL'
				});
			}
		}
		
		// 验证type（如果有更新）
		if (type && !['hls', 'rtmp', 'flv'].includes(type)) {
			return res.status(400).json({
				success: false,
				message: 'type 必须是 hls, rtmp 或 flv'
			});
		}
		
		// 更新字段
		const updates = {};
		if (name !== undefined) updates.name = name.trim();
		if (url !== undefined) updates.url = url.trim();
		if (type !== undefined) updates.type = type;
		if (description !== undefined) updates.description = description.trim();
		if (enabled !== undefined) updates.enabled = enabled;
		updates.updatedAt = new Date().toISOString();
		
		// 保存更新
		const updatedStream = db.streams.update(streamId, updates);
		
		console.log('✅ 更新直播流:', streamId, updates);
		
		res.json({
			success: true,
			data: updatedStream,
			message: '直播流更新成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('更新直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '更新直播流失败: ' + error.message
		});
	}
});

// 删除直播流
app.delete('/api/admin/streams/:id', (req, res) => {
	try {
		const streamId = req.params.id; // 统一使用 :id 参数名
		
		// 查找流
		const stream = db.streams.getById(streamId);
		if (!stream) {
			return res.status(404).json({
				success: false,
				message: '直播流不存在'
			});
		}
		
		// 检查是否正在使用
		if (globalLiveStatus && globalLiveStatus.streamId === streamId) {
			return res.status(400).json({
				success: false,
				message: '该直播流正在使用中，请先停止直播'
			});
		}
		
		// 删除
		db.streams.delete(streamId);
		
		console.log('✅ 删除直播流:', streamId, stream.name);
		
		res.json({
			success: true,
			data: {
				id: streamId,
				name: stream.name
			},
			message: '直播流删除成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '删除直播流失败: ' + error.message
		});
	}
});

// 启动服务器
server.listen(port, '0.0.0.0', () => {
    console.log('');
    printConfig();
    console.log(`辩题: ${debateTopic.title}`);
    console.log(`状态: ✅ 服务器运行中`);
    if (wss) {
        console.log(`🌐 WebSocket 服务已启动: ws://localhost:${port}/ws`);
    }
    if (BACKEND_SERVER_URL) {
        console.log(`🔗 后端服务器代理: ${BACKEND_SERVER_URL}`);
    }
    console.log('═══════════════════════════════════════');
    console.log('');
    
    // 只在模拟模式下启动模拟数据
    if (currentConfig.mode === 'mock') {
        simulateVoteChanges();
        simulateNewAIContent();
        console.log('🤖 模拟数据生成器已启动');
    }
    
    // 启动直播计划检查
    startScheduleCheck();
    console.log('⏰ 直播计划定时检查已启动');
});

// ==================== 代理未匹配的 API 请求到后端服务器 ====================
// 在所有本地路由之后，将未匹配的 API 请求代理到后端服务器
// 注意：如果 PRIORITIZE_BACKEND_SERVER 为 true，这个代理不会执行（因为已经在前面处理了）
// 注意：Express 路由是按顺序匹配的，如果本地路由已经匹配并处理了请求，就不会到达这里
// 所以这个代理只会处理本地路由没有匹配的请求
if (BACKEND_SERVER_URL && !PRIORITIZE_BACKEND_SERVER) {
	console.log(`🔧 配置后端代理: /api/* -> ${BACKEND_SERVER_URL}`);
	// 配置代理中间件
	const proxyOptions = {
		target: BACKEND_SERVER_URL,
		changeOrigin: true, // 修改请求头中的 origin
		pathRewrite: {
			// 保持原始路径不变，直接转发
		},
		onProxyReq: (proxyReq, req, res) => {
			// 在转发请求前可以修改请求头
			console.log(`🔄 [代理] ${req.method} ${req.path} -> ${BACKEND_SERVER_URL}${req.path}`);
		},
		onProxyRes: (proxyRes, req, res) => {
			// 在收到响应后可以修改响应
			console.log(`✅ [代理] ${req.path} <- ${proxyRes.statusCode} ${BACKEND_SERVER_URL}`);
		},
		onError: (err, req, res) => {
			console.error(`❌ [代理错误] ${req.path}:`, err.message);
			// 如果响应还没有发送，返回错误信息
			if (!res.headersSent) {
				res.status(502).json({
					success: false,
					error: 'Bad Gateway',
					message: `无法连接到后端服务器 ${BACKEND_SERVER_URL}`,
					path: req.path,
					details: err.message
				});
			}
		}
	};
	
	// 创建代理中间件
	// 注意：createProxyMiddleware 的第一个参数是配置对象，路径在 app.use 中指定
	const backendProxy = createProxyMiddleware(proxyOptions);
	
	// 在所有本地路由之后，404处理器之前，添加代理中间件
	// 这样，如果本地路由没有匹配，就会尝试代理到后端服务器
	
	// 🔍 调试：添加测试中间件，看看请求是否到达这里
	app.use('/api', (req, res, next) => {
		console.log(`🔍 [调试] API请求到达代理位置: ${req.method} ${req.path}`);
		next(); // 继续到代理中间件
	});
	
	app.use('/api', backendProxy);
	console.log('✅ 后端代理中间件已添加到路由栈');
} else {
	console.log('⚠️  后端代理未配置（BACKEND_SERVER_URL 或 PRIORITIZE_BACKEND_SERVER 不满足条件）');
}

// ==================== 404处理器（必须在所有路由之后） ====================
// 404处理器（API 路由）
app.use((req, res) => {
	// 如果是 API 请求，返回 JSON 格式错误
	if (req.path.startsWith('/api')) {
		console.log(`⚠️  API路由未找到: ${req.method} ${req.path}`);
		res.status(404).json({
			success: false,
			error: 'Not Found',
			path: req.path,
			message: `API路由 ${req.path} 未定义，且无法连接到后端服务器`
		});
	} else {
		// 其他请求返回 404
		console.log(`⚠️  路由未找到: ${req.method} ${req.url}`);
		res.status(404).json({
			error: 'Not Found',
			path: req.url,
			message: `路由 ${req.url} 未定义`
		});
	}
});

module.exports = app;
