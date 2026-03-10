# istari Lens — Design System

> Framework visual focado em clareza analítica, minimalismo premium e estética glassmórfica inspirada na Apple.
> Combina princípios de Apple HIG, Notion, Metabase e Vercel.

**Versão:** 1.0  
**Última atualização:** 2026-03-09  
**Tema padrão:** Dark  
**Stack:** React · Tailwind CSS · shadcn/ui · Recharts · Framer Motion

---

## 1. Princípios de Design

| Princípio | Descrição |
|---|---|
| **Data First** | A interface nunca compete com os dados. Estrutura visual existe para revelar insights. |
| **Premium Minimalism** | Layout limpo, tipografia forte, uso contido de cores. |
| **Structural Clarity** | Toda tela comunica hierarquia imediatamente. |
| **Consistency** | Todos os elementos se comportam e aparecem de forma consistente. |
| **Low Cognitive Load** | Reduzir ruído visual e fricção de interação. |
| **Analytical Precision** | Gráficos, números e tabelas priorizam legibilidade e precisão. |
| **Glassmorphism** | Superfícies translúcidas com blur, inspiradas na Apple, criam profundidade sem peso visual. |

---

## 2. Filosofia de Design

Combinação de referências:

| Referência | O que tomamos |
|---|---|
| **Apple** | Clareza, hierarquia, espaçamento refinado, glassmorphism |
| **Notion** | Interface mínima, design content-first |
| **Metabase** | Forte legibilidade analítica |
| **Vercel** | Disciplina de componentes, precisão |

---

## 3. Estrutura do Produto

### Hierarquia de Navegação (Breadcrumb)

```
Datasets > [Nome do Dataset] > [Nome do Dashboard] > Builder
```

### Estrutura de Dashboard

```
Dashboard
 ├── Header
 ├── Filter Bar (date-range, filtros, chips ativos, ações)
 └── Sections
      └── Widgets
```

### Ordem Narrativa Típica

1. KPIs
2. Tendências (line charts)
3. Breakdowns (bar/pie charts)
4. Dados detalhados (tabelas)

### Layout de Widgets

```
[KPI] [KPI] [KPI] [KPI]
[Line Chart ──────────]
[Bar Chart ───] [Pie ─]
[Table ───────────────]
```

Widgets ocupam de 1 a 4 colunas. Alturas: `0.5x`, `1x`, `2x`.  
Responsivo: widgets empilham verticalmente.

---

## 4. Sistema de Cores

Todos os valores em **HSL** como CSS custom properties. Referenciados via `hsl(var(--token))`.

### 4.1 Brand (Roxo)

| Token | HSL | Hex Aprox. | Uso |
|---|---|---|---|
| `--brand-50` | `246 100% 97%` | `#F4F2FF` | Fundos sutis |
| `--brand-100` | `246 100% 95%` | `#E9E5FF` | Hover suave |
| `--brand-200` | `248 100% 89%` | `#D2CAFF` | Bordas ativas |
| `--brand-300` | `250 100% 83%` | `#B4A6FF` | Gradientes |
| `--brand-400` | `252 100% 75%` | `#957FFF` | Gradientes |
| `--brand-500` | `254 100% 68%` | `#7C5CFF` | **Cor primária** |
| `--brand-600` | `250 75% 60%` | `#6A4FE6` | Hover/pressed |
| `--brand-700` | `250 48% 51%` | `#5843BF` | — |
| `--brand-800` | `248 47% 41%` | `#47379A` | — |
| `--brand-900` | `248 46% 31%` | `#372B75` | — |

**Tailwind:** `brand-50` a `brand-900`  
**Primary/Accent:** Ambos mapeiam para `brand-500`.

### 4.2 Dark Theme (Padrão)

#### Backgrounds

| Token | HSL | Hex Aprox. | Tailwind Class |
|---|---|---|---|
| `--background` | `228 20% 8%` | `#0F1117` | `bg-background` |
| `--card` | `226 18% 11%` | `#151821` | `bg-card` |
| `--secondary` | `224 17% 14%` | `#1B1F2A` | `bg-secondary` |
| `--muted` | `222 16% 17%` | `#222735` | `bg-muted` |

