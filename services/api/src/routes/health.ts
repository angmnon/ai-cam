/** 健康检查（P0-5） */
import type { FastifyPluginAsync } from "fastify";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return ok({
      service: "ai-cam-api",
      status: "ok",
      time: new Date().toISOString(),
    });
  });
};

export default fp(healthRoutes);
