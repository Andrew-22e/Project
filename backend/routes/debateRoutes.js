const express = require('express');
const router = express.Router();
const { debate, debateTopics, streams } = require('../data/mockData');

// 获取辩论设置（全局辩题）
router.get('/debate', (req, res) => {
    try {
        res.json({
            code: 0,
            message: 'success',
            data: debate
        });
    } catch (error) {
        console.error('获取辩论设置失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取辩论设置失败',
            data: null
        });
    }
});

// 更新辩论设置（全局辩题）
router.put('/debate', (req, res) => {
    try {
        const updates = req.body;
        
        // 更新辩论设置
        Object.assign(debate, updates);
        debate.updatedAt = new Date().toISOString();
        
        res.json({
            code: 0,
            message: 'success',
            data: debate
        });
    } catch (error) {
        console.error('更新辩论设置失败:', error);
        res.status(500).json({
            code: 500,
            message: '更新辩论设置失败',
            data: null
        });
    }
});

// 为直播流设置辩题（创建/更新）
router.post('/streams/:stream_id/debate-topic', (req, res) => {
    try {
        const streamId = req.params.stream_id;
        const { title, description, leftPosition, rightPosition } = req.body;
        
        // 验证直播流是否存在
        const streamExists = streams.some(stream => stream.id === streamId);
        if (!streamExists) {
            return res.status(404).json({
                success: false,
                message: '直播流不存在',
                error: 'STREAM_NOT_FOUND'
            });
        }
        
        // 验证必填参数
        if (!title || !leftPosition || !rightPosition) {
            return res.status(400).json({
                success: false,
                message: '参数验证失败：title、leftPosition、rightPosition 不能为空',
                error: 'VALIDATION_ERROR'
            });
        }
        
        // 查找是否已存在该直播流的辩题
        const existingIndex = debateTopics.findIndex(topic => topic.streamId === streamId);
        
        // 创建新的辩题数据
        const debateTopicData = {
            id: existingIndex >= 0 ? debateTopics[existingIndex].id : `debate-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            streamId: streamId,
            title: title,
            description: description || '',
            leftPosition: leftPosition,
            rightPosition: rightPosition,
            createdAt: existingIndex >= 0 ? debateTopics[existingIndex].createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // 更新或添加辩题
        if (existingIndex >= 0) {
            debateTopics[existingIndex] = debateTopicData;
        } else {
            debateTopics.push(debateTopicData);
        }
        
        res.json({
            success: true,
            message: '辩题设置成功',
            data: debateTopicData
        });
    } catch (error) {
        console.error('设置辩题失败:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: 'INTERNAL_ERROR'
        });
    }
});

// 更新直播流辩题
router.put('/streams/:stream_id/debate-topic', (req, res) => {
    try {
        const streamId = req.params.stream_id;
        const { title, description, leftPosition, rightPosition } = req.body;
        
        // 查找辩题
        const topicIndex = debateTopics.findIndex(topic => topic.streamId === streamId);
        if (topicIndex === -1) {
            return res.status(404).json({
                success: false,
                message: '该直播流尚未设置辩题',
                error: 'DEBATE_TOPIC_NOT_FOUND'
            });
        }
        
        // 验证必填参数
        if (!title || !leftPosition || !rightPosition) {
            return res.status(400).json({
                success: false,
                message: '参数验证失败：title、leftPosition、rightPosition 不能为空',
                error: 'VALIDATION_ERROR'
            });
        }
        
        // 更新辩题
        const updatedTopic = {
            ...debateTopics[topicIndex],
            title: title,
            description: description || '',
            leftPosition: leftPosition,
            rightPosition: rightPosition,
            updatedAt: new Date().toISOString()
        };
        
        debateTopics[topicIndex] = updatedTopic;
        
        res.json({
            success: true,
            message: '辩题更新成功',
            data: updatedTopic
        });
    } catch (error) {
        console.error('更新辩题失败:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: 'INTERNAL_ERROR'
        });
    }
});

// 获取直播流辩题
router.get('/streams/:stream_id/debate-topic', (req, res) => {
    try {
        const streamId = req.params.stream_id;
        
        // 查找辩题
        const topic = debateTopics.find(t => t.streamId === streamId);
        
        if (!topic) {
            return res.status(404).json({
                success: false,
                message: '该直播流尚未设置辩题',
                error: 'DEBATE_TOPIC_NOT_FOUND'
            });
        }
        
        res.json({
            success: true,
            data: topic
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

// 删除直播流辩题
router.delete('/streams/:stream_id/debate-topic', (req, res) => {
    try {
        const streamId = req.params.stream_id;
        
        // 查找辩题索引
        const topicIndex = debateTopics.findIndex(t => t.streamId === streamId);
        
        if (topicIndex === -1) {
            return res.status(404).json({
                success: false,
                message: '该直播流尚未设置辩题',
                error: 'DEBATE_TOPIC_NOT_FOUND'
            });
        }
        
        // 删除辩题
        debateTopics.splice(topicIndex, 1);
        
        res.json({
            success: true,
            message: '辩题删除成功'
        });
    } catch (error) {
        console.error('删除辩题失败:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: 'INTERNAL_ERROR'
        });
    }
});

module.exports = router;