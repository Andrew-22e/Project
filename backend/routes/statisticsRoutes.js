const express = require('express');
const router = express.Router();
const { statistics, liveSchedule, aiStatus, debate } = require('../data/mockData');

// 获取仪表盘统计数据
router.get('/dashboard', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: {
                ...statistics,
                debate: debate,
                liveSchedule: liveSchedule,
                aiStatus: aiStatus
            }
        });
    } catch (error) {
        console.error('获取仪表盘数据失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取仪表盘数据失败',
            data: null
        });
    }
});

// 获取投票统计
router.get('/votes', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: {
                votes: statistics.votes,
                total: statistics.voteCount
            }
        });
    } catch (error) {
        console.error('获取投票统计失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取投票统计失败',
            data: null
        });
    }
});

// 模拟投票
router.post('/vote', (req, res) => {
    try {
        const { side } = req.body;
        
        if (!['affirmative', 'negative'].includes(side)) {
            return res.status(400).json({
                code: 400,
                message: '投票选项无效',
                data: null
            });
        }
        
        // 增加投票数
        statistics.votes[side]++;
        statistics.voteCount++;
        
        res.json({
            code: 0,
            message: '投票成功',
            data: {
                side: side,
                votes: statistics.votes,
                total: statistics.voteCount
            }
        });
    } catch (error) {
        console.error('投票失败:', error);
        res.status(500).json({
            code: 500,
            message: '投票失败',
            data: null
        });
    }
});

// 获取直播计划
router.get('/live-schedule', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: liveSchedule
        });
    } catch (error) {
        console.error('获取直播计划失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取直播计划失败',
            data: null
        });
    }
});

// 更新直播计划
router.put('/live-schedule', (req, res) => {
    try {
        const updates = req.body;
        Object.assign(liveSchedule, updates);
        
        res.json({
            code: 0,
            message: '更新直播计划成功',
            data: liveSchedule
        });
    } catch (error) {
        console.error('更新直播计划失败:', error);
        res.status(500).json({
            code: 500,
            message: '更新直播计划失败',
            data: null
        });
    }
});

// 获取AI状态
router.get('/ai-status', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: aiStatus
        });
    } catch (error) {
        console.error('获取AI状态失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取AI状态失败',
            data: null
        });
    }
});

// 控制AI服务
router.post('/ai-control', (req, res) => {
    try {
        const { action, settings } = req.body;
        
        if (!['start', 'stop', 'pause', 'resume'].includes(action)) {
            return res.status(400).json({
                code: 400,
                message: '操作无效',
                data: null
            });
        }
        
        // 更新AI状态
        aiStatus.status = action === 'start' || action === 'resume' ? 'running' : action;
        if (action === 'start') {
            aiStatus.startTime = new Date().toISOString();
            aiStatus.aiSessionId = 'ai-session-' + Date.now();
        }
        if (settings) {
            Object.assign(aiStatus.settings, settings);
        }
        
        res.json({
            code: 0,
            message: 'AI服务控制成功',
            data: aiStatus
        });
    } catch (error) {
        console.error('控制AI服务失败:', error);
        res.status(500).json({
            code: 500,
            message: '控制AI服务失败',
            data: null
        });
    }
});

module.exports = router;