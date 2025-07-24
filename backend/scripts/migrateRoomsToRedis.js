// backend/scripts/migrateRoomsToRedis.js
const mongoose = require('mongoose');
const redisClient = require('../utils/redisClient');
const Room = require('../models/Room');
require('dotenv').config();
const keys = require('../config/keys');

async function migrateRoomsToRedis() {
  if (!keys.mongoURI) {
    console.error('MongoDB URI가 설정되어 있지 않습니다. .env 파일 또는 backend/config/keys.js를 확인하세요.');
    process.exit(1);
  }
  await mongoose.connect(keys.mongoURI); // 환경변수에서 MongoDB URI 사용
  const client = await redisClient.connect();

  const rooms = await Room.find({}).lean();
  for (const room of rooms) {
    // zset에 추가 (score: 생성시간)
    await client.sendCommand([
      'ZADD',
      'chat:rooms:ids',
      String(new Date(room.createdAt).getTime()),
      String(room._id)
    ]);
    // 상세 정보도 캐시에 저장 (선택)
    await client.set(`chat:room:${room._id}`, JSON.stringify(room), { EX: 3600 });
  }
  console.log(`Migrated ${rooms.length} rooms to Redis`);
  process.exit(0);
}

migrateRoomsToRedis();