#### Textos

| Token | HSL | Uso | Tailwind Class |
|---|---|---|---|
| `--foreground` | `230 25% 96%` | Texto primário | `text-foreground` |
| `--secondary-foreground` | `226 17% 78%` | Texto secundário | `text-secondary-foreground` |
| `--muted-foreground` | `229 11% 58%` | Texto terciário / labels | `text-muted-foreground` |

#### Bordas

| Token | HSL | Uso | Tailwind Class |
|---|---|---|---|
| `--border` | `226 22% 18%` | Borda sutil (padrão) | `border-border` |
| `--border-default` | `224 20% 23%` | Borda média | `border-border-default` |
| `--border-strong` | `224 18% 30%` | Borda forte / separadores | `border-border-strong` |

### 4.3 Light Theme

#### Backgrounds

| Token | HSL | Hex Aprox. |
|---|---|---|
| `--background` | `0 0% 100%` | `#FFFFFF` |
| `--card` | `228 33% 97%` | `#F7F8FB` |
| `--secondary` | `228 33% 96%` | `#F1F3F9` |
| `--muted` | `228 30% 93%` | `#E8EBF4` |

#### Textos

| Token | HSL |
|---|---|
| `--foreground` | `228 22% 9%` |
| `--secondary-foreground` | `226 14% 33%` |
| `--muted-foreground` | `230 10% 54%` |

#### Bordas

| Token | HSL |
|---|---|
| `--border` | `230 27% 92%` |
| `--border-default` | `228 22% 87%` |
| `--border-strong` | `226 24% 78%` |

### 4.4 Estados Semânticos

| Token | HSL | Hex Aprox. | Uso |
|---|---|---|---|
| `--success` | `142 71% 45%` | `#22C55E` | Positivo, ativo, delta+ |
| `--warning` | `38 92% 50%` | `#F59E0B` | Atenção, syncing |
| `--destructive` | `0 84% 60%` | `#EF4444` | Erro, inativo, delta- |
| `--info` | `217 91% 60%` | `#3B82F6` | Informativo |
| `--highlight` | `67 100% 55%` | `#D4FF2A` | CTA especial (uso restrito) |

### 4.5 Paleta de Gráficos (8 cores categóricas)

| Token | HSL | Uso sugerido |
|---|---|---|
| `--chart-1` | `254 100% 68%` | Série primária (brand) |
| `--chart-2` | `142 71% 45%` | Série 2 (verde) |
| `--chart-3` | `38 92% 50%` | Série 3 (amarelo) |
| `--chart-4` | `217 91% 60%` | Série 4 (azul) |
| `--chart-5` | `0 84% 60%` | Série 5 (vermelho) |
| `--chart-6` | `173 80% 40%` | Série 6 (teal) |
| `--chart-7` | `271 91% 65%` | Série 7 (roxo claro) |
| `--chart-8` | `48 96% 53%` | Série 8 (ouro) |

**Tailwind:** `chart-1` a `chart-8`

---

## 5. Tipografia

### Font Stack

| Uso | Família | Importação |
|---|---|---|
| **UI (tudo)** | `Inter` | Google Fonts, pesos 400-800 |
| **Dados / Código** | `JetBrains Mono` | Google Fonts, pesos 400-500 |

**Tailwind:** `font-sans` (Inter), `font-mono` (JetBrains Mono)  
**Feature settings:** `"cv02", "cv03", "cv04", "cv11"` (aplicados no `body`)

### Escala Tipográfica

