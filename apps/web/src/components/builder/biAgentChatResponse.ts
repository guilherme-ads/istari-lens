import type { ApiBiAgentRunResponse } from "@/lib/api";

export type FinalChatResponse = {
  text: string;
  followUpQuestions: string[];
};

type BuildFinalChatResponseInput = {
  question: string;
  response: ApiBiAgentRunResponse;
  hasConversationHistory?: boolean;
};

type BuildContextualQuestionInput = {
  currentQuestion: string;
  messages: Array<{ role: "user" | "assistant" | "ai"; content: string }>;
};

type BuildConversationHistoryInput = {
  messages: Array<{ role: "user" | "assistant" | "ai"; content: string }>;
  maxTurns?: number;
};

const toSentence = (value?: string | null): string => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[.!?]$/.test(text)) return text;
  return `${text}.`;
};

const dedupe = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
};

const sameText = (left?: string | null, right?: string | null): boolean => {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  return Boolean(a) && Boolean(b) && a === b;
};

const fromAmbiguities = (response: ApiBiAgentRunResponse): string[] => {
  const questions: string[] = [];
  for (const ambiguity of response.ambiguities || []) {
    if (ambiguity.suggested_refinement) {
      questions.push(toSentence(ambiguity.suggested_refinement));
    }
    for (const alternative of ambiguity.alternatives || []) {
      const alt = String(alternative || "").trim();
      if (!alt) continue;
      questions.push(`Voce quer seguir por ${alt}?`);
    }
  }
  return questions;
};

const fromLimitations = (response: ApiBiAgentRunResponse): string[] => {
  const joined = (response.limitations || []).join(" ").toLowerCase();
  const out: string[] = [];
  if (joined.includes("metrica")) {
    out.push("Qual metrica voce quer analisar?");
  }
  if (joined.includes("periodo") || joined.includes("temporal") || joined.includes("data")) {
    out.push("Qual periodo voce quer analisar?");
  }
  if (joined.includes("dimens") || joined.includes("segment")) {
    out.push("Por qual dimensao voce quer cortar a analise?");
  }
  return out;
};

const genericContinuation = (response: ApiBiAgentRunResponse): string[] => {
  const intent = String(response.analysis_state?.intent || "");
  if (intent === "dashboard_generation") {
    return ["Quer que eu monte um dashboard com isso?"];
  }
  if (intent === "diagnostic_analysis") {
    return ["Voce quer que eu aprofunde a analise por dimensao ou por periodo?"];
  }
  return ["Quer que eu aprofunde essa analise em algum recorte especifico?"];
};

