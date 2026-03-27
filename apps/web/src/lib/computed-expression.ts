export type ExpressionSemanticType = "numeric" | "temporal" | "text" | "boolean";

export type ExprNode =
  | { column: string }
  | { literal: string | number | boolean | null }
  | { op: string; args: ExprNode[] };

type TokenType =
  | "identifier"
  | "number"
  | "string"
  | "operator"
  | "paren_open"
  | "paren_close"
  | "comma"
  | "keyword"
  | "eof";

type Token = { type: TokenType; value: string; start: number; end: number };

const KEYWORDS = new Set(["case", "when", "then", "else", "end", "and", "or", "not", "null", "true", "false"]);

const BINARY_OPERATOR_TO_OP: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "=": "eq",
  "!=": "neq",
  "<>": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

const ALLOWED_FUNCTION_NAME_TO_OP: Record<string, string> = {
  abs: "abs",
  round: "round",
  ceil: "ceil",
  floor: "floor",
  coalesce: "coalesce",
  nullif: "nullif",
  concat: "concat",
  lower: "lower",
  upper: "upper",
  substring: "substring",
  trim: "trim",
  date_trunc: "date_trunc",
  extract: "extract",
};

export const ROW_LEVEL_AGGREGATION_ERROR = "Agregacoes nao sao permitidas em colunas calculadas. Use metricas para isso.";

export type ComputedExpressionValidationResult = {
  ast: ExprNode | null;
  errors: string[];
  references: string[];
  inferredType: ExpressionSemanticType | "desconhecido";
};

export type ComputedExpressionSuggestion = {
  kind: "column" | "function";
  label: string;
  detail: string;
  insertText: string;
  score: number;
};

class Parser {
  private tokens: Token[];
  private current = 0;
  private allowedFunctionNames: Set<string>;
  private forbiddenAggregations: Set<string>;

  constructor(tokens: Token[], allowedFunctionNames: Set<string>, forbiddenAggregations: Set<string>) {
    this.tokens = tokens;
    this.allowedFunctionNames = allowedFunctionNames;
    this.forbiddenAggregations = forbiddenAggregations;
  }

  parse(): ExprNode {
    const expr = this.parseOr();
    this.expect("eof");
    return expr;
  }

  private parseOr(): ExprNode {
    let node = this.parseAnd();
    while (this.matchKeyword("or")) {
      const right = this.parseAnd();
      node = { op: "or", args: [node, right] };
    }
    return node;
  }

  private parseAnd(): ExprNode {
    let node = this.parseComparison();
    while (this.matchKeyword("and")) {
      const right = this.parseComparison();
      node = { op: "and", args: [node, right] };
    }
    return node;
  }

  private parseComparison(): ExprNode {
    let node = this.parseAdditive();
    while (this.peek().type === "operator" && ["=", "!=", "<>", ">", ">=", "<", "<="].includes(this.peek().value)) {
      const token = this.consume();
      const right = this.parseAdditive();
      node = { op: BINARY_OPERATOR_TO_OP[token.value], args: [node, right] };
    }
    return node;
  }

  private parseAdditive(): ExprNode {
    let node = this.parseMultiplicative();
    while (this.peek().type === "operator" && ["+", "-"].includes(this.peek().value)) {
      const token = this.consume();
      const right = this.parseMultiplicative();
      node = { op: BINARY_OPERATOR_TO_OP[token.value], args: [node, right] };
    }
    return node;
  }

  private parseMultiplicative(): ExprNode {
    let node = this.parseUnary();
    while (this.peek().type === "operator" && ["*", "/", "%"].includes(this.peek().value)) {
      const token = this.consume();
      const right = this.parseUnary();
      node = { op: BINARY_OPERATOR_TO_OP[token.value], args: [node, right] };
    }
    return node;
  }