| Token | Tamanho | Line-Height | Letter-Spacing | Peso | Tailwind Class |
|---|---|---|---|---|---|
| `display-xl` | 48px | 1.1 | -0.025em | 700 | `text-display-xl` |
| `display-lg` | 40px | 1.15 | -0.025em | 700 | `text-display-lg` |
| `display-md` | 32px | 1.2 | -0.02em | 700 | `text-display-md` |
| `heading-xl` | 28px | 1.25 | -0.015em | 600 | `text-heading-xl` |
| `heading-lg` | 24px | 1.3 | -0.015em | 600 | `text-heading-lg` |
| `heading-md` | 20px | 1.3 | -0.01em | 600 | `text-heading-md` |
| `title-sm` | 18px | 1.35 | — | 600 | `text-title-sm` |
| `body` | 14px | 1.6 | — | 400 | `text-body` |
| `label` | 13px | 1.4 | — | 500 | `text-label` |
| `caption` | 12px | 1.4 | — | 400 | `text-caption` |
| `heading` | 12px | 1.4 | wider | 600 | `text-heading` (uppercase) |

### Tipografia de KPIs

Números devem dominar visualmente.

| Token | Tamanho | Peso | Font | Line-Height | Utility |
|---|---|---|---|---|---|
| `kpi` | 28px | 600 | JetBrains Mono | 1 | `.text-kpi` |
| `kpi-lg` | 32px | 600 | JetBrains Mono | 1 | `.text-kpi-lg` |

### Classes Responsivas

| Utility | Comportamento |
|---|---|
| `.text-display` | `xl` → `2xl` → `3xl` (sm → lg) com `font-extrabold` |
| `.text-title` | `lg` → `xl` (sm) com `font-bold` |

---

## 6. Espaçamento

Grid de **4px**. Todos os valores são múltiplos de 4.

| Token | Valor | Tailwind |
|---|---|---|
| `space-1` | 4px | `p-1`, `gap-1`, `m-1` |
| `space-2` | 8px | `p-2`, `gap-2`, `m-2` |
| `space-3` | 12px | `p-3`, `gap-3`, `m-3` |
| `space-4` | 16px | `p-4`, `gap-4`, `m-4` |
| `space-5` | 20px | `p-5`, `gap-5`, `m-5` |
| `space-6` | 24px | `p-6`, `gap-6`, `m-6` |
| `space-8` | 32px | `p-8`, `gap-8`, `m-8` |
| `space-10` | 40px | `p-10`, `gap-10`, `m-10` |
| `space-12` | 48px | `p-12`, `gap-12`, `m-12` |
| `space-16` | 64px | `p-16`, `gap-16`, `m-16` |

### Espaçamentos Estruturais

| Contexto | Valor |
|---|---|
| Seção ↔ Seção | 48px (`space-12`) |
| Widget ↔ Widget | 16px (`gap-4`) |
| Widget padding | Compact: 12px · Normal: 16px · Comfortable: 20px |
| Container max-width | 1400px (`2xl`) |
| Container padding | 32px (`2rem`) |

---

## 7. Border Radius

| Token | Valor | Tailwind | Uso |
|---|---|---|---|
| `radius-xs` | 4px | `rounded-xs` | Chips, tags pequenas |
| `radius-sm` | 6px | `rounded-sm` | Inputs, botões sm |
| `radius-md` | 8px | `rounded-md` | Botões, cards pequenos |
| `radius-lg` | 12px | `rounded-lg` | **Widgets, cards principais** |
| `radius-xl` | 16px | `rounded-xl` | Modals, sheets, hero cards |

**Regra:** Widgets sempre usam `rounded-lg` (12px).

---

## 8. Elevação (Sombras)

Dark theme prioriza **bordas** sobre sombras pesadas.

| Token | Valor | Tailwind | Uso |
|---|---|---|---|
| `--shadow-sm` | `0 1px 2px 0 hsl(0 0% 0% / 0.12)` | `shadow-card` | Cards em repouso |
| `--shadow-md` | `0 4px 12px -2px hsl(0 0% 0% / 0.18)` | `shadow-card-hover` | Cards em hover |
| `--shadow-lg` | `0 10px 30px -4px hsl(0 0% 0% / 0.24)` | `shadow-elevated` | Elementos elevados |
| `--shadow-overlay` | `0 16px 48px -8px hsl(0 0% 0% / 0.4)` | `shadow-overlay` | Modals, dropdowns |

> No light theme os valores de opacidade são menores (0.04, 0.06, 0.08, 0.12).

---

## 9. Glassmorphism (Apple-inspired)