export const buildFinalChatResponse = ({
  question,
  response,
  hasConversationHistory = false,
}: BuildFinalChatResponseInput): FinalChatResponse => {
  const chatPresentation = response.chat_presentation;
  if (chatPresentation?.primary_message) {
    const messageParts: string[] = [chatPresentation.primary_message];
    if (chatPresentation.direct_answer && !sameText(chatPresentation.primary_message, chatPresentation.direct_answer)) {
      messageParts.push(toSentence(chatPresentation.direct_answer));
    }
    if (chatPresentation.supporting_points.length > 0) {
      messageParts.push(
        `Principais pontos: ${chatPresentation.supporting_points.slice(0, 2).map((item) => toSentence(item)).join(" ")}`,
      );
    }
    const followups = dedupe([
      ...chatPresentation.follow_up_questions,
      ...(chatPresentation.recommended_next_step ? [toSentence(chatPresentation.recommended_next_step)] : []),
    ]);
    return {
      text: messageParts.join("\n\n"),
      followUpQuestions: followups.length > 0 ? followups : genericContinuation(response),
    };
  }

  const synthesized = response.final_answer;
  if (synthesized && synthesized.short_chat_message) {
    const synthesizedParts: string[] = [synthesized.short_chat_message];
    if (synthesized.direct_answer && !sameText(synthesized.short_chat_message, synthesized.direct_answer)) {
      synthesizedParts.push(toSentence(synthesized.direct_answer));
    }
    if (synthesized.why_not_fully_answered) synthesizedParts.push(toSentence(synthesized.why_not_fully_answered));
    if (synthesized.user_friendly_findings.length > 0) {
      synthesizedParts.push(
        `Principais pontos: ${synthesized.user_friendly_findings.slice(0, 2).map((item) => toSentence(item)).join(" ")}`,
      );
    }
    const followups = dedupe([
      ...synthesized.clarifying_questions,
      ...(synthesized.recommended_next_step ? [toSentence(synthesized.recommended_next_step)] : []),
    ]);
    return {
      text: synthesizedParts.join("\n\n"),
      followUpQuestions: followups.length > 0 ? followups : genericContinuation(response),
    };
  }

  const normalizedQuestion = String(question || "").trim();
  const answer = String(response.answer || "").trim();
  const executiveSummary = String(response.executive_summary || "").trim();
  const keyFindings = (response.key_findings || []).filter((item) => !!String(item || "").trim());
  const confidence = Number(response.answer_confidence || 0);
  const hasAmbiguity = (response.ambiguities || []).length > 0
    || ["medium", "high"].includes(String(response.analysis_state?.ambiguity_level || ""));

  const intro = hasConversationHistory
    ? "Com base no que ja conversamos,"
    : "Analisei sua pergunta";

  const parts: string[] = [];

  if (answer && confidence >= 0.35) {
    parts.push(`${intro} e esta e a resposta mais direta:`);
    parts.push(toSentence(answer));

    if (executiveSummary && executiveSummary.toLowerCase() !== answer.toLowerCase()) {
      parts.push(`Resumo: ${toSentence(executiveSummary)}`);
    }

    if (keyFindings.length > 0) {
      const highlights = keyFindings.slice(0, 2).map((item) => toSentence(item)).join(" ");
      parts.push(`Principais achados: ${highlights}`);
    }
  } else {
    const why = response.limitations?.[0]
      || response.warnings?.[0]
      || response.stopping_reason
      || "faltou evidencia suficiente para concluir";
    if (normalizedQuestion) {
      parts.push(`Sobre sua pergunta \"${normalizedQuestion}\", ainda nao consegui responder com seguranca.`);
    } else {
      parts.push("Ainda nao consegui responder sua pergunta com seguranca.");
    }
    parts.push(`Motivo principal: ${toSentence(why)}`);

    if (executiveSummary) {
      parts.push(`O que consegui ate aqui: ${toSentence(executiveSummary)}`);
    }
  }

  const followUpQuestions = dedupe([
    ...(hasAmbiguity ? fromAmbiguities(response) : []),
    ...fromLimitations(response),
    ...(response.next_best_actions || []).slice(0, 2).map((item) => toSentence(item)),
  ]);

  if (hasAmbiguity) {
    const top = response.ambiguities[0];
    const ambiguityText = top?.description
      ? toSentence(top.description)
      : "Sua pergunta tem mais de uma interpretacao possivel.";
    parts.push(`Existe uma ambiguidade importante: ${ambiguityText}`);
  }

  const finalQuestions = followUpQuestions.length > 0
    ? followUpQuestions
    : genericContinuation(response);

  parts.push(`Para continuar: ${toSentence(finalQuestions[0])}`);

  return {
    text: parts.filter(Boolean).join("\n\n"),
    followUpQuestions: dedupe(finalQuestions).slice(0, 4),
  };
};

export const buildContextualQuestion = ({
  currentQuestion,
  messages,
}: BuildContextualQuestionInput): string => {
  const _ = messages;
  return String(currentQuestion || "").trim();
};

export const buildConversationHistory = ({
  messages,
  maxTurns = 3,
}: BuildConversationHistoryInput): Array<{ role: "user" | "assistant" | "ai"; content: string }> => {
  return messages
    .filter((item) => !!String(item.content || "").trim())
    .slice(-maxTurns * 2)
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").replace(/\s+/g, " ").trim(),
    }));
};

