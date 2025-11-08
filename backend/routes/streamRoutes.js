const express = require('express');
const router = express.Router();
const { streams, debateTopics } = require('../data/mockData');

// 生成播放地址
function generatePlayUrls(stream) {
    const playUrls = {
        hls: null,
        flv: null,
        rtmp: null
    };
    
    const serverIP = process.env.SERVER_IP || 'localhost';
    const hlsServerPort = process.env.HLS_SERVER_PORT || '8086';
    const rtmpServerPort = process.env.RTMP_SERVER_PORT || '1935';
    
    // 从URL中提取流名称
    const getStreamName = (url) => {
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname;
            const parts = path.split('/').filter(p => p);
            return parts[parts.length - 1] || 'stream';
        } catch (e) {
            const match = url.match(/([^\/]+)(?:\.[^\.]+)?$/);
            return match ? match[1] : 'stream';
        }
    };
    
    switch (stream.type) {
        case 'hls':
            playUrls.hls = stream.url;
            if (stream.url.includes('.m3u8')) {
                playUrls.flv = stream.url.replace('.m3u8', '.flv');
            }
            break;
        case 'rtmp':
            const streamName = getStreamName(stream.url);
            playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
            playUrls.flv = `http://${serverIP}:${hlsServerPort}/live/${streamName}.flv`;
            playUrls.rtmp = stream.url.replace('localhost', serverIP);
            break;
        case 'flv':
            playUrls.flv = stream.url;
            if (stream.url.includes('.flv')) {
                const streamName = getStreamName(stream.url);
                playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
            }
            break;
        default:
            playUrls.hls = stream.url;
    }
    
    return playUrls;
}

// 获取直播流列表
router.get('/streams', (req, res) => {
    try {
        // 检查是否需要包含辩题信息
        const includeDebateTopic = req.query.includeDebateTopic === 'true';
        
        const streamsWithStatus = streams.map(stream => {
            const playUrls = generatePlayUrls(stream);
            const streamData = {
                ...stream,
                playUrls: playUrls,
                liveStatus: {
                    isLive: false,
                    liveId: null,
                    startTime: null,
                    stopTime: null,
                    streamUrl: stream.url
                }
            };
            
            // 如果需要包含辩题信息，查找并添加
            if (includeDebateTopic) {
                const debateTopic = debateTopics.find(topic => topic.streamId === stream.id);
                if (debateTopic) {
                    streamData.debateTopic = {
                        id: debateTopic.id,
                        title: debateTopic.title,
                        description: debateTopic.description,
                        leftPosition: debateTopic.leftPosition,
                        rightPosition: debateTopic.rightPosition,
                        updatedAt: debateTopic.updatedAt
                    };
                }
            }
            
            return streamData;
        });
        
        res.json({
            code: 0,
            message: 'success',
            data: {
                streams: streamsWithStatus,
                total: streams.length
            }
        });
    } catch (error) {
        console.error('获取直播流列表失败:', error);
        res.status(500).json({
            code: 500,
            message: '获取直播流列表失败',
            data: null
        });
    }
});

// 添加新的直播流
router.post('/streams', (req, res) => {
    try {
        const { name, url, type, description, enabled } = req.body;
        
        // 参数验证
        if (!name || !url || !type) {
            return res.status(400).json({
                code: 400,
                message: '缺少必要参数: name, url, type 必填',
                data: null
            });
        }
        
        // 验证URL格式
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({
                code: 400,
                message: '流地址格式不正确，请输入有效的URL',
                data: null
            });
        }
        
        // 验证type
        if (!['hls', 'rtmp', 'flv'].includes(type)) {
            return res.status(400).json({
                code: 400,
                message: 'type 必须是 hls, rtmp 或 flv',
                data: null
            });
        }
        
        // 创建新流
        const newStream = {
            id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: name.trim(),
            url: url.trim(),
            type,
            description: description ? description.trim() : '',
            enabled: enabled !== false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // 保存到mock数据
        streams.push(newStream);
        
        res.json({
            code: 0,
            message: '添加直播流成功',
            data: newStream
        });
    } catch (error) {
        console.error('添加直播流失败:', error);
        res.status(500).json({
            code: 500,
            message: '添加直播流失败',
            data: null
        });
    }
});

// 更新直播流
router.put('/streams/:id', (req, res) => {
    try {
        const streamId = req.params.id;
        const { name, url, type, description, enabled } = req.body;
        
        // 查找流
        const streamIndex = streams.findIndex(s => s.id === streamId);
        if (streamIndex === -1) {
            return res.status(404).json({
                code: 404,
                message: '直播流不存在',
                data: null
            });
        }
        
        // 验证URL格式（如果有更新）
        if (url) {
            try {
                new URL(url);
            } catch (e) {
                return res.status(400).json({
                    code: 400,
                    message: '流地址格式不正确，请输入有效的URL',
                    data: null
                });
            }
        }
        
        // 验证type（如果有更新）
        if (type && !['hls', 'rtmp', 'flv'].includes(type)) {
            return res.status(400).json({
                code: 400,
                message: 'type 必须是 hls, rtmp 或 flv',
                data: null
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
        Object.assign(streams[streamIndex], updates);
        
        res.json({
            code: 0,
            message: '更新直播流成功',
            data: streams[streamIndex]
        });
    } catch (error) {
        console.error('更新直播流失败:', error);
        res.status(500).json({
            code: 500,
            message: '更新直播流失败',
            data: null
        });
    }
});

// 删除直播流
router.delete('/streams/:id', (req, res) => {
    try {
        const streamId = req.params.id;
        
        // 查找流
        const streamIndex = streams.findIndex(s => s.id === streamId);
        if (streamIndex === -1) {
            return res.status(404).json({
                code: 404,
                message: '直播流不存在',
                data: null
            });
        }
        
        const deletedStream = streams[streamIndex];
        
        // 删除
        streams.splice(streamIndex, 1);
        
        res.json({
            code: 0,
            message: '删除直播流成功',
            data: {
                id: streamId,
                name: deletedStream.name
            }
        });
    } catch (error) {
        console.error('删除直播流失败:', error);
        res.status(500).json({
            code: 500,
            message: '删除直播流失败',
            data: null
        });
    }
});

module.exports = router;