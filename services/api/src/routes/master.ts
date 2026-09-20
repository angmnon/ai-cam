/** 主数据路由：机床/控制器/刀具/材料/切削规则（Phase 1 种子） */
import type { FastifyPluginAsync } from "fastify";
import { getMasterData } from "@ai-cam/master-data";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

const masterRoutes: FastifyPluginAsync = async (app) => {
  app.get("/machines", async (request) => ok(getMasterData(request.user!.org_id).machines));
  app.get("/controllers", async (request) => ok(getMasterData(request.user!.org_id).controllers));
  app.get("/tools", async (request) => ok(getMasterData(request.user!.org_id).tools));
  app.get("/materials", async (request) => ok(getMasterData(request.user!.org_id).materials));
  app.get("/cutting-rules", async (request) => ok(getMasterData(request.user!.org_id).cutting_rules));
};

export default fp(masterRoutes);
