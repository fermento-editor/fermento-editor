// server/redis.js
import Redis from "ioredis";

export const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : null;
