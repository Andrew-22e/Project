# 🎭 直播辩论系统

## 🚀 演示地址
- **前端访问地址**：http://123.57.228.62:8081
- **后端 API 地址**：http://123.57.228.62:3000
- **网关服务地址**：http://123.57.228.62:8080

## 🧱 技术栈说明

### 后端框架
- **Node.js** + **Express**：轻量级高性能Web框架
- **Mock 数据方案**：内置JSON数据模拟，无需数据库
- **部署平台**：本地开发环境（可扩展至Vercel、Render等云平台）、云服务器（已成功部署）

## 🔗 项目结构

```
├── frontend/          # 前端项目
├── gateway/           # 网关项目（API代理）
├── backend/           # 后端服务
│   ├── data/          # Mock数据文件
│   ├── routes/        # API路由
│   ├── index.js       # 入口文件
│   └── package.json   # 项目配置
└── README.md          # 项目说明
```

## 📋 主要接口说明

### 辩论管理
| 功能 | 方法 | 路径 | 描述 |
|------|------|------|------|
| 获取辩论设置 | GET | `/api/admin/debate` | 获取当前辩论主题和设置 |
| 更新辩论设置 | PUT | `/api/admin/debate` | 更新辩论主题和配置 |

### 直播流管理
| 功能 | 方法 | 路径 | 描述 |
|------|------|------|------|
| 获取直播流列表 | GET | `/api/admin/streams` | 获取所有配置的直播流 |
| 添加直播流 | POST | `/api/admin/streams` | 新增直播流配置 |
| 更新直播流 | PUT | `/api/admin/streams/:id` | 更新指定直播流 |
| 删除直播流 | DELETE | `/api/admin/streams/:id` | 删除指定直播流 |

### 用户管理
| 功能 | 方法 | 路径 | 描述 |
|------|------|------|------|
| 获取用户列表 | GET | `/api/admin/users` | 获取所有用户 |
| 获取单个用户 | GET | `/api/admin/users/:id` | 获取指定用户信息 |
| 更新用户信息 | PUT | `/api/admin/users/:id` | 更新用户信息 |
| 用户登录 | POST | `/api/login` | 模拟用户登录 |

### 统计数据
| 功能 | 方法 | 路径 | 描述 |
|------|------|------|------|
| 获取仪表盘数据 | GET | `/api/dashboard` | 获取综合统计数据 |
| 获取投票统计 | GET | `/api/votes` | 获取投票情况 |
| 提交投票 | POST | `/api/vote` | 用户提交投票 |
| 获取直播计划 | GET | `/api/live-schedule` | 获取直播计划 |
| 控制AI服务 | POST | `/api/ai-control` | 控制AI识别服务 |

## 🧠 项目开发过程笔记

### 实现思路
1. **项目分析**：通过分析前端和网关代码，确定后端需要实现的API接口
2. **技术选型**：选择Express作为后端框架，使用内存存储模拟数据库
3. **架构设计**：
   - 后端提供RESTful API
   - 网关负责请求转发和WebSocket实时通信
   - 前端通过网关访问后端服务

### 遇到的问题与解决方案
1. **跨域问题**：配置CORS中间件允许所有来源
2. **API代理配置**：使用http-proxy-middleware实现请求转发
3. **数据格式统一**：所有API返回统一的JSON格式 `{code, message, data}`

### 本地联调经验
1. 先启动后端服务 `npm start`
2. 再启动网关服务 `npm start`
3. 最后启动前端项目进行测试
4. 使用Postman或浏览器直接测试API接口

## 🚀 部署步骤

### 本地部署
1. **后端服务**：
   ```bash
   cd backend
   npm install
   npm start
   ```

2. **网关服务**：
   ```bash
   cd gateway
   npm install
   npm start
   ```

3. **前端项目**：
   ```bash
   cd frontend
   npm install
   npm run start
   ```

### 部署后访问

部署完成后，您可以通过以下地址访问：

- 前端服务：`[https://live-debate-frontend.onrender.com](http://123.57.228.62:8081/)`
- 后端API：`[https://live-debate-backend.onrender.com](http://123.57.228.62:3000/)`
- 管理后台：`[https://live-debate-gateway.onrender.com/admin](http://123.57.228.62:8080/admin)`

### 注意事项

1. Render的免费计划有资源限制和自动休眠机制，可能会导致服务响应缓慢
2. WebSocket功能在某些云平台可能有限制，请确保您的Render计划支持WebSocket
3. 由于使用模拟数据，重启服务后数据可能会重置
4. 真实的直播流服务需要配置相应的流媒体服务器，当前仅支持模拟数据

## 🧍 个人介绍
- **主语言**：JavaScript/Node.js
- **擅长方向**：Web全栈开发、API设计、系统架构
- **学习目标**：深入学习微服务架构和云原生技术

## ⚠️ 注意事项
- 当前使用的是Mock数据，生产环境需要连接真实数据库
- WebSocket实时通信功能已在网关中实现
- 直播流播放需要配置相应的流媒体服务器
