// Mock数据文件

// 辩论设置（全局辩题）
exports.debate = {
    id: 'debate-001',
    title: '人工智能会取代人类工作吗？',
    description: '随着AI技术的快速发展，越来越多的工作岗位面临被自动化取代的风险。我们需要思考AI对就业市场的影响，以及如何应对这一挑战。',
    affirmativeSide: '正方：人工智能会取代大部分人类工作',
    negativeSide: '反方：人工智能不会完全取代人类工作',
    startTime: '2024-01-15T19:00:00Z',
    endTime: '2024-01-15T21:00:00Z',
    isActive: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-10T10:00:00Z'
};

// 直播流辩题数据（每个直播流对应一个辩题）
exports.debateTopics = [
    // 示例数据：为第一个直播流设置了辩题
    {
        id: 'debate-stream-001',
        streamId: 'stream-001',
        title: '如果有一个一键消除痛苦的按钮，你会按吗？',
        description: '这是一个关于痛苦、成长与人性选择的深度辩论',
        leftPosition: '会按',
        rightPosition: '不会按',
        createdAt: '2024-01-15T10:00:00Z',
        updatedAt: '2024-01-15T10:00:00Z'
    }
];

// 直播流数据
exports.streams = [
    {
        id: 'stream-001',
        name: '主会场直播',
        url: 'rtmp://localhost/live/main',
        type: 'rtmp',
        description: '辩论赛主会场直播流',
        enabled: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-10T10:00:00Z'
    },
    {
        id: 'stream-002',
        name: '分会场直播',
        url: 'http://localhost:8086/live/side.m3u8',
        type: 'hls',
        description: '辩论赛分会场直播流',
        enabled: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-10T10:00:00Z'
    },
    {
        id: 'stream-003',
        name: '嘉宾访谈',
        url: 'http://localhost:8086/live/guest.flv',
        type: 'flv',
        description: '赛后嘉宾访谈直播流',
        enabled: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-10T10:00:00Z'
    }
];

// 用户数据
exports.users = [
    {
        id: 'user-001',
        openid: 'wx1234567890',
        nickname: '张三',
        avatar: 'https://example.com/avatar1.jpg',
        role: 'admin',
        isOnline: true,
        lastActiveTime: new Date().toISOString(),
        createdAt: '2024-01-01T00:00:00Z'
    },
    {
        id: 'user-002',
        openid: 'wx0987654321',
        nickname: '李四',
        avatar: 'https://example.com/avatar2.jpg',
        role: 'user',
        isOnline: true,
        lastActiveTime: new Date().toISOString(),
        createdAt: '2024-01-02T00:00:00Z'
    },
    {
        id: 'user-003',
        openid: 'wx1357924680',
        nickname: '王五',
        avatar: 'https://example.com/avatar3.jpg',
        role: 'judge',
        isOnline: false,
        lastActiveTime: '2024-01-10T10:00:00Z',
        createdAt: '2024-01-03T00:00:00Z'
    }
];

// 统计数据
exports.statistics = {
    isLive: true,
    viewerCount: 1234,
    voteCount: 567,
    messageCount: 890,
    totalViews: 10000,
    totalUsers: 500,
    votes: {
        affirmative: 345,
        negative: 222
    },
    liveStartTime: '2024-01-15T19:00:00Z',
    liveDuration: 3600 // 秒
};

// 直播计划
exports.liveSchedule = {
    isScheduled: true,
    scheduledStartTime: '2024-01-15T19:00:00Z',
    scheduledEndTime: '2024-01-15T21:00:00Z',
    streamId: 'stream-001',
    title: '人工智能辩论大赛',
    description: '年度人工智能主题辩论大赛直播'
};

// AI识别状态
exports.aiStatus = {
    status: 'running',
    aiSessionId: 'ai-session-001',
    startTime: '2024-01-15T19:00:00Z',
    settings: {
        mode: 'realtime',
        interval: 5000,
        sensitivity: 'high',
        minConfidence: 0.7
    },
    statistics: {
        totalContents: 150,
        totalWords: 2000,
        averageConfidence: 0.85
    }
};