  private parseUnary(): ExprNode {
    if (this.matchKeyword("not")) {
      return { op: "not", args: [this.parseUnary()] };
    }
    if (this.peek().type === "operator" && this.peek().value === "-") {
      this.consume();
      return { op: "sub", args: [{ literal: 0 }, this.parseUnary()] };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.type === "paren_open") {
      this.consume();
      const node = this.parseOr();
      this.expect("paren_close");
      return node;
    }

    if (token.type === "keyword" && token.value === "case") {
      return this.parseCaseWhen();
    }

    if (token.type === "number") {
      this.consume();
      return { literal: Number(token.value) };
    }
    if (token.type === "string") {
      this.consume();
      return { literal: token.value };
    }
    if (token.type === "keyword" && token.value === "null") {
      this.consume();
      return { literal: null };
    }
    if (token.type === "keyword" && (token.value === "true" || token.value === "false")) {
      this.consume();
      return { literal: token.value === "true" };
    }

    if (token.type === "identifier") {
      this.consume();
      const identifier = token.value;
      if (this.peek().type === "paren_open") {
        return this.parseFunctionCall(identifier);
      }
      return { column: identifier };
    }

    throw new Error(`Token inesperado '${token.value || token.type}'`);
  }

  private parseFunctionCall(nameRaw: string): ExprNode {
    const name = nameRaw.toLowerCase();
    if (this.forbiddenAggregations.has(name)) {
      throw new Error(ROW_LEVEL_AGGREGATION_ERROR);
    }
    if (!this.allowedFunctionNames.has(name)) {
      throw new Error(`Funcao '${nameRaw}' nao e permitida em coluna calculada.`);
    }

    const op = ALLOWED_FUNCTION_NAME_TO_OP[name];
    if (!op) {
      throw new Error(`Funcao '${nameRaw}' nao e suportada pelo engine.`);
    }
    this.expect("paren_open");
    const args: ExprNode[] = [];
    if (this.peek().type !== "paren_close") {
      while (true) {
        args.push(this.parseOr());
        if (this.peek().type !== "comma") break;
        this.consume();
      }
    }
    this.expect("paren_close");
    return { op, args };
  }

  private parseCaseWhen(): ExprNode {
    this.expectKeyword("case");
    const pairs: Array<{ cond: ExprNode; value: ExprNode }> = [];
    while (this.matchKeyword("when")) {
      const cond = this.parseOr();
      this.expectKeyword("then");
      const value = this.parseOr();
      pairs.push({ cond, value });
    }
    let elseExpr: ExprNode = { literal: null };
    if (this.matchKeyword("else")) elseExpr = this.parseOr();
    this.expectKeyword("end");
    if (pairs.length === 0) throw new Error("CASE WHEN exige ao menos um bloco WHEN ... THEN.");

    let node = { op: "case_when", args: [pairs[pairs.length - 1].cond, pairs[pairs.length - 1].value, elseExpr] } as ExprNode;
    for (let index = pairs.length - 2; index >= 0; index -= 1) {
      node = { op: "case_when", args: [pairs[index].cond, pairs[index].value, node] };
    }
    return node;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) throw new Error(`Esperado '${type}', recebido '${token.value || token.type}'.`);
    this.current += 1;
    return token;
  }

  private expectKeyword(keyword: string): Token {
    const token = this.peek();
    if (token.type !== "keyword" || token.value !== keyword) {
      throw new Error(`Esperado '${keyword}'.`);
    }
    this.current += 1;
    return token;
  }

  private matchKeyword(keyword: string): boolean {
    const token = this.peek();
    if (token.type === "keyword" && token.value === keyword) {
      this.current += 1;
      return true;
    }
    return false;
  }

  private peek(): Token {
    return this.tokens[this.current] || this.tokens[this.tokens.length - 1];
  }

  private consume(): Token {
    const token = this.peek();
    this.current += 1;
    return token;
  }
}

export const normalizeAlias = (value: string): string => value.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "");

export const validateAlias = (value: string, unavailableNames: Set<string>): string | null => {
  const normalized = normalizeAlias(value);
  if (!normalized) return "Alias e obrigatorio.";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) return "Use apenas letras, numeros e underscore, iniciando por letra ou underscore.";
  if (unavailableNames.has(normalized.toLowerCase())) return "Alias ja existe ou conflita com outra coluna.";
  return null;
};

