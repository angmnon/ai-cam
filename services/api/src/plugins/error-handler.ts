/** 统一错误处理：ApiError → 统一错误体；未知错误 → SYSTEM_INTERNAL（详情只入日志） */
import type { FastifyPluginAsync } from "fastify";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { fpRoot } from "./fp.js";

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(error.toResponse(request.requestId));
    }
    // Fastify 内置校验错误（schema validation）
    const validation = (error as { validation?: Array<{ message?: string; instancePath?: string }> }).validation;
    if (validation && validation.length > 0) {
      const wrapped = new ApiError({
        code: ErrorCodes.SYSTEM_VALIDATION,
        message: "Request validation failed.",
        stage: "api",
        details: { issues: validation.map((v) => ({ message: v.message, path: v.instancePath })) },
      });
      return reply.status(422).send(wrapped.toResponse(request.requestId));
    }
    request.log.error({ err: error }, "unhandled error");
    const wrapped = new ApiError({
      code: ErrorCodes.SYSTEM_INTERNAL,
      message: "Internal server error.",
      stage: "api",
      retryable: true,
    });
    return reply.status(500).send(wrapped.toResponse(request.requestId));
  });
};

export default fpRoot(errorHandlerPlugin);
