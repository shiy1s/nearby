import { Redis } from '@upstash/redis';
import * as blob from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { createHandler } from '../cloud/handler.mjs';

let redis;
export default createHandler({ getRedis: () => redis ||= Redis.fromEnv(), blob, handleUpload });
