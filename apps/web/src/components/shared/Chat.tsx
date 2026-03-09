import { useRef, useEffect, type ReactNode, type KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, User, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/* ─── Types ─── */
export interface ChatMessageData {
  id: string;
  role: "user" | "ai" | "assistant";
  content: string;
  status?: "thinking" | "building" | "done";
  /** Slot for custom content rendered below the message bubble */
  extra?: ReactNode;
}

/* ─── Animation presets ─── */
const msgVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

/* ─── Primitives ─── */

/** Typing indicator (three bouncing dots with AI avatar) */
export const ChatTypingIndicator = () => (
  <div className="flex items-center gap-1.5 px-1 py-2">
    <div className="h-7 w-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
      <Bot className="h-3.5 w-3.5 text-accent" />
    </div>
    <div className="flex gap-1 ml-2">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
        />
      ))}
    </div>
  </div>
);

/** Single AI bubble */
export const ChatAIBubble = ({
  content,
  status,
  extra,
}: {
  content: string;
  status?: ChatMessageData["status"];
  extra?: ReactNode;
}) => (
  <motion.div {...msgVariants} className="flex items-start gap-2.5 max-w-[85%]">
    <div className="h-7 w-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
      <Bot className="h-3.5 w-3.5 text-accent" />
    </div>
    <div className="space-y-2 flex-1 min-w-0">
      {/* Status indicators */}
      {status === "thinking" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Analisando...
        </div>
      )}
      {status === "building" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Montando...
        </div>
      )}

      {/* Content */}
      {content && (!status || status === "done") && (
        <div className="rounded-2xl rounded-tl-sm bg-secondary/60 border border-border/50 px-4 py-2.5 text-sm text-foreground">
          <p
            dangerouslySetInnerHTML={{
              __html: content.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>"),
            }}
          />
        </div>
      )}

      {/* Extra slot (previews, actions, etc.) */}
      {extra}
    </div>
  </motion.div>
);

/** Single User bubble */
export const ChatUserBubble = ({ content }: { content: string }) => (
  <motion.div
    {...msgVariants}
    className="flex items-start gap-2.5 max-w-[85%] self-end flex-row-reverse"
  >
    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
      <User className="h-3.5 w-3.5 text-primary" />
    </div>
    <div className="rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm">
      {content}
    </div>
  </motion.div>
);

/** Renders a single message based on role */
export const ChatBubble = ({ message }: { message: ChatMessageData }) => {
  if (message.role === "user") {
    return <ChatUserBubble content={message.content} />;
  }
  return (
    <ChatAIBubble
      content={message.content}
      status={message.status}
      extra={message.extra}
    />
  );
};

/* ─── Suggestion chips ─── */
export const ChatSuggestions = ({
  suggestions,
  onSelect,
  className,
}: {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
  className?: string;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: 0.3, duration: 0.3 }}
    className={cn("flex flex-wrap gap-2", className)}
  >
    {suggestions.map((s) => (
      <button
        key={s}
        onClick={() => onSelect(s)}
        className="text-xs px-3 py-2 rounded-full bg-secondary/60 border border-border text-muted-foreground hover:text-foreground hover:border-accent/50 transition-colors"
      >
        {s}
      </button>
    ))}
  </motion.div>
);

/* ─── Chat input bar ─── */
interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** "input" renders a single-line Input, "textarea" renders a Textarea */
  variant?: "input" | "textarea";
  className?: string;
}

export const ChatInput = ({
  value,
  onChange,
  onSend,
  disabled,
  placeholder = "Digite sua mensagem...",
  variant = "input",
  className,
}: ChatInputProps) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className={cn("flex items-end gap-2", className)}>
      {variant === "textarea" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 min-h-[44px] max-h-32 resize-none text-sm"
          rows={1}
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 h-11"
        />
      )}
      <Button
        onClick={onSend}
        disabled={!value.trim() || disabled}
        size="icon"
        className="h-11 w-11 bg-accent text-accent-foreground hover:bg-accent/90 shrink-0"
      >
        {disabled ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Send className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
};

/* ─── Chat messages container (scrollable area with auto-scroll) ─── */
interface ChatMessagesProps {
  messages: ChatMessageData[];
  isTyping?: boolean;
  /** Optional renderer per message (for custom extras like section previews) */
  renderMessage?: (message: ChatMessageData) => ReactNode;
  /** Content rendered after messages (e.g., suggestions) */
  children?: ReactNode;
  className?: string;
}

export const ChatMessages = ({
  messages,
  isTyping,
  renderMessage,
  children,
  className,
}: ChatMessagesProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  return (
    <div
      ref={scrollRef}
      className={cn("flex-1 overflow-y-auto px-6 py-6 space-y-4 flex flex-col", className)}
    >
      <AnimatePresence mode="popLayout">
        {messages.map((msg) =>
          renderMessage ? (
            <div key={msg.id}>{renderMessage(msg)}</div>
          ) : (
            <ChatBubble key={msg.id} message={msg} />
          )
        )}
      </AnimatePresence>

      {isTyping && <ChatTypingIndicator />}

      {children}
    </div>
  );
};

/* ─── Full chat layout (header + messages + input) ─── */
interface ChatContainerProps {
  header?: ReactNode;
  messages: ChatMessageData[];
  isTyping?: boolean;
  renderMessage?: (message: ChatMessageData) => ReactNode;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  inputDisabled?: boolean;
  inputPlaceholder?: string;
  inputVariant?: "input" | "textarea";
  /** Empty state shown when messages is empty */
  emptyState?: ReactNode;
  /** Content after messages (suggestions, etc.) */
  afterMessages?: ReactNode;
  className?: string;
}

export const ChatContainer = ({
  header,
  messages,
  isTyping,
  renderMessage,
  inputValue,
  onInputChange,
  onSend,
  inputDisabled,
  inputPlaceholder,
  inputVariant = "input",
  emptyState,
  afterMessages,
  className,
}: ChatContainerProps) => (
  <div className={cn("flex flex-col h-full", className)}>
    {/* Header */}
    {header && (
      <div className="border-b border-border bg-card/80 backdrop-blur-sm px-6 py-3 shrink-0">
        {header}
      </div>
    )}

    {/* Messages */}
    <ChatMessages
      messages={messages}
      isTyping={isTyping}
      renderMessage={renderMessage}
    >
      {messages.length === 0 && emptyState}
      {afterMessages}
    </ChatMessages>

    {/* Input */}
    <div className="border-t border-border bg-card/80 backdrop-blur-sm px-6 py-4 shrink-0">
      <ChatInput
        value={inputValue}
        onChange={onInputChange}
        onSend={onSend}
        disabled={inputDisabled}
        placeholder={inputPlaceholder}
        variant={inputVariant}
        className="max-w-3xl mx-auto"
      />
    </div>
  </div>
);