Três níveis de superfície translúcida:

### `.glass-card`
Componente principal para cards de conteúdo.

```css
background: hsl(var(--card) / 0.55);
backdrop-filter: blur(20px) saturate(1.4);
box-shadow: var(--shadow-sm), inset 0 1px 0 0 hsl(var(--foreground) / 0.04);
border: 1px solid hsl(var(--border) / 0.6);
border-radius: 12px;
```

**Hover:**
```css
background: hsl(var(--card) / 0.7);
box-shadow: var(--shadow-md), inset 0 1px 0 0 hsl(var(--foreground) / 0.06);
```

### `.glass-panel`
Superfície de apoio (barras de status, footers, painéis secundários).

```css
background: hsl(var(--card) / 0.45);
backdrop-filter: blur(24px) saturate(1.5);
box-shadow: inset 0 1px 0 0 hsl(var(--foreground) / 0.05);
```

### `.glass-nav`
Navbar fixa com blur no scroll.

```css
background: hsl(var(--background) / 0.7);
backdrop-filter: blur(20px) saturate(1.8);
box-shadow: 0 1px 0 0 hsl(var(--border) / 0.5);
```

### Regras de Uso

- **Glass-card:** cards de features, widgets, testimonials, KPIs
- **Glass-panel:** social proof bars, footers, barras laterais
- **Glass-nav:** headers fixos
- Todas as superfícies glass incluem `inset highlight` no topo (1px branco/foreground a ~4-5% opacidade) para simular reflexo de luz

---

## 10. Motion / Animação

Animações sutis, nunca distraem dos dados.

| Token | Duração | Tailwind |
|---|---|---|
| `fast` | 120ms | `duration-fast` |
| `normal` | 180ms | `duration-normal` |
| `slow` | 240ms | `duration-slow` |

**Easing:** `ease-out` (padrão)

### Animações Disponíveis

| Utility | Descrição |
|---|---|
| `.fade-in` | Opacity 0→1, 180ms ease-out |
| `.slide-up` | Opacity 0→1 + translateY(12px→0), 180ms ease-out |
| `accordion-down/up` | Expand/collapse de accordions, 180ms ease-out |

### Framer Motion Patterns

```tsx
// Stagger container
const containerAnim = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

// Fade up item
const itemAnim = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] } },
};

// Hover lift
className="hover:-translate-y-1 transition-transform"

// Active press
className="active:scale-[0.97] transition-all"
```

---

## 11. Componentes Base (shadcn/ui)

Todos os componentes consomem tokens do design system.

### 11.1 Button

**Variantes:**

| Variant | Descrição | Classe base |
|---|---|---|
| `default` | CTA primário (brand-500) | `bg-primary text-primary-foreground` |
| `secondary` | Ação secundária | `bg-secondary text-secondary-foreground` |
| `destructive` | Ação destrutiva | `bg-destructive text-destructive-foreground` |
| `outline` | Borda com fundo transparente | `border border-input bg-background` |
| `ghost` | Sem borda, sem fundo | Transparente, hover mostra accent |
| `link` | Texto underline | `text-primary underline` |

**Tamanhos:**

| Size | Altura | Padding |
|---|---|---|
| `sm` | 36px | `px-3` |
| `default` | 40px | `px-4` |
| `lg` | 44px | `px-8` |
| `icon` | 40×40px | — |

**Comportamento:** `active:scale-[0.97]`, `transition-all duration-200`, focus ring com `--ring`.

### 11.2 Badge

| Variant | Descrição |
|---|---|
| `default` | Brand/primary filled |
| `secondary` | Fundo muted |
| `destructive` | Vermelho filled |
| `outline` | Borda apenas |

### 11.3 StatusBadge

Badge semântico com indicador de dot animado.

| Status | Cor | Dot |
|---|---|---|
| `active` | `success/10` text `success` | `bg-success` |
| `inactive` | `destructive/10` text `destructive` | `bg-destructive` |
| `syncing` | `warning/10` text `warning` | `bg-warning animate-pulse` |

### 11.4 Card

