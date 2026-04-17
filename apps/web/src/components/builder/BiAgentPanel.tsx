import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, ShieldCheck, Sparkles, X } from "lucide-react";

import { api, ApiError, type ApiBiAgentRunResponse } from "@/lib/api";
import { buildContextualQuestion, buildConversationHistory, buildFinalChatResponse } from "@/components/builder/biAgentChatResponse";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ChatInput, ChatMessages, type ChatMessageData } from "@/components/shared/Chat";

export type BiAgentExecutionState = "idle" | "sending" | "success" | "error";

type BiAgentPanelProps = {
  datasetId: number | null;
  onClose: () => void;
};

const QUICK_SUGGESTIONS = [
  "Quais sao os principais KPIs deste dataset?",
  "Monte um dashboard executivo",
  "Quais dimensoes explicam a queda da receita?",
  "Gere uma analise por periodo",
  "Qual o melhor grafico para analisar este dataset?",
];

const toDateTime = (value?: string | null): string => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR");
};

const summarizeAnalysisState = (response: ApiBiAgentRunResponse | null): string[] => {
  const state = response?.analysis_state;
  if (!state) return ["Estado analitico indisponivel."];

  return [
    `Intencao: ${state.intent}`,
    `Ambiguidade: ${state.ambiguity_level}`,
    `Confianca atual: ${Math.round((state.current_confidence || 0) * 100)}%`,
    `Cobertura temporal: ${state.temporal_coverage ? "sim" : "nao"}`,
    `Cobertura dimensional: ${state.dimensional_coverage ? "sim" : "nao"}`,
    `Candidatos cobertos: ${state.covered_candidate_ids.length}`,
    `Dimensoes cobertas: ${state.covered_dimensions.length}`,
    `Ambiguidades abertas: ${state.open_ambiguities_count}`,
    `Ultima decisao: ${state.last_decision_reason || "-"}`,
  ];
};

const stateLabel: Record<BiAgentExecutionState, string> = {
  idle: "Idle",
  sending: "Enviando",
  success: "Sucesso",
  error: "Erro",
};

