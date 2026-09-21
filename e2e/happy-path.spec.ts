import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

/**
 * P1-03 前端 happy path（Chromium）：
 * login(admin@ai-cam.local) → 上传 STEP → analyze → features/dfm → AI plan(mock) →
 * generate toolpath → simulate → validate → release(approve+正式发布) → download NC。
 */
const stepFixture = resolve(process.cwd(), "e2e/fixtures/box.step");

test.describe("AI-CAM 前端 happy path", () => {
  test("完整工艺链路：登录→上传→分析→AI规划→刀路→仿真校验→发布→下载NC", async ({ page }) => {
    // 1) 登录
    await page.goto("/");
    await page.getByRole("textbox").first().fill("admin@ai-cam.local");
    await page.locator('input[type="password"]').fill("admin123");
    await page.getByRole("button", { name: "登录" }).click();

    // 2) 上传 STEP 测试件并解析（等待文件输入出现即登录成功）
    await expect(page.locator('input[type="file"]')).toBeAttached({ timeout: 15_000 });
    await page.locator('input[type="file"]').setInputFiles(stepFixture);
    await page.getByRole("button", { name: "上传并解析" }).click();

    // 3) 进入零件视图，确认 analyze 完成（features/dfm 已就绪）
    await expect(page.getByText("ANALYZED", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /AI 工艺规划/ })).toBeVisible();

    // 4) AI plan（mock）：输入目标 → 运行 → 应用
    await page.getByPlaceholder("输入加工目标").fill("表面光洁度优先");
    await page.getByRole("button", { name: "AI 规划" }).click();
    await expect(page.getByText("意图：")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Apply 生成新 CAM 计划" }).click();

    // 5) 生成 3 轴刀路（生成后按钮变为 disabled 的“已生成”态）
    await page.getByRole("button", { name: "生成 3 轴刀路" }).click();
    await expect(page.getByRole("button", { name: /已生成/ })).toBeVisible({ timeout: 30_000 });

    // 6) 一键 Job = 仿真 + 校验 → 完成后按钮变为“重新生成 Validated NC”
    await page.getByRole("button", { name: "一键生成 Validated NC" }).click();
    await expect(page.getByRole("button", { name: "重新生成 Validated NC" })).toBeVisible({ timeout: 40_000 });

    // 7) Release：发起申请 → 审批通过（ADMIN）→ 正式发布
    await page.getByRole("button", { name: "发起 Release 申请" }).click();
    await expect(page.getByText("PENDING_APPROVAL", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "审批通过" }).click();
    await expect(page.getByText("APPROVED", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "正式发布" }).click();
    await expect(page.getByText("RELEASED", { exact: true })).toBeVisible({ timeout: 15_000 });

    // 8) 下载 / 查看 NC 程序
    await page.getByRole("button", { name: "查看 NC 程序" }).click();
    await expect(page.locator("pre").first()).toBeVisible({ timeout: 15_000 });
    const ncText = await page.locator("pre").first().innerText();
    expect(ncText.length).toBeGreaterThan(10);
  });
});
