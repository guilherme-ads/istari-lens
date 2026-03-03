const DATETIME_NO_TZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const HAS_TZ_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;

const normalizeApiDateInput = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (DATETIME_NO_TZ.test(trimmed)) {
    return `${trimmed.replace(" ", "T")}Z`;
  }

  if (trimmed.includes(" ") && HAS_TZ_SUFFIX.test(trimmed)) {
    return trimmed.replace(" ", "T");
  }

  return trimmed;
};

export const parseApiDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const normalized = normalizeApiDateInput(value);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

export const normalizeApiDateTime = (value?: string | null): string => {
  if (!value) return "";
  const parsed = parseApiDate(value);
  if (!parsed) return value;
  return parsed.toISOString();
};
