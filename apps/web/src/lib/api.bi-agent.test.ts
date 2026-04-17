import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  clearAuthSession: vi.fn(),
  getAuthToken: vi.fn(),
  isAuthTokenFresh: vi.fn(),
  setAuthSession: vi.fn(),
  updateAuthToken: vi.fn(),
  updateStoredUser: vi.fn(),
}));

import { api } from "@/lib/api";
import { getAuthToken, isAuthTokenFresh } from "@/lib/auth";

describe("api.runBiAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthToken).mockReturnValue("fake-token");
    vi.mocked(isAuthTokenFresh).mockReturnValue(true);
  });

  it("envia payload esperado para /bi-agent/run", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        error: null,
        answer: "Resposta do BI Agent",
        executive_summary: "Resumo",
        key_findings: [],
        limitations: [],
        ambiguities: [],
        answer_confidence: 0.74,
        evidence: [],
        tool_calls: [],
        warnings: [],
        validation_errors: [],
        dashboard_plan: null,
        dashboard_draft: null,
        next_best_actions: [],
        trace_id: "trace-001",
        stopping_reason: "confidence_sufficient",
        analysis_state: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await api.runBiAgent({
      dataset_id: 11,
      question: "Quais sao os principais KPIs?",
      mode: "answer",
      apply_changes: false,
    });

    expect(response.trace_id).toBe("trace-001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/bi-agent/run");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain('"dataset_id":11');
    expect(String(init?.body)).toContain('"mode":"answer"');
    expect(String(init?.body)).toContain('"apply_changes":false');
  });
});
