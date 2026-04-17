import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import BiAgentPanel from "@/components/builder/BiAgentPanel";
import { api, ApiError, type ApiBiAgentRunResponse } from "@/lib/api";

const buildResponse = (overrides: Partial<ApiBiAgentRunResponse> = {}): ApiBiAgentRunResponse => ({
  success: true,
  error: null,
  answer: "Resposta do BI Agent",
  executive_summary: "Resumo executivo",
  key_findings: ["Achado 1", "Achado 2"],
  limitations: ["Limitacao 1"],
  ambiguities: [],
  answer_confidence: 0.82,
  evidence: [
    {
      tool: "lens.run_query",
      summary: "Consulta principal executada",
      timestamp: "2026-03-31T12:00:00Z",
      data: {},
    },
  ],
  tool_calls: [
    {
      step_id: "step-1",
      tool: "lens.run_query",
      category: "analysis",
      success: true,
      attempt: 1,
      skipped: false,
      error: null,
      warnings: [],
      validation_errors_count: 0,
      metadata: {},
      executed_at: "2026-03-31T12:00:00Z",
    },
  ],
  warnings: [],
  validation_errors: [],
  dashboard_plan: null,
  dashboard_draft: null,
  next_best_actions: ["Analisar por canal"],
  clarifying_questions: [],
  user_friendly_findings: ["Achado 1"],
  trace_id: "trace-123",
  stopping_reason: "confidence_sufficient",
  analysis_state: {
    question: "Pergunta",
    intent: "kpi_summary",
    ambiguity_level: "low",
    covered_candidate_ids: ["cand-1"],
    covered_dimensions: ["canal"],
    temporal_coverage: true,
    dimensional_coverage: true,
    current_confidence: 0.82,
    last_decision_reason: "confidence_sufficient",
    open_ambiguities_count: 0,
    hypotheses: [],
    evidence_gaps: [],
  },
  ...overrides,
});

const renderPanel = (datasetId: number | null = 42) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <BiAgentPanel datasetId={datasetId} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
};

