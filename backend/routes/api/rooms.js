const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
const redisClient = require('../../utils/redisClient');
const { promisify } = require('util');
let io;

// 모든 방 목록 캐시를 패턴 기반으로 삭제하는 함수
const deleteRoomListCacheByPattern = async (pattern = 'chat:rooms:list:*') => {
  try {
    const client = await redisClient.connect();
    const keys = [];
    for await (const key of client.scanIterator({ MATCH: pattern })) {
      keys.push(key);
    }
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`[Redis] Deleted keys: ${keys.join(', ')}`);
    }
  } catch (e) {
    console.error('Redis pattern delete error:', e);
  }
};

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isMongoConnected ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 방 목록 조회 (zset + 상세 분리 캐시)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const search = req.query.search || '';
    // 정렬/검색이 없을 때만 캐시 사용
    if (!search) {
      const start = page * pageSize;
      const end = start + pageSize - 1;
      const client = await redisClient.connect();
      // 최신순으로 방 ID 가져오기 (sendCommand 사용)
      const roomIds = await client.sendCommand(['ZREVRANGE', 'chat:rooms:ids', String(start), String(end)]);
      // 상세 정보 병렬 조회
      let rooms = await Promise.all(roomIds.map(id => client.get(`chat:room:${id}`)));
      // 캐시에 없는 방은 DB에서 읽고, Redis에 저장
      for (let i = 0; i < rooms.length; i++) {
        if (!rooms[i]) {
          const dbRoom = await Room.findById(roomIds[i])
            .populate('creator', 'name email')
            .lean();
          if (dbRoom) {
            await client.set(`chat:room:${roomIds[i]}`, JSON.stringify(dbRoom), { EX: 3600 });
            rooms[i] = JSON.stringify(dbRoom);
          }
        }
      }
      // 파싱 및 응답 데이터 구성
      rooms = rooms.map(r => r && typeof r === 'string' ? JSON.parse(r) : r).filter(Boolean);
      const totalCount = await client.zCard('chat:rooms:ids');
      const totalPages = Math.ceil(totalCount / pageSize);
      const hasMore = (start + rooms.length) < totalCount;
      return res.json({
        success: true,
        data: rooms,
        metadata: {
          total: totalCount,
          page,
          pageSize,
          totalPages,
          hasMore,
          currentCount: rooms.length,
          sort: { field: 'createdAt', order: 'desc' }
        }
      });
    }
    // 검색어가 있을 때는 fallback: DB에서 조회
    const filter = {};
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }
    const totalCount = await Room.countDocuments(filter);
    const skip = page * pageSize;
    const rooms = await Room.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('creator', 'name email')
      .lean();
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;
    return res.json({
      success: true,
      data: rooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: rooms.length,
        sort: { field: 'createdAt', order: 'desc' }
      }
    });
  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    res.status(500).json({
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    });
  }
});

// 채팅방 생성 (zset + 상세 분리 캐시)
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }
    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });
    const savedRoom = await newRoom.save();
    const populatedRoom = await Room.findById(savedRoom._id)
      .populate('creator', 'name email')
      .populate('participants', 'name email')
      .lean();
    // Redis에 상세 정보 저장
    const client = await redisClient.connect();
    await client.set(`chat:room:${populatedRoom._id}`, JSON.stringify(populatedRoom), { EX: 3600 });
    // zset에 방 ID 추가 (score: 생성 시간)
    await client.zAdd('chat:rooms:ids', [{ score: new Date(populatedRoom.createdAt).getTime(), value: String(populatedRoom._id) }]);
    // Socket.IO 알림
    if (io) {
      io.to('room-list').emit('roomCreated', {
        ...populatedRoom,
        password: undefined
      });
    }
    res.status(201).json({
      success: true,
      data: {
        ...populatedRoom,
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate('creator', 'name email')
      .populate('participants', 'name email');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      if (!password) {
        return res.status(400).json({
          success: false,
          message: '비밀번호를 입력해주세요.'
        });
      }
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
    }

    const populatedRoom = await room.populate('participants', 'name email');

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }

    res.json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};