```tsx
<Card>        // rounded-lg border bg-card shadow-sm
<CardHeader>  // p-6
<CardTitle>   // text-2xl font-semibold
<CardDescription> // text-sm text-muted-foreground
<CardContent> // p-6 pt-0
<CardFooter>  // p-6 pt-0 flex items-center
```

### 11.5 EmptyState

Componente padrão para estados vazios com ícone, título, descrição e ação opcional.  
Animação: `fade-in` + `slide-up` via Framer Motion.

### 11.6 SkeletonCard

Loading placeholder com 3 variantes:

| Variant | Uso |
|---|---|
| `dataset` | Lista de datasets |
| `dashboard` | Grid de dashboards |
| `widget` | Widgets no builder |

Todos usam `.glass-card` como wrapper.

---

## 12. Widget Container

Todos os widgets de dashboard são encapsulados em um container padronizado.

### Estrutura

```
Widget
 ├── Header (título, subtítulo, ações)
 ├── Content (gráfico, KPI, tabela)
 └── Footer (opcional)
```

### Estilo

| Propriedade | Valor |
|---|---|
| Background | `.glass-card` (translúcido) |
| Border | `border-border/60` |
| Border-radius | `rounded-lg` (12px) |
| Padding | Compact: 12px · Normal: 16px · Comfortable: 20px |

### Configuração

| Propriedade | Opções |
|---|---|
| `width` | 1, 2, 3, 4 colunas |
| `height` | 0.5x, 1x, 2x |
| `padding` | `compact`, `normal`, `comfortable` |
| `colorPalette` | `default`, `warm`, `cool`, `mono`, `vibrant` |
| `showTitle` | boolean |
| `showLegend` | boolean |
| `legendPosition` | `top`, `bottom`, `left`, `right` |
| `showGridLines` | boolean |
| `showDataLabels` | boolean |
| `sensitivityWeight` | 0-100 (controla outliers) |

### Number Format

```ts
interface NumberFormat {
  prefix: string;   // "R$ "
  suffix: string;   // "%"
  decimals: number;  // 2
  compact: boolean;  // true → "284k"
}
```

---

## 13. KPI Card

Componente de métrica primária.

### Estrutura

```
KPI
 ├── Label (text-caption)
 ├── Value (text-kpi ou text-kpi-lg, font-mono)
 ├── Delta (text-success ou text-destructive, com ícone ArrowUpRight/ArrowDownRight)
 ├── Description (opcional)
 └── Sparkline (opcional)
```

### Regras

- Números dominam visualmente: `28-32px`, `font-semibold`, `line-height: 1`
- Sempre usar `JetBrains Mono` para valores numéricos
- Delta positivo: `text-success` + `ArrowUpRight`
- Delta negativo: `text-destructive` + `ArrowDownRight`

### Variantes

| Variante | Descrição |
|---|---|
| `simple` | Label + value |
| `with-delta` | Label + value + delta |
| `with-sparkline` | Label + value + delta + mini gráfico |
| `comparison` | Dois períodos lado a lado |

---

## 14. Chart Card

Wrapper para todas as visualizações.

### Estrutura

```
Chart Card
 ├── Header (título, período, ações)
 ├── Chart Area (Recharts)
 └── Legend
```

### Tipos Suportados

| Tipo | Melhor para |
|---|---|
| `bar` | Comparação categórica |
| `line` | Tendências temporais |
| `pie` | Composições simples |

### Diretrizes de Gráficos

- Gridlines mínimas e sutis
- Eixos sutis (cor `muted-foreground`)
- Tooltips claros
- Legendas consistentes
- Cores da paleta categórica (`chart-1` a `chart-8`)

---

## 15. Data Table

Tabelas construídas com shadcn `<Table>`.

### Regras

| Propriedade | Valor |
|---|---|
| Header | Contraste médio (`font-medium`) |
| Row separators | Borda sutil (`border-border`) |
| Números | Alinhados à direita, `font-mono` |
| Texto | Alinhado à esquerda |
| Hover | Background sutil |

### Capacidades Futuras

- Sorting
- Pagination
- Column pinning
- Export
- Drilldown

---

## 16. Filter Bar

