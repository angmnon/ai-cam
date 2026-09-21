/**
 * P0-04 R2 适配器本地集成实测（MinIO，S3 兼容）。
 *
 * 运行前提：docker compose up -d minio（localhost:9000，minioadmin/minioadmin）。
 * - MinIO 在线：实测 put/get/head 往返 + presigned PUT 直传 + presigned GET 直读。
 * - MinIO 离线：所有用例 skip（不计失败），保证 `pnpm test` 在无 S3 环境下仍全绿。
 *
 * 本测试仅对 R2Adapter 做黑盒集成，不依赖 Fastify app。
 * 注意：describe.runIf 的谓词在收集期求值，故连通性检查必须在顶层 await 完成。
 */
import { describe, expect, it } from "vitest";
import { S3Client, CreateBucketCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import { R2Adapter } from "./r2-adapter.js";

const ENDPOINT = process.env.R2_ENDPOINT ?? "http://localhost:9000";
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID ?? "minioadmin";
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "minioadmin";
const BUCKET = process.env.R2_BUCKET ?? "aicam-r2-test";
const ORG = "org_test";

async function prepare(): Promise<{ available: boolean; adapter?: R2Adapter }> {
  const client = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  try {
    await client.send(new ListBucketsCommand({}));
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (!/BucketAlreadyExists|BucketAlreadyOwnedByYou/.test(name)) throw err;
    }
    const adapter = new R2Adapter({
      accountId: "minio",
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      bucket: BUCKET,
      publicUrl: ENDPOINT,
      endpoint: ENDPOINT,
    });
    return { available: true, adapter };
  } catch {
    return { available: false };
  }
}

const { available: minioAvailable, adapter } = await prepare();

describe.runIf(minioAvailable)("R2Adapter over MinIO (S3-compatible)", () => {
  it("put → head → get 往返一致（含 content-type / size）", async () => {
    const payload = Buffer.from("ai-cam R2 roundtrip ✓", "utf8");
    const key = `${ORG}/cad_source/part_rt/v1/hello.txt`;
    const meta = await adapter!.put(key, payload, "text/plain", ORG);

    expect(meta.content_type).toBe("text/plain");
    expect(meta.size_bytes).toBe(payload.length);
    expect(meta.org_id).toBe(ORG);
    expect(meta.filename).toBe("hello.txt");

    const head = await adapter!.head(key);
    expect(head).not.toBeNull();
    expect(head!.size_bytes).toBe(payload.length);

    const back = await adapter!.get(key);
    expect(back.data.toString("utf8")).toBe("ai-cam R2 roundtrip ✓");
    expect(back.contentType).toBe("text/plain");

    // 不存在的 key → head 返回 null
    expect(await adapter!.head(`${ORG}/nope/missing.txt`)).toBeNull();
  });

  it("presigned PUT：前端直传 URL 可上传，再经 get 取回", async () => {
    const session = await adapter!.createUploadSession(
      ORG,
      "CAD_SOURCE",
      "part_presign",
      "v1",
      "upload.bin",
      "application/octet-stream",
      1024,
    );
    expect(session.method).toBe("PUT");
    expect(session.upload_url).toContain(ENDPOINT);
    // 短期过期：expires_at 在未来 15 分钟内
    const expMs = new Date(session.expires_at).getTime();
    expect(expMs).toBeGreaterThan(Date.now());
    expect(expMs).toBeLessThanOrEqual(Date.now() + 20 * 60 * 1000);

    const body = Buffer.from("presigned-put-body", "utf8");
    const res = await fetch(session.upload_url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    expect([200, 204]).toContain(res.status);

    const fetched = await adapter!.get(session.key);
    expect(fetched.data.toString("utf8")).toBe("presigned-put-body");
  });

  it("presigned GET：直读 URL 取回对象字节", async () => {
    const key = `${ORG}/toolpath/tp_get/v1/presign.txt`;
    const payload = Buffer.from("presigned-get-bytes", "utf8");
    await adapter!.put(key, payload, "text/plain", ORG);

    const url = await adapter!.presignedGetUrl(key, 300);
    expect(url).toContain(ENDPOINT);
    expect(url).toContain("X-Amz-Signature");

    const res = await fetch(url, { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("presigned-get-bytes");
  });

  it("put 跨租户 key 被拒绝（org 前缀校验）", async () => {
    await expect(adapter!.put("other_org/x/y/z/f.txt", Buffer.from("x"), "text/plain", ORG)).rejects.toMatchObject({
      code: "AUTH_TENANT_MISMATCH",
    });
  });
});