describe("BiAgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("chama endpoint do BI Agent com dataset_id correto", async () => {
    const runBiAgentSpy = vi.spyOn(api, "runBiAgent").mockResolvedValue(buildResponse());
    renderPanel(77);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Quais sao os principais KPIs?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    await waitFor(() => expect(runBiAgentSpy).toHaveBeenCalledTimes(1));
    expect(runBiAgentSpy).toHaveBeenCalledWith({
      dataset_id: 77,
      question: "Quais sao os principais KPIs?",
      mode: "answer",
      apply_changes: false,
      conversation_history: [],
    });
  });

  it("mostra loading state durante execucao", async () => {
    const runBiAgentSpy = vi.spyOn(api, "runBiAgent").mockImplementation(
      () => new Promise<ApiBiAgentRunResponse>(() => {}),
    );
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Pergunta em andamento" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    await waitFor(() => expect(runBiAgentSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("bi-agent-state")).toHaveTextContent("Enviando");
  });

  it("mostra success state e renderiza abas", async () => {
    vi.spyOn(api, "runBiAgent").mockResolvedValue(buildResponse());
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Gere uma analise" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    expect(await screen.findByText(/Resposta do BI Agent/)).toBeInTheDocument();
    expect(screen.getByTestId("bi-agent-state")).toHaveTextContent("Sucesso");

    fireEvent.click(screen.getByRole("tab", { name: "Evidencias" }));
    expect(screen.getByText("Achado 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Auditoria" }));
    expect(screen.getByText(/trace-123/)).toBeInTheDocument();
    expect(screen.getByText(/confidence_sufficient/)).toBeInTheDocument();
  });

  it("prioriza sintese final estruturada do backend no chat", async () => {
    vi.spyOn(api, "runBiAgent").mockResolvedValue(buildResponse({
      answer: "m0=82.98",
      final_answer: {
        response_status: "needs_clarification",
        short_chat_message: "Analisei sua pergunta, mas preciso de um refinamento para responder com precisao.",
        direct_answer: null,
        why_not_fully_answered: "A metrica principal nao foi especificada.",
        assumptions_used: ["Considerei receita como metrica inicial."],
        clarifying_questions: ["Qual metrica voce quer analisar?"],
        recommended_next_step: "Definir metrica e periodo alvo.",
        confidence_explanation: "A confianca esta moderada porque ha ambiguidade na pergunta.",
        user_friendly_findings: ["Ha sinais de variacao por categoria."],
      },
      response_status: "needs_clarification",
      short_chat_message: "Analisei sua pergunta, mas preciso de um refinamento para responder com precisao.",
      clarifying_questions: ["Qual metrica voce quer analisar?"],
      recommended_next_step: "Definir metrica e periodo alvo.",
      confidence_explanation: "A confianca esta moderada porque ha ambiguidade na pergunta.",
      user_friendly_findings: ["Ha sinais de variacao por categoria."],
    }));
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Como foi?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    expect(await screen.findByText(/preciso de um refinamento/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Qual metrica voce quer analisar/i })).toBeInTheDocument();
  });

  it("prioriza chat_presentation quando backend fornecer mensagem pronta", async () => {
    vi.spyOn(api, "runBiAgent").mockResolvedValue(buildResponse({
      chat_presentation: {
        response_status: "answered",
        primary_message: "Os principais KPIs deste dataset sao Receita Total, Volume e Ticket Medio.",
        direct_answer: "Receita Total parece ser o KPI mais relevante neste contexto.",
        supporting_points: ["Receita Total apareceu com maior cobertura nas consultas executadas."],
        follow_up_questions: ["Quer que eu detalhe esses KPIs por periodo?"],
        recommended_next_step: "Analisar variacao mensal.",
        confidence_message: "Confianca alta.",
      },
      final_answer: {
        response_status: "answered",
        short_chat_message: "Mensagem alternativa da sintese.",
        direct_answer: null,
        why_not_fully_answered: null,
        assumptions_used: [],
        clarifying_questions: [],
        recommended_next_step: null,
        confidence_explanation: null,
        user_friendly_findings: [],
      },
    }));
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Quais sao os principais KPIs?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    expect(await screen.findByText(/Os principais KPIs deste dataset/i)).toBeInTheDocument();
    expect(screen.queryByText(/Mensagem alternativa da sintese/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quer que eu detalhe esses KPIs por periodo/i })).toBeInTheDocument();
  });

  it("mostra error state quando falha", async () => {
    vi.spyOn(api, "runBiAgent").mockRejectedValue(new ApiError("Falha", 500, "Falha de teste"));
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Pergunta com erro" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    expect(await screen.findByText("Falha de teste")).toBeInTheDocument();
    expect(screen.getByTestId("bi-agent-state")).toHaveTextContent("Erro");
  });

  it("usa sugestao rapida no estado vazio", async () => {
    const runBiAgentSpy = vi.spyOn(api, "runBiAgent").mockResolvedValue(buildResponse());
    renderPanel(88);

    fireEvent.click(screen.getByText("Quais sao os principais KPIs deste dataset?"));

    await waitFor(() => expect(runBiAgentSpy).toHaveBeenCalledTimes(1));
    expect(runBiAgentSpy).toHaveBeenCalledWith({
      dataset_id: 88,
      question: "Quais sao os principais KPIs deste dataset?",
      mode: "answer",
      apply_changes: false,
      conversation_history: [],
    });
  });

  it("desabilita envio quando dataset_id nao esta disponivel", () => {
    renderPanel(null);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });

  it("permite clicar em pergunta sugerida de continuidade", async () => {
    const runBiAgentSpy = vi.spyOn(api, "runBiAgent")
      .mockResolvedValueOnce(buildResponse({
        ambiguities: [{
          code: "ambiguous_metric",
          description: "Nao ficou claro qual metrica analisar",
          alternatives: ["receita", "margem"],
          suggested_refinement: "Qual metrica voce quer analisar?",
        }],
        analysis_state: {
          ...buildResponse().analysis_state!,
          ambiguity_level: "high",
        },
      }))
      .mockResolvedValueOnce(buildResponse({ answer: "Resposta refinada" }));
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Como foi?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    const followUpButton = await screen.findByRole("button", { name: /Qual metrica voce quer analisar/i });
    fireEvent.click(followUpButton);

    await waitFor(() => expect(runBiAgentSpy).toHaveBeenCalledTimes(2));
  });

  it("mantem contexto da conversa em perguntas seguintes", async () => {
    const runBiAgentSpy = vi.spyOn(api, "runBiAgent")
      .mockResolvedValueOnce(buildResponse({ answer: "Primeira resposta" }))
      .mockResolvedValueOnce(buildResponse({ answer: "Segunda resposta" }));
    renderPanel(42);

    const input = screen.getByPlaceholderText("Pergunte algo sobre este dataset...");
    fireEvent.change(input, { target: { value: "Como foi a receita?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });
    await screen.findByText(/Primeira resposta/);

    fireEvent.change(input, { target: { value: "E por estacao?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });
    await screen.findByText(/Segunda resposta/);

    await waitFor(() => expect(runBiAgentSpy).toHaveBeenCalledTimes(2));
    const secondPayload = runBiAgentSpy.mock.calls[1]?.[0];
    expect(String(secondPayload?.question || "")).toBe("E por estacao?");
    expect(Array.isArray(secondPayload?.conversation_history)).toBe(true);
    expect(secondPayload?.conversation_history?.length).toBeGreaterThan(0);
    expect(secondPayload?.conversation_history?.some((item: { role: string; content: string }) => item.role === "assistant")).toBe(true);
  });
});
