/**
 * P1-03 E2E 专用 API 启动器：注入 bootstrap（admin / ADMIN）后启动已编译的 API。
 * 用于 Playwright webServer；不污染 .env，所有变量仅在本进程内。
 * 注意：仓库 dev 脚本用 --experimental-strip-types，但 Windows 下 .js->.ts 解析不可用，
 * 故 E2E 直接运行 pnpm --filter @ai-cam/api build 后的 dist/index.js。
 */
process.env.PORT ||= "8090";
process.env.HOST ||= "127.0.0.1";
process.env.JWT_SECRET ||= "e2e-secret";
process.env.CAM_BOOTSTRAP_EMAIL ||= "admin@ai-cam.local";
process.env.CAM_BOOTSTRAP_PASSWORD ||= "admin123";
process.env.CAM_BOOTSTRAP_ROLE ||= "ADMIN";
process.env.LOG_LEVEL ||= "warn";
process.env.PARTS_ANALYZER ||= "fixture";

await import("../services/api/dist/index.js");
