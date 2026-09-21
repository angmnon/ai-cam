/** 文件路由：上传会话 + 实际上传（P0-4） */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

const CreateSessionBody = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
  resource_type: z.enum([
    "CAD_SOURCE",
    "CAD_PARSED",
    "VIEW_MESH",
    "SIMULATION_MESH",
    "TOOLPATH",
    "FIXTURE_CAD",
    "NC_PROGRAM",
    "SETUP_SHEET",
    "PROCESS_REPORT",
    "SIMULATION_REPORT",
  ]),
  resource_id: z.string().min(1),
  version: z.string().default("v0"),
});

const fileRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/upload-sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "content_type", "size_bytes", "resource_type", "resource_id"],
          properties: {
            filename: { type: "string" },
            content_type: { type: "string" },
            size_bytes: { type: "integer" },
            resource_type: { type: "string" },
            resource_id: { type: "string" },
            version: { type: "string" },
          },
          tags: ["files"],
        },
      },
    },
    async (request) => {
      const body = CreateSessionBody.safeParse(request.body);
      if (!body.success) {
        throw new ApiError({
          code: ErrorCodes.SYSTEM_VALIDATION,
          message: "Invalid upload session payload.",
          stage: "files",
          details: { issues: body.error.issues },
        });
      }
      const orgId = request.user!.org_id;
      const session = await app.storage.createUploadSession(
        orgId,
        body.data.resource_type,
        body.data.resource_id,
        body.data.version,
        body.data.filename,
        body.data.content_type,
        body.data.size_bytes,
      );
      return ok(session);
    },
  );

  // 本地适配器上传端点（原始二进制；R2 模式不走此端点）
  // P0-2：不再读取 x-file-key 作为落盘路径；按 session_id 取回服务端 key，并校验会话属于当前 org。
  app.post("/upload", async (request, reply) => {
    const sessionId = request.headers["x-session-id"];
    const contentType = request.headers["content-type"] ?? "application/octet-stream";
    if (typeof sessionId !== "string") {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Missing x-session-id header.", stage: "files" });
    }
    // 服务端按 session_id 取回 key（内部已校验 org 归属 + 一次性 + 过期）
    const { key } = await app.storage.consumeUploadSession(sessionId, request.user!.org_id);
    const payload = (request.body as Buffer) ?? Buffer.alloc(0);
    // put 内部再次强制 orgId 前缀 + 路径穿越校验
    const meta = await app.storage.put(key, payload, String(contentType), request.user!.org_id);
    request.log.info({ session_id: sessionId, key, size: meta.size_bytes }, "file uploaded");
    return reply.status(201).send(ok(meta));
  });
};

export default fp(fileRoutes);
