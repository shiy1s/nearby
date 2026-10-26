import { Redis } from '@upstash/redis';
import * as blob from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { createHandler } from '../cloud/handler.mjs';

let redis;
export default createHandler({ getRedis: () => redis ||= new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
}), blob, handleUpload });
