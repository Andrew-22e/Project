const express = require('express');
const router = express.Router();
const { users } = require('../data/mockData');

// 获取用户列表
router.get('/users', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: users
        });
    } catch (error) {
        console.error('获取用户列表失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取用户列表失败',
            data: null
        });
    }
});

// 获取单个用户
router.get('/users/:id', (req, res) => {
    try {
        const userId = req.params.id;
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            return res.status(404).json({
                code: 404,
                message: '用户不存在',
                data: null
            });
        }
        
        res.json({
            code: 0,
            message: 'success',
            data: user
        });
    } catch (error) {
        console.error('获取用户失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取用户失败',
            data: null
        });
    }
});

// 更新用户信息
router.put('/users/:id', (req, res) => {
    try {
        const userId = req.params.id;
        const updates = req.body;
        
        const userIndex = users.findIndex(u => u.id === userId);
        if (userIndex === -1) {
            return res.status(404).json({
                code: 404,
                message: '用户不存在',
                data: null
            });
        }
        
        // 更新用户信息
        Object.assign(users[userIndex], updates);
        
        res.json({
            code: 0,
            message: '更新用户信息成功',
            data: users[userIndex]
        });
    } catch (error) {
        console.error('更新用户信息失败:', error);
        res.status(500).json({
            code: 500,
            message: '更新用户信息失败',
            data: null
        });
    }
});

// 删除用户
router.delete('/users/:id', (req, res) => {
    try {
        const userId = req.params.id;
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            return res.status(404).json({
                code: 404,
                message: '用户不存在',
                data: null
            });
        }
        
        const deletedUser = users[userIndex];
        users.splice(userIndex, 1);
        
        res.json({
            code: 0,
            message: '删除用户成功',
            data: {
                id: userId,
                nickname: deletedUser.nickname
            }
        });
    } catch (error) {
        console.error('删除用户失败:', error);
        res.status(500).json({
            code: 500,
            message: '删除用户失败',
            data: null
        });
    }
});

// 模拟用户登录（简化版）
router.post('/login', (req, res) => {
    try {
        const { code } = req.body;
        
        // 模拟微信登录验证
        if (!code) {
            return res.status(400).json({
                code: 400,
                message: '缺少登录凭证',
                data: null
            });
        }
        
        // 返回模拟的登录信息
        res.json({
            code: 0,
            message: '登录成功',
            data: {
                token: 'mock-token-' + Date.now(),
                userInfo: users[0], // 返回第一个用户作为模拟登录用户
                expiresIn: 7200
            }
        });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({
            code: 500,
            message: '登录失败',
            data: null
        });
    }
});

module.exports = router;