Interface de filtro global acima das seções.

### Estrutura

```
Filter Bar
 ├── Date Range Picker
 ├── Filtros dinâmicos
 ├── Chips ativos (com ×)
 └── Ações (limpar, aplicar)
```

---

## 17. Query States

Todo widget deve suportar:

| Estado | Comportamento |
|---|---|
| `loading` | Skeleton contextual (`.glass-card` + `<Skeleton>`) |
| `empty` | `<EmptyState>` com ícone, título e descrição |
| `error` | Mensagem com orientação acionável |
| `partial-data` | Dados parciais + banner de aviso |
| `no-permission` | Lock icon + mensagem de permissão |

---

## 18. Sidebar

### Tokens

| Token | Uso |
|---|---|
| `--sidebar-background` | Fundo (mais escuro que background) |
| `--sidebar-foreground` | Texto |
| `--sidebar-primary` | Itens ativos (brand-500) |
| `--sidebar-accent` | Hover de itens |
| `--sidebar-border` | Borda lateral |

---

## 19. Naming Convention (Tokens)

```
color.bg.canvas          → --background
color.bg.surface         → --card
color.text.primary       → --foreground
color.text.secondary     → --muted-foreground
color.brand.primary      → --primary

space.1 → space.16       → Tailwind spacing

radius.sm → radius.xl    → Tailwind borderRadius

font.size.body           → text-body
font.size.heading        → text-heading-md

shadow.sm → shadow.overlay → Tailwind boxShadow
```

---

## 20. Acessibilidade

| Requisito | Status |
|---|---|
| Contraste de cor | WCAG AA mínimo |
| Navegação por teclado | Focus ring visível (`--ring`) |
| Screen readers | Labels em todos os inputs |
| Focus states | `focus-visible:ring-2 focus-visible:ring-ring` |
| Reduced motion | Respeitar `prefers-reduced-motion` |

---

## 21. Regras Críticas

### ❌ Nunca Fazer

- Usar cores hardcoded em componentes (`text-white`, `bg-black`, `bg-[#xxx]`)
- Usar preto puro `#000` no light theme (usar `--foreground` que é off-black)
- Misturar `rgb()` com o sistema HSL
- Sombras pesadas no dark theme (preferir bordas)
- Animações que distraem dos dados
- `Inter` para valores numéricos de KPIs (usar `JetBrains Mono`)

### ✅ Sempre Fazer

- Usar tokens semânticos: `bg-background`, `text-foreground`, `border-border`
- Usar `.glass-card` para cards de conteúdo
- Usar `.glass-nav` para headers fixos
- Testar ambos os temas (dark e light)
- Usar `font-mono` para dados numéricos
- Manter spacing no grid de 4px
- Widgets com `rounded-lg` (12px)

---

## 22. Arquivos de Implementação

| Arquivo | Responsabilidade |
|---|---|
| `src/index.css` | CSS custom properties, utilities, glass classes |
| `tailwind.config.ts` | Mapeamento de tokens para Tailwind |
| `src/components/ui/*` | Componentes shadcn com tokens Lens |
| `src/components/shared/*` | Componentes compostos (EmptyState, StatusBadge, etc.) |
| `src/types/dashboard.ts` | Tipos TypeScript para widgets e dashboards |

---

## 23. Referência Rápida de Classes Utilitárias

### Tipografia

```
.text-display-xl  .text-display-lg  .text-display-md  .text-display
.text-heading-xl  .text-heading-lg  .text-heading-md
.text-title       .text-title-sm    .text-heading
.text-body        .text-label       .text-caption
.text-kpi         .text-kpi-lg
```

### Superfícies Glass

```
.glass-card    → Cards translúcidos com hover
.glass-panel   → Painéis secundários
.glass-nav     → Navbar com blur
```

### Widget Padding

```
.widget-padding-compact       → 12px
.widget-padding-normal        → 16px
.widget-padding-comfortable   → 20px
```

### Animação

```
.fade-in       → fadeIn 180ms
.slide-up      → slideUp 180ms
.interactive-icon → scale(1.1) on hover
```
