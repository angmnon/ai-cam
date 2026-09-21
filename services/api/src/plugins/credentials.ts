/**
 * Phase 0 bootstrap 凭据校验（P0-01）。
 * 用 node:crypto 的 scrypt 做恒定时间比对，避免时序侧信道；
 * 不引入外部密码哈希依赖（本轮约束：不装新 npm 包）。
 */
import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
/** 派生摘要长度固定，便于 timingSafeEqual 等长比较 */
const KEYLEN = 64;
/** 明文回退用的静态 pepper（仅用于把明文归一到固定长度，非安全秘密） */
const DEMO_PEPPER = "ai-cam-bootstrap-v0";

export interface CredentialCheck {
  /** 明文密码（未配置哈希时使用） */
  password?: string;
  /** scrypt 哈希：{ salt, hashHex } */
  hash?: { salt: string; hashHex: string };
}

/** 恒定时间校验登录密码；返回 true 表示凭据正确 */
export async function verifyLoginPassword(plain: string, cred: CredentialCheck): Promise<boolean> {
  if (cred.hash) {
    // 配置了 scrypt 哈希：用配置盐派生后与存储摘要等长比较
    const derived = (await scryptAsync(plain, cred.hash.salt, KEYLEN)) as Buffer;
    const stored = Buffer.from(cred.hash.hashHex, "hex");
    if (derived.length !== stored.length) return false;
    return timingSafeEqual(derived, stored);
  }
  // 明文回退：双方都先经 scrypt 派生到固定长度再恒定时间比较，避免 === 的时序泄露
  const a = (await scryptAsync(plain, DEMO_PEPPER, KEYLEN)) as Buffer;
  const b = (await scryptAsync(cred.password ?? "", DEMO_PEPPER, KEYLEN)) as Buffer;
  return timingSafeEqual(a, b);
}