const BiAgentPanel = ({ datasetId, onClose }: BiAgentPanelProps) => {
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantMessages, setAssistantMessages] = useState<ChatMessageData[]>([]);
  const [executionState, setExecutionState] = useState<BiAgentExecutionState>("idle");
  const [activeTab, setActiveTab] = useState<"resposta" | "evidencias" | "auditoria">("resposta");
  const [lastResponse, setLastResponse] = useState<ApiBiAgentRunResponse | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const runBiAgentMutation = useMutation({
    mutationFn: async ({ contextualQuestion, conversationHistory }: { displayQuestion: string; contextualQuestion: string; conversationHistory: Array<{ role: "user" | "assistant" | "ai"; content: string }> }) => {
      if (!datasetId || !Number.isFinite(datasetId) || datasetId <= 0) {
        throw new Error("Dataset invalido para executar o BI Agent.");
      }
      return api.runBiAgent({
        dataset_id: datasetId,
        question: contextualQuestion,
        mode: "answer",
        apply_changes: false,
        conversation_history: conversationHistory,
      });
    },
    onSuccess: (response, variables) => {
      setExecutionState("success");
      setLastError(null);
      setLastResponse(response);
      setActiveTab("resposta");
      const finalResponse = buildFinalChatResponse({
        question: variables.displayQuestion,
        response,
        hasConversationHistory: assistantMessages.length > 1,
      });
      const followUps = finalResponse.followUpQuestions;
      setAssistantMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: finalResponse.text || response.short_chat_message || "Analise concluida sem resposta textual.",
          status: "done",
          extra: followUps.length > 0
            ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {followUps.map((question) => (
                  <button
                    key={question}
                    type="button"
                    className="rounded-full bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => handleSend(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            )
            : undefined,
        },
      ]);
      setAssistantInput("");

      if ((finalResponse.text || "").trim() === "" && variables.displayQuestion.trim()) {
        setLastError("O agente respondeu sem conteudo textual. Veja as abas de evidencias e auditoria.");
      }
    },
    onError: (error) => {
      const message = error instanceof ApiError
        ? String(error.detail || error.message)
        : String((error as Error)?.message || "Falha ao executar BI Agent");
      setExecutionState("error");
      setLastError(message);
      setAssistantMessages((prev) => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: `Nao foi possivel concluir a analise agora. ${message}`,
          status: "done",
        },
      ]);
    },
  });

  const handleSend = useCallback((suggestion?: string) => {
    const prompt = (suggestion ?? assistantInput).trim();
    if (!prompt || runBiAgentMutation.isPending) return;
    const contextualQuestion = buildContextualQuestion({
      currentQuestion: prompt,
      messages: assistantMessages.map((item) => ({ role: item.role, content: item.content })),
    });
    const conversationHistory = buildConversationHistory({
      messages: assistantMessages.map((item) => ({ role: item.role, content: item.content })),
      maxTurns: 3,
    });

    setExecutionState("sending");
    setLastError(null);
    setAssistantMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: prompt,
      },
    ]);
    setAssistantInput("");
    runBiAgentMutation.mutate({
      displayQuestion: prompt,
      contextualQuestion,
      conversationHistory,
    });
  }, [assistantInput, assistantMessages, runBiAgentMutation]);

  const analysisSummary = useMemo(() => summarizeAnalysisState(lastResponse), [lastResponse]);
  const confidencePct = Math.round((lastResponse?.answer_confidence || 0) * 100);
  const chatPresentation = lastResponse?.chat_presentation;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
              <Sparkles className="h-4 w-4 text-accent" />
            </span>
            <div>
              <p className="text-sm font-semibold">Assistente IA</p>
              <p className="text-[11px] text-muted-foreground">BI Agent (modo answer)</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]" data-testid="bi-agent-state">{stateLabel[executionState]}</Badge>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <span className="sr-only">Fechar assistente</span>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <ChatMessages messages={assistantMessages} isTyping={executionState === "sending"} className="px-4 py-4">
        {assistantMessages.length === 0 && (
          <div className="flex flex-wrap gap-2" data-testid="bi-agent-suggestions">
            {QUICK_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="rounded-full bg-secondary px-2.5 py-1.5 text-[11px]"
                onClick={() => handleSend(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </ChatMessages>

      {lastError && (
        <div className="px-3 pb-2">
          <Alert variant="destructive" className="py-2">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Falha na execucao</AlertTitle>
            <AlertDescription>{lastError}</AlertDescription>
          </Alert>
        </div>
      )}

      {lastResponse && (
        <div className="border-t border-border px-3 pt-3 pb-2">
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "resposta" | "evidencias" | "auditoria")}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="resposta">Resposta</TabsTrigger>
              <TabsTrigger value="evidencias">Evidencias</TabsTrigger>
              <TabsTrigger value="auditoria">Auditoria</TabsTrigger>
            </TabsList>

            <TabsContent value="resposta" className="mt-3 max-h-52 space-y-2 overflow-auto pr-1">
              <div className="rounded-md border border-border/70 bg-muted/20 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Resposta</p>
                <p className="text-muted-foreground">
                  {chatPresentation?.primary_message
                    || lastResponse.short_chat_message
                    || lastResponse.final_answer?.short_chat_message
                    || "-"}
                </p>
              </div>
              {chatPresentation?.direct_answer
                && chatPresentation.direct_answer.trim().toLowerCase() !== (chatPresentation.primary_message || "").trim().toLowerCase() ? (
                  <div className="rounded-md border border-border/70 p-2 text-xs">
                    <p className="mb-1 font-semibold text-foreground">Resposta direta</p>
                    <p className="text-muted-foreground">{chatPresentation.direct_answer}</p>
                  </div>
                ) : null}
              {chatPresentation?.supporting_points?.length ? (
                <div className="rounded-md border border-border/70 p-2 text-xs">
                  <p className="mb-1 font-semibold text-foreground">Pontos de apoio</p>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {chatPresentation.supporting_points.slice(0, 2).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Confianca: {confidencePct}%</span>
              </div>
              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Proximos passos</p>
                {lastResponse.next_best_actions.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {lastResponse.next_best_actions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">Nenhuma acao sugerida.</p>}
              </div>
            </TabsContent>

            <TabsContent value="evidencias" className="mt-3 max-h-52 space-y-2 overflow-auto pr-1">
              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Principais achados</p>
                {lastResponse.key_findings.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {lastResponse.key_findings.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">Nenhum achado retornado.</p>}
              </div>
              <div className="rounded-md border border-border/70 bg-muted/20 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Resumo executivo</p>
                <p className="text-muted-foreground">{lastResponse.executive_summary || "Nao informado"}</p>
              </div>
              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Limitacoes</p>
                {lastResponse.limitations.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {lastResponse.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">Nenhuma limitacao informada.</p>}
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Evidencias</p>
                {lastResponse.evidence.length > 0 ? (
                  <div className="space-y-1.5">
                    {lastResponse.evidence.map((item, index) => (
                      <div key={`${item.tool}-${item.timestamp}-${index}`} className="rounded border border-border/60 bg-muted/20 p-2">
                        <p className="font-medium text-foreground">{item.summary}</p>
                        <p className="text-muted-foreground">{item.tool} | {toDateTime(item.timestamp)}</p>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-muted-foreground">Nenhuma evidencia estruturada.</p>}
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Ambiguidades</p>
                {lastResponse.ambiguities.length > 0 ? (
                  <div className="space-y-1.5 text-muted-foreground">
                    {lastResponse.ambiguities.map((item) => (
                      <div key={`${item.code}-${item.description}`} className="rounded border border-border/60 bg-muted/20 p-2">
                        <p className="font-medium text-foreground">{item.description}</p>
                        {item.alternatives.length > 0 && <p>Alternativas: {item.alternatives.join(" | ")}</p>}
                        {item.suggested_refinement && <p>Refinamento: {item.suggested_refinement}</p>}
                      </div>
                    ))}
                  </div>
                ) : <p className="text-muted-foreground">Nenhuma ambiguidade reportada.</p>}
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Warnings</p>
                {lastResponse.warnings.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {lastResponse.warnings.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">Sem warnings.</p>}
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Erros de validacao</p>
                {lastResponse.validation_errors.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {lastResponse.validation_errors.map((item, index) => (
                      <li key={`${item.code}-${item.field || "field"}-${index}`}>
                        {item.code}: {item.message}{item.field ? ` (campo: ${item.field})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-muted-foreground">Sem erros de validacao.</p>}
              </div>
            </TabsContent>

            <TabsContent value="auditoria" className="mt-3 max-h-52 space-y-2 overflow-auto pr-1">
              <div className="rounded-md border border-border/70 bg-muted/20 p-2 text-xs text-muted-foreground">
                <p><span className="font-semibold text-foreground">Trace:</span> {lastResponse.trace_id || "-"}</p>
                <p><span className="font-semibold text-foreground">Stopping reason:</span> {lastResponse.stopping_reason || "-"}</p>
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Tool calls</p>
                {lastResponse.tool_calls.length > 0 ? (
                  <div className="space-y-1.5">
                    {lastResponse.tool_calls.map((item) => (
                      <div key={`${item.step_id}-${item.tool}`} className="rounded border border-border/60 bg-muted/20 p-2 text-muted-foreground">
                        <p className="font-medium text-foreground">{item.tool}</p>
                        <p>Step: {item.step_id} | tentativa: {item.attempt} | {item.success ? "sucesso" : "falha"}</p>
                        <p>Executado em: {toDateTime(item.executed_at)}</p>
                        {item.error && <p>Erro: {item.error}</p>}
                      </div>
                    ))}
                  </div>
                ) : <p className="text-muted-foreground">Nenhuma chamada de tool registrada.</p>}
              </div>

              <div className="rounded-md border border-border/70 p-2 text-xs">
                <p className="mb-1 font-semibold text-foreground">Resumo do analysis_state</p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {analysisSummary.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
                </ul>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <div className="border-t border-border p-3">
        <ChatInput
          value={assistantInput}
          onChange={setAssistantInput}
          onSend={() => handleSend()}
          variant="textarea"
          disabled={runBiAgentMutation.isPending || !datasetId}
          placeholder="Pergunte algo sobre este dataset..."
        />
      </div>
    </div>
  );
};

export default BiAgentPanel;