export const tokenizeExpression = (input: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "paren_open", value: "(", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "paren_close", value: ")", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === ",") {
      tokens.push({ type: "comma", value: ",", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    const two = input.slice(index, index + 2);
    if (["!=", "<>", ">=", "<="].includes(two)) {
      tokens.push({ type: "operator", value: two, start: index, end: index + 2 });
      index += 2;
      continue;
    }
    if (["+", "-", "*", "/", "%", "=", ">", "<"].includes(char)) {
      tokens.push({ type: "operator", value: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === "'") {
      let cursor = index + 1;
      let text = "";
      let closed = false;
      while (cursor < input.length) {
        const nextChar = input[cursor];
        if (nextChar === "'") {
          if (input[cursor + 1] === "'") {
            text += "'";
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        text += nextChar;
        cursor += 1;
      }
      if (!closed) throw new Error("String literal sem fechamento.");
      tokens.push({ type: "string", value: text, start: index, end: cursor });
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let cursor = index + 1;
      while (cursor < input.length && /[0-9.]/.test(input[cursor])) cursor += 1;
      tokens.push({ type: "number", value: input.slice(index, cursor), start: index, end: cursor });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index + 1;
      while (cursor < input.length && /[A-Za-z0-9_]/.test(input[cursor])) cursor += 1;
      const value = input.slice(index, cursor);
      const lowered = value.toLowerCase();
      tokens.push({ type: KEYWORDS.has(lowered) ? "keyword" : "identifier", value: KEYWORDS.has(lowered) ? lowered : value, start: index, end: cursor });
      index = cursor;
      continue;
    }
    throw new Error(`Caractere invalido '${char}'.`);
  }
  tokens.push({ type: "eof", value: "", start: input.length, end: input.length });
  return tokens;
};

const inferType = (node: ExprNode, columnTypeByName: Map<string, ExpressionSemanticType>, errors: string[]): ExpressionSemanticType | "desconhecido" => {
  if ("column" in node) return columnTypeByName.get(node.column) || "desconhecido";
  if ("literal" in node) {
    if (node.literal === null) return "desconhecido";
    if (typeof node.literal === "number") return "numeric";
    if (typeof node.literal === "boolean") return "boolean";
    return "text";
  }
  const op = node.op.toLowerCase();
  const args = node.args;
  if (["add", "sub", "mul", "div", "mod", "abs", "round", "ceil", "floor", "extract"].includes(op)) return "numeric";
  if (["concat", "lower", "upper", "substring", "trim"].includes(op)) return "text";
  if (["eq", "neq", "gt", "gte", "lt", "lte", "and", "or", "not"].includes(op)) return "boolean";
  if (op === "date_trunc") return "temporal";
  if (op === "coalesce" || op === "nullif") {
    return inferType(args[0], columnTypeByName, errors);
  }
  if (op === "case_when") {
    const whenType = inferType(args[1], columnTypeByName, errors);
    const elseType = inferType(args[2], columnTypeByName, errors);
    if (whenType !== "desconhecido" && elseType !== "desconhecido" && whenType !== elseType) {
      errors.push("CASE WHEN possui tipos diferentes entre THEN e ELSE.");
      return "desconhecido";
    }
    return whenType === "desconhecido" ? elseType : whenType;
  }
  return "desconhecido";
};

const collectReferences = (node: ExprNode, target: Set<string>) => {
  if ("column" in node) {
    target.add(node.column);
    return;
  }
  if ("op" in node) node.args.forEach((item) => collectReferences(item, target));
};

export const validateAndParseComputedExpression = (params: {
  formula: string;
  columns: Array<{ name: string; type: ExpressionSemanticType }>;
  allowedFunctions: string[];
  forbiddenAggregations: string[];
}): ComputedExpressionValidationResult => {
  const formula = params.formula.trim();
  if (!formula) return { ast: null, errors: ["Expressao por linha e obrigatoria."], references: [], inferredType: "desconhecido" };

  const errors: string[] = [];
  const columnNameSet = new Set(params.columns.map((item) => item.name));
  const columnTypeByName = new Map(params.columns.map((item) => [item.name, item.type]));
  try {
    const parser = new Parser(
      tokenizeExpression(formula),
      new Set(params.allowedFunctions.map((item) => item.toLowerCase())),
      new Set(params.forbiddenAggregations.map((item) => item.toLowerCase())),
    );
    const ast = parser.parse();
    const references = new Set<string>();
    collectReferences(ast, references);
    const unknown = Array.from(references).filter((name) => !columnNameSet.has(name));
    if (unknown.length > 0) errors.push(`Colunas inexistentes: ${unknown.join(", ")}.`);
    const inferredType = inferType(ast, columnTypeByName, errors);
    return { ast, errors, references: Array.from(references), inferredType };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Expressao invalida.");
    return { ast: null, errors, references: [], inferredType: "desconhecido" };
  }
};

const shouldSuggest = (input: string, cursor: number): boolean => {
  if (cursor <= 0) return true;
  const left = input.slice(0, cursor);
  if (/[A-Za-z_][A-Za-z0-9_]*$/.test(left)) return true;
  return /[\s(,+\-*/%=<>]$/.test(left);
};

export const getSuggestions = (params: {
  input: string;
  cursor: number;
  columns: Array<{ name: string; type: ExpressionSemanticType }>;
  functions: string[];
}): { suggestions: ComputedExpressionSuggestion[]; prefix: string } => {
  if (!shouldSuggest(params.input, params.cursor)) return { suggestions: [], prefix: "" };
  const left = params.input.slice(0, params.cursor);
  const tokenMatch = left.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  const prefix = tokenMatch?.[1] || "";
  const normalizedPrefix = prefix.toLowerCase();

  const columnSuggestions = params.columns.map((item) => {
    const lowered = item.name.toLowerCase();
    let score = 90;
    if (!normalizedPrefix) score = 30;
    else if (lowered.startsWith(normalizedPrefix)) score = lowered === normalizedPrefix ? 0 : 10;
    else if (lowered.includes(normalizedPrefix)) score = 20;
    return {
      kind: "column" as const,
      label: item.name,
      detail: item.type,
      insertText: item.name,
      score,
    };
  }).filter((item) => !normalizedPrefix || item.score < 90);

  const functionSuggestions = params.functions
    .map((name) => {
      const lowered = name.toLowerCase();
      let score = 95;
      if (!normalizedPrefix) score = 50;
      else if (lowered.startsWith(normalizedPrefix)) score = lowered === normalizedPrefix ? 40 : 60;
      else if (lowered.includes(normalizedPrefix)) score = 70;
      return {
        kind: "function" as const,
        label: name,
        detail: "funcao",
        insertText: `${name}(`,
        score,
      };
    })
    .filter((item) => !normalizedPrefix || item.score < 95);

  const suggestions = [...columnSuggestions, ...functionSuggestions]
    .sort((a, b) => (a.score - b.score) || a.label.localeCompare(b.label))
    .slice(0, 12);
  return { suggestions, prefix };
};

export const insertSuggestion = (params: {
  input: string;
  cursor: number;
  prefix: string;
  suggestion: ComputedExpressionSuggestion;
}): { value: string; cursor: number } => {
  const start = params.cursor - params.prefix.length;
  const next = `${params.input.slice(0, start)}${params.suggestion.insertText}${params.input.slice(params.cursor)}`;
  const nextCursor = start + params.suggestion.insertText.length;
  return { value: next, cursor: nextCursor };
};

export const evaluateExpression = (node: ExprNode, row: Record<string, unknown>): unknown => {
  if ("column" in node) return row[node.column];
  if ("literal" in node) return node.literal;
  const args = node.args.map((item) => evaluateExpression(item, row));
  switch (node.op) {
    case "add": return Number(args[0] ?? 0) + Number(args[1] ?? 0);
    case "sub": return Number(args[0] ?? 0) - Number(args[1] ?? 0);
    case "mul": return Number(args[0] ?? 0) * Number(args[1] ?? 0);
    case "div": return Number(args[1]) === 0 ? null : Number(args[0] ?? 0) / Number(args[1]);
    case "mod": return Number(args[1]) === 0 ? null : Number(args[0] ?? 0) % Number(args[1]);
    case "concat": return `${args[0] ?? ""}${args[1] ?? ""}`;
    case "coalesce": return args.find((item) => item !== null && item !== undefined) ?? null;
    case "nullif": return args[0] === args[1] ? null : args[0];
    case "lower": return String(args[0] ?? "").toLowerCase();
    case "upper": return String(args[0] ?? "").toUpperCase();
    case "substring": return String(args[0] ?? "").slice(Number(args[1] ?? 0) - 1, args[2] != null ? Number(args[1] ?? 0) - 1 + Number(args[2]) : undefined);
    case "trim": return String(args[0] ?? "").trim();
    case "abs": return Math.abs(Number(args[0] ?? 0));
    case "round": return Math.round(Number(args[0] ?? 0));
    case "ceil": return Math.ceil(Number(args[0] ?? 0));
    case "floor": return Math.floor(Number(args[0] ?? 0));
    case "eq": return args[0] === args[1];
    case "neq": return args[0] !== args[1];
    case "gt": return Number(args[0]) > Number(args[1]);
    case "gte": return Number(args[0]) >= Number(args[1]);
    case "lt": return Number(args[0]) < Number(args[1]);
    case "lte": return Number(args[0]) <= Number(args[1]);
    case "and": return Boolean(args[0]) && Boolean(args[1]);
    case "or": return Boolean(args[0]) || Boolean(args[1]);
    case "not": return !Boolean(args[0]);
    case "case_when": return Boolean(args[0]) ? args[1] : args[2];
    default: return null;
  }
};

export const exprNodeToFormula = (node: ExprNode | null | undefined): string => {
  if (!node) return "";
  if ("column" in node) return node.column;
  if ("literal" in node) {
    if (node.literal === null) return "null";
    if (typeof node.literal === "string") return `'${node.literal.replace(/'/g, "''")}'`;
    return String(node.literal);
  }
  const args = node.args.map((item) => exprNodeToFormula(item));
  switch (node.op) {
    case "add": return `(${args[0]} + ${args[1]})`;
    case "sub": return `(${args[0]} - ${args[1]})`;
    case "mul": return `(${args[0]} * ${args[1]})`;
    case "div": return `(${args[0]} / ${args[1]})`;
    case "mod": return `(${args[0]} % ${args[1]})`;
    case "concat": return `concat(${args.join(", ")})`;
    case "coalesce": return `coalesce(${args.join(", ")})`;
    case "nullif": return `nullif(${args[0]}, ${args[1]})`;
    case "lower": return `lower(${args[0]})`;
    case "upper": return `upper(${args[0]})`;
    case "substring": return `substring(${args.join(", ")})`;
    case "trim": return `trim(${args[0]})`;
    case "date_trunc": return `date_trunc(${args.join(", ")})`;
    case "extract": return `extract(${args[0]} from ${args[1]})`;
    case "abs": return `abs(${args[0]})`;
    case "round": return `round(${args[0]})`;
    case "ceil": return `ceil(${args[0]})`;
    case "floor": return `floor(${args[0]})`;
    case "eq": return `(${args[0]} = ${args[1]})`;
    case "neq": return `(${args[0]} <> ${args[1]})`;
    case "gt": return `(${args[0]} > ${args[1]})`;
    case "gte": return `(${args[0]} >= ${args[1]})`;
    case "lt": return `(${args[0]} < ${args[1]})`;
    case "lte": return `(${args[0]} <= ${args[1]})`;
    case "and": return `(${args[0]} and ${args[1]})`;
    case "or": return `(${args[0]} or ${args[1]})`;
    case "not": return `(not ${args[0]})`;
    case "case_when": return `case when ${args[0]} then ${args[1]} else ${args[2]} end`;
    default: return "";
  }
};
