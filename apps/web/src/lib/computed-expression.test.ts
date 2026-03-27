import { describe, expect, it } from "vitest";

import { getSuggestions, insertSuggestion, ROW_LEVEL_AGGREGATION_ERROR, validateAlias, validateAndParseComputedExpression } from "@/lib/computed-expression";

describe("computed expression", () => {
  const columns = [
    { name: "receita", type: "numeric" as const },
    { name: "custo", type: "numeric" as const },
    { name: "status", type: "text" as const },
  ];
  const allowedFunctions = ["coalesce", "lower", "upper", "substring", "trim", "abs", "round", "ceil", "floor", "date_trunc", "extract", "concat", "nullif"];
  const forbiddenAggregations = ["sum", "avg", "count", "min", "max"];

  it("rejeita agregacoes verticais", () => {
    const result = validateAndParseComputedExpression({
      formula: "sum(receita)",
      columns,
      allowedFunctions,
      forbiddenAggregations,
    });
    expect(result.ast).toBeNull();
    expect(result.errors[0]).toContain(ROW_LEVEL_AGGREGATION_ERROR);
  });

  it("parseia expressao row-level e captura dependencias", () => {
    const result = validateAndParseComputedExpression({
      formula: "case when status = 'ativo' then receita - custo else 0 end",
      columns,
      allowedFunctions,
      forbiddenAggregations,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.references.sort()).toEqual(["custo", "receita", "status"]);
    expect(result.inferredType).toBe("numeric");
    expect(result.ast).not.toBeNull();
  });

  it("ordena autocomplete por prefixo de coluna antes de funcao", () => {
    const { suggestions } = getSuggestions({
      input: "rec",
      cursor: 3,
      columns,
      functions: allowedFunctions,
    });
    expect(suggestions[0]?.kind).toBe("column");
    expect(suggestions[0]?.label).toBe("receita");
  });

  it("insere sugestao no cursor", () => {
    const inserted = insertSuggestion({
      input: "rece + co",
      cursor: 9,
      prefix: "co",
      suggestion: { kind: "column", label: "custo", detail: "numeric", insertText: "custo", score: 0 },
    });
    expect(inserted.value).toBe("rece + custo");
  });

  it("valida alias duplicado", () => {
    const error = validateAlias("Receita", new Set(["receita"]));
    expect(error).toContain("conflita");
  });
});

