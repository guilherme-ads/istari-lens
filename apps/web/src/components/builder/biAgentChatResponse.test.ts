import { describe, expect, it } from "vitest";

import type { ApiBiAgentRunResponse } from "@/lib/api";
import { buildContextualQuestion, buildConversationHistory, buildFinalChatResponse } from "@/components/builder/biAgentChatResponse";

const makeResponse = (overrides: Partial<ApiBiAgentRunResponse> = {}): ApiBiAgentRunResponse => ({
  success: true,
  error: null,
  answer: "A receita caiu 12% no ultimo trimestre.",
  executive_summary: "A principal queda veio do canal X.",
  key_findings: ["Canal X puxou a queda", "Regiao Sul teve maior variacao"],
  limitations: [],
  ambiguities: [],
  answer_confidence: 0.82,
  evidence: [],
  tool_calls: [],
  warnings: [],
  validation_errors: [],
  dashboard_plan: null,
  dashboard_draft: null,
  next_best_actions: ["Analisar por estacao"],
  clarifying_questions: [],
  user_friendly_findings: ["Canal X puxou a queda"],
  trace_id: "trace-1",
  stopping_reason: "confidence_sufficient",
  analysis_state: {
    question: "Pergunta",
    intent: "diagnostic_analysis",
    ambiguity_level: "low",
    covered_candidate_ids: [],
    covered_dimensions: [],
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

describe("biAgentChatResponse", () => {
  it("gera resposta clara quando ha answer", () => {
    const final = buildFinalChatResponse({
      question: "O que aconteceu com a receita?",
      response: makeResponse(),
    });

    expect(final.text).toContain("resposta mais direta");
    expect(final.text).toContain("A receita caiu 12% no ultimo trimestre.");
    expect(final.followUpQuestions.length).toBeGreaterThan(0);
  });

  it("gera perguntas de continuidade quando ha ambiguidade", () => {
    const final = buildFinalChatResponse({
      question: "Como foi?",
      response: makeResponse({
        ambiguities: [{
          code: "ambiguous_metric",
          description: "Nao ficou claro qual metrica analisar",
          alternatives: ["receita", "margem"],
          suggested_refinement: "Qual metrica voce quer analisar?",
        }],
        analysis_state: {
          ...makeResponse().analysis_state!,
          ambiguity_level: "high",
        },
      }),
    });

    expect(final.text).toContain("ambiguidade importante");
    expect(final.followUpQuestions.some((item) => item.toLowerCase().includes("metrica"))).toBe(true);
  });

  it("explica insuficiencia quando nao ha resposta suficiente", () => {
    const final = buildFinalChatResponse({
      question: "Qual foi o impacto?",
      response: makeResponse({
        answer: "",
        answer_confidence: 0.18,
        limitations: ["Nao foi possivel identificar metrica principal"],
      }),
    });

    expect(final.text).toContain("nao consegui responder");
    expect(final.text).toContain("Motivo principal");
  });

  it("inclui contexto recente ao montar pergunta contextual", () => {
    const contextual = buildContextualQuestion({
      currentQuestion: "E por estacao?",
      messages: [
        { role: "user", content: "Quais dimensoes explicam a queda?" },
        { role: "assistant", content: "A principal queda foi no canal X." },
      ],
    });

    expect(contextual).toBe("E por estacao?");
  });

  it("gera historico estruturado para memoria curta", () => {
    const history = buildConversationHistory({
      messages: [
        { role: "user", content: "Quais dimensoes explicam a queda?" },
        { role: "assistant", content: "A principal queda foi no canal X." },
      ],
      maxTurns: 2,
    });
    expect(history.length).toBe(2);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("assistant");
  });

  it("usa sintese estruturada do backend quando disponivel", () => {
    const final = buildFinalChatResponse({
      question: "Como foi?",
      response: makeResponse({
        final_answer: {
          response_status: "needs_clarification",
          short_chat_message: "Preciso de mais contexto para responder com seguranca.",
          direct_answer: null,
          why_not_fully_answered: "A pergunta nao especifica a metrica.",
          assumptions_used: [],
          clarifying_questions: ["Qual metrica voce quer analisar?"],
          recommended_next_step: "Definir metrica e periodo.",
          confidence_explanation: "Confianca moderada por ambiguidade.",
          user_friendly_findings: ["Existe variacao entre categorias."],
        },
        response_status: "needs_clarification",
        short_chat_message: "Preciso de mais contexto para responder com seguranca.",
        clarifying_questions: ["Qual metrica voce quer analisar?"],
        recommended_next_step: "Definir metrica e periodo.",
        confidence_explanation: "Confianca moderada por ambiguidade.",
        user_friendly_findings: ["Existe variacao entre categorias."],
      }),
    });

    expect(final.text).toContain("Preciso de mais contexto");
    expect(final.followUpQuestions).toContain("Qual metrica voce quer analisar?");
  });

  it("prioriza chat_presentation quando disponivel", () => {
    const final = buildFinalChatResponse({
      question: "Quais sao os principais KPIs?",
      response: makeResponse({
        chat_presentation: {
          response_status: "answered",
          primary_message: "Os principais KPIs deste dataset sao Receita Total, Volume e Ticket Medio.",
          direct_answer: "Receita Total e o KPI mais relevante neste contexto.",
          supporting_points: ["Receita Total tem maior cobertura nas consultas."],
          follow_up_questions: ["Quer detalhar esses KPIs por periodo?"],
          recommended_next_step: "Analisar tendencia mensal.",
          confidence_message: "Confianca alta.",
        },
        final_answer: {
          response_status: "needs_clarification",
          short_chat_message: "Fallback sintetizado",
          direct_answer: null,
          why_not_fully_answered: "Faltou metrica",
          assumptions_used: [],
          clarifying_questions: [],
          recommended_next_step: null,
          confidence_explanation: null,
          user_friendly_findings: [],
        },
      }),
    });

    expect(final.text).toContain("Os principais KPIs deste dataset");
    expect(final.text).not.toContain("Fallback sintetizado");
    expect(final.followUpQuestions).toContain("Quer detalhar esses KPIs por periodo?");
  });

  it("nao duplica direct_answer quando igual a primary_message", () => {
    const final = buildFinalChatResponse({
      question: "Qual e o resultado?",
      response: makeResponse({
        chat_presentation: {
          response_status: "answered",
          primary_message: "A estacao mais usada e BYD SAGA 2.",
          direct_answer: "A estacao mais usada e BYD SAGA 2.",
          supporting_points: ["Baseado em ranking por estacao."],
          follow_up_questions: [],
          recommended_next_step: null,
          confidence_message: "Confianca alta.",
        },
      }),
    });

    const occurrences = final.text.split("A estacao mais usada e BYD SAGA 2.").length - 1;
    expect(occurrences).toBe(1);
  });
});
