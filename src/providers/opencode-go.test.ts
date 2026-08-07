import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { opencodeGoProvider, parseOpenCodeGoHtml } from "./opencode-go";

describe("parseOpenCodeGoHtml", () => {
  it("parses SolidJS SSR hydration output", () => {
    const html = `
      <script>
        const hydration = {
          rollingUsage:$R[123]={usagePercent:42.5,resetInSec:1234},
          weeklyUsage:$R[124]={resetInSec:5678,usagePercent:18},
          monthlyUsage:$R[125]={usagePercent:9,resetInSec:23456}
        };
      </script>
    `;

    const result = parseOpenCodeGoHtml(html);
    expect(result.rolling).toEqual({ usagePercent: 42.5, resetInSec: 1234 });
    expect(result.weekly).toEqual({ usagePercent: 18, resetInSec: 5678 });
    expect(result.monthly).toEqual({ usagePercent: 9, resetInSec: 23456 });
  });

  it("parses data-slot HTML fallback", () => {
    const html = `
      <div data-slot="usage-item">
        <span data-slot="usage-label">Rolling Usage</span>
        <span data-slot="usage-value">12%</span>
        <span data-slot="reset-time">1 hour 30 minutes</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Weekly Usage</span>
        <span data-slot="usage-value">36%</span>
        <span data-slot="reset-now">Resets now</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Monthly Usage</span>
        <span data-slot="usage-value">2.5%</span>
        <span data-slot="reset-time">26 days 17 hours</span>
      </div>
    `;

    const result = parseOpenCodeGoHtml(html);
    expect(result.rolling).toEqual({ usagePercent: 12, resetInSec: 5400 });
    expect(result.weekly).toEqual({ usagePercent: 36, resetInSec: 0 });
    expect(result.monthly).toEqual({ usagePercent: 2.5, resetInSec: 26 * 86_400 + 17 * 3_600 });
  });

  it("parses SolidJS-commented data-slot markup from the live dashboard", () => {
    const html = `
      <div data-slot="usage"><!--$-->
        <div data-slot="usage-item">
          <div data-slot="usage-header"><span data-slot="usage-label">Rolling Usage</span><span data-slot="usage-value"><!--$-->7.5<!--/-->%</span></div>
          <span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->5 hours<!--/--></span>
        </div>
        <div data-slot="usage-item">
          <div data-slot="usage-header"><span data-slot="usage-label">Weekly Usage</span><span data-slot="usage-value"><!--$-->2<!--/-->%</span></div>
          <span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->6 days 2 hours<!--/--></span>
        </div>
        <div data-slot="usage-item">
          <div data-slot="usage-header"><span data-slot="usage-label">Monthly Usage</span><span data-slot="usage-value"><!--$-->16.75<!--/-->%</span></div>
          <span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->26 days 17 hours<!--/--></span>
        </div>
      </div>
    `;

    const result = parseOpenCodeGoHtml(html);
    expect(result.rolling).toEqual({ usagePercent: 7.5, resetInSec: 5 * 3_600 });
    expect(result.weekly).toEqual({ usagePercent: 2, resetInSec: 6 * 86_400 + 2 * 3_600 });
    expect(result.monthly).toEqual({ usagePercent: 16.75, resetInSec: 26 * 86_400 + 17 * 3_600 });
  });

  it("returns empty object for unknown markup", () => {
    expect(parseOpenCodeGoHtml("<html>nothing</html>")).toEqual({});
  });
});

describe("opencodeGoProvider.fetch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses the real workspace id from vault credentials instead of credential status booleans", async () => {
    invokeMock
      .mockResolvedValueOnce({
        deepseekApiKey: true,
        opencodeGoWorkspaceId: true,
        opencodeGoAuthCookie: true,
        opencodeGoApiKey: false,
      })
      .mockResolvedValueOnce({
        deepseekApiKey: "sk-test",
        opencodeGoWorkspaceId: "wrk_01KZ6DTXDDNHR9BWAFVR4QGNR5",
        opencodeGoAuthCookie: "Fe26.2-test",
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        bodyText:
          "<script>rollingUsage:$R[1]={usagePercent:10,resetInSec:100}weeklyUsage:$R[2]={usagePercent:20,resetInSec:200}monthlyUsage:$R[3]={usagePercent:30,resetInSec:300}</script>",
      });

    const snapshot = await opencodeGoProvider.fetch();

    expect(snapshot.status).toBe("ok");
    expect(invokeMock).toHaveBeenCalledWith(
      "provider_request",
      expect.objectContaining({
        url: "https://opencode.ai/workspace/wrk_01KZ6DTXDDNHR9BWAFVR4QGNR5/go",
      }),
    );
  });
});
